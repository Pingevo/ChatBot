"""Pure, versioned data contract for identity-bound Zaapi knowledge rows."""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, fields as _dc_fields
from enum import Enum
from typing import Any

import bson

SCHEMA_REVISION = 1
RAW_AUDIT_FIELDS = (
    "source_name", "source_type", "source_file", "import_batch",
    "zaapi_updated_at",
)
RAW_CONTENT_FIELDS = ("kind", "sheet", "row_index", "source_row", "fields", "text")
RAW_STORAGE_FIELDS = (
    "source_id", "version_id", "accounts", "fingerprint", "scope_fingerprint",
    "raw_row_json", "active", *RAW_CONTENT_FIELDS, *RAW_AUDIT_FIELDS,
)
MANIFEST_FIELDS = ("_id", "schema_revision", "sources", "generation")
MANIFEST_POINTER_FIELDS = (
    "revision_id", "source_id", "active_revision", "source_fingerprint",
    "scope_fingerprint", "source_revision", "model_version",
    "prompt_version", "schema_revision", "record_count",
)
REVISION_FIELDS = (
    "source_id", "source_fingerprint", "source_revision", "scope_fingerprint",
    "model_version", "prompt_version", "record_ids",
)
MONGO_BSON_MAX_BYTES = 16 * 1024 * 1024
EXTRACTION_FIELDS = frozenset((
    "record_type", "topic", "model_codes", "aliases", "item_id", "model_id",
    "subject_id", "target_id", "facts", "answer_text", "steps",
))


class Readiness(str, Enum):
    RESOLVED = "resolved"
    UNRESOLVED = "unresolved"
    CONFLICTED = "conflicted"
    INVALID = "invalid"


class RecordType(str, Enum):
    SPEC = "spec"
    COMPATIBILITY = "compatibility"
    FAQ = "faq"
    TROUBLESHOOTING = "troubleshooting"
    POLICY = "policy"
    NOTE = "note"


def canonical_json(value: Any) -> str:
    """Stable UTF-8 JSON representation used by fingerprints and exports."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False)


def fingerprint(value: Any) -> str:
    """SHA-256 of deterministic JSON, independent of dict insertion order."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def canonical_delivery_scope(shop: str, platform: str) -> tuple[str, str]:
    """Single owner of delivery-scope normalization: shop whitespace-collapse
    (case-sensitive), platform strip+casefold. Pure — callers validate types
    at the boundary."""
    return " ".join(shop.split()), platform.strip().casefold()


def account_scope_fingerprint(accounts: list[dict]) -> str:
    """Hash account identity/scope without depending on account order."""
    if not isinstance(accounts, list) or not all(
            isinstance(account, dict) and all(
                isinstance(account.get(key, ""), str)
                for key in ("id", "name", "platform"))
            for account in accounts):
        raise ValueError("invalid account scope")
    delivery = {
        canonical_delivery_scope(account.get("name", ""),
                                 account.get("platform", ""))
        for account in accounts}
    if len(delivery) != len(accounts):
        raise ValueError("duplicate account scope")
    return fingerprint(sorted({
        (account.get("id", "").strip(),
         *canonical_delivery_scope(account.get("name", ""),
                                   account.get("platform", "")))
        for account in accounts
    }))


def canonical_record_id(record: dict) -> str:
    """Closed-schema check of the canonical payload, then its identity hash.

    A supplied `_id`/`record_id` must equal that hash (creation passes neither)."""
    payload = {key: value for key, value in record.items()
               if key not in ("_id", "record_id")}
    if (not isinstance(payload, dict)
            or set(payload) != _RECORD_PAYLOAD_FIELDS):
        raise ValueError("canonical record schema mismatch")
    if (not _plain_int(payload["schema_revision"])
            or payload["schema_revision"] != SCHEMA_REVISION
            or not _plain_int(payload["row"])
            or any(not _nonempty_str(payload[key]) for key in (
                "source_id", "source_snapshot_id", "source_fingerprint",
                "scope_fingerprint", "content_fingerprint",
                "model_version", "prompt_version"))
            or any(not isinstance(payload[key], str) for key in (
                "shop", "platform", "record_type", "topic",
                "answer_text", "readiness", "source_revision"))
            or not (payload["sheet"] is None
                    or isinstance(payload["sheet"], str))
            or any(payload[key] is not None
                   and not isinstance(payload[key], str)
                   for key in ("item_id", "model_id",
                               "subject_id", "target_id"))
            or payload["record_type"] not in {t.value for t in RecordType}
            or payload["readiness"] not in {r.value for r in Readiness}
            or any(not isinstance(payload[key], (list, tuple))
                   or not all(_nonempty_str(value) for value in payload[key])
                   for key in ("model_codes", "aliases", "steps"))
            or not isinstance(payload["facts"], (list, tuple))):
        raise ValueError("canonical record schema mismatch")
    keys: set[str] = set()
    for fact in payload["facts"]:
        value = fact.get("value") if isinstance(fact, dict) else None
        if (not isinstance(fact, dict) or set(fact) != {"key", "value"}
                or not _nonempty_str(fact["key"]) or fact["key"] in keys
                or not (type(value) in (str, int, float, bool)
                        or isinstance(value, list)
                        and all(isinstance(item, str) for item in value))
                or isinstance(value, float) and not math.isfinite(value)):
            raise ValueError("canonical record schema mismatch")
        keys.add(fact["key"])
    if payload["readiness"] == Readiness.RESOLVED.value and (
            not payload["shop"].strip() or not payload["platform"].strip()
            or not (payload["item_id"] or payload["model_id"]
                    or payload["model_codes"])):
        raise ValueError("canonical record schema mismatch")
    if (payload["record_type"] == RecordType.COMPATIBILITY.value
            and payload["readiness"] == Readiness.RESOLVED.value
            and not payload["target_id"]):
        raise ValueError("canonical record schema mismatch")
    identity = fingerprint(payload)
    if any(record.get(key, identity) != identity for key in ("_id", "record_id")):
        raise ValueError("canonical record identity mismatch")
    return identity


def raw_row_id(row: dict) -> str:
    """Deterministic storage id for a closed raw snapshot row."""
    return "raw:" + fingerprint((
        row["source_id"], row["fingerprint"], row["version_id"],
        row["scope_fingerprint"], row["sheet"], row["row_index"]))


def _plain_int(value: Any) -> bool:
    return type(value) is int


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def source_snapshot_id(source_id: str, source_revision: str,
                       source_fingerprint: str,
                       scope_fingerprint: str) -> str:
    """Shared snapshot identity formula for creation and provenance checks."""
    return fingerprint((source_id, source_revision, source_fingerprint,
                        scope_fingerprint))


def validate_raw_row(row: dict) -> dict:
    """Validate a closed raw snapshot document; returns the row unchanged."""
    if (not isinstance(row, dict)
            or set(row) - {"_id"} != set(RAW_STORAGE_FIELDS)):
        raise ValueError("raw row schema mismatch")
    accounts = row["accounts"]
    if (not _nonempty_str(row["source_id"])
            or not _nonempty_str(row["fingerprint"])
            or not _nonempty_str(row["scope_fingerprint"])
            or not _nonempty_str(row["raw_row_json"])
            or any(not isinstance(row[key], str) for key in (
                "version_id", "kind", "text", *RAW_AUDIT_FIELDS))
            or not (row["sheet"] is None or isinstance(row["sheet"], str))
            or not _plain_int(row["row_index"])
            or not _plain_int(row["source_row"])
            or not isinstance(row["fields"], dict)
            or not all(isinstance(value, str)
                       for value in row["fields"].values())
            or not isinstance(row["text"], str)
            or not isinstance(row["active"], bool)
            or not isinstance(accounts, list)
            or not all(isinstance(account, dict)
                       and set(account) == {"id", "name", "platform"}
                       and all(isinstance(account[key], str)
                               for key in account)
                       for account in accounts)):
        raise ValueError("raw row schema mismatch")
    row_data = {key: row[key] for key in RAW_CONTENT_FIELDS}
    if (row["scope_fingerprint"] != account_scope_fingerprint(accounts)
            or row["raw_row_json"] != canonical_json(row_data)
            or ("_id" in row and row["_id"] != raw_row_id(row))):
        raise ValueError("raw row fingerprint mismatch")
    return row


def index_raw_rows(docs) -> dict:
    """Validate Task 3-owned raw rows (legacy rows skipped) and index them once.

    Returns {(source_id, fingerprint, version_id, scope_fingerprint):
    {content_fingerprint: [(row, sanitized_row)]}}."""
    index: dict = {}
    for doc in docs:
        if not (isinstance(doc.get("_id"), str)
                and doc["_id"].startswith("raw:")):
            continue
        row = validate_raw_row(doc)
        safe = sanitize_source_row(row)
        content = fingerprint({key: safe.get(key) for key in RAW_CONTENT_FIELDS})
        index.setdefault((row["source_id"], row["fingerprint"],
                          row["version_id"], row["scope_fingerprint"]),
                         {}).setdefault(content, []).append((row, safe))
    return index


def build_revision(source: dict) -> dict:
    """Sole owner of the immutable per-source revision document.

    `source` supplies REVISION_FIELDS; callers validate a persisted document
    by requiring `build_revision(doc) == doc`."""
    try:
        fields = {key: source[key] for key in REVISION_FIELDS}
    except (KeyError, TypeError) as error:
        raise ValueError("revision schema mismatch") from error
    ids = fields["record_ids"]
    if (any(not _nonempty_str(value) for key, value in fields.items()
            if key not in ("source_revision", "record_ids"))
            or not isinstance(fields["source_revision"], str)
            or not isinstance(ids, list)
            or not ids
            or not all(_nonempty_str(record_id) for record_id in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError("revision schema mismatch")
    active = fingerprint(tuple(fields.values()))
    revision = {"_id": f"revision:{fields['source_id']}:{active}",
                "schema_revision": SCHEMA_REVISION, **fields,
                "active_revision": active, "record_count": len(ids)}
    if len(bson.encode(revision)) > MONGO_BSON_MAX_BYTES:
        raise ValueError("revision exceeds BSON document limit")
    return revision


def _credential_column(label: str) -> bool:
    key = str(label).casefold().replace("_", "").replace("-", "")
    return any(word in key for word in (
        "password", "token", "secret", "apikey"))


def sanitize_source_row(raw: dict) -> dict:
    """Return the safe row used by extraction, content hashes and export.

    xlsx_row text must be an exact permutation of the field lines; other kinds redact per text line."""
    fields = raw.get("fields") or {}
    if not isinstance(fields, dict) or not isinstance(raw.get("text"), str):
        raise ValueError("invalid raw row")
    safe_fields = {key: "[redacted]" if _credential_column(key) else value
                   for key, value in fields.items()}
    lines = []
    if raw.get("kind") == "xlsx_row":
        by_line = {f"{key}: {value}": f"{key}: {safe_fields[key]}"
                   for key, value in fields.items()}
        raw_lines = raw["text"].split("\n")
        if (len(by_line) != len(fields) or len(raw_lines) != len(by_line)
                or set(raw_lines) != set(by_line)):
            raise ValueError("invalid raw row")
        lines = [by_line[line] for line in raw_lines]
    else:
        for line in raw["text"].split("\n"):
            label, sep, _ = line.partition(":")
            lines.append(f"{label}{sep} [redacted]"
                         if sep and _credential_column(label) else line)
    accounts = raw.get("accounts") or []
    if not isinstance(accounts, list) or not all(
            isinstance(account, dict) for account in accounts):
        raise ValueError("invalid account scope")
    return {
        **{key: raw.get(key) for key in (
            "source_id", "version_id", "fingerprint", "scope_fingerprint",
            "kind", "sheet", "row_index", "source_row")},
        "fields": safe_fields, "text": "\n".join(lines),
        "accounts": [
            {key: account.get(key, "") for key in ("id", "name", "platform")}
            for account in accounts],
    }


@dataclass(frozen=True)
class ZaapiKnowledgeRecord:
    record_id: str
    source_id: str
    source_snapshot_id: str
    sheet: str | None
    row: int
    source_fingerprint: str
    scope_fingerprint: str
    content_fingerprint: str
    shop: str
    platform: str
    record_type: str
    topic: str
    model_codes: tuple[str, ...]
    aliases: tuple[str, ...]
    item_id: str | None
    model_id: str | None
    subject_id: str | None
    target_id: str | None
    facts: tuple[dict, ...]
    answer_text: str
    steps: tuple[str, ...]
    readiness: Readiness
    source_revision: str
    model_version: str
    prompt_version: str
    schema_revision: int = SCHEMA_REVISION

    def to_dict(self) -> dict:
        result = asdict(self)
        result["readiness"] = self.readiness.value
        return json.loads(canonical_json(result))

    @classmethod
    def from_extraction(
        cls, raw: dict, extracted: Any, *, shop: str, platform: str,
        model_version: str, prompt_version: str,
        failed: bool = False,
    ) -> ZaapiKnowledgeRecord:
        """Validate closed extraction; malformed values become inactive invalid rows."""
        safe = sanitize_source_row(raw)
        scope_fp = account_scope_fingerprint(safe["accounts"])
        row_data = {k: safe.get(k) for k in RAW_CONTENT_FIELDS}
        snapshot_id = source_snapshot_id(
            raw["source_id"], raw.get("version_id"), raw["fingerprint"], scope_fp)
        content_fp = fingerprint(row_data)
        valid = isinstance(extracted, dict) and set(extracted) == EXTRACTION_FIELDS
        if valid:
            valid = (
                isinstance(extracted["record_type"], str)
                and extracted["record_type"] in {t.value for t in RecordType}
                and isinstance(extracted["topic"], str)
                and bool(extracted["topic"].strip())
                and all(isinstance(extracted[k], list)
                        and all(isinstance(v, str) and bool(v.strip())
                                for v in extracted[k])
                        for k in ("model_codes", "aliases", "steps"))
                and all(extracted[k] is None or isinstance(extracted[k], str)
                        for k in ("item_id", "model_id", "subject_id", "target_id"))
                and isinstance(extracted["answer_text"], str)
                and isinstance(extracted["facts"], list)
            )
        if valid:
            keys: set[str] = set()
            for fact in extracted["facts"]:
                if not isinstance(fact, dict) or set(fact) != {"key", "value"}:
                    valid = False
                    break
                value = fact["value"]
                if (not isinstance(fact["key"], str) or not fact["key"].strip()
                        or fact["key"] in keys
                        or not (type(value) in (str, int, float, bool)
                                or isinstance(value, list)
                                and all(isinstance(x, str) for x in value))
                        or isinstance(value, float) and not math.isfinite(value)):
                    valid = False
                    break
                keys.add(fact["key"])
        if valid:
            valid = (bool(extracted["facts"] or extracted["answer_text"]
                          or extracted["steps"])
                     and (extracted["record_type"] != "compatibility"
                          or bool(extracted["target_id"])))
        readiness = (Readiness.UNRESOLVED if failed
                     else Readiness.INVALID if not valid
                     else Readiness.RESOLVED
                     if shop and platform and (
                         extracted["item_id"] or extracted["model_id"]
                         or extracted["model_codes"]) else Readiness.UNRESOLVED)
        data = extracted if valid else {}
        payload = {
            "source_id": raw["source_id"],
            "source_snapshot_id": snapshot_id,
            "sheet": raw.get("sheet"),
            "row": raw.get("source_row", raw.get("row_index", 0)),
            "source_fingerprint": raw["fingerprint"],
            "scope_fingerprint": scope_fp,
            "content_fingerprint": content_fp,
            "shop": shop, "platform": platform,
            "record_type": data.get("record_type", "note"),
            "topic": data.get("topic", ""),
            "model_codes": tuple(data.get("model_codes", ())),
            "aliases": tuple(data.get("aliases", ())),
            "item_id": data.get("item_id"),
            "model_id": data.get("model_id"),
            "subject_id": data.get("subject_id"),
            "target_id": data.get("target_id"),
            "facts": tuple(data.get("facts", ())),
            "answer_text": data.get("answer_text", ""),
            "steps": tuple(data.get("steps", ())),
            "readiness": readiness.value,
            "source_revision": raw.get("version_id") or "",
            "model_version": model_version,
            "prompt_version": prompt_version,
            "schema_revision": SCHEMA_REVISION,
        }
        return cls(record_id=canonical_record_id(payload),
                   **{**payload, "readiness": readiness})


CANONICAL_RECORD_FIELDS = tuple(
    field.name for field in _dc_fields(ZaapiKnowledgeRecord))
_RECORD_PAYLOAD_FIELDS = frozenset(
    name for name in CANONICAL_RECORD_FIELDS if name != "record_id")


def validate_record_provenance(record: dict, index: dict) -> dict:
    """Fail closed unless exactly one indexed raw row proves the record's provenance."""
    if canonical_record_id(record) != record["record_id"]:
        raise ValueError("canonical record identity mismatch")
    candidates = index.get((
        record["source_id"], record["source_fingerprint"],
        record["source_revision"], record["scope_fingerprint"]), {}).get(
        record["content_fingerprint"], [])
    if len(candidates) != 1:
        raise ValueError("canonical provenance mismatch")
    row, safe = candidates[0]
    accounts = safe["accounts"]
    scoped = (any(account["name"] == record["shop"]
                  and account["platform"] == record["platform"]
                  for account in accounts)
              if accounts else not (record["shop"].strip()
                                    or record["platform"].strip()))
    if (record["source_snapshot_id"] != source_snapshot_id(
            record["source_id"], record["source_revision"],
            record["source_fingerprint"], record["scope_fingerprint"])
            or record["sheet"] != safe["sheet"]
            or record["row"] != safe["source_row"]
            or not scoped):
        raise ValueError("canonical provenance mismatch")
    return row


def validate_manifest(manifest: dict) -> dict:
    """Validate the closed global active manifest document (O(sources) pointers)."""
    if (not isinstance(manifest, dict)
            or set(manifest) != set(MANIFEST_FIELDS)
            or manifest["_id"] != "active:manifest"
            or not _plain_int(manifest["schema_revision"])
            or manifest["schema_revision"] != SCHEMA_REVISION
            or not isinstance(manifest["sources"], dict)):
        raise ValueError("active manifest fingerprint mismatch")
    for source_id, pointer in manifest["sources"].items():
        if (not _nonempty_str(source_id)
                or not isinstance(pointer, dict)
                or set(pointer) != set(MANIFEST_POINTER_FIELDS)
                or pointer["source_id"] != source_id
                or not _plain_int(pointer["schema_revision"])
                or pointer["schema_revision"] != SCHEMA_REVISION
                or not _plain_int(pointer["record_count"])
                or pointer["record_count"] < 1
                or not isinstance(pointer["source_revision"], str)
                or any(not _nonempty_str(pointer[key]) for key in (
                    "revision_id", "source_id", "active_revision",
                    "source_fingerprint", "scope_fingerprint",
                    "model_version", "prompt_version"))):
            raise ValueError("active revision fingerprint mismatch")
    if manifest["generation"] != fingerprint(manifest["sources"]):
        raise ValueError("active manifest fingerprint mismatch")
    if len(bson.encode(manifest)) > MONGO_BSON_MAX_BYTES:
        raise ValueError("active manifest exceeds BSON document limit")
    return manifest


def validate_manifest_records(sources: dict, revisions: list[dict],
                              docs: list[dict], index: dict) -> None:
    """Fail closed on missing/altered/unprovenanced/incomplete active state."""
    by_id = {doc.get("_id"): doc for doc in docs}
    by_revision = {revision.get("_id"): revision for revision in revisions}
    for pointer in sources.values():
        revision = by_revision.get(pointer["revision_id"])
        if (revision is None or build_revision(revision) != revision
                or pointer != {
                    **{key: revision[key] for key in MANIFEST_POINTER_FIELDS
                       if key != "revision_id"},
                    "revision_id": revision["_id"]}):
            raise ValueError("active manifest record mismatch")
        delivered = set()
        for record_id in revision["record_ids"]:
            doc = by_id.get(record_id)
            if (doc is None
                    or doc.get("record_id") != record_id
                    or doc.get("readiness") != Readiness.RESOLVED.value
                    or any(doc.get(field) != pointer[field] for field in (
                        "source_id", "source_fingerprint",
                        "scope_fingerprint", "source_revision",
                        "model_version", "prompt_version",
                        "schema_revision"))):
                raise ValueError("active manifest record mismatch")
            validate_record_provenance(doc, index)
            delivered.add((doc["content_fingerprint"], doc["shop"],
                           doc["platform"]))
        expected = {
            (content, account.get("name", ""), account.get("platform", ""))
            for content, rows in index.get((
                pointer["source_id"], pointer["source_fingerprint"],
                pointer["source_revision"], pointer["scope_fingerprint"]),
                {}).items()
            for _, safe in rows for account in (safe["accounts"] or [{}])}
        if (not expected or expected != delivered
                or revision["record_count"] != len(expected)):
            raise ValueError("active manifest record mismatch")


def load_active_state(records_coll, raw_coll, manifest: dict) -> list[dict]:
    """Bounded fetch + owner validation of the persisted global active state."""
    validate_manifest(manifest)
    sources = manifest["sources"]
    revisions = list(records_coll.find({"_id": {"$in": [
        pointer["revision_id"] for pointer in sources.values()]}}))
    docs = [doc for revision in revisions for doc in records_coll.find({
        "_id": {"$in": revision["record_ids"]
                if isinstance(revision.get("record_ids"), list) else []}})]
    index = index_raw_rows(
        row for source_id in sources
        for row in raw_coll.find({"source_id": source_id}))
    validate_manifest_records(sources, revisions, docs, index)
    return docs


# --- Phase 4: generation lifecycle closed schemas (spec §10–§12) ---

from .generation_pointer import GEN_ID_RE  # noqa: E402 — reuse, ห้าม regex ใหม่


def _sha256_hex(value: Any) -> bool:
    return (isinstance(value, str) and len(value) == 64
            and all(c in "0123456789abcdef" for c in value))


def validate_gen_pointer(doc: dict) -> dict:
    """Validate the closed `{_id:"active"}` pointer document (spec §12)."""
    if (not isinstance(doc, dict)
            or set(doc) != {"_id", "revision", "generation_id",
                            "previous_generation_id", "canonical_generation",
                            "activated_at"}
            or doc["_id"] != "active"
            or not _plain_int(doc["revision"])
            or doc["revision"] < 1
            or not isinstance(doc["generation_id"], str)
            or not GEN_ID_RE.match(doc["generation_id"])
            or not (doc["previous_generation_id"] is None
                    or (isinstance(doc["previous_generation_id"], str)
                        and GEN_ID_RE.match(doc["previous_generation_id"])))
            or not _sha256_hex(doc["canonical_generation"])
            or not _nonempty_str(doc["activated_at"])):
        raise ValueError("invalid generation pointer")
    from datetime import datetime, timezone
    try:
        activated = datetime.fromisoformat(doc["activated_at"])
    except ValueError:
        raise ValueError("invalid generation pointer") from None
    if activated.tzinfo is None or activated.utcoffset() != timezone.utc.utcoffset(activated):
        raise ValueError("invalid generation pointer")
    return doc


def validate_gen_doc(doc: dict) -> dict:
    """Validate the closed `{_id:"gen:<gid>"}` generation document (spec §11)."""
    model_fields = {"name", "revision", "sentence_transformers_version",
                    "dim", "normalize_embeddings", "output_dtype"}
    if (not isinstance(doc, dict)
            or set(doc) != {"_id", "generation_id", "status", "created_at",
                            "canonical_generation", "canonical_schema_revision",
                            "canonical_sources", "record_set_digest",
                            "record_count", "serialization", "model",
                            "artifacts"}
            or not isinstance(doc["generation_id"], str)
            or not GEN_ID_RE.match(doc["generation_id"])
            or doc["_id"] != f"gen:{doc['generation_id']}"
            or doc["status"] != "ready"
            or not _nonempty_str(doc["created_at"])
            or not isinstance(doc["canonical_sources"], dict)
            or doc["canonical_generation"] != fingerprint(doc["canonical_sources"])
            or not _plain_int(doc["canonical_schema_revision"])
            or doc["canonical_schema_revision"] != SCHEMA_REVISION
            or not _sha256_hex(doc["record_set_digest"])
            or not _plain_int(doc["record_count"])
            or doc["record_count"] < 0
            or doc["serialization"] != {"version": "semantic_text/v1"}
            or not isinstance(doc["model"], dict)
            or set(doc["model"]) != model_fields
            or not _nonempty_str(doc["model"]["name"])
            or not _nonempty_str(doc["model"]["revision"])
            or not _nonempty_str(doc["model"]["sentence_transformers_version"])
            or not _plain_int(doc["model"]["dim"])
            or doc["model"]["dim"] < 1
            or not isinstance(doc["model"]["normalize_embeddings"], bool)
            or not _nonempty_str(doc["model"]["output_dtype"])):
        raise ValueError("invalid generation document")
    manifest = doc["artifacts"]
    if (not isinstance(manifest, dict)
            or set(manifest) != {"manifest"}
            or not isinstance(manifest["manifest"], dict)
            or set(manifest["manifest"]) != {"file", "sha256", "size_bytes",
                                            "format"}
            or manifest["manifest"]["file"] != "manifest.json"
            or not _sha256_hex(manifest["manifest"]["sha256"])
            or not _plain_int(manifest["manifest"]["size_bytes"])
            or manifest["manifest"]["size_bytes"] < 0
            or not _nonempty_str(manifest["manifest"]["format"])):
        raise ValueError("invalid generation document")
    return doc


_ARTIFACT_ROLE_FIELDS = {
    "vectors": {"file", "sha256", "size_bytes", "format", "row_count", "dim",
                "dtype"},
    "record_map": {"file", "sha256", "size_bytes", "format", "digest_count",
                   "record_count"},
    "structured_index": {"file", "sha256", "size_bytes", "format",
                         "field_count", "key_count", "posting_count"},
}
_ARTIFACT_COUNT_KEYS = {
    "vectors": ("row_count", "dim"),
    "record_map": ("digest_count", "record_count"),
    "structured_index": ("field_count", "key_count", "posting_count"),
}


def validate_artifact_manifest(obj: dict) -> dict:
    """Validate the closed `manifest.json` object covering 3 payload roles (spec §10)."""
    if (not isinstance(obj, dict)
            or set(obj) != {"schema_version", "generation_id", "vectors",
                            "record_map", "structured_index"}
            or not _plain_int(obj["schema_version"])
            or obj["schema_version"] != 1
            or not isinstance(obj["generation_id"], str)
            or not GEN_ID_RE.match(obj["generation_id"])):
        raise ValueError("invalid artifact manifest")
    for role, fields in _ARTIFACT_ROLE_FIELDS.items():
        entry = obj[role]
        if (not isinstance(entry, dict)
                or set(entry) != fields
                or entry["file"] != f"{role}.{entry['format']}"
                or not _sha256_hex(entry["sha256"])
                or not _plain_int(entry["size_bytes"])
                or entry["size_bytes"] < 0
                or not _nonempty_str(entry["format"])
                or any(not _plain_int(entry[key]) or entry[key] < 0
                       for key in _ARTIFACT_COUNT_KEYS[role])):
            raise ValueError("invalid artifact manifest")
    if obj["structured_index"]["field_count"] != 6:
        raise ValueError("invalid artifact manifest")
    return obj

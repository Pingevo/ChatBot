"""kb_zaapi_generation — Phase 4 canonical-KB generation lifecycle owner เดียว.

Builders (pure, deterministic ตาม spec §2 hard contract):
- `semantic_text` — renderer เดียว (`semantic_text/v1` — labeled lines) ที่ใช้
  ทั้ง vector embedding และ evidence `payload.text` (ไม่มี renderer ที่สอง)
- `semantic_digest` — SHA-256 ของ semantic_text (vector identity เดียว —
  ไม่ใช่ content_fingerprint)
- `record_set_digest` — fingerprint(sorted record_ids) — pinned-set proof
- `build_record_map` — digest→{vector_index, text, records[projection]}
- `build_structured_index` — field-namespaced index 6 namespaces ปิดตาย
- `build_manifest_payload` — manifest.json object ตาม spec §10

Artifact writers — tmp → sha256/size verify → `os.replace`
(pattern จาก `build_embeddings._save_verified_npz`; `_sha256_file`
pattern-copy จาก `publish_generation` เพราะ module นั้นมี sys.path side effect)

Import DAG (locked): โมดูลนี้ import `kb_zaapi_schema` + `embedding` +
`knowledge_base` (lazy KbEvidenceResult) + `answer_context` เท่านั้น —
`kb_zaapi_retrieval` ห้าม import โมดูลนี้
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import numpy as np

from .kb_zaapi_schema import (canonical_delivery_scope, canonical_json,
                              fingerprint)

SERIALIZATION_VERSION = "semantic_text/v1"
STRUCTURED_INDEX_FIELDS = ("item_id", "model_id", "model_code", "alias",
                           "subject_id", "target_id")
_PROJECTION_FIELDS = ("record_id", "shop", "platform", "item_id", "model_id",
                      "subject_id", "target_id")
_LIST_FIELDS = {"model_code": "model_codes", "alias": "aliases"}


def semantic_text(record: dict) -> str:
    """Render deterministic plain text จาก canonical semantic payload
    (spec §7 — scope/provenance/readiness/record_id/timestamps ห้ามรวม)"""
    lines = [f"record_type: {record['record_type']}",
             f"topic: {record['topic']}"]
    for key in ("item_id", "model_id", "subject_id", "target_id"):
        if record.get(key) is not None:
            lines.append(f"{key}: {record[key]}")
    for value in record["model_codes"]:
        lines.append(f"model_code: {value}")
    for value in record["aliases"]:
        lines.append(f"alias: {value}")
    for fact in sorted(record["facts"], key=lambda x: x["key"]):
        lines.append(f"fact {fact['key']}: {canonical_json(fact['value'])}")
    for value in record["steps"]:
        lines.append(f"step: {value}")
    lines.append(f"answer_text: {record['answer_text']}")
    return "\n".join(lines)


def semantic_digest(record_or_text) -> str:
    """SHA-256 ของ rendered semantic_text — vector identity เดียว (spec §7)"""
    text = (record_or_text if isinstance(record_or_text, str)
            else semantic_text(record_or_text))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def record_set_digest(record_ids) -> str:
    """fingerprint(sorted record_ids) — pinned-set proof ใน gen doc (spec §11)"""
    return fingerprint(sorted(record_ids))


def build_record_map(records: list[dict], texts_by_digest: dict) -> dict:
    """digest → {vector_index (sorted-digest position), text, records[…sorted
    by record_id]} — projections 7 fields เท่านั้น; scope normalize ผ่าน
    `canonical_delivery_scope` (spec §10/§16.24)"""
    sorted_digests = sorted(texts_by_digest)
    out: dict[str, dict] = {}
    for rec in records:
        digest = semantic_digest(rec)
        shop, platform = canonical_delivery_scope(rec["shop"], rec["platform"])
        projection = {
            "record_id": rec["record_id"], "shop": shop, "platform": platform,
            "item_id": rec["item_id"], "model_id": rec["model_id"],
            "subject_id": rec["subject_id"], "target_id": rec["target_id"]}
        entry = out.setdefault(digest, {
            "vector_index": sorted_digests.index(digest),
            "text": texts_by_digest[digest], "records": []})
        entry["records"].append(projection)
    for entry in out.values():
        entry["records"].sort(key=lambda p: p["record_id"])
    return out


def build_structured_index(records: list[dict]) -> dict:
    """field-namespaced index — key set ปิดตาย 6 namespaces; value.strip(),
    skip empty-after-strip, postings sorted+unique record_ids (spec §10)"""
    index: dict[str, dict[str, set]] = {
        field: {} for field in STRUCTURED_INDEX_FIELDS}
    for rec in records:
        for field in STRUCTURED_INDEX_FIELDS:
            values = rec[_LIST_FIELDS[field]] if field in _LIST_FIELDS else (
                (rec[field],) if rec.get(field) is not None else ())
            for value in values:
                norm = value.strip()
                if norm:
                    index[field].setdefault(norm, set()).add(rec["record_id"])
    return {field: {value: sorted(ids) for value, ids in entries.items()}
            for field, entries in index.items()}


def build_manifest_payload(gid: str, roles: dict) -> dict:
    """manifest.json object ตาม spec §10 — ครอบ 3 payload roles เท่านั้น
    (ไม่มี self entry; `roles` = per-role metadata จาก `_write_artifact`)"""
    return {"schema_version": 1, "generation_id": gid,
            "vectors": roles["vectors"], "record_map": roles["record_map"],
            "structured_index": roles["structured_index"]}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_artifact(gen_dir: Path, name: str, payload) -> dict:
    """tmp → verify (reload/sha256+size) → `os.replace` —
    คืน `{file, sha256, size_bytes}` สำหรับ manifest role entry"""
    out = gen_dir / name
    tmp = out.parent / f"{out.stem}.tmp{out.suffix}"
    if isinstance(payload, dict):
        np.savez_compressed(tmp, **payload)
        with np.load(tmp, allow_pickle=True) as z:
            for key in payload:
                if key not in z.files:
                    tmp.unlink(missing_ok=True)
                    raise ValueError(f"npz key {key!r} missing after write")
    else:
        tmp.write_bytes(payload)
        if tmp.read_bytes() != payload:
            tmp.unlink(missing_ok=True)
            raise ValueError(f"artifact {name} bytes mismatch after write")
    sha, size = _sha256_file(tmp), tmp.stat().st_size
    os.replace(tmp, out)
    return {"file": name, "sha256": sha, "size_bytes": size}

"""kb_zaapi_retrieval — Phase 4 standalone canonical-KB retrieval owner เดียว.

Load path (fail closed ตาม spec §14 — corruption ทุกรูป → None, ไม่ fallback
gen อื่น, ไม่ serve ผิด generation):
- `_load_artifacts` — validation chain ชั้น 1–3 (gen doc→manifest→payloads)
- `load_generation_snapshot` / `load_active_generation` — snapshot loaders
- `ZaapiKbSnapshot` — self-contained retrieval surface (spec §10 invariant:
  เพียงพอต่อ exact+semantic retrieval + evidence materialization โดยไม่อ่าน
  canonical collections)

`None` เป็น internal loader signal เท่านั้น — public boundary (`retrieve_active`,
T8) แปลง None → empty result + trace ตาม spec §14

Import DAG (locked): retrieval → kb_zaapi_schema + embedding +
kb_evidence_result (`KbEvidenceResult` — side-effect-free contract) +
answer_context — ห้าม import `kb_zaapi_generation`
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import embedding
from .kb_evidence_result import KbEvidenceResult
from .kb_zaapi_schema import (validate_artifact_manifest,
                              validate_gen_doc, validate_gen_pointer)

GEN_COLL = "zaapi_kb_embedding_generations"
POINTER_ID = "active"
ROOT = Path(__file__).resolve().parent.parent.parent
EMBEDDING_DIM = embedding.EMBEDDING_DIM
_STRUCTURED_FIELDS = ("item_id", "model_id", "model_code", "alias",
                      "subject_id", "target_id")
_PROJECTION_FIELDS_V1 = {"record_id", "shop", "platform", "item_id",
                         "model_id", "subject_id", "target_id"}
# v2 = v1 + typed routing/content fields (Task 5 gate/meta contract)
_PROJECTION_FIELDS = _PROJECTION_FIELDS_V1 | {
    "record_type", "topic", "topic_key", "fact_fields", "readiness",
    "answer_text", "steps", "facts"}
_MODEL_FIELDS = ("name", "revision", "sentence_transformers_version", "dim",
                 "normalize_embeddings", "output_dtype")


@dataclass(frozen=True)
class ZaapiKbSnapshot:
    generation_id: str
    vectors: "np.ndarray"            # (n_digests, 1024) float32 — row i ↔ digests[i]
    digests: tuple                   # sorted semantic_digest order
    record_map: dict                 # digest → {vector_index, text, records[…]}
    structured_index: dict           # 6 namespaces → {norm_value: [record_id…]}
    record_index: dict               # record_id → (digest, projection)
    model: dict                      # gen doc pin 6 fields
    model_compatible: bool           # runtime identity == pin (exact ไม่พึ่ง flag)
    canonical_generation: str
    record_count: int
    schema_version: int = 1          # manifest artifact shape version


def _sha256_file(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fail(what: str):
    print(f"[ZAAPI-GEN] {what} → fail closed", file=sys.stderr)
    return None


def _gen_dir(gid: str, exports_root) -> Path:
    root = Path(exports_root) if exports_root is not None else ROOT / "exports"
    return root / "zaapi_kb_gen" / gid


def _load_artifacts(gen_dir: Path, gen_doc: dict) -> dict | None:
    """Validation chain ชั้น 1–3 (spec §11) → payload objects; fail → None."""
    entry = gen_doc["artifacts"]["manifest"]
    manifest_path = gen_dir / entry["file"]
    if not manifest_path.is_file():
        return _fail(f"manifest missing ({manifest_path})")
    if (manifest_path.name != "manifest.json"
            or _sha256_file(manifest_path) != entry["sha256"]
            or manifest_path.stat().st_size != entry["size_bytes"]):
        return _fail("manifest hash/size mismatch")
    try:
        manifest = json.loads(manifest_path.read_bytes())
        validate_artifact_manifest(manifest)
    except Exception as exc:
        return _fail(f"manifest invalid ({exc})")
    if manifest["generation_id"] != gen_doc["generation_id"]:
        return _fail("manifest generation_id != gen doc")

    payloads: dict = {}
    for role in ("vectors", "record_map", "structured_index"):
        meta = manifest[role]
        path = gen_dir / meta["file"]
        if (not path.is_file()
                or path.parent != gen_dir              # fixed filename เท่านั้น
                or _sha256_file(path) != meta["sha256"]
                or path.stat().st_size != meta["size_bytes"]):
            return _fail(f"{role} bytes/hash/size mismatch")
        try:
            if role == "vectors":
                z = np.load(path, allow_pickle=False)
                if ("generation_id" not in z.files
                        or str(z["generation_id"].item())
                        != manifest["generation_id"]):
                    return _fail("vectors generation_id mismatch")
                payloads[role] = {"digests": [str(d) for d in z["digests"]],
                                  "embeddings": z["embeddings"]}
            else:
                payloads[role] = json.loads(path.read_bytes())
        except Exception as exc:
            return _fail(f"{role} load error ({exc})")

    # ชั้น 3 — shape/dim/count/dtype/cross-counts (spec §11)
    expected = (_PROJECTION_FIELDS_V1
                if manifest["schema_version"] == 1
                else _PROJECTION_FIELDS)
    vectors, record_map, sindex = (payloads["vectors"],
                                   payloads["record_map"],
                                   payloads["structured_index"])
    emb = vectors["embeddings"]
    digests = vectors["digests"]
    if (not isinstance(emb, np.ndarray) or emb.ndim != 2
            or emb.dtype != np.float32
            or emb.shape[0] != len(digests)
            or emb.shape[1] != manifest["vectors"]["dim"]
            or emb.shape[1] != EMBEDDING_DIM
            or digests != sorted(digests)
            or len(digests) != manifest["vectors"]["row_count"]):
        return _fail("vectors shape/dim/dtype/digest-order mismatch")
    if (not isinstance(record_map, dict)
            or set(record_map) != set(digests)
            or len(record_map) != manifest["record_map"]["digest_count"]
            or sum(len(e.get("records", ())) for e in record_map.values())
            != manifest["record_map"]["record_count"]):
        return _fail("record_map count/digest-set mismatch")
    for i, digest in enumerate(digests):
        e = record_map[digest]
        if (not isinstance(e, dict)
                or set(e) != {"vector_index", "text", "records"}
                or e["vector_index"] != i
                or not isinstance(e["text"], str)
                or any(set(p) != expected for p in e["records"])):
            return _fail("record_map entry/projection mismatch")
    if (set(sindex) != set(_STRUCTURED_FIELDS)
            or manifest["structured_index"]["field_count"] != len(_STRUCTURED_FIELDS)
            or any(not isinstance(entries, dict) for entries in sindex.values())
            or sum(len(v) for v in sindex.values())
            != manifest["structured_index"]["key_count"]
            or sum(len(ids) for v in sindex.values() for ids in v.values())
            != manifest["structured_index"]["posting_count"]
            or any(ids != sorted(set(ids))
                   for v in sindex.values() for ids in v.values())):
        return _fail("structured_index namespaces/postings mismatch")
    record_ids = {p["record_id"] for e in record_map.values()
                  for p in e["records"]}
    if any(rid not in record_ids
           for v in sindex.values() for ids in v.values() for rid in ids):
        return _fail("structured_index posting references unknown record_id")
    return {"vectors": emb, "digests": tuple(digests),
            "record_map": record_map, "structured_index": sindex,
            "schema_version": manifest["schema_version"]}


def load_generation_snapshot(db, gid: str, *, exports_root=None
                             ) -> ZaapiKbSnapshot | None:
    """gen doc read + validate → artifact chain → snapshot; fail → None."""
    try:
        doc = db[GEN_COLL].find_one({"_id": f"gen:{gid}"})
        if doc is None:
            return _fail(f"gen doc missing ({gid})")
        validate_gen_doc(doc)
    except Exception as exc:
        return _fail(f"gen doc invalid ({exc})")
    gen_dir = _gen_dir(doc["generation_id"], exports_root)
    loaded = _load_artifacts(gen_dir, doc)
    if loaded is None:
        return None
    record_index = {}
    for digest in loaded["digests"]:
        for projection in loaded["record_map"][digest]["records"]:
            record_index[projection["record_id"]] = (digest, projection)
    if len(record_index) != doc["record_count"]:
        return _fail("record_index size != gen doc record_count")
    runtime = embedding.model_identity()
    compatible = all(doc["model"][k] == runtime[k] for k in _MODEL_FIELDS)
    if not compatible:
        print("[ZAAPI-GEN] model identity mismatch — semantic channel "
              "unavailable (exact channels still usable)", file=sys.stderr)
    return ZaapiKbSnapshot(
        generation_id=doc["generation_id"], vectors=loaded["vectors"],
        digests=loaded["digests"], record_map=loaded["record_map"],
        structured_index=loaded["structured_index"],
        record_index=record_index, model=doc["model"],
        model_compatible=compatible,
        canonical_generation=doc["canonical_generation"],
        record_count=doc["record_count"],
        schema_version=loaded["schema_version"])


def load_active_generation(db, *, exports_root=None) -> ZaapiKbSnapshot | None:
    """pointer find_one + `validate_gen_pointer` → snapshot(pointer.gid); fail → None."""
    try:
        pointer = db[GEN_COLL].find_one({"_id": POINTER_ID})
        if pointer is None:
            return _fail("active pointer missing")
        validate_gen_pointer(pointer)
    except Exception as exc:
        return _fail(f"active pointer invalid ({exc})")
    snap = load_generation_snapshot(db, pointer["generation_id"],
                                    exports_root=exports_root)
    if snap is None:
        return None
    if snap.canonical_generation != pointer["canonical_generation"]:
        return _fail("pointer canonical_generation != gen doc")
    return snap


# --- Task 8: retrieve() full query contract (spec §8/§9/§14) ---

from .answer_context import EVIDENCE_LIMIT  # noqa: E402
from .kb_zaapi_schema import canonical_delivery_scope  # noqa: E402

_TYPED_CHANNELS = (("item_ids", "item_id"), ("model_ids", "model_id"),
                   ("model_codes", "model_code"), ("aliases", "alias"),
                   ("subject_ids", "subject_id"), ("target_ids", "target_id"))


def _empty(*trace: str):
    return KbEvidenceResult(supporting_evidence=(), raw_count=0, trace=trace)


def _evidence_record(digest: str, projection: dict, record_map: dict,
                     score: float | None = None,
                     request_id: str = "ch:kb") -> dict:
    """Producer record ตาม spec §9 — materialize จาก artifacts เท่านั้น;
    omit field ว่าง/None; ห้ามเดา/parse prose. kind="kb_zaapi" = source
    marker; meta = single typed channel (routing + content fields);
    score เฉพาะ semantic-origin (exact hits ไม่มี — ไม่ invent)"""
    ev: dict = {"kind": "kb_zaapi"}
    if projection["item_id"] is not None:
        ev["item_id"] = projection["item_id"]
    if projection.get("model_id") is not None:
        ev["model_id"] = projection["model_id"]
    identity = projection["subject_id"] or projection["model_id"]
    if identity is not None:
        ev["identity"] = identity
    if projection["target_id"] is not None:
        ev["target"] = projection["target_id"]
    meta = {"record_type": projection.get("record_type"),
            "fact_fields": tuple(projection.get("fact_fields") or ()),
            "readiness": projection.get("readiness"),
            "record_id": projection.get("record_id"),
            "request_id": request_id}
    for k in ("topic", "topic_key"):   # optional — omit เมื่อ absent
        if projection.get(k) is not None:
            meta[k] = projection[k]
    if projection.get("answer_text") is not None:
        meta["answer_text"] = projection["answer_text"]
    if projection.get("steps"):
        meta["steps"] = tuple(projection["steps"])
    if projection.get("facts"):
        meta["facts"] = tuple(projection["facts"])
    if score is not None:
        meta["score"] = float(score)
    ev["meta"] = meta
    ev["payload"] = {"text": record_map[digest]["text"]}
    return ev


def retrieve(snapshot, *, shop, platform, item_ids=(), model_ids=(),
             model_codes=(), aliases=(), subject_ids=(), target_ids=(),
             semantic_query=None, limit=EVIDENCE_LIMIT,
             request_id="ch:kb"):
    """Canonical-KB retrieval บน snapshot — boundary validation → scope
    normalize → structured channels → semantic channel → scoped merge →
    limit → producer records → KbEvidenceResult (fail closed เป็น empty+trace)"""
    # boundary validation — group เดียว (spec §8)
    if not isinstance(shop, str) or not isinstance(platform, str):
        return _empty("invalid_query")
    shop, platform = canonical_delivery_scope(shop, platform)
    if not shop or not platform:
        return _empty("invalid_query")
    if not isinstance(limit, int) or isinstance(limit, bool) \
            or limit < 1 or limit > EVIDENCE_LIMIT:
        return _empty("invalid_query")
    if semantic_query is not None and not isinstance(semantic_query, str):
        return _empty("invalid_query")
    channels = {}
    for kwarg, ns in _TYPED_CHANNELS:
        refs = locals()[kwarg]
        if not isinstance(refs, (tuple, list)):
            return _empty("invalid_query")
        norms = []
        for ref in refs:
            if not isinstance(ref, str) or not ref.strip():
                return _empty("invalid_query")
            norms.append(ref.strip())
        if norms:
            channels[ns] = norms
    has_semantic = (semantic_query is not None
                    and bool(semantic_query.strip()))
    if not channels and not has_semantic:
        return _empty("no_query")

    def in_scope(projection):
        return projection["shop"] == shop and projection["platform"] == platform

    trace: list[str] = []
    # structured channel: per-ns union → projections → scope filter → sorted
    exact_ids: list[str] = []
    for ns, norms in channels.items():
        for norm in norms:
            for rid in snapshot.structured_index[ns].get(norm, ()):
                if rid not in exact_ids and in_scope(
                        snapshot.record_index[rid][1]):
                    exact_ids.append(rid)
    exact_ids.sort()
    ordered: list[tuple] = [(rid, None) for rid in exact_ids]
    if exact_ids:
        trace.append(f"exact={len(exact_ids)}")

    # semantic channel: score rows → eligible digests → scoped expand
    semantic_hits: list[tuple] = []
    if has_semantic:
        if not snapshot.model_compatible:
            trace.append("semantic_unavailable")
        else:
            try:
                query_vec = embedding.embed_query(semantic_query)
                scores = snapshot.vectors @ np.asarray(
                    query_vec, dtype=np.float32)
            except Exception:
                trace.append("semantic_unavailable")
            else:
                ranked = sorted(
                    range(len(snapshot.digests)),
                    key=lambda i: (-float(scores[i]), snapshot.digests[i]))
                for i in ranked:
                    digest = snapshot.digests[i]
                    eligible = [p for p in
                                snapshot.record_map[digest]["records"]
                                if in_scope(p)]
                    for p in eligible:
                        semantic_hits.append(
                            (float(scores[i]), p["record_id"], digest))
                if semantic_hits:
                    trace.append(f"semantic={len({h[2] for h in semantic_hits})}")

    # merge: structured ก่อน semantic (score desc, tie → record_id asc); dedupe
    seen = set(exact_ids)
    records: list[tuple] = [(rid, snapshot.record_index[rid], None)
                          for rid in exact_ids]
    for sc, rid, digest in sorted(semantic_hits,
                                  key=lambda h: (-h[0], h[1])):
        if rid not in seen:
            seen.add(rid)
            records.append((rid, snapshot.record_index[rid], sc))
    records = records[:limit]
    evs = tuple(_evidence_record(digest, p, snapshot.record_map, score=sc,
                                 request_id=request_id)
                for _, (digest, p), sc in records)
    return KbEvidenceResult(supporting_evidence=evs,
                            raw_count=len(evs), trace=tuple(trace))


def retrieve_active(db, *, shop, platform, item_ids=(), model_ids=(),
                    model_codes=(), aliases=(), subject_ids=(), target_ids=(),
                    semantic_query=None, limit=EVIDENCE_LIMIT,
                    exports_root=None):
    """End-to-end boundary: load_active_generation → None แปลงเป็น
    empty + ("generation_unavailable",) ตาม spec §14"""
    snapshot = load_active_generation(db, exports_root=exports_root)
    if snapshot is None:
        return _empty("generation_unavailable")
    return retrieve(snapshot, shop=shop, platform=platform, item_ids=item_ids,
                    model_ids=model_ids, model_codes=model_codes,
                    aliases=aliases, subject_ids=subject_ids,
                    target_ids=target_ids, semantic_query=semantic_query,
                    limit=limit)

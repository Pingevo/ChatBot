"""Phase 4 Task 11: producer→pool→compiler attribution contract (test-only —
พิสูจน์ producer record จาก retrieve() เข้า executor→pool→compiler contract
ได้โดยไม่มี Task 5 wiring — spec §16.17,18)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "chatbot"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mongo_doubles import GenDb
from zaapi_phase4_helpers import record, write_gen_dir

from shopeechat.kb_zaapi_retrieval import (
    load_active_generation, retrieve)
from shopeechat.retrieval_executor import RetrievalExecutionResult
from shopeechat.candidate_pool import build_candidate_pool
from shopeechat.answer_context import (
    _EVIDENCE_RECORD_BYTES, _compile_evidence)

GID = "g20261104-010203-abcdef12"


def _snapshot(tmp_path):
    db = GenDb()
    coll = db["zaapi_kb_embedding_generations"]
    recs = [record(item_id="IT-1", subject_id="SUB-1", target_id="TG-1",
                   answer_text="spec answer text")]
    write_gen_dir(tmp_path, GID, recs)
    import hashlib
    import json as _json
    manifest_raw = (tmp_path / "zaapi_kb_gen" / GID
                    / "manifest.json").read_bytes()
    sources = {"zaapi_kb": {"revision_id": "rev:1", "record_count": 1}}
    from shopeechat import kb_zaapi_schema as schema
    doc = {
        "_id": f"gen:{GID}", "generation_id": GID, "status": "ready",
        "created_at": "2026-11-04T01:02:03+00:00",
        "canonical_generation": schema.fingerprint(sources),
        "canonical_schema_revision": schema.SCHEMA_REVISION,
        "canonical_sources": sources,
        "record_set_digest": schema.fingerprint(
            sorted(r["record_id"] for r in recs)),
        "record_count": 1,
        "serialization": {"version": "semantic_text/v1"},
        "model": {"name": "BAAI/bge-m3",
                  "revision": "5617a9f61b028005a4858fdac845db406aefb181",
                  "sentence_transformers_version": "5.7.0", "dim": 1024,
                  "normalize_embeddings": True, "output_dtype": "float32"},
        "artifacts": {"manifest": {
            "file": "manifest.json",
            "sha256": hashlib.sha256(manifest_raw).hexdigest(),
            "size_bytes": len(manifest_raw), "format": "json"}}}
    coll.insert_one(doc)
    coll.insert_one({
        "_id": "active", "revision": 1, "generation_id": GID,
        "previous_generation_id": None,
        "canonical_generation": doc["canonical_generation"],
        "activated_at": "2026-11-04T01:02:03+00:00"})
    snap = load_active_generation(db, exports_root=tmp_path)
    assert snap is not None
    return snap


def test_producer_records_survive_attribution_and_compile(tmp_path):
    snap = _snapshot(tmp_path)
    res_kbe = retrieve(snap, shop="ShopA", platform="shopee",
                       item_ids=("IT-1",))
    evs = res_kbe.supporting_evidence
    assert len(evs) == 1
    # producer closed schema — เฉพาะ fields ที่ spec §9 อนุญาต
    assert all(set(e) <= {"kind", "item_id", "identity", "target", "payload"}
               for e in evs)

    # executor result wrapper — request_id ที่ pool ใช้ stamp
    result = RetrievalExecutionResult(
        request_id="r1", source="slot", supporting_evidence=evs)
    pool = build_candidate_pool((result,))
    stamped = pool.supporting_evidence
    assert len(stamped) == 1 and stamped[0]["request_id"] == "r1"

    # attribution seam — request_id → need_indices ผ่าน req_needs/idx_of
    need = object()
    idx_of = {id(need): 0}
    req_needs = {"r1": (need,)}
    trace: list = []
    final = _compile_evidence(
        pool, (), req_needs=req_needs, idx_of=idx_of,
        prodish_idx={0}, target_of={}, ref_needs={}, trace=trace)
    assert len(final) == 1, trace
    rec = final[0]
    assert rec["kind"] == "kb"
    assert rec["need_indices"] == (0,)          # เติมจาก request_id
    assert rec["item_id"] == "IT-1"             # verbatim
    assert rec["identity"] == "SUB-1"           # subject_id precedence
    assert rec["target"] == "TG-1"
    assert isinstance(rec["payload"], str)      # plain text เท่านั้น
    assert "spec answer text" in rec["payload"]
    assert "request_id" not in rec              # ถูกลบตอน emit
    import json
    assert len(json.dumps(rec, ensure_ascii=False).encode("utf-8")
               ) <= _EVIDENCE_RECORD_BYTES
    # fields นอก closed schema ไม่ข้าม (shop/platform/record_id/digest ฯลฯ)
    assert set(rec) <= {"kind", "need_indices", "item_id", "identity",
                        "target", "payload"}

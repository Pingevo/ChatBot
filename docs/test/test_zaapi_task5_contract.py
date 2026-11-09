"""Task 5 contract RED probes — offline-first, real modules, real exit code.

Tripwires installed BEFORE any shopeechat import: socket / pymongo /
urllib / HF-style http calls raise immediately. Embedding seam stubbed at
`shopeechat.embedding.embed_query` + `model_identity` (deterministic sha256
seeded gaussian, same family as stub_embed).

Probe classes:
  [SCHEMA]  missing-field probes — assert fields the contract requires on
            emitted evidence/artifact projections (fail until contract lands)
  [BEHAV]   behavioral probes through the REAL production path
            (_compile_evidence / build_candidate_pool / retrieve)

Run: python3 docs/test/test_zaapi_task5_contract.py ; echo $?
"""
import sys, socket, hashlib, tempfile, json
from dataclasses import replace
from pathlib import Path


def _trip(what):
    def _f(*a, **k):
        raise AssertionError(f"OFFLINE LEAK: {what}")
    return _f


# --- offline tripwires BEFORE shopeechat imports ---
socket.socket.connect = _trip("socket.connect")
try:
    import pymongo
    pymongo.MongoClient.__init__ = _trip("MongoClient()")
except ImportError:
    pass
try:
    import urllib.request
    urllib.request.urlopen = _trip("urlopen")
except ImportError:
    pass

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs/test"))

import numpy as np  # noqa: E402
from mongo_doubles import GenDb  # noqa: E402
from zaapi_phase4_helpers import (  # noqa: E402
    record, write_gen_dir, seed_canonical_state)

from shopeechat import embedding  # noqa: E402


def _stub_vec(text):
    seed = int.from_bytes(
        hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")
    v = np.random.default_rng(seed).standard_normal(1024)
    return (v / np.linalg.norm(v)).astype(np.float32)


_STUB_MODEL = {"name": "BAAI/bge-m3",
               "revision": "5617a9f61b028005a4858fdac845db406aefb181",
               "sentence_transformers_version": "5.7.0", "dim": 1024,
               "normalize_embeddings": True, "output_dtype": "float32"}
embedding.embed_query = lambda t: _stub_vec(t)
embedding.embed_texts = lambda texts, batch_size=32: np.stack(
    [_stub_vec(t) for t in texts]).astype(np.float32)
embedding.model_identity = lambda: dict(_STUB_MODEL)

from shopeechat.turn_decision import TurnNeed, PRODUCTISH_NEED_KINDS  # noqa
from shopeechat.retrieval_planner import channel_request  # noqa
from shopeechat.retrieval_executor import RetrievalExecutionResult  # noqa
from shopeechat.candidate_pool import build_candidate_pool  # noqa
from shopeechat.answer_context import _compile_evidence  # noqa
from shopeechat.kb_zaapi_retrieval import (  # noqa
    load_active_generation, load_generation_snapshot, retrieve,
    _PROJECTION_FIELDS)
from shopeechat import kb_zaapi_schema as schema  # noqa
from shopeechat import kb_zaapi_generation as genmod  # noqa
from shopeechat.retrieval_selection import needs_for_request  # noqa
from shopeechat.kb_zaapi_generation import (  # noqa
    rollback, build_manifest_payload)

RESULTS = []
CLS = {}


def probe(name, cls):
    def deco(fn):
        def wrapped():
            try:
                fn()
                RESULTS.append((name, "PASS")); CLS[name] = cls
            except AssertionError as e:
                RESULTS.append((name, f"RED — {e}")); CLS[name] = cls
            except Exception as e:
                RESULTS.append((name, f"ERROR — {type(e).__name__}: {e}"))
                CLS[name] = cls
        return wrapped
    return deco


def _meta(record_type="faq", request_id="ch:kb:0", **kw):
    """zaapi v2 meta — required {record_type, readiness, record_id,
    request_id} + optional typed fields (contract: R15/R5)"""
    return {"meta": {"record_type": record_type,
                     "readiness": "resolved", "record_id": "rec-x",
                     "request_id": request_id,
                     **{k: v for k, v in kw.items() if v is not None}}}


def mkneed(**kw):
    base = dict(kind="product", operation="describe")
    base.update(kw)
    return TurnNeed(**base)


def compile_evs(res, reqs, needs, *, ref_needs=None):
    pool = build_candidate_pool(res)
    idx_of = {id(n): i for i, n in enumerate(needs)}
    prodish = {i for i, n in enumerate(needs)
               if n.kind in PRODUCTISH_NEED_KINDS}
    req_needs = {}
    for r in reqs:
        srefs = (frozenset(r.subject_refs or ())
                 | frozenset(r.target_refs or ()))
        if srefs:
            req_needs[r.request_id] = tuple(
                n for n in needs
                if (frozenset(n.subject_refs or ())
                    | frozenset(n.target_refs or ())) == srefs)
        else:
            req_needs[r.request_id] = tuple(needs)
    tr = []
    return pool, _compile_evidence(
        pool, (), req_needs=req_needs, idx_of=idx_of,
        need_by_idx=dict(enumerate(needs)), prodish_idx=prodish,
        target_of={}, ref_needs=ref_needs or {}, trace=tr), tr


def _gen_db(tmp, gid, recs, sv=None):
    gen_dir = write_gen_dir(tmp, gid, recs, embed=embedding.embed_texts)
    if sv == 1:  # honest v1 artifact: v1 projections + schema_version=1
        import json as _j
        _V1 = {"record_id", "shop", "platform", "item_id", "model_id",
               "subject_id", "target_id"}
        rp = gen_dir / "record_map.json"
        rm = _j.loads(rp.read_text())
        for e in rm.values():
            e["records"] = [{k: p[k] for k in _V1 if k in p}
                            for p in e["records"]]
        rp.write_text(_j.dumps(rm, sort_keys=True))
        mp = gen_dir / "manifest.json"
        m = _j.loads(mp.read_text()); m["schema_version"] = sv
        m["record_map"]["sha256"] = hashlib.sha256(
            rp.read_bytes()).hexdigest()
        m["record_map"]["size_bytes"] = len(rp.read_bytes())
        mp.write_text(_j.dumps(m))
    mraw = (gen_dir / "manifest.json").read_bytes()
    coll = GenDb()["zaapi_kb_embedding_generations"]
    sources = {"zaapi_kb": {"revision_id": "rev:1", "record_count": len(recs)}}
    doc = {"_id": f"gen:{gid}", "generation_id": gid, "status": "ready",
           "created_at": "2026-11-04T01:02:03+00:00",
           "canonical_generation": schema.fingerprint(sources),
           "canonical_schema_revision": schema.SCHEMA_REVISION,
           "canonical_sources": sources,
           "record_set_digest": schema.fingerprint(
               sorted(r["record_id"] for r in recs)),
           "record_count": len(recs),
           "serialization": {"version": "semantic_text/v1"},
           "model": dict(_STUB_MODEL),
           "artifacts": {"manifest": {
               "file": "manifest.json",
               "sha256": hashlib.sha256(mraw).hexdigest(),
               "size_bytes": len(mraw), "format": "json"}}}
    coll.insert_one(doc)
    coll.insert_one({"_id": "active", "revision": 1, "generation_id": gid,
                     "previous_generation_id": None,
                     "canonical_generation": doc["canonical_generation"],
                     "activated_at": "2026-11-04T01:02:03+00:00"})
    return coll.database


# S1 [SCHEMA] artifact projection must pin typed fields (P1 contract)
@probe("S1 projection typed fields", "SCHEMA")
def s1():
    want = {"record_id", "shop", "platform", "item_id", "model_id",
            "subject_id", "target_id", "record_type", "topic",
            "readiness", "fact_fields", "answer_text", "steps"}
    missing = want - _PROJECTION_FIELDS
    assert not missing, f"projections lack {sorted(missing)} — rebuild req."


# R1 [BEHAV] same-subject different-topic — REAL needs_for_request→pool→compile
@probe("R1 production attribution chain", "BEHAV")
def r1():
    n0 = mkneed(subject_refs=("PB100P",), requested_facts=("charging_speed",))
    n1 = mkneed(subject_refs=("PB100P",), requested_facts=("warranty",))
    needs = (n0, n1)
    bare = channel_request("kb")   # what runtime emits today (single broadcast)
    covered = needs_for_request(bare, needs)   # REAL owner call
    print("  bare ch:kb needs_for_request:", [needs.index(n) for n in covered])
    rec_spec = {"kind": "kb_zaapi", "identity": "PB100P",
                **_meta(record_type="spec", topic_key="charging_speed",
                        fact_fields=("output_power_w",)),
                "payload": {"text": "PPS 5A output"}}
    rec_warr = {"kind": "kb_zaapi", "identity": "PB100P",
                **_meta(record_type="faq", topic_key="warranty"),
                "payload": {"text": "warranty 12 months"}}
    res = RetrievalExecutionResult(request_id=bare.request_id, source="kb",
                                   supporting_evidence=(rec_spec, rec_warr))
    pool = build_candidate_pool((res,))
    idx_of = {id(n): i for i, n in enumerate(needs)}
    prodish = {0, 1}
    tr = []
    final = _compile_evidence(          # REAL production compile
        pool, (), req_needs={bare.request_id: covered}, idx_of=idx_of,
        need_by_idx=dict(enumerate(needs)),
        prodish_idx=prodish, target_of={}, ref_needs={"PB100P": {0, 1}},
        trace=tr)
    emitted = [(e["kind"], e["need_indices"], e.get("payload"))
               for e in final]
    print("  REAL _compile_evidence:", emitted)
    spec = [e for e in final if e.get("payload", "").startswith("PPS")]
    warr = [e for e in final if e.get("payload", "").startswith("warranty")]
    assert spec and spec[0]["need_indices"] == (0,), \
        f"spec unions onto warranty need via production chain: {emitted}"
    assert warr and warr[0]["need_indices"] == (1,), \
        f"faq unions onto spec need via production chain: {emitted}"
    # positive control — identical needs SHOULD share evidence
    i0 = mkneed(subject_refs=("PB100P",), requested_facts=("charging_speed",))
    i1 = mkneed(subject_refs=("PB100P",), requested_facts=("charging_speed",))
    needsc = (i0, i1)
    cov = needs_for_request(bare, needsc)
    poolc = build_candidate_pool((res,))
    idxc = {id(n): i for i, n in enumerate(needsc)}
    fc = _compile_evidence(
        poolc, (), req_needs={bare.request_id: cov}, idx_of=idxc,
        need_by_idx=dict(enumerate(needsc)),
        prodish_idx={0, 1}, target_of={}, ref_needs={"PB100P": {0, 1}},
        trace=[])
    shared = all(e["need_indices"] == (0, 1) for e in fc)
    assert shared, "identical needs must share evidence (positive control)"


# R6 [BEHAV] wrong-topic FAQ + empty requested_facts — production chain
@probe("R6 wrong-topic faq / empty facts", "BEHAV")
def r6():
    n0 = mkneed(subject_refs=("PB100P",), requested_facts=("charging_speed",))
    n1 = mkneed(subject_refs=("PB100P",))   # empty requested_facts = broad
    needs = (n0, n1)
    bare = channel_request("kb")
    covered = needs_for_request(bare, needs)
    faq = {"kind": "kb_zaapi", "identity": "PB100P",
           **_meta(record_type="faq"),
           "payload": {"text": "warranty claim steps"}}
    res = RetrievalExecutionResult(request_id=bare.request_id, source="kb",
                                   supporting_evidence=(faq,))
    pool = build_candidate_pool((res,))
    idx_of = {id(n): i for i, n in enumerate(needs)}
    final = _compile_evidence(
        pool, (), req_needs={bare.request_id: covered}, idx_of=idx_of,
        need_by_idx=dict(enumerate(needs)),
        prodish_idx={0, 1}, target_of={}, ref_needs={"PB100P": {0, 1}},
        trace=[])
    got = [e["need_indices"] for e in final]
    print("  empty-ff FAQ need_indices:", got)
    # DESIRED gate: faq-type + empty fact_fields + need has spec-facts only
    #   → reject on n0; broad need (rf=∅) → accept on n1 → expect (1,)
    assert got and got[0] == (1,), \
        f"wrong-topic FAQ leaked onto spec-fact need: {got}"


# R7 [BEHAV] real rollback() v2→v1 on GenDb + real gen dirs
@probe("R7 generation rollback", "BEHAV")
def r7():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gid1, gid2 = ("g20261105-010203-abcdef12",
                      "g20261105-020304-abcdef12")
        recs = [record(item_id="111", model_id="M1", model_codes=(),
                       answer_text="spec")]
        coll = GenDb()["zaapi_kb_embedding_generations"]
        sources = {"zaapi_kb": {"revision_id": "rev:1",
                                "record_count": len(recs)}}
        cgen = schema.fingerprint(sources)
        for gid in (gid1, gid2):
            gdir = write_gen_dir(tmp, gid, recs, embed=embedding.embed_texts)
            mraw = (gdir / "manifest.json").read_bytes()
            coll.insert_one({
                "_id": f"gen:{gid}", "generation_id": gid, "status": "ready",
                "created_at": "2026-11-04T01:02:03+00:00",
                "canonical_generation": cgen,
                "canonical_schema_revision": schema.SCHEMA_REVISION,
                "canonical_sources": sources,
                "record_set_digest": schema.fingerprint(
                    sorted(r["record_id"] for r in recs)),
                "record_count": len(recs),
                "serialization": {"version": "semantic_text/v1"},
                "model": dict(_STUB_MODEL),
                "artifacts": {"manifest": {
                    "file": "manifest.json",
                    "sha256": hashlib.sha256(mraw).hexdigest(),
                    "size_bytes": len(mraw), "format": "json"}}})
        coll.insert_one({"_id": "active", "revision": 1,
                         "generation_id": gid2, "previous_generation_id": gid1,
                         "canonical_generation": cgen,
                         "activated_at": "2026-11-04T01:02:03+00:00"})
        out = rollback(coll.database, gid2, exports_root=tmp)
        ptr = coll.find_one({"_id": "active"})
        print(f"  rollback() → {out!r}; pointer gid: {ptr['generation_id']}")
        assert ptr["generation_id"] == gid1, \
            f"rollback did not repoint to previous: {out} / {ptr['generation_id']}"


def _v2_gen(tmp, gid, recs):
    """v2 fixture: v1 builder + post-edit record_map (typed projections)
    + manifest schema_version=2 — the ONLY honest v2 artifact today."""
    import json as _json
    gdir = write_gen_dir(tmp, gid, recs, embed=embedding.embed_texts)
    rm_path = gdir / "record_map.json"
    rm = _json.loads(rm_path.read_text())
    ext = {"record_type": "spec", "topic": "t", "readiness": "resolved",
           "fact_fields": (), "answer_text": "a", "steps": ()}
    for e in rm.values():
        for p in e["records"]:
            p.update(ext)
    rm_path.write_text(_json.dumps(rm, sort_keys=True))
    mp = gdir / "manifest.json"
    man = _json.loads(mp.read_text())
    man["schema_version"] = 2
    man["record_map"]["sha256"] = hashlib.sha256(
        rm_path.read_bytes()).hexdigest()
    man["record_map"]["size_bytes"] = len(rm_path.read_bytes())
    mp.write_text(_json.dumps(man, sort_keys=True))
    return gdir, mp


def _gen_doc(gid, recs, mraw, sources=None):
    sources = sources or {"zaapi_kb": {"revision_id": "rev:1",
                                       "record_count": len(recs)}}
    return {"_id": f"gen:{gid}", "generation_id": gid, "status": "ready",
            "created_at": "2026-11-04T01:02:03+00:00",
            "canonical_generation": schema.fingerprint(sources),
            "canonical_schema_revision": schema.SCHEMA_REVISION,
            "canonical_sources": sources,
            "record_set_digest": schema.fingerprint(
                sorted(r["record_id"] for r in recs)),
            "record_count": len(recs),
            "serialization": {"version": "semantic_text/v1"},
            "model": dict(_STUB_MODEL),
            "artifacts": {"manifest": {
                "file": "manifest.json",
                "sha256": hashlib.sha256(mraw).hexdigest(),
                "size_bytes": len(mraw), "format": "json"}}}


# R8 [BEHAV accepts-now] corrupt version → publish/rollback fail closed
@probe("R8 corrupt-version fail-closed", "BEHAV-NOW")
def r8():
    from shopeechat.kb_zaapi_generation import publish
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gid1, gidB = ("g20261105-010203-abcdef12",
                      "g20261105-020304-abcdef12")
        recs = [record(item_id="111", model_id="M1", model_codes=(),
                       answer_text="spec")]
        coll = GenDb()["zaapi_kb_embedding_generations"]
        for gid in (gid1, gidB):
            gdir = write_gen_dir(tmp, gid, recs, embed=embedding.embed_texts)
            mraw = (gdir / "manifest.json").read_bytes()
            coll.insert_one(_gen_doc(gid, recs, mraw))
        # corrupt: schema_version=99 in manifest of gidB + refresh doc sha
        mp = tmp / "zaapi_kb_gen" / gidB / "manifest.json"
        man = json.loads(mp.read_text()); man["schema_version"] = 99
        mp.write_text(json.dumps(man, sort_keys=True))
        coll.update_one({"_id": f"gen:{gidB}"}, {"$set": {
            "artifacts.manifest.sha256": hashlib.sha256(
                mp.read_bytes()).hexdigest(),
            "artifacts.manifest.size_bytes": len(mp.read_bytes())}})
        coll.insert_one({"_id": "active", "revision": 1,
                         "generation_id": gid1,
                         "previous_generation_id": None,
                         "canonical_generation":
                             coll.find_one({"_id": f"gen:{gid1}"})
                             ["canonical_generation"],
                         "activated_at": "t"})
        # publish() needs manifest coll — absent → reject:canonical_drift
        # proves nothing loads invalid artifacts; pointer must not move
        out = publish(coll.database, gidB, exports_root=tmp)
        ptr = coll.find_one({"_id": "active"})
        print(f"  publish(corrupt v99) → {out!r}; ptr={ptr['generation_id']}")
        assert out.startswith("reject"), f"corrupt accepted: {out}"
        assert ptr["generation_id"] == gid1, "pointer moved on corrupt gen"


# R9 [BEHAV] full v2 lifecycle — RED until loader/validator branch lands
@probe("R9 v2 deploy→publish→rollback", "BEHAV")
def r9():
    from shopeechat.kb_zaapi_generation import publish, rollback
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gid1, gid2 = ("g20261105-010203-abcdef12",
                      "g20261105-020304-abcdef12")
        db = GenDb()
        records, manifest = seed_canonical_state(db, [
            dict(item_id="111", model_id="M1", model_codes=(),
                 answer_text="spec")])
        coll = db["zaapi_kb_embedding_generations"]
        g1 = write_gen_dir(tmp, gid1, records, embed=embedding.embed_texts)
        coll.insert_one(_gen_doc(gid1, records,
                                 (g1 / "manifest.json").read_bytes(),
                                 sources=manifest["sources"]))
        _, mp2 = _v2_gen(tmp, gid2, records)
        coll.insert_one(_gen_doc(gid2, records, mp2.read_bytes(),
                                 sources=manifest["sources"]))
        coll.insert_one({"_id": "active", "revision": 1,
                         "generation_id": gid1,
                         "previous_generation_id": None,
                         "canonical_generation":
                             coll.find_one({"_id": f"gen:{gid1}"})
                             ["canonical_generation"],
                         "activated_at": "2026-11-04T01:02:03+00:00"})
        s1l = load_active_generation(db, exports_root=tmp)
        assert s1l is not None, "v1 active unreadable — loader regression"
        v2snap = load_generation_snapshot(db, gid2, exports_root=tmp)
        assert v2snap is not None, \
            "v2 artifacts rejected by loader — needs schema_version branch"
        out = publish(db, gid2, exports_root=tmp)
        assert out == "published", f"v2 publish: {out}"
        snap2 = load_active_generation(db, exports_root=tmp)
        assert snap2 is not None and snap2.generation_id == gid2
        back = rollback(db, gid2, exports_root=tmp)
        ptr = coll.find_one({"_id": "active"})
        assert back == "rolled-back" and ptr["generation_id"] == gid1, \
            f"rollback v2→v1: {back}"
        assert load_active_generation(db, exports_root=tmp) is not None


# R10 [BEHAV] wrong-topic FAQ matrix — typed topic authority
@probe("R10 faq topic matrix", "BEHAV")
def r10():
    def run(need_kw, faq_rec):
        n = mkneed(subject_refs=("PB100P",), **need_kw)
        bare = channel_request("kb")
        cov = needs_for_request(bare, (n,))
        res = RetrievalExecutionResult(request_id=bare.request_id,
                                       source="kb",
                                       supporting_evidence=(faq_rec,))
        pool = build_candidate_pool((res,))
        final = _compile_evidence(
            pool, (), req_needs={bare.request_id: cov},
            idx_of={id(n): 0}, need_by_idx={0: n}, prodish_idx={0},
            target_of={}, ref_needs={"PB100P": {0}}, trace=[])
        return tuple(j for e in final for j in e["need_indices"])

    def faq(topic=None, ff=()):
        # topic_key = derived at BUILD: topic if topic ∈ REQUESTED_FACTS
        #   else None (emitted on v2 projection); topic = legacy free
        #   string — governing rule: declared topic (key OR raw) decides
        return {"kind": "kb_zaapi", "identity": "PB100P",
                **_meta("faq", topic_key=(topic if topic in _RF else None),
                        topic=topic, fact_fields=tuple(ff)),
                "payload": {"text": "faq"}}
    _RF = {"price", "stock", "link", "description", "warranty",
           "data_transfer_speed", "charging_speed", "compatibility"}
    cases = [
        # (need, faq(topic,ff), desired) — governing rule:
        #   tkey∈rf→accept; tkey present ∉rf→reject; topic declared
        #   non-enum→reject specific; none→ff∩nf or broad only
        ({"requested_facts": ("warranty",)}, faq("shipping"), "reject"),
        ({"requested_facts": ("description",)}, faq("warranty"), "reject"),
        ({"requested_facts": ("warranty",)}, faq("warranty"), "accept"),
        ({"requested_facts": ("warranty",)}, faq("shipping", ("warranty",)),
         "reject"),   # conflict: declared topic governs over facts
        ({"requested_facts": ("warranty",)}, faq(None, ("warranty",)),
         "accept"),   # no declared topic → fact binding allowed
        ({"requested_facts": ("charging_speed",)},
         faq("charging safety", ("output_power_w",)),
         "reject"),   # non-enum declared topic → facts cannot rescue
        ({}, faq("shipping"), "accept"),                     # broad need
        ({}, faq(), "accept"),                               # broad + none
        ({"requested_facts": (), "capability_asks": ("does it do X",)},
         faq("shipping"), "reject"),                         # asks=specific
    ]
    bad = []
    for i, (nk, rec, want) in enumerate(cases):
        got = run(nk, rec)
        ok = (got == (0,)) if want == "accept" else (got == ())
        print(f"  case{i} rf={nk.get('requested_facts')} "
              f"faq(t={rec['meta'].get('topic')},"
              f"ff={rec['meta'].get('fact_fields')}) "
              f"→ {got} want {want}")
        if not ok:
            bad.append((i, got, want))
    assert not bad, f"gate violations on production path: {bad}"


# R11 [BEHAV] v1 adapter decline — ACTIVE v1 gen → zaapi_kb_evidence must
# emit nothing into the pool (loadable ≠ answer-eligible). Production seam:
# zaapi_kb_evidence() itself — the fetcher app.py:1218 installs.
@probe("R11 v1 adapter decline", "BEHAV")
def r11():
    from shopeechat import kb_zaapi as kz, knowledge_base as _kb
    with tempfile.TemporaryDirectory() as tmp:
        db = _gen_db(Path(tmp), "g20261105-010203-abcdef12",
                     [record(item_id="111", answer_text="x")],
                     sv=1)  # active v1 (schema_version=1 pinned)
        db[kz._COLL].insert_one(
            {"_id": "c1", "active": True, "unscoped": True,
             "fields": {"รุ่นสินค้า": "PB100P", "ชื่อแบรนด์": "X"},
             "source_name": "zaapi", "text": "PB100P spec text"})
        _orig_a, _orig_d = kz._zaapi_allowed, _kb._admin_db
        try:
            kz._zaapi_allowed = lambda: True
            _kb._admin_db = lambda: db
            from shopeechat.knowledge_base import extract_model_keywords
            kw = extract_model_keywords("PB100P")
            print("  keywords:", kw)
            assert kw, "keywords empty — adapter never reached find"
            res = kz.zaapi_kb_evidence(shop="s1", platform="shopee",
                                       message="PB100P")
        finally:
            kz._zaapi_allowed, _kb._admin_db = _orig_a, _orig_d
        got = res.supporting_evidence
        print("  adapter emitted:", [(e.get("kind")) for e in got])
        # v1 contract: adapter must decline — canonical read + emit is the
        # bug being fixed (v1 artifacts carry no typed routing).
        assert not got, f"v1 adapter emitted {len(got)} records into pool"


# R12 [BEHAV-NOW] legacy passthrough lock — exact app.py:2818 shape must
# keep existing behavior after zaapi gates land (gate keys kind="kb_zaapi")
@probe("R12 legacy kb passthrough lock", "BEHAV-NOW")
def r12():
    n0 = mkneed(subject_refs=("PB100P",), requested_facts=("warranty",))
    n1 = mkneed(subject_refs=("PB100P",), requested_facts=("charging_speed",))
    needs = (n0, n1)
    bare = channel_request("kb")
    legacy = {"kind": "kb", "request_id": "ch:kb",
              "payload": {"text": "legacy kb context"}}
    res = RetrievalExecutionResult(request_id=bare.request_id, source="kb",
                                   supporting_evidence=(legacy,))
    cov = needs_for_request(bare, needs)
    pool = build_candidate_pool((res,))
    final = _compile_evidence(
        pool, (), req_needs={bare.request_id: cov},
        idx_of={id(n): i for i, n in enumerate(needs)},
        need_by_idx=dict(enumerate(needs)),
        prodish_idx={0, 1}, target_of={}, ref_needs={"PB100P": {0, 1}},
        trace=[])
    got = [e["need_indices"] for e in final]
    print("  legacy kind=kb need_indices:", got)
    assert got == [(0, 1)], f"legacy behavior changed: {got}"


# R13 [BEHAV-NOW] source isolation — real kb_source() gate both ways:
# legacy selected → zero zaapi reads; zaapi selected → zero legacy calls.
@probe("R13 source isolation", "BEHAV-NOW")
def r13():
    from shopeechat import kb_zaapi as kz, knowledge_base as _kb
    from shopeechat import runtime_config as _rcfg
    calls, reads = [], []
    db = GenDb(colls={kz._COLL: [
        {"_id": "c1", "active": True, "unscoped": True,
         "fields": {"รุ่นสินค้า": "PB100P"}, "text": "t"}]})
    canon = db[kz._COLL]
    _orig_f, _orig_d, _orig_l, _orig_c = (canon.find, _kb._admin_db,
                                        _kb.lookup_kb,
                                        _rcfg.get_runtime_config)
    try:
        canon.find = lambda *a, **k: reads.append(1) or _orig_f(*a, **k)
        _kb.lookup_kb = lambda *a, **k: calls.append(1) or _orig_l(*a, **k)
        _kb._admin_db = lambda: db
        # direction 1: legacy selected → REAL _zaapi_allowed() must close
        _rcfg.get_runtime_config = lambda force_refresh=False: \
            {"kb_source": "legacy"}
        res_leg = kz.zaapi_kb_evidence(shop="s1", platform="shopee",
                                     message="PB100P")
        legacy_reads = len(reads)
        # direction 2: zaapi selected → must not touch legacy lookup_kb
        _rcfg.get_runtime_config = lambda force_refresh=False: \
            {"kb_source": "zaapi"}
        res_zaa = kz.zaapi_kb_evidence(shop="s1", platform="shopee",
                                     message="PB100P")
    finally:
        canon.find, _kb._admin_db = _orig_f, _orig_d
        _kb.lookup_kb, _rcfg.get_runtime_config = _orig_l, _orig_c
    print("  legacy-selected:", res_leg.trace, "zaapi_reads:", legacy_reads)
    print("  zaapi-selected:", res_zaa.trace,
          "zaapi reads:", len(reads), "legacy calls:", len(calls))
    assert legacy_reads == 0, "zaapi canonical read under legacy source"
    assert not calls, "zaapi path called legacy lookup_kb"


# S2 [SCHEMA] version semantics — manifest schema_version + serialization
@probe("S2 artifact/serialization versions", "SCHEMA")
def s2():
    # manifest schema_version must become 2 for extended projections
    roles = {"vectors": {}, "record_map": {}, "structured_index": {}}
    m = build_manifest_payload("g", roles)
    print("  manifest schema_version:", m["schema_version"])
    assert m["schema_version"] == 2, \
        f"schema_version still {m['schema_version']} — needs 2 + loader branch"
    # serialization stays semantic_text/v1 IF renderer unchanged — the
    #   record_map/projection shape is the manifest's job, not the text's
    assert schema.__dict__.get("SERIALIZATION_VERSION", "x") in (
        "semantic_text/v1", "x"), "serialization version contract"


# R3 [BEHAV] model_id→variant key + KB-only boundary — REAL pool
@probe("R3 model/item join + KB-only", "BEHAV")
def r3():
    n0 = mkneed(subject_refs=("111",))
    card88 = {"item_id": "111", "model_id": "88", "name": "PB X"}
    card99 = {"item_id": "111", "model_id": "99", "name": "PB X Pro"}
    r_slot = replace(channel_request("slot"), request_id="req-0",
                     subject_refs=("111",))
    res_slot = RetrievalExecutionResult(request_id="req-0", source="slot",
                                        eligible_candidates=(card88, card99))
    att_item = {"kind": "kb_product", "identity": "i:111",
                "identity_domain": "item", "item_id": "111",
                "payload": {"text": "item spec"}}
    # real record model_id "88" numeric → variant key v:111#88
    att_m88 = {"kind": "kb_product", "identity": "v:111#88",
               "identity_domain": "model", "item_id": "111",
               "payload": {"text": "variant-88 fact"}}
    res_kb = RetrievalExecutionResult(
        request_id="ch:kb:0", source="kb",
        attachment_evidence=(att_item, att_m88))
    pool, final, _ = compile_evs(
        (res_slot, res_kb), (r_slot,), (n0,),
        ref_needs={"i:111": {0}, "111": {0}, "v:111#88": {0},
                   "v:111#99": {0}})
    links = {(a.identity_domain, a.identity, a.linked_candidate)
             for a in pool.evidence_pool}
    print("  joins:", sorted(links))
    assert ("item", "i:111", "v:111#88") in links
    assert ("item", "i:111", "v:111#99") in links
    assert ("model", "v:111#88", "v:111#88") in links, \
        "model-domain join to exact variant failed"
    # name-shaped model_id cannot form v: key — contract: item-domain/supporting
    assert not any("M-X" in str(l) for l in links)
    # KB-only: no candidates → attachment unlinked, no card created
    pool2 = build_candidate_pool((res_kb,))
    assert len(pool2.eligible) == 0, "KB-only created a candidate!"
    unl = [a for a in pool2.evidence_pool if "unlinked" in a.trace]
    assert len(unl) == 2, f"unlinked attachments expected: {unl}"
    print("  KB-only: 0 candidates, attachments unlinked — no card/stock")


# R14 [BEHAV] zaapi v2 typed attachment — metadata must survive
# dict→EvidenceAttachment (candidate_pool.py:384) AND rec rebuild
# (answer_context.py:814) so _attribute can gate. Same product, two
# needs different topics → must bind only the matching need.
@probe("R14 zaapi v2 typed attachment gate", "BEHAV")
def r14():
    n0 = mkneed(subject_refs=("111",), requested_facts=("charging_speed",))
    n1 = mkneed(subject_refs=("111",), requested_facts=("warranty",))
    needs = (n0, n1)
    card88 = {"item_id": "111", "model_id": "88", "name": "PB X"}
    r_slot = replace(channel_request("slot"), request_id="req-0",
                     subject_refs=("111",))
    res_slot = RetrievalExecutionResult(request_id="req-0", source="slot",
                                        eligible_candidates=(card88,))
    att = {"kind": "kb_zaapi", "identity": "i:111",
           "identity_domain": "item", "item_id": "111",
           # meta = single declared channel for routing/typed fields;
           # poison keys must NOT be selectable — impl must copy only
           # the closed _ROUTING_META_KEYS set, never blanket-update rec
           "meta": {"record_type": "spec", "topic_key": "charging_speed",
                    "fact_fields": ("output_power_w",),
                    "request_id": "ch:kb:0", "readiness": "resolved",
                    "record_id": "rec-att",
                    "kind": "listing", "item_id": "999",
                    "linked_candidate": "v:x", "need_indices": (1,)},
           "payload": {"text": "5A output"}}
    res_kb = RetrievalExecutionResult(request_id="ch:kb:0", source="kb",
                                      attachment_evidence=(att,))
    cov0 = needs_for_request(r_slot, needs)
    pool = build_candidate_pool((res_slot, res_kb))
    conv = [a for a in pool.evidence_pool if a.kind == "kb_zaapi"]
    print("  attachment in pool:", [(a.identity, a.linked_candidate)
                                   for a in conv])
    # data-contract point: meta dict must survive conversion intact
    assert conv and (getattr(conv[0], "meta", None) or {}).get(
        "topic_key") == "charging_speed", \
        "meta lost at dict→EvidenceAttachment conversion"
    idx_of = {id(n): i for i, n in enumerate(needs)}
    final = _compile_evidence(
        pool, (), req_needs={r_slot.request_id: cov0}, idx_of=idx_of,
        need_by_idx=dict(enumerate(needs)),
        prodish_idx={0, 1}, target_of={},
        ref_needs={"V:111#88": {0, 1}, "I:111": {0, 1}}, trace=[])
    got = [(e["identity"], e["need_indices"]) for e in final
           if e["kind"] == "kb_zaapi"]
    print("  zaapi attachment (identity, needs):", got)
    # post-impl GREEN: identity stays i:111 (poison keys not selectable),
    # need_indices (0,) only — topic gate + selective copy
    assert got == [("i:111", (0,))], \
        f"typed attachment leaked/overwritten: {got}"


# R15 [BEHAV] meta validator — malformed typed metadata must be rejected
# (record loses eligibility), valid meta must bind. Acceptance gate for
# impl: _ROUTING_META_KEYS whitelist is not enough — shape+type checked.
@probe("R15 malformed meta rejection", "BEHAV")
def r15():
    need = mkneed(subject_refs=("111",), requested_facts=("warranty",))
    needs = (need,)
    r_kb = replace(channel_request("kb"), request_id="ch:kb:0",
                   subject_refs=("111",))
    valid = {"kind": "kb_zaapi", "identity": "PB100P",
             "meta": {"record_type": "faq", "topic_key": "warranty",
                      "fact_fields": (), "request_id": "ch:kb:0",
                      "readiness": "resolved", "record_id": "rec-v"},
             "payload": {"text": "warranty 12m"}}
    bad = {"kind": "kb_zaapi", "identity": "PB100P",
           "meta": {"record_type": 42, "topic_key": 123,          # wrong types
                    "fact_fields": "warranty",                    # str not tuple
                    "request_id": ["ch:kb:0"], "score": "high"},  # wrong types
           "payload": {"text": "malformed"}}
    res = RetrievalExecutionResult(request_id="ch:kb:0", source="kb",
                                   supporting_evidence=(valid, bad))
    cov = needs_for_request(r_kb, needs)
    pool = build_candidate_pool((res,))
    tr = []
    final = _compile_evidence(
        pool, (), req_needs={r_kb.request_id: cov},
        idx_of={id(need): 0}, need_by_idx={0: need}, prodish_idx={0},
        target_of={}, ref_needs={"PB100P": {0}}, trace=tr)
    got = [e["need_indices"] for e in final if e["kind"] == "kb_zaapi"]
    print("  valid+malformed zaapi need_indices:", got)
    print("  drops:", [t for t in tr if "dropped" in t])
    # meta contract: required = record_type(str∈RecordType) +
    # request_id(str); optional = topic_key/fact_fields/readiness/
    # record_id/answer_text/steps/score — present keys type-checked,
    # absent optional keys OK, malformed → declined + zaapi_meta_invalid
    assert got == [(0,)], \
        f"meta validation missing — valid={got}, malformed must be []"
    assert any("zaapi_meta_invalid" in t for t in tr), \
        "malformed drop must be traced as zaapi_meta_invalid"


# R16 [BEHAV] long answer_text/steps must not trip the 1500-byte structural
# cap — tips owner consumes them PRE-compile; emitted record carries
# payload.text once (answer_text/steps NOT in _EVIDENCE_OUT_FIELDS).
@probe("R16 long answer/steps byte-cap", "BEHAV")
def r16():
    need = mkneed(subject_refs=("111",))
    needs = (need,)
    r_kb = replace(channel_request("kb"), request_id="ch:kb:0",
                   subject_refs=("111",))
    long_ans = "คำตอบยาวมาก " * 200          # ~2200 chars
    long_steps = tuple(f"ขั้นตอนที่ {i} ทำตามนี้ยาวๆ" for i in range(20))
    # faq (not troubleshooting — that type is rejected on productish needs)
    # on a broad need: gate must accept; byte-cap must not drop it.
    # long troubleshooting tips ride the same meta channel → same cap
    # contract at the tips owner (separate seam, not AnswerContext)
    rec = {"kind": "kb_zaapi", "identity": "PB100P",
           "meta": {"record_type": "faq", "readiness": "resolved",
                    "record_id": "rec-long", "request_id": "ch:kb:0",
                    "answer_text": long_ans, "steps": long_steps},
           # payload.text = real rendered text containing answer+steps —
           # record must survive structural cap; payload cut per existing
           # byte budget + evidence_truncated trace
           "payload": {"text": long_ans + " " + " ".join(long_steps)}}
    res = RetrievalExecutionResult(request_id="ch:kb:0", source="kb",
                                   supporting_evidence=(rec,))
    cov = needs_for_request(r_kb, needs)
    pool = build_candidate_pool((res,))
    tr = []
    final = _compile_evidence(
        pool, (), req_needs={r_kb.request_id: cov},
        idx_of={id(need): 0}, need_by_idx={0: need}, prodish_idx={0},
        target_of={}, ref_needs={"PB100P": {0}}, trace=tr)
    got = [e for e in final if e["kind"] == "kb_zaapi"]
    print("  emitted records:", len(got), "drops:",
          [t for t in tr if "dropped" in t])
    # desired: record survives — structural bytes stay small because
    # answer_text/steps are NOT emitted fields (consumed pre-compile)
    assert got and got[0]["need_indices"] == (0,), \
        f"record dropped — answer/steps must not enter structural bytes"


# R4 [SCHEMA] semantic score + typed fields on emitted evidence
@probe("R4 semantic score emission", "SCHEMA")
def r4():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gid = "g20261105-020304-abcdef12"
        recs = [record(item_id="111", model_id="M1", aliases=("PB-X",),
                       model_codes=(), answer_text="spec of PB-X"),
                record(record_type="faq", topic="warranty", item_id=None,
                       model_id=None, model_codes=(), subject_id=None,
                       readiness="unresolved",
                       answer_text="how to claim warranty")]
        db = _gen_db(tmp, gid, recs)
        snap = load_active_generation(db, exports_root=tmp)
        r = retrieve(snap, shop="ShopA", platform="shopee",
                     semantic_query="how to claim warranty")
        evs = r.supporting_evidence
        print("  semantic hits:", [(e.get("identity"), e.get("kind"))
                                   for e in evs])
        assert any(e.get("identity") is None for e in evs), \
            "null-identity FAQ expected in semantic scope (shop/platform)"
        assert all(
            isinstance((e.get("meta") or {}).get("score"), (int, float))
            for e in evs), \
            "score not emitted — semantic relevance unverifiable"
        assert all((e.get("meta") or {}).get("record_id") for e in evs), \
            "record_id missing from meta"


# R5 [SCHEMA] troubleshooting typed contract for tips/policy owners
@probe("R5 troubleshoot typed fields", "SCHEMA")
def r5():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gid = "g20261105-030405-abcdef12"
        recs = [record(record_type="troubleshooting", topic="charging",
                       item_id="111", model_id="M1", model_codes=(),
                       answer_text="กดปุ่มค้าง 10 วิ แล้วลองชาร์จใหม่",
                       steps=("hold power 10s", "replug")),
                record(record_type="faq", topic="warranty",
                       item_id="222", model_id="M2", model_codes=(),
                       answer_text="warranty answer")]
        db = _gen_db(tmp, gid, recs)
        snap = load_active_generation(db, exports_root=tmp)
        r = retrieve(snap, shop="ShopA", platform="shopee",
                     item_ids=("111",), semantic_query="ชาร์จไม่เข้า")
        evs = r.supporting_evidence
        print("  emitted:", sorted(evs[0].keys()) if evs else [])
        by_item = {e.get("item_id"): e for e in evs}
        # meta = single typed channel; required on every zaapi record:
        # record_type/readiness/record_id; optional: answer_text/steps/
        # topic_key/fact_fields/request_id (present ⇒ type-checked)
        for f in ("record_type", "readiness", "record_id"):
            assert all((e.get("meta") or {}).get(f) is not None
                   for e in evs), f"required {f} missing from meta"
        # score = OPTIONAL — semantic-origin only; exact hits dedupe
        # first and carry none (contract: no score invented for exact)
        assert by_item.get("111") and \
            (by_item["111"].get("meta") or {}).get("score") is None, \
            "exact hit must not carry a score"
        assert isinstance(
            (by_item.get("222", {}).get("meta") or {}).get("score"),
            (int, float)), "semantic hit must carry numeric score"


# R17 [BEHAV] fact-vocabulary join (H1) — need `requested_facts`
# vocabulary (charging_speed/data_transfer_speed) must cover canonical
# fact keys (output_power_w/data_transfer_mbps) through the EXISTING
# _REQUESTED_FACT_KEYS owner — no second mapping owner allowed.
@probe("R17 fact vocabulary join", "BEHAV")
def r17():
    n0 = mkneed(subject_refs=("PB100P",), requested_facts=("charging_speed",))
    n1 = mkneed(subject_refs=("PB100P",), requested_facts=("warranty",))
    spec_charge = {"kind": "kb_zaapi", "identity": "PB100P",
                   **_meta("spec", fact_fields=("output_power_w",)),
                   "payload": {"text": "spec 120W"}}
    faq_war = {"kind": "kb_zaapi", "identity": "PB100P",
               **_meta("faq", topic_key="warranty",
                       fact_fields=("warranty",)),
               "payload": {"text": "warranty faq"}}
    spec_cap = {"kind": "kb_zaapi", "identity": "PB100P",
                **_meta("spec", fact_fields=("capacity_mah",)),
                "payload": {"text": "spec mah"}}
    res = RetrievalExecutionResult(
        request_id="ch:kb", source="kb",
        supporting_evidence=(spec_charge, faq_war, spec_cap))
    needs = (n0, n1)
    bare = channel_request("kb")
    cov = needs_for_request(bare, needs)
    pool = build_candidate_pool((res,))
    final = _compile_evidence(
        pool, (), req_needs={bare.request_id: cov},
        idx_of={id(n): i for i, n in enumerate(needs)},
        need_by_idx=dict(enumerate(needs)),
        prodish_idx={0, 1}, target_of={}, ref_needs={"PB100P": {0, 1}},
        trace=[])
    got = {e["payload"]: e["need_indices"]
           for e in final if e["kind"] == "kb_zaapi"}
    print("  fact-join:", got)
    # charging_speed need covers output_power_w via declared mapping —
    #   fact evidence must reach the right need, wrong-topic must not
    assert got.get("spec 120W") == (0,), \
        f"output_power_w spec did not reach charging_speed need: {got}"
    assert got.get("warranty faq") == (1,), \
        f"warranty faq wrong binding: {got}"
    assert "spec mah" not in got or got["spec mah"] == (), \
        f"capacity_mah spec leaked: {got}"

    # positive control — data_transfer_speed ↔ data_transfer_mbps
    nd = mkneed(subject_refs=("PB100P",),
                requested_facts=("data_transfer_speed",))
    spec_xfer = {"kind": "kb_zaapi", "identity": "PB100P",
                 **_meta("spec", fact_fields=("data_transfer_mbps",)),
                 "payload": {"text": "480Mbps"}}
    res2 = RetrievalExecutionResult(request_id="ch:kb", source="kb",
                                    supporting_evidence=(spec_xfer,))
    pool2 = build_candidate_pool((res2,))
    final2 = _compile_evidence(
        pool2, (), req_needs={bare.request_id: (nd,)},
        idx_of={id(nd): 0}, need_by_idx={0: nd},
        prodish_idx={0}, target_of={}, ref_needs={"PB100P": {0}},
        trace=[])
    got2 = [e["need_indices"] for e in final2 if e["kind"] == "kb_zaapi"]
    print("  data_transfer control:", got2)
    assert got2 == [(0,)], \
        f"data_transfer_mbps spec did not reach data_transfer_speed: {got2}"


# R18 [BEHAV] subject/target role separation (H2) — adapter→retrieve→pool
# path: subject refs must query subject-side namespaces only, target refs
# must query the target_ids channel; role swap must not false-match.
@probe("R18 subject/target role separation", "BEHAV")
def r18():
    from shopeechat import kb_zaapi as kz, knowledge_base as _kb
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gid = "g20261105-030303-abcdef12"
        recs = [
            # compat record: subject CB-1 × target iphone17
            record(record_type="compatibility", topic="compatibility",
                   model_codes=("CB-1",), subject_id="CB-1",
                   target_id="iphone17",
                   facts=({"key": "compatible", "value": True},),
                   answer_text="CB-1 works with iphone17"),
            # spec about PB100P as SUBJECT (for role-swap trap)
            record(model_codes=("PB100P",), subject_id="PB100P",
                   target_id=None,
                   facts=({"key": "output_power_w", "value": 120},),
                   answer_text="PB100P spec"),
        ]
        db = _gen_db(tmp, gid, recs)
        _orig_a, _orig_d = kz._zaapi_allowed, _kb._admin_db
        try:
            kz._zaapi_allowed = lambda: True
            _kb._admin_db = lambda: db
            # case 1 — subject+target both resolve: hit
            n1 = mkneed(kind="compat", operation="compat",
                        subject_refs=("CB-1",), target_refs=("iphone17",))
            r1 = kz.zaapi_kb_evidence(shop="ShopA", platform="shopee",
                                      needs=(n1,), exports_root=tmp)
            ids1 = [e["meta"]["record_id"][:12]
                    for e in r1.supporting_evidence]
            print("  case1 subject+target:", len(r1.supporting_evidence))
            assert r1.supporting_evidence, \
                "compat record not found via subject+target channels"

            # case 2 — subject misses, target carries: target_ids channel
            #   must find the compat record (bug: target → subject ns = miss)
            n2 = mkneed(kind="compat", operation="compat",
                        subject_refs=("ZZ9",), target_refs=("iphone17",))
            r2 = kz.zaapi_kb_evidence(shop="ShopA", platform="shopee",
                                      needs=(n2,), exports_root=tmp)
            print("  case2 target-only:", len(r2.supporting_evidence))
            assert r2.supporting_evidence, \
                "target_id-only match lost — target ref never queried as target"

            # case 3 — role swap: target ref "PB100P" must NOT hit the
            #   PB100P spec (target is not a subject-side identity)
            n3 = mkneed(kind="compat", operation="compat",
                        subject_refs=("ZZ9",), target_refs=("PB100P",))
            r3 = kz.zaapi_kb_evidence(shop="ShopA", platform="shopee",
                                      needs=(n3,), exports_root=tmp)
            print("  case3 role-swap:", len(r3.supporting_evidence))
            assert not r3.supporting_evidence, \
                "target ref matched subject identity — role leak"
        finally:
            kz._zaapi_allowed, _kb._admin_db = _orig_a, _orig_d


# R19 [BEHAV] meta validation truth table (M1) — enum membership +
# finite-score boundary at the same single validator; legacy unaffected.
@probe("R19 meta validation truth table", "BEHAV")
def r19():
    need = mkneed(subject_refs=("PB100P",), requested_facts=("warranty",))
    bare = channel_request("kb")
    cov = needs_for_request(bare, (need,))

    def run(meta_over, kind="kb_zaapi"):
        m = {"record_type": "faq", "readiness": "resolved",
             "record_id": "r-1", "request_id": "ch:kb:0",
             "topic_key": "warranty"}
        m.update(meta_over)
        e = ({"kind": kind, "request_id": "ch:kb",
              "payload": {"text": "legacy"}}
             if kind != "kb_zaapi"
             else {"kind": "kb_zaapi", "identity": "PB100P",
                   "meta": m, "payload": {"text": "t"}})
        res = RetrievalExecutionResult(request_id="ch:kb:0", source="kb",
                                       supporting_evidence=(e,))
        pool = build_candidate_pool((res,))
        tr = []
        final = _compile_evidence(
            pool, (), req_needs={"ch:kb:0": cov, "ch:kb": cov},
            idx_of={id(need): 0}, need_by_idx={0: need},
            prodish_idx={0}, target_of={}, ref_needs={"PB100P": {0}},
            trace=tr)
        bound = [x["need_indices"] for x in final
                 if x["kind"] == kind]
        return bound, tr

    nan = float("nan"); inf = float("inf")
    cases = [
        ("record_type outside RecordType", {"record_type": "bogus"}, False),
        ("readiness outside Readiness", {"readiness": "bogus"}, False),
        ("readiness unresolved (not resolved)", {"readiness": "unresolved"}, False),
        ("readiness conflicted", {"readiness": "conflicted"}, False),
        ("topic_key outside REQUESTED_FACTS", {"topic_key": "not_a_fact"}, False),
        ("score bool", {"score": True}, False),
        ("score NaN", {"score": nan}, False),
        ("score +inf", {"score": inf}, False),
        ("score -inf", {"score": -inf}, False),
        ("fact_fields str not tuple", {"fact_fields": "warranty"}, False),
        ("fact_fields non-str elem", {"fact_fields": (7,)}, False),
        ("valid — no score (exact)", {}, True),
        ("valid — finite score", {"score": 0.83}, True),
        ("valid — int score", {"score": 1}, True),
    ]
    bad = []
    for name, over, want in cases:
        got, tr = run(over)
        ok = (got == [(0,)]) == want
        if want is False:
            ok = ok and any("zaapi_meta_invalid" in t for t in tr)
        print(f"  {name}: bound={got} want={want} "
              f"trace={['zaapi_meta_invalid' in t for t in tr]}")
        if not ok:
            bad.append(name)
    # legacy kind=kb — old contract, no meta required
    lg, _ = run({}, kind="kb")
    print("  legacy kind=kb bound:", lg)
    if lg != [(0,)]:
        bad.append("legacy kind=kb regressed")
    assert not bad, f"validator gaps: {bad}"


# R20 [BEHAV] attachment target integrity (H1 round-2) — compat record
#   ที่ resolve item_id เดินทาง attachment path (adapter → EvidenceAttachment
#   → pool.evidence_pool → _compile_evidence → _attribute): declared target
#   ต้องรอดถึง gate; wrong-device ผูก item เดียวกันก็ต้องไม่เข้า need ต่าง device
@probe("R20 attachment target integrity", "BEHAV")
def r20():
    from shopeechat import kb_zaapi as kz, knowledge_base as _kb
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gid = "g20261105-050505-abcdef12"
        recs = [
            # wrong device — item_id set → attachment path (the H1 leak)
            record(record_type="compatibility", topic="compatibility",
                   model_codes=("CTC620P",), subject_id="CTC620P",
                   item_id="i-ct", target_id="iphone 17",
                   facts=({"key": "compatible", "value": True},),
                   answer_text="CTC620P works with iphone 17"),
            # positive control — same subject+item, requested device
            record(record_type="compatibility", topic="compatibility",
                   model_codes=("CTC620P",), subject_id="CTC620P",
                   item_id="i-ct", target_id="xiaomi 17 ultra",
                   facts=({"key": "compatible", "value": True},),
                   answer_text="CTC620P works with xiaomi 17 ultra"),
        ]
        db = _gen_db(tmp, gid, recs)
        _orig_a, _orig_d = kz._zaapi_allowed, _kb._admin_db
        try:
            kz._zaapi_allowed = lambda: True
            _kb._admin_db = lambda: db
            need = mkneed(kind="compat", operation="compat",
                          subject_refs=("CTC620P",),
                          target_refs=("xiaomi 17 ultra",))
            res = kz.zaapi_kb_evidence(shop="ShopA", platform="shopee",
                                       needs=(need,), exports_root=tmp,
                                       request_id="ch:kb:0")
            # attachment path must be exercised — item_id resolved
            assert res.attachment_evidence, \
                f"fixture must produce attachments: {res.trace}"
            print(f"  adapter attachments={len(res.attachment_evidence)} "
                  f"sup={len(res.supporting_evidence)}")
            req = RetrievalExecutionResult(
                request_id="ch:kb:0", source="kb",
                attachment_evidence=tuple(res.attachment_evidence))
            pool = build_candidate_pool((req,))
            # item-bound identity → compat need (selected-subject seam)
            tr = []
            final = _compile_evidence(
                pool, (), req_needs={"ch:kb:0": (need,)},
                idx_of={id(need): 0}, need_by_idx={0: need},
                prodish_idx={0}, target_of={0: "xiaomi 17 ultra"},
                ref_needs={"I:I-CT": {0}, "I-CT": {0},
                           "CTC620P": {0}}, trace=tr)
            compats = [e for e in final
                       if e.get("kind") == "kb_zaapi"
                       and e.get("record_type") == "compatibility"]
            print("  ctx compat evidence:",
                  [(e.get("target"), e.get("need_indices"),
                    (e.get("payload") or "")[:40]) for e in compats])
            tgts = {e.get("target") for e in compats}
            assert "iphone 17" not in tgts, \
                f"wrong-device compat attachment leaked into ctx: {compats}"
            assert "xiaomi 17 ultra" in tgts, \
                f"positive control (same-item xiaomi) missing: {compats}"
            # no-target compat fail-closed at gate — canonical schema
            #   already rejects resolved compat without target_id
            #   (canonical_record_id raises; readiness→INVALID) so this
            #   shape can only arrive crafted: supporting-path dict with
            #   no "target" key must NOT bind a target-bearing need —
            #   missing evidence = cannot verify, not universal
            pool3 = build_candidate_pool((RetrievalExecutionResult(
                request_id="ch:kb:0", source="kb",
                supporting_evidence=({
                    "kind": "kb_zaapi", "identity": "CTC620P",
                    "meta": {"record_type": "compatibility",
                             "readiness": "resolved",
                             "record_id": "rec-notarget",
                             "request_id": "ch:kb:0"},
                    "payload": {"text": "crafted compat no target"}},)),))
            tr3 = []
            final3 = _compile_evidence(
                pool3, (), req_needs={"ch:kb:0": (need,)},
                idx_of={id(need): 0}, need_by_idx={0: need},
                prodish_idx={0}, target_of={0: "xiaomi 17 ultra"},
                ref_needs={"CTC620P": {0}}, trace=tr3)
            assert not any(
                e.get("kind") == "kb_zaapi"
                and e.get("record_type") == "compatibility"
                for e in final3), \
                f"no-target compat leaked via supporting path: {final3}"
            # legacy attachment control — non-zaapi kind unaffected
            pool2 = build_candidate_pool((RetrievalExecutionResult(
                request_id="ch:kb:0", source="kb",
                attachment_evidence=({"kind": "anchor",
                                      "identity": "i:i-ct",
                                      "item_id": "i-ct",
                                      "linked_candidate": None,
                                      "payload": {"text": "anchor ev"}},)),))
            tr2 = []
            final2 = _compile_evidence(
                pool2, (), req_needs={"ch:kb:0": (need,)},
                idx_of={id(need): 0}, need_by_idx={0: need},
                prodish_idx={0}, target_of={0: "xiaomi 17 ultra"},
                ref_needs={"I:I-CT": {0}, "I-CT": {0}}, trace=tr2)
            assert any(e.get("kind") == "anchor" for e in final2), \
                f"legacy attachment control regressed: {final2} {tr2}"
        finally:
            kz._zaapi_allowed, _kb._admin_db = _orig_a, _orig_d


if __name__ == "__main__":
    s1(); s2(); r1(); r3(); r4(); r5(); r6(); r7(); r8(); r9(); r10(); r11()
    r12(); r13(); r14(); r15(); r16(); r17(); r18(); r19(); r20()
    print("\n=== RESULTS ===")
    for name, st in RESULTS:
        print(f"  [{CLS[name]}] {name}: {st}")
    reds = sum(1 for _, s in RESULTS if s != "PASS")
    print(f"  {len(RESULTS) - reds}/{len(RESULTS)} pass, {reds} RED")
    sys.exit(1 if reds else 0)

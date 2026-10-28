"""Phase 10B — description_embeddings.npz builder contract (fixture only).

proves: deterministic chunk rows, canonical item_id/chunk_id mapping, shop
mapping, malformed/empty exclusion, finite dim-1024 vectors, runtime
_desc_vectors load, fetch→product mapping, anchor isolation, old-gen no-op,
corrupt-artifact fail-closed, publish gate.  stub embedder+tokenizer — no
BGE-M3/Mongo/provider.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from chatbot.shopeechat.scripts.build_embeddings import build_description_npz
from chatbot.shopeechat.embedding import (
    EMBEDDING_DIM, DESC_CHUNK_TOKENS, build_description_chunks)
from chatbot.shopeechat import product_store as _ps

IID_A = 27639651334          # CMC615P-like — 480Mbps เฉพาะใน description
IID_B = 49267582152          # cable อื่น — chunk ที่ match แรงกว่า
IID_C = 50000000001          # multi-chunk
IID_D = 50000000002          # empty desc → zero rows
DESC_480 = ("สายชาร์จแม่เหล็ก CUKTECH CMC615P 240W\n"
            "รองรับการถ่ายโอนข้อมูล 480Mbps สายถักถุงน่อง")
DESC_B = "สายชาร์จ CTL301 3A\nสายยาว 1 เมตร น้ำหนักเบา"
DESC_C = "p1 a b c\np2 d e\np1 a b c\np3 f"   # dup para + 3 unique paras
VARIANT_DESC = "เสื้อ size L สีแดง\nคงเหลือ variant M"  # listing-level เท่านั้น


class _FakeTok:
    """whitespace tokenizer — 1 word = 1 token (ไม่ใช่ BGE-M3)"""
    def __call__(self, paras, add_special_tokens=True):
        return {"input_ids": [[hash(w) & 0xFFFF for w in p.split()]
                              for p in paras]}

    def decode(self, ids):
        return " ".join(str(i) for i in ids)


def _fake_embed(texts, batch_size=64):
    """deterministic finite vectors — stub เท่านั้น"""
    out = np.zeros((len(texts), EMBEDDING_DIM), dtype=np.float32)
    for i, t in enumerate(texts):
        out[i] = (hash(t) & 0xFF) / 255.0 + i * 1e-4
    return out


def _fixture_export() -> list[dict]:
    return [
        {"item_id": IID_A, "item_name": "CMC615P cable",
         "shopname": "shopX", "description": DESC_480},
        {"item_id": IID_B, "item_name": "CTL301 cable",
         "shopname": "shopY", "description": DESC_B},
        {"item_id": IID_C, "item_name": "Multi C",
         "shopname": "shopX", "description": DESC_C},
        {"item_id": IID_D, "item_name": "NoDesc",
         "shopname": "shopX", "description": ""},
        {"item_id": None, "item_name": "NoID",
         "shopname": "shopX", "description": "x"},
        {"item_name": "NoIIDField", "shopname": "shopX",
         "description": "x"},                        # missing item_id key
        {"item_id": IID_A, "item_name": "DUP of A",  # duplicate doc → first wins
         "shopname": "shopX", "description": "different desc"},
        {"item_id": 50000000003, "item_name": "VariantShirt",
         "shopname": "shopY", "description": VARIANT_DESC},
    ]


def _build(tmp_path, export_docs=None) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    ep = tmp_path / "export.json"
    ep.write_text(json.dumps(export_docs or _fixture_export()),
                  encoding="utf-8")
    out = tmp_path / "description_embeddings.npz"
    build_description_npz(ep, out, generation_id="gfix-0001",
                          embed=_fake_embed, tokenizer=_FakeTok())
    return out


def _digest(path: Path) -> str:
    z = np.load(path, allow_pickle=True)
    h = hashlib.sha256()
    for k in ("item_ids", "chunk_ids", "shops", "texts"):
        h.update(np.asarray(z[k], dtype=str).tobytes())
    h.update(z["embeddings"].tobytes())
    return h.hexdigest()


# ── chunker contract ────────────────────────────────────────────────────────

def test_chunks_deterministic_and_dedup():
    c1 = build_description_chunks(DESC_C, tokenizer=_FakeTok())
    c2 = build_description_chunks(DESC_C, tokenizer=_FakeTok())
    assert c1 == c2
    assert c1 == ["p1 a b c\np2 d e\np3 f"]      # dup para removed, merged
    assert build_description_chunks("", tokenizer=_FakeTok()) == []


def test_long_para_hard_windows():
    para = " ".join(f"w{i}" for i in range(DESC_CHUNK_TOKENS * 2 + 10))
    c = build_description_chunks(para, tokenizer=_FakeTok())
    assert len(c) == 3                           # 512+512+rest, no overlap


# ── builder contract ────────────────────────────────────────────────────────

def test_two_builds_identical_digest(tmp_path):
    assert _digest(_build(tmp_path / "a")) == _digest(_build(tmp_path / "b"))


def test_rows_schema_and_mapping(tmp_path):
    z = np.load(_build(tmp_path), allow_pickle=True)
    n = z["embeddings"].shape[0]
    assert n > 0 and z["embeddings"].shape[1] == EMBEDDING_DIM
    assert np.isfinite(z["embeddings"]).all()
    assert str(z["generation_id"].item()) == "gfix-0001"
    for k in ("item_ids", "chunk_ids", "shops", "texts"):
        assert len(z[k]) == n
    iids, cids = [str(x) for x in z["item_ids"]], [str(x) for x in z["chunk_ids"]]
    assert len(set(cids)) == n                       # unique chunk_ids
    assert all(c.startswith(f"{i}:") for i, c in zip(iids, cids))
    assert set(iids) == {str(IID_A), str(IID_B), str(IID_C), "50000000003"}
    assert str(IID_D) not in iids                    # empty desc → zero rows
    assert "None" not in iids                        # malformed excluded
    a_rows = [c for i, c in zip(iids, cids) if i == str(IID_A)]
    assert a_rows == [f"{IID_A}:0"]                  # first-wins duplicate doc
    shops = dict(zip(cids, [str(s) for s in z["shops"]]))
    assert shops[f"{IID_A}:0"] == "shopX" and shops[f"{IID_B}:0"] == "shopY"
    texts = dict(zip(cids, [str(t) for t in z["texts"]]))
    assert "480Mbps" in texts[f"{IID_A}:0"]
    assert "variant M" in texts["50000000003:0"]     # listing-level text kept


def test_c_item_multiple_chunks_ordered(tmp_path):
    z = np.load(_build(tmp_path), allow_pickle=True)
    c_rows = [str(c) for c in z["chunk_ids"] if str(c).startswith(f"{IID_C}:")]
    assert c_rows == [f"{IID_C}:{i}" for i in range(len(c_rows))]


def test_nonfinite_embedding_rejected(tmp_path):
    def bad_embed(texts, batch_size=64):
        e = _fake_embed(texts, batch_size)
        if len(e):
            e[0][0] = float("nan")
        return e
    ep = tmp_path / "export.json"
    ep.write_text(json.dumps(_fixture_export()), encoding="utf-8")
    with pytest.raises(ValueError):
        build_description_npz(ep, tmp_path / "d.npz", generation_id="g",
                              embed=bad_embed, tokenizer=_FakeTok())


# ── runtime load + fetch mapping (fixture gen dir, cleaned after) ───────────

FIXTURE_GID = "gfixture-desc-offline"
GEN_DIR = Path(__file__).resolve().parent.parent.parent / \
    "exports" / "gen" / FIXTURE_GID


@pytest.fixture()
def gen_artifact(tmp_path):
    GEN_DIR.mkdir(parents=True, exist_ok=True)
    try:
        src = _build(tmp_path)
        (GEN_DIR / "description_embeddings.npz").write_bytes(
            src.read_bytes())
        # แก้ generation_id ใน npz ให้ตรง FIXTURE_GID
        z = np.load(GEN_DIR / "description_embeddings.npz", allow_pickle=True)
        np.savez(GEN_DIR / "description_embeddings.npz",
                 **{k: z[k] for k in z.files if k != "generation_id"},
                 generation_id=np.array(FIXTURE_GID))
        yield GEN_DIR / "description_embeddings.npz"
    finally:
        (GEN_DIR / "description_embeddings.npz").unlink(missing_ok=True)
        try:
            GEN_DIR.rmdir()
        except OSError:
            pass
        _ps._DESC_VEC_CACHE.clear()


class _Snap:
    generation_id = FIXTURE_GID


def test_runtime_loads_artifact(gen_artifact):
    _ps._DESC_VEC_CACHE.clear()
    dv = _ps._desc_vectors(_Snap())
    assert dv is not None
    assert str(IID_A) in [str(i) for i in dv["item_ids"]]


def test_fetch_maps_winning_chunk_to_product(gen_artifact, monkeypatch):
    _ps._DESC_VEC_CACHE.clear()
    monkeypatch.setattr(_ps, "_desc_item_docs",
                        lambda ids: {i: _doc(i) for i in ids})
    dv = _ps._desc_vectors(_Snap())
    qv = np.asarray(dv["emb"])[
        [str(i) for i in dv["item_ids"]].index(str(IID_A))].astype(np.float32)
    from chatbot.shopeechat import embedding as _em
    monkeypatch.setattr(_em, "embed_query", lambda *a, **k: qv)
    res = _ps.fetch_description_evidence(
        "480Mbps", retrieval_profile=None, snap=_Snap())
    hits = {str(c["item_id"]): c["_desc_hit"] for c in res.cards}
    assert str(IID_A) in hits                          # chunk → correct item
    assert hits[str(IID_A)]["chunk_id"] == f"{IID_A}:0"
    assert hits[str(IID_A)]["item_id"] == str(IID_A)


def test_anchor_isolation_on_fixture(gen_artifact, monkeypatch):
    _ps._DESC_VEC_CACHE.clear()
    monkeypatch.setattr(_ps, "_desc_item_docs",
                        lambda ids: {i: _doc(i) for i in ids})
    from chatbot.shopeechat import embedding as _em
    monkeypatch.setattr(_em, "embed_query",
                        lambda *a, **k: np.zeros(EMBEDDING_DIM, np.float32))
    prof = _profile(anchor_item_ids=(str(IID_B),))
    res = _ps.fetch_description_evidence(
        "480Mbps", retrieval_profile=prof, snap=_Snap())
    assert [str(c["item_id"]) for c in res.cards] == [str(IID_B)]


def test_old_generation_no_artifact_is_noop():
    class _Old:
        generation_id = "g20261024-072533-2be3443e"   # active gen — no desc npz
    _ps._DESC_VEC_CACHE.clear()
    assert _ps._desc_vectors(_Old()) is None


def test_corrupt_generation_id_fails_closed(gen_artifact):
    p = gen_artifact
    z = np.load(p, allow_pickle=True)
    np.savez(p, **{k: z[k] for k in z.files if k != "generation_id"},
             generation_id=np.array("gWRONG"))
    _ps._DESC_VEC_CACHE.clear()
    assert _ps._desc_vectors(_Snap()) is None


# ── publish gate ────────────────────────────────────────────────────────────

class _Coll:
    def __init__(self, n): self.n = n
    def count_documents(self, q): return self.n
    def find_one(self, q): return None


class _DB:
    def __init__(self, counts): self.counts = counts
    def __getitem__(self, name): return _Coll(self.counts.get(name, 0))


def _gen_dir_for_publish(tmp_path, gid, with_desc=True):
    g = tmp_path / "gen" / gid          # publish() ต้องการ exports_root/gen/gid
    g.mkdir(parents=True)
    (g / "sellable_units.jsonl").write_text("{}\n{}\n", encoding="utf-8")
    (g / "image_texts.jsonl").write_text("{}\n", encoding="utf-8")
    (g / "ShpProducts.export.json").write_text("[]", encoding="utf-8")
    def _npz(name, rows, ggid=gid):
        np.savez(g / name,
                 embeddings=np.ones((rows, EMBEDDING_DIM), np.float32),
                 generation_id=np.array(ggid))
    _npz("unit_embeddings.npz", 2)
    _npz("product_embeddings.npz", 2)
    if with_desc:
        src = _build(tmp_path / f"b-{gid}")
        z = np.load(src, allow_pickle=True)
        np.savez(g / "description_embeddings.npz",
                 **{k: z[k] for k in z.files if k != "generation_id"},
                 generation_id=np.array(gid))
    (g / "image_texts.counts.json").write_text(json.dumps({
        "generation_id": gid,
        "completed_scopes": ["sellable", "nonsellable"],
        "scopes": {"sellable": {k: 1 if k == "discovered" else 0
                                for k in ("discovered", "reusable", "carried",
                                          "new", "changed", "deferred",
                                          "malformed", "duplicate")},
                   "nonsellable": {k: 0 for k in ("discovered", "reusable",
                                                  "carried", "new", "changed",
                                                  "deferred", "malformed",
                                                  "duplicate")}},
        "unique_discovered": 1, "published_evidence": 1}), encoding="utf-8")
    return g


def test_publish_accepts_gen_without_desc_artifact(tmp_path):
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-aaaa1111"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=False)
    db = _DB({f"sellable_units_{gid}": 2, f"image_texts_{gid}": 1})
    stats = _pg.validate_generation(g, db, gid)
    assert stats["desc_rows"] == 0
    assert "description_embeddings.npz" not in stats["sha256"]


def test_publish_validates_desc_artifact_schema(tmp_path):
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-bbbb2222"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=True)
    db = _DB({f"sellable_units_{gid}": 2, f"image_texts_{gid}": 1})
    stats = _pg.validate_generation(g, db, gid)
    assert stats["desc_rows"] > 0
    assert "description_embeddings.npz" in stats["sha256"]


def test_publish_rejects_desc_gid_mismatch(tmp_path):
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-cccc3333"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=True)
    z = np.load(g / "description_embeddings.npz", allow_pickle=True)
    np.savez(g / "description_embeddings.npz",
             **{k: z[k] for k in z.files if k != "generation_id"},
             generation_id=np.array("gWRONG"))
    db = _DB({f"sellable_units_{gid}": 2, f"image_texts_{gid}": 1})
    with pytest.raises(ValueError, match="generation_id"):
        _pg.validate_generation(g, db, gid)


# ── required-description publication gate (Phase 10B — explicit operator
#    precondition; review: missing artifact was fail-open) ───────────────────

def _db_for(gid):
    return _DB({f"sellable_units_{gid}": 2, f"image_texts_{gid}": 1})


def _mutate_desc(g, fn):
    p = g / "description_embeddings.npz"
    z = np.load(p, allow_pickle=True)
    d = {k: z[k] for k in z.files}
    d.update(fn(z))
    np.savez(p, **d)


def test_required_missing_artifact_rejected(tmp_path):
    """RED: fail-open — new gen ที่ต้องการ desc แต่ artifact ไม่มี ต้อง reject"""
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-reqmiss1"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=False)
    with pytest.raises(ValueError, match="description"):
        _pg.validate_generation(g, _db_for(gid), gid,
                                require_description=True)


def test_required_zero_rows_rejected(tmp_path):
    """RED: artifact ว่าง (0 rows) = ไม่มี description source — ต้อง reject"""
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-reqzero1"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=False)
    np.savez(g / "description_embeddings.npz",
             item_ids=np.array([], dtype="<U24"),
             chunk_ids=np.array([], dtype="<U40"),
             shops=np.array([], dtype="<U64"),
             texts=np.array([], dtype=object),
             embeddings=np.zeros((0, EMBEDDING_DIM), np.float32),
             generation_id=np.array(gid))
    with pytest.raises(ValueError, match="description"):
        _pg.validate_generation(g, _db_for(gid), gid,
                                require_description=True)


def test_required_valid_artifact_passes(tmp_path):
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-reqpass1"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=True)
    stats = _pg.validate_generation(g, _db_for(gid), gid,
                                  require_description=True)
    assert stats["desc_rows"] > 0


@pytest.mark.parametrize("mutate,match", [
    (lambda z: {"generation_id": np.array("gWRONG")}, "generation_id"),
    (lambda z: {"embeddings": np.ones(
        (z["embeddings"].shape[0], 8), np.float32)}, "dim"),
    (lambda z: {"embeddings": np.concatenate(
        ([[np.nan] * z["embeddings"].shape[1]],
          z["embeddings"][1:])).astype(np.float32)}, "non-finite"),
    (lambda z: {"texts": z["texts"][:1]}, "rows"),
    (lambda z: {"chunk_ids": np.where(
        np.arange(len(z["chunk_ids"])) == 1, z["chunk_ids"][0],
        z["chunk_ids"])}, "duplicate"),
    (lambda z: {"item_ids": np.where(
        np.arange(len(z["item_ids"])) == 0, "99999",
        z["item_ids"])}, "item_id"),
])
def test_required_schema_rejects(tmp_path, mutate, match):
    """schema gate ครบทุก branch เมื่อ artifact ถูก require"""
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-reqmut01"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=True)
    _mutate_desc(g, mutate)
    with pytest.raises(ValueError, match=match):
        _pg.validate_generation(g, _db_for(gid), gid,
                                require_description=True)


def test_not_required_still_validates_present_artifact(tmp_path):
    """require=False + artifact เสีย → ยัง reject (gate เดิมไม่หลุด)"""
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-notreq01"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=True)
    _mutate_desc(g, lambda z: {"generation_id": np.array("gWRONG")})
    with pytest.raises(ValueError):
        _pg.validate_generation(g, _db_for(gid), gid,
                                require_description=False)


def test_failed_required_validation_never_reaches_cas(tmp_path, monkeypatch):
    """pointer safety — reject ก่อน manifest/CAS เสมอ"""
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-eeee5555"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=False)
    calls = {"cas": 0, "manifest": 0}
    monkeypatch.setattr(_pg, "cas_publish",
                        lambda *a, **k: calls.__setitem__("cas", 1) or "x")
    monkeypatch.setattr(_pg, "finalize_manifest",
                        lambda *a, **k: calls.__setitem__("manifest", 1))
    with pytest.raises(ValueError, match="description"):
        _pg.publish(_db_for(gid), g, gid, require_description=True,
                    exports_root=tmp_path)
    assert calls == {"cas": 0, "manifest": 0}
    assert not (g / "manifest.json").exists()


def test_required_publish_writes_manifest_desc_fields(tmp_path, monkeypatch):
    """manifest ต้องมี counts.description_chunks + sha256 ของ artifact"""
    from chatbot.shopeechat.scripts import publish_generation as _pg
    gid = "g20269999-000000-dddd4444"
    g = _gen_dir_for_publish(tmp_path, gid, with_desc=True)
    monkeypatch.setattr(_pg, "cas_publish", lambda *a, **k: "published")
    monkeypatch.setattr(_pg, "_read_pointer", lambda db: None)
    monkeypatch.setattr(_pg, "cleanup_generations", lambda *a, **k: [])
    res = _pg.publish(_db_for(gid), g, gid, require_description=True,
                      exports_root=tmp_path)
    assert res == "published"
    m = json.loads((g / "manifest.json").read_text(encoding="utf-8"))
    assert m["counts"]["description_chunks"] > 0
    assert "description_embeddings.npz" in m["sha256"]


def test_refresh_script_desc_step_is_blocking():
    """refresh contract: desc build fail → abort; publish ถูกเรียกด้วย
    --require-description เท่านั้น (source contract ของ shell script —
    behavioral gates ทดสอบที่ publish() แล้ว)"""
    src = Path(__file__).resolve().parent.parent.parent / \
        "chatbot/shopeechat/scripts/refresh_data.sh"
    lines = src.read_text(encoding="utf-8").splitlines()
    di = next(i for i, l in enumerate(lines) if "description npz" in l)
    pi = next(i for i, l in enumerate(lines)
              if "publish_generation.py" in l)
    desc_block = "\n".join(lines[di:pi])
    assert "|| warn" not in desc_block          # fail-open removed
    assert "if ! run" in desc_block             # blocking
    assert "ABORT" in desc_block and "exit 1" in desc_block
    assert "--require-description" in "\n".join(lines[pi:pi + 4])
    assert di < pi                              # desc build ก่อน publish เสมอ


# ── helpers ─────────────────────────────────────────────────────────────────

def _doc(iid):
    return {"item_id": int(iid), "item_name": "n", "item_status": "NORMAL",
            "cat_name": "cable", "shopname": "shopX", "description": "d",
            "tier_variation": [], "brand": {},
            "model": [{"model_id": "m", "model_name": "n",
                       "model_status": "MODEL_NORMAL",
                       "stock_info_v2": {"summary_info": {
                           "total_available_stock": 3}},
                       "price_info": [{"current_price": 1}]}]}


def _profile(**kw):
    from chatbot.shopeechat.route_context import RetrievalProfile
    base = dict(platform="shopee", shop=None, message="q", intent="",
                product_types=frozenset(), subtype=None, model_codes=(),
                variant_terms=(), target_device=None,
                availability_mode="", compat_mode="")
    base.update(kw)
    return RetrievalProfile(**base)

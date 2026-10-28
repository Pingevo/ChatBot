"""Phase 10B D2 — bounded resumable A/B benchmark: description vector design.

A: one vector per item_id  (item_name + description, deterministic bound)
B: multiple chunks per item_id (paragraph-merge <=TOKEN_BUDGET, source order)

Corpus = real export — gold-first (capped per query) + seeded shop/category
distractors, total <= 1,000 items.  Gold = regex oracle over description text
(test oracle only — never production).  B rows <= 3,000 hard stop.

Resumable: gitignored cache keyed by (corpus hash, model, device, dim,
chunk settings) — batch sizes deliberately excluded so batch tuning never
invalidates manifests.  corpus.json/a_rows.json/b_rows.json/queries.json are
self-contained: a matching resume skips export parse, gold scan and chunking.
Atomic .tmp -> os.replace; embedding checkpoint after EVERY batch;
20-min wall-clock deadline checked inside every loop; no CPU fallback.

Run:  EMBEDDING_DEVICE=mps IMGTXT_SKIP_HUB=1 python -u <this> [--probe]
(no tail/grep pipe — it would hide progress lines)
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import resource
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

EXPORT = ROOT / "exports/gen/g20261024-072533-2be3443e/ShpProducts.export.json"
OUT_DIR = ROOT / "docs/test/results"
CACHE = OUT_DIR / ".phase10b_desc_bench_cache"

# ── bounds ───────────────────────────────────────────────────────────────────
CORPUS_MAX = 1000
GOLD_CAP = 20                 # per-query in-corpus gold cap (deterministic)
B_ROW_MAX = 3_000
TOKEN_BUDGET = 512            # merged-paragraph chunk budget (tokens)
A_TEXT_CAP = 8000
TOPK = 5
A_BATCH = 8                   # long texts — small batches keep MPS responsive
B_BATCH = 32                  # chunks <=512 tokens
Q_BATCH = 32
BATCH_TIMEOUT_S = 60          # stop if a single encode batch exceeds this
WALL_BUDGET_S = 20 * 60
RSS_CAP_GB = 4.5
SEED = 7
PROBE_A_ROWS = 16
PROBE_B_ROWS = 64
MODEL_ID = "BAAI/bge-m3"
DEVICE = os.environ.get("EMBEDDING_DEVICE", "mps")

# (query, regex oracle patterns, must_pass, note)
# "neg shoes" was gold=40 on full export -> oracle defect; kept as
# non-must adversarial, excluded from negative metric (negative requires
# full-export gold == 0 — computed dynamically, not by flag).
QUERIES = [
    ("สายชาร์จ CMC615P ถ่ายโอนข้อมูล speed เท่าไหร่",
     [r"cmc615p", r"\d+\s*mbps|\d+\s*gbps"], True, "A2-anchored CMC615P"),
    ("มีสายแม่เหล็กที่ส่งข้อมูล 10Gbps ขึ้นไปไหม",
     [r"แม่เหล็ก|magnetic", r"(?:[1-4]\d)\s*gbps"], True, "A3 magnetic+10Gbps"),
    ("สายแม่เหล็ก 240W ส่งข้อมูลได้ไหม",
     [r"แม่เหล็ก|magnetic", r"240\s*w"], True, "magnetic 240W cable"),
    ("สายชาร์จถ่ายโอนข้อมูล 480Mbps", [r"480\s*mbps"], True, "480Mbps"),
    ("สาย usb4 40Gbps", [r"usb\s*4|40\s*gbps"], True, "USB4/40Gbps"),
    ("สายชาร์จ thunderbolt 40gbps", [r"thunderbolt"], True, "thunderbolt"),
    ("สาย 20Gbps ส่งไฟล์เร็ว", [r"20\s*gbps"], True, "20Gbps"),
    ("นาฬิกาเชื่อมต่อ Strava ได้ไหม", [r"strava"], True, "strava"),
    ("smartwatch มี GPS ในตัว", [r"\bgps\b"], True, "gps"),
    ("นาฬิกามี NFC จ่ายเงินได้", [r"\bnfc\b"], True, "nfc"),
    ("นาฬิกาวัด ECG คลื่นหัวใจ", [r"\becg\b"], True, "ecg"),
    ("นาฬิกาวัดออกซิเจนในเลือด SpO2", [r"spo2"], True, "spo2"),
    ("สมาร์ทวอทช์จอ AMOLED", [r"amoled"], True, "amoled"),
    ("นาฬิกากันน้ำ IP68", [r"ip\s*68"], True, "ip68"),
    ("นาฬิการองรับ bluetooth 5", [r"bluetooth\s*5"], True, "bt5"),
    ("กล้องมีไซเรนดังเตือนขโมย", [r"ไซเรน|siren"], True, "siren"),
    ("กล้องตรวจจับมนุษย์ human detection", [r"human|มนุษย์"], True, "human"),
    ("หัวชาร์จ GaN", [r"\bgan\b|แกลเลียม|nitride"], True, "gan"),
    ("หัวชาร์จ 140W ชาร์จโน้ตบุ๊ก", [r"140\s*w"], True, "140W"),
    ("หัวชาร์จรองรับ PD 3.1", [r"pd\s*3\.?1"], True, "pd31"),
    ("หัวชาร์จ QC4", [r"qc\s*4"], True, "qc4"),
    ("สายชาร์จ MFi รับรอง apple", [r"\bmfi\b"], True, "mfi"),
    ("พาวเวอร์แบงค์ 20000mAh", [r"20,?000\s*mah"], True, "20k mah"),
    ("แผงโซล่าร์ชาร์จกล้อง", [r"solar|โซล่า"], True, "solar"),
    ("powerbank wireless charge", [r"wireless|ไร้สาย"], True, "wireless"),
    ("CUKTECH CMC615P", [r"cmc615p"], True, "model name"),
    ("IMILAB W01", [r"\bw01\b"], True, "model W01"),
    ("IMILAB EC4", [r"\bec4\b"], True, "model EC4"),
    # negatives — only count when full-export gold == 0
    ("รองเท้าวิ่งกันน้ำ", [r"รองเท้าวิ่ง"], False, "neg shoes (adversarial)"),
    ("เคสไอโฟนหนังแท้", [r"เคสไอโฟนหนัง"], False, "neg case"),
    ("กาแฟคั่วอราบิก้า", [r"กาแฟคั่ว"], False, "neg coffee"),
    ("สายชาร์จชุดใหญ่หลายหัว", [r"หลายหัว|3\s*in\s*1|3in1"], True, "multi-head"),
    ("นาฬิการุ่นใหญ่หน้าจอใหญ่", [r"หน้าจอ.{0,15}(ใหญ่|นิ้ว)|amoled"],
     True, "big display"),
]

_T0 = time.time()


def _log(msg: str):
    print(f"[{time.time()-_T0:7.1f}s][{_rss_gb():5.2f}GB] {msg}", flush=True)


def _rss_gb() -> float:
    # ru_maxrss = bytes on macOS
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 ** 3


def _deadline() -> bool:
    return time.time() - _T0 > WALL_BUDGET_S


def _atomic_write(path: Path, data: bytes):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _save_json(path: Path, obj):
    _atomic_write(path, json.dumps(obj, ensure_ascii=False).encode())


def _load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _save_npz(path: Path, v: np.ndarray):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as f:
        np.savez(f, v=v)
    os.replace(tmp, path)


def _load_npz(path: Path) -> np.ndarray | None:
    if not path.exists():
        return None
    try:
        return np.load(path)["v"]
    except Exception:
        return None


def _cache_key(corpus_hash: str, dim: int) -> str:
    # batch sizes intentionally excluded — batch tuning must not invalidate
    return hashlib.sha256(json.dumps({
        "corpus": corpus_hash, "model": MODEL_ID, "device": DEVICE,
        "dim": dim, "token_budget": TOKEN_BUDGET,
        "a_cap": A_TEXT_CAP, "topk": TOPK}, sort_keys=True).encode()
    ).hexdigest()[:16]


def _save_meta(stage: str, key: str, extra: dict | None = None):
    meta = {"key": key, "stage": stage, "ts": time.time(), **(extra or {})}
    _save_json(CACHE / "meta.json", meta)


def _load_meta() -> dict:
    return _load_json(CACHE / "meta.json") or {}


def _load_model():
    _log(f"model: loading {MODEL_ID} device={DEVICE} (no CPU fallback)")
    t = time.time()
    from shopeechat import embedding as emb
    model = emb._get_model()
    _log(f"model: loaded in {time.time()-t:.1f}s max_seq={model.max_seq_length}")
    return emb, model


def _probe():
    """Bounded MPS probe: worst-case A batches + representative B batches."""
    _log(f"PROBE start device={DEVICE}")
    docs = json.load(open(EXPORT))
    descs = sorted(((d.get("description") or "").strip() for d in docs),
                   key=len, reverse=True)
    a_texts = descs[:PROBE_A_ROWS]
    b_texts = [d[:TOKEN_BUDGET * 4] for d in
               descs[len(descs) // 2: len(descs) // 2 + PROBE_B_ROWS]]
    emb, model = _load_model()
    t_a = t_b = 0.0
    for bi in range(2):
        lo, hi = bi * A_BATCH, min((bi + 1) * A_BATCH, PROBE_A_ROWS)
        t = time.time()
        v = emb.embed_texts(a_texts[lo:hi], batch_size=A_BATCH)
        dt = time.time() - t
        t_a += dt
        _log(f"PROBE A batch {bi+1}/2 rows {lo}-{hi} in {dt:.2f}s")
        if dt > BATCH_TIMEOUT_S:
            _log("PROBE FAILED — A batch > 60s")
            sys.exit(4)
        if not np.isfinite(v).all():
            _log("PROBE FAILED — non-finite A vectors")
            sys.exit(4)
    for bi in range(2):
        lo, hi = bi * B_BATCH, min((bi + 1) * B_BATCH, PROBE_B_ROWS)
        t = time.time()
        v = emb.embed_texts(b_texts[lo:hi], batch_size=B_BATCH)
        dt = time.time() - t
        t_b += dt
        _log(f"PROBE B batch {bi+1}/2 rows {lo}-{hi} in {dt:.2f}s")
        if dt > BATCH_TIMEOUT_S or not np.isfinite(v).all():
            _log("PROBE FAILED — B batch slow or non-finite")
            sys.exit(4)
    per_a = t_a / 2
    per_b = t_b / 2
    est = (-(-1000 // A_BATCH)) * per_a + (-(-2400 // B_BATCH)) * per_b + 60
    _log(f"PROBE per-batch A={per_a:.2f}s B={per_b:.2f}s "
         f"est_full={est:.0f}s rss={_rss_gb():.2f}GB")
    if est > WALL_BUDGET_S:
        _log("PHASE_10B_DESCRIPTION_BENCHMARK_ESTIMATE_EXCEEDS_BUDGET")
        sys.exit(5)
    _log("PROBE OK — exiting")


def main():
    _log(f"START pid={os.getpid()} device={DEVICE} budget={WALL_BUDGET_S}s "
         f"corpus<={CORPUS_MAX} B<={B_ROW_MAX} "
         f"Ab={A_BATCH} Bb={B_BATCH} Qb={Q_BATCH}")
    CACHE.mkdir(parents=True, exist_ok=True)

    # ── resume fast path: self-contained cache, no export parse ──
    corpus_cache = _load_json(CACHE / "corpus.json")
    cached_ids = (corpus_cache or {}).get("ids") or []
    corpus_hash = hashlib.sha256(
        "|".join(cached_ids).encode()).hexdigest()[:16] if cached_ids else ""

    emb, model = _load_model()
    tok = model.tokenizer
    dim = int(model.get_embedding_dimension()
              if hasattr(model, "get_embedding_dimension")
              else model.get_sentence_embedding_dimension())
    key = _cache_key(corpus_hash, dim) if corpus_hash else ""
    meta = _load_meta()
    resumable = bool(corpus_hash) and meta.get("key") == key \
        and all((CACHE / n).exists() for n in
                ("a_rows.json", "b_rows.json", "queries.json"))
    _log(f"cache: key={key or 'n/a'} resumable={resumable}")

    if resumable:
        corpus = corpus_cache["items"]
        a_rows = _load_json(CACHE / "a_rows.json")
        b_rows = _load_json(CACHE / "b_rows.json")
        qrows = _load_json(CACHE / "queries.json")
        for q in qrows:
            q["gold"] = set(q["gold"])
            q["gold_in_corpus"] = set(q["gold_in_corpus"])
        stage = meta.get("stage", "none")
        _log(f"cache: resume — corpus {len(corpus)} A {len(a_rows)} "
             f"B {len(b_rows)} stage={stage} (preprocessing skipped)")
    else:
        stage = "none"
        # ── corpus build (deterministic) ──
        docs = json.load(open(EXPORT))
        items = {}
        for i, d in enumerate(docs):
            if i % 100 == 0:
                _log(f"corpus: parsed {i}/{len(docs)}")
            if _deadline():
                _log("corpus: deadline in parse loop — stop")
                sys.exit(2)
            desc = (d.get("description") or "").strip()
            if not desc:
                continue
            iid = str(int(d["item_id"]) if isinstance(d.get("item_id"), float)
                      else d.get("item_id"))
            items[iid] = {"item_id": iid, "shop": d.get("shopname") or "",
                          "cat": d.get("cat_name") or "",
                          "name": d.get("item_name") or "", "desc": desc}
        _log(f"corpus: export items with description = {len(items)}")

        qrows, corpus_ids = [], set()
        rng = random.Random(SEED)
        for q, pats, must, note in QUERIES:
            cres = [re.compile(p, re.I) for p in pats]
            gold = {iid for iid, it in items.items()
                    if all(p.search(it["desc"]) for p in cres)}
            inc = set(gold)
            if len(inc) > GOLD_CAP:
                inc = set(rng.sample(sorted(inc), GOLD_CAP))
            corpus_ids |= inc
            qrows.append({"q": q, "gold": gold, "must": must, "note": note,
                          "gold_in_corpus": inc})
            _log(f"corpus: q[{note}] gold={len(gold)} in_corpus={len(inc)}")

        def gold_ids():
            s = set()
            for q in qrows:
                s |= q["gold_in_corpus"]
            return s

        if len(gold_ids()) > CORPUS_MAX:
            _log(f"corpus: gold union {len(gold_ids())} > {CORPUS_MAX} — stop")
            sys.exit(2)

        by_sc: dict[tuple, list] = {}
        for iid, it in items.items():
            if iid not in corpus_ids:
                by_sc.setdefault((it["shop"], it["cat"]), []).append(iid)
        pools = sorted(by_sc.items())
        for _, v in pools:
            rng.shuffle(v)
        i = 0
        while len(corpus_ids) < CORPUS_MAX:
            if _deadline():
                _log("corpus: deadline in distractor loop — stop")
                sys.exit(2)
            progressed = False
            for _, v in pools:
                if len(corpus_ids) >= CORPUS_MAX:
                    break
                if i < len(v):
                    corpus_ids.add(v[i])
                    progressed = True
                    if len(corpus_ids) % 100 == 0:
                        _log(f"corpus: selected {len(corpus_ids)}/{CORPUS_MAX}")
            if not progressed:
                break
            i += 1

        corpus = [items[i] for i in sorted(corpus_ids)]
        corpus_hash = hashlib.sha256(
            "|".join(r["item_id"] for r in corpus).encode()).hexdigest()[:16]
        key = _cache_key(corpus_hash, dim)
        _log(f"corpus: items={len(corpus)} gold={len(gold_ids())} "
             f"distractors={len(corpus)-len(gold_ids())} hash={corpus_hash}")
        if len(corpus) > CORPUS_MAX:
            _log("corpus: EXCEEDED CORPUS_MAX — stop")
            sys.exit(2)

        # ── rows (batch tokenizer per item; no per-paragraph encode) ──
        a_rows = [{"row_key": r["item_id"], "item_id": r["item_id"],
                   "shop": r["shop"], "platform": "shopee",
                   "source": "description",
                   "text": (r["name"] + "\n\n" + r["desc"])[:A_TEXT_CAP],
                   "src_len": len(r["name"]) + len(r["desc"])}
                  for r in corpus]
        b_rows: list[dict] = []
        for ci, r in enumerate(corpus):
            if ci % 100 == 0:
                _log(f"chunk: {ci}/{len(corpus)} B rows so far={len(b_rows)}")
            if _deadline():
                _log("chunk: deadline — stop")
                sys.exit(2)
            paras = [p.strip() for p in r["desc"].split("\n") if p.strip()]
            seen = set()
            paras = [p for p in paras if not (p in seen or seen.add(p))]
            if not paras:
                continue
            ids_list = tok(paras, add_special_tokens=True)["input_ids"]
            cur, cur_t, idx = [], 0, 0

            def _emit(text=None):
                nonlocal cur, cur_t, idx
                b_rows.append({"chunk_id": f"{r['item_id']}:{idx}",
                               "item_id": r["item_id"], "shop": r["shop"],
                               "platform": "shopee", "source": "description",
                               "source_index": idx,
                               "text": text if text is not None
                               else "\n".join(cur)})
                idx += 1
                cur, cur_t = [], 0

            for p, ids in zip(paras, ids_list):
                n = len(ids)
                if n > TOKEN_BUDGET:
                    if cur:
                        _emit()
                    for s in range(0, n, TOKEN_BUDGET):
                        _emit(tok.decode(ids[s:s + TOKEN_BUDGET]))
                    continue
                if cur and cur_t + n > TOKEN_BUDGET:
                    _emit()
                cur.append(p)
                cur_t += n
            if cur:
                _emit()
        _log(f"rows: A={len(a_rows)} B={len(b_rows)}")
        if len(b_rows) > B_ROW_MAX:
            _log(f"rows: B {len(b_rows)} > {B_ROW_MAX} — stop, no silent "
                 f"truncation")
            _save_meta("stopped-b-rows", key, {"b_rows": len(b_rows)})
            sys.exit(2)

        # ── pre-embed checkpoints: self-contained manifests ──
        _save_json(CACHE / "corpus.json", {
            "hash": corpus_hash, "ids": [r["item_id"] for r in corpus],
            "items": corpus})
        _save_json(CACHE / "a_rows.json", a_rows)
        _save_json(CACHE / "b_rows.json", b_rows)
        _save_json(CACHE / "queries.json", [
            {**q, "gold": sorted(q["gold"]),
             "gold_in_corpus": sorted(q["gold_in_corpus"])} for q in qrows])
        _save_json(CACHE / "a_rows.manifest.json", [
            {"row_key": r["row_key"], "item_id": r["item_id"],
             "text_len": len(r["text"])} for r in a_rows])
        _save_json(CACHE / "b_rows.manifest.json", [
            {"row_key": r["chunk_id"], "item_id": r["item_id"],
             "source_index": r["source_index"], "text_len": len(r["text"])}
            for r in b_rows])
        _save_meta("manifests", key)
        _log("cache: manifests + rows written")

    # ── fairness checks (both paths, before embed) ──
    a_ids = [r["item_id"] for r in a_rows]
    b_ids = [r["item_id"] for r in b_rows]
    assert set(a_ids) == {c["item_id"] for c in corpus}, "A ids != corpus"
    assert set(b_ids) <= set(a_ids), "B ids outside corpus"
    assert len(a_rows) == len(set(a_ids)), "A not 1 row/item"
    a_chars = sum(len(r["text"]) for r in a_rows)
    a_trunc = sum(1 for r in a_rows if r.get("src_len", 0) > A_TEXT_CAP)
    b_chars = sum(len(r["text"]) for r in b_rows)
    import collections
    ch = collections.Counter(b_ids)
    a_tok = sum(len(x) for x in
                tok([r["text"] for r in a_rows], add_special_tokens=True)
                ["input_ids"])
    b_tok = sum(len(x) for x in
                tok([r["text"] for r in b_rows], add_special_tokens=True)
                ["input_ids"])
    src_chars = sum(len(c["desc"]) for c in corpus)
    _log(f"fairness: A chars={a_chars} tok={a_tok} truncated_items={a_trunc} | "
         f"B chars={b_chars} tok={b_tok} coverage={b_chars/src_chars:.2%} "
         f"chunks/item avg={len(b_rows)/len(ch):.2f} max={max(ch.values())}")

    # ── embed with per-batch checkpoint ──
    def _stage_rank(s):
        return {"none": 0, "manifests": 0, "a": 1, "b": 2, "q": 3,
                "done": 4}.get(s, 0)

    def _embed(tag, texts, name, bs, my_stage):
        full, part = CACHE / name, CACHE / (name + ".part")
        v_full = _load_npz(full)
        if (v_full is not None and v_full.shape == (len(texts), dim)
                and _stage_rank(stage) >= my_stage):
            _log(f"cache: {tag} reuse {v_full.shape} — no re-encode")
            return v_full
        v = np.zeros((len(texts), dim), np.float32)
        start = 0
        pv = _load_npz(part)
        if pv is not None and pv.shape[1] == dim \
                and pv.shape[0] <= len(texts):
            start = int(pv.shape[0])
            v[:start] = pv
            _log(f"cache: {tag} resume partial at row {start}/{len(texts)}")
        nb = -(-len(texts) // bs)
        for bi in range(start // bs, nb):
            if _deadline():
                _save_npz(part, v[: bi * bs])
                _save_meta(f"partial-{name}", key, {"rows_done": bi * bs})
                _log(f"deadline: checkpointed {tag} {bi*bs}/{len(texts)}")
                sys.exit(2)
            lo, hi = bi * bs, min((bi + 1) * bs, len(texts))
            t = time.time()
            v[lo:hi] = emb.embed_texts(texts[lo:hi], batch_size=bs)
            dt = time.time() - t
            _save_npz(part, v[:hi])
            _save_meta(f"partial-{name}", key, {"rows_done": hi})
            _log(f"{tag} batch {bi+1}/{nb} rows {hi}/{len(texts)} "
                 f"+{dt:.1f}s elapsed={time.time()-_T0:.0f}s "
                 f"rss={_rss_gb():.2f}GB")
            if dt > BATCH_TIMEOUT_S:
                _log(f"{tag}: batch took {dt:.1f}s > {BATCH_TIMEOUT_S}s — stop")
                sys.exit(2)
            if _rss_gb() > RSS_CAP_GB:
                _log(f"{tag}: rss {_rss_gb():.2f}GB > {RSS_CAP_GB}GB — stop")
                sys.exit(2)
            if not np.isfinite(v[lo:hi]).all():
                _log(f"{tag}: non-finite vectors — stop")
                sys.exit(4)
        _save_npz(full, v)
        part.unlink(missing_ok=True)
        _save_meta({1: "a", 2: "b", 3: "q"}[my_stage], key)
        _log(f"embed: {tag} done {v.shape} saved")
        return v

    a_vec = _embed("A", [r["text"] for r in a_rows], "a_embed.npz", A_BATCH, 1)
    b_vec = _embed("B", [r["text"] for r in b_rows], "b_embed.npz", B_BATCH, 2)
    q_vec = _embed("Q", [q["q"] for q in qrows], "q_embed.npz", Q_BATCH, 3)

    # ── scoring (item-level; B aggregates by max score per item) ──
    _log("score: scoring")
    results, lat_ms = [], []
    for q, vec in zip(qrows, q_vec):
        t = time.time()
        sa = a_vec @ vec
        top_a = [(a_ids[i], float(sa[i]))
                 for i in np.argsort(-sa)[:TOPK]]
        sb = b_vec @ vec
        best: dict[str, float] = {}
        for s, iid in zip(sb, b_ids):
            if s > best.get(iid, -1):
                best[iid] = float(s)
        top_b = sorted(best.items(), key=lambda kv: -kv[1])[:TOPK]
        lat_ms.append(round((time.time() - t) * 1000, 1))
        gold = q["gold"]
        neg = (not q["must"]) and len(gold) == 0
        results.append({
            "q": q["q"], "note": q["note"], "must_pass": q["must"],
            "negative": neg,
            "gold_n": len(gold), "gold_in_corpus": len(q["gold_in_corpus"]),
            "a_top": top_a, "b_top": top_b,
            "a_r1": bool(gold and top_a[0][0] in gold),
            "a_r5": bool(gold and any(i in gold for i, _ in top_a)),
            "b_r1": bool(gold and top_b[0][0] in gold),
            "b_r5": bool(gold and any(i in gold for i, _ in top_b)),
            "a_hit5": len(gold & {i for i, _ in top_a}),
            "b_hit5": len(gold & {i for i, _ in top_b}),
            "a_cross": bool(gold and top_a[0][0] not in gold),
            "b_cross": bool(gold and top_b[0][0] not in gold),
            "a_neg_fp": bool(neg and top_a and top_a[0][1] >= 0.5),
            "b_neg_fp": bool(neg and top_b and top_b[0][1] >= 0.5),
        })
    _save_meta("done", key)
    _log("score: done")

    def _agg(k, filt=None):
        v = [r[k] for r in results if filt is None or filt(r)]
        return round(sum(v) / len(v), 4) if v else 0.0

    negs = [r for r in results if r["negative"]]
    mp = [{"note": r["note"], "q": r["q"],
           "a_top3": [i for i, _ in r["a_top"][:3]],
           "b_top3": [i for i, _ in r["b_top"][:3]]}
          for r in results if r["must_pass"] and not (r["a_r5"] and r["b_r5"])]
    fail_a = [r["note"] for r in results if r["must_pass"] and not r["a_r5"]]
    fail_b = [r["note"] for r in results if r["must_pass"] and not r["b_r5"]]
    summary = {
        "corpus_items": len(corpus), "corpus_hash": corpus_hash,
        "gold_in_corpus": len({i for q in qrows
                               for i in q["gold_in_corpus"]}),
        "distractors": len(corpus) - len({i for q in qrows
                                          for i in q["gold_in_corpus"]}),
        "a_rows": len(a_rows), "b_rows": len(b_rows),
        "a_bytes": len(a_rows) * dim * 4, "b_bytes": len(b_rows) * dim * 4,
        "a_indexed_chars": a_chars, "a_indexed_tokens": a_tok,
        "a_truncated_items": a_trunc,
        "b_indexed_chars": b_chars, "b_indexed_tokens": b_tok,
        "b_coverage": round(b_chars / src_chars, 4),
        "b_chunks_per_item_avg": round(len(b_rows) / len(ch), 2),
        "b_chunks_per_item_max": max(ch.values()),
        "a_r1": _agg("a_r1"), "b_r1": _agg("b_r1"),
        "a_r5": _agg("a_r5"), "b_r5": _agg("b_r5"),
        "a_r5_must": _agg("a_r5", lambda r: r["must_pass"]),
        "b_r5_must": _agg("b_r5", lambda r: r["must_pass"]),
        "a_hit5": _agg("a_hit5"), "b_hit5": _agg("b_hit5"),
        "a_cross_item": _agg("a_cross"), "b_cross_item": _agg("b_cross"),
        "neg_n": len(negs),
        "a_neg_fp": _agg("a_neg_fp", lambda r: r["negative"]),
        "b_neg_fp": _agg("b_neg_fp", lambda r: r["negative"]),
        "variant_ambiguity": sum(1 for r in results
                                 if r["gold_in_corpus"] > 1),
        "query_latency_ms_mean": round(sum(lat_ms) / len(lat_ms), 1),
        "elapsed_s": round(time.time() - _T0, 1),
        "peak_rss_gb": round(_rss_gb(), 2),
        "device": DEVICE, "cache_key": key,
        "oracle_note": "neg shoes excluded from negatives: gold=40>0",
        "failed_must_pass": mp,
        "failed_a": fail_a, "failed_b": fail_b}
    ts = time.strftime("%Y%m%d-%H%M%S")
    jp = OUT_DIR / f"phase10b_description_ab_{ts}.json"
    jp.write_text(json.dumps({"summary": summary, "queries": [
        {**r, "gold": sorted(q["gold"])[:60],
         "gold_in_corpus": sorted(q["gold_in_corpus"])}
        for q, r in zip(qrows, results)]},
        ensure_ascii=False, indent=1))
    mdp = OUT_DIR / f"phase10b_description_ab_{ts}.md"
    mdp.write_text(_md(summary, results))
    print(json.dumps(summary, ensure_ascii=False, indent=1), flush=True)
    print("artifacts:", jp, mdp, sep="\n", flush=True)


def _md(s, results):
    L = ["# Phase 10B description A/B benchmark (bounded)", "",
         f"- device {s['device']} · corpus {s['corpus_items']} "
         f"(gold {s['gold_in_corpus']} + distractors {s['distractors']}) "
         f"hash `{s['corpus_hash']}`",
         f"- A rows={s['a_rows']} (~{s['a_bytes']//1_000_000}MB, "
         f"{s['a_indexed_tokens']} tok, trunc={s['a_truncated_items']}) · "
         f"B rows={s['b_rows']} (~{s['b_bytes']//1_000_000}MB, "
         f"{s['b_indexed_tokens']} tok, cov={s['b_coverage']:.1%}, "
         f"chunks/item {s['b_chunks_per_item_avg']}–"
         f"{s['b_chunks_per_item_max']})",
         f"- R@1: A={s['a_r1']} B={s['b_r1']} · R@5: A={s['a_r5']} "
         f"B={s['b_r5']} · must-pass R@5: A={s['a_r5_must']} "
         f"B={s['b_r5_must']}",
         f"- cross-item@1: A={s['a_cross_item']} B={s['b_cross_item']} · "
         f"neg FP (n={s['neg_n']}): A={s['a_neg_fp']} B={s['b_neg_fp']} · "
         f"multi-gold queries: {s['variant_ambiguity']}",
         f"- query latency mean {s['query_latency_ms_mean']}ms · "
         f"elapsed {s['elapsed_s']}s · peak RSS ~{s['peak_rss_gb']}GB",
         f"- oracle: {s['oracle_note']}",
         f"- failed must-pass A: {s['failed_a'] or 'none'} · "
         f"B: {s['failed_b'] or 'none'}", "",
         "| query | gold | neg | A@1 | A@5 | B@1 | B@5 | A hits | B hits |",
         "|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        L.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            r["note"], r["gold_in_corpus"], int(r["negative"]),
            int(r["a_r1"]), int(r["a_r5"]), int(r["b_r1"]), int(r["b_r5"]),
            r["a_hit5"], r["b_hit5"]))
    if s["failed_must_pass"]:
        L += ["", "### failed must-pass (A or B missed top-5)"]
        for f in s["failed_must_pass"]:
            L.append(f"- **{f['note']}** `{f['q']}` — "
                     f"A:{f['a_top3']} B:{f['b_top3']}")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    if "--probe" in sys.argv:
        _probe()
    else:
        main()

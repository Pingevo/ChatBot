"""eval_zaapi_search_recall.py — วัดความถูกต้องของ zaapi_search บน corpus จริง

ใช้ backup EJSON (docs/test/results/zaapi-kb-full-backup-*) — corpus เดียวกับ
production ก่อน reset (A-297): 12,168 rows / 118 registry / 7,101 visible rows

- FakeDb จำลอง Mongo เฉพาะ filter ที่ zaapi_search ใช้ ($or/$exists/$in/$ne/eq)
- patch _zaapi_files_allowed → True (gate = config ไม่ใช่ search quality)
- embedding: memoize per-text → npz cache (vector จริงจาก BGE-M3 เดียวกัน)
- สร้าง ~400 queries 7 เงื่อยไข → run production call shape (types=ALL4, limit=20)
- grade: hit@1/5 + precision@5 ด้วย _ref_hit boundary + scope/type invariants

usage: HF_HUB_OFFLINE=1 .venv/bin/python docs/test/tools/eval_zaapi_search_recall.py [--eyeball 40] [--out results.json]
"""
from __future__ import annotations

import json
import random
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))

from bson.json_util import loads  # noqa: E402

BACKUP = ROOT / "docs/test/results/zaapi-kb-full-backup-20261114T085706Z"
VEC_CACHE = Path("/tmp/zaapi_eval_vecs.npz")


# ── FakeDb ────────────────────────────────────────────────────────────────

def _match(doc: dict, filt: dict) -> bool:
    for k, v in (filt or {}).items():
        if k == "$or":
            if not any(_match(doc, c) for c in v):
                return False
        elif k == "$nor":
            if any(_match(doc, c) for c in v):
                return False
        elif k == "$and":
            if not all(_match(doc, c) for c in v):
                return False
        else:
            dv = doc.get(k)
            if isinstance(v, dict):
                for op, ov in v.items():
                    if op == "$exists":
                        if (k in doc) != bool(ov):
                            return False
                    elif op == "$in":
                        if dv not in ov:
                            return False
                    elif op == "$nin":
                        if dv in ov:
                            return False
                    elif op == "$ne":
                        if dv == ov:
                            return False
                    else:
                        raise NotImplementedError(op)
            elif dv != v:
                return False
    return True


class FakeColl:
    def __init__(self, docs):
        self._docs = list(docs)

    def find(self, filt=None, projection=None):
        return [d for d in self._docs if _match(d, filt)]

    def find_one(self, filt=None):
        for d in self._docs:
            if _match(d, filt):
                return d
        return None

    def count_documents(self, filt=None):
        return sum(1 for d in self._docs if _match(d, filt))


class FakeDb:
    def __init__(self):
        self._colls = {}

    def seed(self, name, docs):
        self._colls[name] = FakeColl(docs)

    def __getitem__(self, name):
        return self._colls.setdefault(name, FakeColl([]))


# ── embedding memo (vector จริง — encode ครั้งเดียวต่อ text) ──────────────

class VecCache:
    def __init__(self, embed_fn, path):
        self._fn = embed_fn
        self._path = Path(path)
        self._map = {}
        if self._path.exists():
            import numpy as np
            z = np.load(self._path, allow_pickle=False)
            for k, v in zip(z["keys"].tolist(), z["vecs"]):
                self._map[k] = v
            print(f"[veccache] loaded {len(self._map)} vectors", flush=True)
        self._dirty = 0

    def embed(self, texts, batch_size=32):
        import numpy as np
        out = [None] * len(texts)
        waiting = {}
        for i, t in enumerate(texts):
            if t in self._map:
                out[i] = self._map[t]
            else:
                waiting.setdefault(t, []).append(i)
        miss_txt = list(waiting)
        if miss_txt:
            vecs = self._fn(miss_txt, batch_size=512)
            for t, v in zip(miss_txt, vecs):
                self._map[t] = v
                for i in waiting[t]:
                    out[i] = v
                self._dirty += 1
            if self._dirty >= 512:
                self.save()
        return np.asarray(out, dtype="float32")

    def save(self):
        if not self._dirty:
            return
        import numpy as np
        keys = sorted(self._map)
        np.savez(self._path, keys=keys,
                 vecs=np.stack([self._map[k] for k in keys]))
        self._dirty = 0
        print(f"[veccache] saved {len(keys)}", flush=True)


# ── query generation ──────────────────────────────────────────────────────

CODE_RE = re.compile(r"[A-Za-z][A-Za-z0-9]*\d+[A-Za-z0-9]*(?:-[A-Za-z0-9]+)*")
CODE_STOP = {
    "mAh", "10000", "20000", "25000", "30000", "5000", "USB", "PD", "QC",
    "CCC", "CE", "FCC", "ROHS", "CN", "30D", "3M", "1Y", "2Y", "V", "W",
    "A", "Hz", "GHz", "GB", "TB", "Mbps", "Type", "C", "Pro", "Max",
    "Plus", "Ultra", "Lite", "Mini", "Series", "Edition", "Gen", "Ver",
    "Version", "2024", "2025", "2026", "Black", "White", "Silver", "Grey",
    "Gray", "Blue", "Green", "Pink", "Red", "Gold", "Purple", "Orange",
    "Brown", "Shopee", "Lazada", "Tiktok", "Facebook", "Line", "xlsx",
    "https", "http", "com", "www", "co", "th", "goto", "youtube", "youtu",
    "shorts", "be", "product", "products", "item", "id",
}


def _model_token(name: str) -> str:
    """หยิบ token ที่หน้าตาเหมือน model code ที่สุด (มีทั้งตัวอักษร+เลข)."""
    cands = []
    for m in CODE_RE.finditer(name or ""):
        t = m.group(0)
        if len(t) < 3 or len(t) > 20:
            continue
        if t in CODE_STOP or t.lower() in {s.lower() for s in CODE_STOP}:
            continue
        if not (any(c.isalpha() for c in t) and any(c.isdigit() for c in t)):
            continue
        if re.fullmatch(r"[A-Za-z]+\d{4}", t) and int(t[-4:]) in range(1900, 2100):
            continue  # years
        cands.append(t)
    return max(cands, key=len) if cands else ""


def gen_queries(vis_rows, regs):
    random.seed(42)
    qs = []

    def shop_of(d):
        accts = regs.get(d.get("source_file"), {}).get("accounts") or ()
        return accts[0] if accts else None

    def plat_of(d):
        pl = regs.get(d.get("source_file"), {}).get("platforms") or ()
        return pl[0] if pl else None

    prod = [d for d in vis_rows if d.get("content_type") == "product"]
    warr = [d for d in vis_rows if d.get("content_type") == "warranty"]
    ts = [d for d in vis_rows if d.get("content_type") == "troubleshooting"]
    faq = [d for d in vis_rows if d.get("content_type") == "faq"]

    # index ชื่อสินค้า → model token
    name_of = {}
    for d in vis_rows:
        f = d.get("fields") or {}
        for k in ("ชื่อสินค้า", "ชื่อ", "รุ่น", "รุ่นและหัวข้อ/อาการ", "SKU"):
            v = f.get(k)
            if v and v not in name_of.values():
                name_of[d.get("_id")] = v
                break

    codes = {}
    for d in vis_rows:
        f = d.get("fields") or {}
        nm = f.get("ชื่อสินค้า") or f.get("ชื่อ") or f.get(
            "รุ่นและหัวข้อ/อาการ") or ""
        t = _model_token(nm)
        if t:
            codes.setdefault(t, d)

    # ── A. exact model (bare code + มี code ไหม) ──
    picked = random.sample(sorted(codes), min(45, len(codes)))
    for c in picked:
        d = codes[c]
        qs.append(dict(cls="model_bare", q=c, expect_code=c,
                       shop=shop_of(d), platform=plat_of(d),
                       expect_row=d))
        qs.append(dict(cls="model_thai", q=f"มี {c} ไหม", expect_code=c,
                       shop=shop_of(d), platform=plat_of(d),
                       expect_row=d))

    # ── B. product question ──
    prod_named = [d for d in prod if _model_token(
        (d.get("fields") or {}).get("ชื่อสินค้า") or
        (d.get("fields") or {}).get("ชื่อ") or "")]
    random.shuffle(prod_named)
    tmpl = ["{nm} ราคาเท่าไหร่", "{nm} มีสีอะไรบ้าง",
            "{nm} ของแท้ไหม", "{nm} รีวิวดีไหม"]
    for d in prod_named[:40]:
        f = d.get("fields") or {}
        nm = (f.get("ชื่อสินค้า") or f.get("ชื่อ") or "").strip()
        tok = _model_token(nm)
        qs.append(dict(cls="product_q",
                       q=random.choice(tmpl).format(nm=nm[:80]),
                       expect_code=tok, shop=shop_of(d),
                       platform=plat_of(d), expect_row=d))

    # ── C. spec/fact question ──
    spec_tmpl = ["{c} กี่วัตต์", "{c} ชาร์จเร็วไหม", "{c} แบตอยู่ได้นานไหม",
                 "{c} รองรับ PD ไหม", "{c} กันน้ำไหม",
                 "{c} ใช้กับ iPhone ได้ไหม", "{c} สเปคอะไร"]
    for d in prod_named[40:100]:
        f = d.get("fields") or {}
        nm = (f.get("ชื่อสินค้า") or f.get("ชื่อ") or "").strip()
        tok = _model_token(nm)
        if not tok:
            continue
        qs.append(dict(cls="spec_q",
                       q=random.choice(spec_tmpl).format(c=tok),
                       expect_code=tok, shop=shop_of(d),
                       platform=plat_of(d), expect_row=d))

    # ── D. troubleshooting ──
    symptom_generic = [
        "ชาร์จไม่เข้า", "สายชาร์จเป็นขุย", "เปิดเครื่องไม่ติด",
        "เชื่อมต่อบลูทูธไม่ได้", "จอดับเอง", "แบตหมดเร็วมาก",
        "ชาร์จช้ามาก", "เครื่องร้อนตอนชาร์จ", "หูฟังข้างเดียวไม่มีเสียง",
        "กดปุ่มไม่ได้", "อัปเดตแอพไม่ได้", "สแกน QR ไม่ได้",
        "นาฬิกาไม่สั่นแจ้งเตือน", "วัดออกซิเจนไม่ได้",
        "ซิงค์ข้อมูลเข้าแอพไม่ขึ้น", "รีเซ็ตนาฬิกายังไง",
        "ตั้งเวลาไม่ได้", "GPS จับไม่ได้", "แจ้งเตือนไม่เด้ง",
        "โทรออกจากนาฬิกาไม่ได้", "นาฬิกาค้าง", "หน้าจอไม่ติด",
        "เชื่อมแอพหลุดบ่อย", "แบตเสื่อมเร็ว", "ชาร์จไม่เต็ม",
    ]
    ts_named = [d for d in ts if _model_token(
        (d.get("fields") or {}).get("รุ่นและหัวข้อ/อาการ") or
        (d.get("fields") or {}).get("ชื่อสินค้า") or "")]
    random.shuffle(ts_named)
    for d in ts_named[:25]:
        f = d.get("fields") or {}
        sym = (f.get("รุ่นและหัวข้อ/อาการ") or "").strip()
        tok = _model_token(sym)
        tail = sym.split("-")[-1].strip()[:60] if "-" in sym else sym[:60]
        qs.append(dict(cls="ts_model",
                       q=f"{tok} {tail}" if tail else sym[:60],
                       expect_code=tok, expect_type="troubleshooting",
                       shop=shop_of(d), platform=plat_of(d), expect_row=d))
    for s in random.sample(symptom_generic, 25):
        qs.append(dict(cls="ts_generic", q=s, expect_code="",
                       expect_type="troubleshooting", shop=None,
                       platform=None, expect_row=None))

    # ── E. warranty / faq ──
    warr_named = [d for d in warr if _model_token(
        (d.get("fields") or {}).get("ชื่อสินค้า") or "")]
    random.shuffle(warr_named)
    wt = ["{c} ประกันกี่ปี", "{c} ประกันกี่เดือน",
          "{c} เสียเคลมได้ไหม", "{c} ตกน้ำเคลมได้ไหม"]
    for d in warr_named[:35]:
        f = d.get("fields") or {}
        nm = (f.get("ชื่อสินค้า") or "").strip()
        tok = _model_token(nm)
        qs.append(dict(cls="warranty_model",
                       q=random.choice(wt).format(c=tok),
                       expect_code=tok, expect_type="warranty",
                       shop=shop_of(d), platform=plat_of(d), expect_row=d))
    faq_generic = [
        "เคลมสินค้าต้องทำยังไง", "เปลี่ยนเครื่องใหม่ได้ไหม",
        "ส่งของวันไหน", "ค่าจัดส่งเท่าไหร่", "มีโค้ดส่วนลดไหม",
        "ยกเลิกออเดอร์ได้ไหม", "เก็บเงินปลายทางได้ไหม",
        "สินค้าหมดเมื่อไหร่ลงของ", "ซื้อ 2 ชิ้นลดไหม",
        "มีของแถมให้ไหม", "ส่งนอกประเทศไหม", "รับคืนสินค้าไหม",
        "ใช้โค้ดส่วนลดยังไง", "ลดราคาเหลือเท่าไหร่", "โปรโมชั่นมีอะไรบ้าง",
        "เช็คสถานะพัสดุยังไง", "ส่ง Kerry ไหม", "กี่วันได้รับของ",
        "ส่งด่วนได้ไหม", "แพ็คของอย่างดีไหม",
    ]
    for s in faq_generic:
        qs.append(dict(cls="faq_generic", q=s, expect_code="",
                       expect_type=None, shop=None, platform=None,
                       expect_row=None))

    # ── F. scope ──
    scoped = [d for d in prod_named
              if regs.get(d.get("source_file"), {}).get("accounts")]
    random.shuffle(scoped)
    shops = sorted({a for r in regs.values()
                    for a in (r.get("accounts") or ())})
    for d in scoped[:10]:
        f = d.get("fields") or {}
        nm = (f.get("ชื่อสินค้า") or "").strip()
        tok = _model_token(nm)
        good = shop_of(d)
        bad = random.choice([s for s in shops if s != good])
        base = dict(q=f"มี {tok} ไหม", expect_code=tok, expect_row=d)
        qs.append(dict(cls="scope_ok", platform=plat_of(d), shop=good,
                       **base))
        qs.append(dict(cls="scope_wrong", platform=plat_of(d), shop=bad,
                       wrong_of=d.get("source_file"), **base))
        qs.append(dict(cls="scope_none", platform=None, shop=None, **base))

    # ── G. edge ──
    edge_codes = picked[:6]
    for c in edge_codes:
        mut = c[:-1] + ("X" if not c.endswith("X") else "Y")
        qs.append(dict(cls="edge_typo", q=f"มี {mut} ไหม", expect_code=c,
                       shop=None, platform=None, expect_row=codes.get(c)))
    for c in edge_codes:
        qs.append(dict(cls="edge_en", q=f"is {c} compatible with iPhone",
                       expect_code=c, shop=None, platform=None,
                       expect_row=codes.get(c)))
    extra = [
        ("edge_junk", "asdfqwer zxcvbn", ""),
        ("edge_junk", "ทดสอบxyz999", ""),
        ("edge_empty", "", ""),
        ("edge_empty", "   ", ""),
        ("edge_nomodel", "มี FAKEMODEL999 ไหม", ""),
        ("edge_nomodel", "iPhone 99 Pro Max รองรับไหม", ""),
        ("edge_long", (prod_named[0].get("fields") or {}).get(
            "ชื่อสินค้า") or "x" * 300, ""),
        ("edge_price", "ลดราคาเหลือเท่าไหร่คะ", ""),
        ("edge_mixed", "หูฟัง Kieslect กันน้ำไหม", "Kieslect"),
        ("edge_mixed", "CUKTECH powerbank กี่ mAh", "CUKTECH"),
    ]
    for cls, q, code in extra:
        qs.append(dict(cls=cls, q=q, expect_code=code,
                       shop=None, platform=None, expect_row=None))
    return qs


# ── grading ───────────────────────────────────────────────────────────────

def _hit_pred(q, hit, ref_hit):
    code = (q.get("expect_code") or "").lower()
    if not code:
        return False
    hay = (hit.get("a") or "").lower()
    if ref_hit(code, hay):
        return True
    for v in (hit.get("fields") or {}).values():
        if ref_hit(code, str(v).lower()):
            return True
    return False


def grade(q, hits, regs, ref_hit):
    """คืน dict metrics — predicate ตาม class."""
    cls = q["cls"]
    top5 = hits[:5]
    top1 = hits[:1]
    out = {"n_hits": len(hits)}

    if cls.startswith("scope"):
        # invariant: ทุก hit ต้องผ่าน _scope_ok กับ query scope
        from shopeechat.kb_zaapi_files import _scope_ok
        bad = []
        for h in hits:
            reg = regs.get((h.get("meta") or {}).get("file"), {})
            if not _scope_ok(reg, q.get("shop"), q.get("platform")):
                bad.append((h.get("meta") or {}).get("file"))
        out["scope_violations"] = bad
        if cls == "scope_wrong":
            wrong = q.get("wrong_of")
            leak = [h for h in hits
                    if (h.get("meta") or {}).get("file") == wrong]
            out["file_leak"] = len(leak)
        code_hit = next(
            (i + 1 for i, h in enumerate(hits[:10])
             if _hit_pred(q, h, ref_hit)), 0)
        out["hit_at_5"] = int(any(
            _hit_pred(q, h, ref_hit) for h in top5))
        out["rr"] = 1.0 / code_hit if code_hit else 0.0
        return out

    if cls.startswith("edge"):
        code_hit = next(
            (i + 1 for i, h in enumerate(hits[:10])
             if _hit_pred(q, h, ref_hit)), 0)
        out["hit_at_5"] = int(any(
            _hit_pred(q, h, ref_hit) for h in top5))
        out["rr"] = 1.0 / code_hit if code_hit else 0.0
        out["top_type"] = (top1[0].get("meta") or {}).get("file") \
            if top1 else None
        return out

    # model/product/spec/ts_model/warranty_model → code predicate
    code_hit = next(
        (i + 1 for i, h in enumerate(hits[:10])
         if _hit_pred(q, h, ref_hit)), 0)
    out["hit_at_1"] = int(bool(top1 and _hit_pred(q, top1[0], ref_hit)))
    out["hit_at_5"] = int(any(_hit_pred(q, h, ref_hit) for h in top5))
    out["prec_at_5"] = (sum(1 for h in top5
                           if _hit_pred(q, h, ref_hit)) / 5.0
                        if hits else 0.0)
    out["rr"] = 1.0 / code_hit if code_hit else 0.0
    # expected exact row present?
    er = q.get("expect_row")
    if er:
        rid = "{}::{}::{}".format(
            er.get("source_file"), er.get("sheet"), er.get("row_index"))
        out["row_in_top5"] = int(any(
            h.get("record_id") == rid for h in top5))
        out["row_rank"] = next(
            (i + 1 for i, h in enumerate(hits[:10])
             if h.get("record_id") == rid), 0)
    if cls in ("ts_generic", "faq_generic", "ts_model", "warranty_model"):
        types = [str((h.get("meta") or {}).get("type") or
                     h.get("_type") or "") for h in top5]
        out["top5_types"] = types
        if q.get("expect_type"):
            out["type_hit5"] = int(any(
                t == q["expect_type"] for t in types))
    return out


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--eyeball", type=int, default=40)
    ap.add_argument("--out", default="")
    ap.add_argument("--no-embed", action="store_true",
                    help="ข้าม semantic rerank (text-only prefilter path)")
    args = ap.parse_args()

    rows = [loads(l) for l in open(BACKUP / "zaapi_kb.ndjson")]
    regs_list = [loads(l) for l in open(BACKUP / "zaapi_kb_files.ndjson")]
    regs = {r["_id"]: r for r in regs_list}

    db = FakeDb()
    db.seed("zaapi_kb", rows)
    db.seed("zaapi_kb_files", regs_list)

    from shopeechat import kb_zaapi_files as kzf
    from shopeechat import embedding as emb
    import numpy as np

    kzf._zaapi_files_allowed = lambda: True
    ref_hit = kzf._ref_hit

    vc = VecCache(emb.embed_texts, VEC_CACHE)
    if args.no_embed:
        emb.embed_texts = lambda *a, **k: (_ for _ in ()).throw(
            RuntimeError("embed disabled"))
        emb.embed_query = emb.embed_texts
    else:
        emb.embed_texts = vc.embed
        emb.embed_query = lambda t: vc.embed([t])[0]

    qs = gen_queries(rows, regs)
    print(f"[gen] {len(qs)} queries "
          f"{ {c: sum(1 for q in qs if q['cls']==c) for c in sorted({q['cls'] for q in qs})} }",
          flush=True)

    ALL4 = ("product", "troubleshooting", "faq", "warranty")
    results = []
    t_all = time.time()
    for i, q in enumerate(qs):
        refs = [q["expect_code"]] if q.get("expect_code") else []
        t0 = time.time()
        hits, trace = kzf.zaapi_search(
            db, shop=q.get("shop"), platform=q.get("platform"),
            query=q["q"], refs=refs, limit=20, types=ALL4)
        el = time.time() - t0
        m = re.search(r"cands=(\d+).*?docs=(\d+).*?reg=(\d+)", trace[0])
        g = grade(q, hits, regs, ref_hit)
        g.update(cls=q["cls"], q=q["q"][:80], shop=q.get("shop"),
                 cands=int(m.group(1)) if m else -1,
                 docs=int(m.group(2)) if m else -1,
                 elapsed=round(el, 3),
                 top1_rid=(hits[0].get("record_id") if hits else None),
                 top1_text=((hits[0].get("a") or "")[:160] if hits else ""),
                 hits5=[{"rid": h.get("record_id"),
                         "sim": round(h.get("_qa_sim", 0), 4),
                         "pre": round(h.get("_qa_prefilter", 0), 3),
                         "text": (h.get("a") or "")[:120]}
                        for h in hits[:5]])
        results.append(g)
        if (i + 1) % 50 == 0:
            print(f"[{i + 1}/{len(qs)}] elapsed={time.time() - t_all:.0f}s",
                  flush=True)
    vc.save()

    # ── aggregate ──
    import collections
    by = collections.defaultdict(list)
    for r in results:
        by[r["cls"]].append(r)

    print("\n===== SUMMARY =====")
    print(f"{'class':<16} {'n':>4} {'hit@1':>6} {'hit@5':>6} "
          f"{'prec@5':>7} {'MRR':>6} {'cands~':>7} {'docs~':>7}")
    order = ["model_bare", "model_thai", "product_q", "spec_q",
             "ts_model", "ts_generic", "warranty_model", "faq_generic",
             "scope_ok", "scope_wrong", "scope_none",
             "edge_typo", "edge_en", "edge_junk", "edge_empty",
             "edge_nomodel", "edge_long", "edge_price", "edge_mixed"]
    tot = {"hit_at_1": 0, "hit_at_5": 0, "rr": 0.0, "n": 0}
    for cls in order:
        rs = by.get(cls) or []
        if not rs:
            continue
        n = len(rs)
        h1 = sum(r.get("hit_at_1", 0) for r in rs) / n
        h5 = sum(r.get("hit_at_5", 0) for r in rs) / n
        p5 = sum(r.get("prec_at_5", 0) for r in rs) / n
        rr = sum(r.get("rr", 0) for r in rs) / n
        ca = sum(r.get("cands", 0) for r in rs) / n
        dc = sum(r.get("docs", 0) for r in rs) / n
        print(f"{cls:<16} {n:>4} {h1:>6.2f} {h5:>6.2f} {p5:>7.2f} "
              f"{rr:>6.2f} {ca:>7.0f} {dc:>7.0f}")
        if not cls.startswith(("edge", "scope")):
            tot["hit_at_1"] += sum(r.get("hit_at_1", 0) for r in rs)
            tot["hit_at_5"] += sum(r.get("hit_at_5", 0) for r in rs)
            tot["rr"] += sum(r.get("rr", 0) for r in rs)
            tot["n"] += n
    if tot["n"]:
        print(f"{'ALL(non-edge)':<16} {tot['n']:>4} "
              f"{tot['hit_at_1'] / tot['n']:>6.2f} "
              f"{tot['hit_at_5'] / tot['n']:>6.2f} {'':>7} "
              f"{tot['rr'] / tot['n']:>6.2f}")

    # invariants
    viol = [r for r in results if r.get("scope_violations")]
    leaks = [r for r in results if r.get("file_leak")]
    print(f"\nscope violations: {len(viol)} queries | file leaks: {len(leaks)}")
    for r in (viol + leaks)[:10]:
        print("  -", r["cls"], r["q"][:60], "shop:", r.get("shop"),
              "viol:", (r.get("scope_violations") or [])[:3],
              "leak:", r.get("file_leak"))

    # failures sample
    fails = [r for r in results
             if not r["cls"].startswith(("edge", "scope"))
             and not r.get("hit_at_5")]
    print(f"\nmiss@5: {len(fails)}")
    for r in fails[:15]:
        print(f"  [{r['cls']}] {r['q'][:70]} → top1={r['top1_rid']}")

    # eyeball sample for manual review
    eb = random.sample(results, min(args.eyeball, len(results)))
    print("\n===== EYEBALL SAMPLE =====")
    for r in eb:
        print(f"\n[{r['cls']}] Q: {r['q']}")
        for h in r["hits5"][:3]:
            print(f"   #{h['sim']:.3f} {h['rid']}\n      {h['text'][:110]}")

    if args.out:
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False,
                                             indent=1, default=str))
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()

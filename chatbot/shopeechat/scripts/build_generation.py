"""build_generation.py — R1 generation build driver (daily|weekly).

ขั้น: export → image_texts(2 scopes) → units → unit npz → product npz →
description (weekly=build จริง, daily=carry+re-stamp จาก gen ล่าสุด) →
import gen colls → validate+manifest → generation_runs.status=pending
(ยังไม่ publish — CAS = admin accept แยก).

ทุกขั้นเขียน build_log.jsonl ใน gen dir + อัปเดต Mongo `generation_runs`
(percent จาก stdout `N/total` ของ scripts เดิม). build ซ้ำพร้อมกันไม่ได้ —
status=building ค้าง → หยุด (stale>24h ถือว่าตาย rerun ได้)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat.generation_pointer import mint_generation_id  # noqa: E402

_RUNS_COLL = "generation_runs"
_STALE_BUILD_SECONDS = 24 * 3600
_PROGRESS_RE = re.compile(r"(\d[\d,]*)/(\d[\d,]*)")
_PCT_RE = re.compile(r"pct=(\d+(?:\.\d+)?)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(gen_dir: Path, obj: dict) -> None:
    obj.setdefault("ts", _now())
    with (gen_dir / "build_log.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def _update_run(db, gid: str, step: str, patch: dict) -> None:
    db[_RUNS_COLL].update_one(
        {"_id": gid},
        {"$set": {**patch, "updated_at": _now(),
                  f"steps.{step}": patch.get("step_info")},
         "$setOnInsert": {"generation_id": gid, "created_at": _now()}},
        upsert=True)


def _step_update(db, gid: str, gen_dir: Path, name: str, status: str,
                 percent: float | None = None, error: str | None = None,
                 **extra) -> None:
    info = {"name": name, "status": status, "percent": percent,
            "error": error, **extra}
    _update_run(db, gid, name, {
        "current_step": name, "step_info": info})
    _log(gen_dir, {"step": name, **info})


def _run_script(gen_dir: Path, db, gid: str, step: str, args: list[str]) -> None:
    """subprocess -u + stream stdout; parse `N/total` → percent (cap 99 จน exit 0)."""
    _step_update(db, gid, gen_dir, step, "running", percent=0.0)
    log_path = gen_dir / f"build_{step}.log"
    proc = subprocess.Popen(
        [sys.executable, "-u", *args], cwd=ROOT,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    with log_path.open("w", encoding="utf-8") as lf:
        for line in proc.stdout:
            lf.write(line)
            lf.flush()
            m = _PROGRESS_RE.search(line)
            if m:
                done, total = (int(x.replace(",", "")) for x in m.groups())
                if total:
                    _step_update(db, gid, gen_dir, step, "running",
                                 percent=min(99.0, round(done / total * 100, 1)))
            pm = _PCT_RE.search(line)
            if pm:
                _step_update(db, gid, gen_dir, step, "running",
                             percent=min(99.0, float(pm.group(1))))
    rc = proc.wait()
    if rc != 0:
        _step_update(db, gid, gen_dir, step, "failed",
                     error=f"exit {rc} (log {log_path.name})")
        raise RuntimeError(f"step {step} failed rc={rc}")
    _step_update(db, gid, gen_dir, step, "done", percent=100.0)


def _find_desc_source(exports_root: Path, exclude_gid: str) -> tuple[Path, str]:
    """gen dir ล่าสุด (ชื่อ gid เรียงเวลา) ที่มี description_embeddings.npz."""
    gen_root = Path(exports_root) / "gen"
    for d in sorted((p for p in gen_root.iterdir() if p.is_dir()),
                    key=lambda p: p.name, reverse=True):
        if d.name != exclude_gid and (d / "description_embeddings.npz").exists():
            return d / "description_embeddings.npz", d.name
    raise RuntimeError("no previous generation with description_embeddings.npz")


def _carry_description(src: Path, src_gid: str, dst: Path, gid: str) -> int:
    """copy desc npz + re-stamp generation_id (ผ่าน _save_verified_npz เดิม)."""
    import numpy as np
    from chatbot.shopeechat.scripts.build_embeddings import _save_verified_npz
    z = np.load(src, allow_pickle=True)
    payload = {k: z[k] for k in z.files if k != "generation_id"}
    rows = int(z["embeddings"].shape[0])
    _save_verified_npz(payload, dst, rows, gid)
    return rows


def _import_colls(db, gid: str, gen_dir: Path) -> dict:
    """delete+insert gen colls จากไฟล์ (idempotent เทียบ validate gate)."""
    out = {}
    for coll_name, fname in ((f"sellable_units_{gid}", "sellable_units.jsonl"),
                             (f"image_texts_{gid}", "image_texts.jsonl")):
        docs = [json.loads(l) for l in (gen_dir / fname).open(encoding="utf-8")
                if l.strip()]
        coll = db[coll_name]
        coll.delete_many({})
        for i in range(0, len(docs), 500):
            coll.insert_many(docs[i:i + 500], ordered=False)
        out[coll_name] = len(docs)
    return out


_STEP_ORDER = [
    "export",
    "image_texts_sellable",
    "image_texts_nonsellable",
    "sellable_units",
    "unit_embeddings",
    "product_embeddings",
    "description_embeddings",
    "import_db",
    "validate",
]
# image_texts 2 scope merge ลง image_texts.jsonl ไฟล์เดียว — resume ต้อง
# rerun ทั้งคู่ ไม่งั้นไฟล์รวมขาด scope ที่ข้าม
_IMAGE_TEXT_PAIR = frozenset(
    {"image_texts_sellable", "image_texts_nonsellable"})
# idempotent/ต้องสดเสมอ — resume rerun ท้ายเส้นทุกครั้ง
_ALWAYS_RERUN = frozenset({"import_db", "validate"})

# step → artifact ใต้ gen_dir ที่ step เขียน (import_db เขียน Mongo ไม่ใช่ไฟล์)
_STEP_OUTPUTS = {
    "export": ("ShpProducts.export.json",),
    "image_texts_sellable": ("image_texts.jsonl",),
    "image_texts_nonsellable": ("image_texts.jsonl",),
    "sellable_units": ("sellable_units.jsonl",),
    "unit_embeddings": ("unit_embeddings.npz",),
    "product_embeddings": ("product_embeddings.npz",),
    "description_embeddings": ("description_embeddings.npz",),
    "validate": ("manifest.json",),
}


def _pid_alive(pid) -> bool:
    """pid ยังมีชีวิต? — os.kill(pid,0): dead→ProcessLookupError,
    ต่าง owner→PermissionError (alive แต่ kill ไม่ได้)"""
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (TypeError, ValueError, OSError):
        return False
    return True


def _run_alive(run: dict) -> bool:
    """building run ยังทำงานจริง? — มี pid → เช็ค pid; ไม่มี pid (run เก่าก่อน
    pid tracking) → fallback stale 24h จาก updated_at เดิม"""
    pid = run.get("pid")
    if pid is not None:
        return _pid_alive(pid)
    try:
        age = time.time() - datetime.fromisoformat(
            run["updated_at"]).timestamp()
    except (KeyError, TypeError, ValueError):
        return False
    return age < _STALE_BUILD_SECONDS


def _check_build_lock(db, exclude_gid: str | None = None) -> None:
    """ห้าม 2 builds ขนาน — building run ที่ตายแล้ว (pid dead / stale)
    ไม่บล็อก → admin resume หรือ start ใหม่ได้"""
    for run in db[_RUNS_COLL].find({"status": "building"}):
        if exclude_gid is not None and run["_id"] == exclude_gid:
            continue
        if _run_alive(run):
            raise RuntimeError(
                f"another build in progress: {run['_id']} "
                f"({run.get('current_step')})")


def _resume_plan(steps: dict, mode: str) -> list[str]:
    """run doc steps → ordered steps ที่ต้อง (re)run ตอน resume.

    - status done → skip (artifact อยู่ gen_dir แล้ว)
    - image_texts pair atomic: scope ใดยังไม่ done → rerun ทั้งคู่
      (แชร์ image_texts.jsonl — rerun scope เดียวทำไฟล์รวมขาด)
    - import_db + validate รันเสมอ (idempotent + manifest ต้องสด)
    """
    todo = {s for s in _STEP_ORDER
            if (steps.get(s) or {}).get("status") != "done"}
    if todo & _IMAGE_TEXT_PAIR:
        todo |= _IMAGE_TEXT_PAIR
    todo |= _ALWAYS_RERUN
    return [s for s in _STEP_ORDER if s in todo]


def _clean_step_outputs(gen_dir: Path, plan: list[str]) -> None:
    """ลบ artifact ของ steps ที่จะ rerun — กันไฟล์ค้างรอบที่ตายทำ output เพี้ยน"""
    for name in {f for s in plan for f in _STEP_OUTPUTS.get(s, ())}:
        (gen_dir / name).unlink(missing_ok=True)


def _run_steps(mode: str, db, exports_root: Path, gen_dir: Path,
               gid: str, plan: list[str]) -> None:
    """รัน build steps ตาม plan (ordered subset ของ _STEP_ORDER) —
    description_embeddings: weekly สร้างจริง, daily carry+re-stamp"""
    s = lambda step, args: _run_script(  # noqa: E731
        gen_dir, db, gid, step,
        [f"chatbot/shopeechat/scripts/{args[0]}", *args[1:]])
    if "export" in plan:
        s("export", ["export_mongo.py", "--collection", "ShpProducts",
                     "--format", "json", "--out", str(gen_dir)])
    for scope in ("sellable", "nonsellable"):
        step = f"image_texts_{scope}"
        if step in plan:
            s(step, ["build_image_texts.py", "--gen-dir", str(gen_dir),
                     "--gid", gid, "--scope", scope])
    if "sellable_units" in plan:
        s("sellable_units",
          ["build_sellable_units.py", "--export",
           str(gen_dir / "ShpProducts.export.json"), "--image-texts",
           str(gen_dir / "image_texts.jsonl"), "--out",
           str(gen_dir / "sellable_units.jsonl")])
    if "unit_embeddings" in plan:
        s("unit_embeddings",
          ["build_embeddings.py", "--units", "--units-path",
           str(gen_dir / "sellable_units.jsonl"), "--out",
           str(gen_dir / "unit_embeddings.npz"), "--gid", gid])
    if "product_embeddings" in plan:
        s("product_embeddings",
          ["build_embeddings.py", "--export",
           str(gen_dir / "ShpProducts.export.json"), "--out",
           str(gen_dir / "product_embeddings.npz"), "--gid", gid])
    if "description_embeddings" in plan:
        if mode == "weekly":
            s("description_embeddings",
              ["build_embeddings.py", "--description", "--export",
               str(gen_dir / "ShpProducts.export.json"), "--out",
               str(gen_dir / "description_embeddings.npz"), "--gid", gid])
        else:
            _step_update(db, gid, gen_dir, "description_embeddings",
                         "running")
            src, src_gid = _find_desc_source(exports_root, gid)
            rows = _carry_description(
                src, src_gid, gen_dir / "description_embeddings.npz", gid)
            _step_update(db, gid, gen_dir, "description_embeddings", "done",
                         percent=100.0, carried_from=src_gid, rows=rows)
            _update_run(db, gid, "description_embeddings",
                        {"description_source_gid": src_gid})
    if "import_db" in plan:
        _step_update(db, gid, gen_dir, "import_db", "running")
        counts = _import_colls(db, gid, gen_dir)
        _step_update(db, gid, gen_dir, "import_db", "done", percent=100.0,
                     **counts)
    if "validate" in plan:
        _step_update(db, gid, gen_dir, "validate", "running")
        from chatbot.shopeechat.scripts import publish_generation as pg
        stats = pg.validate_generation(gen_dir, db, gid,
                                       require_description=True)
        manifest = {"generation_id": gid, "status": "validated",
                    "validated_at": pg._utc_now_iso(),
                    "counts": stats.get("unit_count"),
                    "sha256": stats["sha256"]}
        pg.finalize_manifest(gen_dir, manifest)
        _step_update(db, gid, gen_dir, "validate", "done", percent=100.0)


def build(mode: str, db, exports_root: Path | None = None,
          gid: str | None = None) -> Path:
    """mode: daily|weekly — คืน gen_dir; raise RuntimeError เมื่อขั้นใดพัง.
    gid=None → mint ใหม่; ผู้เรียก (API start) ส่ง gid ที่ mint ไว้แล้วได้"""
    exports_root = Path(exports_root or ROOT / "exports")
    gid = gid or mint_generation_id()
    # gid ที่ caller mint มาแล้ว (API start) มี run doc+pid ของ process นี้
    # อยู่ก่อนแล้ว — exclude ตัวเองไม่งั้น lock เห็นตัวเองเป็น concurrent build
    _check_build_lock(db, exclude_gid=gid)
    gen_dir = exports_root / "gen" / gid
    gen_dir.mkdir(parents=True, exist_ok=False)
    _update_run(db, gid, "init", {
        "status": "building", "build_kind": mode,
        "pid": os.getpid(), "hostname": socket.gethostname()})
    _log(gen_dir, {"event": "build_start", "gid": gid, "mode": mode})
    t0 = time.time()
    try:
        _run_steps(mode, db, exports_root, gen_dir, gid, _STEP_ORDER)
        _update_run(db, gid, "done",
                    {"status": "pending",
                     "duration_s": round(time.time() - t0, 1)})
        _log(gen_dir, {"event": "build_done", "gid": gid,
                       "duration_s": round(time.time() - t0, 1)})
        return gen_dir
    except Exception as exc:
        _update_run(db, gid, "failed",
                    {"status": "failed", "error": str(exc),
                     "duration_s": round(time.time() - t0, 1)})
        _log(gen_dir, {"event": "build_failed", "gid": gid, "error": str(exc)})
        raise


def resume(gid: str, db, exports_root: Path | None = None) -> Path:
    """resume build ที่ตายกลางทาง (building ที่ pid ตาย / failed / stopped) —
    ใช้ run doc + gen_dir เดิม, ข้าม step ที่ done, ลบ artifact ค้างของ step
    ที่จะ rerun แล้วทำต่อ; active pointer ไม่ถูกแตะ (publish แยกเหมือนเดิม)"""
    exports_root = Path(exports_root or ROOT / "exports")
    run = db[_RUNS_COLL].find_one({"_id": gid})
    if not run:
        raise RuntimeError(f"no generation_runs doc for {gid}")
    if run.get("status") not in ("building", "failed", "stopped"):
        raise RuntimeError(
            f"cannot resume {gid}: status={run.get('status')}")
    _check_build_lock(db, exclude_gid=gid)
    mode = run.get("build_kind") or "daily"
    gen_dir = exports_root / "gen" / gid
    if not gen_dir.is_dir():
        raise RuntimeError(f"missing generation dir {gen_dir}")
    plan = _resume_plan(run.get("steps") or {}, mode)
    _update_run(db, gid, "resume", {
        "status": "building", "error": None,
        "pid": os.getpid(), "hostname": socket.gethostname(),
        "resumed_at": _now(), "resume_plan": plan})
    _log(gen_dir, {"event": "resume_start", "gid": gid,
                   "mode": mode, "plan": plan})
    _clean_step_outputs(gen_dir, plan)
    t0 = time.time()
    try:
        _run_steps(mode, db, exports_root, gen_dir, gid, plan)
        _update_run(db, gid, "done",
                    {"status": "pending",
                     "duration_s": round(time.time() - t0, 1)})
        _log(gen_dir, {"event": "build_done", "gid": gid, "resumed": True,
                       "duration_s": round(time.time() - t0, 1)})
        return gen_dir
    except Exception as exc:
        _update_run(db, gid, "failed",
                    {"status": "failed", "error": str(exc),
                     "duration_s": round(time.time() - t0, 1)})
        _log(gen_dir, {"event": "build_failed", "gid": gid,
                       "error": str(exc), "resumed": True})
        raise


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["daily", "weekly"])
    ap.add_argument("--gid", default=None,
                    help="generation id ที่ caller mint ไว้แล้ว (API start)")
    ap.add_argument("--resume", default=None, metavar="GID",
                    help="ทำต่อ build เดิมจาก step ที่ตาย (run doc/gen dir เดิม)")
    ap.add_argument("--exports-root", type=Path, default=None)
    args = ap.parse_args()
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    from chatbot.shopeechat import knowledge_base as _kb
    if args.resume:
        gen_dir = resume(args.resume, _kb._admin_db(), args.exports_root)
    else:
        if not args.mode:
            ap.error("--mode required (unless --resume)")
        gen_dir = build(args.mode, _kb._admin_db(), args.exports_root,
                        gid=args.gid)
    print(f"build done → {gen_dir} (pending admin accept)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

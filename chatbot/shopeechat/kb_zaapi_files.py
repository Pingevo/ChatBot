"""kb_zaapi_files.py — Zaapi KB file-backed serving owner (file import spec v4).

เก็บแถวต้นฉบับจาก .xlsx/.txt ใน `zaapi_kb` โดยไม่แปลงผ่าน LLM:
- row doc: source_file + file_rev + sheet/row provenance + fields/text verbatim
- registry `zaapi_kb_files`: `_id`=ชื่อไฟล์ตรงทุกตัวอักษร, `active_rev` = จุด visibility
  เดียว (ชื่อเดิม = full-file replace revision ใหม่; ชื่อใหม่ = แหล่งเพิ่ม;
  ไม่จับคู่ข้ามชื่อ)
- `zaapi_kb_import_log`: apply/rollback/sweep audit
- manual docs (ไม่มี source_file) ไม่ถูกแตะและมองเห็นเสมอ
- search = registry resolve → scoped $or → Python prefilter → lazy-embed
  cosine ทุก candidate (local BGE-M3) — ไม่มี persistent vector/cache
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import io
import os
from pathlib import PurePosixPath

import openpyxl
from openpyxl.worksheet.hyperlink import Hyperlink as _OxlHyperlink

# openpyxl 3.1.5 parse hyperlink 'address' attribute ไม่ได้ → drop kwarg
#   (pattern เดียวกับ docs/zaapi/script/import_zaapi_kb.py)
_hl_init = _OxlHyperlink.__init__
def _hl_init_compat(self, *a, **kw):  # noqa: ANN001
    kw.pop("address", None)
    _hl_init(self, *a, **kw)
_OxlHyperlink.__init__ = _hl_init_compat

from pymongo.errors import DuplicateKeyError  # noqa: E402

from . import runtime_config as _rc  # noqa: E402

_COLL = os.environ.get(
    "ADMIN_MONGO_COLLECTION_ZAAPI_KB", "zaapi_kb").strip()
_FILES_COLL = os.environ.get(
    "ADMIN_MONGO_COLLECTION_ZAAPI_KB_FILES", "zaapi_kb_files").strip()
_LOG_COLL = os.environ.get(
    "ADMIN_MONGO_COLLECTION_ZAAPI_KB_IMPORT_LOG",
    "zaapi_kb_import_log").strip()
_RETIRE_S = int(os.environ.get(
    "ZAAPI_KB_RETIRE_S", str(7 * 24 * 3600)) or "604800")

_EXTS = (".xlsx", ".txt")
# admin ระบุชนิดเนื้อหา (file/sheet) — ไม่ infer จากชื่อ/ข้อความ
_CONTENT_TYPES = frozenset(
    {"product", "troubleshooting", "faq", "warranty"})


def _zaapi_files_allowed() -> bool:
    try:
        return _rc.kb_enabled() and _rc.kb_source() == "zaapi"
    except Exception:
        return False


def _admin_db():
    from . import knowledge_base as _kb
    return _kb._admin_db()


def _utcnow():
    return _dt.datetime.now(_dt.timezone.utc)


def _valid_filename(filename: str) -> str:
    fn = (filename or "").strip()
    if (not fn or PurePosixPath(fn).name != fn or fn.startswith(".env")
            or fn == "มาแล้วจ้า.md"
            or PurePosixPath(fn).suffix.lower() not in _EXTS):
        raise ValueError("invalid filename")
    return fn


def _clean(v) -> str:
    return str(v).strip() if v is not None else ""


def _norm_platforms(v) -> list[str]:
    """platform ids → lowercase unique — canonical form ตรงกับ
    req.platform ฝั่ง chat (UI ส่ง display-case ได้)."""
    return sorted({str(p).strip().lower() for p in v or ()
                   if str(p).strip()})


def parse_upload(filename: str, data: bytes) -> list[dict]:
    """bytes → [{kind, sheet, row_index, source_row, fields, text}]
    (ค่า verbatim — ไม่แปลง/ไม่สรุป; header row เป็นชื่อคอลัมน์)."""
    fn = _valid_filename(filename)
    suffix = PurePosixPath(fn).suffix.lower()
    docs: list[dict] = []
    if suffix == ".txt":
        text = data.decode("utf-8", errors="replace").strip()
        if text:
            docs.append({"kind": "text", "sheet": None, "row_index": 0,
                         "source_row": 0, "fields": {}, "text": text})
        if not docs:
            raise ValueError("no data rows")
        return docs
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    try:
        for ws in wb.worksheets:
            rows = ws.iter_rows(values_only=True)
            header = [_clean(c) for c in next(rows, [])]
            for idx, row in enumerate(rows, start=2):
                fields = {
                    header[i]: _clean(v)
                    for i, v in enumerate(row)
                    if i < len(header) and header[i] and _clean(v)
                }
                if not fields:
                    continue
                docs.append({
                    "kind": "xlsx_row", "sheet": ws.title,
                    "row_index": len(docs), "source_row": idx,
                    "fields": fields,
                    "text": "\n".join(f"{k}: {v}" for k, v in fields.items()),
                })
    finally:
        wb.close()
    if not docs:
        raise ValueError("no data rows")
    return docs


def _row_id(filename: str, rev: int, attempt: str,
            sheet, row_index: int) -> str:
    return hashlib.sha256(
        f"{filename}|{rev}|{attempt}|{sheet}|{row_index}"
        .encode("utf-8")).hexdigest()


def _norm_content_type(v) -> str | None:
    s = str(v or "").strip()
    if not s:
        return None
    if s not in _CONTENT_TYPES:
        raise ValueError(f"unknown content_type: {s}")
    return s


def _norm_sheet_types(v) -> dict[str, str]:
    if not v:
        return {}
    out = {}
    for k, t in dict(v).items():
        ct = _norm_content_type(t)
        if ct:
            out[str(k)] = ct
    return out


def _scope_ok(reg: dict, shop, platform) -> bool:
    accts = reg.get("accounts") or ()
    plats = reg.get("platforms") or ()
    if accts and (shop or "") not in accts:
        return False
    if plats and (platform or "").lower() not in [
            str(p).lower() for p in plats]:
        return False
    return True


def _visible_pairs(db, shop=None, platform=None) -> tuple[list[dict], int]:
    """registry → [{source_file,file_rev,apply_id?}] ที่ scope match +
    จำนวน registry docs — apply_id คือ attempt ที่ CAS publish (กันแถว
    staged/orphan ชน file_rev เดียวกันหลุดมองเห็น)."""
    regs = list(db[_FILES_COLL].find({}))
    pairs = []
    for d in regs:
        if not d.get("active_rev") or not _scope_ok(d, shop, platform):
            continue
        p = {"source_file": d["_id"], "file_rev": d["active_rev"]}
        if d.get("active_apply"):
            p["apply_id"] = d["active_apply"]
        pairs.append(p)
    return pairs, len(regs)


def _sheet_key(d: dict) -> str:
    return str(d.get("sheet") or "-")


def _row_content_type(d: dict, file_type, sheet_types: dict) -> str | None:
    return (sheet_types.get(_sheet_key(d))
            or file_type or None)


def preview_import(db, *, filename: str, data: bytes,
                   accounts=(), platforms=(), content_type=None,
                   sheet_types=None) -> dict:
    """read-only: parse + เทียบ registry เดิม — 0 writes."""
    fn = _valid_filename(filename)
    docs = parse_upload(fn, data)
    reg = db[_FILES_COLL].find_one({"_id": fn}) or {}
    old_rev = reg.get("active_rev", 0)
    _of: dict = {"source_file": fn, "file_rev": old_rev}
    if reg.get("active_apply"):
        _of["apply_id"] = reg["active_apply"]
    old_rows = db[_COLL].count_documents(_of) if old_rev else 0
    ctype = _norm_content_type(content_type) or reg.get("content_type")
    stypes = (_norm_sheet_types(sheet_types)
              or dict(reg.get("sheet_types") or {}))
    sheets: dict[str, int] = {}
    sheet_type_map: dict[str, str] = {}
    untyped = 0
    for d in docs:
        sname = _sheet_key(d)
        sheets[sname] = sheets.get(sname, 0) + 1
        rt = _row_content_type(d, ctype, stypes)
        sheet_type_map[sname] = rt
        if not rt:
            untyped += 1
    return {
        "filename": fn, "new_rev": old_rev + 1,
        "replaces_rev": old_rev or None, "old_rows": old_rows,
        "new_rows": len(docs), "sheets": sheets,
        "sheet_type_map": sheet_type_map,
        "sha256": hashlib.sha256(data).hexdigest(),
        "accounts": list(accounts) or list(reg.get("accounts") or ()),
        "platforms": _norm_platforms(platforms or reg.get("platforms")
                                   or ()),
        "content_type": ctype, "sheet_types": stypes,
        "untyped_rows": untyped,
        "warnings": ([
            "การอัปโหลดชื่อเดิมจะแทนข้อมูลของไฟล์นี้ทั้งชุด "
            "(manual edit บนแถวของไฟล์จะถูกแทน)"
        ] if old_rev else []),
    }


def _log(db, entry: dict) -> None:
    db[_LOG_COLL].insert_one({**entry, "at": _utcnow()})


def apply_import(db, *, filename: str, data: bytes,
                 accounts=(), platforms=(), admin: str = "",
                 content_type=None, sheet_types=None) -> dict:
    """full-file replace: insert rows ที่ stamp (file_rev, apply_id) ครบ
    ตั้งแต่ต้น + expire_at → verify ด้วย apply_id → CAS publish triple
    (file, rev, apply_id) จุดเดียว — visibility ไม่ต้องการ mutation หลัง CAS:
    staged rows ไม่เคยตรง triple ที่ publish จึงไม่มีทางมองเห็นก่อน commit;
    งานหลัง CAS (ปลด expire_at ตัวเอง/retire เก่า/log) = cleanup ล้วน
    ล้มได้แต่ห้ามทำให้ rev ที่ publish อ่านไม่ได้ (รายงาน warning);
    CAS loser ลบเฉพาะแถวของ attempt ตัวเอง."""
    fn = _valid_filename(filename)
    ctype = _norm_content_type(content_type)
    stypes = _norm_sheet_types(sheet_types)
    docs = parse_upload(fn, data)
    now = _utcnow()
    sha = hashlib.sha256(data).hexdigest()
    za, files = db[_COLL], db[_FILES_COLL]
    reg = files.find_one({"_id": fn}) or {}
    old_rev = int(reg.get("active_rev") or 0)
    rev = old_rev + 1
    # scope/types: ค่าที่ส่งมามีนัย → ใช้ใหม่; ไม่ส่ง → inherit registry เดิม
    accts = list(accounts) or list(reg.get("accounts") or ())
    plats = _norm_platforms(platforms or reg.get("platforms") or ())
    ctype = ctype if ctype is not None else reg.get("content_type")
    stypes = stypes or dict(reg.get("sheet_types") or {})
    attempt = hashlib.sha256(
        f"{fn}|{rev}|{sha}|{now.isoformat()}|{os.urandom(16).hex()}"
        .encode()).hexdigest()[:24]
    expire_at = now + _dt.timedelta(seconds=_RETIRE_S)
    rows = [{
        "_id": _row_id(fn, rev, attempt, d.get("sheet"), d["row_index"]),
        "apply_id": attempt,
        "source_file": fn, "file_rev": rev, "file_sha256": sha,
        "kind": d["kind"], "sheet": d.get("sheet"),
        "row_index": d["row_index"], "source_row": d.get("source_row", 0),
        "fields": d.get("fields") or {}, "text": d.get("text") or "",
        "content_type": _row_content_type(d, ctype, stypes),
        "imported_at": now,
        "expire_at": expire_at,  # staged: ไม่ commit → sweep เก็บเอง
    } for d in docs]
    committed = False
    try:
        za.insert_many(rows, ordered=False)
        if za.count_documents({"apply_id": attempt}) != len(rows):
            raise RuntimeError("staged verify failed")
        za.create_index([("source_file", 1), ("file_rev", 1),
                         ("apply_id", 1)], background=True)
        try:
            res = files.update_one(
                {"_id": fn, "active_rev": old_rev},
                {"$set": {
                    "active_rev": rev, "active_apply": attempt,
                    "file_sha256": sha,
                    "accounts": accts, "platforms": plats,
                    "content_type": ctype, "sheet_types": stypes,
                    "row_count": len(rows),
                    "prev_row_count": reg.get("row_count"),
                    "prev_rev": old_rev or None,
                    "prev_apply": reg.get("active_apply"),
                    "imported_by": admin, "updated_at": now}},
                upsert=True)
        except DuplicateKeyError:
            res = None
        if not (res and (res.matched_count or res.upserted_id)):
            za.delete_many({"apply_id": attempt})  # เฉพาะของ attempt นี้
            _log_safely(db, {"op": "apply", "file": fn, "rev_to": rev,
                             "rev_from": old_rev, "status": "conflict",
                             "admin": admin})
            return {"ok": False, "conflict": True, "file": fn}
        committed = True  # CAS publish แล้ว — rows visible ทันที (triple)
        try:
            # cleanup ล้วน: ปลด expire_at ตัวเอง (sweep-proof อยู่แล้วด้วย
            # $nor active triple) + retire เก่า + stale attempt ของ rev เดิม
            # (re-apply หลัง rollback — attempt เก่าไม่ถูก publish อีก)
            # + audit log — ล้มได้
            za.update_many({"apply_id": attempt},
                           {"$unset": {"expire_at": ""}})
            za.update_many(
                {"source_file": fn, "file_rev": rev,
                 "apply_id": {"$ne": attempt}},
                {"$set": {"expire_at": expire_at}})
            if old_rev:
                za.update_many(
                    {"source_file": fn, "file_rev": old_rev},
                    {"$set": {"expire_at": expire_at}})
            _log(db, {"op": "apply", "file": fn, "rev_from": old_rev,
                      "rev_to": rev, "rows": len(rows), "sha256": sha,
                      "accounts": accts, "platforms": plats,
                      "content_type": ctype, "sheet_types": stypes,
                      "status": "ok", "admin": admin})
        except Exception as exc:
            _log_safely(db, {"op": "apply", "file": fn,
                             "rev_from": old_rev, "rev_to": rev,
                             "rows": len(rows), "status": "post_commit_warn",
                             "error": str(exc), "admin": admin})
            return {"ok": True, "file": fn, "rev": rev,
                    "rows": len(rows), "replaced_rev": old_rev or None,
                    "warning": f"post_commit_error: {exc}"}
        return {"ok": True, "file": fn, "rev": rev,
                "rows": len(rows), "replaced_rev": old_rev or None}
    except Exception:
        if not committed:
            try:
                za.delete_many({"apply_id": attempt})
            except Exception:
                pass  # rows มี expire_at → sweep เก็บภายหลัง
        raise


def _log_safely(db, entry: dict) -> None:
    try:
        _log(db, entry)
    except Exception:
        pass


def rollback_import(db, *, filename: str, admin: str = "") -> dict:
    """CAS กลับ prev_rev — prev rows ต้องครบตาม prev_row_count ที่เคย
    publish; ปลด expire_at ของ prev ก่อน flip (กัน sweep แย่งชิงชุดใหม่)."""
    fn = _valid_filename(filename)
    za, files = db[_COLL], db[_FILES_COLL]
    reg = files.find_one({"_id": fn}) or {}
    cur = int(reg.get("active_rev") or 0)
    prev = reg.get("prev_rev")
    expected = reg.get("prev_row_count")
    if not cur or not prev or expected is None:
        _log_safely(db, {"op": "rollback", "file": fn,
                         "status": "no_prev", "admin": admin})
        return {"ok": False, "reason": "no_prev", "file": fn}
    prev_filt: dict = {"source_file": fn, "file_rev": prev}
    if reg.get("prev_apply"):
        prev_filt["apply_id"] = reg["prev_apply"]
    actual = za.count_documents(prev_filt)
    if actual != int(expected):
        _log_safely(db, {"op": "rollback", "file": fn, "rev_from": cur,
                         "rev_to": prev, "status": "prev_rows_incomplete",
                         "expected": expected, "actual": actual,
                         "admin": admin})
        return {"ok": False, "reason": "prev_rows_incomplete",
                "file": fn}
    now = _utcnow()
    expire_at = now + _dt.timedelta(seconds=_RETIRE_S)
    # 1) ปลด expire_at ของ prev ก่อน — ชุดที่จะ active ห้ามโดน sweep
    za.update_many(prev_filt, {"$unset": {"expire_at": ""}})
    res = files.update_one(
        {"_id": fn, "active_rev": cur},
        {"$set": {"active_rev": prev,
                  "active_apply": reg.get("prev_apply"),
                  "prev_rev": cur,
                  "prev_apply": reg.get("active_apply"),
                  "row_count": int(expected),
                  "prev_row_count": reg.get("row_count"),
                  "updated_at": now}})
    if not res.matched_count:
        # CAS แพ้ — prev ยังไม่ active → คืน expire_at เดิมให้ sweep ได้
        za.update_many(prev_filt, {"$set": {"expire_at": expire_at}})
        _log_safely(db, {"op": "rollback", "file": fn,
                         "status": "conflict", "admin": admin})
        return {"ok": False, "conflict": True, "file": fn}
    try:
        za.update_many({"source_file": fn, "file_rev": cur},
                       {"$set": {"expire_at": expire_at}})
        _log(db, {"op": "rollback", "file": fn, "rev_from": cur,
                  "rev_to": prev, "status": "ok", "admin": admin})
    except Exception as exc:
        # pointer flip แล้ว — post-commit fail ห้ามแกะกลับ; รายงาน warning
        _log_safely(db, {"op": "rollback", "file": fn, "rev_from": cur,
                         "rev_to": prev, "status": "post_commit_warn",
                         "error": str(exc), "admin": admin})
        return {"ok": True, "file": fn, "rev": prev,
                "replaced_rev": cur,
                "warning": f"post_commit_error: {exc}"}
    return {"ok": True, "file": fn, "rev": prev, "replaced_rev": cur}


def sweep_expired(db) -> dict:
    """ลบแถวที่ expire_at < now — ยกเว้น revision ที่ registry ชี้ใช้งาน
    (expire_at รั่วบน active rev ต้องไม่ทำข้อมูลหาย)."""
    active = []
    for d in db[_FILES_COLL].find({}):
        if not d.get("active_rev"):
            continue
        p = {"source_file": d["_id"], "file_rev": d["active_rev"]}
        if d.get("active_apply"):
            p["apply_id"] = d["active_apply"]
        active.append(p)
    filt: dict = {"expire_at": {"$exists": True, "$lt": _utcnow()}}
    if active:
        filt["$nor"] = active
    res = db[_COLL].delete_many(filt)
    if res.deleted_count:
        _log_safely(db, {"op": "sweep", "deleted": res.deleted_count,
                         "status": "ok"})
    return {"deleted": res.deleted_count}


def list_files(db) -> list[dict]:
    """registry + live row counts + sheets/type breakdown สำหรับ UI/status.
    stats = aggregate เดียว group ตาม (file,rev,apply,type) ครอบทุกไฟล์ —
    key ตาม active triple; ไฟล์ disabled → stats ของ rev ที่ปิดอยู่."""
    stats: dict = {}
    try:
        for g in db[_COLL].aggregate([
            {"$match": {"file_rev": {"$exists": True}}},
            {"$group": {"_id": {"f": "$source_file", "r": "$file_rev",
                                "a": "$apply_id", "t": "$content_type"},
                        "n": {"$sum": 1},
                        "sheets": {"$addToSet": "$sheet"}}},
        ]):
            k = (g["_id"]["f"], g["_id"]["r"], g["_id"]["a"])
            s = stats.setdefault(k, {"sheets": set(), "type_counts": {}})
            s["sheets"].update(x for x in g["sheets"] if x)
            t = g["_id"]["t"] or "untyped"
            s["type_counts"][t] = s["type_counts"].get(t, 0) + g["n"]
    except Exception:
        stats = {}
    out = []
    for d in db[_FILES_COLL].find({}).sort("_id", 1):
        rev = d.get("active_rev") or 0
        apply_id = d.get("active_apply")
        if not rev:
            rev = d.get("disabled_rev") or 0
            apply_id = d.get("disabled_apply")
        filt: dict = {"source_file": d["_id"], "file_rev": rev}
        if apply_id:
            filt["apply_id"] = apply_id
        st = stats.get((d["_id"], rev, apply_id), {})
        out.append({
            "file": d["_id"], "active_rev": d.get("active_rev") or 0,
            "disabled": bool(d.get("disabled_rev")),
            "sheets": sorted(st.get("sheets") or ()),
            "type_counts": st.get("type_counts") or {},
            "prev_rev": d.get("prev_rev"),
            "content_type": d.get("content_type"),
            "sheet_types": d.get("sheet_types") or {},
            "rows": db[_COLL].count_documents(filt) if rev else 0,
            "accounts": d.get("accounts") or [],
            "platforms": d.get("platforms") or [],
            "file_sha256": d.get("file_sha256", ""),
            "imported_by": d.get("imported_by", ""),
            "updated_at": (d.get("updated_at").isoformat()
                           if d.get("updated_at") else None),
        })
    return out


def set_file_enabled(db, *, filename: str, enabled: bool,
                     admin: str = "") -> dict:
    """toggle visibility ต่อไฟล์: disable = ย้าย active_rev/active_apply →
    disabled_rev/disabled_apply (rows คงอยู่ restore ได้), enable = ย้ายกลับ.
    CAS บน rev ที่อ่าน (matched=0 → registry เปลี่ยนกลางทาง → retry);
    สถานะตรงเป้าอยู่แล้ว → ok unchanged; log op=toggle ลง import log.
    กระทบเฉพาะ registry doc ไฟล์นี้ — rows และไฟล์อื่นไม่แตะ."""
    fn = _valid_filename(filename)
    files = db[_FILES_COLL]
    reg = files.find_one({"_id": fn})
    if not reg:
        raise ValueError(f"unknown file: {fn}")
    src, dst = (("active", "disabled") if not enabled
                else ("disabled", "active"))
    rev = reg.get(f"{src}_rev")
    if reg.get(f"{dst}_rev"):
        return {"ok": True, "file": fn, "enabled": bool(enabled),
                "rev": reg[f"{dst}_rev"], "unchanged": True}
    if not rev:
        raise ValueError(f"file has no {src} revision: {fn}")
    apply_id = reg.get(f"{src}_apply")
    res = files.update_one(
        {"_id": fn, f"{src}_rev": rev},
        {"$set": {f"{dst}_rev": rev, f"{dst}_apply": apply_id,
                  "updated_at": _utcnow()},
         "$unset": {f"{src}_rev": "", f"{src}_apply": ""}})
    if res.matched_count == 0:
        raise ValueError("registry changed concurrently — retry")
    _log(db, {"op": "toggle", "file": fn, "rev_to": rev,
              "status": "ok", "admin": admin, "enabled": bool(enabled)})
    return {"ok": True, "file": fn, "enabled": bool(enabled), "rev": rev}


def export_file(db, *, filename: str) -> bytes | None:
    """active revision rows → file bytes — .txt คืน text verbatim,
    .xlsx คืน workbook (ค่า verbatim; re-import ชื่อเดิม = replace)."""
    fn = _valid_filename(filename)
    reg = db[_FILES_COLL].find_one({"_id": fn}) or {}
    rev = reg.get("active_rev")
    apply_id = reg.get("active_apply")
    if not rev:  # disabled file → export revision ที่ถูกปิดอยู่แทน
        rev = reg.get("disabled_rev")
        apply_id = reg.get("disabled_apply")
    if not rev:
        return None
    filt: dict = {"source_file": fn, "file_rev": rev}
    if apply_id:
        filt["apply_id"] = apply_id
    rows = list(db[_COLL].find(filt).sort(
        [("sheet", 1), ("row_index", 1)]))
    if not rows:
        return None
    if PurePosixPath(fn).suffix.lower() == ".txt":
        return "\n".join(r.get("text") or "" for r in rows).encode("utf-8")
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    by_sheet: dict[str, list[dict]] = {}
    for r in rows:
        by_sheet.setdefault(str(r.get("sheet") or "Sheet1"),
                            []).append(r)
    for sheet_name, srows in by_sheet.items():
        ws = wb.create_sheet(title=sheet_name[:31])
        header: list[str] = []
        for r in srows:
            for k in (r.get("fields") or {"text": r.get("text", "")}):
                if k not in header:
                    header.append(k)
        ws.append(header)
        for r in srows:
            fields = r.get("fields") or {"text": r.get("text", "")}
            ws.append([fields.get(h, "") for h in header])
    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    return buf.getvalue()


# ── search ────────────────────────────────────────────────────────────────

def _trigram_dice(a: str, b: str) -> float:
    """char-3gram Dice — prefilter score เท่านั้น (ไม่ใช่ semantic truth)."""
    a, b = " ".join((a or "").lower().split()), " ".join(
        (b or "").lower().split())
    if not a or not b:
        return 0.0
    ga = {a[i:i + 3] for i in range(max(1, len(a) - 2))}
    gb = {b[i:i + 3] for i in range(max(1, len(b) - 2))}
    inter = len(ga & gb)
    return (2.0 * inter / (len(ga) + len(gb))) if (ga or gb) else 0.0


def _cosine(qv, tv) -> float:
    import numpy as np
    q = np.asarray(qv, dtype="float32")
    t = np.asarray(tv, dtype="float32")
    d = float(np.linalg.norm(q) * np.linalg.norm(t))
    return float(np.dot(q, t) / d) if d else 0.0


def _code_edge(c: str) -> bool:
    """ตัวอักษรที่ต่อ token รุ่นได้ — alnum + - _ (กัน 'AC65B' กลืน
    'AC65B-2'/'AC65B_2' เป็น near-model)."""
    return bool(c) and c.isascii() and (c.isalnum() or c in "-_")


def _ref_hit(ref: str, hay: str) -> bool:
    """ref พบใน hay แบบติดขอบ code-edge ไม่ได้ — 'ac65b' ห้ามนับใน
    'ac65b2'/'ac65b-2' (near-model); ภาษาไทยต่อท้ายนับปกติ (ไม่มีวรรค)."""
    start = 0
    while True:
        i = hay.find(ref, start)
        if i < 0:
            return False
        before = hay[i - 1] if i else ""
        after = hay[i + len(ref)] if i + len(ref) < len(hay) else ""
        if not _code_edge(before) and not _code_edge(after):
            return True
        start = i + 1


def _manual_scope_ok(d: dict, shop, platform) -> bool:
    """standalone manual doc: unscoped/accounts ว่าง → ทุกร้าน; entry ที่มี
    name/platform ต้อง match ตรง (ค่าว่างใน entry = wildcard; shop/platform
    ไม่รู้จัก → เฉพาะ entry ที่ไม่จำกัดค่านั้นผ่าน — fail-closed)."""
    accts = d.get("accounts") or ()
    if d.get("unscoped") or not accts:
        return True
    for e in accts:
        name_ok = not e.get("name") or e.get("name") == shop
        plat_ok = (not e.get("platform")
                   or str(e.get("platform")).lower()
                   == str(platform or "").lower())
        if name_ok and plat_ok:
            return True
    return False


def zaapi_search(db, *, shop=None, platform=None, query: str = "",
                 refs=(), limit: int = 5, types=None,
                 include_manual: bool = False) -> tuple[list[dict], tuple]:
    """ค้น active rows → hits [{a,q,_qa_score,_qa_sim,record_id,meta,...}].

    registry resolve → $or visible pairs (file rows, content_type filter
    ตาม types — แถวไม่จัดชนิดไม่เข้าเส้นทางเฉพาะชนิด) + manual docs
    (kind=manual+active เท่านั้น เมื่อ include_manual; legacy unmigrated
    ห้ามรวม) → Python prefilter (refs boundary-match + trigram
    = ขอบเขตงานเดียว) → lazy-embed cosine บนทุก candidate ที่ผ่าน —
    ไม่ตัด rank ก่อน cosine (แถวที่ถูกต้องทางความหมายห้ามหลุดก่อน rerank;
    cost ผูกกับจำนวน prefilter-admitted ไม่ใช่ cap ตายตัว)."""
    if not _zaapi_files_allowed():
        return [], ("zaapi_files_gate_closed",)
    try:
        pairs, nreg = _visible_pairs(db, shop, platform)
        typed = [str(t) for t in types or () if str(t).strip()]
        ors = []
        for p in pairs:
            cond = dict(p)
            if typed:
                cond["content_type"] = {"$in": typed}
            ors.append(cond)
        if include_manual:
            ors.append({"source_file": {"$exists": False},
                        "kind": "manual", "active": {"$ne": False}})
        if not ors:
            return [], (f"zaapi_files_empty reg={nreg}",)
        docs = list(db[_COLL].find(
            {"$or": ors},
            {"fields": 1, "text": 1, "source_file": 1,
             "file_rev": 1, "sheet": 1, "row_index": 1,
             "content_type": 1, "kind": 1, "accounts": 1,
             "unscoped": 1, "active": 1}))
    except Exception:
        return [], ("zaapi_files_read_err",)
    docs = [d for d in docs
            if d.get("source_file")
            or _manual_scope_ok(d, shop, platform)]
    if not docs:
        return [], (f"zaapi_files_empty reg={nreg}",)
    ref_l = [str(r).lower() for r in refs if str(r).strip()]
    # exact query substring = ref เดียวกัน (short query เช่น "AC65B" ต้องจับได้)
    qfull = (query or "").strip().lower()
    if len(qfull) >= 4 and qfull not in ref_l:
        ref_l.append(qfull)
    scored: list[tuple[float, dict]] = []
    for d in docs:
        text = d.get("text") or ""
        hay = text.lower()
        ref_hits = sum(1 for r in ref_l if _ref_hit(r, hay))
        tri = _trigram_dice(query, text)
        if ref_hits or tri >= 0.08:
            scored.append((ref_hits * 0.5 + tri, d))
    scored.sort(key=lambda t: -t[0])
    cands = scored  # ทุกแถวที่ prefilter ผ่าน — ไม่ตัดก่อน semantic rerank
    if not cands:
        return [], ("zaapi_files_no_match",)
    sims: list[float] | None = None
    try:
        from . import embedding as _emb
        qv = _emb.embed_query(query)
        tvs = _emb.embed_texts([d.get("text") or "" for _, d in cands])
        sims = [_cosine(qv, tv) for tv in tvs]
    except Exception:
        sims = None
    hits: list[dict] = []
    for i, (pre, d) in enumerate(cands):
        sim = sims[i] if sims is not None else pre
        rid = "{}::{}::{}".format(
            d.get("source_file") or "manual:" + str(d.get("_id", ""))[-6:],
            d.get("sheet") if d.get("sheet") is not None else "-",
            d.get("row_index"))
        hits.append({
            "a": d.get("text") or "", "q": "",
            "_qa_sim": sim, "_qa_score": sim,
            "_qa_prefilter": pre, "_qa_source": "zaapi",
            "record_id": rid,
            "meta": {"file": d.get("source_file"),
                     "sheet": d.get("sheet"),
                     "row": d.get("row_index")},
            "fields": d.get("fields") or {},
        })
    hits.sort(key=lambda h: -h["_qa_sim"])
    return hits[:limit], (
        f"zaapi_files hits={len(hits)} cands={len(cands)} "
        f"docs={len(docs)} reg={nreg}"
        f"{' sim=embed' if sims is not None else ' sim=prefilter'}",)


def file_kb_ready(db) -> dict:
    """readiness = active file revision rows ที่ triple registry publish —
    ไม่กรอง scope (readiness = มีข้อมูล active จริง ไม่ใช่ร้านใดค้นได้);
    manual/legacy-unmigrated docs ไม่ทำให้พร้อม (รายงานแยกเพื่อ migration)."""
    regs = list(db[_FILES_COLL].find({}))
    ors = []
    for d in regs:
        if not d.get("active_rev"):
            continue
        p = {"source_file": d["_id"], "file_rev": d["active_rev"]}
        if d.get("active_apply"):
            p["apply_id"] = d["active_apply"]
        ors.append(p)
    rows = (db[_COLL].count_documents({"$or": ors}) if ors else 0)
    nreg = len(regs)
    manual = db[_COLL].count_documents(
        {"source_file": {"$exists": False}, "kind": "manual",
         "active": {"$ne": False}})
    legacy = db[_COLL].count_documents(
        {"source_file": {"$exists": False}, "kind": {"$ne": "manual"}})
    return {"files": nreg, "active_rows": rows, "manual_rows": manual,
            "legacy_unmigrated_rows": legacy,
            "searchable": bool(rows)}

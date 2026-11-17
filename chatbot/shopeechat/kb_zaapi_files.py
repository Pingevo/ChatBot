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

import base64
import datetime as _dt
import hashlib
import io
import json
import os
import re
import time as _time
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
_SOURCES_COLL = f"{_FILES_COLL}_sources"
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
                cells = [{"column_index": i + 1,
                          "header": header[i] if i < len(header) else "",
                          "value": "" if v is None else str(v)}
                         for i, v in enumerate(row)]
                fields = {c["header"]: _clean(c["value"]) for c in cells
                          if c["header"] and _clean(c["value"])}
                if not any(_clean(c["value"]) for c in cells):
                    continue
                docs.append({
                    "kind": "xlsx_row", "sheet": ws.title,
                    "row_index": len(docs), "source_row": idx,
                    "cells": cells, "fields": fields,
                    "text": "\n".join(
                        f"{c['header'] or 'column_' + str(c['column_index'])}: "
                        f"{_clean(c['value'])}" for c in cells
                        if _clean(c["value"])),
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


def _json_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate JSON key")
        out[key] = value
    return out


def _norm_shop_scopes(scopes) -> list[dict]:
    if not isinstance(scopes, list):
        raise ValueError("shop_scopes must be a list")
    out, keys, names = [], set(), set()
    for s in scopes:
        if not isinstance(s, dict):
            raise ValueError("invalid shop scope")
        if not all(isinstance(s.get(k), str) and s[k].strip()
                   for k in ("platform", "shop_id", "shopname")):
            raise ValueError("shop scope requires platform, shop_id and shopname")
        p, sid, name = s["platform"].strip().lower(), s["shop_id"].strip(), s["shopname"].strip()
        key = f"{p}|{sid}"
        if "|" in p or "|" in sid or s.get("key", key) != key:
            raise ValueError("invalid shop key")
        if key in keys or (p, name) in names:
            raise ValueError("duplicate or ambiguous shop scope")
        keys.add(key)
        names.add((p, name))
        out.append({"key": key, "platform": p, "shop_id": sid, "shopname": name})
    return sorted(out, key=lambda s: s["key"])


def validate_shop_mapping(mapping_data: bytes, source_data: bytes,
                          shops: list[dict]) -> list[dict]:
    mapping = json.loads(mapping_data, object_pairs_hook=_json_object)
    source = json.loads(source_data, object_pairs_hook=_json_object)
    if (not isinstance(mapping, dict) or mapping.get("version") != 1
            or not isinstance(mapping.get("mapping"), dict)
            or not isinstance(mapping.get("rows"), list)
            or not isinstance(source, dict) or not isinstance(source.get("items"), list)):
        raise ValueError("invalid mapping/source schema")
    if mapping.get("zaapi_source_sha256") != hashlib.sha256(source_data).hexdigest():
        raise ValueError("source snapshot checksum mismatch")
    current = {s["key"]: s for s in _norm_shop_scopes(shops)}
    sources, filenames = {}, set()
    for item in source["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
            raise ValueError("invalid source identity")
        download = item.get("downloaded_file")
        if not isinstance(download, dict) or not isinstance(download.get("file"), str):
            raise ValueError("source file metadata missing")
        fn = _valid_filename(download["file"])
        sha = download.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64:
            raise ValueError("invalid source file checksum")
        try:
            int(sha, 16)
        except ValueError:
            raise ValueError("invalid source file checksum") from None
        if item["id"] in sources or fn in filenames:
            raise ValueError("duplicate source identity or filename")
        sources[item["id"]] = {"filename": fn, "file_sha256": sha}
        filenames.add(fn)
    if set(mapping["mapping"]) - set(sources):
        raise ValueError("unknown source in mapping")
    rows = {}
    for row in mapping["rows"]:
        if (not isinstance(row, dict) or not isinstance(row.get("source_id"), str)
                or row["source_id"] in rows):
            raise ValueError("invalid or duplicate mapping row")
        rows[row["source_id"]] = row
    if set(rows) != set(mapping["mapping"]):
        raise ValueError("mapping and rows disagree")
    plan = []
    for sid, info in sources.items():
        selected = mapping["mapping"].get(sid, [])
        if (not isinstance(selected, list) or not all(isinstance(k, str) for k in selected)
                or len(set(selected)) != len(selected) or set(selected) - set(current)):
            raise ValueError("duplicate, unknown or stale shop key")
        scopes = sorted((current[k] for k in selected), key=lambda s: s["key"])
        if sid in rows:
            row = rows[sid]
            if row.get("file") != info["filename"] or _norm_shop_scopes(row.get("shops")) != scopes:
                raise ValueError("mapping row does not match source/current shops")
        plan.append({"source_id": sid, **info, "shop_scopes": scopes,
                     "mapping_sha256": hashlib.sha256(mapping_data).hexdigest(),
                     "source_snapshot_sha256": mapping["zaapi_source_sha256"]})
    return plan


def _scope_ok(reg: dict, shop, platform) -> bool:
    if reg.get("shop_scopes") is not None:
        if not isinstance(shop, str) or not isinstance(platform, str):
            return False
        try:
            scopes = _norm_shop_scopes(reg["shop_scopes"])
        except ValueError:
            return False
        return any(s["platform"] == platform.strip().lower()
                   and shop.strip() in (s["shop_id"], s["shopname"])
                   for s in scopes)
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
    return (d["content_type"] if "content_type" in d else
            sheet_types.get(_sheet_key(d)) or file_type or None)


def _restore_snapshot(docs: list[dict], snapshot) -> list[dict]:
    if snapshot is None:
        return docs
    if not isinstance(snapshot, list) or len(snapshot) != len(docs):
        raise ValueError("row snapshot count mismatch")
    restored = []
    for raw, row in zip(docs, snapshot):
        if (not isinstance(row, dict) or any(row.get(k) != raw.get(k)
                for k in ("kind", "sheet", "row_index", "source_row"))
                or (row.get("cells") or []) != (raw.get("cells") or [])):
            raise ValueError("row snapshot provenance mismatch")
        fields = row.get("fields")
        if (not isinstance(fields, dict) or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in fields.items())
                or not isinstance(row.get("text"), str)
                or not isinstance(row.get("manual_edit", False), bool)):
            raise ValueError("invalid row snapshot values")
        changed = fields != raw["fields"] or row["text"] != raw["text"]
        if changed and not row.get("manual_edit"):
            raise ValueError("changed row requires manual edit provenance")
        restored.append({**raw, "fields": fields, "text": row["text"],
                         "content_type": _norm_content_type(row.get("content_type")),
                         "manual_edit": row.get("manual_edit", False)})
    return restored


def _subject_digest(d: dict) -> str:
    payload = [d.get("fields") or {}, d.get("text") or "", d.get("cells") or [],
               d.get("subject_refs") or []]
    if d.get("facts"):
        payload.append(d["facts"])
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def _bind_subjects(docs: list[dict], bindings, reg: dict, sha: str) -> tuple[dict, list[dict]]:
    if bindings is None:
        bindings = reg.get("subject_bindings") or {}
        if reg.get("file_sha256") != sha and any("refs" in b or "rows" in b for b in bindings.values()):
            raise ValueError("fixed subject bindings require review for changed source")
    if not isinstance(bindings, dict):
        raise ValueError("subject_bindings must be a sheet mapping")
    sheets = {_sheet_key(d) for d in docs}
    plan = {}
    for sheet, rule in bindings.items():
        if sheet not in sheets or not isinstance(rule, dict) or set(rule) - {"facts"} not in ({"columns"}, {"refs"}, {"rows"}):
            raise ValueError("invalid subject binding sheet or rule")
        if "columns" not in rule:
            assignments = {"*": rule["refs"]} if "refs" in rule else rule["rows"]
            row_keys = {str(d["row_index"]) for d in docs if _sheet_key(d) == sheet}
            if (not isinstance(assignments, dict) or not assignments
                    or ("rows" in rule and set(assignments) - row_keys)):
                raise ValueError("invalid subject row positions")
            normalized = {}
            for key, refs in assignments.items():
                if not isinstance(refs, list) or not refs or not all(isinstance(r, str) and r.strip() for r in refs):
                    raise ValueError("invalid subject refs")
                normalized[key] = sorted({" ".join(r.casefold().split()) for r in refs})
            plan[sheet] = {"refs": normalized["*"]} if "refs" in rule else {"rows": normalized}
        else:
            cols = rule["columns"]
            if not isinstance(cols, list) or not cols:
                raise ValueError("subject columns must be nonempty")
            indices = set()
            for c in cols:
                if (not isinstance(c, dict) or set(c) != {"column_index", "header"}
                        or type(c["column_index"]) is not int or c["column_index"] < 1
                        or not isinstance(c["header"], str) or c["column_index"] in indices):
                    raise ValueError("invalid subject column selector")
                indices.add(c["column_index"])
            plan[sheet] = {"columns": [dict(c) for c in cols]}
        facts = rule.get("facts", {})
        if not isinstance(facts, dict) or set(facts) - {"warranty"}:
            raise ValueError("invalid subject fact bindings")
        for selector in facts.values():
            if (not isinstance(selector, dict) or set(selector) != {"column_index", "header"}
                    or type(selector["column_index"]) is not int or selector["column_index"] < 1
                    or not isinstance(selector["header"], str)):
                raise ValueError("invalid subject fact column selector")
        if facts:
            plan[sheet]["facts"] = {key: dict(selector) for key, selector in facts.items()}
    bound = []
    for d in docs:
        rule = plan.get(_sheet_key(d), {})
        refs = list(rule.get("refs", rule.get("rows", {}).get(str(d["row_index"]), ())))
        cells = {c["column_index"]: c for c in d.get("cells") or ()}
        facts = []
        selectors = [(None, s) for s in rule.get("columns", ())] + list(rule.get("facts", {}).items())
        for fact, selector in selectors:
            cell = cells.get(selector["column_index"])
            if cell is None or cell["header"] != selector["header"]:
                raise ValueError("subject column header or position changed")
            value = cell["value"]
            if d.get("manual_edit"):
                header = cell["header"]
                value = (d["fields"].get(header, "") if header and sum(
                    c["header"] == header for c in cells.values()) == 1 else "")
            if fact:
                from .warranty import warranty_value_months
                months = warranty_value_months(value)
                if refs and months is not None and months > 0:
                    facts.append({"key": fact, "value": months})
            elif value.strip():
                refs.append(" ".join(value.casefold().split()))
        row = {**d, "subject_refs": sorted(set(refs)), **({"facts": facts} if rule.get("facts") else {})}
        bound.append({**row, "subject_digest": _subject_digest(row)})
    return plan, bound


def _import_scope(db, filename: str, reg: dict, source_id, shop_scopes,
                  data: bytes, file_sha256, mapping_sha256, source_snapshot_sha256) -> dict:
    sha = hashlib.sha256(data).hexdigest()
    if file_sha256 is not None and file_sha256 != sha:
        raise ValueError("source file checksum mismatch")
    sid = reg.get("source_id") if source_id is None else source_id
    scopes = reg.get("shop_scopes") if shop_scopes is None else shop_scopes
    if sid is not None:
        if not isinstance(sid, str) or not sid.strip() or sid != sid.strip():
            raise ValueError("invalid source identity")
        if reg.get("source_id") not in (None, sid):
            raise ValueError("source reassignment requires explicit migration")
        bound = db[_FILES_COLL].find_one({"source_id": sid})
        if bound and bound["_id"] != filename:
            raise ValueError("source already bound to another filename; review rename")
        if scopes is None:
            raise ValueError("source requires explicit shop scopes")
    if scopes is not None:
        if sid is None:
            raise ValueError("shop scopes require a source identity")
        scopes = _norm_shop_scopes(scopes)
    return {"source_id": sid, "shop_scopes": scopes,
            "mapping_sha256": mapping_sha256 or (
                reg.get("mapping_sha256") if reg.get("file_sha256") == sha else None),
            "source_snapshot_sha256": source_snapshot_sha256 or (
                reg.get("source_snapshot_sha256") if reg.get("file_sha256") == sha else None)}


def preview_import(db, *, filename: str, data: bytes,
                   accounts=(), platforms=(), content_type=None,
                   sheet_types=None, source_id=None, shop_scopes=None, row_snapshot=None,
                   file_sha256=None, mapping_sha256=None, source_snapshot_sha256=None,
                   subject_bindings=None) -> dict:
    """read-only: parse + เทียบ registry เดิม — 0 writes."""
    fn = _valid_filename(filename)
    docs = _restore_snapshot(parse_upload(fn, data), row_snapshot)
    reg = db[_FILES_COLL].find_one({"_id": fn}) or {}
    scope = _import_scope(db, fn, reg, source_id, shop_scopes, data,
                          file_sha256, mapping_sha256, source_snapshot_sha256)
    bindings, docs = _bind_subjects(docs, subject_bindings, reg, hashlib.sha256(data).hexdigest())
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
    columns: dict[tuple[str, str], set[int]] = {}
    unnamed: dict[str, set[int]] = {}
    sheet_columns: dict[str, dict[int, str]] = {}
    for d in docs:
        sname = _sheet_key(d)
        for c in d.get("cells") or ():
            sheet_columns.setdefault(sname, {})[c["column_index"]] = c["header"]
            if c["header"]:
                columns.setdefault((sname, c["header"]), set()).add(c["column_index"])
            elif _clean(c["value"]):
                unnamed.setdefault(sname, set()).add(c["column_index"])
        sheets[sname] = sheets.get(sname, 0) + 1
        rt = _row_content_type(d, ctype, stypes)
        sheet_type_map[sname] = rt
        if not rt:
            untyped += 1
    duplicate_columns = [
        {"sheet": s, "header": h, "columns": sorted(cs)}
        for (s, h), cs in columns.items() if len(cs) > 1]
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
        "untyped_rows": untyped, **scope, "subject_bindings": bindings,
        "bound_rows": sum(bool(d["subject_refs"]) for d in docs),
        "unbound_rows": sum(not d["subject_refs"] for d in docs),
        "sheet_columns": {s: [{"column_index": i, "header": h} for i, h in sorted(cs.items())]
                          for s, cs in sheet_columns.items()},
        "subject_samples": [{"sheet": d.get("sheet"), "row_index": d["row_index"],
                             "source_row": d.get("source_row"), "cells": d.get("cells") or [],
                             "fields": d.get("fields") or {}, "text": d.get("text") or "",
                             "subject_refs": d["subject_refs"], "facts": d.get("facts") or []} for d in docs[:10]],
        "duplicate_columns": duplicate_columns,
        "unnamed_columns": [{"sheet": s, "columns": sorted(cs)}
                            for s, cs in unnamed.items()],
        "warnings": ([
            "การอัปโหลดชื่อเดิมจะแทนข้อมูลของไฟล์นี้ทั้งชุด "
            "(manual edit บนแถวของไฟล์จะถูกแทน)"
        ] if old_rev else []) + (
            ["Duplicate headers preserved by column position"]
            if duplicate_columns else []) + (
            ["Unnamed nonempty columns preserved by column position"]
            if unnamed else []),
    }


def _log(db, entry: dict) -> None:
    db[_LOG_COLL].insert_one({**entry, "at": _utcnow()})


def apply_import(db, *, filename: str, data: bytes,
                 accounts=(), platforms=(), admin: str = "",
                 content_type=None, sheet_types=None,
                 source_id=None, shop_scopes=None, row_snapshot=None,
                   file_sha256=None, mapping_sha256=None, source_snapshot_sha256=None,
                   subject_bindings=None, require_scope: bool = False) -> dict:
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
    docs = _restore_snapshot(parse_upload(fn, data), row_snapshot)
    now = _utcnow()
    sha = hashlib.sha256(data).hexdigest()
    za, files = db[_COLL], db[_FILES_COLL]
    reg = files.find_one({"_id": fn}) or {}
    scope = _import_scope(db, fn, reg, source_id, shop_scopes, data,
                          file_sha256, mapping_sha256, source_snapshot_sha256)
    if require_scope and not scope["shop_scopes"]:
        raise ValueError("shop scope required: select platform/shop for this file before import")
    bindings, docs = _bind_subjects(docs, subject_bindings, reg, hashlib.sha256(data).hexdigest())
    old_rev = int(reg.get("active_rev") or 0)
    rev = old_rev + 1
    # scope/types: ค่าที่ส่งมามีนัย → ใช้ใหม่; ไม่ส่ง → inherit registry เดิม
    accts = list(accounts) or list(reg.get("accounts") or ())
    plats = _norm_platforms(platforms or reg.get("platforms") or ())
    ctype = ctype if ctype is not None else reg.get("content_type")
    stypes = stypes or dict(reg.get("sheet_types") or {})
    metadata = {**scope, "file_sha256": sha, "accounts": accts,
                "platforms": plats, "content_type": ctype, "sheet_types": stypes,
                "subject_bindings": bindings}
    previous_metadata = {k: reg.get(k) for k in metadata}
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
        "cells": d.get("cells") or [],
        "subject_refs": d["subject_refs"], "subject_digest": d["subject_digest"],
        **({"facts": d["facts"]} if "facts" in d else {}),
        **({"manual_edit": d["manual_edit"]} if "manual_edit" in d else {}),
        "content_type": _row_content_type(d, ctype, stypes),
        "imported_at": now,
        "expire_at": expire_at,  # staged: ไม่ commit → sweep เก็บเอง
    } for d in docs]
    # เตรียม vector ล่วงหน้าต่อ revision (row เปลี่ยน = rev ใหม่เสมอ —
    #   pin model_identity ไว้กับ vec; search เทียบ pin ก่อนใช้)
    vecs, vec_model = None, None
    try:
        from . import embedding as _emb
        vecs = _emb.embed_texts([r["text"] for r in rows])
        vec_model = _emb.model_identity()
    except Exception:
        vecs = None
    if vecs is not None:
        for r, v in zip(rows, vecs):
            r["vec"] = [float(x) for x in v]
            r["vec_model"] = vec_model
    committed = False
    try:
        if scope["source_id"] is not None:
            files.create_index("source_id", unique=True,
                               partialFilterExpression={"source_id": {"$type": "string"}})
        db[_SOURCES_COLL].insert_one({
            "_id": attempt, "apply_id": attempt,
            "source_file": fn, "file_rev": rev, "metadata": metadata,
            "file_sha256": sha, "data": data, "expire_at": expire_at})
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
                    **metadata, "prev_metadata": previous_metadata,
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
            db[_SOURCES_COLL].delete_many({"apply_id": attempt})
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
            db[_SOURCES_COLL].update_many(
                {"source_file": fn, "apply_id": {"$ne": attempt}},
                {"$set": {"expire_at": expire_at}})
            db[_SOURCES_COLL].update_many(
                {"apply_id": attempt}, {"$unset": {"expire_at": ""}})
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
                db[_SOURCES_COLL].delete_many({"apply_id": attempt})
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
    if (reg.get("shop_scopes") is not None
            and (reg.get("prev_metadata") or {}).get("shop_scopes") is None):
        return {"ok": False, "reason": "prev_scope_unverified", "file": fn}
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
    db[_SOURCES_COLL].update_many(prev_filt, {"$unset": {"expire_at": ""}})
    previous_metadata = reg.get("prev_metadata") or {}
    current_metadata = {k: reg.get(k) for k in previous_metadata}
    res = files.update_one(
        {"_id": fn, "active_rev": cur},
        {"$set": {**previous_metadata, "prev_metadata": current_metadata,
                  "active_rev": prev,
                  "active_apply": reg.get("prev_apply"),
                  "prev_rev": cur,
                  "prev_apply": reg.get("active_apply"),
                  "row_count": int(expected),
                  "prev_row_count": reg.get("row_count"),
                  "updated_at": now}})
    if not res.matched_count:
        # CAS แพ้ — prev ยังไม่ active → คืน expire_at เดิมให้ sweep ได้
        za.update_many(prev_filt, {"$set": {"expire_at": expire_at}})
        db[_SOURCES_COLL].update_many(prev_filt, {"$set": {"expire_at": expire_at}})
        _log_safely(db, {"op": "rollback", "file": fn,
                         "status": "conflict", "admin": admin})
        return {"ok": False, "conflict": True, "file": fn}
    try:
        za.update_many({"source_file": fn, "file_rev": cur},
                       {"$set": {"expire_at": expire_at}})
        db[_SOURCES_COLL].update_many(
            {"source_file": fn, "file_rev": cur},
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
        for state in ("active", "disabled"):
            if not d.get(f"{state}_rev"):
                continue
            p = {"source_file": d["_id"], "file_rev": d[f"{state}_rev"]}
            if d.get(f"{state}_apply"):
                p["apply_id"] = d[f"{state}_apply"]
            active.append(p)
    filt: dict = {"expire_at": {"$exists": True, "$lt": _utcnow()}}
    if active:
        filt["$nor"] = active
    res = db[_COLL].delete_many(filt)
    db[_SOURCES_COLL].delete_many(filt)
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
            "source_id": d.get("source_id"), "shop_scopes": d.get("shop_scopes"),
            "subject_bindings": d.get("subject_bindings") or {},
            "mapping_sha256": d.get("mapping_sha256"),
            "source_snapshot_sha256": d.get("source_snapshot_sha256"),
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


def export_package(db, *, filename: str) -> bytes | None:
    from .kb_zaapi_schema import canonical_json
    fn = _valid_filename(filename)
    reg = db[_FILES_COLL].find_one({"_id": fn}) or {}
    rev = reg.get("active_rev") or reg.get("disabled_rev")
    attempt = reg.get("active_apply") or reg.get("disabled_apply")
    if not rev:
        return None
    if not reg.get("source_id") or reg.get("shop_scopes") is None:
        raise ValueError("portable export requires explicit validated source/shop mapping")
    filt = {"source_file": fn, "file_rev": rev, "apply_id": attempt}
    source = db[_SOURCES_COLL].find_one(filt)
    if source is None:
        raise ValueError("original source unavailable; re-import required")
    raw = bytes(source["data"])
    if hashlib.sha256(raw).hexdigest() != source["file_sha256"]:
        raise ValueError("source checksum mismatch")
    stored = list(db[_COLL].find(filt).sort("row_index"))
    if len(stored) != reg.get("row_count"):
        raise ValueError("active revision rows incomplete")
    keys = ("kind", "sheet", "row_index", "source_row", "cells", "fields", "text", "content_type", "manual_edit")
    rows = [{k: r[k] for k in keys if k in r} for r in stored]
    _restore_snapshot(parse_upload(fn, raw), rows)
    metadata = {k: reg.get(k) for k in (
        "source_id", "shop_scopes", "accounts", "platforms", "content_type", "sheet_types",
        "mapping_sha256", "source_snapshot_sha256", "subject_bindings")}
    payload = {"format": "zaapi-kb-source", "version": 1, "filename": fn,
               "source_sha256": source["file_sha256"],
               "source_b64": base64.b64encode(raw).decode("ascii"),
               "metadata": metadata, "rows": rows}
    digest = hashlib.sha256(canonical_json(payload).encode()).hexdigest()
    return canonical_json({**payload, "integrity_sha256": digest}).encode()


def import_package(db, *, data: bytes, shops: list[dict],
                   preview: bool = False, admin: str = "") -> dict:
    from .kb_zaapi_schema import canonical_json
    payload = json.loads(data, object_pairs_hook=_json_object)
    if not isinstance(payload, dict):
        raise ValueError("invalid source package")
    digest = payload.pop("integrity_sha256", None)
    if digest != hashlib.sha256(canonical_json(payload).encode()).hexdigest():
        raise ValueError("package integrity mismatch")
    if payload.get("format") != "zaapi-kb-source" or payload.get("version") != 1:
        raise ValueError("unsupported source package")
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("source_id"), str):
        raise ValueError("source package identity missing")
    scopes = _norm_shop_scopes(metadata.get("shop_scopes"))
    current = {s["key"]: s for s in _norm_shop_scopes(shops)}
    if any(current.get(s["key"]) != s for s in scopes):
        raise ValueError("package shop scope unknown or stale")
    if not isinstance(payload.get("source_b64"), str):
        raise ValueError("source bytes missing")
    raw = base64.b64decode(payload["source_b64"], validate=True)
    if hashlib.sha256(raw).hexdigest() != payload.get("source_sha256"):
        raise ValueError("package source checksum mismatch")
    kw = {"filename": payload.get("filename"), "data": raw,
          "source_id": metadata["source_id"], "shop_scopes": scopes,
          "accounts": metadata.get("accounts") or (),
          "platforms": metadata.get("platforms") or (),
          "content_type": metadata.get("content_type"),
          "sheet_types": metadata.get("sheet_types"),
          "row_snapshot": payload.get("rows"),
          "file_sha256": payload["source_sha256"],
          "mapping_sha256": metadata.get("mapping_sha256"),
          "source_snapshot_sha256": metadata.get("source_snapshot_sha256"),
          "subject_bindings": ({} if metadata.get("subject_bindings") is None
                               else metadata["subject_bindings"])}
    if not isinstance(kw["row_snapshot"], list):
        raise ValueError("row snapshot missing")
    if preview:
        return preview_import(db, **kw)
    return apply_import(db, admin=admin, require_scope=True, **kw)


def export_file(db, *, filename: str, original: bool = False) -> bytes | None:
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
    if original:
        source = db[_SOURCES_COLL].find_one(filt)
        if source is None:
            return None
        raw = bytes(source["data"])
        if hashlib.sha256(raw).hexdigest() != source["file_sha256"]:
            raise ValueError("source checksum mismatch")
        return raw
    rows = list(db[_COLL].find(filt).sort(
        [("row_index", 1), ("sheet", 1)]))
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
        if all(r.get("cells") for r in srows):
            headers = {c["column_index"]: c["header"] for c in srows[0]["cells"]}
            field_columns = {h: col for col, h in headers.items() if h}
            for r in srows:
                if r.get("manual_edit"):
                    for h in r.get("fields") or {}:
                        if h not in field_columns:
                            col = max(headers, default=0) + 1
                            headers[col] = h
                            field_columns[h] = col
            for col, h in headers.items():
                cell = ws.cell(1, col, h)
                cell.data_type = "s"
            for r in srows:
                values = {c["column_index"]: c["value"] for c in r["cells"]}
                if r.get("manual_edit"):
                    values.update({col: (r.get("fields") or {}).get(h, "")
                                   for h, col in field_columns.items()})
                for col, value in values.items():
                    cell = ws.cell(r["source_row"], col, value)
                    cell.data_type = "s"
            continue
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

def bind_preview(db, *, filename: str, rows: int = 0) -> dict:
    """read-only: คอลัมน์ + ค่าตัวอย่างต่อชีต จาก stored source bytes —
    ให้ admin เลือก subject binding โดยไม่ต้อง re-upload (0 writes).
    rows>0 → เพิ่ม grid แถวข้อมูลจริง N แถวแรกต่อชีต + text ดิบของไฟล์ .txt."""
    fn = _valid_filename(filename)
    data = export_file(db, filename=fn, original=True)
    if data is None:
        raise ValueError("no stored source for this file")
    rows = min(max(int(rows or 0), 0), 50)
    docs = parse_upload(fn, data)
    reg = db[_FILES_COLL].find_one({"_id": fn}) or {}
    sheets: dict[str, dict] = {}
    for d in docs:
        s = _sheet_key(d)
        info = sheets.setdefault(
            s, {"rows": 0, "columns": {}, "grid": [], "grid_src": [],
                "text": None})
        info["rows"] += 1
        if rows and d.get("kind") == "text" and info["text"] is None:
            info["text"] = (d.get("text") or "")[:20000]
        for c in d.get("cells") or ():
            col = info["columns"].setdefault(
                c["column_index"], {"header": c["header"], "samples": []})
            v = _clean(c["value"])
            if v and v not in col["samples"] and len(col["samples"]) < 8:
                col["samples"].append(v)
        if rows and len(info["grid"]) < rows and d.get("cells"):
            info["grid"].append([_clean(c["value"]) for c in d["cells"]])
            info["grid_src"].append(d.get("source_row"))

    def _sheet_out(i: dict) -> dict:
        ncol = max(i["columns"]) if i["columns"] else 0
        out = {"rows": i["rows"], "columns": [
            {"column_index": k, "header": v["header"], "samples": v["samples"]}
            for k, v in sorted(i["columns"].items())]}
        if rows:
            out["grid"] = [r + [""] * (ncol - len(r)) for r in i["grid"]]
            out["grid_src"] = i["grid_src"]
            if i["text"] is not None:
                out["text"] = i["text"]
        return out

    return {
        "filename": fn, "active_rev": reg.get("active_rev"),
        "subject_bindings": reg.get("subject_bindings") or {},
        "sheets": {s: _sheet_out(i) for s, i in sheets.items()}}


def bind_apply(db, *, filename: str, subject_bindings, admin: str = "") -> dict:
    """re-bind subjects บน stored source — apply_import rev ใหม่
    (scope/type/source ทั้งหมด inherit จาก registry; {} = ล้าง binding)."""
    fn = _valid_filename(filename)
    data = export_file(db, filename=fn, original=True)
    if data is None:
        raise ValueError("no stored source for this file")
    if not isinstance(subject_bindings, dict):
        raise ValueError("subject_bindings must be a sheet mapping")
    res = apply_import(db, filename=fn, data=data,
                       subject_bindings=subject_bindings, admin=admin)
    if res.get("ok"):
        rev = res.get("rev")
        res["bound_rows"] = db[_COLL].count_documents(
            {"source_file": fn, "file_rev": rev,
             "subject_refs.0": {"$exists": True}})
    return res


def edit_source_apply(db, *, filename: str, patches=None, text=None,
                      admin: str = "") -> dict:
    """แก้ไฟล์ต้นฉบับจากหน้า preview → rev ใหม่ (scope/bindings inherit):
    xlsx = patches {sheet: {row: {col: value}}} ลง stored bytes เดิม
    (cell อื่น/แถวเกิน preview คงเดิม); txt = text ทั้งก้อน."""
    fn = _valid_filename(filename)
    data = export_file(db, filename=fn, original=True)
    if data is None:
        raise ValueError("no stored source for this file")
    suffix = PurePosixPath(fn).suffix.lower()
    ncell = 0
    if suffix == ".txt":
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text required for .txt")
        new_data = text.encode("utf-8")
    else:
        if not isinstance(patches, dict) or not patches:
            raise ValueError("patches {sheet:{row:{col:value}}} required")
        wb = openpyxl.load_workbook(io.BytesIO(data))
        try:
            for sheet, rows in patches.items():
                if sheet not in wb.sheetnames:
                    raise ValueError(f"unknown sheet: {sheet}")
                ws = wb[sheet]
                if not isinstance(rows, dict):
                    raise ValueError("patch rows must be a mapping")
                for r, cols in rows.items():
                    r_i = int(r) if str(r).isdigit() else 0
                    if r_i < 1 or r_i > ws.max_row + 50:
                        raise ValueError(f"bad row index: {r}")
                    if not isinstance(cols, dict):
                        raise ValueError("patch cols must be a mapping")
                    for c, v in cols.items():
                        c_i = int(c) if str(c).isdigit() else 0
                        if c_i < 1 or c_i > ws.max_column + 10:
                            raise ValueError(f"bad column index: {c}")
                        ws.cell(row=r_i, column=c_i).value = v
                        ncell += 1
            if ncell > 5000:
                raise ValueError("too many edited cells")
            buf = io.BytesIO()
            wb.save(buf)
            new_data = buf.getvalue()
        finally:
            wb.close()
    reg = db[_FILES_COLL].find_one({"_id": fn}) or {}
    res = apply_import(db, filename=fn, data=new_data,
                       subject_bindings=reg.get("subject_bindings") or {},
                       admin=admin)
    if res.get("ok"):
        res["edited_cells"] = ncell
    return res


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


_REF_RE_CACHE: dict = {}


def _ref_declared(ref_ns: str, text_low: str, text_ns: str) -> bool:
    """ref (nospace-casefold) ถูกประกาศใน text — 'gs3' ≡ 'g s 3' (space
    ระหว่างตัวอักษร) แต่ 'gs3ultra' ไม่นับเป็น 'gs3' — normalization owner
    เดียวกับ identity refs; text_low=text casefold, text_ns=nospace."""
    if not ref_ns or ref_ns not in text_ns:
        return False
    pat = _REF_RE_CACHE.get(ref_ns)
    if pat is None:
        pat = re.compile(
            r"(?<![a-z0-9])" + r"\s*".join(re.escape(c) for c in ref_ns)
            + r"(?!\s*[a-z0-9])")
        _REF_RE_CACHE[ref_ns] = pat
    return pat.search(text_low) is not None


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
                 include_manual: bool = False,
                 include_unbound: bool = False,
                 extra_terms=()) -> tuple[list[dict], tuple]:
    """ค้น active rows → hits [{a,q,_qa_score,_qa_sim,record_id,meta,...}].

    registry resolve → $or visible pairs (file rows, content_type filter
    ตาม types — แถวไม่จัดชนิดไม่เข้าเส้นทางเฉพาะชนิด) + manual docs
    (kind=manual+active เท่านั้น เมื่อ include_manual; legacy unmigrated
    ห้ามรวม) → Python prefilter (refs boundary-match + trigram
    = ขอบเขตงานเดียว) → lazy-embed cosine บนทุก candidate ที่ผ่าน —
    ไม่ตัด rank ก่อน cosine (แถวที่ถูกต้องทางความหมายห้ามหลุดก่อน rerank;
    cost ผูกกับจำนวน prefilter-admitted ไม่ใช่ cap ตายตัว).

    include_unbound=True → เมื่อ refs ระบุ ให้แถวที่ subject_refs ว่าง
    (ไฟล์ไม่มี binding แต่ digest ยัง verify ผ่าน) อยู่ใน candidate pool
    ด้วย — caller ตัดสิน scope จากเนื้อหาเอง (model/generic/foreign)."""
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
             "unscoped": 1, "active": 1, "cells": 1,
             "subject_refs": 1, "subject_digest": 1, "facts": 1,
             "vec": 1, "vec_model": 1}))
    except Exception:
        return [], ("zaapi_files_read_err",)
    docs = [d for d in docs
            if d.get("source_file")
            or _manual_scope_ok(d, shop, platform)]
    if not docs:
        return [], (f"zaapi_files_empty reg={nreg}",)
    # identity normalization owner เดียวทั้งสองฝั่ง — space-insensitive
    #   casefold ('GS3ULTRA' ≡ 'gs3 ultra'; bound refs เก็บ normalized อยู่แล้ว)
    identity_refs = {"".join(str(r).casefold().split())
                     for r in refs if str(r).strip()}
    if identity_refs:
        docs = [d for d in docs if isinstance(d.get("subject_refs"), list)
                and d.get("subject_digest") == _subject_digest(d)
                and (identity_refs.intersection(
                        "".join(str(s).casefold().split())
                        for s in d["subject_refs"])
                     or (include_unbound and not d["subject_refs"]))]
        if not docs:
            return [], ("zaapi_files_subject_unverified_or_mismatch",)
    ref_l = [str(r).lower() for r in refs if str(r).strip()]
    # exact query substring = ref เดียวกัน (short query เช่น "AC65B" ต้องจับได้)
    qfull = (query or "").strip().lower()
    if len(qfull) >= 4 and qfull not in ref_l:
        ref_l.append(qfull)
    # brand ฯลฯ ที่ไม่ใช่ subject identity — นับ ref_hit ผ่าน prefilter
    # แต่ไม่กรอง bound docs (อยู่นอก identity_refs)
    ref_l += [str(t).strip().lower() for t in extra_terms if str(t).strip()]
    scored: list[tuple[float, dict]] = []
    for d in docs:
        text = d.get("text") or ""
        hay = text.lower()
        if identity_refs and d.get("subject_refs"):
            ref_hits = len(identity_refs.intersection(
                "".join(str(s).casefold().split())
                for s in d["subject_refs"]))
        else:
            # ไม่มี refs หรือ unbound doc — ref ที่ประกาศในเนื้อหา (รวมรูปแบบ
            # เว้นวรรค "gs 3") นับเป็น ref_hit ด้วย — contract เดียวกับ
            # _ref_hit แต่ทน space ภายใน code
            hay_ns = "".join(hay.split())
            ref_hits = sum(
                1 for r in ref_l
                if _ref_hit(r, hay)
                or _ref_declared("".join(r.casefold().split()), hay, hay_ns))
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
        mid = _emb.model_identity()
        sims = [0.0] * len(cands)
        pending = []
        for i, (_, d) in enumerate(cands):
            v = d.get("vec")
            if isinstance(v, list) and v and d.get("vec_model") == mid:
                sims[i] = _cosine(qv, v)
            else:
                pending.append(i)
        if pending:
            tvs = _emb.embed_texts(
                [cands[i][1].get("text") or "" for i in pending])
            for j, i in enumerate(pending):
                sims[i] = _cosine(qv, tvs[j])
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
            "subject_refs": (d.get("subject_refs") or []) if identity_refs else [],
            "facts": (d.get("facts") or []) if identity_refs else [],
        })
    hits.sort(key=lambda h: -h["_qa_sim"])
    return hits[:limit], (
        f"zaapi_files hits={len(hits)} cands={len(cands)} "
        f"docs={len(docs)} reg={nreg}"
        f"{' sim=embed' if sims is not None else ' sim=prefilter'}",)


def backfill_stale_vecs(db, *, embed_texts, mid: str, batch: int = 64,
                        log=print) -> int:
    """embed+$set vec/vec_model เฉพาะแถว active ที่ vec ขาด/ไม่ตรง mid —
    คืนจำนวนแถวที่เขียน; query-time lazy-embed ยังเป็น fallback อยู่
    (derived cache เท่านั้น — ไม่แตะ text/visibility/triple)."""
    pairs, nreg = _visible_pairs(db)
    ors = [dict(p) for p in pairs]
    ors.append({"source_file": {"$exists": False},
                "kind": "manual", "active": {"$ne": False}})
    stale_q = {"$or": [{"vec": {"$exists": False}}, {"vec": None},
                       {"vec_model": {"$ne": mid}}]}
    docs = list(db[_COLL].find(
        {"$and": [{"$or": ors}, stale_q]}, {"text": 1}))
    total = len(docs)
    log(f"zaapi_kb_embeddings: active_files={len(pairs)}/{nreg} "
        f"stale_rows={total}")
    done = 0
    t0 = _time.time()
    for i in range(0, total, batch):
        chunk = docs[i:i + batch]
        vecs = embed_texts([d.get("text") or "" for d in chunk],
                           batch_size=batch)
        for d, v in zip(chunk, vecs):
            db[_COLL].update_one(
                {"_id": d["_id"]},
                {"$set": {"vec": [float(x) for x in v],
                          "vec_model": mid}})
        done += len(chunk)
        log(f"{done}/{total} elapsed={_time.time()-t0:.1f}s")
    log(f"zaapi_kb_embeddings: done rows={done} model={mid}")
    return done


def file_kb_ready(db) -> dict:
    """readiness = active file revision rows ที่ triple registry publish —
    ไม่กรอง scope (readiness = มีข้อมูล active จริง ไม่ใช่ร้านใดค้นได้);
    manual/legacy-unmigrated docs ไม่ทำให้พร้อม (รายงานแยกเพื่อ migration)."""
    regs = list(db[_FILES_COLL].find({}))
    ors = []
    for d in regs:
        if not d.get("active_rev"):
            continue
        if d.get("shop_scopes") is not None:
            try:
                if not _norm_shop_scopes(d["shop_scopes"]):
                    continue
            except ValueError:
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

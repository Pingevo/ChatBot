"use client";
// ZaapiKbPanel — imported Zaapi KB corpus (zaapi_kb) แบบกลุ่ม source + CRUD
// docs ข้างในแก้/ลบ/เปิด-ปิดได้ · แก้แล้ว mark manual_edit (importer ไม่ทับ)
// "เพิ่มในกลุ่มนี้" inherit accounts ของ source (scope เดียวกัน)
// "เพิ่ม" ทั่วไป → unscoped ใช้ได้ทุกร้าน
import { SelectField } from "@/components/ui/SelectField";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { Pagination } from "@/components/ui/Pagination";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { useSearchShortcut, useEscToClear } from "@/lib/useKeyboardShortcuts";
import { toast } from "@/components/ui/Toast";
import { ModalLayer } from "@/components/ui/ModalLayer";
import { MobileAddActions } from "@/components/mobile/MobileAddActions";
import { confirm } from "@/components/ui/ConfirmDialog";
import {
  Search, ChevronDown, Database, Pencil, Trash2, Plus, X, FileSpreadsheet,
  Upload, Download, RotateCcw, Eye,
} from "lucide-react";

type ZaapiSource = {
  source_id: string;
  source_name: string;
  accounts: { id: string; platform: string; name: string }[];
  docs: number;
  active_docs: number;
  zaapi_updated_at?: string;
};

type ZaapiDoc = {
  id: string;
  row_index: number;
  sheet?: string;
  kind: string;
  fields: Record<string, string>;
  text: string;
  source_id?: string;
  source_name?: string;
  source_file?: string;
  active: boolean;
};

// shop scope — คู่ platform|shop_id ที่ผูกไฟล์กับร้านจริง (บังคับก่อน import)
type ShopScope = { platform: string; shop_id: string; shopname: string };

// file-backed source (zaapi_kb_files registry) — filename = identity ตรงทุกตัวอักษร
type ZaapiFile = {
  file: string;
  active_rev: number;
  source_id?: string | null;
  shop_scopes?: ShopScope[] | null;
  disabled?: boolean;
  prev_rev?: number | null;
  rows: number;
  accounts: string[];
  platforms: string[];
  content_type?: string | null;
  sheet_types?: Record<string, string>;
  sheets?: string[];
  type_counts?: Record<string, number>;
  imported_by?: string;
  updated_at?: string;
};

const IMPORT_PLATFORMS = [
  { v: "shopee", l: "Shopee" },
  { v: "lazada", l: "Lazada" },
  { v: "tiktok", l: "TikTok" },
  { v: "facebook", l: "Facebook" },
  { v: "line official", l: "LINE Official" },
];
const TYPE_LABEL: Record<string, string> = {
  product: "สินค้า", troubleshooting: "แก้ปัญหา", faq: "FAQ",
  warranty: "ประกัน", untyped: "ไม่จัดชนิด",
};

type ImportPreview = {
  filename: string; new_rev: number; replaces_rev: number | null;
  old_rows: number; new_rows: number; sheets: Record<string, number>;
  accounts: string[]; platforms: string[]; warnings: string[];
  content_type?: string | null;
  sheet_types?: Record<string, string>;
  sheet_type_map?: Record<string, string>;
  untyped_rows?: number;
  bound_rows?: number;
  unbound_rows?: number;
  sheet_columns?: Record<string, { column_index: number; header: string }[]>;
  subject_samples?: {
    sheet: string; row_index: number;
    subject_refs: string[]; facts: { key: string; value: number }[];
  }[];
};

// subject-binding editor — preview คอลัมน์/ค่าตัวอย่างจาก stored source
type BindRule = {
  columns?: { column_index: number; header: string }[];
  refs?: string[];
  rows?: Record<string, string[]>;
};
type BindPreview = {
  filename: string; active_rev: number;
  subject_bindings: Record<string, BindRule>;
  sheets: Record<string, {
    rows: number;
    columns: { column_index: number; header: string; samples: string[] }[];
    grid?: string[][];  // rows>0 — แถวข้อมูลจริง N แถวแรก (xlsx)
    text?: string;      // rows>0 — เนื้อดิบของไฟล์ .txt
  }>;
};
type BindSheetSel = { mode: "cols" | "refs" | "rows"; cols: number[]; refs: string; rows: string };

// ชนิดเนื้อหาที่ admin เลือก (ห้าม infer จากชื่อไฟล์/ข้อความ)
const CONTENT_TYPES: { v: string; l: string }[] = [
  { v: "", l: "— ไม่จัดชนิด (hold การใช้ตอบ) —" },
  { v: "product", l: "สินค้า" },
  { v: "troubleshooting", l: "วิธีแก้ปัญหา" },
  { v: "faq", l: "คำถามทั่วไป" },
  { v: "warranty", l: "ประกัน" },
];

const PLATFORM_COLORS: Record<string, string> = {
  Shopee: "bg-orange-100 text-orange-700",
  Facebook: "bg-blue-100 text-blue-700",
  Lazada: "bg-sky-100 text-sky-700",
  TikTok: "bg-neutral-800 text-white",
  "LINE Official": "bg-green-100 text-green-700",
};
const PAGE_SIZE = 25;
const FILES_PAGE_SIZE = 10;
const TITLE_COLS = ["รุ่นสินค้า", "ชื่อรุ่นสินค้าย่อ", "คำถามเกี่ยวสินค้า", "คำถาม", "รุ่น", "model"];

function docTitle(d: ZaapiDoc): string {
  for (const c of TITLE_COLS) if (d.fields[c]?.trim()) return d.fields[c].trim();
  const first = Object.values(d.fields).find((v) => v?.trim());
  return (first || d.text || "ไม่มีชื่อ").trim().slice(0, 80);
}

function FilterDropdown({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { v: string; l: string }[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const cur = options.find((o) => o.v === value);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="h-8 px-3 rounded-lg border border-border bg-surface text-xs text-text-muted hover:bg-surface-2 flex items-center gap-1.5"
      >
        {label}: <span className="text-text">{cur?.l || "ทั้งหมด"}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[140px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
          {options.map((o) => (
            <button
              key={o.v}
              onClick={() => { onChange(o.v); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${o.v === value ? "text-brand font-medium" : "text-text"}`}
            >
              {o.l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type EditState = {
  id?: string;
  source_id?: string;
  source_name: string;
  accounts?: { id: string; platform: string; name: string }[];
  fields: { k: string; v: string }[];
  text: string;
};

export function ZaapiKbPanel() {
  const { user } = useAuth();
  const editable = canEditPage(user, "kb");

  const [sources, setSources] = useState<ZaapiSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [pythonToolsAvailable, setPythonToolsAvailable] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("all");
  const [active, setActive] = useState("all");
  const [sortBy, setSortBy] = useState("name");
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const handleSearchEsc = useEscToClear(() => setSearch(""));

  const [docs, setDocs] = useState<ZaapiDoc[]>([]);
  const [docsTotal, setDocsTotal] = useState(0);
  const [docsPage, setDocsPage] = useState(0);
  const [docsLoading, setDocsLoading] = useState(false);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  // ── file-based import (spec v4) ──
  const [files, setFiles] = useState<ZaapiFile[]>([]);
  const [filesPage, setFilesPage] = useState(0);
  const [importing, setImporting] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [imp, setImp] = useState<{
    file: File; platforms: string[]; scopes: ShopScope[];
    contentType: string; sheetTypes: Record<string, string>;
    // per-sheet declared bindings: subject คอลัมน์ + warranty fact คอลัมน์ (optional)
    bindings: Record<string, { subject?: number; warranty?: number }>;
    preview: ImportPreview | null;
  } | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileDocs, setFileDocs] = useState<ZaapiDoc[]>([]);
  const [fileDocsTotal, setFileDocsTotal] = useState(0);
  const [fileDocsPage, setFileDocsPage] = useState(0);
  const [fileDocsLoading, setFileDocsLoading] = useState(false);
  const [kbShops, setKbShops] = useState<{ name: string; platform: string; shop_id: string }[]>([]);
  const [shopPeek, setShopPeek] = useState<string | null>(null);
  const [bind, setBind] = useState<{
    file: string; loading: boolean; saving: boolean;
    data: BindPreview | null; sel: Record<string, BindSheetSel>;
  } | null>(null);


  const loadSources = useCallback(() => {
    api()
      .get("/zaapi-kb", { params: { mode: "sources" } })
      .then((r) => setSources(r.data.sources || []))
      .catch(() => setSources([]))
      .finally(() => setLoading(false));
  }, []);
  const loadFiles = useCallback(() => {
    if (!pythonToolsAvailable) {
      setFiles([]);
      return;
    }
    api()
      .get("/zaapi-kb/files")
      .then((r) => setFiles(r.data.files || []))
      .catch(() => setFiles([]));
  }, [pythonToolsAvailable]);
  const loadMapping = useCallback(() => {
    api()
      .get("/zaapi-kb/mapping")
      .then((r) => setKbShops(r.data.shops || []))
      .catch(() => setKbShops([]));
  }, []);
  useEffect(() => {
    loadSources();
    loadMapping();
    api().get<{ python_tools_available: boolean }>("/system/chat-engine")
      .then((r) => setPythonToolsAvailable(r.data.python_tools_available === true))
      .catch(() => setPythonToolsAvailable(false));
  }, [loadSources, loadMapping]);
  useEffect(() => {
    if (pythonToolsAvailable === true) loadFiles();
    else if (pythonToolsAvailable === false) setFiles([]);
  }, [loadFiles, pythonToolsAvailable]);

  async function doImport(op: "preview" | "apply") {
    if (!pythonToolsAvailable || !imp) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", imp.file);
      fd.append("filename", imp.file.name);
      fd.append("accounts", [...new Set(imp.scopes.map((s) => s.shopname))].join(","));
      fd.append("platforms", [...new Set(imp.scopes.map((s) => s.platform))].join(","));
      fd.append("shop_scopes", JSON.stringify(imp.scopes));
      // registry มี source_id อยู่แล้ว → ส่ง "" ให้ inherit; ไฟล์ใหม่ → identity เฉพาะไฟล์นี้
      const reg = files.find((f) => f.file === imp.file.name);
      fd.append("source_id", reg?.source_id ? "" : `manual:${imp.file.name}`);
      fd.append("content_type", imp.contentType);
      fd.append("sheet_types", JSON.stringify(imp.sheetTypes));
      // declared-subject contract: ส่งเฉพาะชีตที่เลือกคอลัมน์สินค้า —
      // warranty fact ผูกแถวเดียวกัน ไม่เลือก = ไม่ส่ง fact (ยังตอบจาก text ได้)
      const sb: Record<string, unknown> = {};
      for (const [sheet, cols] of Object.entries(imp.preview?.sheet_columns || {})) {
        const sel = imp.bindings[sheet];
        if (!sel?.subject) continue;
        const scol = cols.find((c) => c.column_index === sel.subject);
        if (!scol) continue;
        const rule: Record<string, unknown> = {
          columns: [{ column_index: scol.column_index, header: scol.header }],
        };
        if (sel.warranty) {
          const wcol = cols.find((c) => c.column_index === sel.warranty);
          if (wcol) rule.facts = { warranty: { column_index: wcol.column_index, header: wcol.header } };
        }
        sb[sheet] = rule;
      }
      if (Object.keys(sb).length) fd.append("subject_bindings", JSON.stringify(sb));
      const r = await api().post(`/zaapi-kb/import?op=${op}`, fd);
      if (op === "preview") {
        // resolved types (registry-inherited + ที่เลือก) → prefill pickers
        setImp({
          ...imp,
          contentType: imp.contentType || (r.data?.content_type ?? ""),
          sheetTypes: { ...(r.data?.sheet_types || {}), ...imp.sheetTypes },
          preview: r.data,
        });
      } else if (r.data?.ok) {
        if (r.data.warning) {
          toast.warning(`นำเข้า ${r.data.file} rev ${r.data.rev} สำเร็จ แต่ขั้นตอนหลัง publish มีปัญหา: ${r.data.warning}`);
        } else {
          toast.success(`นำเข้า ${r.data.file} rev ${r.data.rev} (${r.data.rows} แถว)`);
        }
        setImp(null);
        loadFiles();
        loadSources();
      } else {
        toast.error(r.data?.conflict ? "มีการนำเข้าพร้อมกัน — ลองใหม่" : "นำเข้าไม่สำเร็จ");
      }
    } catch (e) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(`นำเข้าไม่สำเร็จ${d ? ` — ${d}` : ""}`);
    } finally {
      setImporting(false);
    }
  }

  async function downloadSnapshot() {
    setSnapshotting(true);
    try {
      const response = await fetch("/api/zaapi-kb/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const lines = text.split("\n");
      if (!text.endsWith("\n") || lines.length < 3 || lines[lines.length - 1] !== "")
        throw new Error("incomplete snapshot");
      const header = JSON.parse(lines[0]);
      const footer = JSON.parse(lines[lines.length - 2]);
      const collections = ["zaapi_kb", "zaapi_kb_files", "zaapi_kb_import_log"];
      const collectionNames = header.collection_names || {};
      const resolvedNames = Object.values(collectionNames);
      if (header.kind !== "header" || header.format !== "zaapi-kb-snapshot" || header.version !== 1
          || JSON.stringify(header.collections) !== JSON.stringify(collections)
          || Object.keys(collectionNames).sort().join(",") !== [...collections].sort().join(",")
          || resolvedNames.some((name) => typeof name !== "string" || !name.trim())
          || new Set(resolvedNames).size !== collections.length
          || footer.kind !== "footer" || footer.complete !== true
          || Object.keys(footer.counts || {}).sort().join(",") !== [...collections].sort().join(",")
          || Object.keys(footer.sha256 || {}).sort().join(",") !== [...collections].sort().join(","))
        throw new Error("invalid snapshot footer");

      const filename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1]
        || "zaapi-kb-snapshot.ndjson";
      const blob = new Blob([bytes], { type: response.headers.get("content-type") || "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("ดาวน์โหลด snapshot แล้ว — ตรวจ digest ก่อน reconcile");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      toast.error(`ดาวน์โหลด snapshot ไม่สำเร็จหรือไฟล์ไม่ครบ (${detail})`);
    } finally {
      setSnapshotting(false);
    }
  }

  const [toggling, setToggling] = useState<string | null>(null);
  async function doToggleFile(f: ZaapiFile) {
    if (!pythonToolsAvailable) return;
    const next = !!f.disabled;
    if (!(await confirm.ask({
      title: next ? `เปิดใช้ ${f.file}?` : `ปิดใช้ ${f.file}?`,
      message: next
        ? "แถวของไฟล์จะกลับมาใช้ตอบตาม scope เดิมทันที"
        : "แถวของไฟล์จะถูก hold ไม่ใช้ตอบ (ข้อมูลไม่หาย เปิดกลับได้)",
      variant: next ? "primary" : "danger",
    }))) return;
    setToggling(f.file);
    try {
      const r = await api().post("/zaapi-kb/files", null, {
        params: { file: f.file, enabled: next },
      });
      if (r.data?.ok) {
        toast.success(next ? `เปิดใช้ ${f.file}` : `ปิดใช้ ${f.file}`);
        loadFiles();
      } else {
        toast.error(r.data?.detail || r.data?.error || "เปลี่ยนสถานะไม่สำเร็จ");
      }
    } catch {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ");
    } finally {
      setToggling(null);
    }
  }

  async function doExport(f: ZaapiFile) {
    if (!pythonToolsAvailable) return;
    try {
      const r = await api().get("/zaapi-kb/export", {
        params: { file: f.file }, responseType: "blob",
      });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url; a.download = f.file; a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Export ไม่สำเร็จ");
    }
  }

  async function doRollback(f: ZaapiFile) {
    if (!pythonToolsAvailable) return;
    if (!(await confirm.ask({ title: `Rollback ${f.file} กลับ rev ${f.prev_rev ?? "?"}?`, variant: "danger" }))) return;
    try {
      const r = await api().post(`/zaapi-kb/import?op=rollback&file=${encodeURIComponent(f.file)}`);
      if (r.data?.ok) {
        if (r.data.warning) toast.warning(`Rollback → rev ${r.data.rev} แต่: ${r.data.warning}`);
        else toast.success(`Rollback → rev ${r.data.rev}`);
        loadFiles();
      }
      else toast.error("Rollback ไม่ได้ — " + (r.data?.reason || "error"));
    } catch {
      toast.error("Rollback ไม่สำเร็จ");
    }
  }

  // ── subject-binding editor (ใช้ stored source — ไม่ต้อง re-upload) ──
  async function openBind(f: ZaapiFile) {
    if (!pythonToolsAvailable) return;
    if (bind?.file === f.file) { setBind(null); return; }
    setBind({ file: f.file, loading: true, saving: false, data: null, sel: {} });
    try {
      const r = await api().get("/zaapi-kb/bind", { params: { file: f.file } });
      const data = r.data as BindPreview;
      const sel: Record<string, BindSheetSel> = {};
      for (const [sheet, rule] of Object.entries(data.subject_bindings || {})) {
        if (rule.columns?.length)
          sel[sheet] = { mode: "cols", cols: rule.columns.map((c) => c.column_index), refs: "", rows: "" };
        else if (rule.refs?.length)
          sel[sheet] = { mode: "refs", cols: [], refs: rule.refs.join(", "), rows: "" };
        else if (rule.rows && Object.keys(rule.rows).length)
          sel[sheet] = { mode: "rows", cols: [], refs: "", rows: JSON.stringify(rule.rows) };
      }
      setBind({ file: f.file, loading: false, saving: false, data, sel });
    } catch {
      toast.error("โหลด binding preview ไม่สำเร็จ");
      setBind(null);
    }
  }

  function setSel(sheet: string, patch: Partial<BindSheetSel>) {
    if (!bind) return;
    const cur = bind.sel[sheet] || { mode: "cols" as const, cols: [], refs: "", rows: "" };
    setBind({ ...bind, sel: { ...bind.sel, [sheet]: { ...cur, ...patch } } });
  }

  async function saveBind() {
    if (!pythonToolsAvailable || !bind) return;
    const sb: Record<string, BindRule> = {};
    const headers = (s: string, i: number) =>
      bind.data?.sheets[s]?.columns.find((c) => c.column_index === i)?.header || "";
    try {
      for (const [sheet, sel] of Object.entries(bind.sel)) {
        if (sel.mode === "cols" && sel.cols.length)
          sb[sheet] = { columns: sel.cols.map((i) => ({ column_index: i, header: headers(sheet, i) })) };
        else if (sel.mode === "refs" && sel.refs.trim())
          sb[sheet] = { refs: sel.refs.split(",").map((x) => x.trim()).filter(Boolean) };
        else if (sel.mode === "rows" && sel.rows.trim())
          sb[sheet] = { rows: JSON.parse(sel.rows) };
      }
    } catch {
      toast.error("rows JSON ไม่ถูกต้อง");
      return;
    }
    setBind({ ...bind, saving: true });
    try {
      const r = await api().post(`/zaapi-kb/bind?file=${encodeURIComponent(bind.file)}`,
        { subject_bindings: sb });
      if (r.data?.ok) {
        toast.success(`Bind → rev ${r.data.rev} · ผูก ${r.data.bound_rows ?? "?"} แถว`);
        setBind(null);
        loadFiles();
      } else toast.error("Bind ไม่สำเร็จ — " + (r.data?.reason || r.data?.detail || "error"));
    } catch (e: any) {
      toast.error("Bind ไม่สำเร็จ — " + (e?.response?.data?.detail || "error"));
      setBind({ ...bind, saving: false });
    }
  }

  function loadFileDocs(file: string, page: number) {
    setFileDocsLoading(true);
    api().get("/zaapi-kb", {
      params: {
        mode: "docs", source_file: file,
        skip: page * PAGE_SIZE, limit: PAGE_SIZE,
      },
    })
      .then((r) => {
        setFileDocs(r.data.docs || []);
        setFileDocsTotal(r.data.total || 0);
      })
      .catch(() => { setFileDocs([]); setFileDocsTotal(0); })
      .finally(() => setFileDocsLoading(false));
  }

  function toggleFileDoc(f: ZaapiFile) {
    if (openFile === f.file) { setOpenFile(null); return; }
    setOpenFile(f.file);
    setFileDocsPage(0);
    loadFileDocs(f.file, 0);
  }

  const loadDocs = useCallback((sourceId: string, page: number) => {
    setDocsLoading(true);
    api()
      .get("/zaapi-kb", {
        params: {
          mode: "docs", source_id: sourceId,
          q: search || undefined,
          active: active !== "all" ? active : undefined,
          skip: page * PAGE_SIZE, limit: PAGE_SIZE,
        },
      })
      .then((r) => { setDocs(r.data.docs || []); setDocsTotal(r.data.total || 0); })
      .catch(() => { setDocs([]); setDocsTotal(0); })
      .finally(() => setDocsLoading(false));
  }, [search, active]);

  function toggleSource(id: string) {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    setDocsPage(0);
    loadDocs(id, 0);
  }

  // filter เปลี่ยน → reload docs ของ source ที่เปิดอยู่
  useEffect(() => {
    if (openId) { setDocsPage(0); loadDocs(openId, 0); }
  }, [search, active]); // eslint-disable-line react-hooks/exhaustive-deps

  function openEditDoc(d: ZaapiDoc, s: ZaapiSource) {
    setEdit({
      id: d.id,
      source_id: s.source_id,
      source_name: s.source_name,
      accounts: s.accounts,
      fields: Object.entries(d.fields).map(([k, v]) => ({ k, v })),
      text: d.text,
    });
  }

  function openCreate(s?: ZaapiSource) {
    setEdit({
      source_id: s?.source_id,
      source_name: s?.source_name || "เพิ่มเอง",
      accounts: s?.accounts,
      fields: [{ k: "", v: "" }],
      text: "",
    });
  }

  async function saveEdit() {
    if (!edit) return;
    const fields = Object.fromEntries(
      edit.fields.filter((f) => f.k.trim() && f.v.trim()).map((f) => [f.k.trim(), f.v.trim()]));
    setSaving(true);
    try {
      if (edit.id) {
        await api().patch(`/zaapi-kb/${edit.id}`, {
          source_name: edit.source_name, fields, text: edit.text,
        });
        toast.success("บันทึกแล้ว");
      } else {
        await api().post("/zaapi-kb", {
          source_id: edit.source_id,
          source_name: edit.source_name,
          accounts: edit.accounts || [],
          unscoped: !edit.source_id,
          fields, text: edit.text,
        });
        toast.success("เพิ่มรายการแล้ว");
      }
      const openSource = edit.source_id;
      setEdit(null);
      if (openId === openSource) loadDocs(openSource, docsPage);
      loadSources();
    } catch {
      toast.error("บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(d: ZaapiDoc) {
    try {
      await api().patch(`/zaapi-kb/${d.id}`, { active: !d.active });
      setDocs((ds) => ds.map((x) => x.id === d.id ? { ...x, active: !d.active } : x));
      loadSources();
    } catch {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  async function removeDoc(d: ZaapiDoc, s: ZaapiSource) {
    if (!(await confirm.ask({ title: `ลบ "${docTitle(d)}" ?`, variant: "danger" }))) return;
    try {
      await api().delete(`/zaapi-kb/${d.id}`);
      toast.success("ลบแล้ว");
      loadDocs(s.source_id, docsPage);
      loadSources();
    } catch {
      toast.error("ลบไม่สำเร็จ");
    }
  }

  // platform → shops group (import modal — เลือก platform ก่อนแล้วร้านตาม platform)
  const impShopGroups = (() => {
    const byPlat = new Map<string, { name: string; shop_id: string }[]>();
    for (const s of kbShops) {
      const k = s.platform || "other";
      if (!byPlat.has(k)) byPlat.set(k, []);
      byPlat.get(k)!.push({ name: s.name, shop_id: s.shop_id });
    }
    const order = IMPORT_PLATFORMS.map((p) => p.v);
    return [...byPlat.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
      })
      .map(([plat, shops]) => ({
        plat,
        label: IMPORT_PLATFORMS.find((p) => p.v === plat)?.l || plat || "other",
        shops,
      }));
  })();

  // เปิด import modal — prefill scope จาก registry เดิมถ้าไฟล์ชื่อซ้ำ (re-import ไม่ต้องแมปใหม่)
  function openImport(f: File) {
    if (!pythonToolsAvailable) return;
    const reg = files.find((x) => x.file === f.name);
    const scopes: ShopScope[] = (reg?.shop_scopes || []).map(
      ({ platform, shop_id, shopname }) => ({ platform, shop_id, shopname }));
    setImp({
      file: f,
      platforms: [...new Set(scopes.map((s) => s.platform))],
      scopes,
      contentType: reg?.content_type || "",
      sheetTypes: reg?.sheet_types || {},
      bindings: {},
      preview: null,
    });
  }

  const filtered = sources
    .filter((s) => {
      if (platform !== "all" && !s.accounts.some((a) => a.platform === platform)) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        (s.source_name || "").toLowerCase().includes(q) ||
        s.accounts.some((a) => a.name.toLowerCase().includes(q) || a.platform.toLowerCase().includes(q))
      );
    })
    .sort((a, b) =>
      sortBy === "recent"
        ? (b.zaapi_updated_at || "").localeCompare(a.zaapi_updated_at || "")
        : (a.source_name || "").localeCompare(b.source_name || ""));

  const importModal = imp && (

        <ModalLayer presentation="workspace" className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setImp(null)} onBack={() => { if (importing) return false; setImp(null); return true; }}>
          <div role="dialog" aria-modal="true" aria-label="นำเข้าไฟล์ Zaapi KB" className="bg-surface rounded-2xl border border-border shadow-xl w-full max-w-lg flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="text-sm font-semibold text-text">Import ไฟล์เข้า Zaapi KB</div>
              <button onClick={() => setImp(null)} className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center" aria-label="ปิด">
                <X size={15} className="text-text-muted" />
              </button>
            </div>
            <div className="mobile-workspace-body px-5 py-4 space-y-3 text-xs">
              <div>
                <label className="text-text-muted block mb-1">ไฟล์ (ชื่อตรงทุกตัวอักษร = แหล่งเดิม → แทนทั้งชุด)</label>
                <div className="font-mono text-text">{imp.file.name}</div>
              </div>
              <div>
                <label className="text-text-muted block mb-1">Platform (เลือกเพื่อกรองรายชื่อร้าน)</label>
                <div className="flex gap-1.5 flex-wrap">
                  {IMPORT_PLATFORMS.map((p) => (
                    <button
                      key={p.v}
                      onClick={() => setImp({
                        ...imp,
                        platforms: imp.platforms.includes(p.v)
                          ? imp.platforms.filter((x) => x !== p.v)
                          : [...imp.platforms, p.v],
                      })}
                      className={`px-2 py-1 rounded-lg border text-[11px] ${imp.platforms.includes(p.v) ? "border-brand bg-brand/10 text-brand" : "border-border text-text-muted"}`}
                    >
                      {p.l}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-text-muted block mb-1">ร้านที่ไฟล์นี้เป็นของ * (ต้องเลือกอย่างน้อย 1 — ไฟล์ที่ไม่ผูกร้านจะ import ไม่ได้)</label>
                {imp.scopes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {imp.scopes.map((s) => (
                      <button
                        key={`${s.platform}|${s.shop_id}`}
                        onClick={() => setImp({
                          ...imp,
                          scopes: imp.scopes.filter(
                            (x) => !(x.platform === s.platform && x.shop_id === s.shop_id)),
                        })}
                        className="px-2 py-0.5 rounded-lg border border-brand bg-brand/10 text-brand text-[11px]"
                        title="กดเพื่อเอาร้านนี้ออก"
                      >
                        {s.shopname} · {s.platform} ✕
                      </button>
                    ))}
                  </div>
                )}
                {!imp.platforms.length ? (
                  <div className="text-text-subtle text-[11px]">เลือก platform ก่อนเพื่อดูรายชื่อร้าน</div>
                ) : (
                  <div className="max-h-36 overflow-y-auto space-y-1.5">
                    {impShopGroups
                      .filter((g) => imp.platforms.includes(g.plat))
                      .map((g) => (
                        <div key={g.plat}>
                          <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wide">{g.label}</div>
                          <div className="flex flex-col gap-0.5">
                            {g.shops.map((s) => {
                              const on = imp.scopes.some(
                                (x) => x.platform === g.plat && x.shop_id === s.shop_id);
                              return (
                                <label key={s.shop_id}
                                  className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 cursor-pointer ${on ? "bg-brand/10" : "hover:bg-surface-2"}`}>
                                  <input type="checkbox" className="accent-brand" checked={on}
                                    onChange={() => setImp({
                                      ...imp,
                                      scopes: on
                                        ? imp.scopes.filter(
                                            (x) => !(x.platform === g.plat && x.shop_id === s.shop_id))
                                        : [...imp.scopes, {
                                            platform: g.plat, shop_id: s.shop_id, shopname: s.name }],
                                    })} />
                                  <span>{s.name} <span className="text-text-subtle">({s.shop_id})</span></span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
                {!imp.scopes.length && (
                  <div className="text-warning mt-1 text-[11px]">
                    ยังไม่ได้เลือกร้าน — import จะถูกปฏิเสธจนกว่าจะระบุว่าไฟล์นี้เป็นของร้านไหน
                  </div>
                )}
              </div>
              <div>
                <label className="text-text-muted block mb-1">ชนิดเนื้อหาของไฟล์ (admin เลือกเอง — แถวที่ไม่จัดชนิดจะถูก hold การใช้ตอบ)</label>
                <SelectField
                  value={imp.contentType}
                  onChange={(e) => setImp({ ...imp, contentType: e.target.value })}
                  className="w-full h-8 px-2 rounded-lg border border-border bg-surface text-xs focus:outline-none focus:ring-2 focus:ring-brand/40"
                >
                  {CONTENT_TYPES.map((t) => (
                    <option key={t.v} value={t.v}>{t.l}</option>
                  ))}
                </SelectField>
              </div>
              {imp.preview && (
                <div className="rounded-lg border border-border bg-surface-2/60 p-3 space-y-2">
                  <div className="font-medium">Preview — rev {imp.preview.new_rev}</div>
                  <div className="text-text-muted">
                    {imp.preview.new_rows} แถวใหม่
                    {imp.preview.replaces_rev ? ` · แทน rev ${imp.preview.replaces_rev} (${imp.preview.old_rows} แถว)` : " · แหล่งใหม่"}
                  </div>
                  <div className="text-text-muted">
                    sheet: {Object.entries(imp.preview.sheets).map(([s, n]) =>
                      `${s} (${n})=${imp.preview?.sheet_type_map?.[s] ?? "ไม่ระบุ"}`).join(", ")}
                  </div>
                  {(imp.preview.untyped_rows ?? 0) > 0 && (
                    <div className="text-warning">
                      {imp.preview.untyped_rows} แถวยังไม่จัดชนิด — จะถูก hold การใช้ตอบ
                    </div>
                  )}
                  <div className="space-y-1">
                    {Object.keys(imp.preview.sheets).map((s) => (
                      <div key={s} className="flex items-center gap-2">
                        <span className="w-40 truncate text-text-muted" title={s}>{s}</span>
                        <SelectField
                          value={imp.sheetTypes[s] ?? ""}
                          onChange={(e) => setImp({
                            ...imp,
                            sheetTypes: e.target.value
                              ? { ...imp.sheetTypes, [s]: e.target.value }
                              : Object.fromEntries(Object.entries(imp.sheetTypes).filter(([k]) => k !== s)),
                          })}
                          className="flex-1 h-7 px-2 rounded-lg border border-border bg-surface text-[11px] focus:outline-none focus:ring-2 focus:ring-brand/40"
                        >
                          {CONTENT_TYPES.map((t) => (
                            <option key={t.v} value={t.v}>{t.l}</option>
                          ))}
                        </SelectField>
                      </div>
                    ))}
                  </div>
                  {imp.preview.sheet_columns && Object.keys(imp.preview.sheet_columns).length > 0 && (
                    <div className="space-y-1.5 border-t border-border pt-2">
                      <div className="text-text-muted">
                        เลือกคอลัมน์ที่ระบุสินค้าของแถว (declared subject — ไม่เลือก = ไม่ผูกรุ่น ใช้ตอบทั่วไปอย่างเดียว)
                      </div>
                      {Object.entries(imp.preview.sheet_columns).map(([s, cols]) => {
                        const sel = imp.bindings[s] || {};
                        const setSel = (k: "subject" | "warranty", v: number) => setImp({
                          ...imp,
                          bindings: {
                            ...imp.bindings,
                            [s]: { ...sel, [k]: v || undefined },
                          },
                        });
                        const colOpts = [
                          <option key={0} value="">— ไม่ผูก —</option>,
                          ...cols.map((c) => (
                            <option key={c.column_index} value={c.column_index}>
                              {c.column_index}: {c.header || "(ไม่มีหัว)"}
                            </option>
                          )),
                        ];
                        return (
                          <div key={s} className="rounded border border-border/60 p-2 space-y-1">
                            <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wide truncate" title={s}>{s}</div>
                            <div className="flex items-center gap-2">
                              <span className="w-24 text-text-subtle">คอลัมน์สินค้า</span>
                              <select
                                value={sel.subject ?? ""}
                                onChange={(e) => setSel("subject", Number(e.target.value) || 0)}
                                className="flex-1 h-7 px-2 rounded-lg border border-border bg-surface text-[11px] focus:outline-none focus:ring-2 focus:ring-brand/40"
                              >
                                {colOpts}
                              </select>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-24 text-text-subtle">คอลัมน์ประกัน</span>
                              <select
                                value={sel.warranty ?? ""}
                                onChange={(e) => setSel("warranty", Number(e.target.value) || 0)}
                                disabled={!sel.subject}
                                className="flex-1 h-7 px-2 rounded-lg border border-border bg-surface text-[11px] focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:opacity-40"
                              >
                                {colOpts}
                              </select>
                            </div>
                          </div>
                        );
                      })}
                      <div className="text-text-muted">
                        ผูกแล้ว {imp.preview.bound_rows ?? 0} แถว · ไม่ผูก {imp.preview.unbound_rows ?? 0} แถว
                        {(imp.preview.subject_samples || []).some((x) => x.facts?.length) && (
                          <span> · พบ warranty fact {(imp.preview.subject_samples || []).filter((x) => x.facts?.length).length} แถวแรก</span>
                        )}
                      </div>
                      <Button size="sm" variant="outline" onClick={() => doImport("preview")} disabled={importing}>
                        {importing ? "กำลังตรวจ..." : "อัปเดต Preview ตามที่เลือก"}
                      </Button>
                    </div>
                  )}
                  {imp.preview.warnings.map((w, i) => (
                    <div key={i} className="text-warning">{w}</div>
                  ))}
                </div>
              )}
            </div>
            <div className="mobile-workspace-actions flex justify-end gap-2 px-5 py-3 border-t border-border">
              <Button size="sm" variant="outline" onClick={() => setImp(null)}>ยกเลิก</Button>
              {!imp.preview ? (
                <Button size="sm" onClick={() => doImport("preview")} disabled={importing}>
                  {importing ? "กำลังตรวจ..." : "Preview"}
                </Button>
              ) : (
                <Button size="sm" onClick={() => doImport("apply")} disabled={importing || !imp.scopes.length}>
                  {importing ? "กำลังนำเข้า..." : "ยืนยัน Import"}
                </Button>
              )}
            </div>
          </div>
        </ModalLayer>

  );

  const mobileAddActions = editable ? [
    { label: "เพิ่มเอกสาร", icon: <Plus size={17} />, onSelect: () => openCreate() },
    ...(pythonToolsAvailable ? [{ label: "Import ไฟล์", icon: <Upload size={17} />, onSelect: () => document.getElementById("zaapi-file-input")?.click() }] : []),
  ] : [];

  if (loading || pythonToolsAvailable === null) return <div className="flex justify-center py-12"><Loading size={24} /></div>;
  if (sources.length === 0 && files.length === 0 && !imp)
    return (
      <div className="zaapi-kb-mobile-add-space space-y-3 pb-20 md:pb-0">
        {pythonToolsAvailable === false && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-muted">
            รายการไฟล์, Import, Export, Rollback และการผูกรุ่นต้องใช้ Python engine; เลือก legacy/v2/v3 เพื่อใช้งานส่วนนี้
          </div>
        )}
        {editable && (
          <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={downloadSnapshot} disabled={snapshotting}>
              <Download size={14} /> {snapshotting ? "กำลังสำรอง..." : "Backup snapshot"}
            </Button>
            {pythonToolsAvailable && <div className="hidden md:block">
              <Button size="sm" className="phone-mobile-add-hidden" onClick={() => document.getElementById("zaapi-file-input")?.click()}>
                <Upload size={14} /> Import ไฟล์
              </Button>
            </div>}
            <input
              id="zaapi-file-input" type="file" accept=".xlsx,.txt" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && pythonToolsAvailable) openImport(f);
                e.target.value = "";
              }}
            />
          </div>
        )}
        <MobileAddActions actions={mobileAddActions} />
        <EmptyState icon={Database} title="ยังไม่มี Zaapi KB" description="Import ไฟล์ .xlsx/.txt หรือสร้างเอกสาร manual" />
        {imp && importModal}
      </div>
    );

  return (
    <div className="zaapi-kb-mobile-add-space space-y-3 pb-20 md:pb-0">
      <MobileAddActions actions={mobileAddActions} />
      {pythonToolsAvailable === false && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-muted">
          รายการไฟล์, Import, Export, Rollback และการผูกรุ่นต้องใช้ Python engine; เลือก legacy/v2/v3 เพื่อใช้งานส่วนนี้
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="text"
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchEsc}
            placeholder="ค้นหา source / ร้านค้า / platform..."
            className="w-full h-8 pl-8 pr-8 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
          />
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-text-subtle border border-border rounded px-1 py-0.5 pointer-events-none">/</kbd>
        </div>
        <FilterDropdown label="แพลตฟอร์ม" value={platform}
          options={[{ v: "all", l: "ทั้งหมด" }, ...Object.keys(PLATFORM_COLORS).map((p) => ({ v: p, l: p }))]}
          onChange={setPlatform} />
        <FilterDropdown label="สถานะ" value={active}
          options={[{ v: "all", l: "ทั้งหมด" }, { v: "active", l: "เปิดใช้" }, { v: "inactive", l: "ปิดใช้" }]}
          onChange={setActive} />
        <FilterDropdown label="เรียง" value={sortBy}
          options={[{ v: "name", l: "ชื่อ source" }, { v: "recent", l: "อัปเดตล่าสุด" }]}
          onChange={setSortBy} />
        <span className="text-xs text-text-muted ml-auto">{filtered.length}/{sources.length} sources</span>
        <div className="flex items-center gap-2">
          {editable && (
            <Button size="sm" variant="outline" className="phone-mobile-add-hidden" onClick={() => openCreate()}>
              <Plus size={14} /> เพิ่ม (ทุกร้าน)
            </Button>
          )}
          {editable && (
            <Button size="sm" variant="outline" onClick={downloadSnapshot} disabled={snapshotting}>
              <Download size={14} /> {snapshotting ? "กำลังสำรอง..." : "Backup snapshot"}
            </Button>
          )}
          {editable && pythonToolsAvailable && (
            <Button size="sm" className="phone-mobile-add-hidden" onClick={() => document.getElementById("zaapi-file-input")?.click()}>
              <Upload size={14} /> Import ไฟล์
            </Button>
          )}
        </div>
        <input
          id="zaapi-file-input" type="file" accept=".xlsx,.txt" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && pythonToolsAvailable) openImport(f);
            e.target.value = "";
          }}
        />
      </div>

      {/* file-based sources (import ตรงจากไฟล์ — filename = identity) */}
      {files.length > 0 && (() => {
        const pageCount = Math.ceil(files.length / FILES_PAGE_SIZE);
        const page = Math.min(filesPage, pageCount - 1);
        const pageFiles = files.slice(page * FILES_PAGE_SIZE, (page + 1) * FILES_PAGE_SIZE);
        return (
        <div className="border border-border rounded-xl divide-y divide-border bg-surface">
          <div className="px-4 py-2 text-[11px] font-medium text-text-subtle bg-surface-2 rounded-t-xl flex items-center justify-between gap-2">
            <span>ไฟล์นำเข้า ({files.length}) — ชื่อไฟล์เดิมแทนทั้งชุด · Export เป็น Excel{pageCount > 1 ? ` · หน้า ${page + 1}/${pageCount}` : ""}</span>
            {editable && pythonToolsAvailable && (
              <button
                onClick={async () => {
                  try {
                    const r = await api().post("/zaapi-kb/import?op=sweep");
                    toast.success(`Sweep ลบแถวหมดอายุ ${r.data?.deleted ?? 0} แถว`);
                    loadFiles();
                  } catch { toast.error("Sweep ไม่สำเร็จ"); }
                }}
                className="text-[10px] text-text-muted hover:text-text hover:underline"
                title="ลบแถว staged/retired ที่หมด grace (ไม่แตะ revision ที่ใช้งาน)"
              >
                Sweep expired
              </button>
            )}
          </div>
          {pageFiles.map((f) => (
            <div key={f.file} className={f.disabled ? "opacity-60" : ""}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <button onClick={() => toggleFileDoc(f)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                  <ChevronDown size={14} className={`text-text-subtle transition-transform ${openFile === f.file ? "" : "-rotate-90"}`} />
                  <FileSpreadsheet size={14} className="text-text-subtle shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-text truncate">{f.file}</div>
                    <div className="text-[11px] text-text-subtle mt-0.5 truncate">
                      {f.disabled ? "ปิดอยู่ · " : ""}rev {f.active_rev} · {f.rows} แถว
                      {f.sheets?.length ? ` · ${f.sheets.length} sheets` : ""}
                      {Object.keys(f.type_counts || {}).length > 0 &&
                        ` · ${Object.entries(f.type_counts || {}).map(([t, n]) => `${TYPE_LABEL[t] || t} ${n}`).join(" · ")}`}
                      {f.platforms.length ? ` · ${f.platforms.length} platform` : ""}
                      {f.updated_at ? ` · ${new Date(f.updated_at).toLocaleDateString("th-TH")}` : ""}
                    </div>
                    {shopPeek === f.file && f.accounts.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {f.accounts.map((a) => (
                          <span key={a} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{a}</span>
                        ))}
                      </div>
                    )}
                    {(f.content_type || Object.keys(f.sheet_types || {}).length > 0) && (
                      <div className="text-[10px] text-text-subtle mt-0.5 truncate">
                        ชนิด: {f.content_type || "—"}
                        {Object.entries(f.sheet_types || {}).map(([s, t]) => ` · ${s}=${t}`).join("")}
                      </div>
                    )}
                  </div>
                </button>
                <button type="button"
                  className="text-[11px] text-accent hover:underline shrink-0"
                  onClick={() => setShopPeek(shopPeek === f.file ? null : f.file)}>
                  {f.accounts.length ? `${f.accounts.length} ร้าน` : "ทุกร้าน"}
                </button>
                {f.disabled && <Badge tone="warning">ปิดอยู่</Badge>}
                {editable && pythonToolsAvailable && (
                  <span title={f.disabled ? "เปิดใช้ไฟล์นี้" : "ปิดใช้ไฟล์นี้"}>
                    <ToggleSwitch size="sm" enabled={!f.disabled}
                      disabled={toggling === f.file}
                      onChange={() => doToggleFile(f)} />
                  </span>
                )}
                {pythonToolsAvailable && <a
                  href={`/zaapi-preview?file=${encodeURIComponent(f.file)}`}
                  className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
                  title="พรีวิว/แก้ไฟล์ต้นฉบับ" aria-label="Preview source">
                  <Eye size={13} className="text-text-muted" />
                </a>}
                {pythonToolsAvailable && <button onClick={() => doExport(f)} className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center" title="Export xlsx" aria-label="Export">
                  <Download size={13} className="text-text-muted" />
                </button>}
                {editable && pythonToolsAvailable && f.prev_rev != null && (
                  <button onClick={() => doRollback(f)} className="w-7 h-7 rounded-md hover:bg-error-soft flex items-center justify-center" title={`Rollback → rev ${f.prev_rev}`} aria-label="Rollback">
                    <RotateCcw size={13} className="text-text-muted" />
                  </button>
                )}
              </div>
              {openFile === f.file && (
                <div className="border-t border-border bg-surface-2/50 px-4 py-3">
                  {editable && pythonToolsAvailable && (
                    <div className="mb-3 rounded-lg border border-border/60 bg-surface px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] text-text-subtle">
                          Subject bindings — ผูกแถวกับรุ่น/สินค้า (คำถามเจาะรุ่นจะตอบได้ก็ต่อเมื่อผูกแล้ว)
                        </div>
                        <Button size="sm" variant="outline" onClick={() => openBind(f)}>
                          {bind?.file === f.file ? "ปิด" : "ตั้งค่าผูกรุ่น"}
                        </Button>
                      </div>
                      {bind?.file === f.file && (
                        <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                          {bind.loading ? (
                            <div className="flex justify-center py-3"><Loading size={16} /></div>
                          ) : bind.data ? (
                            <>
                              {Object.entries(bind.data.sheets).map(([s, info]) => {
                                const sel = bind.sel[s] || { mode: "cols" as const, cols: [], refs: "", rows: "" };
                                const headerOf = (i: number) => info.columns.find((c) => c.column_index === i)?.header || "";
                                return (
                                  <div key={s} className="rounded border border-border/60 p-2 space-y-1.5">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wide truncate" title={s}>{s}</span>
                                      <span className="text-[10px] text-text-subtle">{info.rows} แถว</span>
                                      <div className="ml-auto flex items-center gap-2 text-[10px]">
                                        {([["cols", "คอลัมน์"], ["refs", "refs ทั้งชีต"], ["rows", "รายแถว (JSON)"]] as const).map(([m, l]) => (
                                          <label key={m} className="flex items-center gap-1 cursor-pointer">
                                            <input type="radio" checked={sel.mode === m} onChange={() => setSel(s, { mode: m })} />
                                            {l}
                                          </label>
                                        ))}
                                      </div>
                                    </div>
                                    {sel.mode === "cols" && (
                                      <div className="space-y-1">
                                        {info.columns.map((c) => (
                                          <label key={c.column_index} className="flex items-start gap-1.5 text-[11px] cursor-pointer">
                                            <input type="checkbox" className="mt-0.5"
                                              checked={sel.cols.includes(c.column_index)}
                                              onChange={(e) => setSel(s, {
                                                cols: e.target.checked
                                                  ? [...sel.cols, c.column_index].sort((a, b) => a - b)
                                                  : sel.cols.filter((x) => x !== c.column_index),
                                              })} />
                                            <span className="min-w-0">
                                              <span className="font-medium">{c.column_index}: {c.header || "(ไม่มีหัว)"}</span>
                                              {c.samples.length > 0 && (
                                                <span className="block text-text-subtle truncate">
                                                  {c.samples.slice(0, 3).join(" · ")}{c.samples.length > 3 ? " …" : ""}
                                                </span>
                                              )}
                                            </span>
                                          </label>
                                        ))}
                                      </div>
                                    )}
                                    {sel.mode === "refs" && (
                                      <input
                                        value={sel.refs} placeholder="ref1, ref2, ... (ใช้ทั้งชีต)"
                                        onChange={(e) => setSel(s, { refs: e.target.value })}
                                        className="w-full h-7 px-2 rounded-lg border border-border bg-surface text-[11px] focus:outline-none focus:ring-2 focus:ring-brand/40"
                                      />
                                    )}
                                    {sel.mode === "rows" && (
                                      <textarea
                                        value={sel.rows} rows={3}
                                        placeholder='{"3": ["รุ่น a"], "5": ["รุ่น b", "alias b"]}'
                                        onChange={(e) => setSel(s, { rows: e.target.value })}
                                        className="w-full px-2 py-1 rounded-lg border border-border bg-surface text-[11px] font-mono focus:outline-none focus:ring-2 focus:ring-brand/40"
                                      />
                                    )}
                                  </div>
                                );
                              })}
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-text-subtle">
                                  rev {bind.data.active_rev} → บันทึก = rev ใหม่ (rollback ได้) · ว่างทั้งหมด = ล้าง binding
                                </span>
                                <Button size="sm" onClick={saveBind} disabled={bind.saving || !pythonToolsAvailable}>
                                  {bind.saving ? "กำลังบันทึก..." : "บันทึก binding"}
                                </Button>
                              </div>
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )}
                  {fileDocsLoading ? (
                    <div className="flex justify-center py-6"><Loading size={18} /></div>
                  ) : fileDocs.length === 0 ? (
                    <div className="text-xs text-text-subtle py-4 text-center">ไม่มีเอกสาร</div>
                  ) : (
                    <>
                      <div className="space-y-1.5 max-h-80 overflow-y-auto">
                        {fileDocs.map((d) => (
                          <div key={d.id} className="border border-border/60 rounded-lg bg-surface px-3 py-2">
                            <div className="flex items-center gap-2 text-[10px] text-text-subtle mb-1">
                              <span className="font-mono">#{d.row_index}</span>
                              <span>{d.kind}{d.sheet ? ` · ${d.sheet}` : ""}</span>
                            </div>
                            <div className="text-xs font-medium text-text">{docTitle(d)}</div>
                            <div className="text-xs text-text-muted whitespace-pre-wrap break-words max-h-32 overflow-y-auto mt-0.5">{d.text}</div>
                          </div>
                        ))}
                      </div>
                      {fileDocsTotal > PAGE_SIZE && (
                        <div className="mt-3">
                          <Pagination
                            page={fileDocsPage + 1}
                            totalPages={Math.ceil(fileDocsTotal / PAGE_SIZE)}
                            onChange={(pg) => { setFileDocsPage(pg - 1); loadFileDocs(f.file, pg - 1); }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          {pageCount > 1 && (
            <div className="px-4 py-3">
              <Pagination
                page={page + 1}
                totalPages={pageCount}
                onChange={(pg) => setFilesPage(pg - 1)}
              />
            </div>
          )}
        </div>
        );
      })()}

      <div className="border border-border rounded-xl divide-y divide-border overflow-y-auto bg-surface max-h-[calc(100dvh-300px)]">
        {filtered.map((s) => {
          const platforms = [...new Set(s.accounts.map((a) => a.platform))];
          const open = openId === s.source_id;
          return (
            <div key={s.source_id}>
              <button
                onClick={() => toggleSource(s.source_id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2 transition-colors"
              >
                <ChevronDown size={14} className={`text-text-subtle transition-transform ${open ? "" : "-rotate-90"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-text truncate">{s.source_name}</div>
                  <div className="text-[11px] text-text-subtle mt-0.5 truncate">
                    {s.accounts.slice(0, 3).map((a) => a.name).join(", ")}
                    {s.accounts.length > 3 && ` +${s.accounts.length - 3}`}
                    {s.accounts.length === 0 && "ทุกร้าน"}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {platforms.map((p) => (
                    <span key={p} className={`text-[10px] px-1.5 py-0.5 rounded ${PLATFORM_COLORS[p] || "bg-surface-2 text-text-muted"}`}>
                      {p}
                    </span>
                  ))}
                </div>
                <Badge tone={s.active_docs === s.docs ? "success" : "warning"}>
                  {s.active_docs}/{s.docs}
                </Badge>
              </button>

              {open && (
                <div className="border-t border-border bg-surface-2/50 px-4 py-3">
                  <div className="flex justify-end mb-2">
                    {editable && (
                      <button
                        onClick={() => openCreate(s)}
                        className="text-xs text-brand hover:underline flex items-center gap-1"
                      >
                        <Plus size={12} /> เพิ่มในกลุ่มนี้
                      </button>
                    )}
                  </div>
                  {docsLoading ? (
                    <div className="flex justify-center py-6"><Loading size={18} /></div>
                  ) : docs.length === 0 ? (
                    <div className="text-xs text-text-subtle py-4 text-center">ไม่มีเอกสาร</div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        {docs.map((d) => (
                          <div key={d.id} className="border border-border/60 rounded-lg bg-surface px-3 py-2">
                            <div className="flex items-center gap-2 text-[10px] text-text-subtle mb-1">
                              <span className="font-mono">#{d.row_index}</span>
                              <span>{d.kind}{d.sheet ? ` · ${d.sheet}` : ""}</span>
                              {!d.active && <span className="text-error">ปิดอยู่</span>}
                              {editable && (
                                <span className="ml-auto flex items-center gap-1">
                                  <ToggleSwitch enabled={d.active} onChange={() => toggleActive(d)} />
                                  <button onClick={() => openEditDoc(d, s)} className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center" title="แก้ไข" aria-label="แก้ไข">
                                    <Pencil size={11} className="text-text-muted" />
                                  </button>
                                  <button onClick={() => removeDoc(d, s)} className="w-7 h-7 rounded-md hover:bg-error-soft flex items-center justify-center" title="ลบ" aria-label="ลบ">
                                    <Trash2 size={11} className="text-text-muted" />
                                  </button>
                                </span>
                              )}
                            </div>
                            <div className="text-xs font-medium text-text">{docTitle(d)}</div>
                            <div className="text-xs text-text-muted whitespace-pre-wrap break-words max-h-32 overflow-y-auto mt-0.5">
                              {d.text}
                            </div>
                          </div>
                        ))}
                      </div>
                      {docsTotal > PAGE_SIZE && (
                        <div className="mt-3">
                          <Pagination
                            page={docsPage + 1}
                            totalPages={Math.ceil(docsTotal / PAGE_SIZE)}
                            onChange={(p) => { setDocsPage(p - 1); loadDocs(s.source_id, p - 1); }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Edit / Create modal */}
      {edit && (
        <ModalLayer presentation="workspace" className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setEdit(null)} onBack={() => { if (saving) return false; setEdit(null); return true; }}>
          <div role="dialog" aria-modal="true" aria-label={edit.id ? "แก้ไขรายการ Zaapi KB" : "เพิ่มรายการ Zaapi KB"} className="bg-surface rounded-2xl border border-border shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="text-sm font-semibold text-text">{edit.id ? "แก้ไขรายการ" : "เพิ่มรายการใหม่"}</div>
              <button onClick={() => setEdit(null)} className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center" aria-label="ปิด">
                <X size={15} className="text-text-muted" />
              </button>
            </div>
            <div className="mobile-workspace-body px-5 py-4 space-y-3 overflow-y-auto flex-1">
              <div>
                <label className="text-xs text-text-muted block mb-1">Source (กลุ่ม/ชื่อชุดความรู้)</label>
                <input
                  value={edit.source_name}
                  onChange={(e) => setEdit({ ...edit, source_name: e.target.value })}
                  className="w-full h-8 px-3 rounded-lg border border-border bg-surface text-xs focus:outline-none focus:ring-2 focus:ring-brand/40"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">Fields (คอลัมน์ → ค่า)</label>
                <div className="space-y-1.5">
                  {edit.fields.map((f, i) => (
                    <div key={i} className="flex gap-1.5">
                      <input
                        value={f.k} placeholder="ชื่อฟิลด์"
                        onChange={(e) => setEdit({ ...edit, fields: edit.fields.map((x, j) => j === i ? { ...x, k: e.target.value } : x) })}
                        className="w-40 h-8 px-2 rounded-lg border border-border bg-surface text-xs focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                      <input
                        value={f.v} placeholder="ค่า"
                        onChange={(e) => setEdit({ ...edit, fields: edit.fields.map((x, j) => j === i ? { ...x, v: e.target.value } : x) })}
                        className="flex-1 h-8 px-2 rounded-lg border border-border bg-surface text-xs focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                      <button
                        onClick={() => setEdit({ ...edit, fields: edit.fields.filter((_, j) => j !== i) })}
                        className="w-8 h-8 rounded-md hover:bg-error-soft flex items-center justify-center shrink-0" aria-label="ลบฟิลด์"
                      >
                        <X size={12} className="text-text-muted" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setEdit({ ...edit, fields: [...edit.fields, { k: "", v: "" }] })}
                    className="text-xs text-brand hover:underline"
                  >
                    + เพิ่มฟิลด์
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted block mb-1">เนื้อความ (ใช้ค้นหา + ส่งให้บอท)</label>
                <textarea
                  value={edit.text}
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                  rows={6}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-xs focus:outline-none focus:ring-2 focus:ring-brand/40 whitespace-pre-wrap"
                />
              </div>
              {!edit.source_id && (
                <p className="text-[11px] text-text-subtle">รายการที่สร้างเองจะใช้ได้กับทุกร้าน (unscoped)</p>
              )}
            </div>
            <div className="mobile-workspace-actions flex justify-end gap-2 px-5 py-3 border-t border-border">
              <Button size="sm" variant="outline" onClick={() => setEdit(null)}>ยกเลิก</Button>
              <Button size="sm" onClick={saveEdit} disabled={saving}>{saving ? "กำลังบันทึก..." : "บันทึก"}</Button>
            </div>
          </div>
        </ModalLayer>
      )}

      {importModal}
    </div>
  );
}

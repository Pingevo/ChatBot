"use client";
// ZaapiKbPanel — imported Zaapi KB corpus (zaapi_kb) แบบกลุ่ม source + CRUD
// docs ข้างในแก้/ลบ/เปิด-ปิดได้ · แก้แล้ว mark manual_edit (importer ไม่ทับ)
// "เพิ่มในกลุ่มนี้" inherit accounts ของ source (scope เดียวกัน)
// "เพิ่ม" ทั่วไป → unscoped ใช้ได้ทุกร้าน
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
import { confirm } from "@/components/ui/ConfirmDialog";
import {
  Search, ChevronDown, Database, Pencil, Trash2, Plus, X, FileSpreadsheet,
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
  active: boolean;
};

const PLATFORM_COLORS: Record<string, string> = {
  Shopee: "bg-orange-100 text-orange-700",
  Facebook: "bg-blue-100 text-blue-700",
  Lazada: "bg-sky-100 text-sky-700",
  TikTok: "bg-neutral-800 text-white",
  "LINE Official": "bg-green-100 text-green-700",
};
const PAGE_SIZE = 25;
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

  const loadSources = useCallback(() => {
    api()
      .get("/zaapi-kb", { params: { mode: "sources" } })
      .then((r) => setSources(r.data.sources || []))
      .catch(() => setSources([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { loadSources(); }, [loadSources]);

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

  const filtered = sources
    .filter((s) => {
      if (platform !== "all" && !s.accounts.some((a) => a.platform === platform)) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        s.source_name.toLowerCase().includes(q) ||
        s.accounts.some((a) => a.name.toLowerCase().includes(q) || a.platform.toLowerCase().includes(q))
      );
    })
    .sort((a, b) =>
      sortBy === "recent"
        ? (b.zaapi_updated_at || "").localeCompare(a.zaapi_updated_at || "")
        : a.source_name.localeCompare(b.source_name));

  if (loading) return <div className="flex justify-center py-12"><Loading size={24} /></div>;
  if (sources.length === 0)
    return <EmptyState icon={Database} title="ยังไม่มี Zaapi KB" description="รัน import_zaapi_kb.py เพื่อนำเข้าข้อมูล" />;

  return (
    <div className="space-y-3">
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
        {editable && (
          <Button size="sm" variant="outline" onClick={() => openCreate()}>
            <Plus size={14} /> เพิ่ม (ทุกร้าน)
          </Button>
        )}
      </div>

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
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setEdit(null)}>
          <div className="bg-surface rounded-2xl border border-border shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="text-sm font-semibold text-text">{edit.id ? "แก้ไขรายการ" : "เพิ่มรายการใหม่"}</div>
              <button onClick={() => setEdit(null)} className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center" aria-label="ปิด">
                <X size={15} className="text-text-muted" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
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
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
              <Button size="sm" variant="outline" onClick={() => setEdit(null)}>ยกเลิก</Button>
              <Button size="sm" onClick={saveEdit} disabled={saving}>{saving ? "กำลังบันทึก..." : "บันทึก"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

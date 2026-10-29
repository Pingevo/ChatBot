"use client";
// ZaapiKbPanel — imported Zaapi KB corpus (zaapi_kb) เป็น card list + CRUD
// เพิ่ม/แก้/ลบ/เปิด-ปิด ได้เหมือน legacy KB — doc ที่แก้ถูก mark manual_edit
// (importer จะไม่ทับ) · doc สร้างเอง unscoped = ใช้ได้ทุกร้าน
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

type ZaapiDoc = {
  id: string;
  row_index: number;
  sheet?: string;
  kind: string;
  fields: Record<string, string>;
  text: string;
  source_id?: string;
  source_name?: string;
  accounts?: { id: string; platform: string; name: string }[];
  unscoped?: boolean;
  manual_edit?: boolean;
  active: boolean;
};

const PAGE_SIZE = 24;
const PLATFORMS = ["Shopee", "Facebook", "Lazada", "TikTok", "LINE Official"];
const TITLE_COLS = ["รุ่นสินค้า", "ชื่อรุ่นสินค้าย่อ", "คำถามเกี่ยวสินค้า", "คำถาม", "รุ่น", "model"];

function docTitle(d: ZaapiDoc): string {
  for (const c of TITLE_COLS) if (d.fields[c]?.trim()) return d.fields[c].trim();
  const first = Object.values(d.fields).find((v) => v?.trim());
  return (first || d.text || d.source_name || "ไม่มีชื่อ").trim().slice(0, 80);
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
  source_name: string;
  fields: { k: string; v: string }[];
  text: string;
};

export function ZaapiKbPanel() {
  const { user } = useAuth();
  const editable = canEditPage(user, "kb");

  const [docs, setDocs] = useState<ZaapiDoc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("all");
  const [active, setActive] = useState("all");
  const [sortBy, setSortBy] = useState("recent");
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const handleSearchEsc = useEscToClear(() => setSearch(""));

  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api()
      .get("/zaapi-kb", {
        params: {
          mode: "list", q: search || undefined,
          platform: platform !== "all" ? platform : undefined,
          active: active !== "all" ? active : undefined,
          sort: sortBy, skip: page * PAGE_SIZE, limit: PAGE_SIZE,
        },
      })
      .then((r) => { setDocs(r.data.docs || []); setTotal(r.data.total || 0); })
      .catch(() => { setDocs([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [search, platform, active, sortBy, page]);

  useEffect(() => { load(); }, [load]);

  function openEdit(d: ZaapiDoc) {
    setEdit({
      id: d.id,
      source_name: d.source_name || "",
      fields: Object.entries(d.fields).map(([k, v]) => ({ k, v })),
      text: d.text,
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
          source_name: edit.source_name, fields, text: edit.text,
        });
        toast.success("เพิ่มรายการแล้ว");
      }
      setEdit(null);
      load();
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
    } catch {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  async function remove(d: ZaapiDoc) {
    if (!(await confirm.ask({ title: `ลบ "${docTitle(d)}" ?`, variant: "danger" }))) return;
    try {
      await api().delete(`/zaapi-kb/${d.id}`);
      toast.success("ลบแล้ว");
      load();
    } catch {
      toast.error("ลบไม่สำเร็จ");
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-3">
      {/* Filter bar — ชุดเดียวกับ legacy: search + platform + status + sort + เพิ่ม */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="text"
            ref={searchRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            onKeyDown={handleSearchEsc}
            placeholder="ค้นหาเนื้อหา / source..."
            className="w-full h-8 pl-8 pr-8 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
          />
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-text-subtle border border-border rounded px-1 py-0.5 pointer-events-none">/</kbd>
        </div>
        <FilterDropdown label="แพลตฟอร์ม" value={platform}
          options={[{ v: "all", l: "ทั้งหมด" }, ...PLATFORMS.map((p) => ({ v: p, l: p }))]}
          onChange={(v) => { setPlatform(v); setPage(0); }} />
        <FilterDropdown label="สถานะ" value={active}
          options={[{ v: "all", l: "ทั้งหมด" }, { v: "active", l: "เปิดใช้" }, { v: "inactive", l: "ปิดใช้" }]}
          onChange={(v) => { setActive(v); setPage(0); }} />
        <FilterDropdown label="เรียง" value={sortBy}
          options={[{ v: "recent", l: "ล่าสุด" }, { v: "oldest", l: "เก่าสุด" }, { v: "name", l: "ชื่อ source" }]}
          onChange={setSortBy} />
        <span className="text-xs text-text-subtle ml-auto">{total.toLocaleString()} รายการ</span>
        {editable && (
          <Button size="sm" onClick={() => setEdit({ source_name: "เพิ่มเอง", fields: [{ k: "", v: "" }], text: "" })}>
            <Plus size={14} /> เพิ่ม
          </Button>
        )}
      </div>

      {/* Card list */}
      <div className="max-h-[calc(100dvh-300px)] overflow-y-auto pr-1">
        {loading ? (
          <div className="flex justify-center py-12"><Loading size={24} /></div>
        ) : docs.length === 0 ? (
          <EmptyState icon={Database} title="ไม่พบรายการ" description="ลองล้าง filter หรือเพิ่มรายการใหม่" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {docs.map((d) => {
              const platforms = [...new Set((d.accounts || []).map((a) => a.platform))];
              return (
                <div key={d.id} className="bg-surface rounded-xl border border-border p-4 hover:border-pale-sky transition-colors">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge tone={d.kind === "manual" ? "brand" : "pale"}>
                        {d.kind === "manual" ? "เพิ่มเอง" : d.kind === "xlsx_row" ? "Zaapi" : d.kind}
                      </Badge>
                      {d.source_name && <Badge tone="neutral">{d.source_name.slice(0, 40)}</Badge>}
                      {platforms.map((p) => <Badge key={p} tone="pale">{p}</Badge>)}
                      {d.manual_edit && <Badge tone="warning">แก้ไขแล้ว</Badge>}
                      {!d.active && <Badge tone="neutral">ปิดอยู่</Badge>}
                    </div>
                    {editable && (
                      <div className="flex items-center gap-1 shrink-0">
                        <ToggleSwitch enabled={d.active} onChange={() => toggleActive(d)} />
                        <button onClick={() => openEdit(d)} className="w-9 h-9 rounded-md hover:bg-surface-2 flex items-center justify-center" title="แก้ไข" aria-label="แก้ไข">
                          <Pencil size={13} className="text-text-muted" />
                        </button>
                        <button onClick={() => remove(d)} className="w-9 h-9 rounded-md hover:bg-error-soft flex items-center justify-center" title="ลบ" aria-label="ลบ">
                          <Trash2 size={13} className="text-text-muted" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-medium text-text">{docTitle(d)}</div>
                  <p className="text-xs text-text-muted mt-1 line-clamp-2 whitespace-pre-wrap">{d.text}</p>
                  <div className="flex items-center gap-1 mt-2 text-[10px] text-text-subtle">
                    <FileSpreadsheet size={10} />
                    {d.source_name} · #{d.row_index}
                    {d.unscoped && " · ทุกร้าน"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {totalPages > 1 && (
        <Pagination page={page + 1} totalPages={totalPages} onChange={(p) => setPage(p - 1)} />
      )}

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
              {!edit.id && (
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

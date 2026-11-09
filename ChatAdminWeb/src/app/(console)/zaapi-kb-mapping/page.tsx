"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { Loading } from "@/components/ui/Loading";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";

type FileMeta = {
  file: string; name?: string; rows: number;
  sheets: Record<string, number>;
  shop_guess?: string; type_guess?: string;
};
type SavedMap = {
  accounts: string[]; platforms: string[];
  content_type: string; sheet_types: Record<string, string>;
  mapped_by?: string; mapped_at?: string;
};
const TYPES = ["product", "troubleshooting", "faq", "warranty"];
const ALL = "ทุกร้าน";
const SEL = "w-full bg-surface text-text border border-border rounded-md px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

export default function ZaapiKbMappingPage() {
  const { user } = useAuth();
  const editable = canEditPage(user, "kb");
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [shops, setShops] = useState<string[]>([]);
  const [saved, setSaved] = useState<Record<string, SavedMap>>({});
  const [draft, setDraft] = useState<Record<string, Partial<SavedMap>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unmapped">("unmapped");
  const { catchError } = useToastError();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get("/zaapi-kb/mapping");
      setFiles(r.data.files || []);
      setShops(r.data.shops || []);
      setSaved(r.data.mapping || {});
      const d: Record<string, Partial<SavedMap>> = {};
      for (const f of r.data.files || []) {
        const s = (r.data.mapping || {})[f.file];
        d[f.file] = s
          ? { ...s }
          : {
              accounts: f.shop_guess ? [f.shop_guess] : [],
              platforms: ["shopee"],
              content_type: f.type_guess || "product",
              sheet_types: {},
            };
      }
      setDraft(d);
    } catch (e) {
      catchError(e, "โหลด mapping ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  useEffect(() => { load(); }, [load]);

  const setField = (file: string, patch: Partial<SavedMap>) =>
    setDraft((p) => ({ ...p, [file]: { ...p[file], ...patch } }));

  const isMapped = (f: FileMeta) => !!saved[f.file];
  const shown = useMemo(
    () => files.filter((f) => (filter === "all" ? true : !isMapped(f))),
    [files, filter, saved]
  );
  const mappedCount = files.filter(isMapped).length;

  const save = async (f: FileMeta) => {
    const d = draft[f.file] || {};
    if (!d.content_type) { toast.error("เลือก content_type ก่อน"); return; }
    setSaving(f.file);
    try {
      await api().post("/zaapi-kb/mapping", {
        file: f.file,
        accounts: d.accounts || [],
        platforms: d.platforms || ["shopee"],
        content_type: d.content_type,
        sheet_types: d.sheet_types || {},
      });
      setSaved((p) => ({ ...p, [f.file]: d as SavedMap }));
      toast.success(`บันทึก ${f.file}`);
    } catch (e) { catchError(e, "โหลด mapping ไม่สำเร็จ"); }
    finally { setSaving(null); }
  };

  if (loading) return <PageShell title="Zaapi KB Mapping"><Loading /></PageShell>;

  return (
    <PageShell title="Zaapi KB Mapping"
      subtitle={`map แล้ว ${mappedCount}/${files.length} ไฟล์ — ข้อมูลนี้ใช้ตอน import เข้าระบบ`}>
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" variant={filter === "unmapped" ? "primary" : "secondary"}
          onClick={() => setFilter("unmapped")}>ยังไม่ map ({files.length - mappedCount})</Button>
        <Button size="sm" variant={filter === "all" ? "primary" : "secondary"}
          onClick={() => setFilter("all")}>ทั้งหมด ({files.length})</Button>
        {!editable && <span className="text-xs text-text-muted ml-2">read-only — ต้องมีสิทธิ์แก้ KB</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-left text-text-muted border-b border-border">
              <th className="py-2 pr-3 w-8">#</th>
              <th className="pr-3">ไฟล์</th>
              <th className="pr-3 w-56">shop</th>
              <th className="pr-3 w-40">type ไฟล์</th>
              <th className="pr-3">sheets</th>
              <th className="w-20"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f, i) => {
              const d = draft[f.file] || {};
              const mapped = isMapped(f);
              return (
                <tr key={f.file} className="border-b border-border align-top">
                  <td className="py-2 pr-3 text-text-muted">{i + 1}</td>
                  <td className="pr-3 py-2">
                    <div className="font-medium">{f.file}</div>
                    <div className="text-text-muted">{f.name} · {f.rows} rows</div>
                    {mapped && <div className="text-emerald-500 text-[10px]">mapped by {saved[f.file].mapped_by}</div>}
                  </td>
                  <td className="pr-3 py-2">
                    <select className={SEL}
                      disabled={!editable}
                      value={(d.accounts && d.accounts[0]) || ALL}
                      onChange={(e) => setField(f.file, {
                        accounts: e.target.value === ALL ? [] : [e.target.value],
                      })}>
                      <option value={ALL}>{ALL} (ไม่จำกัด scope)</option>
                      {shops.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {!d.accounts?.length && (
                      <div className="text-amber-500 text-[10px] mt-1">เสิร์ฟทุกร้าน — ระวังข้อมูลเฉพาะร้านรั่ว</div>
                    )}
                  </td>
                  <td className="pr-3 py-2">
                    <select className={SEL}
                      disabled={!editable}
                      value={d.content_type || "product"}
                      onChange={(e) => setField(f.file, { content_type: e.target.value })}>
                      {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="pr-3 py-2">
                    {Object.entries(f.sheets).map(([s, n]) => (
                      <div key={s} className="text-text-muted truncate max-w-[200px] mb-1" title={s}>{s} ({n})</div>
                    ))}
                  </td>
                  <td className="py-2">
                    {editable && (
                      <Button size="sm" disabled={saving === f.file}
                        onClick={() => save(f)}>
                        {saving === f.file ? "…" : "บันทึก"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PageShell>
  );
}

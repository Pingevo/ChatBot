"use client";
import { SelectField } from "@/components/ui/SelectField";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { Loading } from "@/components/ui/Loading";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { MobileDataTable, MobileInfoCard } from "@/components/mobile/MobilePresentation";
import { ModalLayer } from "@/components/ui/ModalLayer";

type PreviewRow = { row: number; fields: Record<string, string>; text?: string };
type FileMeta = {
  file: string; name?: string; rows: number;
  sheets: Record<string, number>;
  preview?: Record<string, PreviewRow[]>;
  shop_guess?: string; type_guess?: string;
};
type SavedMap = {
  accounts: string[]; platforms: string[];
  content_type: string; sheet_types: Record<string, string>;
  mapped_by?: string; mapped_at?: string;
};
const TYPES = ["product", "troubleshooting", "faq", "warranty"];
const PLATFORMS = [
  { v: "shopee", l: "Shopee" },
  { v: "lazada", l: "Lazada" },
  { v: "tiktok", l: "TikTok" },
  { v: "facebook", l: "Facebook" },
  { v: "line official", l: "LINE Official" },
];
const SEL = "w-full bg-surface text-text border border-border rounded-md px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const CHIP = "px-2 py-1 rounded-lg border text-[11px]";

export default function ZaapiKbMappingPage() {
  const { user } = useAuth();
  const editable = canEditPage(user, "kb");
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [shops, setShops] = useState<{ name: string; platform: string }[]>([]);
  const [saved, setSaved] = useState<Record<string, SavedMap>>({});
  const [draft, setDraft] = useState<Record<string, Partial<SavedMap>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unmapped">("unmapped");
  const [preview, setPreview] = useState<{ file: string; sheet: string; rows: PreviewRow[] } | null>(null);
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

  // platform id → label + shops — หัวข้อกลุ่มร้านตาม platform
  const shopGroups = useMemo(() => {
    const order = PLATFORMS.map((p) => p.v);
    const byPlat = new Map<string, string[]>();
    for (const s of shops) {
      const k = s.platform || "other";
      if (!byPlat.has(k)) byPlat.set(k, []);
      byPlat.get(k)!.push(s.name);
    }
    return [...byPlat.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
      })
      .map(([plat, names]) => ({
        plat,
        label: PLATFORMS.find((p) => p.v === plat)?.l || plat || "other",
        names,
      }));
  }, [shops]);

  const save = async (f: FileMeta) => {
    const d = draft[f.file] || {};
    if (!d.content_type) { toast.error("เลือก content_type ก่อน"); return; }
    setSaving(f.file);
    try {
      await api().post("/zaapi-kb/mapping", {
        file: f.file,
        accounts: d.accounts || [],
        platforms: d.platforms || [],
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant={filter === "unmapped" ? "primary" : "secondary"}
          onClick={() => setFilter("unmapped")}>ยังไม่ map ({files.length - mappedCount})</Button>
        <Button size="sm" variant={filter === "all" ? "primary" : "secondary"}
          onClick={() => setFilter("all")}>ทั้งหมด ({files.length})</Button>
        {!editable && <span className="text-xs text-text-muted ml-2">read-only — ต้องมีสิทธิ์แก้ KB</span>}
      </div>
      <div className="grid grid-cols-1 2xl:hidden gap-3">
        {shown.map((f) => {
          const d = draft[f.file] || {};
          const mapped = isMapped(f);
          const selectedAccounts = d.accounts || [];
          const selectedPlatforms = d.platforms || [];
          const accountSummary = selectedAccounts.length
            ? `${selectedAccounts.slice(0, 2).join(", ")}${selectedAccounts.length > 2 ? ` +${selectedAccounts.length - 2}` : ""}`
            : "ทุกร้าน";
          const platformSummary = selectedPlatforms.length
            ? selectedPlatforms.map((value) => PLATFORMS.find((platform) => platform.v === value)?.l || value).join(", ")
            : "ทุก platform";

          return (
            <MobileInfoCard
              key={`mobile-${f.file}`}
              title={f.file}
              subtitle={`${f.name || "ไม่ระบุชื่อ"} · ${f.rows} rows`}
              summary={<span className={`text-xs font-medium ${mapped ? "text-success" : "text-warning-dark"}`}>{mapped ? "Mapped" : "ยังไม่ map"}</span>}
              previewCount={2}
              rows={[
                { label: "ร้าน", value: accountSummary },
                { label: "Platform", value: platformSummary },
                { label: "ประเภทไฟล์", value: d.content_type || "product" },
                { label: "จำนวน sheet", value: Object.keys(f.sheets).length },
                ...(mapped ? [{ label: "บันทึกโดย", value: saved[f.file].mapped_by || "—" }] : []),
              ]}
              details={<div className="space-y-4 text-xs">
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-text">ร้านที่ใช้ mapping</h3>
                  {!selectedPlatforms.length ? (
                    <p className="text-text-muted">เลือก platform ก่อน (เว้นว่าง platform = ทุก platform)</p>
                  ) : shopGroups.filter((group) => selectedPlatforms.includes(group.plat)).map((group) => (
                    <div key={group.plat}>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{group.label}</div>
                      <div className="grid gap-1 sm:grid-cols-2">
                        {group.names.map((shop) => {
                          const selected = selectedAccounts.includes(shop);
                          return (
                            <label key={shop} className={`flex min-h-9 items-center gap-2 rounded-lg border px-2 ${selected ? "border-accent/40 bg-accent/5" : "border-border"} ${!editable ? "opacity-60" : ""}`}>
                              <input
                                type="checkbox"
                                className="accent-accent"
                                disabled={!editable}
                                checked={selected}
                                onChange={() => setField(f.file, {
                                  accounts: selected ? selectedAccounts.filter((value) => value !== shop) : [...selectedAccounts, shop],
                                })}
                              />
                              <span className="min-w-0 truncate text-text">{shop}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {!shopGroups.some((group) => selectedPlatforms.includes(group.plat)) && selectedPlatforms.length > 0 && (
                    <p className="text-text-muted">ไม่มีร้านใน platform ที่เลือก</p>
                  )}
                  {!selectedAccounts.length && <p className="text-warning-dark">เสิร์ฟทุกร้าน — ระวังข้อมูลเฉพาะร้านรั่ว</p>}
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-text">Platform</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {PLATFORMS.map((platform) => {
                      const selected = selectedPlatforms.includes(platform.v);
                      return (
                        <button
                          key={platform.v}
                          type="button"
                          disabled={!editable}
                          onClick={() => setField(f.file, {
                            platforms: selected ? selectedPlatforms.filter((value) => value !== platform.v) : [...selectedPlatforms, platform.v],
                          })}
                          className={`${CHIP} ${selected ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted"} disabled:opacity-60`}
                        >
                          {platform.l}
                        </button>
                      );
                    })}
                  </div>
                  {!selectedPlatforms.length && <p className="text-text-muted">เว้นว่างเพื่อเลือกทุก platform</p>}
                </section>

                <label className="block space-y-1.5">
                  <span className="text-sm font-semibold text-text">ประเภทข้อมูลของไฟล์</span>
                  <SelectField className={SEL} disabled={!editable} value={d.content_type || "product"} onChange={(event) => setField(f.file, { content_type: event.target.value })}>
                    {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </SelectField>
                </label>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-text">ประเภทข้อมูลแยกตาม sheet</h3>
                  {Object.entries(f.sheets).map(([sheet, count]) => {
                    const sheetType = (d.sheet_types || {})[sheet];
                    const overridden = !!sheetType && sheetType !== d.content_type;
                    return (
                      <div key={sheet} className={`rounded-xl border p-3 ${overridden ? "border-accent/50 bg-accent/5" : "border-border bg-surface-1"}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-medium text-text">{sheet}</span>
                          <span className="shrink-0 text-[10px] text-text-muted">{count} rows</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setPreview({ file: f.file, sheet, rows: f.preview?.[sheet] || [] })}>ดูข้อมูล</Button>
                          <SelectField
                            className={SEL}
                            disabled={!editable}
                            value={sheetType || d.content_type || "product"}
                            onChange={(event) => {
                              const next = { ...(d.sheet_types || {}) };
                              if (event.target.value === d.content_type) delete next[sheet];
                              else next[sheet] = event.target.value;
                              setField(f.file, { sheet_types: next });
                            }}
                          >
                            {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                          </SelectField>
                        </div>
                        {overridden && <p className="mt-1 text-[10px] text-accent">ต่างจากประเภทไฟล์ ({d.content_type})</p>}
                      </div>
                    );
                  })}
                </section>
              </div>}
              cardActions={editable ? (
                <div className="flex justify-end">
                  <Button size="sm" disabled={saving === f.file} onClick={() => save(f)}>{saving === f.file ? "กำลังบันทึก…" : "บันทึก"}</Button>
                </div>
              ) : undefined}
            />
          );
        })}
      </div>
      <div className="hidden 2xl:block">
      <MobileDataTable>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-left text-text-muted border-b border-border">
              <th className="py-2 pr-3 w-8">#</th>
              <th className="pr-3">ไฟล์</th>
              <th className="pr-3 w-72">shop (ว่าง = ทุกร้าน)</th>
              <th className="pr-3 w-52">platform (ว่าง = ทุก platform)</th>
              <th className="pr-3 w-40">type ไฟล์</th>
              <th className="pr-3">type ต่อ sheet</th>
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
                    {!d.platforms?.length ? (
                      <div className="text-text-muted text-[10px]">เลือก platform ก่อน (ว่าง platform = ทุก platform)</div>
                    ) : (
                      <div className="max-h-40 overflow-y-auto space-y-2">
                        {shopGroups
                          .filter((g) => (d.platforms || []).includes(g.plat))
                          .map((g) => (
                            <div key={g.plat}>
                              <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-0.5">{g.label}</div>
                              <div className="flex flex-col gap-0.5">
                                {g.names.map((s) => {
                                  const on = (d.accounts || []).includes(s);
                                  return (
                                    <label key={s}
                                      className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 cursor-pointer ${on ? "bg-accent/10" : "hover:bg-surface-2"} ${!editable ? "opacity-60 cursor-not-allowed" : ""}`}>
                                      <input type="checkbox" className="accent-accent" disabled={!editable}
                                        checked={on}
                                        onChange={() => setField(f.file, {
                                          accounts: on
                                            ? (d.accounts || []).filter((x) => x !== s)
                                            : [...(d.accounts || []), s],
                                        })} />
                                      <span className="truncate">{s}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        {!shopGroups.some((g) => (d.platforms || []).includes(g.plat)) && (
                          <div className="text-text-muted text-[10px]">ไม่มีร้านใน platform ที่เลือก</div>
                        )}
                      </div>
                    )}
                    {!d.accounts?.length && (
                      <div className="text-amber-500 text-[10px] mt-1">เสิร์ฟทุกร้าน — ระวังข้อมูลเฉพาะร้านรั่ว</div>
                    )}
                  </td>
                  <td className="pr-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {PLATFORMS.map((p) => {
                        const on = (d.platforms || []).includes(p.v);
                        return (
                          <button key={p.v} type="button" disabled={!editable}
                            onClick={() => setField(f.file, {
                              platforms: on
                                ? (d.platforms || []).filter((x) => x !== p.v)
                                : [...(d.platforms || []), p.v],
                            })}
                            className={`${CHIP} ${on ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted"}`}>
                            {p.l}
                          </button>
                        );
                      })}
                    </div>
                    {!d.platforms?.length && (
                      <div className="text-text-muted text-[10px] mt-1">ทุก platform</div>
                    )}
                  </td>
                  <td className="pr-3 py-2">
                    <SelectField className={SEL}
                      disabled={!editable}
                      value={d.content_type || "product"}
                      onChange={(e) => setField(f.file, { content_type: e.target.value })}>
                      {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </SelectField>
                  </td>
                  <td className="pr-3 py-2">
                    <div className="flex flex-col gap-1.5">
                      {Object.entries(f.sheets).map(([s, n]) => {
                        const st = (d.sheet_types || {})[s];
                        const overridden = !!st && st !== d.content_type;
                        return (
                          <div key={s}
                            className={`rounded-lg border px-2 py-1.5 ${overridden ? "border-accent/50 bg-accent/5" : "border-border bg-surface-2"}`}>
                            <div className="flex items-center justify-between gap-2">
                              <button type="button"
                                className="text-accent hover:underline truncate text-left font-medium"
                                title={`ดูข้อมูล ${s}`}
                                onClick={() => setPreview({ file: f.file, sheet: s, rows: f.preview?.[s] || [] })}>
                                {s}
                              </button>
                              <span className="text-[10px] text-text-muted whitespace-nowrap">{n} rows</span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-1">
                              <Button size="sm" variant="ghost"
                                onClick={() => setPreview({ file: f.file, sheet: s, rows: f.preview?.[s] || [] })}>
                                ดูข้อมูล
                              </Button>
                              <SelectField className={SEL}
                                disabled={!editable}
                                value={st || d.content_type || "product"}
                                onChange={(e) => {
                                  const next = { ...(d.sheet_types || {}) };
                                  if (e.target.value === d.content_type) delete next[s];
                                  else next[s] = e.target.value;
                                  setField(f.file, { sheet_types: next });
                                }}>
                                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                              </SelectField>
                            </div>
                            {overridden && (
                              <div className="text-[10px] text-accent mt-0.5">ต่างจาก type ไฟล์ ({d.content_type})</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
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
      </MobileDataTable>
      </div>
      {preview && (
        <ModalLayer presentation="workspace" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onBack={() => setPreview(null)}
          onClick={() => setPreview(null)}>
          <div role="dialog" aria-modal="true" aria-label={`ตัวอย่างข้อมูล ${preview.sheet}`} className="bg-surface border border-border rounded-xl max-w-4xl w-full max-h-[80vh] overflow-auto p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-center justify-between px-4 pt-4 mb-3">
              <div>
                <div className="text-sm font-semibold">{preview.sheet}</div>
                <div className="text-xs text-text-muted">{preview.file}</div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setPreview(null)}>ปิด</Button>
            </div>
            <div className="mobile-workspace-body px-4 pb-4">
            {preview.rows.length === 0 && <div className="text-text-muted text-sm">ไม่มีข้อมูล preview</div>}
            {preview.rows.map((r, i) => (
              <div key={i} className="border border-border rounded-lg p-3 mb-2 text-xs">
                <div className="text-text-muted mb-1">row {r.row}</div>
                <table className="w-full">
                  <tbody>
                    {Object.entries(r.fields).map(([k, v]) => (
                      <tr key={k} className="align-top">
                        <td className="pr-3 py-0.5 text-text-muted whitespace-nowrap font-medium w-40">{k}</td>
                        <td className="py-0.5 whitespace-pre-wrap break-words">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.text && <div className="mt-2 pt-2 border-t border-border text-text-muted whitespace-pre-wrap">{r.text}</div>}
              </div>
            ))}
            </div>
          </div>
        </ModalLayer>
      )}
    </PageShell>
  );
}

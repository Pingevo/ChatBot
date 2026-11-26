"use client";
// Bot performance — Q&A data part: filterable table of bot answers + admin decisions/reasons, detail drawer with edit diff, CSV/JSONL export
import { useCallback, useEffect, useState } from "react";
import { Download, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { api } from "@/lib/apiClient";
import { diffLines } from "@/lib/textDiff";
import { formatMinutes, OUTCOME_COLORS } from "./BotPerformanceStats";
import type { PerfScope } from "@/app/(console)/bot-performance/page";

type Outcome = "approved" | "edited" | "rejected" | "pending" | "none";
type Handoff = "none" | "requested" | "approved" | "rejected" | "pending";
interface QaBubble {
  bubble_id: string; original_text: string; final_text: string; decision: string; edit_pct: number;
  decided_by_name?: string; decided_at?: string | null; review_minutes: number | null;
  rejection_category?: string; rejection_reason?: string; delivery_state: string; outbound_text?: string; card_item_id?: string; card_delivery_state: string;
  edit_history?: { before_text: string; after_text: string; reason_category?: string; reason_text?: string; actor_name?: string; at?: string }[];
}
interface QaRow {
  reply_id: string; conversation_id: string; shop_id: string; created_at: string; chat_engine?: string; origin?: string;
  inbound_text: string; bot_reply_text: string; outcome: Outcome; handoff: Handoff;
  handoff_reason: string; handoff_explanation: string; handoff_reviewed_by?: string; handoff_rejection_category: string; handoff_rejection_reason: string; handoff_assigned_to: string;
  max_edit_pct: number; review_minutes: number | null; reviewers: string[]; admin_reasons: string[]; bubbles: QaBubble[];
  timeline: { type: string; actor: string; actor_name?: string; created_at: string; action?: string; rejection_category?: string; rejection_reason?: string; assigned_to_name?: string }[];
}
interface QaData { items: QaRow[]; page: number; total: number; total_pages: number; truncated: boolean }

const OUTCOME_LABEL: Record<Outcome, string> = { approved: "ผ่านไม่ต้องแก้", edited: "แก้แล้วผ่าน", rejected: "ไม่อนุมัติ", pending: "รอตรวจ", none: "ไม่มีร่าง" };
const OUTCOME_TONE: Record<Outcome, "success" | "info" | "error" | "warning" | "neutral"> = { approved: "success", edited: "info", rejected: "error", pending: "warning", none: "neutral" };
const HANDOFF_LABEL: Record<Handoff, string> = { none: "—", requested: "ขอส่งต่อ", approved: "ส่งต่อแล้ว", rejected: "ไม่ให้ส่งต่อ", pending: "รอตัดสินส่งต่อ" };
const BUBBLE_LABEL: Record<string, string> = { approved: "ผ่าน", edited_approved: "แก้แล้วผ่าน", rejected: "ไม่อนุมัติ", pending: "รอตรวจ" };
const DELIVERY_LABEL: Record<string, string> = {
  not_requested: "ยังไม่ได้ส่ง", not_sent_switch_off: "อนุมัติแล้ว แต่สวิตช์ปิด จึงยังไม่ได้ส่ง",
  mock_sent: "บันทึกผลจำลองส่ง ลูกค้ายังไม่ได้รับ", mock_failed: "จำลองส่งไม่สำเร็จ",
  live_sending: "กำลังส่งจริง", live_sent: "Shopee ยืนยันส่งถึงลูกค้าแล้ว",
  live_failed: "Shopee ส่งไม่สำเร็จ", live_unknown: "ผลส่งจริงไม่ชัดเจน ต้องตรวจแชทก่อนทำซ้ำ",
};

function dateLabel(value?: string | null) {
  return value ? new Date(value).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "short", timeStyle: "short" }) : "—";
}

function DiffView({ original, final }: { original: string; final: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border text-sm leading-relaxed text-text">
      {diffLines(original, final).map((s, i) => <div key={i} className={`grid grid-cols-[1.5rem_minmax(0,1fr)] whitespace-pre-wrap break-words ${
        s.op === "del" ? "bg-error-soft text-error" : s.op === "add" ? "bg-success-soft text-success-dark" : "bg-surface"
      }`}>
        <span aria-hidden="true" className="select-none px-1 text-center opacity-75">{s.op === "del" ? "−" : s.op === "add" ? "+" : " "}</span>
        <span className="py-0.5 pr-2">{s.text}</span>
      </div>)}
    </div>
  );
}

function Drawer({ row, onClose }: { row: QaRow; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const label = "mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted";
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="ปิด" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="รายละเอียดคำถามคำตอบ" className="relative flex h-full w-full max-w-2xl flex-col bg-surface shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={OUTCOME_TONE[row.outcome]}>{OUTCOME_LABEL[row.outcome]}</Badge>
              {row.handoff !== "none" && <Badge tone="warning">{HANDOFF_LABEL[row.handoff]}</Badge>}</div>
            <p className="mt-1 text-xs text-text-muted">{dateLabel(row.created_at)} · ร้าน {row.shop_id} · {row.chat_engine || row.origin || "engine ไม่ระบุ"}</p>
            <p className="mt-0.5 select-all font-mono text-[11px] text-text-subtle">แชท {row.conversation_id}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="ปิด" onClick={onClose} className="shrink-0"><X size={16} /></Button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section><div className={label}>คำถามลูกค้า</div><p className="whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-sm text-text">{row.inbound_text || "(ไม่มีข้อความ)"}</p></section>
          <section className="space-y-3">
            <div className={label}>คำตอบบอท → ข้อความสุดท้าย</div>
            {!row.bubbles.length && <p className="whitespace-pre-wrap break-words text-sm text-text">{row.bot_reply_text || "(บอทไม่ได้ส่งร่างคำตอบ)"}</p>}
            {row.bubbles.map((b, i) => (
              <div key={b.bubble_id} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-text">ส่วนที่ {i + 1}</span>
                  <span className="rounded-full bg-surface-2 px-2 py-0.5">{BUBBLE_LABEL[b.decision] || b.decision}</span>
                  {b.decision === "edited_approved" && <span className="text-text-muted">แก้ {b.edit_pct}%</span>}
                  {b.decided_by_name && <span className="text-text-muted">โดย {b.decided_by_name} · ใช้เวลา {formatMinutes(b.review_minutes)}</span>}
                </div>
                {b.final_text !== b.original_text ? <DiffView original={b.original_text} final={b.final_text} />
                  : <p className="whitespace-pre-wrap break-words text-sm text-text">{b.original_text}</p>}
                <p className="mt-2 text-xs text-text-muted">ผลการส่ง: {DELIVERY_LABEL[b.delivery_state] || b.delivery_state || "ไม่ทราบสถานะ"}</p>
                {b.outbound_text !== undefined && <div className="mt-2 rounded-md border border-border bg-surface-2 p-2.5">
                  <div className="text-[11px] font-semibold text-text">{b.delivery_state === "live_sent" ? "ข้อความที่ส่งจริง (Shopee ยืนยันแล้ว)" : b.delivery_state === "live_unknown" ? "ข้อความในคำขอส่ง (ยังยืนยันผลไม่ได้)" : "ข้อความในคำขอส่ง (สถานะส่งไม่สำเร็จ)"}</div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text">{b.outbound_text}</p>
                </div>}
                {b.card_item_id && <p className="mt-1 text-xs text-text-muted">การ์ดสินค้า {b.card_item_id} · ผลการส่ง: {DELIVERY_LABEL[b.card_delivery_state] || b.card_delivery_state || "ไม่ทราบสถานะ"}</p>}
                {!!b.edit_history?.length && <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <div className="text-xs font-semibold text-text">ประวัติการแก้คำตอบ</div>
                  {b.edit_history.map((edit, revisionIndex) => (
                    <div key={`${edit.at || revisionIndex}:${revisionIndex}`} className="rounded-md bg-surface-2 p-2.5">
                      <div className="flex flex-wrap items-center gap-1 text-xs font-medium text-text">
                        <span>ครั้งที่ {revisionIndex + 1}</span>
                        <span>· {edit.reason_category || "ไม่มีหมวดเหตุผลย้อนหลัง"}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text-muted">{edit.reason_text || "ไม่มีคำอธิบายย้อนหลัง"}</p>
                      <p className="mt-1 text-[11px] text-text-subtle">{edit.actor_name || "ไม่ระบุผู้แก้"} · {dateLabel(edit.at)}</p>
                      <div className="mt-2"><DiffView original={edit.before_text} final={edit.after_text} /></div>
                    </div>
                  ))}
                </div>}
                {b.final_text !== b.original_text && !b.edit_history?.length && <p className="mt-2 text-xs text-text-muted">รายการนี้มีข้อความแก้ แต่ไม่มีเหตุผลย้อนหลังบันทึกไว้</p>}
                {b.rejection_reason && <p className="mt-2 rounded-md bg-error-soft px-2 py-1.5 text-xs text-error">เหตุผลไม่อนุมัติ: {b.rejection_category ? `${b.rejection_category} · ` : ""}{b.rejection_reason}</p>}
              </div>
            ))}
            {row.bubbles.some((b) => b.decision === "edited_approved") && <p className="text-[11px] text-text-subtle"><del className="bg-error-soft text-error">แดง</del> = บอทเขียนแต่แอดมินลบ · <ins className="bg-success-soft text-success-dark no-underline">เขียว</ins> = แอดมินเพิ่ม</p>}
          </section>
          {row.handoff !== "none" && (
            <section className="rounded-lg border border-warning/30 bg-warning-soft/40 p-3 text-sm">
              <div className="font-medium text-text">ส่งต่อแอดมิน: {HANDOFF_LABEL[row.handoff]}</div>
              <div className="mt-1 text-xs text-text-muted">รหัสเหตุผล: {row.handoff_reason || "ไม่ระบุ"}</div>
              {row.handoff_explanation && <div className="mt-1 text-xs text-text">{row.handoff_explanation}</div>}
              {row.handoff_reviewed_by && <div className="mt-1 text-xs text-text-muted">ผู้ตัดสิน: {row.handoff_reviewed_by}{row.handoff_assigned_to && ` · ผู้รับงาน: ${row.handoff_assigned_to}`}</div>}
              {row.handoff_rejection_reason && <div className="mt-1 whitespace-pre-wrap text-xs text-error">เหตุผลไม่ให้ส่งต่อ: {row.handoff_rejection_category ? `${row.handoff_rejection_category} · ` : ""}{row.handoff_rejection_reason}</div>}
            </section>
          )}
          <section>
            <div className={label}>Timeline การทำงาน</div>
            <ol className="space-y-2 border-l border-border pl-4">
              {row.timeline.map((e, i) => (
                <li key={`${e.created_at}:${i}`} className="relative text-xs">
                  <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-accent" />
                  <div className="font-medium text-text">{e.action || e.type} · {e.actor_name || e.actor}</div>
                  <div className="text-text-muted">{dateLabel(e.created_at)}</div>
                  {e.rejection_reason && <div>เหตุผล: {e.rejection_category ? `${e.rejection_category} · ` : ""}{e.rejection_reason}</div>}
                  {e.assigned_to_name && <div>จ่ายให้: {e.assigned_to_name}</div>}
                </li>
              ))}
              {!row.timeline.length && <li className="text-xs text-text-muted">ไม่มี event</li>}
            </ol>
          </section>
        </div>
      </aside>
    </div>
  );
}

export function BotPerformanceQa({ scope, reviewers }: { scope: PerfScope; reviewers: string[] }) {
  const [outcome, setOutcome] = useState("");
  const [handoff, setHandoff] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [minEdit, setMinEdit] = useState("");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<QaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [selected, setSelected] = useState<QaRow | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => setQ(query), 350); return () => clearTimeout(t); }, [query]);
  useEffect(() => { setPage(1); }, [scope, outcome, handoff, reviewer, minEdit, q]);

  const params = { ...scope, outcome, handoff, reviewer, min_edit_pct: minEdit, q };
  const paramsKey = JSON.stringify(params);

  const load = useCallback(async () => {
    if (!scope.from || !scope.to || scope.from > scope.to) return;
    setLoading(true); setErrorText("");
    try {
      const r = await api().get<QaData>("/bot-performance", { params: { view: "items", page, ...JSON.parse(paramsKey) } });
      setData(r.data);
    } catch (e) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setErrorText(err.response?.data?.detail || err.message || "โหลดข้อมูลไม่สำเร็จ");
    } finally { setLoading(false); }
  }, [paramsKey, page, scope.from, scope.to]);

  useEffect(() => { void load(); }, [load]);

  async function exportFile(format: "csv" | "jsonl") {
    setExporting(true);
    try {
      const r = await api().get<Blob>("/bot-performance", { params: { view: "export", format, ...params }, responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url; a.download = `bot-performance_${scope.from}_${scope.to}.${format}`; a.click();
      URL.revokeObjectURL(url);
      if (r.headers["x-export-truncated"] === "1") setErrorText("ไฟล์มีเฉพาะ 5,000 รายการแรก กรุณากรองให้แคบลงถ้าต้องการครบ");
    } catch { setErrorText("ดาวน์โหลดไฟล์ไม่สำเร็จ"); } finally { setExporting(false); }
  }

  const cell = "px-3 py-2.5 align-top";
  return (
    <div className="space-y-3">
      <section className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3">
        <label className="relative min-w-52 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input type="search" aria-label="ค้นข้อความ" placeholder="ค้นคำถาม คำตอบ เหตุผล หรือรหัสแชท" value={query} onChange={(e) => setQuery(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-surface pl-8 pr-3 text-sm text-text placeholder:text-text-subtle" />
        </label>
        <SelectField density="compact" aria-label="ผลตรวจ" value={outcome} onChange={(e) => setOutcome(e.target.value)} className="w-auto">
          <option value="">ผลตรวจทั้งหมด</option>
          {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((k) => <option key={k} value={k}>{OUTCOME_LABEL[k]}</option>)}
        </SelectField>
        <SelectField density="compact" aria-label="ส่งต่อแอดมิน" value={handoff} onChange={(e) => setHandoff(e.target.value)} className="w-auto">
          <option value="">ส่งต่อ: ทั้งหมด</option><option value="requested">บอทขอส่งต่อ (ทุกสถานะ)</option><option value="approved">ส่งต่อแล้ว</option>
          <option value="rejected">ไม่ให้ส่งต่อ</option><option value="pending">รอตัดสินส่งต่อ</option><option value="none">ไม่ขอส่งต่อ</option>
        </SelectField>
        <SelectField density="compact" aria-label="ผู้ตรวจ" value={reviewer} onChange={(e) => setReviewer(e.target.value)} className="w-auto">
          <option value="">ผู้ตรวจทั้งหมด</option>{reviewers.map((r) => <option key={r} value={r}>{r}</option>)}
        </SelectField>
        <SelectField density="compact" aria-label="แก้อย่างน้อย" value={minEdit} onChange={(e) => setMinEdit(e.target.value)} className="w-auto">
          <option value="">แก้: ทุกระดับ</option><option value="10">แก้ ≥ 10%</option><option value="30">แก้ ≥ 30%</option><option value="60">แก้ ≥ 60%</option>
        </SelectField>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" disabled={exporting || !data?.total} onClick={() => void exportFile("csv")}><Download size={13} />CSV</Button>
          <Button variant="outline" size="sm" disabled={exporting || !data?.total} onClick={() => void exportFile("jsonl")} title="ไฟล์สำหรับส่งให้ AI วิเคราะห์ต่อ"><Download size={13} />JSONL (AI)</Button>
        </div>
      </section>
      {errorText && <div role="alert" className="rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{errorText}</div>}

      <section className={`overflow-hidden rounded-xl border border-border bg-surface ${loading ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-xs text-text-muted">
          <span>ทั้งหมด {data?.total ?? 0} รายการ · คลิกแถวเพื่อดูรายละเอียดและส่วนที่แอดมินแก้</span>
          <div className="flex items-center gap-2">
            <span>หน้า {data?.page || 1} / {data?.total_pages || 1}</span>
            <Button variant="outline" size="sm" disabled={!data || page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>ก่อนหน้า</Button>
            <Button variant="outline" size="sm" disabled={!data || page >= (data.total_pages || 1) || loading} onClick={() => setPage((p) => p + 1)}>ถัดไป</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-surface-2/60 text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-3 py-2">เวลา / ร้าน</th><th className="px-3 py-2">คำถามลูกค้า</th><th className="px-3 py-2">คำตอบบอท</th>
                <th className="px-3 py-2">ผลตรวจ</th><th className="px-3 py-2">% แก้</th><th className="px-3 py-2">เหตุผลของแอดมิน / ส่งต่อ</th>
                <th className="px-3 py-2">ผู้ตรวจ</th><th className="px-3 py-2">เวลาตรวจ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data?.items.map((row) => (
                <tr key={row.reply_id} tabIndex={0} onClick={() => setSelected(row)} onKeyDown={(e) => { if (e.key === "Enter") setSelected(row); }}
                  className="cursor-pointer transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2 focus-visible:outline-none">
                  <td className={`${cell} whitespace-nowrap text-xs text-text-muted`}>{dateLabel(row.created_at)}<div className="text-text-subtle">ร้าน {row.shop_id}</div></td>
                  <td className={`${cell} max-w-64`}><p className="line-clamp-3 break-words text-text">{row.inbound_text || "—"}</p></td>
                  <td className={`${cell} max-w-72`}><p className="line-clamp-3 break-words text-text">{row.bot_reply_text.replaceAll("|||", " · ") || "—"}</p></td>
                  <td className={cell}><Badge tone={OUTCOME_TONE[row.outcome]}>{OUTCOME_LABEL[row.outcome]}</Badge></td>
                  <td className={`${cell} tabular-nums`}>{row.max_edit_pct ? <span style={{ color: OUTCOME_COLORS.edited }}>{row.max_edit_pct}%</span> : "—"}</td>
                  <td className={`${cell} max-w-64 text-xs`}>
                    {row.admin_reasons.map((r, i) => <p key={i} className="line-clamp-2 text-error">{r}</p>)}
                    {row.handoff !== "none" && <p className="mt-0.5 text-text-muted">{HANDOFF_LABEL[row.handoff]} · {row.handoff_reason || "ไม่ระบุ"}</p>}
                    {!row.admin_reasons.length && row.handoff === "none" && <span className="text-text-subtle">—</span>}
                  </td>
                  <td className={`${cell} text-xs text-text`}>{row.reviewers.join(", ") || "—"}</td>
                  <td className={`${cell} whitespace-nowrap text-xs tabular-nums`}>{formatMinutes(row.review_minutes)}</td>
                </tr>
              ))}
              {!loading && data?.items.length === 0 && <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-text-muted">ไม่มีรายการตามตัวกรองนี้</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {selected && <Drawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

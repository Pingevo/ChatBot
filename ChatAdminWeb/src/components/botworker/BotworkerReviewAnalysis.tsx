"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/apiClient";

type TimelineEvent = { type: string; actor: string; actor_name?: string; created_at: string; metadata?: Record<string, unknown> };
type AnalysisItem = {
  reply_id: string;
  conversation_id: string;
  shop_id: string;
  created_at: string;
  inbound_text: string;
  bot_reply_text: string;
  bot_source?: string;
  chat_engine?: string;
  bot_handoff_required?: boolean;
  handoff_reason?: string;
  handoff_explanation?: string;
  handoff_review?: { status: string; reviewed_by_name?: string; selected_admin_name?: string; rejection_reason?: string };
  review_bubbles: { original_text: string; edited_text?: string; approved_text?: string; decision: string; decided_by_name?: string; rejection_reason?: string; edit_history?: { before_text: string; after_text: string; actor: string; actor_name: string; at: string }[]; delivery?: { state: string } }[];
  timeline: TimelineEvent[];
};
type AnalysisData = {
  series: Record<string, string | number>[];
  items: AnalysisItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  timezone: string;
};

function todayBangkok() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date()); }
function dateLabel(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
}
function statusLabel(value: string) {
  const labels: Record<string, string> = {
    pending: "รอตรวจ", approved: "อนุมัติ", edited_approved: "แก้ไขและอนุมัติ", rejected: "ไม่อนุมัติ",
    live_sent: "ส่งจริงสำเร็จ", not_sent_switch_off: "อนุมัติแล้ว แต่ switch ปิดจึงไม่ส่ง", mock_sent: "บันทึกผลจำลอง",
    live_failed: "ส่งจริงไม่สำเร็จ", live_unknown: "ยังยืนยันผลส่งไม่ได้", mock_failed: "จำลองล้มเหลว",
  };
  return labels[value] || value;
}

export function BotworkerReviewAnalysis() {
  const today = todayBangkok();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [group, setGroup] = useState<"day" | "month" | "year">("day");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");

  const load = useCallback(async () => {
    if (!from || !to || from > to) { setErrorText("กรุณาเลือกช่วงวันที่ให้ถูกต้อง"); return; }
    setLoading(true); setErrorText("");
    try {
      const response = await api().get<AnalysisData>("/botworker/review-analysis", {
        params: { from, to, group, page: String(page), page_size: "25" },
      });
      setData(response.data);
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : "โหลดผลวิเคราะห์ไม่สำเร็จ");
      setData(null);
    } finally { setLoading(false); }
  }, [from, to, group, page]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => (data?.series || []).reduce<Record<string, number>>((out, row) => {
    for (const key of ["drafts", "handoff_requested", "handoff_approved", "handoff_rejected", "bubbles", "approved", "edited_approved", "rejected", "pending", "live_sent", "not_sent_switch_off", "mock_sent", "failed_or_unknown"]) {
      out[key] = (out[key] || 0) + Number(row[key] || 0);
    }
    return out;
  }, {} as Record<string, number>), [data]);

  function setPreset(kind: "today" | "month" | "year") {
    const now = todayBangkok();
    setTo(now);
    setPage(1);
    if (kind === "today") { setFrom(now); setGroup("day"); }
    if (kind === "month") { setFrom(`${now.slice(0, 7)}-01`); setGroup("day"); }
    if (kind === "year") { setFrom(`${now.slice(0, 4)}-01-01`); setGroup("month"); }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface-2 p-4 md:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">วิเคราะห์ผลการตรวจ BotWorker</h1>
          <p className="text-sm text-text-muted">ดูคำถาม คำตอบ การตัดสินใจของผู้ตรวจ และผล handoff ตามเวลาประเทศไทย</p>
        </header>

        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs text-text-muted">ตั้งแต่
              <input aria-label="วันที่เริ่ม" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm text-text" />
            </label>
            <label className="grid gap-1 text-xs text-text-muted">ถึง
              <input aria-label="วันที่สิ้นสุด" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm text-text" />
            </label>
            <label className="grid gap-1 text-xs text-text-muted">จัดกลุ่มกราฟ
              <select value={group} onChange={(e) => { setGroup(e.target.value as typeof group); setPage(1); }} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm text-text">
                <option value="day">รายวัน</option><option value="month">รายเดือน</option><option value="year">รายปี</option>
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setPreset("today")} className="h-10 rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-2">วันนี้</button>
              <button onClick={() => setPreset("month")} className="h-10 rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-2">เดือนนี้</button>
              <button onClick={() => setPreset("year")} className="h-10 rounded-lg border border-border px-3 text-sm text-text hover:bg-surface-2">ปีนี้</button>
            </div>
            <button onClick={() => { setPage(1); void load(); }} disabled={loading} className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-white disabled:opacity-50">{loading ? "กำลังโหลด…" : "แสดงผล"}</button>
          </div>
          <div className="mt-2 text-[11px] text-text-subtle">เลือกวันเดียวได้โดยใช้วันที่เริ่มและสิ้นสุดวันเดียวกัน หรือเลือกหลายวันเป็นช่วงได้ · เขตเวลา Asia/Bangkok</div>
          {errorText && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{errorText}</div>}
        </section>

        <section aria-label="ภาพรวมตัวเลข" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {([
            ["ร่างคำตอบจากบอท", totals.drafts || 0, "conversation"],
            ["เคสขอ handoff", totals.handoff_requested || 0, `อนุมัติ ${totals.handoff_approved || 0} · ไม่อนุมัติ ${totals.handoff_rejected || 0}`],
            ["คำตอบที่ตรวจแล้ว", (totals.approved || 0) + (totals.edited_approved || 0) + (totals.rejected || 0), `รอตรวจ ${totals.pending || 0}`],
            ["ส่งจริงสำเร็จ", totals.live_sent || 0, `switch ปิด ${totals.not_sent_switch_off || 0} · จำลอง ${totals.mock_sent || 0}`],
          ] as Array<[string, number, string]>).map(([title, value, detail]) => (
            <div key={String(title)} className="rounded-xl border border-border bg-surface p-4">
              <div className="text-xs text-text-muted">{title}</div><div className="mt-2 text-2xl font-semibold text-text">{value}</div><div className="mt-1 text-[11px] text-text-subtle">{detail}</div>
            </div>
          ))}
        </section>

        <section className="grid gap-4 xl:grid-cols-2" aria-label="กราฟวิเคราะห์">
          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-4 text-sm font-semibold text-text">ผลการตรวจคำตอบ</h2>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.series || []} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip /> <Legend />
                  <Bar dataKey="approved" name="อนุมัติ" stackId="review" fill="#198754" />
                  <Bar dataKey="edited_approved" name="แก้ไขแล้วอนุมัติ" stackId="review" fill="#2a8fbd" />
                  <Bar dataKey="rejected" name="ไม่อนุมัติ" stackId="review" fill="#cf4848" />
                  <Bar dataKey="pending" name="รอตรวจ" stackId="review" fill="#e4a11b" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-4 text-sm font-semibold text-text">Handoff และผลการส่ง</h2>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.series || []} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip /> <Legend />
                  <Bar dataKey="handoff_requested" name="ขอ handoff" fill="#697b9b" />
                  <Bar dataKey="handoff_approved" name="อนุมัติ handoff" fill="#198754" />
                  <Bar dataKey="handoff_rejected" name="ไม่อนุมัติ handoff" fill="#cf4848" />
                  <Bar dataKey="live_sent" name="ส่งจริงสำเร็จ" fill="#178b80" />
                  <Bar dataKey="not_sent_switch_off" name="อนุมัติแต่ switch ปิด" fill="#e4a11b" />
                  <Bar dataKey="failed_or_unknown" name="ส่งไม่สำเร็จ/ไม่ทราบผล" fill="#b42318" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        <section aria-label="คำถามคำตอบและสถานะ" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><h2 className="text-base font-semibold text-text">คำถาม คำตอบ และประวัติการตรวจ</h2><p className="text-xs text-text-muted">ทั้งหมด {data?.total || 0} รายการ · หน้า {data?.page || 1} จาก {data?.total_pages || 1}</p></div>
            <div className="flex gap-2">
              <button disabled={!data || page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40">ก่อนหน้า</button>
              <button disabled={!data || page >= (data.total_pages || 1) || loading} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40">ถัดไป</button>
            </div>
          </div>
          {data?.items.map((item) => (
            <article key={item.reply_id} className="overflow-hidden rounded-xl border border-border bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs text-text-muted">
                <span>{dateLabel(item.created_at)} · ร้าน {item.shop_id} · แชท {item.conversation_id}</span>
                <span>{item.chat_engine || item.bot_source || "engine ไม่ระบุ"}</span>
              </div>
              <div className="grid gap-4 p-4 lg:grid-cols-2">
                <div><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">คำถามลูกค้า</div><p className="whitespace-pre-wrap break-words text-sm text-text">{item.inbound_text || "(ไม่มีข้อความ)"}</p></div>
                <div><div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">คำตอบจากบอท</div><p className="whitespace-pre-wrap break-words text-sm text-text">{item.bot_reply_text || "(บอทไม่ได้ส่งร่างคำตอบ)"}</p></div>
              </div>
              {(item.bot_handoff_required || item.review_bubbles.length > 0) && (
                <div className="space-y-3 border-t border-border bg-surface-2/60 p-4">
                  {item.bot_handoff_required && <div className="rounded-lg border border-amber-300/40 bg-amber-100/40 p-3 text-sm text-text">
                    <div className="font-semibold">Handoff: {statusLabel(item.handoff_review?.status || "pending")}</div>
                    <div className="mt-1 text-xs">รหัสเหตุผล: {item.handoff_reason || "ไม่ระบุ"} · {item.handoff_explanation || "ไม่มีคำอธิบาย"}</div>
                    {item.handoff_review?.reviewed_by_name && <div className="mt-1 text-xs">ผู้ตรวจ: {item.handoff_review.reviewed_by_name} · ผู้รับ: {item.handoff_review.selected_admin_name || "ยังไม่ได้จ่ายงาน"}</div>}
                    {item.handoff_review?.rejection_reason && <div className="mt-1 text-xs">เหตุผลที่ไม่อนุมัติ: {item.handoff_review.rejection_reason}</div>}
                  </div>}
                  {item.review_bubbles.map((bubble, index) => <div key={`${item.reply_id}:${index}`} className="rounded-lg border border-border bg-surface p-3 text-sm">
                    <div className="mb-2 flex flex-wrap items-center gap-2"><span className="font-medium">คำตอบส่วนที่ {index + 1}</span><span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{statusLabel(bubble.decision)}</span><span className="text-[11px] text-text-muted">{statusLabel(bubble.delivery?.state || "not_requested")}</span></div>
                    <div className="whitespace-pre-wrap break-words">{bubble.original_text}</div>
                    {bubble.edited_text && bubble.edited_text !== bubble.original_text && <div className="mt-2 text-xs text-text-muted">ข้อความที่แก้: <span className="whitespace-pre-wrap text-text">{bubble.edited_text}</span></div>}
                    {bubble.approved_text && <div className="mt-2 text-xs text-text-muted">ข้อความที่อนุมัติ: <span className="whitespace-pre-wrap text-text">{bubble.approved_text}</span></div>}
                    {bubble.rejection_reason && <div className="mt-2 text-xs text-danger">เหตุผลที่ไม่อนุมัติ: {bubble.rejection_reason}</div>}
                    {bubble.decided_by_name && <div className="mt-2 text-[11px] text-text-muted">ผู้ตรวจ: {bubble.decided_by_name}</div>}
                    {bubble.edit_history && bubble.edit_history.length > 0 && <details className="mt-2 border-t border-border pt-2">
                      <summary className="cursor-pointer text-[11px] text-text-muted">ประวัติแก้ไข {bubble.edit_history.length} ครั้ง</summary>
                      <ol className="mt-2 space-y-2">
                        {bubble.edit_history.map((edit, editIndex) => <li key={`${edit.at}:${editIndex}`} className="rounded-md bg-surface-2 p-2 text-xs">
                          <div className="text-text-muted">{edit.actor_name || edit.actor} · {dateLabel(edit.at)}</div>
                          <div className="mt-1 whitespace-pre-wrap break-words"><span className="text-text-muted">ก่อน:</span> {edit.before_text}</div>
                          <div className="mt-1 whitespace-pre-wrap break-words"><span className="text-text-muted">หลัง:</span> {edit.after_text}</div>
                        </li>)}
                      </ol>
                    </details>}
                  </div>)}
                </div>
              )}
              <details className="border-t border-border px-4 py-3">
                <summary className="cursor-pointer text-xs font-medium text-text-muted">ดู timeline การทำงาน ({item.timeline.length} events)</summary>
                <ol className="mt-3 space-y-2 border-l border-border pl-4">
                  {item.timeline.map((event, index) => <li key={`${event.type}:${event.created_at}:${index}`} className="relative text-xs text-text">
                    <span className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-brand" />
                    <div className="font-medium">{event.metadata?.action ? String(event.metadata.action) : event.type} · {event.actor_name || event.actor}</div>
                    <div className="text-text-muted">{dateLabel(event.created_at)}</div>
                    {Boolean(event.metadata?.rejection_reason) && <div className="mt-0.5">เหตุผล: {String(event.metadata?.rejection_reason)}</div>}
                    {Boolean(event.metadata?.assigned_to_name) && <div className="mt-0.5">จ่ายให้: {String(event.metadata?.assigned_to_name)}</div>}
                  </li>)}
                  {item.timeline.length === 0 && <li className="text-text-muted">ไม่มี event ในช่วงเวลานี้</li>}
                </ol>
              </details>
            </article>
          ))}
          {!loading && data?.items.length === 0 && <div className="rounded-xl border border-dashed border-border bg-surface p-8 text-center text-sm text-text-muted">ไม่มีผลตรวจในช่วงเวลานี้</div>}
        </section>
      </div>
    </div>
  );
}

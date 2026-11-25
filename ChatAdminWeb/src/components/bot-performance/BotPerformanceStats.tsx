"use client";
// Bot performance — statistics part: KPI cards, quality/workload trends, edit distribution, top reasons, per-reviewer and per-shop tables
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface PerfSummary {
  truncated: boolean;
  kpi: {
    replies: number; conversations: number; bubbles: number; decided: number;
    approved: number; edited: number; rejected: number; pending: number;
    pass_rate: number; edited_rate: number; rejected_rate: number; avg_edit_pct: number;
    human_replies: number; human_reply_rate: number; human_conversations: number; human_conversation_rate: number;
    handoff_requested: number; handoff_rate: number; handoff_approved: number; handoff_rejected: number; handoff_pending: number; handoff_agree_rate: number;
    median_review_minutes: number | null; live_sent: number; switch_off: number; delivery_failed: number;
  };
  series: { period: string; replies: number; human: number; approved: number; edited: number; rejected: number; pending: number; pass_rate: number; human_rate: number }[];
  edit_buckets: { label: string; count: number }[];
  rejection_reasons: { label: string; count: number }[];
  handoff_reasons: { label: string; count: number }[];
  by_reviewer: { name: string; decided: number; approved: number; edited: number; rejected: number; pass_rate: number; median_review_minutes: number | null; handoffs_reviewed: number; handoffs_received: number }[];
  by_shop: { shop_id: string; replies: number; conversations: number; pass_rate: number; human_rate: number }[];
  reviewers: string[];
  shops: string[];
}

export const OUTCOME_COLORS = { approved: "#198754", edited: "#2a8fbd", rejected: "#cf4848", pending: "#e4a11b" };
const AXIS = { fontSize: 11, fill: "var(--color-text-muted)" };

export function formatMinutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return "< 1 นาที";
  if (value < 60) return `${Math.round(value)} นาที`;
  if (value < 1440) return `${Math.round(value / 6) / 10} ชม.`;
  return `${Math.round(value / 144) / 10} วัน`;
}

function Panel({ title, hint, children, className = "" }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-surface p-4 ${className}`}>
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {hint && <p className="mt-0.5 text-[11px] text-text-subtle">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Kpi({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        {tone && <span className="h-2 w-2 rounded-full" style={{ background: tone }} />}{label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-text">{value}</div>
      <div className="mt-1 text-[11px] leading-snug text-text-subtle">{detail}</div>
    </div>
  );
}

function RankList({ rows, empty, color }: { rows: { label: string; count: number }[]; empty: string; color: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return <p className="py-6 text-center text-xs text-text-subtle">{empty}</p>;
  return (
    <ol className="space-y-2">
      {rows.map((row) => (
        <li key={row.label} className="text-xs">
          <div className="flex justify-between gap-3"><span className="break-words text-text">{row.label}</span><span className="tabular-nums text-text-muted">{row.count}</span></div>
          <div className="mt-1 h-1.5 rounded-full bg-surface-2"><div className="h-full rounded-full" style={{ width: `${(row.count / max) * 100}%`, background: color }} /></div>
        </li>
      ))}
    </ol>
  );
}

const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted";
const td = "px-3 py-2 tabular-nums";

export function BotPerformanceStats({ summary, loading }: { summary: PerfSummary | null; loading: boolean }) {
  if (!summary) {
    return <div className="rounded-xl border border-dashed border-border bg-surface p-10 text-center text-sm text-text-muted">{loading ? "กำลังโหลด…" : "ไม่มีข้อมูล"}</div>;
  }
  const k = summary.kpi;
  if (!k.replies) return <div className="rounded-xl border border-dashed border-border bg-surface p-10 text-center text-sm text-text-muted">ยังไม่มีคำตอบจาก BotWorker ในช่วงเวลานี้</div>;

  return (
    <div className={`space-y-4 ${loading ? "opacity-60" : ""}`}>
      <section aria-label="คุณภาพคำตอบ" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="ผ่านไม่ต้องแก้" tone={OUTCOME_COLORS.approved} value={`${k.pass_rate}%`} detail={`${k.approved} จาก ${k.decided} ข้อความที่ตรวจแล้ว`} />
        <Kpi label="แก้แล้วผ่าน" tone={OUTCOME_COLORS.edited} value={`${k.edited_rate}%`} detail={`${k.edited} ข้อความ · แก้เฉลี่ย ${k.avg_edit_pct}% ของข้อความ`} />
        <Kpi label="ไม่อนุมัติ" tone={OUTCOME_COLORS.rejected} value={`${k.rejected_rate}%`} detail={`${k.rejected} ข้อความ`} />
        <Kpi label="รอตรวจ" tone={OUTCOME_COLORS.pending} value={String(k.pending)} detail={`เวลาตรวจเฉลี่ย (มัธยฐาน) ${formatMinutes(k.median_review_minutes)}`} />
      </section>
      <section aria-label="ภาระงานแอดมิน" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="แชทที่ต้องให้คนจัดการ" value={`${k.human_conversation_rate}%`} detail={`${k.human_conversations} จาก ${k.conversations} แชทที่ BotWorker ตอบ`} />
        <Kpi label="ข้อความที่ต้องให้คนจัดการ" value={`${k.human_reply_rate}%`} detail={`${k.human_replies} จาก ${k.replies} คำตอบของบอท (ถูกแก้ / ไม่ผ่าน / ส่งต่อ)`} />
        <Kpi label="บอทขอส่งต่อแอดมิน" value={`${k.handoff_rate}%`} detail={`${k.handoff_requested} เคส · อนุมัติ ${k.handoff_approved} · ไม่อนุมัติ ${k.handoff_rejected} · รอ ${k.handoff_pending}`} />
        <Kpi label="ส่งต่อถูกเคส" value={`${k.handoff_agree_rate}%`} detail="% ที่แอดมินเห็นด้วยว่าต้องส่งต่อ (จากเคสที่ตัดสินแล้ว)" />
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="แนวโน้มคุณภาพคำตอบ" hint="จำนวนข้อความแยกตามผลตรวจในแต่ละช่วงเวลา">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={summary.series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="period" tick={AXIS} /><YAxis allowDecimals={false} tick={AXIS} />
                <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="approved" name="ผ่านไม่ต้องแก้" stackId="q" fill={OUTCOME_COLORS.approved} />
                <Bar dataKey="edited" name="แก้แล้วผ่าน" stackId="q" fill={OUTCOME_COLORS.edited} />
                <Bar dataKey="rejected" name="ไม่อนุมัติ" stackId="q" fill={OUTCOME_COLORS.rejected} />
                <Bar dataKey="pending" name="รอตรวจ" stackId="q" fill={OUTCOME_COLORS.pending} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="% ผ่านไม่ต้องแก้ เทียบ % ต้องให้คนจัดการ" hint="เส้นเขียวขึ้นและเส้นแดงลง = บอทดีขึ้น แอดมินเบาลง">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={summary.series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="period" tick={AXIS} /><YAxis domain={[0, 100]} unit="%" tick={AXIS} />
                <Tooltip formatter={(v) => `${v}%`} /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="pass_rate" name="ผ่านไม่ต้องแก้" stroke={OUTCOME_COLORS.approved} strokeWidth={2} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="human_rate" name="ต้องให้คนจัดการ" stroke={OUTCOME_COLORS.rejected} strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title="แอดมินแก้มากแค่ไหน" hint="จำนวนข้อความที่ถูกแก้ แยกตาม % ที่เปลี่ยนจากคำตอบบอท">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={summary.edit_buckets} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="label" tick={AXIS} /><YAxis allowDecimals={false} tick={AXIS} />
                <Tooltip /><Bar dataKey="count" name="ข้อความ" fill={OUTCOME_COLORS.edited} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel title="เหตุผลที่แอดมินไม่อนุมัติ" hint="10 อันดับที่เจอบ่อย (คำตอบและ handoff)">
          <RankList rows={summary.rejection_reasons} empty="ยังไม่มีเหตุผลไม่อนุมัติ" color={OUTCOME_COLORS.rejected} />
        </Panel>
        <Panel title="เหตุผลที่บอทขอส่งต่อ" hint="10 อันดับรหัสเหตุผล handoff">
          <RankList rows={summary.handoff_reasons} empty="ยังไม่มีเคสส่งต่อ" color={OUTCOME_COLORS.pending} />
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="รายแอดมิน" hint="ใครตรวจเท่าไหร่ ตัดสินแบบไหน ใช้เวลาเท่าไหร่ และรับงานส่งต่อกี่เคส">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b border-border"><tr>
                <th className={th}>แอดมิน</th><th className={th}>ตรวจ</th><th className={th}>ผ่าน / แก้ / ไม่ผ่าน</th><th className={th}>% ผ่าน</th><th className={th}>เวลาตรวจ</th><th className={th}>ตรวจ handoff</th><th className={th}>รับงาน</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {summary.by_reviewer.map((r) => (
                  <tr key={r.name}>
                    <td className="px-3 py-2 text-text">{r.name}</td><td className={td}>{r.decided}</td>
                    <td className={td}><span style={{ color: OUTCOME_COLORS.approved }}>{r.approved}</span> / <span style={{ color: OUTCOME_COLORS.edited }}>{r.edited}</span> / <span style={{ color: OUTCOME_COLORS.rejected }}>{r.rejected}</span></td>
                    <td className={td}>{r.pass_rate}%</td><td className={td}>{formatMinutes(r.median_review_minutes)}</td><td className={td}>{r.handoffs_reviewed}</td><td className={td}>{r.handoffs_received}</td>
                  </tr>
                ))}
                {!summary.by_reviewer.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-xs text-text-subtle">ยังไม่มีการตรวจ</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="รายร้าน" hint="ร้านไหนบอทตอบได้ดี ร้านไหนยังต้องให้คนช่วยเยอะ">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="border-b border-border"><tr>
                <th className={th}>ร้าน</th><th className={th}>แชท</th><th className={th}>คำตอบ</th><th className={th}>% ผ่าน</th><th className={th}>% ต้องให้คน</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {summary.by_shop.map((s) => (
                  <tr key={s.shop_id}>
                    <td className="px-3 py-2 text-text">{s.shop_id}</td><td className={td}>{s.conversations}</td><td className={td}>{s.replies}</td>
                    <td className={td}>{s.pass_rate}%</td><td className={td}>{s.human_rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <p className="text-[11px] text-text-subtle">
        ส่งจริงสำเร็จ {k.live_sent} · อนุมัติแต่สวิตช์ส่งจริงปิด {k.switch_off} · ส่งไม่สำเร็จ/ไม่ทราบผล {k.delivery_failed} ·
        "ต้องให้คนจัดการ" = คำตอบที่ถูกแก้ ไม่อนุมัติ หรือส่งต่อแอดมินที่อนุมัติแล้ว
      </p>
    </div>
  );
}

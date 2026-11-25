"use client";
// Bot performance — how well BotWorker answers: review outcome, admin edits, human workload (two parts: stats / Q&A data)
import { useCallback, useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { PageShell } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { api } from "@/lib/apiClient";
import { BotPerformanceStats, type PerfSummary } from "@/components/bot-performance/BotPerformanceStats";
import { BotPerformanceQa } from "@/components/bot-performance/BotPerformanceQa";

export type PerfGroup = "day" | "week" | "month";
export interface PerfScope { from: string; to: string; shop_id: string }

function bangkokDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

const PRESETS: { key: string; label: string; range: () => [string, string]; group: PerfGroup }[] = [
  { key: "today", label: "วันนี้", range: () => [bangkokDate(), bangkokDate()], group: "day" },
  { key: "7d", label: "7 วัน", range: () => [bangkokDate(-6), bangkokDate()], group: "day" },
  { key: "30d", label: "30 วัน", range: () => [bangkokDate(-29), bangkokDate()], group: "day" },
  { key: "month", label: "เดือนนี้", range: () => [`${bangkokDate().slice(0, 7)}-01`, bangkokDate()], group: "day" },
  { key: "year", label: "ปีนี้", range: () => [`${bangkokDate().slice(0, 4)}-01-01`, bangkokDate()], group: "month" },
];

export default function BotPerformancePage() {
  const [scope, setScope] = useState<PerfScope>({ from: bangkokDate(-6), to: bangkokDate(), shop_id: "" });
  const [group, setGroup] = useState<PerfGroup>("day");
  const [tab, setTab] = useState<"stats" | "qa">("stats");
  const [summary, setSummary] = useState<PerfSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");

  const load = useCallback(async () => {
    if (!scope.from || !scope.to || scope.from > scope.to) { setErrorText("กรุณาเลือกช่วงวันที่ให้ถูกต้อง"); return; }
    setLoading(true); setErrorText("");
    try {
      const r = await api().get<PerfSummary>("/bot-performance", { params: { view: "summary", group, ...scope } });
      setSummary(r.data);
    } catch (e) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setErrorText(err.response?.data?.detail || err.message || "โหลดข้อมูลไม่สำเร็จ");
      setSummary(null);
    } finally { setLoading(false); }
  }, [scope, group]);

  useEffect(() => { void load(); }, [load]);

  const activePreset = PRESETS.find((p) => { const [from, to] = p.range(); return from === scope.from && to === scope.to; })?.key;
  const dateInput = "h-9 rounded-lg border border-border bg-surface px-2.5 text-sm text-text";

  const filterBar = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1" role="group" aria-label="ช่วงเวลาลัด">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => { const [from, to] = p.range(); setScope((s) => ({ ...s, from, to })); setGroup(p.group); }}
              className={`h-7 rounded-md px-3 text-xs font-medium transition-colors ${activePreset === p.key ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text"}`}>
              {p.label}
            </button>
          ))}
        </div>
        <input aria-label="วันที่เริ่ม" type="date" value={scope.from} max={scope.to} onChange={(e) => setScope((s) => ({ ...s, from: e.target.value }))} className={dateInput} />
        <span className="text-xs text-text-subtle">ถึง</span>
        <input aria-label="วันที่สิ้นสุด" type="date" value={scope.to} min={scope.from} onChange={(e) => setScope((s) => ({ ...s, to: e.target.value }))} className={dateInput} />
        <SelectField density="compact" aria-label="จัดกลุ่มกราฟ" value={group} onChange={(e) => setGroup(e.target.value as PerfGroup)} className="w-auto">
          <option value="day">รายวัน</option><option value="week">รายสัปดาห์</option><option value="month">รายเดือน</option>
        </SelectField>
        <SelectField density="compact" aria-label="ร้าน" value={scope.shop_id} onChange={(e) => setScope((s) => ({ ...s, shop_id: e.target.value }))} className="w-auto min-w-36">
          <option value="">ทุกร้าน</option>
          {[...new Set([...(summary?.shops || []), scope.shop_id].filter(Boolean))].map((id) => <option key={id} value={id}>ร้าน {id}</option>)}
        </SelectField>
      </div>
      <div role="tablist" aria-label="ส่วนของหน้า" className="flex gap-1 border-b border-border -mb-1">
        {([["stats", "สถิติและกราฟ"], ["qa", "ข้อมูลถามตอบ"]] as const).map(([key, label]) => (
          <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${tab === key ? "border-accent text-accent" : "border-transparent text-text-muted hover:text-text"}`}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <PageShell
      icon={BarChart3}
      title="ผลงานบอท"
      subtitle="บอทตอบได้ดีแค่ไหน แอดมินต้องแก้มากไหม และงานที่ต้องให้คนจัดการมีกี่ % ของทั้งหมด · เวลาประเทศไทย"
      actions={<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? "animate-spin" : ""} />รีเฟรช</Button>}
      filterBar={filterBar}
    >
      {errorText && <div role="alert" className="rounded-lg bg-error-soft px-3 py-2 text-sm text-error">{errorText}</div>}
      {summary?.truncated && <div className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-dark">ช่วงเวลานี้มีข้อมูลเกิน 20,000 คำตอบ ระบบนับเฉพาะ 20,000 รายการล่าสุด กรุณาเลือกช่วงให้สั้นลงเพื่อดูตัวเลขครบ</div>}
      {tab === "stats"
        ? <BotPerformanceStats summary={summary} loading={loading} />
        : <BotPerformanceQa scope={scope} reviewers={summary?.reviewers || []} />}
    </PageShell>
  );
}

"use client";
// Generation pipeline — build status + admin accept (R1)
//   header: next scheduled build (daily 09:00 / จันทร์=weekly, Asia/Bangkok) + last build
//   cards: pixel-cat progress + per-step bars + ETA; expand = files/manifest/log + rollback
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/ui/PageShell";
import { Loading } from "@/components/ui/Loading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { confirm } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/apiClient";
import { useToastError, toast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { BuildProgressCat } from "@/components/generations/BuildProgressCat";
import { GenTracks } from "@/components/generations/GenTracks";

const API = "/chatbot/shopee/admin/generations";
const STEP_ORDER = [
  "export", "image_texts_sellable", "image_texts_nonsellable",
  "sellable_units", "unit_embeddings", "product_embeddings",
  "description_embeddings", "import_db", "validate",
];
const STEP_LABEL: Record<string, string> = {
  export: "Export สินค้า", image_texts_sellable: "OCR รูป (ขายได้)",
  image_texts_nonsellable: "OCR รูป (ไม่ขาย)", sellable_units: "สร้าง units",
  unit_embeddings: "Unit vectors", product_embeddings: "Product vectors",
  description_embeddings: "Description vectors", import_db: "Import DB",
  validate: "Validate + Manifest",
};

type StepInfo = { name: string; status: string; percent?: number | null;
                  error?: string | null; carried_from?: string };
type Run = {
  _id: string; generation_id?: string; build_kind?: string; status: string;
  current_step?: string; steps?: Record<string, StepInfo>;
  duration_s?: number; error?: string; created_at?: string;
  updated_at?: string; description_source_gid?: string; published_by?: string;
  pid_alive?: boolean;
};
type Detail = {
  run: Run; build_log_tail: { ts?: string; step?: string; status?: string }[];
  files: { name: string; size: number }[];
  manifest: { counts?: Record<string, number | string[] | boolean> } | null;
  pointer_active?: string; pointer_previous?: string;
};

const STATUS_COLOR: Record<string, string> = {
  building: "bg-blue-100 text-blue-700", pending: "bg-amber-100 text-amber-700",
  published: "bg-green-100 text-green-700", failed: "bg-red-100 text-red-700",
  stopped: "bg-orange-100 text-orange-700",
  discarded: "bg-gray-100 text-gray-500",
};

function fmtDur(s?: number) {
  if (s == null) return "-";
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : m ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}
function fmtTs(iso?: string) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
}
function fmtSize(b: number) {
  return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB`
    : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}

/** เวลา build ถัดไป — daily 09:00 Asia/Bangkok (จันทร์ = weekly) */
function nextRun(): { at: Date; kind: string } {
  const now = new Date();
  const bkk = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const t = new Date(bkk); t.setHours(9, 0, 0, 0);
  if (t <= bkk) t.setDate(t.getDate() + 1);
  const kind = t.getDay() === 1 ? "weekly (มี description build)" : "daily";
  const diff = (t.getTime() - bkk.getTime()) / 1000 +
    (now.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" })).getTime()) / 1000;
  return { at: new Date(now.getTime() + Math.max(diff, 0) * 1000), kind };
}

function StepBar({ info }: { info: StepInfo | undefined }) {
  if (!info) return <div className="h-1.5 rounded bg-border/40" />;
  const pct = info.status === "done" ? 100 : (info.percent ?? 0);
  const color = info.status === "failed" ? "bg-red-500"
    : info.status === "done" ? "bg-green-500" : "bg-blue-500";
  return (
    <div className="h-1.5 rounded bg-border/40 overflow-hidden">
      <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function RunDetail({ gid }: { gid: string }) {
  const [d, setD] = useState<Detail | null>(null);
  useEffect(() => {
    api().get<Detail>(`${API}/${encodeURIComponent(gid)}`)
      .then((r) => setD(r.data)).catch(() => setD(null));
  }, [gid]);
  if (!d) return <div className="text-[11px] text-muted py-2">กำลังโหลดรายละเอียด…</div>;
  const counts = d.manifest?.counts || {};
  return (
    <div className="mt-3 grid gap-3 md:grid-cols-2 text-[11px]">
      <div>
        <div className="font-semibold mb-1">ไฟล์ใน gen</div>
        {d.files.length === 0 && <div className="text-muted">ไม่มี gen dir</div>}
        {d.files.map((f) => (
          <div key={f.name} className="flex justify-between gap-2 font-mono">
            <span className="truncate">{f.name}</span>
            <span className="text-muted shrink-0">{fmtSize(f.size)}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="font-semibold mb-1">manifest counts</div>
        {Object.keys(counts).length === 0 && <div className="text-muted">ยังไม่มี manifest</div>}
        {Object.entries(counts).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 font-mono">
            <span className="truncate">{k}</span>
            <span className="text-muted shrink-0">{Array.isArray(v) ? v.join("+") : String(v)}</span>
          </div>
        ))}
        <div className="font-semibold mt-3 mb-1">build log (tail)</div>
        <div className="max-h-32 overflow-auto space-y-0.5 font-mono">
          {d.build_log_tail.slice(-12).map((l, i) => (
            <div key={i} className="truncate text-muted">
              {l.ts ? new Date(l.ts).toLocaleTimeString("th-TH") : ""} · {l.step || (l as { event?: string }).event} {l.status}
            </div>
          ))}
          {d.build_log_tail.length === 0 && <div className="text-muted">ไม่มี log</div>}
        </div>
      </div>
    </div>
  );
}

function RunCard({ run, active, previous, editable, busy, onAction, expanded, onToggle }: {
  run: Run; active?: string; previous?: string; editable: boolean; busy: boolean;
  expanded: boolean; onToggle: () => void;
  onAction: (action: string, gid: string) => void;
}) {
  const gid = run._id;
  const steps = run.steps || {};
  const curIdx = STEP_ORDER.indexOf(run.current_step || "");
  const overall = Math.round(
    STEP_ORDER.reduce((a, s) =>
      a + (steps[s]?.status === "done" ? 100 : (steps[s]?.percent ?? 0)), 0)
    / STEP_ORDER.length);
  const elapsed = run.status === "building" && run.created_at
    ? (Date.now() - new Date(run.created_at).getTime()) / 1000 : undefined;
  const eta = run.status === "building" && overall > 0 && elapsed
    ? elapsed * (100 - overall) / overall : undefined;
  const canRollback = gid !== active &&
    (run.status === "published" || gid === previous);
  const dead = run.status === "building" && run.pid_alive === false;
  const liveBuilding = run.status === "building" && run.pid_alive !== false;
  const canStop = liveBuilding;
  const canResume = dead || run.status === "failed" || run.status === "stopped";
  return (
    <div className="border border-border rounded-xl p-4 bg-surface">
      <button type="button" onClick={onToggle}
              className="w-full flex items-center gap-2 flex-wrap text-left">
        <code className="text-xs font-semibold">{gid}</code>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_COLOR[run.status] || ""}`}>
          {run.status}
        </span>
        {dead && <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700">process ตายแล้ว</span>}
        {run.build_kind && <Badge>{run.build_kind}</Badge>}
        {active === gid && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">active</span>}
        {previous === gid && <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">rollback target</span>}
        <span className="ml-auto text-[11px] text-muted">
          {fmtTs(run.created_at)} · {fmtDur(run.duration_s)} {expanded ? "▲" : "▼"}
        </span>
      </button>
      {run.status === "building" && (
        <>
          <BuildProgressCat current={Math.max(curIdx, 0)} total={STEP_ORDER.length} walking={!dead} />
          <div className="space-y-1.5 mt-1">
            {STEP_ORDER.map((s) => (
              <div key={s} className="grid grid-cols-[150px_1fr_42px] items-center gap-2">
                <span className="text-[11px] text-muted truncate">{STEP_LABEL[s]}</span>
                <StepBar info={steps[s]} />
                <span className="text-[10px] text-muted text-right">
                  {steps[s]?.status === "done" ? "✓" :
                   steps[s]?.percent != null ? `${Math.round(steps[s].percent!)}%` : ""}
                </span>
              </div>
            ))}
          </div>
          <div className={`text-[11px] mt-1 ${dead ? "text-red-600" : "text-blue-600"}`}>
            {dead
              ? "build process ตายแล้ว — กด ทำต่อ เพื่อ resume จาก step ที่ตาย"
              : <>กำลังทำ: {STEP_LABEL[run.current_step || ""] || run.current_step || "-"} · รวม {overall}%
                {eta != null && ` · เหลือ ~${fmtDur(eta)}`}</>}
          </div>
        </>
      )}
      {run.error && <div className="text-[11px] text-red-600 mt-2">{run.error}</div>}
      {run.description_source_gid && (
        <div className="text-[11px] text-muted mt-1">description ยืมจาก {run.description_source_gid}</div>
      )}
      {(run.status === "pending" || canRollback || canStop || canResume) && editable && (
        <div className="flex gap-2 pt-3">
          {canStop && (
            <Button size="sm" variant="danger" disabled={busy}
                    onClick={() => onAction("stop", gid)}>
              Stop
            </Button>
          )}
          {canResume && (
            <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => onAction("resume", gid)}>
              ทำต่อ
            </Button>
          )}
          {run.status === "pending" && (
            <>
              <Button size="sm" disabled={busy} onClick={() => onAction("publish", gid)}>
                Accept → Publish
              </Button>
              <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => onAction("discard", gid)}>
                Reject
              </Button>
            </>
          )}
          {canRollback && (
            <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => onAction("rollback", gid)}>
              Rollback ไป gen นี้
            </Button>
          )}
        </div>
      )}
      {run.status === "pending" && !editable && (
        <div className="text-[11px] text-amber-600 pt-2">รอแอดมินที่มีสิทธิ์กด Accept</div>
      )}
      {expanded && <RunDetail gid={gid} />}
    </div>
  );
}

export default function GenerationsPage() {
  const { user } = useAuth();
  const editable = canEditPage(user, "kb");
  const { catchError } = useToastError();
  const [active, setActive] = useState<string>("");
  const [previous, setPrevious] = useState<string>("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [startMode, setStartMode] = useState<"daily" | "weekly">("daily");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const r = await api().get<{ active: string; previous?: string; runs: Run[] }>(API);
      setActive(r.data.active || "");
      setPrevious(r.data.previous || "");
      setRuns(r.data.runs || []);
    } catch (e) {
      if (!quiet) catchError(e, "โหลด generations ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [load]);

  const nxt = useMemo(nextRun, []);
  const lastDone = useMemo(
    () => runs.find((r) => r.status === "published" || r.status === "pending"),
    [runs]);
  const building = runs.find((r) => r.status === "building");
  const liveBuilding = runs.find(
    (r) => r.status === "building" && r.pid_alive !== false);

  const onAction = async (action: string, gid: string) => {
    const meta: Record<string, { title: string; msg: string; okText: string; danger?: boolean }> = {
      publish: { title: "ยืนยัน Publish", okText: "Publish",
        msg: `สลับ pointer ไป ${gid} — บอทจะใช้ข้อมูลชุดใหม่ทันที (rollback ได้)` },
      discard: { title: "ยืนยัน Reject", okText: "ยืนยัน", danger: true,
        msg: `ทิ้ง generation ${gid} (ไฟล์ยังอยู่ ไม่ถูกใช้)` },
      rollback: { title: "ยืนยัน Rollback", okText: "ยืนยัน", danger: true,
        msg: `สลับ pointer กลับไป ${gid} — artifact ทั้งชุดเปลี่ยนด้วยกัน (rollback แบบบางส่วนไม่มี)` },
      stop: { title: "ยืนยัน Stop", okText: "Stop", danger: true,
        msg: `หยุด build ${gid} — step ที่กำลังทำจะตาย ของที่เสร็จแล้วเก็บไว้ กด "ทำต่อ" resume ได้ภายหลัง` },
      resume: { title: "ยืนยันทำต่อ", okText: "ทำต่อ",
        msg: `ทำต่อ build ${gid} จาก step ที่ตาย — step ที่เสร็จแล้วจะไม่ทำซ้ำ` },
    };
    const m = meta[action];
    if (!m) return;
    const ok = await confirm.ask({
      title: m.title, message: m.msg, confirmText: m.okText,
      variant: m.danger ? "danger" : "primary",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api().post(`${API}/${action}?gid=${encodeURIComponent(gid)}`);
      toast.success(action === "publish" ? "Publish แล้ว — pointer สลับ" : "บันทึกแล้ว");
      await load();
    } catch (e) {
      catchError(e, `${action} ไม่สำเร็จ`);
    } finally {
      setBusy(false);
    }
  };

  const onStart = async () => {
    const ok = await confirm.ask({
      title: "ยืนยัน Build เลย",
      message: `สร้าง generation ใหม่และเริ่ม build ${startMode} ทันที — live bot ยังใช้ gen เดิมจนกว่าจะกด Accept`,
      confirmText: "Build",
      variant: "primary",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api().post<{ gid?: string }>(`${API}/start?mode=${startMode}`);
      toast.success(`เริ่ม build ${r.data.gid || ""} แล้ว`);
      await load();
    } catch (e) {
      catchError(e, "เริ่ม build ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell title="Generation Pipeline" subtitle="build → review → publish (pointer สลับเฉพาะตอน Accept)">
      <div className="mb-3 grid gap-2 md:grid-cols-3 text-[12px]">
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="text-muted">active generation</div>
          <code className="font-semibold">{active || "-"}</code>
        </div>
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="text-muted">build รอบถัดไป</div>
          <div className="font-semibold">
            {building ? "กำลัง build อยู่" :
              `${nxt.at.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} · ${nxt.kind}`}
          </div>
          {editable && !liveBuilding && (
            <div className="flex items-center gap-2 mt-2">
              <select value={startMode}
                      onChange={(e) => setStartMode(e.target.value as "daily" | "weekly")}
                      className="text-[11px] border border-border rounded px-1.5 py-1 bg-surface">
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </select>
              <Button size="sm" disabled={busy} onClick={onStart}>
                Build เลย
              </Button>
            </div>
          )}
        </div>
        <div className="border border-border rounded-lg p-3 bg-surface">
          <div className="text-muted">build ล่าสุด</div>
          <div className="font-semibold">
            {lastDone
              ? `${fmtTs(lastDone.created_at)} → เสร็จ ${fmtTs(lastDone.updated_at)}`
              : "ยังไม่มี"}
          </div>
        </div>
      </div>
      <GenTracks runs={runs} active={active} />
      <div className="mt-3" />
      {loading ? <Loading /> : (
        <div className="space-y-3">
          {runs.length === 0 && (
            <div className="border border-dashed border-border rounded-xl p-6 text-center">
              <BuildProgressCat current={0} total={1} walking={false} />
              <div className="text-sm text-muted mt-2">
                ยังไม่มี generation run — รอบแรกจะเริ่ม {nxt.at.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })} ({nxt.kind})
              </div>
            </div>
          )}
          {runs.map((r) => (
            <RunCard key={r._id} run={r} active={active} previous={previous}
                     editable={editable} busy={busy} onAction={onAction}
                     expanded={expanded === r._id}
                     onToggle={() => setExpanded(expanded === r._id ? null : r._id)} />
          ))}
        </div>
      )}
      <div className="mt-4 text-[11px] text-muted">
        หมายเหตุ: rollback สลับ artifact ทั้งชุด (units/product/description/image_texts) — ไม่มี rollback บางส่วน เพราะ pointer อ้างทั้ง bundle
      </div>
    </PageShell>
  );
}

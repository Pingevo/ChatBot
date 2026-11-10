"use client";
// Generation pipeline — build status + admin accept (R1)
//   GET  /api/chatbot/shopee/admin/generations            (list + active)
//   GET  /api/chatbot/shopee/admin/generations/<gid>      (detail + log tail)
//   POST /api/chatbot/shopee/admin/generations/publish|discard|rollback
import React, { useCallback, useEffect, useState } from "react";
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
  description_source_gid?: string; published_by?: string;
};

const STATUS_COLOR: Record<string, string> = {
  building: "bg-blue-100 text-blue-700", pending: "bg-amber-100 text-amber-700",
  published: "bg-green-100 text-green-700", failed: "bg-red-100 text-red-700",
  discarded: "bg-gray-100 text-gray-500",
};

function fmtDur(s?: number) {
  if (!s) return "-";
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : m ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}

function StepBar({ info }: { info: StepInfo | undefined }) {
  if (!info) {
    return <div className="h-1.5 rounded bg-border/40" />;
  }
  const pct = info.status === "done" ? 100 : (info.percent ?? 0);
  const color = info.status === "failed" ? "bg-red-500"
    : info.status === "done" ? "bg-green-500" : "bg-blue-500";
  return (
    <div className="h-1.5 rounded bg-border/40 overflow-hidden">
      <div className={`h-full ${color} transition-all duration-500`}
           style={{ width: `${pct}%` }} />
    </div>
  );
}

function RunCard({ run, active, editable, onAction, busy }: {
  run: Run; active?: string; editable: boolean; busy: boolean;
  onAction: (action: string, gid: string) => void;
}) {
  const gid = run._id;
  const steps = run.steps || {};
  const curIdx = STEP_ORDER.indexOf(run.current_step || "");
  const overall = Math.round(
    STEP_ORDER.reduce((a, s) =>
      a + (steps[s]?.status === "done" ? 100 : (steps[s]?.percent ?? 0)), 0)
    / STEP_ORDER.length);
  return (
    <div className="border border-border rounded-xl p-4 bg-surface space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-xs font-semibold">{gid}</code>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_COLOR[run.status] || ""}`}>
          {run.status}
        </span>
        {run.build_kind && <Badge>{run.build_kind}</Badge>}
        {active === gid && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">active</span>}
        <span className="ml-auto text-[11px] text-muted">{fmtDur(run.duration_s)}</span>
      </div>
      {run.status === "building" && (
        <BuildProgressCat current={Math.max(curIdx, 0)} total={STEP_ORDER.length} walking />
      )}
      {run.status !== "published" && (
        <div className="space-y-1.5">
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
      )}
      {run.status === "building" && (
        <div className="text-[11px] text-blue-600">กำลังทำ: {STEP_LABEL[run.current_step || ""] || run.current_step} · รวม {overall}%</div>
      )}
      {run.error && <div className="text-[11px] text-red-600">{run.error}</div>}
      {run.description_source_gid && (
        <div className="text-[11px] text-muted">description ยืมจาก {run.description_source_gid}</div>
      )}
      {run.status === "pending" && editable && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" disabled={busy} onClick={() => onAction("publish", gid)}>
            Accept → Publish
          </Button>
          <Button size="sm" variant="ghost" disabled={busy}
                  onClick={() => onAction("discard", gid)}>
            Reject
          </Button>
        </div>
      )}
      {run.status === "pending" && !editable && (
        <div className="text-[11px] text-amber-600">รอแอดมินที่มีสิทธิ์กด Accept</div>
      )}
    </div>
  );
}

export default function GenerationsPage() {
  const { user } = useAuth();
  const editable = canEditPage(user, "kb");
  const { catchError } = useToastError();
  const [active, setActive] = useState<string>("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const r = await api().get<{ active: string; runs: Run[] }>(API);
      setActive(r.data.active || "");
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

  const onAction = async (action: string, gid: string) => {
    const isPub = action === "publish";
    const ok = await confirm.ask({
      title: isPub ? "ยืนยัน Publish" : action === "discard" ? "ยืนยัน Reject" : "ยืนยัน Rollback",
      message: isPub
        ? `สลับ pointer ไป ${gid} — บอทจะใช้ข้อมูลชุดใหม่ทันที (rollback ได้)`
        : action === "discard"
        ? `ทิ้ง generation ${gid} (ไฟล์ยังอยู่ ไม่ถูกใช้)`
        : "สลับ pointer กลับไป generation ก่อนหน้า",
      confirmText: isPub ? "Publish" : "ยืนยัน",
      variant: isPub ? "primary" : "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const q = action === "rollback" ? "" : `?gid=${encodeURIComponent(gid)}`;
      await api().post(`${API}/${action}${q}`);
      toast.success(isPub ? "Publish แล้ว — pointer สลับ" : "บันทึกแล้ว");
      await load();
    } catch (e) {
      catchError(e, `${action} ไม่สำเร็จ`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageShell title="Generation Pipeline" subtitle="build → review → publish (pointer สลับเฉพาะตอน Accept)">
      <div className="mb-3 text-[12px] text-muted">
        active: <code className="font-semibold text-text">{active || "-"}</code>
      </div>
      {loading ? <Loading /> : (
        <div className="space-y-3">
          {runs.length === 0 && (
            <div className="text-sm text-muted">ยังไม่มี generation build — build ใหม่จะมาแสดงที่นี่พร้อมปุ่ม Accept</div>
          )}
          {runs.map((r) => (
            <RunCard key={r._id} run={r} active={active} editable={editable}
                     busy={busy} onAction={onAction} />
          ))}
        </div>
      )}
    </PageShell>
  );
}

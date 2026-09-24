"use client";
// Backlog distributor — จ่ายงานค้าง pending_assignment ให้ admin pool ที่เลือกเอง
// superadmin/dev เท่านั้น (API guard: requireSuperadmin)
// flow: เลือก source → เลือก admin pool → preview (ไม่เขียน DB) → confirm commit
import React, { useState, useEffect, useCallback } from "react";
import { Inbox, RefreshCw, Play, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToastError } from "@/components/ui/Toast";
import { api } from "@/lib/apiClient";

type BacklogSource = "ticket" | "botworker";
type BacklogMode = "round_robin_selected" | "least_loaded_selected" | "manual_quota";

interface BacklogItem {
  conversation_id: string;
  shop_id?: string;
  platform?: string;
  assignment_reason?: string;
  pending_since?: string;
}

interface AdminRow {
  admin_id: string;
  name?: string;
  username?: string;
  role: string;
  active: boolean;
  is_accepting_chats?: boolean;
}

interface Plan {
  total_pending: number;
  planned: number;
  skipped: number;
  per_admin: Record<string, number>;
}

const MODE_LABELS: Record<BacklogMode, string> = {
  round_robin_selected: "Round-robin (วนตามลำดับที่เลือก)",
  least_loaded_selected: "Least-loaded (งานน้อยสุดก่อน)",
  manual_quota: "Manual quota (กำหนดจำนวนต่อคน)",
};

export default function BacklogPage() {
  const { catchError } = useToastError();
  const [source, setSource] = useState<BacklogSource>("ticket");
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showPaused, setShowPaused] = useState(false);
  const [mode, setMode] = useState<BacklogMode>("round_robin_selected");
  const [limit, setLimit] = useState(50);
  const [quotas, setQuotas] = useState<Record<string, number>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [committing, setCommitting] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ items: BacklogItem[]; total: number }>("/assignment/backlog", {
        params: { source },
      });
      setItems(r.data.items || []);
    } catch (e) {
      catchError(e, "โหลดงานค้างไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    loadItems();
    setPlan(null);
  }, [loadItems]);

  useEffect(() => {
    api().get<{ users: AdminRow[] }>("/users/list").then((r) => {
      setAdmins((r.data.users || []).filter((u) => u.role === "admin" && u.active));
    }).catch(() => setAdmins([]));
  }, []);

  const visibleAdmins = showPaused ? admins : admins.filter((a) => a.is_accepting_chats !== false);

  function toggleAdmin(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPlan(null);
  }

  async function preview() {
    try {
      const r = await api().post<{ plan: Plan }>("/assignment/backlog/preview", {
        source,
        admin_ids: [...selected],
        mode,
        limit,
        quotas: mode === "manual_quota" ? quotas : undefined,
      });
      setPlan(r.data.plan);
    } catch (e) {
      catchError(e, "preview ไม่สำเร็จ");
    }
  }

  async function commit() {
    if (!plan || plan.planned === 0) return;
    setCommitting(true);
    try {
      const idem = `bw-${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const r = await api().post<{ applied: number; skipped_race: number; idempotent_replay: boolean }>(
        "/assignment/backlog/commit",
        {
          source,
          admin_ids: [...selected],
          mode,
          limit,
          quotas: mode === "manual_quota" ? quotas : undefined,
          idem_key: idem,
        }
      );
      setLastResult(
        `จ่ายสำเร็จ ${r.data.applied} งาน${r.data.skipped_race ? ` (race-skip ${r.data.skipped_race})` : ""}${r.data.idempotent_replay ? " — idempotent replay" : ""}`
      );
      setPlan(null);
      await loadItems();
    } catch (e) {
      catchError(e, "commit ไม่สำเร็จ");
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Inbox size={20} className="text-brand" />
        <h1 className="text-lg font-semibold text-text">งานค้างรอจ่าย (Pending Assignment)</h1>
        <Badge tone="neutral">superadmin/dev</Badge>
      </div>

      {/* Source + refresh */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-lg border border-border overflow-hidden">
          {(["ticket", "botworker"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`px-4 py-2 text-sm transition-colors ${source === s ? "bg-brand text-white" : "bg-surface text-text-muted hover:bg-surface-2"}`}
            >
              {s === "ticket" ? "Tickets จริง" : "Botworker (sandbox)"}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={loadItems} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
        </Button>
        <span className="text-sm text-text-muted">
          ค้างอยู่ <b className="text-text">{items.length}</b> งาน
        </span>
      </div>

      {/* Pending items (compact list) */}
      {items.length > 0 && (
        <div className="rounded-lg border border-border bg-surface max-h-48 overflow-y-auto">
          {items.slice(0, 50).map((it) => (
            <div key={it.conversation_id} className="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-border/50 last:border-0">
              <span className="font-mono text-text-muted">{it.conversation_id.slice(0, 12)}…</span>
              <span className="text-text-subtle">{it.platform}</span>
              <span className="text-text-subtle ml-auto">{it.assignment_reason || "—"}</span>
            </div>
          ))}
          {items.length > 50 && <div className="px-3 py-1.5 text-xs text-text-subtle text-center">…และอีก {items.length - 50} งาน</div>}
        </div>
      )}

      {/* Admin pool */}
      <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">เลือก admin pool ({selected.size} คน)</h2>
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
            <input type="checkbox" checked={showPaused} onChange={(e) => setShowPaused(e.target.checked)} />
            แสดง admin ที่พักรับแชทด้วย
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {visibleAdmins.map((a) => {
            const paused = a.is_accepting_chats === false;
            const sel = selected.has(a.admin_id);
            return (
              <button
                key={a.admin_id}
                onClick={() => toggleAdmin(a.admin_id)}
                className={`px-3 py-1.5 rounded-full border text-xs transition-colors ${
                  sel ? "border-brand bg-brand/10 text-brand" : "border-border bg-surface-2 text-text-muted hover:border-brand/50"
                }`}
              >
                {a.name || a.username}
                {paused && <span className="ml-1 text-[10px] opacity-60">(พักรับ)</span>}
              </button>
            );
          })}
          {visibleAdmins.length === 0 && <span className="text-xs text-text-subtle">ไม่มีแอดมินที่เปิดรับแชท</span>}
        </div>
      </div>

      {/* Mode + limit */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={mode}
          onChange={(e) => { setMode(e.target.value as BacklogMode); setPlan(null); }}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
        >
          {Object.entries(MODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-text-muted">
          จ่ายสูงสุด
          <input
            type="number" min={1} max={500} value={limit}
            onChange={(e) => { setLimit(Number(e.target.value) || 50); setPlan(null); }}
            className="w-20 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text"
          />
          งาน/รอบ
        </label>
        <Button size="sm" variant="outline" onClick={preview} disabled={selected.size === 0 || items.length === 0}>
          <Play size={14} /> Preview
        </Button>
      </div>

      {/* Quota inputs (manual_quota) */}
      {mode === "manual_quota" && selected.size > 0 && (
        <div className="rounded-lg border border-border bg-surface p-3 flex flex-wrap gap-3">
          {[...selected].map((id) => {
            const a = admins.find((x) => x.admin_id === id);
            return (
              <label key={id} className="flex items-center gap-2 text-xs text-text">
                {a?.name || a?.username || id}
                <input
                  type="number" min={0} value={quotas[id] ?? 0}
                  onChange={(e) => { setQuotas((p) => ({ ...p, [id]: Number(e.target.value) || 0 })); setPlan(null); }}
                  className="w-16 rounded border border-border bg-surface-2 px-2 py-1 text-text"
                />
              </label>
            );
          })}
        </div>
      )}

      {/* Plan preview + commit */}
      {plan && (
        <div className="rounded-lg border border-brand/30 bg-brand/5 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-text">แผนจ่ายงาน (ยังไม่เขียน DB)</h3>
          <div className="text-sm text-text-muted">
            ค้างทั้งหมด {plan.total_pending} · จะจ่าย {plan.planned} · เหลือค้าง {plan.skipped}
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(plan.per_admin).map(([id, n]) => {
              const a = admins.find((x) => x.admin_id === id);
              return <Badge key={id} tone="brand">{a?.name || a?.username || id}: {n} งาน</Badge>;
            })}
          </div>
          <Button size="sm" onClick={commit} disabled={committing || plan.planned === 0}>
            <CheckCheck size={14} /> {committing ? "กำลังจ่าย..." : `ยืนยันจ่าย ${plan.planned} งาน`}
          </Button>
        </div>
      )}

      {lastResult && <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success-soft">{lastResult}</div>}
    </div>
  );
}

"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import {
  Users, RefreshCw, Settings, UserPlus, UserMinus, Crown,
  MessageSquare, AlertCircle, Activity, Store, Globe,
  Clock, PauseCircle, PlayCircle,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canManage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import type { Platform } from "@/lib/types";

interface AgentRow {
  admin_id: string;
  name: string;
  username: string;
  role: "superadmin" | "admin" | "dev";
  active: boolean;
  is_active_agent: boolean;
  workload: { open: number; bot: number; handoff: number; pending: number };
  assigned_shops: string[];
}

interface TeamResponse {
  mode: AssignmentMode;
  agents: AgentRow[];
  total_agents: number;
  active_agents: number;
  total_open_conversations: number;
  unassigned: number;
}

type AssignmentMode = "equal_global" | "equal_per_shop" | "equal_per_platform";

interface ShopRow {
  shop_id: string;
  shopname: string;
  platform: Platform;
}

interface ShopTeamRow {
  shop_id: string;
  admin_id: string;
  is_active: boolean;
}

interface PlatformTeamRow {
  platform: string;
  admin_id: string;
  is_active: boolean;
}

// Phase 8 — chat accept status + วันนี้
interface ChatStatusRow {
  admin_id: string;
  name: string;
  username: string;
  role: string;
  current_state: "accepting" | "paused";
  current_since: string | null;
  accepting_ms: number;
  paused_ms: number;
  accepting_sessions: number;
  paused_sessions: number;
}

const modeLabels: Record<AssignmentMode, string> = {
  equal_global: "ทั่วระบบ (Global)",
  equal_per_shop: "ตามร้าน (Per Shop)",
  equal_per_platform: "ตามแพลตฟอร์ม (Per Platform)",
};

const modeDescriptions: Record<AssignmentMode, string> = {
  equal_global: "วนทุก agent ทั้งระบบ 1→2→3→1",
  equal_per_shop: "วนเฉพาะ agent ในทีมของร้านนั้น",
  equal_per_platform: "วนเฉพาะ agent ตามแพลตฟอร์ม (shopee/lazada/tiktok)",
};

const platforms: { value: Platform; label: string; color: string }[] = [
  { value: "shopee", label: "Shopee", color: "#ee4d2d" },
  { value: "tiktok", label: "TikTok", color: "#111827" },
  { value: "lazada", label: "Lazada", color: "#1a2e8c" },
];

type Tab = "overview" | "shop-team" | "platform-team";

export default function TeamPage() {
  const { user } = useAuth();
  const editable = canManage(user); // superadmin or dev only — admin is read-only
  const { catchError } = useToastError();
  const [data, setData] = useState<TeamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  // shop-team state
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [shopTeam, setShopTeam] = useState<ShopTeamRow[]>([]);
  const [selectedShopId, setSelectedShopId] = useState<string>("");
  const [shopTeamLoading, setShopTeamLoading] = useState(false);
  const [shopAgentAdding, setShopAgentAdding] = useState<string | null>(null);

  // platform-team state
  const [platformTeam, setPlatformTeam] = useState<PlatformTeamRow[]>([]);
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>("shopee");
  const [platformTeamLoading, setPlatformTeamLoading] = useState(false);
  const [platformAgentAdding, setPlatformAgentAdding] = useState<string | null>(null);

  // Phase 8 — chat accept status
  const [chatStatus, setChatStatus] = useState<ChatStatusRow[]>([]);
  const [chatStatusLoading, setChatStatusLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<TeamResponse>("/team");
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadShopTeam = useCallback(async () => {
    setShopTeamLoading(true);
    try {
      const [shopsRes, teamRes] = await Promise.all([
        api().get<{ rows: ShopRow[]; total: number }>("/shops"),
        api().get<{ rows: ShopTeamRow[] }>("/assignment/shop-team"),
      ]);
      setShops(shopsRes.data.rows || []);
      setShopTeam(teamRes.data.rows || []);
      if (!selectedShopId && shopsRes.data.rows.length > 0) {
        setSelectedShopId(shopsRes.data.rows[0].shop_id);
      }
    } catch {
      setShops([]);
      setShopTeam([]);
    } finally {
      setShopTeamLoading(false);
    }
  }, [selectedShopId]);

  const loadPlatformTeam = useCallback(async () => {
    setPlatformTeamLoading(true);
    try {
      const r = await api().get<{ rows: PlatformTeamRow[] }>("/assignment/platform-team");
      setPlatformTeam(r.data.rows || []);
    } catch {
      setPlatformTeam([]);
    } finally {
      setPlatformTeamLoading(false);
    }
  }, []);

  // Phase 8 — โหลด chat accept status + เวลาวันนี้
  const loadChatStatus = useCallback(async () => {
    setChatStatusLoading(true);
    try {
      const r = await api().get<{ rows: ChatStatusRow[] }>("/team/chat-status");
      setChatStatus(r.data.rows || []);
    } catch {
      setChatStatus([]);
    } finally {
      setChatStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadChatStatus();
  }, [load, loadChatStatus]);

  useEffect(() => {
    if (tab === "shop-team") loadShopTeam();
    if (tab === "platform-team") loadPlatformTeam();
  }, [tab, loadShopTeam, loadPlatformTeam]);

  async function handleModeChange(mode: AssignmentMode) {
    if (!editable || !data) return;
    if (data.mode === mode) return;
    const ok = await confirm.ask({
      title: "เปลี่ยนโหมดการมอบหมายงาน?",
      message: `เปลี่ยนจาก "${modeLabels[data.mode]}" เป็น "${modeLabels[mode]}" — ระบบจะใช้วิธีมอบหมายงานแบบใหม่ตั้งแต่ตอนนี้`,
      confirmText: "เปลี่ยนโหมด",
    });
    if (!ok) return;
    setSavingMode(true);
    try {
      await api().put("/assignment/config", { mode });
      await load();
      toast.success(`เปลี่ยนโหมดเป็น "${modeLabels[mode]}" แล้ว`);
    } catch (err) {
      catchError(err, "เปลี่ยนโหมดไม่สำเร็จ");
    } finally {
      setSavingMode(false);
    }
  }

  async function handleAddAgentToShop(adminId: string) {
    if (!selectedShopId) return;
    setShopAgentAdding(adminId);
    try {
      await api().post("/assignment/shop-team", { shop_id: selectedShopId, admin_id: adminId });
      await loadShopTeam();
      toast.success("เพิ่ม agent เข้าทีมร้านแล้ว");
    } catch (err) {
      catchError(err, "เพิ่ม agent ไม่สำเร็จ");
    } finally {
      setShopAgentAdding(null);
    }
  }

  async function handleRemoveAgentFromShop(adminId: string) {
    if (!selectedShopId) return;
    const ok = await confirm.ask({
      title: "นำ agent ออกจากทีมร้าน?",
      message: "agent จะไม่รับงานจากร้านนี้อีก (แชทเดิมที่ assign อยู่ยังเป็นของตัวเอง)",
      confirmText: "นำออก",
      variant: "danger",
    });
    if (!ok) return;
    setShopAgentAdding(adminId);
    try {
      await api().delete("/assignment/shop-team", { data: { shop_id: selectedShopId, admin_id: adminId } });
      await loadShopTeam();
      toast.success("นำ agent ออกจากทีมร้านแล้ว");
    } catch (err) {
      catchError(err, "ลบ agent ไม่สำเร็จ");
    } finally {
      setShopAgentAdding(null);
    }
  }

  async function handleAddAgentToPlatform(adminId: string) {
    setPlatformAgentAdding(adminId);
    try {
      await api().post("/assignment/platform-team", { platform: selectedPlatform, admin_id: adminId });
      await loadPlatformTeam();
      toast.success("เพิ่ม agent เข้าทีมแพลตฟอร์มแล้ว");
    } catch (err) {
      catchError(err, "เพิ่ม agent ไม่สำเร็จ");
    } finally {
      setPlatformAgentAdding(null);
    }
  }

  async function handleRemoveAgentFromPlatform(adminId: string) {
    const ok = await confirm.ask({
      title: "นำ agent ออกจากทีมแพลตฟอร์ม?",
      message: "agent จะไม่รับงานจากแพลตฟอร์มนี้อีก",
      confirmText: "นำออก",
      variant: "danger",
    });
    if (!ok) return;
    setPlatformAgentAdding(adminId);
    try {
      await api().delete("/assignment/platform-team", { data: { platform: selectedPlatform, admin_id: adminId } });
      await loadPlatformTeam();
      toast.success("นำ agent ออกจากทีมแพลตฟอร์มแล้ว");
    } catch (err) {
      catchError(err, "ลบ agent ไม่สำเร็จ");
    } finally {
      setPlatformAgentAdding(null);
    }
  }

  // Phase 8 — helpers สำหรับแสดง chat accept status
  const statusOf = (adminId: string): ChatStatusRow | undefined =>
    chatStatus.find((s) => s.admin_id === adminId);

  function formatDuration(ms: number): string {
    if (ms <= 0) return "0 นาที";
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h} ชม. ${m} นาที`;
    return `${m} นาที`;
  }

  function formatSince(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    return formatDuration(diffMs);
  }

  // สรุปรวม stats ทุกคนวันนี้
  const totalAcceptingMs = chatStatus.reduce((sum, s) => sum + s.accepting_ms, 0);
  const totalPausedMs = chatStatus.reduce((sum, s) => sum + s.paused_ms, 0);
  const acceptingCount = chatStatus.filter((s) => s.current_state === "accepting").length;
  const pausedCount = chatStatus.filter((s) => s.current_state === "paused").length;

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loading size={32} />
      </div>
    );
  }

  if (!data) {
    return <EmptyState icon={Users} title="ไม่สามารถโหลดข้อมูลทีมได้" />;
  }

  const sortedAgents = [...data.agents].sort((a, b) => {
    if (a.is_active_agent !== b.is_active_agent) return a.is_active_agent ? -1 : 1;
    return b.workload.open - a.workload.open;
  });

  const selectedShop = shops.find((s) => s.shop_id === selectedShopId);
  const shopTeamAgentIds = shopTeam
    .filter((r) => r.shop_id === selectedShopId && r.is_active)
    .map((r) => r.admin_id);
  const platformTeamAgentIds = platformTeam
    .filter((r) => r.platform === selectedPlatform && r.is_active)
    .map((r) => r.admin_id);

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <Users size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">ทีม & การมอบหมาย</h1>
              <p className="text-xs text-text-muted">
                {data.active_agents} agent ทำงาน · {data.total_open_conversations} งานเปิดอยู่ · {data.unassigned} ยังไม่ได้มอบหมาย
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { load(); loadChatStatus(); }}
            disabled={loading || chatStatusLoading}
          >
            <RefreshCw size={14} className={loading || chatStatusLoading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {/* Read-only banner for admin role */}
        {!editable && (
          <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg p-2.5 text-xs text-text-muted">
            <AlertCircle size={14} className="text-text-subtle" />
            คุณเป็น Admin — ดูได้อย่างเดียว ต้องเป็น SuperAdmin หรือ Dev ถึงจะเปลี่ยนโหมด/จัดทีมได้
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1.5 border-b border-border">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={Activity} label="ภาพรวม" />
          <TabButton active={tab === "shop-team"} onClick={() => setTab("shop-team")} icon={Store} label="จัดทีมร้าน" />
          <TabButton active={tab === "platform-team"} onClick={() => setTab("platform-team")} icon={Globe} label="จัดทีมแพลตฟอร์ม" />
        </div>

        {/* === Tab: Overview === */}
        {tab === "overview" && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard icon={Users} label="Agent ทั้งหมด" value={data.total_agents} sub={`${data.active_agents} ทำงาน`} />
              <SummaryCard
                icon={MessageSquare}
                label="งานเปิดอยู่"
                value={data.total_open_conversations}
                sub={`${data.unassigned} ยังไม่ได้มอบหมาย`}
                tone={data.unassigned > 0 ? "coral" : "brand"}
              />
              <SummaryCard
                icon={PlayCircle}
                label="กำลังรับแชท"
                value={acceptingCount}
                sub={`${pausedCount} คนพัก`}
                tone="brand"
              />
              <SummaryCard
                icon={Clock}
                label="เวลารับแชทวันนี้"
                valueText={formatDuration(totalAcceptingMs)}
                sub={`พัก ${formatDuration(totalPausedMs)}`}
              />
            </div>

            {/* Assignment mode config */}
            {editable && (
              <Card className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Settings size={14} className="text-text-muted" />
                  <h2 className="text-sm font-semibold text-text">โหมดการมอบหมายงาน (Round-Robin)</h2>
                </div>
                <p className="text-xs text-text-muted mb-3">
                  เลือกวิธีแบ่งงาน — แล้วไปที่แท็บ "จัดทีมร้าน" หรือ "จัดทีมแพลตฟอร์ม" เพื่อกำหนด agent
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {(Object.keys(modeLabels) as AssignmentMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => handleModeChange(mode)}
                      disabled={savingMode}
                      className={`text-left p-3 rounded-lg border transition-colors ${
                        data.mode === mode
                          ? "border-brand bg-brand/10"
                          : "border-border bg-surface-2 hover:bg-pale-sky-soft"
                      } ${savingMode ? "opacity-50" : ""}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-text">{modeLabels[mode]}</span>
                        {data.mode === mode && <span className="w-2 h-2 rounded-full bg-brand" />}
                      </div>
                      <div className="text-[11px] text-text-muted">{modeDescriptions[mode]}</div>
                      {(mode === "equal_per_shop" || mode === "equal_per_platform") && (
                        <div className="text-[10px] text-brand mt-1.5">
                          → ไปจัดทีมที่แท็บ{mode === "equal_per_shop" ? "ร้าน" : "แพลตฟอร์ม"}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {/* Agent table */}
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                <Users size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text">รายชื่อ Agent</h2>
                <Badge tone="brand" className="ml-auto">{sortedAgents.length} คน</Badge>
              </div>
              {sortedAgents.length === 0 ? (
                <div className="p-8"><EmptyState icon={Users} title="ไม่มี agent" description="ยังไม่มีผู้ใช้ในระบบ" /></div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-2/50">
                      <th className="text-left px-4 py-2.5 font-medium text-text-muted text-xs">Agent</th>
                      <th className="text-left px-4 py-2.5 font-medium text-text-muted text-xs">บทบาท</th>
                      <th className="text-center px-4 py-2.5 font-medium text-text-muted text-xs">สถานะ</th>
                      <th className="text-center px-4 py-2.5 font-medium text-text-muted text-xs">รับแชท</th>
                      <th className="text-left px-4 py-2.5 font-medium text-text-muted text-xs">เวลาวันนี้</th>
                      <th className="text-center px-4 py-2.5 font-medium text-text-muted text-xs">งานเปิด</th>
                      <th className="text-center px-4 py-2.5 font-medium text-text-muted text-xs">Bot</th>
                      <th className="text-center px-4 py-2.5 font-medium text-text-muted text-xs">Handoff</th>
                      <th className="text-center px-4 py-2.5 font-medium text-text-muted text-xs">Pending</th>
                      <th className="text-left px-4 py-2.5 font-medium text-text-muted text-xs">ร้านที่ดูแล</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAgents.map((a, i) => {
                      const st = statusOf(a.admin_id);
                      const accepting = st?.current_state === "accepting";
                      return (
                      <tr key={a.admin_id} className={`border-b border-border/50 hover:bg-surface-2/30 transition-colors ${i % 2 === 0 ? "" : "bg-surface-2/20"}`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-full bg-brand/15 flex items-center justify-center text-xs font-medium text-brand flex-shrink-0">
                              {a.name?.charAt(0).toUpperCase() || a.username?.charAt(0).toUpperCase() || "?"}
                            </div>
                            <div className="min-w-0">
                              <div className="font-medium text-text truncate">{a.name || a.username}</div>
                              <div className="text-[11px] text-text-muted truncate">@{a.username}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={a.role === "superadmin" ? "brand" : a.role === "dev" ? "pale" : "neutral"}>{a.role}</Badge>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex items-center gap-1 text-xs ${a.is_active_agent ? "text-green-400" : "text-text-subtle"}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${a.is_active_agent ? "bg-green-400" : "bg-text-subtle"}`} />
                            {a.is_active_agent ? "ออนไลน์" : "ปิด"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {st ? (
                            <span className={`inline-flex items-center gap-1 text-xs ${accepting ? "text-green-400" : "text-yellow-500"}`}>
                              {accepting ? <PlayCircle size={12} /> : <PauseCircle size={12} />}
                              <span className={`w-1.5 h-1.5 rounded-full ${accepting ? "bg-green-400" : "bg-yellow-500"}`} />
                              {accepting ? "รับ" : "พัก"}
                            </span>
                          ) : <span className="text-[11px] text-text-subtle">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {st ? (
                            <div className="text-[11px] leading-tight">
                              <div className="text-text-muted">
                                <Clock size={10} className="inline mr-1 text-green-400" />
                                {formatDuration(st.accepting_ms)}
                                <span className="text-text-subtle"> รับ</span>
                              </div>
                              <div className="text-text-subtle mt-0.5">
                                <PauseCircle size={10} className="inline mr-1 text-yellow-500" />
                                {formatDuration(st.paused_ms)} พัก
                              </div>
                              <div className="text-text-subtle mt-0.5">
                                ต่อเนื่อง: {formatSince(st.current_since)}
                              </div>
                            </div>
                          ) : <span className="text-[11px] text-text-subtle">—</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`font-semibold ${a.workload.open > 0 ? "text-text" : "text-text-subtle"}`}>{a.workload.open}</span>
                        </td>
                        <td className="px-4 py-3 text-center text-text-muted">{a.workload.bot}</td>
                        <td className="px-4 py-3 text-center">
                          {a.workload.handoff > 0 ? <span className="text-vibrant-coral font-medium">{a.workload.handoff}</span> : <span className="text-text-subtle">0</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {a.workload.pending > 0 ? <span className="text-yellow-500 font-medium">{a.workload.pending}</span> : <span className="text-text-subtle">0</span>}
                        </td>
                        <td className="px-4 py-3">
                          {a.assigned_shops.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {a.assigned_shops.slice(0, 3).map((s) => (
                                <code key={s} className="text-[10px] text-text-muted bg-surface-2 px-1.5 py-0.5 rounded">{s}</code>
                              ))}
                              {a.assigned_shops.length > 3 && <span className="text-[10px] text-text-subtle">+{a.assigned_shops.length - 3}</span>}
                            </div>
                          ) : <span className="text-[11px] text-text-subtle">—</span>}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>

            {data.unassigned > 0 && (
              <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
                <AlertCircle size={18} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-yellow-200">มี {data.unassigned} การสนทนาที่ยังไม่ได้มอบหมาย</div>
                  <div className="text-xs text-yellow-200/70 mt-0.5">
                    ระบบจะมอบหมายอัตโนมัติตามโหมด {modeLabels[data.mode]} หรือมอบหมายเองได้จากหน้าแชท
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* === Tab: Shop Team === */}
        {tab === "shop-team" && (
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Store size={14} className="text-text-muted" />
              <h2 className="text-sm font-semibold text-text">จัดทีมร้าน — ใครตอบร้านไหน</h2>
            </div>
            <p className="text-xs text-text-muted mb-4">
              เลือกร้าน → เพิ่ม/ลด agent ที่จะรับงานจากร้านนั้น (ใช้กับโหมด "ตามร้าน")
            </p>

            {shopTeamLoading ? (
              <div className="flex justify-center py-8"><Loading size={24} /></div>
            ) : shops.length === 0 ? (
              <EmptyState icon={Store} title="ไม่มีร้านค้า" description="ยังไม่มีร้านในระบบ — รอ Phase 6 sync จาก dbWallet" />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Shop list */}
                <div className="space-y-1.5">
                  <div className="text-xs text-text-muted mb-2">เลือกร้าน</div>
                  <div className="space-y-1 max-h-96 overflow-y-auto">
                    {shops.map((s) => {
                      const count = shopTeam.filter((r) => r.shop_id === s.shop_id && r.is_active).length;
                      return (
                        <button
                          key={s.shop_id}
                          onClick={() => setSelectedShopId(s.shop_id)}
                          className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                            selectedShopId === s.shop_id
                              ? "border-brand bg-brand/10"
                              : "border-border bg-surface-2 hover:bg-pale-sky-soft"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-text truncate">{s.shopname}</div>
                              <div className="text-[11px] text-text-muted capitalize">{s.platform}</div>
                            </div>
                            <Badge tone={count > 0 ? "brand" : "neutral"}>{count} agent</Badge>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Agent assignment for selected shop */}
                <div className="lg:col-span-2">
                  <div className="text-xs text-text-muted mb-2">
                    Agent ของร้าน: {selectedShop?.shopname || "—"}
                  </div>
                  {editable && selectedShopId ? (
                    <div className="space-y-1.5 max-h-96 overflow-y-auto">
                      {sortedAgents.map((a) => {
                        const isInTeam = shopTeamAgentIds.includes(a.admin_id);
                        return (
                          <div key={a.admin_id} className="flex items-center justify-between p-2.5 rounded-lg bg-surface-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-7 h-7 rounded-full bg-brand/15 flex items-center justify-center text-[10px] font-medium text-brand flex-shrink-0">
                                {a.name?.charAt(0).toUpperCase() || "?"}
                              </div>
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-text truncate">{a.name || a.username}</div>
                                <div className="text-[11px] text-text-muted">@{a.username} · {a.role}</div>
                              </div>
                            </div>
                            {isInTeam ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleRemoveAgentFromShop(a.admin_id)}
                                disabled={shopAgentAdding === a.admin_id}
                                className="text-vibrant-coral"
                              >
                                {shopAgentAdding === a.admin_id ? <Loading size={12} /> : <UserMinus size={14} />} ลบ
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleAddAgentToShop(a.admin_id)}
                                disabled={shopAgentAdding === a.admin_id}
                              >
                                {shopAgentAdding === a.admin_id ? <Loading size={12} /> : <UserPlus size={14} />} เพิ่ม
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-text-muted bg-surface-2 rounded-lg p-3">
                      {editable ? "เลือกร้านก่อน" : "ต้องมีสิทธิ์ editor เพื่อจัดทีม"}
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* === Tab: Platform Team === */}
        {tab === "platform-team" && (
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Globe size={14} className="text-text-muted" />
              <h2 className="text-sm font-semibold text-text">จัดทีมแพลตฟอร์ม — ใครตอบแพลตฟอร์มไหน</h2>
            </div>
            <p className="text-xs text-text-muted mb-4">
              เลือกแพลตฟอร์ม → เพิ่ม/ลด agent ที่จะรับงานจากแพลตฟอร์มนั้น (ใช้กับโหมด "ตามแพลตฟอร์ม")
            </p>

            {platformTeamLoading ? (
              <div className="flex justify-center py-8"><Loading size={24} /></div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Platform list */}
                <div className="space-y-1.5">
                  <div className="text-xs text-text-muted mb-2">เลือกแพลตฟอร์ม</div>
                  <div className="space-y-1">
                    {platforms.map((p) => {
                      const count = platformTeam.filter((r) => r.platform === p.value && r.is_active).length;
                      return (
                        <button
                          key={p.value}
                          onClick={() => setSelectedPlatform(p.value)}
                          className={`w-full text-left p-2.5 rounded-lg border transition-colors ${
                            selectedPlatform === p.value
                              ? "border-brand bg-brand/10"
                              : "border-border bg-surface-2 hover:bg-pale-sky-soft"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full" style={{ background: p.color }} />
                              <span className="text-sm font-medium text-text">{p.label}</span>
                            </div>
                            <Badge tone={count > 0 ? "brand" : "neutral"}>{count} agent</Badge>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Agent assignment for selected platform */}
                <div className="lg:col-span-2">
                  <div className="text-xs text-text-muted mb-2">
                    Agent ของแพลตฟอร์ม: {platforms.find((p) => p.value === selectedPlatform)?.label}
                  </div>
                  {editable ? (
                    <div className="space-y-1.5 max-h-96 overflow-y-auto">
                      {sortedAgents.map((a) => {
                        const isInTeam = platformTeamAgentIds.includes(a.admin_id);
                        return (
                          <div key={a.admin_id} className="flex items-center justify-between p-2.5 rounded-lg bg-surface-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-7 h-7 rounded-full bg-brand/15 flex items-center justify-center text-[10px] font-medium text-brand flex-shrink-0">
                                {a.name?.charAt(0).toUpperCase() || "?"}
                              </div>
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-text truncate">{a.name || a.username}</div>
                                <div className="text-[11px] text-text-muted">@{a.username} · {a.role}</div>
                              </div>
                            </div>
                            {isInTeam ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleRemoveAgentFromPlatform(a.admin_id)}
                                disabled={platformAgentAdding === a.admin_id}
                                className="text-vibrant-coral"
                              >
                                {platformAgentAdding === a.admin_id ? <Loading size={12} /> : <UserMinus size={14} />} ลบ
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleAddAgentToPlatform(a.admin_id)}
                                disabled={platformAgentAdding === a.admin_id}
                              >
                                {platformAgentAdding === a.admin_id ? <Loading size={12} /> : <UserPlus size={14} />} เพิ่ม
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-text-muted bg-surface-2 rounded-lg p-3">
                      ต้องมีสิทธิ์ editor เพื่อจัดทีม
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Users; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-brand text-brand"
          : "border-transparent text-text-muted hover:text-text"
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  valueText,
  sub,
  tone = "neutral",
}: {
  icon: typeof Users;
  label: string;
  value?: number;
  valueText?: string;
  sub?: string;
  tone?: "brand" | "coral" | "neutral";
}) {
  const toneClass = tone === "brand" ? "text-brand" : tone === "coral" ? "text-vibrant-coral" : "text-text";
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} className="text-text-muted" />
        <span className="text-xs text-text-muted">{label}</span>
      </div>
      <div className={`text-lg font-bold ${toneClass}`}>
        {valueText !== undefined ? valueText : value ?? 0}
      </div>
      {sub && <div className="text-[11px] text-text-subtle mt-0.5">{sub}</div>}
    </Card>
  );
}

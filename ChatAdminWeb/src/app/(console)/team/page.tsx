"use client";
import { useState, useEffect, useCallback, Fragment, useMemo } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import {
  Users, RefreshCw, Settings,
  MessageSquare, AlertCircle, Activity, Store, Globe,
  Clock, PauseCircle, PlayCircle, ChevronDown,
  TrendingUp, CheckCircle, Inbox, Send, Check, LayoutGrid,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { UnifiedDateRangePicker, rangeToParams, type DateRangeValue } from "@/components/ui/UnifiedDateRangePicker";
import type { Platform } from "@/lib/types";

interface AgentShopDetail {
  shop_id: string;
  shopname: string;
  platform: string;
}

interface AgentHistory {
  assigned: number;
  closed: number;
  reopened: number;
  handoff: number;
  replied: number;
  resolved: number;
}

interface AgentRow {
  admin_id: string;
  name: string;
  username: string;
  role: "superadmin" | "admin" | "dev";
  active: boolean;
  is_active_agent: boolean;
  workload: { all: number; active: number; closed: number };
  assigned_shops: string[];
  assigned_shops_detail?: AgentShopDetail[];
  assigned_platforms?: string[];
  history?: AgentHistory;
}

interface TeamResponse {
  mode: AssignmentMode;
  agents: AgentRow[];
  total_agents: number;
  active_agents: number;
  total_open_conversations: number;
  unassigned: number;
  unassigned_handoff?: number;
  unassigned_open?: number;
  total_conversations?: number;
  date_range?: { start: string | null; end: string | null; range: string };
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
type TeamFilter = "all" | "in" | "out";

const roleTone = (role: string): "brand" | "pale" | "neutral" =>
  role === "superadmin" ? "brand" : role === "dev" ? "pale" : "neutral";

export default function TeamPage() {
  const { user } = useAuth();
  const editable = canEditPage(user, "team"); // superadmin or dev only — admin is read-only
  const { catchError } = useToastError();
  const [data, setData] = useState<TeamResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [shopFilter, setShopFilter] = useState<TeamFilter>("all");
  const [platformFilter, setPlatformFilter] = useState<TeamFilter>("all");
  const [shopPlatformFilter, setShopPlatformFilter] = useState<"all" | Platform>("all");
  const [overviewPlatformFilter, setOverviewPlatformFilter] = useState<"all" | Platform>("all");
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

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

  // ⚡ date range สำหรับ historical stats
  const [dateRange, setDateRange] = useState<DateRangeValue>({
    preset: "daily",
    startDate: null,
    endDate: null,
  });

  const dateParams = useMemo(() => rangeToParams(dateRange), [dateRange]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<TeamResponse>("/team", { params: dateParams });
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [dateParams]);

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

  // ⚡ Lazy-load: โหลด shops/shopTeam/platformTeam เฉพาะตอนเปิด tab นั้นๆ (ไม่โหลดตอน mount)
  //   - ก่อนหน้านี้โหลดทั้งหมดตอน mount ทำให้หน้าโหลดช้า
  //   - overview tab ไม่ต้องใช้ shops/shopTeam/platformTeam (ข้อมูลมาจาก /team API แล้ว)
  // ⚡ รีเฟรชข้อมูลตอนสลับ tab (เพื่อให้ tab shop-team/platform-team มีข้อมูลสด)
  useEffect(() => {
    if (tab === "shop-team") loadShopTeam();
    if (tab === "platform-team") loadPlatformTeam();
  }, [tab, loadShopTeam, loadPlatformTeam]);

  // ⚡ derived: shops กรองตาม platform filter (ใช้ใน tab shop-team)
  const filteredShops = shopPlatformFilter === "all"
    ? shops
    : shops.filter((s) => s.platform === shopPlatformFilter);

  // เมื่อ platform filter เปลี่ยน → เลือกร้านแรกของแพลตฟอร์มนั้น
  useEffect(() => {
    if (tab !== "shop-team") return;
    if (filteredShops.length > 0 && !filteredShops.some((s) => s.shop_id === selectedShopId)) {
      setSelectedShopId(filteredShops[0].shop_id);
    }
  }, [shopPlatformFilter, filteredShops, selectedShopId, tab]);

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
      // 🔒 P4e: Undo — re-add agent to shop
      toast.success("นำ agent ออกจากทีมร้านแล้ว", 6000, {
        label: "กู้คืน",
        onClick: () => handleAddAgentToShop(adminId),
      });
    } catch (err) {
      catchError(err, "ลบ agent ไม่สำเร็จ");
    } finally {
      setShopAgentAdding(null);
    }
  }

  // ⚡ รับ platform เป็น parameter — ก่อนหน้านี้ matrix เรียกด้วย selectedPlatform ตลอด (bug: ทุกช่องเขียนลง shopee)
  async function handleAddAgentToPlatform(adminId: string, platform: Platform) {
    setPlatformAgentAdding(adminId);
    try {
      await api().post("/assignment/platform-team", { platform, admin_id: adminId });
      await loadPlatformTeam();
      toast.success("เพิ่ม agent เข้าทีมแพลตฟอร์มแล้ว");
    } catch (err) {
      catchError(err, "เพิ่ม agent ไม่สำเร็จ");
    } finally {
      setPlatformAgentAdding(null);
    }
  }

  async function handleRemoveAgentFromPlatform(adminId: string, platform: Platform) {
    const ok = await confirm.ask({
      title: "นำ agent ออกจากทีมแพลตฟอร์ม?",
      message: "agent จะไม่รับงานจากแพลตฟอร์มนี้อีก",
      confirmText: "นำออก",
      variant: "danger",
    });
    if (!ok) return;
    setPlatformAgentAdding(adminId);
    try {
      await api().delete("/assignment/platform-team", { data: { platform, admin_id: adminId } });
      await loadPlatformTeam();
      // 🔒 P4e: Undo — re-add agent to platform
      toast.success("นำ agent ออกจากทีมแพลตฟอร์มแล้ว", 6000, {
        label: "กู้คืน",
        onClick: () => handleAddAgentToPlatform(adminId, platform),
      });
    } catch (err) {
      catchError(err, "ลบ agent ไม่สำเร็จ");
    } finally {
      setPlatformAgentAdding(null);
    }
  }

  // Phase 8 — helpers สำหรับแสดง chat accept status
  const statusOf = (adminId: string): ChatStatusRow | undefined =>
    chatStatus.find((s) => s.admin_id === adminId);

  // ⚡ ร้านที่ agent ดูแล — ใช้ข้อมูลจาก API โดยตรง (assigned_shops_detail)
  //    fallback ไป shopTeam state ถ้า API ไม่ส่งมา
  const agentShopsOf = (a: AgentRow): AgentShopDetail[] =>
    a.assigned_shops_detail && a.assigned_shops_detail.length > 0
      ? a.assigned_shops_detail
      : shops
          .filter((s) =>
            shopTeam.some((r) => r.shop_id === s.shop_id && r.admin_id === a.admin_id && r.is_active)
          )
          .map((s) => ({ shop_id: s.shop_id, shopname: s.shopname, platform: s.platform }));

  // ⚡ แพลตฟอร์มที่ agent ดูแล — assigned_platforms ก่อน, fallback platformTeam state
  const agentPlatformValuesOf = (a: AgentRow): string[] =>
    a.assigned_platforms && a.assigned_platforms.length > 0
      ? a.assigned_platforms
      : platformTeam
          .filter((r) => r.admin_id === a.admin_id && r.is_active)
          .map((r) => r.platform);

  // agent ครอบคลุม platform นี้ไหม (ดูแล platform team หรือมีร้านบน platform นั้น)
  const agentCoversPlatform = (a: AgentRow, p: Platform): boolean =>
    agentPlatformValuesOf(a).includes(p) || agentShopsOf(a).some((s) => s.platform === p);

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
    return b.workload.active - a.workload.active;
  });

  // ⚡ overview: กรอง agent ตามแพลตฟอร์มที่เลือก (ครอบคลุม = อยู่ทีมแพลตฟอร์ม หรือมีร้านบนแพลตฟอร์มนั้น)
  const visibleAgents = overviewPlatformFilter === "all"
    ? sortedAgents
    : sortedAgents.filter((a) => agentCoversPlatform(a, overviewPlatformFilter));

  const platformAgentCount = (p: Platform) =>
    sortedAgents.filter((a) => agentCoversPlatform(a, p)).length;

  const selectedShop = shops.find((s) => s.shop_id === selectedShopId);
  const shopTeamAgentIds = shopTeam
    .filter((r) => r.shop_id === selectedShopId && r.is_active)
    .map((r) => r.admin_id);
  const platformTeamAgentIds = platformTeam
    .filter((r) => r.platform === selectedPlatform && r.is_active)
    .map((r) => r.admin_id);

  return (
    <PageShell
      icon={Users}
      title="ทีม & การมอบหมาย"
      helpHref="/help#team"
      subtitle={
        <>
          {data.active_agents} agent ทำงาน · {data.total_open_conversations} งานเปิดอยู่ · {data.unassigned} ยังไม่ได้มอบหมาย
          {data.total_conversations != null && (
            <span className="text-text-subtle"> (รวม {data.total_conversations.toLocaleString()} แชท)</span>
          )}
        </>
      }
      actions={
        <>
          <UnifiedDateRangePicker value={dateRange} onChange={setDateRange} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => { load(); loadChatStatus(); }}
            disabled={loading || chatStatusLoading}
          >
            <RefreshCw size={14} className={loading || chatStatusLoading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </>
      }
    >
      {/* Read-only banner for admin role */}
      {!editable && (
        <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg p-2.5 text-xs text-text-muted">
          <AlertCircle size={14} className="text-text-subtle" />
          คุณเป็น Admin — ดูได้อย่างเดียว ต้องเป็น SuperAdmin หรือ Dev ถึงจะเปลี่ยนโหมด/จัดทีมได้
        </div>
      )}

      {/* Tabs — segmented control */}
      <div role="tablist" aria-label="มุมมองทีม" className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-surface-2/70 p-1">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={Activity} label="ภาพรวม" desc="สถานะ & งานค้าง" />
        <TabButton active={tab === "shop-team"} onClick={() => setTab("shop-team")} icon={Store} label="จัดทีมร้าน" desc="แยกตามร้าน" />
        <TabButton active={tab === "platform-team"} onClick={() => setTab("platform-team")} icon={Globe} label="จัดทีมแพลตฟอร์ม" desc="แยกตามแพลตฟอร์ม" />
      </div>

      {/* === Tab: Overview === */}
      {tab === "overview" && (
        <>
          {/* ⚠️ Unassigned banner — ด้านบน, แดงเลือดหมู (brand) */}
          {data.unassigned > 0 && (
            <div className="flex items-center gap-3 bg-brand border border-brand-dark rounded-xl p-3.5 sm:p-4 shadow-md">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-white/15 flex items-center justify-center shrink-0">
                <AlertCircle size={20} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-white">
                  มี {data.unassigned.toLocaleString()} การสนทนาที่ยังไม่ได้มอบหมาย
                </div>
                <div className="text-xs text-white/80 mt-0.5">
                  {(data.unassigned_handoff ?? 0) > 0 && (
                    <span className="font-semibold text-white">รอแอดมินรับ {data.unassigned_handoff?.toLocaleString()} · </span>
                  )}
                  {(data.unassigned_open ?? 0) > 0 && (
                    <span>บอทตอบอยู่/ยังไม่มีคนตอบ {data.unassigned_open?.toLocaleString()} · </span>
                  )}
                  ระบบจะมอบหมายอัตโนมัติตามโหมด {modeLabels[data.mode]} หรือมอบหมายเองได้จากหน้าแชท
                </div>
              </div>
              <button
                onClick={() => setTab("shop-team")}
                className="flex items-center gap-1.5 text-xs font-semibold px-2.5 sm:px-3 py-1.5 rounded-lg bg-white text-brand hover:bg-pale-sky-soft transition-colors shrink-0"
              >
                <Store size={12} /> จัดทีม
              </button>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
            <SummaryCard icon={Users} label="Agent ทั้งหมด" value={data.total_agents} sub={`${data.active_agents} ทำงาน`} />
            <SummaryCard
              icon={MessageSquare}
              label="งานเปิดอยู่"
              value={data.total_open_conversations}
              sub={`${data.unassigned.toLocaleString()} ยังไม่ได้มอบหมาย${(data.unassigned_handoff ?? 0) > 0 ? ` (${data.unassigned_handoff} รอรับ)` : ""}`}
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
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
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

          {/* Agent list — card list บน mobile/tablet, table บน lg+ */}
          <Card className="overflow-hidden">
            <div className="px-3 sm:px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-2 gap-y-2">
              <Users size={14} className="text-text-muted" />
              <h2 className="text-sm font-semibold text-text">รายชื่อ Agent</h2>
              <Badge tone="brand">{visibleAgents.length} คน</Badge>
              <span className="text-[11px] text-text-subtle hidden md:inline">กดเพื่อดูร้าน/แพลตฟอร์มที่ดูแล</span>
              {/* ⚡ filter ตามแพลตฟอร์มที่ agent ครอบคลุม */}
              <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto sm:ml-auto pb-0.5 sm:pb-0">
                <FilterChip
                  active={overviewPlatformFilter === "all"}
                  onClick={() => setOverviewPlatformFilter("all")}
                  label="ทั้งหมด"
                  count={sortedAgents.length}
                />
                {platforms.map((p) => (
                  <FilterChip
                    key={p.value}
                    active={overviewPlatformFilter === p.value}
                    onClick={() => setOverviewPlatformFilter(p.value)}
                    label={p.label}
                    count={platformAgentCount(p.value)}
                    platform={p.value}
                  />
                ))}
              </div>
            </div>

            {visibleAgents.length === 0 ? (
              <EmptyState
                icon={Users}
                title="ไม่มี agent"
                description={overviewPlatformFilter === "all" ? "ยังไม่มีผู้ใช้ในระบบ" : "ไม่มี agent ที่ครอบคลุมแพลตฟอร์มนี้"}
              />
            ) : (
              <>
                {/* Mobile / tablet — card list (<lg) */}
                <div className="lg:hidden divide-y divide-border/60">
                  {visibleAgents.map((a, i) => {
                    const st = statusOf(a.admin_id);
                    const isExpanded = expandedAgent === a.admin_id;
                    const agentShops = agentShopsOf(a);
                    const agentPlatforms = platforms.filter((p) => agentPlatformValuesOf(a).includes(p.value));
                    return (
                      <div key={`agent-card-${a.admin_id}-${i}`} className={isExpanded ? "bg-brand/5" : ""}>
                        <button
                          onClick={() => setExpandedAgent(isExpanded ? null : a.admin_id)}
                          className="w-full text-left px-4 py-3.5 space-y-2.5 hover:bg-surface-2/30 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <AgentAvatar name={a.name || a.username} online={a.is_active_agent} size={36} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-semibold text-text truncate">{a.name || a.username}</span>
                                <Badge tone={roleTone(a.role)}>{a.role}</Badge>
                              </div>
                              <div className="text-[11px] text-text-muted truncate flex items-center gap-1.5 mt-0.5">
                                <span className={`inline-flex items-center gap-1 ${a.is_active_agent ? "text-success" : "text-text-subtle"}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${a.is_active_agent ? "bg-success" : "bg-surface-4"}`} />
                                  {a.is_active_agent ? "ออนไลน์" : "ปิด"}
                                </span>
                                <span className="text-text-subtle">@{a.username}</span>
                              </div>
                            </div>
                            <StatusPill st={st} />
                            <ChevronDown size={14} className={`text-text-subtle shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </div>

                          <div className="grid grid-cols-3 gap-1.5">
                            <MiniStat label="เปิดอยู่" value={a.workload.active} highlight={a.workload.active > 0} />
                            <MiniStat label="ทั้งหมด" value={a.workload.all} />
                            <MiniStat label="ปิดแล้ว" value={a.workload.closed} />
                          </div>

                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            {st ? (
                              <span className="flex items-center gap-2.5 text-text-muted min-w-0">
                                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                  <Clock size={10} className="text-success" />
                                  {formatDuration(st.accepting_ms)} รับ
                                </span>
                                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                  <PauseCircle size={10} className="text-warning" />
                                  {formatDuration(st.paused_ms)} พัก
                                </span>
                              </span>
                            ) : (
                              <span className="text-text-subtle">ไม่มีข้อมูลวันนี้</span>
                            )}
                            <CoverageDots agentShops={agentShops} agentPlatforms={agentPlatforms} />
                          </div>
                        </button>
                        {isExpanded && (
                          <div className="px-4 pb-4 animate-fade-in">
                            <AgentExpandedContent
                              hist={a.history}
                              agentShops={agentShops}
                              agentPlatforms={agentPlatforms}
                              dateRange={data.date_range}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Desktop — table (lg+) */}
                <div className="hidden lg:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-surface-2/50 text-[10px] uppercase tracking-wide text-text-subtle">
                        <th rowSpan={2} className="text-left px-4 py-2 font-semibold align-bottom">Agent</th>
                        <th rowSpan={2} className="text-left px-4 py-2 font-semibold align-bottom">สถานะ</th>
                        <th rowSpan={2} className="text-left px-4 py-2 font-semibold align-bottom">เวลาวันนี้</th>
                        <th colSpan={3} className="px-4 py-1.5 text-center font-semibold border-b border-border-subtle">งานที่มอบหมาย</th>
                        <th rowSpan={2} className="text-left px-4 py-2 font-semibold align-bottom">ร้าน & แพลตฟอร์ม</th>
                      </tr>
                      <tr className="bg-surface-2/50 border-b border-border text-[10px] uppercase tracking-wide text-text-subtle">
                        <th className="px-3 py-1.5 text-center font-medium">เปิดอยู่</th>
                        <th className="px-3 py-1.5 text-center font-medium">ทั้งหมด</th>
                        <th className="px-3 py-1.5 text-center font-medium">ปิดแล้ว</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAgents.map((a, i) => {
                        const st = statusOf(a.admin_id);
                        const isExpanded = expandedAgent === a.admin_id;
                        const agentShops = agentShopsOf(a);
                        const agentPlatforms = platforms.filter((p) => agentPlatformValuesOf(a).includes(p.value));
                        return (
                          <Fragment key={`${a.admin_id}-${i}`}>
                            <tr
                              className={`border-b border-border/50 hover:bg-surface-2/30 transition-colors cursor-pointer ${i % 2 === 0 ? "" : "bg-surface-2/20"} ${isExpanded ? "bg-brand/5" : ""}`}
                              onClick={() => setExpandedAgent(isExpanded ? null : a.admin_id)}
                            >
                              {/* Agent */}
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2.5">
                                  <AgentAvatar name={a.name || a.username} online={a.is_active_agent} size={34} />
                                  <div className="min-w-0">
                                    <div className="font-medium text-text truncate">{a.name || a.username}</div>
                                    <div className="text-[11px] text-text-muted truncate flex items-center gap-1.5">
                                      <span>@{a.username}</span>
                                      <Badge tone={roleTone(a.role)}>{a.role}</Badge>
                                    </div>
                                  </div>
                                </div>
                              </td>
                              {/* สถานะ — ออนไลน์ + รับแชท รวมคอลัมน์เดียว */}
                              <td className="px-4 py-3">
                                <div className="flex flex-col items-start gap-1">
                                  <span className={`inline-flex items-center gap-1.5 text-xs ${a.is_active_agent ? "text-success" : "text-text-subtle"}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${a.is_active_agent ? "bg-success" : "bg-surface-4"}`} />
                                    {a.is_active_agent ? "ออนไลน์" : "ปิด"}
                                  </span>
                                  <StatusPill st={st} />
                                </div>
                              </td>
                              {/* เวลาวันนี้ */}
                              <td className="px-4 py-3">
                                {st ? (
                                  <div className="text-[11px] leading-tight">
                                    <div className="text-text-muted">
                                      <Clock size={10} className="inline mr-1 text-success" />
                                      {formatDuration(st.accepting_ms)}
                                      <span className="text-text-subtle"> รับ</span>
                                    </div>
                                    <div className="text-text-subtle mt-0.5">
                                      <PauseCircle size={10} className="inline mr-1 text-warning" />
                                      {formatDuration(st.paused_ms)} พัก
                                    </div>
                                    <div className="text-text-subtle mt-0.5">
                                      ต่อเนื่อง: {formatSince(st.current_since)}
                                    </div>
                                  </div>
                                ) : <span className="text-[11px] text-text-subtle">—</span>}
                              </td>
                              {/* งาน — เปิดอยู่ / ทั้งหมด / ปิดแล้ว */}
                              <td className="px-3 py-3 text-center">
                                {a.workload.active > 0
                                  ? <span className="text-vibrant-coral font-semibold">{a.workload.active}</span>
                                  : <span className="text-text-subtle">0</span>}
                              </td>
                              <td className="px-3 py-3 text-center">
                                <span className={`font-semibold ${a.workload.all > 0 ? "text-text" : "text-text-subtle"}`}>{a.workload.all}</span>
                              </td>
                              <td className="px-3 py-3 text-center">
                                {a.workload.closed > 0
                                  ? <span className="text-text-muted font-medium">{a.workload.closed}</span>
                                  : <span className="text-text-subtle">0</span>}
                              </td>
                              {/* ร้าน & แพลตฟอร์ม */}
                              <td className="px-4 py-3">
                                <div className="flex flex-wrap items-center gap-1 max-w-[240px]">
                                  {agentPlatforms.map((p) => (
                                    <span key={p.value} className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} title={p.label} />
                                  ))}
                                  {agentShops.slice(0, 2).map((s, si) => (
                                    <span key={`shop-${a.admin_id}-${si}`} className="text-[10px] text-text-muted bg-surface-2 px-1.5 py-0.5 rounded max-w-[120px] truncate">{s.shopname}</span>
                                  ))}
                                  {agentShops.length > 2 && <span className="text-[10px] text-text-subtle">+{agentShops.length - 2}</span>}
                                  {agentShops.length === 0 && agentPlatforms.length === 0 && (
                                    <span className="text-[11px] text-text-subtle">ทั่วระบบ</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-surface-2/40">
                                <td colSpan={7} className="px-4 py-4">
                                  <div className="ml-6 animate-fade-in">
                                    <AgentExpandedContent
                                      hist={a.history}
                                      agentShops={agentShops}
                                      agentPlatforms={agentPlatforms}
                                      dateRange={data.date_range}
                                    />
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        </>
      )}

      {/* === Tab: Shop Team === */}
      {tab === "shop-team" && (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
              <Store size={15} className="text-brand" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text">จัดทีมร้าน — ใครตอบร้านไหน</h2>
              <p className="text-[11px] text-text-muted">ใช้กับโหมด "ตามร้าน" · เลือกร้านแล้วเปิด/ปิด agent</p>
            </div>
          </div>

          {shopTeamLoading ? (
            <div className="flex justify-center py-8"><Loading size={24} /></div>
          ) : shops.length === 0 ? (
            <EmptyState icon={Store} title="ไม่มีร้านค้า" description="ยังไม่มีร้านในระบบ" />
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] gap-4 items-start">
                {/* คอลัมน์ซ้าย — platform filter + ตัวเลือกร้าน */}
                <div className="space-y-3 min-w-0">
                  {/* Platform filter chips */}
                  <div className="flex lg:flex-wrap items-center gap-1.5 overflow-x-auto pb-0.5">
                    <FilterChip
                      active={shopPlatformFilter === "all"}
                      onClick={() => setShopPlatformFilter("all")}
                      label="ทั้งหมด"
                      count={shops.length}
                    />
                    {platforms.map((p) => (
                      <FilterChip
                        key={p.value}
                        active={shopPlatformFilter === p.value}
                        onClick={() => setShopPlatformFilter(p.value)}
                        label={p.label}
                        count={shops.filter((s) => s.platform === p.value).length}
                        platform={p.value}
                      />
                    ))}
                  </div>

                  {/* Mobile/tablet — shop dropdown */}
                  <Card className="p-3 lg:hidden">
                    <label className="text-[11px] font-medium text-text-muted">ร้าน</label>
                    <div className="relative mt-1.5">
                      <select
                        value={selectedShopId}
                        onChange={(e) => setSelectedShopId(e.target.value)}
                        className="w-full appearance-none bg-surface-2 border border-border rounded-lg px-3 py-2 pr-9 text-sm text-text focus:outline-none focus:border-brand cursor-pointer"
                      >
                        {filteredShops.map((s, si) => {
                          const count = shopTeam.filter((r) => r.shop_id === s.shop_id && r.is_active).length;
                          return (
                            <option key={`${s.shop_id}-${si}`} value={s.shop_id}>
                              {s.shopname} ({s.platform}) — {count} agent
                            </option>
                          );
                        })}
                      </select>
                      <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                    </div>
                  </Card>

                  {/* Desktop — รายการร้าน grouped by platform */}
                  <Card className="hidden lg:block overflow-hidden">
                    <div className="px-3 py-2.5 border-b border-border bg-surface-2/50 flex items-center justify-between">
                      <span className="text-xs font-semibold text-text">ร้านค้า</span>
                      <span className="text-[11px] text-text-subtle">{filteredShops.length} ร้าน</span>
                    </div>
                    <div className="max-h-[520px] overflow-y-auto">
                      {filteredShops.length === 0 && (
                        <div className="py-8 text-center text-xs text-text-subtle">ไม่มีร้านในแพลตฟอร์มนี้</div>
                      )}
                      {platforms
                        .filter((p) => shopPlatformFilter === "all" || p.value === shopPlatformFilter)
                        .map((p) => {
                          const group = filteredShops.filter((s) => s.platform === p.value);
                          if (group.length === 0) return null;
                          return (
                            <div key={p.value}>
                              <div className="sticky top-0 z-[1] px-3 py-1.5 bg-surface-2/90 backdrop-blur text-[10px] font-semibold uppercase tracking-wide text-text-subtle flex items-center gap-1.5 border-y border-border-subtle">
                                <PlatformIcon platform={p.value} size={12} />
                                {p.label} · {group.length}
                              </div>
                              {group.map((s, si) => {
                                const count = shopTeam.filter((r) => r.shop_id === s.shop_id && r.is_active).length;
                                const selected = s.shop_id === selectedShopId;
                                return (
                                  <button
                                    key={`${s.shop_id}-${si}`}
                                    onClick={() => setSelectedShopId(s.shop_id)}
                                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-left border-l-2 transition-colors ${
                                      selected
                                        ? "border-brand bg-brand/5"
                                        : "border-transparent hover:bg-surface-2/40"
                                    }`}
                                  >
                                    <span className={`flex-1 min-w-0 text-sm truncate ${selected ? "font-semibold text-text" : "text-text-muted"}`}>
                                      {s.shopname}
                                    </span>
                                    <Badge tone={count > 0 ? "brand" : "neutral"}>{count}</Badge>
                                  </button>
                                );
                              })}
                            </div>
                          );
                        })}
                    </div>
                  </Card>
                </div>

                {/* คอลัมน์ขวา — agent list ของร้านที่เลือก */}
                {selectedShopId ? (
                  <Card className="overflow-hidden">
                    {/* Selected shop summary */}
                    <div className="px-4 py-3 border-b border-border flex items-center gap-2.5">
                      {selectedShop && <PlatformIcon platform={selectedShop.platform} size={22} />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-text truncate">{selectedShop?.shopname || "ร้านที่เลือก"}</div>
                        <div className="text-[11px] text-text-muted capitalize">{selectedShop?.platform}</div>
                      </div>
                      <Badge tone="brand" className="shrink-0">{shopTeamAgentIds.length} agent</Badge>
                    </div>

                    {/* Filter sub-tabs */}
                    <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-surface-2/50 overflow-x-auto">
                      <SubFilterTabs
                        value={shopFilter}
                        onChange={setShopFilter}
                        counts={{
                          all: sortedAgents.length,
                          in: shopTeamAgentIds.length,
                          out: sortedAgents.length - shopTeamAgentIds.length,
                        }}
                      />
                      <div className="ml-auto text-[10px] text-text-subtle whitespace-nowrap pl-2">
                        กดสวิตช์เพื่อเพิ่ม/นำออก
                      </div>
                    </div>

                    {/* Agent rows */}
                    <div className="divide-y divide-border/50 max-h-[480px] overflow-y-auto">
                      {sortedAgents
                        .filter((a) => {
                          const isIn = shopTeamAgentIds.includes(a.admin_id);
                          if (shopFilter === "in") return isIn;
                          if (shopFilter === "out") return !isIn;
                          return true;
                        })
                        .map((a, i) => {
                          const isInTeam = shopTeamAgentIds.includes(a.admin_id);
                          const busy = shopAgentAdding === a.admin_id;
                          return (
                            <AgentToggleRow
                              key={`shop-${a.admin_id}-${i}`}
                              agent={a}
                              isInTeam={isInTeam}
                              busy={busy}
                              disabled={!editable}
                              onToggle={() => isInTeam ? handleRemoveAgentFromShop(a.admin_id) : handleAddAgentToShop(a.admin_id)}
                            />
                          );
                        })}
                      {sortedAgents.filter((a) => {
                        const isIn = shopTeamAgentIds.includes(a.admin_id);
                        if (shopFilter === "in") return isIn;
                        if (shopFilter === "out") return !isIn;
                        return true;
                      }).length === 0 && (
                        <div className="py-8 text-center text-xs text-text-subtle">
                          {shopFilter === "in" ? "ยังไม่มี agent ในทีมนี้" : "เพิ่ม agent ครบแล้ว"}
                        </div>
                      )}
                    </div>
                  </Card>
                ) : (
                  <Card className="p-2">
                    <EmptyState icon={Store} title="เลือกร้านก่อน" description="เลือกร้านจากรายการด้านซ้าย" />
                  </Card>
                )}
              </div>

              {!editable && (
                <div className="flex items-center gap-2 text-[11px] text-text-subtle bg-surface-2 rounded-lg px-3 py-2">
                  <AlertCircle size={12} /> คุณเป็น Admin — ดูได้อย่างเดียว
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* === Tab: Platform Team === */}
      {tab === "platform-team" && (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
              <Globe size={15} className="text-brand" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text">จัดทีมแพลตฟอร์ม — ใครตอบแพลตฟอร์มไหน</h2>
              <p className="text-[11px] text-text-muted">ใช้กับโหมด "ตามแพลตฟอร์ม" · เลือกแพลตฟอร์มแล้วเปิด/ปิด agent</p>
            </div>
          </div>

          {platformTeamLoading ? (
            <div className="flex justify-center py-8"><Loading size={24} /></div>
          ) : (
            <>
              {/* Platform selector cards — กดเพื่อเลือกแพลตฟอร์ม */}
              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {platforms.map((p) => {
                  const count = platformTeam.filter((r) => r.platform === p.value && r.is_active).length;
                  const selected = selectedPlatform === p.value;
                  return (
                    <button
                      key={p.value}
                      onClick={() => setSelectedPlatform(p.value)}
                      aria-pressed={selected}
                      className={`relative flex flex-col items-center gap-1.5 sm:gap-2 rounded-xl border p-3 sm:p-4 transition-all ${
                        selected
                          ? "border-brand bg-brand/5 shadow-[var(--shadow-sm)]"
                          : "border-border bg-surface hover:border-border-strong hover:bg-surface-1"
                      }`}
                    >
                      <PlatformIcon platform={p.value} size={26} />
                      <div>
                        <div className="text-sm font-semibold text-text">{p.label}</div>
                        <div className="text-[11px] text-text-muted">{count} agent</div>
                      </div>
                      {selected && (
                        <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-brand text-white flex items-center justify-center">
                          <Check size={10} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Desktop — matrix view: agents × platforms (lg+) */}
              <Card className="hidden lg:block overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                  <LayoutGrid size={14} className="text-text-muted" />
                  <h3 className="text-sm font-semibold text-text">เมทริกซ์ทีม — agent × แพลตฟอร์ม</h3>
                  <span className="text-[10px] text-text-subtle ml-auto">กดสวิตช์เพื่อเพิ่ม/นำออก</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface-2/50">
                        <th className="text-left px-4 py-3 font-medium text-text-muted text-xs sticky left-0 bg-surface-2/95 backdrop-blur">
                          Agent
                        </th>
                        {platforms.map((p) => (
                          <th key={p.value} className={`px-4 py-3 text-center ${selectedPlatform === p.value ? "bg-brand/5" : ""}`}>
                            <div className="flex items-center justify-center gap-1.5">
                              <PlatformIcon platform={p.value} size={16} />
                              <span className="text-xs font-medium text-text">{p.label}</span>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedAgents.map((a, i) => (
                        <tr
                          key={`pf-matrix-${a.admin_id}-${i}`}
                          className={`border-b border-border/50 hover:bg-surface-2/20 transition-colors ${i % 2 === 0 ? "" : "bg-surface-2/10"}`}
                        >
                          <td className="px-4 py-3 sticky left-0 bg-inherit">
                            <div className="flex items-center gap-2.5">
                              <AgentAvatar name={a.name || a.username} online={a.is_active_agent} size={28} />
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-text truncate">{a.name || a.username}</div>
                                <div className="text-[10px] text-text-muted truncate">
                                  @{a.username} · {a.role}
                                </div>
                              </div>
                            </div>
                          </td>
                          {platforms.map((p) => {
                            const isInTeam = platformTeam.some(
                              (r) => r.platform === p.value && r.admin_id === a.admin_id && r.is_active
                            );
                            const busy = platformAgentAdding === a.admin_id;
                            return (
                              <td key={p.value} className={`px-4 py-3 text-center ${selectedPlatform === p.value ? "bg-brand/5" : ""}`}>
                                <ToggleSwitch
                                  checked={isInTeam}
                                  disabled={!editable || busy}
                                  onChange={() => isInTeam
                                    ? handleRemoveAgentFromPlatform(a.admin_id, p.value)
                                    : handleAddAgentToPlatform(a.admin_id, p.value)}
                                  loading={busy}
                                  label={isInTeam
                                    ? `เอา ${a.name || a.username} ออกจากทีม ${p.label}`
                                    : `เพิ่ม ${a.name || a.username} เข้าทีม ${p.label}`}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {sortedAgents.length === 0 && (
                  <EmptyState icon={Users} title="ไม่มี agent" />
                )}
              </Card>

              {/* Mobile/tablet — agent list ของแพลตฟอร์มที่เลือก (<lg) */}
              <Card className="lg:hidden overflow-hidden">
                <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-surface-2/50 overflow-x-auto">
                  <SubFilterTabs
                    value={platformFilter}
                    onChange={setPlatformFilter}
                    counts={{
                      all: sortedAgents.length,
                      in: platformTeamAgentIds.length,
                      out: sortedAgents.length - platformTeamAgentIds.length,
                    }}
                  />
                  <div className="ml-auto text-[10px] text-text-subtle whitespace-nowrap pl-2">
                    กดสวิตช์เพื่อเพิ่ม/นำออก
                  </div>
                </div>
                <div className="divide-y divide-border/50">
                  {sortedAgents
                    .filter((a) => {
                      const isIn = platformTeamAgentIds.includes(a.admin_id);
                      if (platformFilter === "in") return isIn;
                      if (platformFilter === "out") return !isIn;
                      return true;
                    })
                    .map((a, i) => {
                      const isInTeam = platformTeamAgentIds.includes(a.admin_id);
                      const busy = platformAgentAdding === a.admin_id;
                      return (
                        <AgentToggleRow
                          key={`pf-${a.admin_id}-${i}`}
                          agent={a}
                          isInTeam={isInTeam}
                          busy={busy}
                          disabled={!editable}
                          onToggle={() => isInTeam
                            ? handleRemoveAgentFromPlatform(a.admin_id, selectedPlatform)
                            : handleAddAgentToPlatform(a.admin_id, selectedPlatform)}
                        />
                      );
                    })}
                  {sortedAgents.filter((a) => {
                    const isIn = platformTeamAgentIds.includes(a.admin_id);
                    if (platformFilter === "in") return isIn;
                    if (platformFilter === "out") return !isIn;
                    return true;
                  }).length === 0 && (
                    <div className="py-8 text-center text-xs text-text-subtle">
                      {platformFilter === "in" ? "ยังไม่มี agent ในทีมนี้" : "เพิ่ม agent ครบแล้ว"}
                    </div>
                  )}
                </div>
              </Card>

              {!editable && (
                <div className="flex items-center gap-2 text-[11px] text-text-subtle bg-surface-2 rounded-lg px-3 py-2">
                  <AlertCircle size={12} /> คุณเป็น Admin — ดูได้อย่างเดียว
                </div>
              )}
            </>
          )}
        </div>
      )}
    </PageShell>
  );
}

/* ---------- shared bits ---------- */

function TabButton({ active, onClick, icon: Icon, label, desc }: { active: boolean; onClick: () => void; icon: typeof Users; label: string; desc?: string }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-2 transition-all ${
        active
          ? "bg-surface text-brand shadow-[var(--shadow-sm)]"
          : "text-text-muted hover:text-text hover:bg-surface/60"
      }`}
    >
      <span className="flex items-center gap-1.5 text-xs sm:text-sm font-semibold whitespace-nowrap">
        <Icon size={14} className={active ? "text-brand" : "text-text-subtle"} />
        {label}
      </span>
      {desc && <span className="hidden lg:block text-[10px] font-normal text-text-subtle">{desc}</span>}
    </button>
  );
}

/** FilterChip — ปุ่ม pill สำหรับ filter แพลตฟอร์ม/ทั้งหมด */
function FilterChip({
  active,
  onClick,
  label,
  count,
  platform,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  platform?: Platform;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap border transition-colors shrink-0 ${
        active
          ? "bg-brand text-white border-brand"
          : "bg-surface text-text-muted border-border hover:border-border-strong hover:text-text"
      }`}
    >
      {platform && <PlatformIcon platform={platform} size={12} />}
      {label}
      {count !== undefined && (
        <span className={active ? "opacity-75" : "text-text-subtle"}>{count}</span>
      )}
    </button>
  );
}

/** AgentAvatar — avatar + status dot (online/offline) */
function AgentAvatar({ name, online, size = 32 }: { name: string; online?: boolean; size?: number }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="w-full h-full rounded-full bg-brand/10 text-brand flex items-center justify-center font-semibold"
        style={{ fontSize: size * 0.38 }}
      >
        {name?.charAt(0).toUpperCase() || "?"}
      </div>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface ${online ? "bg-success" : "bg-surface-4"}`}
        />
      )}
    </div>
  );
}

/** StatusPill — สถานะรับแชท (accepting/paused) */
function StatusPill({ st }: { st?: ChatStatusRow }) {
  if (!st) return <span className="text-[11px] text-text-subtle">—</span>;
  const accepting = st.current_state === "accepting";
  return (
    <Badge tone={accepting ? "success" : "warning"} className="shrink-0">
      {accepting ? <PlayCircle size={11} /> : <PauseCircle size={11} />}
      {accepting ? "รับแชท" : "พัก"}
    </Badge>
  );
}

/** MiniStat — ตัวเลขงานตัวเดียวใน card list บน mobile */
function MiniStat({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2/60 px-2 py-1.5 text-center">
      <div className={`text-sm font-bold ${highlight ? "text-vibrant-coral" : "text-text"}`}>{value}</div>
      <div className="text-[10px] text-text-subtle">{label}</div>
    </div>
  );
}

/** CoverageDots — สรุป platform dots + จำนวนร้านที่ agent ดูแล (แบบย่อ) */
function CoverageDots({ agentShops, agentPlatforms }: { agentShops: AgentShopDetail[]; agentPlatforms: { value: Platform; label: string; color: string }[] }) {
  if (agentShops.length === 0 && agentPlatforms.length === 0) {
    return <span className="text-text-subtle whitespace-nowrap">ทั่วระบบ</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {agentPlatforms.map((p) => (
        <span key={p.value} className="w-2 h-2 rounded-full" style={{ background: p.color }} title={p.label} />
      ))}
      {agentShops.length > 0 && <span className="text-text-subtle">{agentShops.length} ร้าน</span>}
    </span>
  );
}

/** AgentExpandedContent — รายละเอียดตอนขยาย (ใช้ร่วมกันทั้ง card list และ table row) */
function AgentExpandedContent({
  hist,
  agentShops,
  agentPlatforms,
  dateRange,
}: {
  hist?: AgentHistory;
  agentShops: AgentShopDetail[];
  agentPlatforms: { value: Platform; label: string; color: string }[];
  dateRange?: TeamResponse["date_range"];
}) {
  return (
    <div className="space-y-4">
      {/* ⚡ Historical stats ตาม date range */}
      {hist && (
        <div className="bg-surface rounded-lg border border-border p-3">
          <div className="flex items-center gap-1.5 mb-2.5 text-xs font-medium text-text-muted">
            <TrendingUp size={12} />
            สถิติตามช่วงเวลาที่เลือก
            <span className="text-text-subtle font-normal">
              ({dateRange?.start ? new Date(dateRange.start).toLocaleDateString("th-TH", { day: "2-digit", month: "short" }) : "—"}
              {dateRange?.end ? ` - ${new Date(dateRange.end).toLocaleDateString("th-TH", { day: "2-digit", month: "short" })}` : ""})
            </span>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            <HistStat icon={Inbox} label="รับงาน" value={hist.assigned} tone="brand" />
            <HistStat icon={Send} label="ตอบ" value={hist.replied} tone="neutral" />
            <HistStat icon={MessageSquare} label="ส่งต่อ" value={hist.handoff} tone="coral" />
            <HistStat icon={CheckCircle} label="ปิด" value={hist.closed} tone="neutral" />
            <HistStat icon={Activity} label="เปิดใหม่" value={hist.reopened} tone="neutral" />
            <HistStat icon={CheckCircle} label="resolve" value={hist.resolved} tone="brand" />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* ร้านที่ดูแล */}
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-text-muted">
            <Store size={12} /> ร้านที่ดูแล ({agentShops.length})
          </div>
          {agentShops.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agentShops.map((s, si) => {
                const pf = platforms.find((p) => p.value === s.platform);
                return (
                  <span
                    key={`exp-shop-${si}`}
                    className="inline-flex items-center gap-1.5 text-[11px] bg-surface border border-border rounded-full px-2 py-1"
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: pf?.color || "#888" }} />
                    <span className="text-text">{s.shopname}</span>
                    <span className="text-text-subtle capitalize">· {s.platform}</span>
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="text-[11px] text-text-subtle">ไม่ได้ดูแลร้านใด (ใช้โหมด Global)</div>
          )}
        </div>

        {/* แพลตฟอร์มที่ดูแล */}
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-text-muted">
            <Globe size={12} /> แพลตฟอร์มที่ดูแล ({agentPlatforms.length})
          </div>
          {agentPlatforms.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {agentPlatforms.map((p) => (
                <span
                  key={`exp-pf-${p.value}`}
                  className="inline-flex items-center gap-1.5 text-[11px] bg-surface border border-border rounded-full px-2 py-1"
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: p.color }} />
                  <span className="text-text">{p.label}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-text-subtle">ไม่ได้ดูแลแพลตฟอร์มใดโดยเฉพาะ</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** AgentToggleRow — แถว agent + toggle switch (ใช้ใน shop-team และ platform-team list) */
function AgentToggleRow({
  agent: a,
  isInTeam,
  busy,
  disabled,
  onToggle,
}: {
  agent: AgentRow;
  isInTeam: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${isInTeam ? "bg-brand/5" : "hover:bg-surface-2/30"}`}>
      <AgentAvatar name={a.name || a.username} online={a.is_active_agent} size={32} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text truncate">{a.name || a.username}</span>
          <Badge tone={roleTone(a.role)}>{a.role}</Badge>
        </div>
        <div className="text-[11px] text-text-muted truncate">
          @{a.username} · {a.workload.active} งานเปิด
          {a.assigned_shops.length > 0 && ` · ${a.assigned_shops.length} ร้าน`}
        </div>
      </div>
      <ToggleSwitch
        checked={isInTeam}
        disabled={disabled || busy}
        onChange={onToggle}
        loading={busy}
        label={isInTeam
          ? `เอา ${a.name || a.username} ออกจากทีม`
          : `เพิ่ม ${a.name || a.username} เข้าทีม`}
      />
    </div>
  );
}

/** SubFilterTabs — chips ทั้งหมด/ในทีม/ยังไม่เพิ่ม */
function SubFilterTabs({
  value,
  onChange,
  counts,
}: {
  value: TeamFilter;
  onChange: (v: TeamFilter) => void;
  counts: { all: number; in: number; out: number };
}) {
  const opts: { key: TeamFilter; label: string }[] = [
    { key: "all", label: `ทั้งหมด (${counts.all})` },
    { key: "in", label: `ในทีม (${counts.in})` },
    { key: "out", label: `ยังไม่เพิ่ม (${counts.out})` },
  ];
  return (
    <div className="flex items-center gap-1">
      {opts.map((f) => (
        <button
          key={f.key}
          onClick={() => onChange(f.key)}
          className={`px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors ${
            value === f.key
              ? "bg-brand text-white"
              : "text-text-muted hover:text-text hover:bg-surface"
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
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
  const iconTone = tone === "brand"
    ? "bg-brand/10 text-brand"
    : tone === "coral"
      ? "bg-vibrant-coral-soft text-vibrant-coral"
      : "bg-surface-2 text-text-muted";
  return (
    <Card className="p-3 sm:p-3.5">
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${iconTone}`}>
          <Icon size={13} />
        </span>
        <span className="text-[11px] sm:text-xs text-text-muted truncate">{label}</span>
      </div>
      <div className={`text-lg sm:text-xl font-bold ${toneClass}`}>
        {valueText !== undefined ? valueText : value ?? 0}
      </div>
      {sub && <div className="text-[10px] sm:text-[11px] text-text-subtle mt-0.5 truncate" title={sub}>{sub}</div>}
    </Card>
  );
}

/** ⚡ HistStat — แสดง historical stat ตัวเลขเดียวใน expand panel */
function HistStat({
  icon: Icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: typeof Users;
  label: string;
  value: number;
  tone?: "brand" | "coral" | "neutral";
}) {
  const toneClass = tone === "brand" ? "text-brand" : tone === "coral" ? "text-vibrant-coral" : "text-text";
  return (
    <div className="flex flex-col items-center text-center bg-surface-2/50 rounded-lg p-2">
      <Icon size={12} className="text-text-muted mb-1" />
      <span className={`text-sm font-bold ${toneClass}`}>{value}</span>
      <span className="text-[10px] text-text-subtle">{label}</span>
    </div>
  );
}

/** Toggle switch — ใช้ในจัดทีมร้าน/แพลตฟอร์ม แทนปุ่ม add/remove */
function ToggleSwitch({
  checked,
  disabled,
  loading,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        checked ? "bg-brand" : "bg-surface-2 border border-border"
      }`}
    >
      {loading ? (
        <span className="absolute left-1/2 -translate-x-1/2">
          <Loading size={10} />
        </span>
      ) : (
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-1"
          }`}
        />
      )}
    </button>
  );
}

"use client";
import { useState, useEffect, useCallback } from "react";
import { ScrollText, RefreshCw, ChevronDown, X, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/lib/authStore";
import { usePolling } from "@/lib/usePolling";

// Phase 7.10 — หน้า Logs แยกจาก config
// แสดง audit trail ของทุก action ในระบบ พร้อม filter admin + action_type

interface AdminLogRow {
  admin_id: string;
  username?: string;
  name?: string;
  action_type: string;
  conversation_id?: string;
  shop_id?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  target_admin_id?: string;
  ip?: string;
}

interface AdminOption {
  admin_id: string;
  name?: string;
  username?: string;
  role: string;
}

// แบ่งหมวด action_type สำหรับ filter dropdown
const ACTION_CATEGORIES: { label: string; types: string[] }[] = [
  { label: "Auth", types: ["login", "logout"] },
  { label: "User mgmt", types: ["user.create", "user.update", "user.delete", "user.toggle_active", "user.reset_password"] },
  { label: "Trigger", types: ["trigger.create", "trigger.update", "trigger.delete", "trigger.toggle"] },
  { label: "Knowledge", types: ["kb.create", "kb.update", "kb.delete", "kb.toggle", "kb.import_excel"] },
  { label: "Assignment", types: ["chat_assigned", "chat_reassigned", "assignment.mode_change", "assignment.shop_team_add", "assignment.shop_team_remove", "assignment.platform_team_add", "assignment.platform_team_remove", "agent.pause", "agent.resume", "agent_auto_paused"] },
  { label: "Conversation", types: ["admin.reply", "conversation.handoff", "conversation.resolve", "conversation.open", "conversation.close", "conversation.status_change", "ticket.create", "ticket.update", "ticket.delete"] },
  { label: "Config", types: ["config.update", "config.shop_toggle", "config.test_integration"] },
  { label: "Bot/Data", types: ["bot.reply", "bot.handoff_to_admin", "bot.process_started", "bot.process_completed", "bot.process_failed", "bot.guard_violation", "bot.idempotency_skip", "data_writer.message_received", "data_writer.conversation_upserted", "data_writer.duplicate_message", "platform_api.blocked"] },
  { label: "Quick reply", types: ["quick_reply.create", "quick_reply.update", "quick_reply.delete", "quick_reply.use"] },
];

const ACTION_TONE: Record<string, "brand" | "coral" | "neutral" | "pale"> = {
  login: "brand",
  logout: "neutral",
  "admin.reply": "brand",
  "conversation.handoff": "coral",
  "conversation.resolve": "pale",
  "conversation.close": "neutral",
  chat_assigned: "brand",
  chat_reassigned: "coral",
  "bot.reply": "brand",
  "bot.guard_violation": "coral",
  "platform_api.blocked": "coral",
  "user.delete": "coral",
};

export default function LogsPage() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<AdminLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [filterAdmin, setFilterAdmin] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterActionType, setFilterActionType] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdminDropdown, setShowAdminDropdown] = useState(false);
  const [showCatDropdown, setShowCatDropdown] = useState(false);

  // โหลด admins list (สำหรับ filter + แสดงชื่อ)
  useEffect(() => {
    if (user?.role === "admin") return;
    api().get<{ users: AdminOption[] }>("/users/list").then((r) => {
      setAdmins(r.data.users || []);
    }).catch(() => setAdmins([]));
  }, [user?.role]);

  const canViewLogs = user?.role === "superadmin" || user?.role === "dev";

  const loadLogs = useCallback(async () => {
    if (!canViewLogs) { setLogs([]); setLoading(false); return; }
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit: 200 };
      if (filterActionType !== "all") params.action_type = filterActionType;
      const r = await api().get<{ rows: AdminLogRow[]; total: number }>("/admin/logs", { params });
      setLogs(r.data.rows || []);
    } catch (err) {
      console.error("load logs failed", err);
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [filterActionType, canViewLogs]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // poll 5 วิ (เฉพาะ superadmin/dev)
  usePolling(canViewLogs ? loadLogs : async () => {}, canViewLogs ? 5000 : 0);

  // ชื่อ admin สำหรับแสดง
  const adminName = (id: string): string => {
    if (id === "system") return "system";
    const a = admins.find((x) => x.admin_id === id);
    return a?.name || a?.username || id;
  };

  // filter ใน frontend
  const filtered = logs.filter((log) => {
    if (filterAdmin !== "all" && log.admin_id !== filterAdmin) return false;
    if (filterCategory !== "all") {
      const cat = ACTION_CATEGORIES.find((c) => c.label === filterCategory);
      if (cat && !cat.types.includes(log.action_type)) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const name = adminName(log.admin_id).toLowerCase();
      if (!log.action_type.toLowerCase().includes(q) &&
          !name.includes(q) &&
          !(log.conversation_id || "").toLowerCase().includes(q) &&
          !(log.shop_id || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const selectedAdminLabel = filterAdmin === "all"
    ? "ทุกแอดมิน"
    : adminName(filterAdmin);
  const selectedCatLabel = filterCategory === "all"
    ? "ทุกหมวด"
    : filterCategory;

  if (!canViewLogs) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-vibrant-coral/15 flex items-center justify-center">
              <ShieldAlert size={20} className="text-vibrant-coral" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">บันทึกระบบ</h1>
              <p className="text-xs text-text-muted">สำหรับ SuperAdmin / Dev เท่านั้น</p>
            </div>
          </div>
        </div>
        <div className="p-12 text-center">
          <ShieldAlert size={40} className="mx-auto mb-3 text-text-subtle" />
          <p className="text-sm text-text-muted">คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p>
          <p className="text-xs text-text-subtle mt-1">ติดต่อ SuperAdmin หากต้องการสิทธิ์เข้าถึง</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header — navbar เดิม (เหมือน shops/team) */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <ScrollText size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">บันทึกระบบ</h1>
              <p className="text-xs text-text-muted">
                audit trail · {filtered.length} รายการ · รีเฟรชทุก 5 วิ
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={loadLogs} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          {/* Filter admin (dropdown แบบเลือกแล้วแสดงชื่อ) */}
          <div className="relative">
            <button
              onClick={() => { setShowAdminDropdown(!showAdminDropdown); setShowCatDropdown(false); }}
              className="h-8 px-3 rounded-lg border border-border bg-surface-2 text-xs text-text flex items-center gap-1.5 hover:border-brand/40 transition-colors"
            >
              <span className="text-text-muted">admin:</span>
              <span className="font-medium">{selectedAdminLabel}</span>
              <ChevronDown size={12} className="text-text-muted" />
            </button>
            {showAdminDropdown && (
              <div className="absolute top-full left-0 mt-1 min-w-[180px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1 max-h-72 overflow-y-auto">
                <button
                  onClick={() => { setFilterAdmin("all"); setShowAdminDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterAdmin === "all" ? "text-brand font-medium" : "text-text"}`}
                >
                  ทุกแอดมิน
                </button>
                <button
                  onClick={() => { setFilterAdmin("system"); setShowAdminDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterAdmin === "system" ? "text-brand font-medium" : "text-text"}`}
                >
                  system
                </button>
                <div className="border-t border-border my-1" />
                {admins.map((a) => (
                  <button
                    key={a.admin_id}
                    onClick={() => { setFilterAdmin(a.admin_id); setShowAdminDropdown(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterAdmin === a.admin_id ? "text-brand font-medium" : "text-text"}`}
                  >
                    {a.name || a.username} <span className="text-text-subtle">({a.role})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Filter category (dropdown) */}
          <div className="relative">
            <button
              onClick={() => { setShowCatDropdown(!showCatDropdown); setShowAdminDropdown(false); }}
              className="h-8 px-3 rounded-lg border border-border bg-surface-2 text-xs text-text flex items-center gap-1.5 hover:border-brand/40 transition-colors"
            >
              <span className="text-text-muted">หมวด:</span>
              <span className="font-medium">{selectedCatLabel}</span>
              <ChevronDown size={12} className="text-text-muted" />
            </button>
            {showCatDropdown && (
              <div className="absolute top-full left-0 mt-1 min-w-[160px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                <button
                  onClick={() => { setFilterCategory("all"); setFilterActionType("all"); setShowCatDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterCategory === "all" ? "text-brand font-medium" : "text-text"}`}
                >
                  ทุกหมวด
                </button>
                {ACTION_CATEGORIES.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => { setFilterCategory(c.label); setFilterActionType("all"); setShowCatDropdown(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterCategory === c.label ? "text-brand font-medium" : "text-text"}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Search */}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหา action / ชื่อ / conv id..."
            className="h-8 px-3 rounded-lg border border-border bg-surface-2 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-brand/40 w-56"
          />

          {/* Clear filter */}
          {(filterAdmin !== "all" || filterCategory !== "all" || search) && (
            <button
              onClick={() => { setFilterAdmin("all"); setFilterCategory("all"); setFilterActionType("all"); setSearch(""); }}
              className="h-8 px-2 rounded-lg text-xs text-text-muted hover:text-vibrant-coral hover:bg-surface-2 flex items-center gap-1 transition-colors"
            >
              <X size={12} /> ล้าง
            </button>
          )}
        </div>
      </div>

      {/* Log list */}
      <div className="p-6">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-text-muted text-sm">
            {loading ? "กำลังโหลด..." : "ยังไม่มี log ตรงเงื่อนไข"}
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((log, i) => {
              const key = `${log.admin_id}-${log.timestamp}-${i}`;
              const expanded = expandedId === key;
              const tone = ACTION_TONE[log.action_type] || "neutral";
              return (
                <div
                  key={key}
                  className="rounded-lg border border-border bg-surface overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedId(expanded ? null : key)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2/50 transition-colors"
                  >
                    <code className="text-text-subtle flex-shrink-0 font-mono text-[11px] w-32">
                      {new Date(log.timestamp).toLocaleString("th-TH", {
                        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
                      })}
                    </code>
                    <Badge tone={tone} className="flex-shrink-0">{log.action_type}</Badge>
                    <span className="text-brand flex-shrink-0 text-xs font-medium">
                      {adminName(log.admin_id)}
                    </span>
                    <span className="text-text-muted text-xs truncate flex-1">
                      {log.conversation_id ? `conv: ${log.conversation_id.slice(0, 16)}` : ""}
                      {log.shop_id ? ` · shop: ${log.shop_id.slice(0, 12)}` : ""}
                      {log.target_admin_id ? ` → ${adminName(log.target_admin_id)}` : ""}
                    </span>
                    <ChevronDown size={12} className={`text-text-muted flex-shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </button>
                  {expanded && (
                    <div className="px-3 py-2.5 border-t border-border bg-surface-2/30 text-xs space-y-1.5">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <div><span className="text-text-muted">admin_id:</span> <code className="font-mono text-text">{log.admin_id}</code></div>
                        <div><span className="text-text-muted">action_type:</span> <code className="font-mono text-text">{log.action_type}</code></div>
                        {log.target_admin_id && (
                          <div><span className="text-text-muted">target:</span> <code className="font-mono text-text">{log.target_admin_id}</code></div>
                        )}
                        {log.conversation_id && (
                          <div><span className="text-text-muted">conversation:</span> <code className="font-mono text-text">{log.conversation_id}</code></div>
                        )}
                        {log.shop_id && (
                          <div><span className="text-text-muted">shop:</span> <code className="font-mono text-text">{log.shop_id}</code></div>
                        )}
                        {log.ip && (
                          <div><span className="text-text-muted">ip:</span> <code className="font-mono text-text">{log.ip}</code></div>
                        )}
                      </div>
                      {log.metadata && Object.keys(log.metadata).length > 0 && (
                        <div className="pt-1.5 border-t border-border">
                          <div className="text-text-muted mb-1">metadata:</div>
                          <pre className="text-[10px] text-text-muted bg-surface rounded p-2 overflow-x-auto font-mono">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

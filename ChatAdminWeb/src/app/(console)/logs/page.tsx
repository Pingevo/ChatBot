"use client";
import { useState, useEffect, useCallback, Fragment, useRef } from "react";
import { ScrollText, RefreshCw, ChevronDown, X, ShieldAlert, List, Table2, FileText } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterChips } from "@/components/ui/FilterChips";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/lib/authStore";
import { usePolling } from "@/lib/usePolling";
import { useSearchShortcut, useEscToClear, useListboxNav } from "@/lib/useKeyboardShortcuts";
import { toast, useToastError } from "@/components/ui/Toast";
import { FilterPresets } from "@/components/ui/FilterPresets";
import { ACTION_CATEGORIES, ACTION_TONE, actionTypeLabel } from "@/lib/actionTypes";

// Phase 7.10 — หน้า Logs แยกจาก config
// แสดง audit trail ของทุก action ในระบบ พร้อม filter admin + action_type
// ⚡ v2 — เพิ่ม tab สลับมุมมอง ลิสต์/ตาราง (ตารางแสดงทุก field จริงใน doc)

interface AdminLogRow {
  admin_id: string;
  username?: string;
  name?: string;
  action_type: string;
  ticket_id?: string;
  meta?: Record<string, unknown>;
  conversation_id?: string;
  shop_id?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  target_admin_id?: string;
  actor?: string;
  ip?: string;
}

interface AdminOption {
  admin_id: string;
  name?: string;
  username?: string;
  role: string;
}

export default function LogsPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const handleSearchEsc = useEscToClear(() => setSearch(""));
  const { user } = useAuth();
  const [logs, setLogs] = useState<AdminLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [filterAdmin, setFilterAdmin] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"list" | "table">("list");
  const [filterActionType, setFilterActionType] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdminDropdown, setShowAdminDropdown] = useState(false);
  const [showCatDropdown, setShowCatDropdown] = useState(false);
  // Column visibility for table view (persisted in localStorage)
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("chatadmin:logs:hiddenCols");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const toggleCol = (col: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      try { localStorage.setItem("chatadmin:logs:hiddenCols", JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const { catchError } = useToastError();

  // arrow-key navigation for filter dropdowns
  const adminNav = useListboxNav(admins.length + 2, (i) => {
    if (i === 0) { setFilterAdmin("all"); setShowAdminDropdown(false); return; }
    if (i === 1) { setFilterAdmin("system"); setShowAdminDropdown(false); return; }
    const a = admins[i - 2];
    if (a) { setFilterAdmin(a.admin_id); setShowAdminDropdown(false); }
  }, () => setShowAdminDropdown(false));
  const catNav = useListboxNav(ACTION_CATEGORIES.length + 1, (i) => {
    if (i === 0) { setFilterCategory("all"); setFilterActionType("all"); setShowCatDropdown(false); return; }
    const c = ACTION_CATEGORIES[i - 1];
    if (c) { setFilterCategory(c.label); setFilterActionType("all"); setShowCatDropdown(false); }
  }, () => setShowCatDropdown(false));

  // โหลด admins list (สำหรับ filter + แสดงชื่อ)
  useEffect(() => {
    if (user?.role === "admin") return;
    api().get<{ users: AdminOption[] }>("/users/list").then((r) => {
      setAdmins(r.data.users || []);
    }).catch((e) => {
      catchError(e, "โหลดรายชื่อแอดมินไม่สำเร็จ");
      setAdmins([]);
    });
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
      toast.error("โหลดบันทึกระบบไม่สำเร็จ", 0, { label: "ลองใหม่", onClick: () => loadLogs() });
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
    <PageShell
      icon={ScrollText}
      title="บันทึกระบบ"
      helpHref="/help#logs"
      subtitle={<>audit trail · {filtered.length} รายการ · รีเฟรชทุก 5 วิ · <a href="/help#action-types" className="text-brand hover:text-brand-dark">ดูรหัส action_type ทั้งหมด →</a></>}
      actions={
        <>
          {/* ⚡ v2 — tab สลับมุมมอง ลิสต์/ตาราง */}
          <div className="flex items-center rounded-lg border border-border bg-surface-2 p-0.5" role="group" aria-label="มุมมอง">
            <button
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list" ? "true" : "false"}
              className={`h-7 px-2.5 rounded-md text-xs flex items-center gap-1.5 transition-colors ${viewMode === "list" ? "bg-brand text-white" : "text-text-muted hover:text-text"}`}
            >
              <List size={12} /> ลิสต์
            </button>
            <button
              onClick={() => setViewMode("table")}
              aria-pressed={viewMode === "table" ? "true" : "false"}
              className={`h-7 px-2.5 rounded-md text-xs flex items-center gap-1.5 transition-colors ${viewMode === "table" ? "bg-brand text-white" : "text-text-muted hover:text-text"}`}
            >
              <Table2 size={12} /> ตาราง
            </button>
          </div>
          <Button size="sm" variant="outline" onClick={loadLogs} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </>
      }
      filterBar={
        <>
          {/* Filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
          {/* Filter admin (dropdown แบบเลือกแล้วแสดงชื่อ) */}
          <div className="relative">
            <button
              onClick={() => { setShowAdminDropdown(!showAdminDropdown); setShowCatDropdown(false); }}
              aria-expanded={showAdminDropdown}
              aria-haspopup="listbox"
              className="h-8 px-3 rounded-lg border border-border bg-surface-2 text-xs text-text flex items-center gap-1.5 hover:border-brand/40 transition-colors"
            >
              <span className="text-text-muted">admin:</span>
              <span className="font-medium">{selectedAdminLabel}</span>
              <ChevronDown size={12} className="text-text-muted" />
            </button>
            {showAdminDropdown && (
              <div ref={(el) => { if (showAdminDropdown && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามแอดมิน" aria-activedescendant={`admin-option-${adminNav.activeIndex}`} onKeyDown={(e) => { adminNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[180px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1 max-h-72 overflow-y-auto">
                <button
                  id="admin-option-0" role="option" aria-selected={filterAdmin === "all"}
                  onClick={() => { setFilterAdmin("all"); setShowAdminDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterAdmin === "all" ? "text-brand font-medium" : "text-text"}`}
                >
                  ทุกแอดมิน
                </button>
                <button
                  id="admin-option-1" role="option" aria-selected={filterAdmin === "system"}
                  onClick={() => { setFilterAdmin("system"); setShowAdminDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterAdmin === "system" ? "text-brand font-medium" : "text-text"}`}
                >
                  system
                </button>
                <div className="border-t border-border my-1" />
                {admins.map((a, i) => (
                  <button
                    key={a.admin_id}
                    id={`admin-option-${i + 2}`} role="option" aria-selected={filterAdmin === a.admin_id}
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
              aria-expanded={showCatDropdown}
              aria-haspopup="listbox"
              className="h-8 px-3 rounded-lg border border-border bg-surface-2 text-xs text-text flex items-center gap-1.5 hover:border-brand/40 transition-colors"
            >
              <span className="text-text-muted">หมวด:</span>
              <span className="font-medium">{selectedCatLabel}</span>
              <ChevronDown size={12} className="text-text-muted" />
            </button>
            {showCatDropdown && (
              <div ref={(el) => { if (showCatDropdown && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามหมวด" aria-activedescendant={`cat-option-${catNav.activeIndex}`} onKeyDown={(e) => { catNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[160px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                <button
                  id="cat-option-0" role="option" aria-selected={filterCategory === "all"}
                  onClick={() => { setFilterCategory("all"); setFilterActionType("all"); setShowCatDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 ${filterCategory === "all" ? "text-brand font-medium" : "text-text"}`}
                >
                  ทุกหมวด
                </button>
                {ACTION_CATEGORIES.map((c, i) => (
                  <button
                    key={c.label}
                    id={`cat-option-${i + 1}`} role="option" aria-selected={filterCategory === c.label}
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
          <div className="relative w-56">
            <input
              type="text"
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchEsc}
              placeholder="ค้นหาคำสั่งงาน / ชื่อ / รหัสแชท..."
              className="w-full h-8 px-3 pr-8 rounded-lg border border-border bg-surface-2 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-brand/40"
            />
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-text-subtle border border-border rounded px-1 py-0.5 pointer-events-none">/</kbd>
          </div>

          {/* Preset */}
          <FilterPresets
            pageKey="logs"
            adminId={user?.admin_id || "anon"}
            currentValues={{
              filterAdmin,
              filterCategory,
              filterActionType,
              search,
              viewMode,
            }}
            onApply={(v) => {
              setFilterAdmin(v.filterAdmin || "all");
              setFilterCategory(v.filterCategory || "all");
              setFilterActionType(v.filterActionType || "all");
              setSearch(v.search || "");
              setViewMode(v.viewMode || "list");
            }}
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

        {/* Active filter chips */}
        {(filterAdmin !== "all" || filterCategory !== "all" || filterActionType !== "all" || search) && (
          <div className="mt-2">
            <FilterChips
              chips={[
                ...(search ? [{ key: "search", label: `ค้นหา: ${search}`, onRemove: () => setSearch("") }] : []),
                ...(filterAdmin !== "all" ? [{ key: "admin", label: `แอดมิน: ${adminName(filterAdmin)}`, onRemove: () => setFilterAdmin("all") }] : []),
                ...(filterCategory !== "all" ? [{ key: "category", label: `หมวด: ${filterCategory}`, onRemove: () => setFilterCategory("all") }] : []),
                ...(filterActionType !== "all" ? [{ key: "actionType", label: `action: ${actionTypeLabel(filterActionType)}`, onRemove: () => setFilterActionType("all") }] : []),
              ]}
              onClearAll={() => { setFilterAdmin("all"); setFilterCategory("all"); setFilterActionType("all"); setSearch(""); }}
            />
          </div>
        )}
        </>
      }
      contentClassName="p-6"
    >
      {/* Log content — สลับ list/table ตาม viewMode */}
      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loading /></div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={FileText} title="ยังไม่มี log ตรงเงื่อนไข" description="ลองเปลี่ยน filter หรือล้างการกรอง" />
        ) : viewMode === "list" ? (
          /* ── List view (เดิม) ── */
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
                    aria-expanded={expanded === true}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2/50 transition-colors"
                  >
                    <code className="text-text-subtle flex-shrink-0 font-mono text-[11px] w-32">
                      {new Date(log.timestamp).toLocaleString("th-TH", {
                        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
                      })}
                    </code>
                    <Badge tone={tone} className="flex-shrink-0">{actionTypeLabel(log.action_type)}</Badge>
                    <span className="text-brand flex-shrink-0 text-xs font-medium">
                      {adminName(log.admin_id)}
                    </span>
                    <span className="text-text-muted text-xs truncate flex-1" title={log.conversation_id || log.shop_id || ""}>
                      {log.conversation_id ? `conv: ${log.conversation_id.slice(0, 16)}` : ""}
                      {log.shop_id ? ` · shop: ${log.shop_id.slice(0, 12)}` : ""}
                      {log.target_admin_id ? ` → ${adminName(log.target_admin_id)}` : ""}
                    </span>
                    <ChevronDown size={12} className={`text-text-muted flex-shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </button>
                  {expanded && (
                    <div className="px-3 py-2.5 border-t border-border bg-surface-2/30 text-xs space-y-1.5">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <div><span className="text-text-muted">ผู้กระทำ:</span> <code className="font-mono text-text">{adminName(log.admin_id)}</code></div>
                        <div><span className="text-text-muted">การกระทำ:</span> <code className="font-mono text-text">{actionTypeLabel(log.action_type)}</code></div>
                        {log.target_admin_id && (
                          <div><span className="text-text-muted">เป้าหมาย:</span> <code className="font-mono text-text">{adminName(log.target_admin_id)}</code></div>
                        )}
                        {log.conversation_id && (
                          <div><span className="text-text-muted">แชท:</span> <code className="font-mono text-text" title={log.conversation_id}>{log.conversation_id.slice(0, 16)}</code></div>
                        )}
                        {log.shop_id && (
                          <div><span className="text-text-muted">ร้าน:</span> <code className="font-mono text-text" title={log.shop_id}>{log.shop_id.slice(0, 12)}</code></div>
                        )}
                        {log.ip && (
                          <div><span className="text-text-muted">IP:</span> <code className="font-mono text-text">{log.ip}</code></div>
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
        ) : (
          /* ── Table view (ใหม่ — แสดงทุก field จริงใน AdminLogDoc) ── */
          <LogTableView logs={filtered} adminName={adminName} actionTypeLabel={actionTypeLabel} expandedId={expandedId} setExpandedId={setExpandedId} hiddenCols={hiddenCols} toggleCol={toggleCol} />
        )}
      </div>
    </PageShell>
  );
}

// ── Table view — แสดงทุก field จริงใน AdminLogDoc ──────────────────────────
// คอลัมน์: timestamp · action_type · actor/admin_id · target_admin_id ·
//          conversation_id · shop_id · ticket_id · ip · meta · metadata
// คลิก row → expand ดู metadata/meta แบบเต็มด้านล่าง
function LogTableView({
  logs,
  adminName,
  actionTypeLabel,
  expandedId,
  setExpandedId,
  hiddenCols,
  toggleCol,
}: {
  logs: AdminLogRow[];
  adminName: (id: string) => string;
  actionTypeLabel: (t: string) => string;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  hiddenCols: Set<string>;
  toggleCol: (col: string) => void;
}) {
  const fmtTime = (ts: string) =>
    new Date(ts).toLocaleString("th-TH", {
      day: "2-digit", month: "2-digit", year: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  const truncate = (s: string | undefined, n: number) =>
    !s ? "—" : s.length > n ? s.slice(0, n) + "…" : s;
  const metaCount = (m?: Record<string, unknown>) =>
    !m ? 0 : Object.keys(m).length;

  const cols = [
    { key: "target", label: "เป้าหมาย", hideClass: "hidden lg:table-cell" },
    { key: "conv", label: "แชท", hideClass: "hidden md:table-cell" },
    { key: "shop", label: "ร้าน", hideClass: "hidden md:table-cell" },
    { key: "ticket", label: "ทิกเก็ต", hideClass: "hidden lg:table-cell" },
    { key: "ip", label: "หมายเลข IP", hideClass: "hidden xl:table-cell" },
    { key: "meta", label: "บันทึกย่อ", hideClass: "hidden md:table-cell" },
  ];

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      {/* Column visibility toggle */}
      <fieldset className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-surface-2/50 flex-wrap" role="group" aria-label="เลือกคอลัมน์ที่จะแสดง">
        <span className="text-[10px] text-text-subtle">คอลัมน์:</span>
        {cols.map((c) => (
          <button
            key={c.key}
            onClick={() => toggleCol(c.key)}
            aria-pressed={!hiddenCols.has(c.key)}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand/40 ${
              !hiddenCols.has(c.key)
                ? "border-brand/30 bg-brand/10 text-brand"
                : "border-border bg-surface text-text-subtle hover:text-text"
            }`}
          >
            {c.label}
          </button>
        ))}
        {hiddenCols.size > 0 && (
          <button
            onClick={() => cols.forEach((c) => hiddenCols.has(c.key) && toggleCol(c.key))}
            className="text-[10px] px-1.5 py-0.5 text-text-subtle hover:text-brand ml-auto"
          >
            แสดงทั้งหมด
          </button>
        )}
      </fieldset>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[640px]">
          <thead className="bg-surface-2 text-text-muted sticky top-0">
            <tr>
              <th className="text-left font-medium px-3 py-2 whitespace-nowrap">เวลา</th>
              <th className="text-left font-medium px-3 py-2 whitespace-nowrap">การกระทำ</th>
              <th className="text-left font-medium px-3 py-2 whitespace-nowrap">ผู้กระทำ</th>
              <th className={`text-left font-medium px-3 py-2 whitespace-nowrap ${hiddenCols.has("target") ? "hidden" : "hidden lg:table-cell"}`}>เป้าหมาย</th>
              <th className={`text-left font-medium px-3 py-2 whitespace-nowrap ${hiddenCols.has("conv") ? "hidden" : "hidden md:table-cell"}`}>แชท</th>
              <th className={`text-left font-medium px-3 py-2 whitespace-nowrap ${hiddenCols.has("shop") ? "hidden" : "hidden md:table-cell"}`}>ร้าน</th>
              <th className={`text-left font-medium px-3 py-2 whitespace-nowrap ${hiddenCols.has("ticket") ? "hidden" : "hidden lg:table-cell"}`}>ทิกเก็ต</th>
              <th className={`text-left font-medium px-3 py-2 whitespace-nowrap ${hiddenCols.has("ip") ? "hidden" : "hidden xl:table-cell"}`}>หมายเลข IP</th>
              <th className={`text-right font-medium px-3 py-2 whitespace-nowrap ${hiddenCols.has("meta") ? "hidden" : "hidden md:table-cell"}`}>บันทึกย่อ</th>
              <th className="text-right font-medium px-3 py-2 whitespace-nowrap">รายละเอียด</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {logs.map((log, i) => {
              const key = `${log.admin_id}-${log.timestamp}-${i}`;
              const expanded = expandedId === key;
              const tone = ACTION_TONE[log.action_type] || "neutral";
              const hasDetail = metaCount(log.metadata) > 0 || metaCount(log.meta) > 0;
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => hasDetail && setExpandedId(expanded ? null : key)}
                    tabIndex={hasDetail ? 0 : undefined}
                    role={hasDetail ? "button" : undefined}
                    onKeyDown={hasDetail ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpandedId(expanded ? null : key);
                      }
                    } : undefined}
                    className={`align-top ${hasDetail ? "cursor-pointer hover:bg-surface-2/50" : "cursor-default"} transition-colors`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-text-subtle">
                      {fmtTime(log.timestamp)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Badge tone={tone}>{actionTypeLabel(log.action_type)}</Badge>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-text font-medium" title={log.admin_id}>{adminName(log.admin_id)}</div>
                      {log.actor && log.actor !== log.admin_id && (
                        <div className="text-text-subtle text-[10px]">actor: {log.actor}</div>
                      )}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap text-text-muted ${hiddenCols.has("target") ? "hidden" : "hidden lg:table-cell"}`}>
                      {log.target_admin_id ? (
                        <span title={log.target_admin_id}>
                          <div>{adminName(log.target_admin_id)}</div>
                        </span>
                      ) : "—"}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap font-mono text-text-muted ${hiddenCols.has("conv") ? "hidden" : "hidden md:table-cell"}`}>
                      {log.conversation_id ? (
                        <span title={log.conversation_id}>{truncate(log.conversation_id, 20)}</span>
                      ) : "—"}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap font-mono text-text-muted ${hiddenCols.has("shop") ? "hidden" : "hidden md:table-cell"}`}>
                      {log.shop_id ? (
                        <span title={log.shop_id}>{truncate(log.shop_id, 16)}</span>
                      ) : "—"}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap font-mono text-text-muted ${hiddenCols.has("ticket") ? "hidden" : "hidden lg:table-cell"}`}>
                      {log.ticket_id ? (
                        <span title={log.ticket_id}>{truncate(log.ticket_id, 16)}</span>
                      ) : "—"}
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap font-mono text-text-muted ${hiddenCols.has("ip") ? "hidden" : "hidden xl:table-cell"}`}>
                      {log.ip || "—"}
                    </td>
                    <td className={`px-3 py-2 text-right text-text-muted whitespace-nowrap ${hiddenCols.has("meta") ? "hidden" : "hidden md:table-cell"}`}>
                      {metaCount(log.meta) > 0 ? `${metaCount(log.meta)} keys` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {metaCount(log.metadata) > 0 ? (
                        <span className="text-brand flex items-center justify-end gap-1">
                          {metaCount(log.metadata)} keys
                          {hasDetail && (
                            <ChevronDown size={10} className={`text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
                          )}
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                  {expanded && hasDetail && (
                    <tr key={`${key}-detail`} className="bg-surface-2/30">
                      <td colSpan={10} className="px-3 py-2.5">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {metaCount(log.metadata) > 0 && (
                            <div>
                              <div className="text-text-muted mb-1 text-[11px]">metadata ({metaCount(log.metadata)} keys):</div>
                              <pre className="text-[10px] text-text-muted bg-surface rounded p-2 overflow-x-auto font-mono border border-border">
                                {JSON.stringify(log.metadata, null, 2)}
                              </pre>
                            </div>
                          )}
                          {metaCount(log.meta) > 0 && (
                            <div>
                              <div className="text-text-muted mb-1 text-[11px]">meta (legacy, {metaCount(log.meta)} keys):</div>
                              <pre className="text-[10px] text-text-muted bg-surface rounded p-2 overflow-x-auto font-mono border border-border">
                                {JSON.stringify(log.meta, null, 2)}
                              </pre>
                            </div>
                          )}
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
    </div>
  );
}

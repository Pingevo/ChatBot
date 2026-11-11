// MobileNav — bottom navigation bar สำหรับมือถือ
// แยกการออกแบบจาก desktop sidebar — ไม่อิง desktop
// แสดง 4 ไอเทมหลัก + ปุ่ม "เพิ่มเติม" ที่เปิด drawer
"use client";
import { useState, useMemo, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  MessageSquare,
  BarChart3,
  MoreHorizontal,
  Zap,
  GitBranch,
  Reply,
  BookOpen,
  Map,
  Database,
  Store,
  Users,
  Settings,
  Headset,
  Bot,
  Ghost,
  Wrench,
  ScrollText,
  Shield,
  KeyRound,
  Sliders,
  ContactIcon,
  TestTube2,
  Scale,
  ClipboardCheck,
  Gauge,
  FileSearch,
  Sparkles,
  Settings2,
  HelpCircle,
  X,
  UserCog,
  Inbox,
  Search,
  ChevronDown,
  ChevronRight,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canAccessPage, type PageKey } from "@/lib/roles";
import { confirm } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

const roleLabel: Record<string, string> = {
  superadmin: "SuperAdmin",
  admin: "Admin",
  dev: "Dev",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  return parts[0].slice(0, 2);
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  page?: PageKey;
}

// 4 ไอเทมหลักที่แสดงใน bottom bar
const primaryItems: NavItem[] = [
  { href: "/dashboard", label: "หน้าแรก", icon: LayoutDashboard, page: "dashboard" },
  { href: "/tickets", label: "แชท", icon: MessageSquare, page: "ticket" },
  { href: "/analytics/live", label: "สถิติ", icon: BarChart3, page: "analytics" },
];

// ไอเทมรอง — แสดงใน "เพิ่มเติม" drawer แบ่งกลุ่มตาม sidebar (แบบ A)
interface NavGroup {
  label: string;
  items: NavItem[];
}

const secondaryGroups: NavGroup[] = [
  {
    label: "กระบวนการ",
    items: [
      { href: "/triggers", label: "ทริกเกอร์", icon: Zap, page: "trigger" },
      { href: "/workflows", label: "เวิร์กโฟลว์", icon: GitBranch, page: "workflow" },
      { href: "/quick-replies", label: "คำตอบเร็ว", icon: Reply, page: "quickreply" },
      { href: "/knowledge", label: "ฐานความรู้", icon: BookOpen, page: "kb" },
      { href: "/zaapi-kb-mapping", label: "แมป Zaapi KB", icon: Map, page: "kb" },
      { href: "/generations", label: "Gen Pipeline", icon: Database, page: "kb" },
      { href: "/persona", label: "ตัวแทนร้าน", icon: Sparkles, page: "persona" },
      { href: "/shop-settings", label: "ตั้งค่าร้าน", icon: Settings2, page: "shop-setting" },
    ],
  },
  {
    label: "การทดสอบบอท",
    items: [
      { href: "/test-chat/shopee", label: "ทดสอบบอท", icon: Bot, page: "testchat" },
      { href: "/shadow-inbox", label: "กล่องเงา", icon: Ghost, page: "shadow-inbox" },
      { href: "/botworker", label: "เครื่องบอท", icon: Wrench, page: "botworker" },
      { href: "/test-assignment", label: "ทดสอบจ่ายงาน", icon: TestTube2, page: "test-assignment" },
      { href: "/live-assignment", label: "จ่ายงานสด", icon: Headset, page: "live-assignment" },
      { href: "/replay-compare", label: "เปรียบเทียบรีเพลย์", icon: Scale, page: "replay-compare" },
      { href: "/test-results", label: "ผลการทดสอบ", icon: ClipboardCheck, page: "test-result" },
      { href: "/admin-review-kpi", label: "KPI รีวิว", icon: Gauge, page: "admin-review-kpi" },
      { href: "/admin-chat-result", label: "ผลแชทแอดมิน", icon: FileSearch, page: "admin-chat-result" },
      { href: "/test-chat-result", label: "ผลทดสอบแชท", icon: FileSearch, page: "test-chat-result" },
    ],
  },
  {
    label: "จัดการ",
    items: [
      { href: "/shops", label: "ร้านค้า", icon: Store, page: "shop" },
      { href: "/contacts", label: "รายชื่อลูกค้า", icon: ContactIcon, page: "customer" },
      { href: "/team", label: "ทีม & มอบหมาย", icon: Headset, page: "team" },
      { href: "/backlog", label: "งานค้างรอจ่าย", icon: Inbox, page: "backlog" },
      { href: "/users", label: "จัดการผู้ใช้", icon: Users, page: "user" },
    ],
  },
  {
    label: "ตั้งค่า",
    items: [
      { href: "/admin-config", label: "ตั้งค่าแอดมิน", icon: Sliders, page: "admin-config" },
      { href: "/config", label: "ตั้งค่าระบบ", icon: Shield, page: "config" },
      { href: "/llm", label: "LLM & API Keys", icon: KeyRound, page: "llm" },
      { href: "/roles", label: "สิทธิ์การใช้งาน", icon: UserCog, page: "role-admin" },
      { href: "/logs", label: "บันทึกระบบ", icon: ScrollText, page: "log" },
    ],
  },
  {
    // footer items — ไม่มี role gate (เหมือน Sidebar footer)
    label: "ทั่วไป",
    items: [
      { href: "/help", label: "คู่มือ", icon: HelpCircle },
      { href: "/settings", label: "โปรไฟล์", icon: Settings },
    ],
  },
];

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuQuery, setMenuQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Filter by permission
  const visiblePrimary = useMemo(
    () => primaryItems.filter((item) => !item.page || canAccessPage(user, item.page)),
    [user]
  );
  const visibleSecondaryGroups = useMemo(
    () =>
      secondaryGroups
        .map((g) => ({
          ...g,
          items: g.items.filter((item) => !item.page || canAccessPage(user, item.page)),
        }))
        .filter((g) => g.items.length > 0),
    [user]
  );

  const isActive = (href: string) =>
    pathname === href || (href !== "/dashboard" && pathname?.startsWith(href));

  // ขยายกลุ่มที่มีหน้าปัจจุบันเมื่อเปิดเมนู + ปิดด้วย Escape
  useEffect(() => {
    if (!moreOpen) return;
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      for (const g of visibleSecondaryGroups) {
        if (g.items.some((i) => isActive(i.href))) next.add(g.label);
      }
      return next;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moreOpen, pathname]);

  function toggleGroup(label: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  async function handleLogout() {
    const ok = await confirm.ask({
      title: "ออกจากระบบ?",
      message: "คุณต้องการออกจากระบบจริงๆ ใช่ไหม?",
      confirmText: "ออกจากระบบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await logout();
      toast.success("ออกจากระบบแล้ว");
      router.replace("/login");
    } catch {
      toast.error("ออกจากระบบไม่สำเร็จ");
    }
  }

  const isSearching = menuQuery.trim().length > 0;
  const queryLower = menuQuery.trim().toLowerCase();
  const displayGroups = isSearching
    ? visibleSecondaryGroups
        .map((g) => ({
          ...g,
          items: g.items.filter((i) => i.label.toLowerCase().includes(queryLower)),
        }))
        .filter((g) => g.items.length > 0)
    : visibleSecondaryGroups;

  return (
    <>
      {/* Bottom navigation bar — fixed ที่ล่างสุดของจอ มือถือเท่านั้น */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-border safe-area-pb">
        <div className="flex items-stretch h-14">
          {visiblePrimary.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  active ? "text-brand" : "text-text-muted"
                }`}
              >
                <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
                <span className={`text-[10px] ${active ? "font-medium" : ""}`}>
                  {item.label}
                </span>
              </Link>
            );
          })}
          {/* More button */}
          <button
            onClick={() => setMoreOpen(true)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
              moreOpen ? "text-brand" : "text-text-muted"
            }`}
          >
            <MoreHorizontal size={20} strokeWidth={moreOpen ? 2.2 : 1.8} />
            <span className={`text-[10px] ${moreOpen ? "font-medium" : ""}`}>เพิ่มเติม</span>
          </button>
        </div>
      </nav>

      {/* "More" menu — full-screen: search + collapsible groups + user bar */}
      {moreOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col bg-surface animate-slide-up">
          {/* Header — title + close + search (sticky) */}
          <div className="shrink-0 border-b border-border safe-area-pt">
            <div className="flex items-center gap-2 px-4 pt-3 pb-2">
              <h3 className="flex-1 font-semibold text-text text-base">เมนูทั้งหมด</h3>
              <button
                onClick={() => setMoreOpen(false)}
                className="w-10 h-10 rounded-lg hover:bg-surface-2 flex items-center justify-center text-text-muted transition-colors"
                aria-label="ปิด"
              >
                <X size={20} />
              </button>
            </div>
            <div className="px-4 pb-3">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
                <input
                  type="text"
                  value={menuQuery}
                  onChange={(e) => setMenuQuery(e.target.value)}
                  placeholder="ค้นหาเมนู..."
                  aria-label="ค้นหาเมนู"
                  className="w-full h-10 pl-9 pr-9 rounded-xl border border-border bg-surface-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
                />
                {menuQuery && (
                  <button
                    onClick={() => setMenuQuery("")}
                    aria-label="ล้างการค้นหา"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-subtle hover:text-text"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Groups — collapsible, auto-expand กลุ่มที่มีหน้าปัจจุบัน */}
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {displayGroups.length === 0 && (
              <div className="py-12 text-center text-sm text-text-muted">
                ไม่พบเมนู “{menuQuery.trim()}”
              </div>
            )}
            {displayGroups.map((group) => {
              const expanded = isSearching || expandedGroups.has(group.label);
              const groupActive = group.items.some((i) => isActive(i.href));
              return (
                <div key={group.label} className="mb-1">
                  <button
                    onClick={() => toggleGroup(group.label)}
                    aria-expanded={expanded}
                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-surface-2 transition-colors"
                  >
                    <span className={`text-[11px] font-semibold uppercase tracking-wider ${groupActive ? "text-brand" : "text-text-subtle"}`}>
                      {group.label}
                    </span>
                    {groupActive && <span className="w-1.5 h-1.5 rounded-full bg-brand shrink-0" />}
                    <span className="ml-auto text-[10px] text-text-subtle">{group.items.length}</span>
                    {expanded ? (
                      <ChevronDown size={16} className="text-text-subtle shrink-0" />
                    ) : (
                      <ChevronRight size={16} className="text-text-subtle shrink-0" />
                    )}
                  </button>
                  {expanded && (
                    <div className="space-y-0.5 pb-1">
                      {group.items.map((item) => {
                        const active = isActive(item.href);
                        const Icon = item.icon;
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            onClick={() => setMoreOpen(false)}
                            className={`flex items-center gap-3 min-h-[48px] px-3 py-2.5 rounded-xl transition-colors ${
                              active
                                ? "bg-brand/10 text-brand"
                                : "text-text-muted hover:bg-surface-2 hover:text-text active:bg-surface-3"
                            }`}
                          >
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                              active ? "bg-brand/15" : "bg-surface-2"
                            }`}>
                              <Icon size={18} />
                            </div>
                            <span className="text-sm font-medium">{item.label}</span>
                            {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-brand shrink-0" />}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* User bar — เห็น identity + logout บนมือถือ (เดิมไม่มีทางออกจากระบบ) */}
          {user && (
            <div className="shrink-0 border-t border-border px-4 py-3 safe-area-pb">
              <div className="flex items-center gap-3">
                <Link
                  href="/settings"
                  onClick={() => setMoreOpen(false)}
                  className="flex items-center gap-3 flex-1 min-w-0 rounded-lg"
                  aria-label={`โปรไฟล์: ${user.name || user.username}`}
                >
                  <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-xs font-bold text-white shrink-0">
                    {initials(user.name || user.username)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text truncate">
                      {user.name || user.username}
                    </div>
                    <span className="inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent/80 text-white">
                      {roleLabel[user.role] || user.role}
                    </span>
                  </div>
                </Link>
                <button
                  onClick={handleLogout}
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-text-muted hover:bg-error/10 hover:text-error transition-colors shrink-0"
                  title="ออกจากระบบ"
                  aria-label="ออกจากระบบ"
                >
                  <LogOut size={18} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

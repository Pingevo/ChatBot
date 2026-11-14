// MobileNav — bottom navigation and a searchable, permission-aware route index.
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
  Inbox,
  Search,
  ArrowLeft,
  ChevronRight,
  X,
  LogOut,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canAccessPage, type PageKey } from "@/lib/roles";
import { confirm } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

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

const primaryItems: NavItem[] = [
  { href: "/dashboard", label: "หน้าแรก", icon: LayoutDashboard, page: "dashboard" },
  { href: "/tickets", label: "แชท", icon: MessageSquare, page: "ticket" },
  { href: "/analytics/live", label: "สถิติ", icon: BarChart3, page: "analytics" },
];

interface NavGroup {
  label: string;
  items: NavItem[];
}

const secondaryGroups: NavGroup[] = [
  {
    label: "สถิติ",
    items: [
      { href: "/analytics", label: "ภาพรวมสถิติ", icon: BarChart3, page: "analytics" },
      { href: "/analytics/performance", label: "ประสิทธิภาพ", icon: Gauge, page: "analytics" },
      { href: "/analytics/admin-activity", label: "กิจกรรมแอดมิน", icon: Users, page: "analytics" },
    ],
  },
  {
    label: "แชท",
    items: [
      { href: "/chats", label: "รายการแชท", icon: MessageSquare, page: "ticket" },
    ],
  },
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
      { href: "/test-chat/tiktok", label: "ทดสอบบอท TikTok", icon: Bot, page: "testchat" },
      { href: "/test-chat/lazada", label: "ทดสอบบอท Lazada", icon: Bot, page: "testchat" },
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
    label: "ทั่วไป",
    items: [{ href: "/help", label: "คู่มือ", icon: HelpCircle }],
  },
];

const groupIcons: Record<string, LucideIcon> = {
  "สถิติ": BarChart3,
  "แชท": MessageSquare,
  "กระบวนการ": GitBranch,
  "การทดสอบบอท": TestTube2,
  "จัดการ": Users,
  "ตั้งค่า": Settings2,
  "ทั่วไป": HelpCircle,
};

export function MobileNav({ keyboardOpen = false }: { keyboardOpen?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuQuery, setMenuQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  const visiblePrimary = useMemo(
    () => primaryItems.filter((item) => !item.page || canAccessPage(user, item.page)),
    [user]
  );
  const visibleGroups = useMemo(
    () => secondaryGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.page || canAccessPage(user, item.page)),
      }))
      .filter((group) => group.items.length > 0),
    [user]
  );

  const isActive = (href: string) =>
    pathname === href || (href !== "/dashboard" && pathname?.startsWith(href));
  const query = menuQuery.trim().toLowerCase();
  const isSearching = query.length > 0;
  const displayedGroups = isSearching
    ? visibleGroups
      .map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLowerCase().includes(query)) }))
      .filter((group) => group.items.length > 0 || (user && group.label === "ทั่วไป" && "ออกจากระบบ".includes(query)))
    : selectedGroup
      ? visibleGroups.filter((group) => group.label === selectedGroup)
      : [];

  useEffect(() => {
    setMoreOpen(false);
    setMenuQuery("");
    setSelectedGroup(null);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

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

  function openMenu() {
    setSelectedGroup(null);
    setMenuQuery("");
    setMoreOpen(true);
  }

  function goToMenuBack() {
    if (isSearching) {
      setMenuQuery("");
      return;
    }
    setSelectedGroup(null);
  }

  function renderPrimaryLink(item: NavItem) {
    const active = isActive(item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className={`flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors ${active ? "text-brand" : "text-text-muted"}`}
      >
        <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
        <span className={`text-[10px] ${active ? "font-medium" : ""}`}>{item.label}</span>
      </Link>
    );
  }

  return (
    <>
      <nav
        aria-label="เมนูหลัก"
        className={`tablet-touch-nav md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface border-t border-border safe-area-pb ${keyboardOpen ? "hidden" : ""}`}
      >
        <div className="flex h-14 items-stretch">
          {visiblePrimary.slice(0, 2).map(renderPrimaryLink)}
          <button
            type="button"
            onClick={openMenu}
            aria-expanded={moreOpen}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors ${moreOpen ? "text-brand" : "text-text-muted"}`}
          >
            <MoreHorizontal size={20} strokeWidth={moreOpen ? 2.2 : 1.8} />
            <span className={`text-[10px] ${moreOpen ? "font-medium" : ""}`}>เมนู</span>
          </button>
          {visiblePrimary.slice(2).map(renderPrimaryLink)}
          {user && (
            <Link
              href="/settings"
              aria-current={isActive("/settings") ? "page" : undefined}
              aria-label={`โปรไฟล์ ${user.name || user.username}`}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors ${isActive("/settings") ? "text-brand" : "text-text-muted"}`}
            >
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-offset-1 ring-offset-surface ${isActive("/settings") ? "bg-accent ring-accent/30" : "bg-navy ring-navy/15"}`}>
                {initials(user.name || user.username)}
              </span>
              <span className={`text-[10px] ${isActive("/settings") ? "font-medium" : ""}`}>โปรไฟล์</span>
            </Link>
          )}
        </div>
      </nav>

      {moreOpen && (
        <div
          className="mobile-menu-overlay md:hidden fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
          style={{ height: "var(--app-vh, 100dvh)" }}
        >
          <button type="button" className="mobile-menu-backdrop" onClick={() => setMoreOpen(false)} aria-label="ปิดเมนู" />
          <section className="mobile-menu-dialog" role="dialog" aria-modal="true" aria-label="เมนูหลัก">
            <header className="shrink-0 border-b border-border safe-area-pt">
              <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                {(selectedGroup || isSearching) ? (
                  <button
                    type="button"
                    onClick={goToMenuBack}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2"
                    aria-label={isSearching ? "ล้างการค้นหา" : "กลับไปหมวดหมู่"}
                  >
                    <ArrowLeft size={19} />
                  </button>
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center text-accent" aria-hidden="true">
                    <MoreHorizontal size={20} />
                  </div>
                )}
                <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text">
                  {isSearching ? "ผลการค้นหา" : selectedGroup || "เมนูทั้งหมด"}
                </h2>
              </div>
              <div className="px-4 pb-3">
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
                  <input
                    type="text"
                    value={menuQuery}
                    onChange={(event) => {
                      setMenuQuery(event.target.value);
                      if (event.target.value.trim()) setSelectedGroup(null);
                    }}
                    placeholder="ค้นหาเมนู..."
                    aria-label="ค้นหาเมนู"
                    autoComplete="off"
                    enterKeyHint="search"
                    className="h-11 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-10 text-[13px] text-text placeholder:text-text-subtle focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                  {menuQuery && (
                    <button
                      type="button"
                      onClick={() => setMenuQuery("")}
                      aria-label="ล้างการค้นหา"
                      className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center text-text-subtle hover:text-text"
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
              </div>
            </header>

            <div className="mobile-menu-scene" aria-hidden="true">
              <span className="mobile-menu-orbit" />
              <span className="mobile-menu-spark mobile-menu-spark--one" />
              <span className="mobile-menu-spark mobile-menu-spark--two" />
              <span className="mobile-menu-spark mobile-menu-spark--three" />
              <span className="mobile-menu-walker">
                <span className="mobile-menu-walker-shadow" />
                <span className="mobile-menu-walker-sprite mobile-menu-mascot" />
              </span>
            </div>

            <div className="mobile-menu-body min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {!isSearching && !selectedGroup && (
                <div className="divide-y divide-border-subtle">
                  {visibleGroups.map((group) => {
                    const Icon = groupIcons[group.label] ?? MoreHorizontal;
                    const activeItem = group.items.find((item) => isActive(item.href));
                    const itemCount = group.items.length + (user && group.label === "ทั่วไป" ? 1 : 0);
                    return (
                      <button
                        key={group.label}
                        type="button"
                        onClick={() => setSelectedGroup(group.label)}
                        className="mobile-menu-row flex min-h-14 w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-surface-1 active:bg-surface-2"
                      >
                        <Icon size={17} className={activeItem ? "shrink-0 text-accent" : "shrink-0 text-navy"} />
                        <span className="min-w-0 flex-1 text-[13px] font-medium text-text">{group.label}</span>
                        {activeItem && <span className="max-w-32 truncate text-[10px] text-text-subtle">{activeItem.label}</span>}
                        <span className="text-[10px] tabular-nums text-text-subtle">{itemCount}</span>
                        <ChevronRight size={15} className="shrink-0 text-text-subtle" />
                      </button>
                    );
                  })}
                </div>
              )}

              {(isSearching || selectedGroup) && displayedGroups.length === 0 && (
                <div className="px-5 py-12 text-center text-[13px] text-text-muted">
                  ไม่พบเมนู “{menuQuery.trim()}”
                </div>
              )}

              {(isSearching || selectedGroup) && displayedGroups.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  {isSearching && <h3 className="px-5 pt-4 pb-1 text-[10px] font-semibold text-text-subtle">{group.label}</h3>}
                  <div className="divide-y divide-border-subtle">
                    {group.items.map((item) => {
                      const active = isActive(item.href);
                      const Icon = item.icon;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => setMoreOpen(false)}
                          aria-current={active ? "page" : undefined}
                          className={`mobile-menu-row flex min-h-12 items-center gap-3 px-5 py-2 text-[13px] transition-colors ${active ? "bg-accent-softer text-accent" : "text-text hover:bg-surface-1 active:bg-surface-2"}`}
                        >
                          <Icon size={16} className={active ? "shrink-0 text-accent" : "shrink-0 text-text-subtle"} />
                          <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                          {active && <span className="text-[10px] text-accent">หน้านี้</span>}
                        </Link>
                      );
                    })}
                    {user && group.label === "ทั่วไป" && (!isSearching || "ออกจากระบบ".includes(query)) && (
                      <button
                        type="button"
                        onClick={handleLogout}
                        className="mobile-menu-row flex min-h-12 w-full items-center gap-3 px-5 py-2 text-left text-[13px] text-text transition-colors hover:bg-error/5 active:bg-error/10"
                        aria-label="ออกจากระบบ"
                      >
                        <LogOut size={16} className="shrink-0 text-error" />
                        <span className="min-w-0 flex-1 truncate font-medium">ออกจากระบบ</span>
                      </button>
                    )}
                  </div>
                </section>
              ))}
            </div>

            <footer className="mobile-menu-footer shrink-0 border-t border-border px-4 py-2.5 safe-area-pb">
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                className="ml-auto flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-1 text-text-muted shadow-sm transition-colors hover:border-accent/25 hover:bg-accent-softer hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="ปิดเมนู"
                title="ปิดเมนู"
              >
                <X size={18} />
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

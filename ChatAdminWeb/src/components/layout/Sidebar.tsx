// Sidebar — shadcn-style collapsible sidebar.
// Composable structure: Header → Content (Group → GroupLabel → Menu) → Footer → Rail
// Features: collapse to icons, keyboard shortcut (cmd+b), rail toggle, grouped nav.
"use client";
import { useState, useEffect, useRef, type PointerEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { canAccessPage, type PageKey } from "@/lib/roles";
import { confirm } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import {
  MessageSquare,
  LayoutDashboard,
  BookOpen,
  Zap,
  Reply,
  BarChart3,
  Store,
  Users,
  Bot,
  KeyRound,
  Shield,
  ContactIcon,
  Headset,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  ChevronDown,
  ChevronRight,
  ScrollText,
  History,
  TestTube2,
  Scale,
  Settings2,
  Sliders,
  Ghost,
  Wrench,
  Sparkles,
  ClipboardCheck,
  Gauge,
  FileSearch,
  Search,
  X,
  HelpCircle,
  UserCog,
  Inbox,
  Map,
  Database,
  Grip,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { GenPendingDot } from "./GenPendingDot";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

interface NavChild {
  href: string;
  label: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  badgeTag?: string;
  page?: PageKey;          // maps to permission system — if set, filtered by canAccessPage
  roles?: string[]; // legacy — used if page is not set
  children?: NavChild[];
}

interface NavGroup {
  label: string;
  icon?: LucideIcon;       // optional — shown when sidebar is collapsed
  collapsible?: boolean;   // if true, group label is a toggle button (expand/collapse items)
  items: NavItem[];
}

/* ------------------------------------------------------------------ */
/* Navigation config                                                  */
/* ------------------------------------------------------------------ */

const navGroups: NavGroup[] = [
  {
    label: "หลัก",
    items: [
      { href: "/dashboard", label: "แดชบอร์ด", icon: LayoutDashboard, page: "dashboard" },
      { href: "/analytics/live", label: "สถิติ", icon: BarChart3, page: "analytics" },
      { href: "/tickets", label: "แชท / ตั๋ว", icon: MessageSquare, badge: "live", page: "ticket" },
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
      { href: "/generations", label: "Gen Pipeline", icon: Database, badge: "gen-pending", page: "kb" },
      { href: "/persona", label: "ตัวแทนร้าน", icon: Sparkles, page: "persona" },
      { href: "/shop-settings", label: "ตั้งค่าร้าน", icon: Settings2, page: "shop-setting" },
    ],
  },
  {
    label: "การทดสอบบอท",
    collapsible: true,
    items: [
      {
        href: "/test-chat/shopee",
        label: "ทดสอบบอท",
        icon: Bot,
        page: "testchat",
        children: [
          { href: "/test-chat/shopee", label: "Shopee" },
          { href: "/test-chat/tiktok", label: "TikTok" },
          { href: "/test-chat/lazada", label: "Lazada" },
        ],
      },
      { href: "/shadow-inbox", label: "กล่องเงา (Shadow Inbox)", icon: Ghost, page: "shadow-inbox" },
      { href: "/botworker", label: "เครื่องบอท (Bot Worker)", icon: Wrench, badge: "auto", page: "botworker" },
      { href: "/test-assignment", label: "ทดสอบจ่ายงาน", icon: TestTube2, page: "test-assignment" },
      { href: "/live-assignment", label: "จ่ายงานสด (Live)", icon: Headset, page: "live-assignment" },
      { href: "/replay-compare", label: "เปรียบเทียบรีเพลย์", icon: Scale, page: "replay-compare" },
      { href: "/test-results", label: "ผลการทดสอบ", icon: ClipboardCheck, page: "test-result" },
      { href: "/admin-review-kpi", label: "KPI รีวิวแอดมิน", icon: Gauge, page: "admin-review-kpi" },
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
      { href: "/users", label: "จัดการผู้ใช้", icon: Users, badgeTag: "Super", page: "user" },
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
];

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return "?";
  return parts[0].slice(0, 2);
}

const roleLabel: Record<string, string> = {
  superadmin: "SuperAdmin",
  admin: "Admin",
  dev: "Dev",
};

const desktopGroupIcons: Record<string, LucideIcon> = {
  "หลัก": LayoutDashboard,
  "กระบวนการ": GitBranch,
  "การทดสอบบอท": TestTube2,
  "จัดการ": Users,
  "ตั้งค่า": Settings2,
  "ทั่วไป": HelpCircle,
};

function clampDesktopNavPosition(x: number, y: number) {
  const size = 56;
  const inset = 16;
  return {
    x: Math.max(inset, Math.min(x, window.innerWidth - size - inset)),
    y: Math.max(inset, Math.min(y, window.innerHeight - size - inset)),
  };
}

function DesktopNavLauncher({
  groups,
  pathname,
  user,
  onLogout,
}: {
  groups: NavGroup[];
  pathname: string;
  user: { name?: string; username?: string; role: string } | null;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const generalGroup: NavGroup = {
    label: "ทั่วไป",
    icon: HelpCircle,
    items: [{ href: "/help", label: "คู่มือการใช้งาน", icon: HelpCircle }],
  };
  const allGroups = [...groups, generalGroup];
  const searchText = query.trim().toLocaleLowerCase();
  const visibleGroups = allGroups
    .map((group) => ({
      ...group,
      items: searchText
        ? group.items.filter((item) =>
            item.label.toLocaleLowerCase().includes(searchText) ||
            item.children?.some((child) => child.label.toLocaleLowerCase().includes(searchText))
          )
        : group.items,
    }))
    .filter((group) =>
      group.items.length > 0 || (searchText && group.label === "ทั่วไป" && "ออกจากระบบ".includes(searchText))
    );
  const selected = allGroups.find((group) => group.label === selectedGroup);
  const displayedGroups = selected ? [selected] : visibleGroups;
  const activeLabel = groups.flatMap((group) => group.items).flatMap((item) => {
    const candidates = item.children?.length ? item.children : [{ href: item.href, label: item.label }];
    return candidates.filter((candidate) => pathname === candidate.href || pathname.startsWith(candidate.href + "/"));
  })[0]?.label;

  useEffect(() => {
    try {
      const stored = localStorage.getItem("itsrc.desktop-nav-position");
      if (!stored) return;
      const parsed = JSON.parse(stored) as { x?: number; y?: number };
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        setPosition(clampDesktopNavPosition(parsed.x!, parsed.y!));
      }
    } catch {
      localStorage.removeItem("itsrc.desktop-nav-position");
    }
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    if (open) window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => {
    const toggleDesktopMenu = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      setOpen((current) => !current);
      setSelectedGroup(null);
      setQuery("");
    };
    window.addEventListener("keydown", toggleDesktopMenu);
    return () => window.removeEventListener("keydown", toggleDesktopMenu);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchInput.current?.focus());
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setSelectedGroup(null);
    setQuery("");
  }, [pathname]);

  useEffect(() => {
    const clampAfterResize = () => {
      setPosition((current) => current ? clampDesktopNavPosition(current.x, current.y) : null);
    };
    window.addEventListener("resize", clampAfterResize);
    return () => window.removeEventListener("resize", clampAfterResize);
  }, []);

  const positionPanel = () => {
    const x = position?.x ?? 20;
    const y = position?.y ?? window.innerHeight - 116;
    const panelWidth = Math.min(368, window.innerWidth - 32);
    const panelHeight = Math.min(540, window.innerHeight - 32);
    const left = Math.max(16, Math.min(x, window.innerWidth - panelWidth - 16));
    if (y > window.innerHeight * 0.55) {
      return { left, bottom: Math.max(16, window.innerHeight - y + 12) };
    }
    return { left, top: Math.max(16, Math.min(y + 66, window.innerHeight - panelHeight - 16)) };
  };

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      moved: false,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - activeDrag.startX;
    const deltaY = event.clientY - activeDrag.startY;
    if (!activeDrag.moved && Math.hypot(deltaX, deltaY) < 5) return;
    activeDrag.moved = true;
    setOpen(false);
    setPosition(clampDesktopNavPosition(activeDrag.originX + deltaX, activeDrag.originY + deltaY));
  }

  function handlePointerUp(event: PointerEvent<HTMLButtonElement>) {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!activeDrag.moved) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 120);
    setPosition((current) => {
      if (current) {
        try {
          localStorage.setItem("itsrc.desktop-nav-position", JSON.stringify(current));
        } catch {
          // Moving the launcher still works when storage is unavailable.
        }
      }
      return current;
    });
  }

  function openCategory(label: string) {
    setSelectedGroup(label);
    setQuery("");
  }

  function renderRoute(item: NavItem) {
    const routes = item.children?.length
      ? item.children
      : [{ href: item.href, label: item.label }];
    const filteredRoutes = searchText
      ? routes.filter((route) => route.label.toLocaleLowerCase().includes(searchText) || item.label.toLocaleLowerCase().includes(searchText))
      : routes;
    const Icon = item.icon;
    return filteredRoutes.map((route) => {
      const active = pathname === route.href || pathname.startsWith(route.href + "/");
      return (
        <Link
          key={route.href}
          href={route.href}
          onClick={() => setOpen(false)}
          aria-current={active ? "page" : undefined}
          className={`desktop-nav-route ${active ? "is-active" : ""}`}
        >
          <Icon size={17} aria-hidden="true" />
          <span>{route.label}</span>
          {active && <span className="desktop-nav-current">หน้านี้</span>}
          <ChevronRight size={15} aria-hidden="true" />
        </Link>
      );
    });
  }

  return (
    <div className="desktop-nav-launcher" data-open={open || undefined}>
      {open && (
        <>
          <button
            type="button"
            className="desktop-nav-dismiss fixed inset-0 z-[88]"
            onClick={() => setOpen(false)}
            aria-label="ปิดเมนู"
          />
          <section
            className="desktop-nav-panel fixed z-[90]"
            style={positionPanel()}
            role="dialog"
            aria-label="เมนูนำทาง"
          >
            <header className="desktop-nav-panel-header">
              <div className="desktop-nav-panel-heading">
                {selected || searchText ? (
                  <button
                    type="button"
                    className="desktop-nav-back"
                    onClick={() => {
                      setSelectedGroup(null);
                      setQuery("");
                    }}
                    aria-label="กลับไปหมวดเมนู"
                  >
                    <ChevronRight size={17} />
                  </button>
                ) : (
                  <LayoutDashboard size={18} className="text-accent" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <h2>{searchText ? "ผลการค้นหา" : selected?.label ?? "เมนูทั้งหมด"}</h2>
                  <p>{activeLabel ? `หน้าปัจจุบัน · ${activeLabel}` : "เลือกหมวด แล้วเลือกหน้าที่ต้องการ"}</p>
                </div>
                <button
                  type="button"
                  className="desktop-nav-close"
                  onClick={() => setOpen(false)}
                  aria-label="ปิดเมนู"
                  title="ปิดเมนู"
                >
                  <X size={17} />
                </button>
              </div>
              <label className="desktop-nav-search">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchInput}
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedGroup(null);
                  }}
                  placeholder="ค้นหาเมนู..."
                  aria-label="ค้นหาเมนู"
                />
              </label>
            </header>

            <div className="desktop-nav-panel-body">
              {!searchText && !selected && (
                <div className="desktop-nav-categories">
                  {allGroups.map((group) => {
                    const Icon = desktopGroupIcons[group.label] ?? group.icon ?? MoreHorizontal;
                    const activeItem = group.items.find((item) =>
                      pathname === item.href || pathname.startsWith(item.href + "/") ||
                      item.children?.some((child) => pathname === child.href || pathname.startsWith(child.href + "/"))
                    );
                    const count = group.items.reduce((total, item) => total + Math.max(1, item.children?.length ?? 0), 0) + (group.label === "ทั่วไป" && user ? 1 : 0);
                    return (
                      <button key={group.label} type="button" className="desktop-nav-category" onClick={() => openCategory(group.label)}>
                        <span className="desktop-nav-category-icon"><Icon size={17} /></span>
                        <span className="desktop-nav-category-copy">
                          <strong>{group.label}</strong>
                          {activeItem && <small>{activeItem.label}</small>}
                        </span>
                        <span className="desktop-nav-count">{count}</span>
                        <ChevronRight size={15} className="text-text-subtle" />
                      </button>
                    );
                  })}
                </div>
              )}

              {(selected || searchText) && displayedGroups.map((group) => (
                <section key={group.label} className="desktop-nav-group" aria-label={group.label}>
                  {searchText && <h3>{group.label}</h3>}
                  {group.items.map((item) => renderRoute(item))}
                  {user && group.label === "ทั่วไป" && (!searchText || "ออกจากระบบ".includes(searchText)) && (
                    <button type="button" className="desktop-nav-route desktop-nav-logout" onClick={onLogout}>
                      <LogOut size={17} aria-hidden="true" />
                      <span>ออกจากระบบ</span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  )}
                </section>
              ))}

              {(selected || searchText) && displayedGroups.length === 0 && (
                <p className="desktop-nav-empty">ไม่พบเมนู “{query.trim()}”</p>
              )}
            </div>

            {user && (
              <footer className="desktop-nav-panel-footer">
                <Link href="/settings" onClick={() => setOpen(false)} className="desktop-nav-profile">
                  <span className="desktop-nav-avatar">{initials(user.name || user.username || "?")}</span>
                  <span className="desktop-nav-profile-copy">
                    <strong>{user.name || user.username}</strong>
                    <small>{roleLabel[user.role] || user.role} · โปรไฟล์</small>
                  </span>
                  <ChevronRight size={15} aria-hidden="true" />
                </Link>
              </footer>
            )}
          </section>
        </>
      )}

      <button
        type="button"
        className="desktop-nav-orb fixed z-[91]"
        style={position ? { left: position.x, top: position.y } : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 48 : 20;
          const movement: Record<string, [number, number]> = {
            ArrowLeft: [-delta, 0],
            ArrowRight: [delta, 0],
            ArrowUp: [0, -delta],
            ArrowDown: [0, delta],
          };
          const offset = movement[event.key];
          if (!offset) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const next = clampDesktopNavPosition(rect.left + offset[0], rect.top + offset[1]);
          setPosition(next);
          try {
            localStorage.setItem("itsrc.desktop-nav-position", JSON.stringify(next));
          } catch {
            // Keyboard movement still works when storage is unavailable.
          }
        }}
        onClick={() => {
          if (suppressClick.current) return;
          setOpen((current) => !current);
          setSelectedGroup(null);
          setQuery("");
        }}
        aria-label={open ? "ปิดเมนู" : "เปิดเมนู"}
        aria-expanded={open}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
        title="ลากเพื่อย้ายตำแหน่ง · คลิกเพื่อเปิดเมนู"
      >
        <span className="desktop-nav-orb-mark"><LayoutDashboard size={20} /></span>
        <Grip size={12} className="desktop-nav-orb-grip" aria-hidden="true" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Collapsible submenu (items with children)                          */
/* ------------------------------------------------------------------ */

function SubMenu({
  item,
  pathname,
  collapsed,
  onMobileClose,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  onMobileClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = item.icon;
  const childActive = item.children!.some(
    (c) => pathname === c.href || pathname.startsWith(c.href + "/")
  );

  // Auto-expand when a child is active
  useEffect(() => {
    if (childActive) setExpanded(true);
  }, [childActive]);

  if (collapsed) {
    return (
      <Link
        href={item.href}
        onClick={onMobileClose}
        title={item.label}
        aria-label={item.label}
        className={`flex items-center justify-center rounded-lg text-sm transition-colors px-2 py-2 ${
          childActive
            ? "bg-accent/20 text-sidebar-text"
            : "text-sidebar-text-muted hover:bg-white/5 hover:text-sidebar-text"
        }`}
      >
        <Icon size={18} className="shrink-0" />
      </Link>
    );
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={`submenu-${item.href.replace(/\//g, "-")}`}
        className={`flex items-center gap-3 rounded-lg text-sm transition-colors w-full px-3 py-2 ${
          childActive
            ? "bg-accent/15 text-sidebar-text font-medium"
            : "text-sidebar-text-muted hover:bg-white/5 hover:text-sidebar-text"
        }`}
      >
        <Icon size={18} className="shrink-0" />
        <span className="flex-1 text-left whitespace-nowrap">{item.label}</span>
        {item.badgeTag && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-white/10 text-pale-sky/70 shrink-0">
            {item.badgeTag}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-sidebar-text-muted" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-sidebar-text-muted" />
        )}
      </button>
      {expanded && (
        <div id={`submenu-${item.href.replace(/\//g, "-")}`} className="mt-0.5 ml-[26px] space-y-0.5 border-l border-white/10 pl-2">
          {item.children!.map((child) => {
            const cActive = pathname === child.href;
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={onMobileClose}
                className={`flex items-center gap-2 rounded-lg text-sm transition-colors px-3 py-1.5 ${
                  cActive
                    ? "text-sidebar-text font-medium"
                    : "text-sidebar-text-muted hover:text-sidebar-text"
                }`}
              >
                <span className="w-1 h-1 rounded-full bg-current opacity-50" />
                {child.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
  onMobileOpenChange: (open: boolean) => void;
  collapsed: boolean;
  onCollapsedChange: (v: boolean) => void;
}

export function Sidebar({ mobileOpen, onMobileClose, onMobileOpenChange, collapsed, onCollapsedChange }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [navSearch, setNavSearch] = useState("");
  const compactNav = collapsed && !mobileOpen;

  // Keyboard shortcut: toggle the tablet menu or collapse the laptop sidebar.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        if (window.matchMedia("(min-width: 1024px) and (pointer: fine)").matches) return;
        e.preventDefault();
        if (window.matchMedia("(min-width: 768px) and (max-width: 1023.98px)").matches) {
          onMobileOpenChange(!mobileOpen);
        } else {
          onCollapsedChange(!collapsed);
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [collapsed, mobileOpen, onCollapsedChange, onMobileOpenChange]);

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

  // Filter items by permission (page-based) or legacy role list
  const filteredGroups = navGroups
    .map((g) => ({
      ...g,
      items: g.items.filter((item) => {
        if (item.page) return canAccessPage(user, item.page);
        if (item.roles) return user ? item.roles.includes(user.role) : false;
        return true; // no restriction
      }),
    }))
    .filter((g) => g.items.length > 0);

  // When searching, filter items by label and force-expand all collapsible groups
  const isSearching = navSearch.trim().length > 0;
  const searchLower = navSearch.trim().toLowerCase();
  const visibleGroups = isSearching
    ? filteredGroups
        .map((g) => ({
          ...g,
          items: g.items.filter((item) => {
            const matchSelf = item.label.toLowerCase().includes(searchLower);
            const matchChildren = item.children?.some((c) => c.label.toLowerCase().includes(searchLower));
            return matchSelf || matchChildren;
          }),
        }))
        .filter((g) => g.items.length > 0)
    : filteredGroups;

  // Collapsible group state — track which collapsible groups are expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Auto-expand collapsible group when a child route is active
  // ⚠️ ใช้ navGroups (static) แทน filteredGroups เพื่อกัน infinite loop
  //   filteredGroups ถูกสร้างใหม่ทุก render → ถ้าเป็น dependency จะ setState ทุก render → วนซ้ำ
  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      for (const g of navGroups) {
        if (!g.collapsible) continue;
        const childActive = g.items.some(
          (item) =>
            pathname === item.href ||
            pathname.startsWith(item.href + "/") ||
            item.children?.some(
              (c) => pathname === c.href || pathname.startsWith(c.href + "/")
            )
        );
        if (childActive) next.add(g.label);
      }
      return next;
    });
  }, [pathname]);

  function toggleGroup(label: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          className="tablet-nav-scrim fixed inset-0 z-40 hidden bg-black/30 backdrop-blur-[1px] md:block lg:hidden"
          onClick={onMobileClose}
          aria-label="ปิดเมนู"
        />
      )}

      <aside
        data-state={compactNav ? "collapsed" : "expanded"}
        data-tablet-open={mobileOpen || undefined}
          className={`desktop-sidebar
          ${compactNav ? "w-[60px]" : "w-64"}
          hidden md:flex
          fixed z-50 h-full
          bg-sidebar text-sidebar-text flex-col
          transition-[width,transform,box-shadow] duration-200 ease-in-out
          border-r border-white/10
          shadow-[4px_0_24px_-8px_rgba(0,0,0,0.20)]
          ${mobileOpen ? "tablet-nav-open shadow-2xl" : ""}
        `}
      >
        {/* ---- SidebarHeader ---- */}
        <div className="h-14 flex items-center gap-2.5 px-3 shrink-0 border-b border-white/10">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center font-bold text-white text-sm shrink-0 shadow-sm">
            IT
          </div>
          {!compactNav && (
            <div className="overflow-hidden flex-1">
              <div className="font-bold text-sm leading-tight whitespace-nowrap tracking-tight text-sidebar-text">
                ITSRC Panel
              </div>
            </div>
          )}
        </div>

        {/* Toggle button — absolute ที่ขอบขวาของ sidebar
            ระดับเดียวกับโลโก้ (top-4 กลาง h-14 header)
            ครึ่งวงกลม ตัดตรงกลางเส้น sidebar พอดี (-right-3 = ครึ่งวงกลม w-6)
            ขนาดเล็ก (w-6 h-6) แต่ชัด (border + bg + text) */}
        <button
          onClick={() => {
            if (window.matchMedia("(min-width: 768px) and (max-width: 1023.98px)").matches) {
              onMobileOpenChange(!mobileOpen);
            } else {
              onCollapsedChange(!collapsed);
            }
          }}
          className="absolute top-4 -right-3 z-50 w-6 h-6 rounded-full bg-sidebar border border-white/15 text-sidebar-text-muted hover:bg-sidebar-2 hover:text-sidebar-text flex items-center justify-center transition-all shadow-sm"
          title={mobileOpen ? "ปิดเมนู" : compactNav ? "เปิดเมนู (Ctrl+B)" : "ย่อเมนู (Ctrl+B)"}
          aria-label={mobileOpen ? "ปิดเมนู" : compactNav ? "เปิดเมนู" : "ย่อเมนู"}
          aria-expanded={!compactNav}
        >
          {compactNav ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
        </button>

        {/* ---- SidebarContent ---- */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-4 sidebar-scroll">
          {/* Nav search — ช่วยกรองเมนูใน sidebar ที่มี 20+ items */}
          {!compactNav && (
            <div className="relative mb-2">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-text-muted" />
              <input
                type="text"
                value={navSearch}
                onChange={(e) => setNavSearch(e.target.value)}
                placeholder="ค้นหาเมนู..."
                aria-label="ค้นหาเมนู"
                className="w-full h-8 pl-8 pr-7 rounded-lg bg-white/5 text-xs text-sidebar-text placeholder:text-sidebar-text-muted border border-white/10 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 transition-colors"
              />
              {navSearch && (
                <button
                  onClick={() => setNavSearch("")}
                  aria-label="ล้างการค้นหา"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-sidebar-text-muted hover:text-sidebar-text"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}
          {visibleGroups.map((group) => {
            const isExpanded = isSearching || expandedGroups.has(group.label);
            const GroupIcon = group.icon;

            // Check if any item in this group is active (for styling)
            const groupChildActive = group.items.some(
              (item) =>
                pathname === item.href ||
                pathname.startsWith(item.href + "/") ||
                item.children?.some(
                  (c) => pathname === c.href || pathname.startsWith(c.href + "/")
                )
            );

            return (
              <div key={group.label}>
                {/* Group label — collapsible groups have a toggle button */}
                {!compactNav && group.collapsible && (
                  <button
                    onClick={() => toggleGroup(group.label)}
                    aria-expanded={isExpanded}
                    aria-controls={`group-${group.label.replace(/\s/g, "-")}`}
                    className={`flex items-center gap-3 w-full px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                      groupChildActive
                        ? "text-sidebar-text"
                        : "text-sidebar-text-muted hover:bg-white/5 hover:text-sidebar-text"
                    }`}
                  >
                    {GroupIcon && <GroupIcon size={18} className="shrink-0" />}
                    <span className="flex-1 text-left whitespace-nowrap">{group.label}</span>
                    {isExpanded ? (
                      <ChevronDown size={14} className="shrink-0 text-sidebar-text-muted" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-sidebar-text-muted" />
                    )}
                  </button>
                )}
                {!compactNav && !group.collapsible && (
                  <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-sidebar-text-muted">
                    {group.label}
                  </div>
                )}
                {compactNav && (
                  <div className="mx-auto my-1 h-px w-6 bg-white/10" />
                )}

                {/* SidebarMenu — hidden if collapsible group is collapsed */}
                {(!group.collapsible || isExpanded || compactNav) && (
                  <div id={group.collapsible ? `group-${group.label.replace(/\s/g, "-")}` : undefined} className="space-y-0.5">
                    {group.items.map((item) => {
                      const active =
                        pathname === item.href || pathname.startsWith(item.href + "/");
                      const Icon = item.icon;
                      const hasChildren = item.children && item.children.length > 0;

                      if (hasChildren) {
                        return (
                          <SubMenu
                            key={item.href}
                            item={item}
                            pathname={pathname}
                            collapsed={compactNav}
                            onMobileClose={onMobileClose}
                          />
                        );
                      }

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          prefetch
                          onClick={onMobileClose}
                          title={compactNav ? item.label : undefined}
                          aria-label={compactNav ? item.label : undefined}
                          aria-current={active ? "page" : undefined}
                          className={`
                            flex items-center gap-3 rounded-lg text-sm transition-colors relative
                            ${compactNav ? "justify-center px-2 py-2" : "px-3 py-2"}
                            ${active
                              ? "bg-accent/20 text-sidebar-text font-medium"
                              : "text-sidebar-text-muted hover:bg-white/5 hover:text-sidebar-text"
                            }
                          `}
                        >
                          {/* Active indicator bar (shadcn style) */}
                          {active && (
                            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full bg-accent-light" />
                          )}
                          <Icon size={18} className="shrink-0" />
                          {!compactNav && (
                            <span className="flex-1 whitespace-nowrap">{item.label}</span>
                          )}
                          {!compactNav && item.badgeTag && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-white/10 text-sidebar-text-muted shrink-0">
                              {item.badgeTag}
                            </span>
                          )}
                          {!compactNav && item.badge === "live" && (
                            <span className="w-2 h-2 rounded-full bg-error animate-pulse-soft shrink-0" />
                          )}
                          {compactNav && item.badge === "live" && (
                            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-error animate-pulse-soft" />
                          )}
                          {item.badge === "gen-pending" && (
                            <GenPendingDot collapsed={compactNav} />
                          )}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ---- SidebarFooter ---- */}
        {user && (
          <div className="border-t border-white/10 p-2 shrink-0 space-y-1">
            {/* Help button */}
            <Link
              href="/help"
              onClick={onMobileClose}
              title={compactNav ? "คู่มือการใช้งาน" : undefined}
              aria-label={compactNav ? "คู่มือการใช้งาน" : undefined}
              className={`flex items-center gap-2.5 rounded-lg p-2 hover:bg-white/5 transition-colors ${
                compactNav ? "justify-center" : ""
              }`}
            >
              <HelpCircle size={18} className="text-sidebar-text-muted shrink-0" />
              {!compactNav && (
                <span className="text-sm text-sidebar-text-muted">คู่มือการใช้งาน</span>
              )}
            </Link>
            {/* 🔒 P3: Changed from div onClick → Link for keyboard accessibility */}
            <div className={`flex items-center gap-2.5 rounded-lg p-2 hover:bg-white/5 transition-colors ${compactNav ? "justify-center" : ""}`}>
              <Link
                href="/settings"
                onClick={() => onMobileClose()}
                className="flex items-center gap-2.5 flex-1 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded"
                title="ไปที่โปรไฟล์"
                aria-label={`โปรไฟล์: ${user.name || user.username}`}
              >
                <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-xs font-bold text-white shrink-0">
                  {initials(user.name || user.username)}
                </div>
                {!compactNav && (
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-sidebar-text truncate">
                      {user.name || user.username}
                    </div>
                    <span className="inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent/80 text-white">
                      {roleLabel[user.role] || user.role}
                    </span>
                  </div>
                )}
              </Link>
              {!compactNav && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLogout();
                  }}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-sidebar-text-muted hover:bg-white/10 hover:text-sidebar-text transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                  title="ออกจากระบบ"
                  aria-label="ออกจากระบบ"
                >
                  <LogOut size={14} />
                </button>
              )}
            </div>
          </div>
        )}

      </aside>
      <DesktopNavLauncher
        groups={filteredGroups}
        pathname={pathname}
        user={user}
        onLogout={handleLogout}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* SidebarTrigger — button that lives in the main content area        */
/* ⚠️ Deprecated — ปุ่ม toggle ย้ายเข้าไปใน sidebar แล้ว (ด้านบน)       */
/* ------------------------------------------------------------------ */

// Sidebar — shadcn-style collapsible sidebar.
// Composable structure: Header → Content (Group → GroupLabel → Menu) → Footer → Rail
// Features: collapse to icons, keyboard shortcut (cmd+b), rail toggle, grouped nav.
"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/authStore";
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
  Shield,
  ContactIcon,
  Headset,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  ChevronDown,
  ChevronRight,
  ScrollText,
  FlaskConical,
  History,
  type LucideIcon,
} from "lucide-react";

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
  roles?: ("superadmin" | "admin" | "dev")[];
  children?: NavChild[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/* ------------------------------------------------------------------ */
/* Navigation config                                                  */
/* ------------------------------------------------------------------ */

const navGroups: NavGroup[] = [
  {
    label: "หลัก",
    items: [
      { href: "/dashboard", label: "แดชบอร์ด", icon: LayoutDashboard },
      { href: "/analytics/live", label: "สถิติ", icon: BarChart3 },
      { href: "/tickets", label: "แชท / ตั๋ว", icon: MessageSquare, badge: "live" },
    ],
  },
  {
    label: "เครื่องมือ",
    items: [
      { href: "/triggers", label: "ทริกเกอร์", icon: Zap },
      { href: "/quick-replies", label: "คำตอบเร็ว", icon: Reply },
      { href: "/knowledge", label: "ฐานความรู้", icon: BookOpen },
      {
        href: "/test-chat/shopee",
        label: "ทดสอบบอท",
        icon: Bot,
        roles: ["superadmin", "admin", "dev"],
        badgeTag: "Dev",
        children: [
          { href: "/test-chat/shopee", label: "Shopee" },
          { href: "/test-chat/tiktok", label: "TikTok" },
          { href: "/test-chat/lazada", label: "Lazada" },
        ],
      },
      { href: "/shadow-inbox", label: "Shadow Inbox", icon: FlaskConical, roles: ["dev"], badgeTag: "Dev" },
    ],
  },
  {
    label: "จัดการ",
    items: [
      { href: "/shops", label: "ร้านค้า", icon: Store },
      { href: "/contacts", label: "รายชื่อลูกค้า", icon: ContactIcon },
      { href: "/team", label: "ทีม & มอบหมาย", icon: Headset, roles: ["superadmin", "admin", "dev"] },
      { href: "/users", label: "จัดการผู้ใช้", icon: Users, roles: ["superadmin", "dev"], badgeTag: "Super" },
      { href: "/logs", label: "บันทึกระบบ", icon: ScrollText, roles: ["superadmin", "dev"] },
      { href: "/config", label: "ตั้งค่าระบบ", icon: Shield, roles: ["superadmin", "dev"] },
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
        className={`flex items-center justify-center rounded-md text-sm transition-colors px-2 py-2 ${
          childActive
            ? "bg-brand/15 text-white"
            : "text-pale-sky/70 hover:bg-white/5 hover:text-white"
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
        className={`flex items-center gap-3 rounded-md text-sm transition-colors w-full px-3 py-2 ${
          childActive
            ? "bg-brand/10 text-white font-medium"
            : "text-pale-sky/70 hover:bg-white/5 hover:text-white"
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
          <ChevronDown size={14} className="shrink-0 text-pale-sky/50" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-pale-sky/50" />
        )}
      </button>
      {expanded && (
        <div className="mt-0.5 ml-[26px] space-y-0.5 border-l border-white/10 pl-2">
          {item.children!.map((child) => {
            const cActive = pathname === child.href;
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={onMobileClose}
                className={`flex items-center gap-2 rounded-md text-sm transition-colors px-3 py-1.5 ${
                  cActive
                    ? "text-white font-medium"
                    : "text-pale-sky/60 hover:text-white"
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
  collapsed: boolean;
  onCollapsedChange: (v: boolean) => void;
}

export function Sidebar({ mobileOpen, onMobileClose, collapsed, onCollapsedChange }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  // Keyboard shortcut: cmd+b / ctrl+b
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        onCollapsedChange(!collapsed);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [collapsed, onCollapsedChange]);

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

  // Filter items by role
  const filteredGroups = navGroups
    .map((g) => ({
      ...g,
      items: g.items.filter((item) => {
        if (!item.roles) return true;
        if (!user) return false;
        return item.roles.includes(user.role);
      }),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        data-state={collapsed ? "collapsed" : "expanded"}
        className={`
          ${collapsed ? "w-[60px]" : "w-64"}
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0
          fixed z-50 h-full
          bg-deep-space text-white flex flex-col
          transition-[width,transform] duration-200 ease-in-out
          border-r border-white/10
        `}
      >
        {/* ---- SidebarHeader ---- */}
        <div className="h-14 flex items-center gap-2 px-3 shrink-0 border-b border-white/10">
          <div className="w-8 h-8 rounded-md bg-brand flex items-center justify-center font-bold text-white text-sm shrink-0">
            IT
          </div>
          {!collapsed && (
            <div className="overflow-hidden flex-1">
              <div className="font-bold text-sm leading-tight whitespace-nowrap tracking-wide">
                ITSRC PANEL
              </div>
            </div>
          )}
        </div>

        {/* Toggle button — absolute ที่ขอบขวาของ sidebar
            ระดับเดียวกับโลโก้ (top-4 กลาง h-14 header)
            ครึ่งวงกลม ตัดตรงกลางเส้น sidebar พอดี (-right-3 = ครึ่งวงกลม w-6)
            ขนาดเล็ก (w-6 h-6) แต่ชัด (border + bg + text) */}
        <button
          onClick={() => onCollapsedChange(!collapsed)}
          className="absolute top-4 -right-3 z-50 w-6 h-6 rounded-full bg-deep-space border border-white/25 text-white hover:bg-white/20 hover:border-white/40 flex items-center justify-center transition-colors shadow"
          title={collapsed ? "ขยายเมนู (Ctrl+B)" : "ย่อเมนู (Ctrl+B)"}
          aria-label={collapsed ? "ขยายเมนู" : "ย่อเมนู"}
        >
          {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
        </button>

        {/* ---- SidebarContent ---- */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-4 sidebar-scroll">
          {filteredGroups.map((group) => (
            <div key={group.label}>
              {/* SidebarGroupLabel */}
              {!collapsed && (
                <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-pale-sky/40">
                  {group.label}
                </div>
              )}
              {collapsed && (
                <div className="mx-auto my-1 h-px w-6 bg-white/10" />
              )}

              {/* SidebarMenu */}
              <div className="space-y-0.5">
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
                        collapsed={collapsed}
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
                      title={collapsed ? item.label : undefined}
                      className={`
                        flex items-center gap-3 rounded-md text-sm transition-colors relative
                        ${collapsed ? "justify-center px-2 py-2" : "px-3 py-2"}
                        ${active
                          ? "bg-brand/15 text-white font-medium"
                          : "text-pale-sky/70 hover:bg-white/5 hover:text-white"
                        }
                      `}
                    >
                      {/* Active indicator bar (shadcn style) */}
                      {active && (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full bg-brand" />
                      )}
                      <Icon size={18} className="shrink-0" />
                      {!collapsed && (
                        <span className="flex-1 whitespace-nowrap">{item.label}</span>
                      )}
                      {!collapsed && item.badgeTag && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-white/10 text-pale-sky/70 shrink-0">
                          {item.badgeTag}
                        </span>
                      )}
                      {!collapsed && item.badge === "live" && (
                        <span className="w-2 h-2 rounded-full bg-vibrant-coral animate-pulse-soft shrink-0" />
                      )}
                      {collapsed && item.badge === "live" && (
                        <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-vibrant-coral animate-pulse-soft" />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* ---- SidebarFooter ---- */}
        {user && (
          <div className="border-t border-white/10 p-2 shrink-0">
            <div
              className={`flex items-center gap-2.5 rounded-md p-2 hover:bg-white/5 transition-colors cursor-pointer ${
                collapsed ? "justify-center" : ""
              }`}
              onClick={() => {
                onMobileClose();
                router.push("/settings");
              }}
              title="ไปที่โปรไฟล์"
            >
              <div className="w-8 h-8 rounded-full bg-brand flex items-center justify-center text-xs font-bold text-white shrink-0">
                {initials(user.name || user.username)}
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-white truncate">
                    {user.name || user.username}
                  </div>
                  <span className="inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand/80 text-white">
                    {roleLabel[user.role] || user.role}
                  </span>
                </div>
              )}
              {!collapsed && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLogout();
                  }}
                  className="w-7 h-7 rounded-md flex items-center justify-center text-pale-sky/50 hover:bg-white/10 hover:text-white transition-colors shrink-0"
                  title="ออกจากระบบ"
                >
                  <LogOut size={14} />
                </button>
              )}
            </div>
          </div>
        )}

      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* SidebarTrigger — button that lives in the main content area        */
/* ⚠️ Deprecated — ปุ่ม toggle ย้ายเข้าไปใน sidebar แล้ว (ด้านบน)       */
/* ------------------------------------------------------------------ */

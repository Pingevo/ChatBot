// Sidebar — collapsible, role-aware, responsive. Redesigned to match the
// ITSRC Figma reference: dark navy background, maroon active state, inline
// role badges (Super/Dev) next to restricted items, and a user card pinned
// to the bottom (replaces the old top Topbar user menu).
"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import {
  MessageSquare,
  LayoutDashboard,
  BookOpen,
  Zap,
  BarChart3,
  Store,
  Users,
  Bot,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof MessageSquare;
  badge?: string;
  badgeTag?: string; // small role tag shown next to the label, e.g. "Super" / "Dev"
  roles?: ("superadmin" | "admin" | "dev")[];
  children?: { href: string; label: string }[];
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "แดชบอร์ด", icon: LayoutDashboard },
  { href: "/analytics", label: "สถิติ", icon: BarChart3 },
  { href: "/tickets", label: "แชท / ตั๋ว", icon: MessageSquare, badge: "live" },
  { href: "/triggers", label: "ทริกเกอร์", icon: Zap },
  { href: "/knowledge", label: "ฐานความรู้", icon: BookOpen },
  { href: "/users", label: "จัดการผู้ใช้", icon: Users, roles: ["superadmin", "dev"], badgeTag: "Super" },
  { href: "/test-chat/shopee", label: "ทดสอบบอท", icon: Bot, roles: ["superadmin", "admin", "dev"], badgeTag: "Dev", children: [
    { href: "/test-chat/shopee", label: "Shopee" },
    { href: "/test-chat/tiktok", label: "TikTok" },
    { href: "/test-chat/lazada", label: "Lazada" },
  ] },
  { href: "/shops", label: "ร้านค้า", icon: Store },
];

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

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

// Collapsible nav group for items with children (e.g. test-chat sub-pages)
function NavGroup({
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
  if (childActive && !expanded) setExpanded(true);

  if (collapsed) {
    // Collapsed mode — link to first child
    return (
      <Link
        href={item.href}
        onClick={onMobileClose}
        title={item.label}
        className={`flex items-center justify-center rounded-lg text-sm transition-colors px-2 py-2.5 ${
          childActive ? "bg-brand text-white font-medium" : "text-pale-sky/85 hover:bg-white/5 hover:text-white"
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
        className={`flex items-center gap-3 rounded-lg text-sm transition-colors w-full px-3 py-2.5 ${
          childActive
            ? "bg-brand/15 text-white font-medium"
            : "text-pale-sky/85 hover:bg-white/5 hover:text-white"
        }`}
      >
        <Icon size={18} className="shrink-0" />
        <span className="flex-1 text-left whitespace-nowrap">{item.label}</span>
        {item.badgeTag && (
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${
            childActive ? "bg-white/20 text-white" : "bg-white/10 text-pale-sky/80"
          }`}>
            {item.badgeTag}
          </span>
        )}
        {expanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
      </button>
      {expanded && (
        <div className="mt-0.5 ml-5 space-y-0.5 border-l border-white/10 pl-2">
          {item.children!.map((child) => {
            const cActive = pathname === child.href;
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={onMobileClose}
                className={`flex items-center gap-2 rounded-md text-sm transition-colors px-3 py-2 ${
                  cActive
                    ? "bg-brand text-white font-medium"
                    : "text-pale-sky/70 hover:bg-white/5 hover:text-white"
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                {child.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const items = navItems.filter((item) => {
    if (!item.roles) return true;
    if (!user) return false;
    return item.roles.includes(user.role);
  });

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onMobileClose} />
      )}

      <aside
        className={`
          ${collapsed ? "w-16" : "w-64"}
          ${mobileOpen ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0
          fixed md:relative z-40 h-full
          bg-deep-space text-white flex flex-col
          transition-all duration-200 ease-in-out shrink-0
        `}
      >
        {/* Logo */}
        <div className="h-16 flex items-center gap-2.5 px-4 border-b border-white/10 shrink-0">
          <div className="w-9 h-9 rounded-lg bg-brand flex items-center justify-center font-bold text-white shrink-0">
            IT
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <div className="font-bold text-sm leading-tight whitespace-nowrap tracking-wide">ITSRC PANEL</div>
            </div>
          )}
          {!collapsed && (
            <button
              onClick={() => setCollapsed(true)}
              className="hidden md:flex ml-auto w-7 h-7 rounded-md items-center justify-center text-pale-sky/60 hover:bg-white/5 hover:text-white transition-colors shrink-0"
              title="ย่อเมนู"
            >
              <PanelLeftClose size={15} />
            </button>
          )}
        </div>
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="hidden md:flex items-center justify-center h-8 mx-2 mt-2 rounded-md text-pale-sky/60 hover:bg-white/5 hover:text-white transition-colors"
            title="ขยายเมนู"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2.5 space-y-1">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            const hasChildren = item.children && item.children.length > 0;

            if (hasChildren) {
              return (
                <NavGroup
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
                onClick={onMobileClose}
                title={collapsed ? item.label : undefined}
                className={`
                  flex items-center gap-3 rounded-lg text-sm transition-colors relative
                  ${collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"}
                  ${active
                    ? "bg-brand text-white font-medium shadow-sm"
                    : "text-pale-sky/85 hover:bg-white/5 hover:text-white"
                  }
                `}
              >
                <Icon size={18} className="shrink-0" />
                {!collapsed && <span className="flex-1 whitespace-nowrap">{item.label}</span>}
                {!collapsed && item.badgeTag && (
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${
                      active ? "bg-white/20 text-white" : "bg-white/10 text-pale-sky/80"
                    }`}
                  >
                    {item.badgeTag}
                  </span>
                )}
                {!collapsed && item.badge === "live" && (
                  <span className="w-2 h-2 rounded-full bg-vibrant-coral animate-pulse-soft shrink-0" />
                )}
                {collapsed && item.badge === "live" && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-vibrant-coral animate-pulse-soft" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* User card (replaces the old Topbar user dropdown) */}
        {user && (
          <div className="border-t border-white/10 p-3 shrink-0">
            <div
              className={`flex items-center gap-2.5 rounded-lg p-2 hover:bg-white/5 transition-colors cursor-pointer ${collapsed ? "justify-center" : ""}`}
              onClick={() => { onMobileClose(); router.push("/settings"); }}
              title="ไปที่โปรไฟล์"
            >
              <div className="w-9 h-9 rounded-full bg-brand flex items-center justify-center text-xs font-bold text-white shrink-0">
                {initials(user.name || user.username)}
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-white truncate">{user.name || user.username}</div>
                  <span className="inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-brand/80 text-white">
                    {roleLabel[user.role] || user.role}
                  </span>
                </div>
              )}
              {!collapsed && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleLogout(); }}
                  className="w-7 h-7 rounded-md flex items-center justify-center text-pale-sky/60 hover:bg-white/10 hover:text-white transition-colors shrink-0"
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

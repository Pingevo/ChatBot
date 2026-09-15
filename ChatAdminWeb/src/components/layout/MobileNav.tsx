// MobileNav — bottom navigation bar สำหรับมือถือ
// แยกการออกแบบจาก desktop sidebar — ไม่อิง desktop
// แสดง 4 ไอเทมหลัก + ปุ่ม "เพิ่มเติม" ที่เปิด drawer
"use client";
import { useState, useMemo } from "react";
import { usePathname } from "next/navigation";
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
  Store,
  Users,
  Settings,
  Headset,
  Bot,
  Ghost,
  Wrench,
  ScrollText,
  Shield,
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
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canAccessPage, type PageKey } from "@/lib/roles";

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

// ไอเทมรอง — แสดงใน "เพิ่มเติม" drawer
const secondaryItems: NavItem[] = [
  { href: "/triggers", label: "ทริกเกอร์", icon: Zap, page: "trigger" },
  { href: "/workflows", label: "เวิร์กโฟลว์", icon: GitBranch, page: "workflow" },
  { href: "/quick-replies", label: "คำตอบเร็ว", icon: Reply, page: "quickreply" },
  { href: "/knowledge", label: "ฐานความรู้", icon: BookOpen, page: "kb" },
  { href: "/persona", label: "ตัวแทนร้าน", icon: Sparkles, page: "persona" },
  { href: "/shop-settings", label: "ตั้งค่าร้าน", icon: Settings2, page: "shop-setting" },
  { href: "/test-chat/shopee", label: "ทดสอบบอท", icon: Bot, page: "testchat" },
  { href: "/shadow-inbox", label: "กล่องเงา", icon: Ghost, page: "shadow-inbox" },
  { href: "/botworker", label: "เครื่องบอท", icon: Wrench, page: "botworker" },
  { href: "/live-assignment", label: "จ่ายงานสด", icon: Headset, page: "live-assignment" },
  { href: "/test-assignment", label: "ทดสอบจ่ายงาน", icon: TestTube2, page: "test-assignment" },
  { href: "/replay-compare", label: "เปรียบเทียบรีเพลย์", icon: Scale, page: "replay-compare" },
  { href: "/test-results", label: "ผลการทดสอบ", icon: ClipboardCheck, page: "test-result" },
  { href: "/admin-review-kpi", label: "KPI รีวิว", icon: Gauge, page: "admin-review-kpi" },
  { href: "/admin-chat-result", label: "ผลแชทแอดมิน", icon: FileSearch, page: "admin-chat-result" },
  { href: "/test-chat-result", label: "ผลทดสอบแชท", icon: FileSearch, page: "test-chat-result" },
  { href: "/shops", label: "ร้านค้า", icon: Store, page: "shop" },
  { href: "/contacts", label: "รายชื่อลูกค้า", icon: ContactIcon, page: "customer" },
  { href: "/team", label: "ทีม & มอบหมาย", icon: Headset, page: "team" },
  { href: "/users", label: "จัดการผู้ใช้", icon: Users, page: "user" },
  { href: "/admin-config", label: "ตั้งค่าแอดมิน", icon: Sliders, page: "admin-config" },
  { href: "/config", label: "ตั้งค่าระบบ", icon: Shield, page: "config" },
  { href: "/logs", label: "บันทึกระบบ", icon: ScrollText, page: "log" },
  // footer items — ไม่มี role gate (เหมือน Sidebar footer)
  { href: "/help", label: "คู่มือ", icon: HelpCircle },
  { href: "/settings", label: "โปรไฟล์", icon: Settings },
];

export function MobileNav() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);

  // Filter by permission
  const visiblePrimary = useMemo(
    () => primaryItems.filter((item) => !item.page || canAccessPage(user, item.page)),
    [user]
  );
  const visibleSecondary = useMemo(
    () => secondaryItems.filter((item) => !item.page || canAccessPage(user, item.page)),
    [user]
  );

  const isActive = (href: string) =>
    pathname === href || (href !== "/dashboard" && pathname?.startsWith(href));

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

      {/* "More" drawer — full-screen overlay แสดงไอเทมรองทั้งหมด */}
      {moreOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 z-0"
            onClick={() => setMoreOpen(false)}
          />
          {/* Sheet — slide up from bottom, z-10 เพื่อให้อยู่เหนือ backdrop */}
          <div className="relative z-10 mt-auto bg-surface rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col animate-slide-up">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <h3 className="font-semibold text-text text-sm">เมนูทั้งหมด</h3>
              <button
                onClick={() => setMoreOpen(false)}
                className="w-8 h-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-text-muted"
                aria-label="ปิด"
              >
                <X size={18} />
              </button>
            </div>
            {/* Grid of items */}
            <div className="overflow-y-auto p-4 grid grid-cols-4 gap-3">
              {visibleSecondary.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex flex-col items-center gap-1.5 p-2 rounded-xl transition-colors ${
                      active ? "bg-brand/10 text-brand" : "text-text-muted hover:bg-surface-2 hover:text-text"
                    }`}
                  >
                    <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${
                      active ? "bg-brand/15" : "bg-surface-2"
                    }`}>
                      <Icon size={20} />
                    </div>
                    <span className="text-[10px] text-center leading-tight line-clamp-2">
                      {item.label}
                    </span>
                  </Link>
                );
              })}
            </div>
            {/* Safe area padding */}
            <div className="h-2 safe-area-pb" />
          </div>
        </div>
      )}
    </>
  );
}

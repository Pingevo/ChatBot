// AppShell — wraps every authenticated page with Sidebar + content.
// shadcn-style: sidebar is position:fixed, main content uses margin-left
// to avoid reflow thrashing during collapse/expand transitions.
// ปุ่ม toggle อยู่ที่ขอบขวาของ sidebar (absolute) — ไม่บังโลโก้
// แต่ละหน้ามี navbar ของตัวเอง (sticky top-0) — AppShell ไม่ใส่ topbar กลาง
//
// Responsive strategy:
//   - Mobile (<768px): Bottom nav bar (MobileNav) + no sidebar, content full width
//   - Tablet (768-1024px): Icon rail sidebar (60px) by default, content gets space
//   - Desktop (≥1024px): Full sidebar (256px) with collapse/expand
"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { Loading } from "@/components/ui/Loading";
import { ToastContainer } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ImageViewerOverlay } from "@/components/ui/ImageViewer";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, initialized, fetchMe } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // ⚡ test-chat pages — เดิมออกแบบให้ bypass login แต่ตอนนี้ middleware บังคับ SSO ทุกหน้า
  //   (PUBLIC_PAGES = ["/login"] เท่านั้น) — flag นี้เป็น dead path ไว้เผื่อ middleware whitelist ภายหลัง
  const isTestChatPage = pathname?.startsWith("/test-chat") || false;

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    // ⚡ ไม่ redirect ถ้าอยู่ในหน้า test-chat
    if (initialized && !user && !isTestChatPage) router.replace("/login");
  }, [initialized, user, router, isTestChatPage]);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // ⚡ test-chat pages — แสดงเลยไม่ต้องรอ login (แต่ถ้า login แล้วก็แสดง sidebar ปกติ)
  if (!initialized || (!user && !isTestChatPage)) {
    return (
      <div className="h-screen flex flex-col items-center justify-center auth-gradient-bg gap-3">
        <Loading size={32} />
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden">
      {/* Sidebar — position:fixed, doesn't affect layout flow
          Desktop: full sidebar (256px or 60px collapsed)
          Tablet: icon rail (60px) — auto-collapsed
          Mobile: hidden (uses MobileNav bottom bar instead) */}
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />

      {/* Main content — margin-left transitions to make room for sidebar
          Desktop (≥1280px): ml-64 or ml-[60px]
          Tablet/Phone (<1280px): ml-0 (full width, bottom nav handles navigation) */}
      <div
        className={`h-full flex flex-col min-w-0 transition-[margin] duration-200 ease-in-out ${collapsed ? "lg:ml-[60px]" : "lg:ml-64"}`}
      >
        {/* Mobile/Tablet-only top strip with brand
            (โทรศัพท์ + iPad: ใช้ bottom nav แทน sidebar) */}
        <div className="lg:hidden h-14 flex items-center gap-2 px-4 border-b border-border bg-surface/95 backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center font-bold text-white text-xs">
              IT
            </div>
            <span className="font-bold text-sm text-text tracking-tight">ITSRC Panel</span>
          </div>
        </div>
        {/* Content area — pb-14 บนมือถือ/แท็บเล็ต เผื่อที่ให้ bottom nav */}
        <main className="flex-1 min-h-0 overflow-hidden pb-14 lg:pb-0">{children}</main>
      </div>

      {/* Mobile bottom navigation — แยกจาก sidebar */}
      <MobileNav />

      {/* Global UI: Toast notifications + Confirm dialogs + Image viewer */}
      <ToastContainer />
      <ConfirmDialog />
      <ImageViewerOverlay />
    </div>
  );
}

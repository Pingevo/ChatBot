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
import { MobilePageNavigationProvider } from "./MobilePageNavigation";
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
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // ⚡ test-chat pages — เดิมออกแบบให้ bypass login แต่ตอนนี้ middleware บังคับ SSO ทุกหน้า
  //   (PUBLIC_PAGES = ["/login"] เท่านั้น) — flag นี้เป็น dead path ไว้เผื่อ middleware whitelist ภายหลัง
  const isTestChatPage = pathname?.startsWith("/test-chat") || false;

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    if (keyboardOpen) document.body.dataset.mobileKeyboardOpen = "true";
    else delete document.body.dataset.mobileKeyboardOpen;
    return () => { delete document.body.dataset.mobileKeyboardOpen; };
  }, [keyboardOpen]);

  useEffect(() => {
    // ⚡ ไม่ redirect ถ้าอยู่ในหน้า test-chat
    if (initialized && !user && !isTestChatPage) router.replace("/login");
  }, [initialized, user, router, isTestChatPage]);

  // ⚡ mobile keyboard — iOS Safari ไม่ resize layout viewport ตอน keyboard เปิด
  //   ใช้ visualViewport.height เป็น --app-vh แทน 100vh/dvh → composer ไม่โดนกลบ
  useEffect(() => {
    const vv = window.visualViewport;
    const phoneViewport = window.matchMedia(
      "(max-width: 767px), (pointer: coarse) and (max-height: 500px)"
    );
    let baselineHeight = Math.max(window.innerHeight, vv?.height ?? 0);
    let baselineWidth = window.innerWidth;

    const apply = () => {
      const height = vv?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-vh", `${height}px`);

      if (Math.abs(window.innerWidth - baselineWidth) > 80) {
        baselineWidth = window.innerWidth;
        baselineHeight = Math.max(window.innerHeight, height);
      }

      const active = document.activeElement;
      const editing =
        active instanceof HTMLElement &&
        (active.matches("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]") ||
          active.isContentEditable);
      const viewportLoss = baselineHeight - height;
      setKeyboardOpen(phoneViewport.matches && editing && viewportLoss > 120);

      if (!editing) baselineHeight = Math.max(baselineHeight, window.innerHeight, height);
    };
    const onFocusIn = () => {
      baselineHeight = Math.max(baselineHeight, window.innerHeight, vv?.height ?? 0);
      apply();
    };
    const onFocusOut = () => window.setTimeout(apply, 100);

    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    phoneViewport.addEventListener("change", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      phoneViewport.removeEventListener("change", apply);
      document.documentElement.style.removeProperty("--app-vh");
    };
  }, []);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // ⚡ test-chat pages — แสดงเลยไม่ต้องรอ login (แต่ถ้า login แล้วก็แสดง sidebar ปกติ)
  if (!initialized || (!user && !isTestChatPage)) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center auth-gradient-bg gap-3">
        <Loading size={32} />
      </div>
    );
  }

  return (
    <div
      className="h-dvh overflow-hidden"
      data-mobile-keyboard-open={keyboardOpen || undefined}
      style={{ height: "var(--app-vh, 100dvh)" }}
    >
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
        {/* Content area — pb-14 บนมือถือ/แท็บเล็ต เผื่อที่ให้ bottom nav */}
        <main
          data-app-content
          className={`phone-app-stage flex-1 min-h-0 overflow-hidden ${keyboardOpen ? "pb-0" : "pb-14"} lg:pb-0`}
        >
          <MobilePageNavigationProvider>{children}</MobilePageNavigationProvider>
        </main>
      </div>

      {/* Mobile bottom navigation — แยกจาก sidebar */}
      <MobileNav keyboardOpen={keyboardOpen} />

      {/* Global UI: Toast notifications + Confirm dialogs + Image viewer */}
      <ToastContainer />
      <ConfirmDialog />
      <ImageViewerOverlay />
    </div>
  );
}

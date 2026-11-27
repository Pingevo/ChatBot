// AppShell — wraps every authenticated page with Sidebar + content.
// shadcn-style: sidebar is position:fixed, main content uses margin-left
// to avoid reflow thrashing during collapse/expand transitions.
// ปุ่ม toggle อยู่ที่ขอบขวาของ sidebar (absolute) — ไม่บังโลโก้
// แต่ละหน้ามี navbar ของตัวเอง (sticky top-0) — AppShell ไม่ใส่ topbar กลาง
//
// Responsive strategy:
//   - Phone: rounded bottom navigation; no persistent side rail
//   - Coarse-touch tablet: floating tablet navigation; content fills the frame
//   - Fine-pointer laptop/PC: draggable floating launcher; content fills the frame
"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { MobilePageNavigationProvider } from "./MobilePageNavigation";
import { Loading } from "@/components/ui/Loading";
import { ToastContainer, toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ImageViewerOverlay } from "@/components/ui/ImageViewer";
import { getPageIdentityKind } from "@/components/ui/PageIdentityMark";
import { canAccessPage } from "@/lib/roles";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/lib/types";
import { findNotificationEvents, type NotificationConversation } from "@/lib/notificationMonitor";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, initialized, fetchMe } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    const preferences = user.notification_preferences || DEFAULT_NOTIFICATION_PREFERENCES;
    const monitorStartedAt = Date.now();
    const storageKey = `chat-notifications:v1:${user.admin_id}`;
    const previous = new Map<string, NotificationConversation>();
    const seen = new Set<string>();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(saved)) for (const key of saved) if (typeof key === "string") seen.add(key);
    } catch { /* use a fresh in-memory set */ }
    let disposed = false;
    let polling = false;

    const poll = async () => {
      if (polling || disposed) return;
      polling = true;
      try {
        const includeBotworker = canAccessPage(user, "botworker");
        const responses = await Promise.allSettled([
          fetch("/api/admin/conversations?limit=100", { cache: "no-store" }).then(async (response) => {
            if (!response.ok) throw new Error(`admin conversations ${response.status}`);
            const payload = await response.json();
            const rows = Array.isArray(payload) ? payload : payload.rows;
            return Array.isArray(rows) ? rows.map((row) => ({ ...row, source: "admin" as const })) : [];
          }),
          includeBotworker
            ? fetch("/api/botworker/conversations?limit=300", { cache: "no-store" }).then(async (response) => {
                if (!response.ok) throw new Error(`botworker conversations ${response.status}`);
                const payload = await response.json();
                return Array.isArray(payload.rows) ? payload.rows.map((row: Record<string, unknown>) => ({ ...row, source: "botworker" as const })) : [];
              })
            : Promise.resolve([]),
        ]);
        const rows: NotificationConversation[] = responses.flatMap((result) =>
          result.status === "fulfilled" ? result.value as NotificationConversation[] : []
        );
        const events = findNotificationEvents({ rows, previous, preferences, now: Date.now(), monitorStartedAt });
        for (const event of events) {
          if (seen.has(event.key)) continue;
          seen.add(event.key);
          toast.info(event.message, 8000);
        }
        try {
          localStorage.setItem(storageKey, JSON.stringify([...seen].slice(-500)));
        } catch { /* notifications still dedupe for this page session */ }
        previous.clear();
        for (const row of rows) previous.set(`${row.source}:${row.id}`, row);
      } catch (error) {
        console.warn("Notification polling failed", error);
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = window.setInterval(poll, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [user?.admin_id, user?.role, user?.notification_preferences?.newTicket, user?.notification_preferences?.handoff, user?.notification_preferences?.unanswered]);

  // ⚡ test-chat pages — เดิมออกแบบให้ bypass login แต่ตอนนี้ middleware บังคับ SSO ทุกหน้า
  //   (PUBLIC_PAGES = ["/login"] เท่านั้น) — flag นี้เป็น dead path ไว้เผื่อ middleware whitelist ภายหลัง
  const isTestChatPage = pathname?.startsWith("/test-chat") || false;

  useEffect(() => {
    if (window.innerWidth >= 1440) setCollapsed(false);
  }, []);

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
      "(max-width: 767px), (pointer: coarse) and (max-width: 1279.98px)"
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
      className="tablet-console-frame h-dvh overflow-hidden"
      data-mobile-keyboard-open={keyboardOpen || undefined}
      style={{ height: "var(--app-vh, 100dvh)" }}
    >
      {/* Sidebar — tablet rail, expandable laptop sidebar, full wide-screen sidebar. */}
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onMobileOpenChange={setMobileOpen}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />

      {/* Keep a 60px rail at tablet widths; laptop and wide screens follow the user's collapse setting. */}
      <div
        className={`tablet-console-content h-full flex flex-col min-w-0 transition-[margin] duration-200 ease-in-out md:ml-[60px] ${collapsed ? "lg:ml-[60px]" : "lg:ml-64"}`}
      >
        {/* Reserve bottom-nav space on phones only. */}
        <main
          data-app-content
          data-page-identity={getPageIdentityKind(pathname || "/dashboard")}
          className={`tablet-console-main phone-app-stage flex-1 min-h-0 overflow-hidden ${keyboardOpen ? "pb-0" : "pb-14 md:pb-0"}`}
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

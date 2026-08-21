// AppShell — wraps every authenticated page with Sidebar + content.
// shadcn-style: sidebar is position:fixed, main content uses margin-left
// to avoid reflow thrashing during collapse/expand transitions.
// ปุ่ม toggle อยู่ที่ขอบขวาของ sidebar (absolute) — ไม่บังโลโก้
// แต่ละหน้ามี navbar ของตัวเอง (sticky top-0) — AppShell ไม่ใส่ topbar กลาง
"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Sidebar } from "./Sidebar";
import { Loading } from "@/components/ui/Loading";
import { ToastContainer } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu } from "lucide-react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, initialized, fetchMe } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    if (initialized && !user) router.replace("/login");
  }, [initialized, user, router]);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (!initialized || !user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center auth-gradient-bg gap-3">
        <Loading size={32} />
        <p className="text-pale-sky/70 text-sm">กำลังโหลด...</p>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden">
      {/* Sidebar — position:fixed, doesn't affect layout flow */}
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />

      {/* Main content — margin-left transitions to make room for sidebar */}
      <div
        className={`h-full flex flex-col min-w-0 transition-[margin] duration-200 ease-in-out ${collapsed ? "md:ml-[60px]" : "md:ml-64"}`}
      >
        {/* Mobile-only top strip with menu button (desktop ไม่มี topbar — แต่ละหน้ามี navbar ของตัวเอง) */}
        <div className="md:hidden h-14 flex items-center gap-2 px-3 border-b border-border bg-surface shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="w-9 h-9 rounded-md hover:bg-surface-2 flex items-center justify-center transition-colors"
            title="เมนู"
          >
            <Menu size={20} className="text-text-muted" />
          </button>
        </div>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>

      {/* Global UI: Toast notifications + Confirm dialogs */}
      <ToastContainer />
      <ConfirmDialog />
    </div>
  );
}

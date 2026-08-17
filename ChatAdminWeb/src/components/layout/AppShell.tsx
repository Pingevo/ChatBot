// AppShell — wraps every authenticated page with Sidebar + content.
// Sidebar is collapsible on desktop, drawer on mobile. No global Topbar —
// user account access lives in the Sidebar's bottom user card (matches the
// ITSRC design reference); a minimal mobile-only bar provides the menu
// toggle since the sidebar is off-canvas on small screens.
"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Sidebar } from "./Sidebar";
import { Loading } from "@/components/ui/Loading";
import { Menu } from "lucide-react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, initialized, fetchMe } = useAuth();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    if (initialized && !user) router.replace("/login");
  }, [initialized, user, router]);

  if (!initialized || !user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center auth-gradient-bg gap-3">
        <Loading size={32} />
        <p className="text-pale-sky/70 text-sm">กำลังโหลด...</p>
      </div>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile-only top strip — desktop relies on the sidebar alone */}
        <div className="md:hidden h-14 flex items-center px-4 border-b border-border bg-surface shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="w-9 h-9 rounded-lg hover:bg-surface-2 flex items-center justify-center transition-colors"
            title="เมนู"
          >
            <Menu size={20} className="text-text-muted" />
          </button>
          <span className="ml-3 font-bold text-sm text-deep-space">ITSRC PANEL</span>
        </div>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}

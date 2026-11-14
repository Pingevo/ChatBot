// PageShell — shared page scaffold for console pages.
"use client";
import { ReactNode, ComponentType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MobileAddActions, type MobileAddAction } from "@/components/mobile/MobileAddActions";
import { getPageIdentityKind, PageIdentityMark } from "@/components/ui/PageIdentityMark";
import {
  ArrowLeft, BarChart3, BookOpen, Bot, ClipboardCheck, ContactIcon, Gauge,
  GitBranch, HelpCircle, Inbox, KeyRound, LayoutDashboard, MessageSquare,
  Reply, ScrollText, Settings2, Shield, Store, Users, Wrench, Zap,
} from "lucide-react";
import { useMobilePageNavigation } from "@/components/layout/MobilePageNavigation";

interface PageShellProps {
  icon?: ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  mobileHeaderActions?: ReactNode;
  mobileAddActions?: MobileAddAction[];
  filterBar?: ReactNode;
  filterBarBelow?: boolean;
  children: ReactNode;
  contentClassName?: string;
  helpHref?: string;
  stickyMobileSearch?: boolean;
}

export function PageShell({
  icon: Icon,
  title,
  subtitle,
  actions,
  mobileHeaderActions,
  mobileAddActions,
  filterBar,
  filterBarBelow = false,
  children,
  contentClassName = "p-4 md:p-6 space-y-4",
  helpHref,
  stickyMobileSearch = false,
}: PageShellProps) {
  const pathname = usePathname() ?? "/";
  const { goBack } = useMobilePageNavigation();
  const MobileIcon = Icon ?? getMobilePageIcon(pathname);
  const identityKind = getPageIdentityKind(pathname);
  const canGoBack = pathname !== "/dashboard" && pathname !== "/login";

  return (
    <div data-ui="page-frame" className={`h-full min-w-0 overflow-y-auto phone-page-shell ${stickyMobileSearch ? "phone-sticky-search-page" : ""} ${mobileAddActions?.length ? "phone-has-mobile-add-actions" : ""}`}>
      <div
        data-ui="page-header"
        className={`phone-page-header px-4 sm:px-6 py-4 sm:py-5 border-b border-border bg-surface/95 backdrop-blur-sm ${
          filterBarBelow ? "" : "sticky top-0 z-10"
        }`}
      >
        <div className="phone-page-heading flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1 md:flex-none">
            {canGoBack && (
              <button
                type="button"
                onClick={() => goBack()}
                className="phone-page-back md:hidden"
                aria-label="ย้อนกลับ"
                title="ย้อนกลับ"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <PageIdentityMark
              kind={identityKind}
              icon={Icon ?? MobileIcon}
              className="w-9 h-9 sm:w-10 sm:h-10 shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="phone-page-title text-base sm:text-lg font-bold text-text tracking-tight">{title}</h1>
                {helpHref && (
                  <Link
                    href={helpHref}
                    className="text-text-subtle hover:text-accent transition-colors shrink-0"
                    aria-label={`วิธีใช้งาน${title}`}
                  >
                    <HelpCircle size={14} />
                  </Link>
                )}
              </div>
              {subtitle && <p className="phone-page-subtitle text-xs text-text-muted mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {actions && (
            <div className={`phone-page-actions flex items-center gap-2 flex-wrap ${mobileHeaderActions || mobileAddActions?.length ? "hidden md:flex" : ""}`}>
              {actions}
            </div>
          )}
          {mobileHeaderActions && (
            <div className="phone-page-mobile-actions flex items-center gap-2 md:hidden">{mobileHeaderActions}</div>
          )}
        </div>
        {mobileAddActions && <MobileAddActions actions={mobileAddActions} />}
        {!filterBarBelow && filterBar && (
          <div className="mt-3 pb-1">{filterBar}</div>
        )}
      </div>
      {filterBarBelow && filterBar && (
        <div className="phone-page-filter-bar px-4 sm:px-6 py-3 border-b border-border bg-surface-1 sticky top-0 z-10">
          {filterBar}
        </div>
      )}
      <div data-ui="page-content" className={`phone-page-content min-w-0 ${contentClassName}`}>{children}</div>
    </div>
  );
}

function getMobilePageIcon(pathname: string): ComponentType<{ size?: number; className?: string }> {
  if (pathname.startsWith("/analytics")) return BarChart3;
  if (pathname.startsWith("/ticket") || pathname.startsWith("/chats")) return MessageSquare;
  if (pathname.startsWith("/knowledge") || pathname.startsWith("/zaapi-kb")) return BookOpen;
  if (pathname.startsWith("/workflows")) return GitBranch;
  if (pathname.startsWith("/triggers")) return Zap;
  if (pathname.startsWith("/quick-replies")) return Reply;
  if (pathname.startsWith("/shops") || pathname.startsWith("/shop-settings")) return Store;
  if (pathname.startsWith("/contacts")) return ContactIcon;
  if (pathname.startsWith("/team") || pathname.startsWith("/users") || pathname.startsWith("/roles")) return Users;
  if (pathname.startsWith("/llm")) return KeyRound;
  if (pathname.startsWith("/test-results") || pathname.startsWith("/test-chat-result")) return ClipboardCheck;
  if (pathname.startsWith("/test") || pathname.startsWith("/replay")) return Wrench;
  if (pathname.startsWith("/logs")) return ScrollText;
  if (pathname.startsWith("/backlog")) return Inbox;
  if (pathname.startsWith("/config") || pathname.startsWith("/admin-config") || pathname.startsWith("/settings")) return Settings2;
  if (pathname.startsWith("/admin-review-kpi")) return Gauge;
  if (pathname.startsWith("/admin-chat-result")) return Shield;
  if (pathname.startsWith("/persona")) return Bot;
  return LayoutDashboard;
}

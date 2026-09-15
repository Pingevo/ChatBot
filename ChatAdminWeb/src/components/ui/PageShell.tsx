// PageShell — shared page scaffold for console pages.
"use client";
import { ReactNode, ComponentType } from "react";
import Link from "next/link";
import { HelpCircle } from "lucide-react";

interface PageShellProps {
  icon?: ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  filterBar?: ReactNode;
  filterBarBelow?: boolean;
  children: ReactNode;
  contentClassName?: string;
  helpHref?: string;
}

export function PageShell({
  icon: Icon,
  title,
  subtitle,
  actions,
  filterBar,
  filterBarBelow = false,
  children,
  contentClassName = "p-4 md:p-6 space-y-4",
  helpHref,
}: PageShellProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={`px-4 sm:px-6 py-4 sm:py-5 border-b border-border bg-surface/95 backdrop-blur-sm ${
          filterBarBelow ? "" : "sticky top-0 z-10"
        }`}
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {Icon && (
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-accent-soft flex items-center justify-center shrink-0">
                <Icon size={18} className="text-accent sm:hidden" />
                <Icon size={20} className="text-accent hidden sm:block" />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h1 className="text-base sm:text-lg font-bold text-text tracking-tight truncate">{title}</h1>
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
              {subtitle && <p className="text-xs text-text-muted mt-0.5 truncate">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </div>
        {!filterBarBelow && filterBar && (
          <div className="mt-3 pb-1">{filterBar}</div>
        )}
      </div>
      {filterBarBelow && filterBar && (
        <div className="px-4 sm:px-6 py-3 border-b border-border bg-surface-1 sticky top-0 z-10">
          {filterBar}
        </div>
      )}
      <div className={contentClassName}>{children}</div>
    </div>
  );
}

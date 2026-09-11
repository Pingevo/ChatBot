// PageShell — shared page scaffold for console pages.
// Replaces the 18× hand-rolled `<div className="h-full overflow-y-auto">` + sticky header pattern.
// Enforces consistent bg token, sticky header, focus ring, and content padding.
"use client";
import { ReactNode, ComponentType } from "react";
import Link from "next/link";
import { HelpCircle } from "lucide-react";

interface PageShellProps {
  /** Icon shown in the brand circle (Lucide icon component) */
  icon?: ComponentType<{ size?: number; className?: string }>;
  /** Page title (h1) */
  title: string;
  /** Subtitle / description below the title */
  subtitle?: ReactNode;
  /** Action(s) on the right of the header (button, picker, etc.) */
  actions?: ReactNode;
  /** Sticky filter bar rendered below the header (inside the sticky zone) */
  filterBar?: ReactNode;
  /** When true, render filterBar as a separate sticky bar below the header (header scrolls away, filter bar sticks at top) */
  filterBarBelow?: boolean;
  /** Main content; placed inside `p-4 md:p-6 space-y-4` by default */
  children: ReactNode;
  /** Override content container className if default padding/spacing doesn't fit */
  contentClassName?: string;
  /** Help page anchor (e.g. "workflows" links to /help#workflows) */
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
        className={`px-6 py-5 border-b border-border bg-surface ${
          filterBarBelow ? "" : "sticky top-0 z-10"
        }`}
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            {Icon && (
              <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
                <Icon size={20} className="text-brand" />
              </div>
            )}
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-lg font-bold text-text">{title}</h1>
                {helpHref && (
                  <Link
                    href={helpHref}
                    className="text-text-subtle hover:text-brand transition-colors"
                    aria-label={`วิธีใช้งาน${title}`}
                  >
                    <HelpCircle size={14} />
                  </Link>
                )}
              </div>
              {subtitle && <p className="text-xs text-text-muted">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {!filterBarBelow && filterBar && (
          <div className="mt-3 pb-1">{filterBar}</div>
        )}
      </div>
      {filterBarBelow && filterBar && (
        <div className="px-6 py-3 border-b border-border bg-surface-2 sticky top-0 z-10">
          {filterBar}
        </div>
      )}
      <div className={contentClassName}>{children}</div>
    </div>
  );
}


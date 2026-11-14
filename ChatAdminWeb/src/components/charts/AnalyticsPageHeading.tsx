"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Info } from "lucide-react";
import { PageIdentityMark } from "@/components/ui/PageIdentityMark";
import {
  UnifiedDateRangePicker,
  type DateRangeValue,
} from "@/components/ui/UnifiedDateRangePicker";

export function AnalyticsPageHeading({
  icon: Icon,
  title,
  description,
  value,
  onChange,
  helpHref,
  showDescriptionDesktop = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  helpHref?: string;
  showDescriptionDesktop?: boolean;
}) {
  return (
    <header className="analytics-page-heading flex items-center justify-between flex-wrap gap-2">
      <div className="analytics-page-heading-main flex items-center gap-2 min-w-0">
        <PageIdentityMark kind="insights" icon={Icon} className="analytics-page-heading-icon grid md:hidden" />
        <div className="analytics-page-heading-copy">
          <span className="analytics-page-eyebrow block md:hidden">INSIGHTS</span>
          <h2 className="analytics-page-title text-lg font-bold text-text">{title}</h2>
          <p className={`analytics-page-description text-xs text-text-muted ${showDescriptionDesktop ? "block md:block md:text-sm" : "block md:hidden"}`}>
            {description}
          </p>
        </div>
      </div>
      <div className="analytics-page-heading-controls flex items-center gap-3">
        <UnifiedDateRangePicker value={value} onChange={onChange} />
        {helpHref && (
          <Link href={helpHref} className="analytics-page-help text-xs text-brand flex items-center gap-1 hover:underline">
            <Info size={14} />
            <span>วิธีใช้งาน</span>
          </Link>
        )}
      </div>
    </header>
  );
}

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, TrendingUp, UserCog } from "lucide-react";

const tabs = [
  { href: "/analytics/live", label: "ภาพรวมข้อมูลสด", mobileLabel: "ข้อมูลสด", icon: Activity },
  { href: "/analytics/performance", label: "ภาพรวม Performance", mobileLabel: "ประสิทธิภาพ", icon: TrendingUp },
  { href: "/analytics/admin-activity", label: "การทำงานของแอดมิน", mobileLabel: "ทีมแอดมิน", icon: UserCog },
];

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="analytics-layout h-full overflow-y-auto">
      <div className="analytics-header px-4 md:px-6 pt-6 pb-0 border-b border-border bg-surface sticky top-0 z-10">
        <h1 className="hidden text-xl font-bold text-text mb-1 md:block">สถิติ</h1>
        <p className="hidden text-sm text-text-muted mb-4 md:block">วิเคราะห์ประสิทธิภาพการตอบแชท</p>
        <div className="analytics-tabs flex gap-0.5 lg:gap-1 flex-wrap">
          {tabs.map((t) => {
            const active = pathname === t.href || pathname.startsWith(t.href + "/");
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`analytics-tab flex items-center gap-1 lg:gap-1.5 px-2.5 lg:px-4 py-2 lg:py-2.5 text-xs lg:text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? "border-brand text-brand"
                    : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                <Icon size={13} />
                <span className="hidden md:inline">{t.label}</span>
                <span className="md:hidden">{t.mobileLabel}</span>
              </Link>
            );
          })}
        </div>
      </div>
      <div className="analytics-content p-4 md:p-6">{children}</div>
    </div>
  );
}

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, TrendingUp, UserCog } from "lucide-react";

const tabs = [
  { href: "/analytics/live", label: "ภาพรวมข้อมูลสด", icon: Activity },
  { href: "/analytics/performance", label: "ภาพรวม Performance", icon: TrendingUp },
  { href: "/analytics/admin-activity", label: "การทำงานของแอดมิน", icon: UserCog },
];

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 md:px-6 pt-6 pb-0 border-b border-border bg-surface sticky top-0 z-10">
        <h1 className="text-xl font-bold text-text mb-1">สถิติ</h1>
        <p className="text-sm text-text-muted mb-4">วิเคราะห์ประสิทธิภาพการตอบแชท</p>
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const active = pathname === t.href || pathname.startsWith(t.href + "/");
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  active
                    ? "border-brand text-brand"
                    : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                <Icon size={15} />
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}

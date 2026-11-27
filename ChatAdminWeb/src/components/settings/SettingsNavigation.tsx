"use client";

import Link from "next/link";
import { Activity, Bot, GitBranch, Lock, MessageCircle, Settings2, Store, Users } from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canAccessPage } from "@/lib/roles";

export type SettingsSection = "engine" | "operations" | "shops" | "diagnostics" | "safety"
  | "buffer" | "workflow" | "assignment" | "model";

const configSections = [
  { id: "engine", label: "คำตอบบอท", icon: Bot },
  { id: "operations", label: "การทำงาน", icon: Settings2 },
  { id: "shops", label: "ร้านค้า", icon: Store },
  { id: "diagnostics", label: "สถานะระบบ", icon: Activity },
  { id: "safety", label: "ข้อจำกัด", icon: Lock },
] as const;

const adminSections = [
  { id: "buffer", label: "รวมข้อความ", icon: MessageCircle },
  { id: "workflow", label: "Workflow", icon: GitBranch },
  { id: "assignment", label: "มอบหมายงาน", icon: Users },
  { id: "model", label: "LLM", icon: Bot },
] as const;

interface Props {
  page: "config" | "admin-config";
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  showDiagnostics?: boolean;
}

export function SettingsNavigation({ page, activeSection, onSectionChange, showDiagnostics = true }: Props) {
  const { user } = useAuth();
  const sections = page === "config" ? configSections.filter((item) => showDiagnostics || item.id !== "diagnostics") : adminSections;
  const canViewConfig = canAccessPage(user, "config");
  const canViewAdminConfig = canAccessPage(user, "admin-config");
  const sectionButtons = sections.map(({ id, label, icon: Icon }) => (
    <button key={id} type="button" onClick={() => onSectionChange(id)} aria-pressed={activeSection === id} aria-controls="settings-section-panel"
      className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:ml-2 lg:w-[calc(100%-0.5rem)] ${activeSection === id ? "bg-brand text-white" : "text-text-muted hover:bg-surface-2 hover:text-text"}`}>
      <Icon size={15} aria-hidden="true" /> {label}
    </button>
  ));

  return (
    <nav aria-label="เมนูตั้งค่า" className="order-first min-w-0 rounded-xl border border-border bg-surface p-2 lg:order-last lg:sticky lg:top-5">
      <div className="hidden px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted lg:block">Settings</div>
      <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {canViewConfig && (
          <Link href="/config" aria-current={page === "config" ? "page" : undefined}
            className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:w-full ${page === "config" ? "bg-brand/10 text-brand" : "text-text-muted hover:bg-surface-2 hover:text-text"}`}>
            ตั้งค่าระบบ
          </Link>
        )}
        {page === "config" && sectionButtons}
        {canViewAdminConfig && (
          <Link href="/admin-config" aria-current={page === "admin-config" ? "page" : undefined}
            className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:mt-2 lg:w-full lg:border-t lg:border-border lg:rounded-t-none ${page === "admin-config" ? "bg-brand/10 text-brand" : "text-text-muted hover:bg-surface-2 hover:text-text"}`}>
            ตั้งค่าแอดมิน
          </Link>
        )}
        {page === "admin-config" && sectionButtons}
      </div>
    </nav>
  );
}

"use client";
// InfoTab — แสดงข้อมูล conversation + stats + ประวัติปิดแชท (card ยืด/หด ได้)
import { useState } from "react";
import { ChevronDown, ChevronRight, User, Store, MessageSquare, Bot, Headset, History } from "lucide-react";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Badge } from "@/components/ui/Badge";
import type { Conversation, ChatMessage, CloseHistoryRecord, ProblemCategory } from "@/lib/types";

const CATEGORY_LABELS: Record<ProblemCategory, string> = {
  shipping: "การจัดส่ง",
  product: "สินค้า",
  payment: "การชำระเงิน",
  return_refund: "คืนสินค้า/คืนเงิน",
  warranty: "รับประกัน",
  account: "บัญชี/ล็อกอิน",
  promotion: "โปรโมชั่น/ส่วนลด",
  other: "อื่นๆ",
};

interface Props {
  conversation: Conversation;
  messages: ChatMessage[];
  closeHistory: CloseHistoryRecord[];
  onSuggestProduct?: () => void;
  onCreateTicket?: () => void;
  onSendCode?: () => void;
}

export function InfoTab({ conversation, messages, closeHistory }: Props) {
  // คำนวณ stats
  const userMsgs = messages.filter((m) => m.role === "user").length;
  const botMsgs = messages.filter((m) => m.role === "bot").length;
  const adminMsgs = messages.filter((m) => m.role === "admin");

  // นับ admin คนไหนตอบกี่ msg
  const adminCounts: Record<string, number> = {};
  adminMsgs.forEach((m) => {
    const id = m.admin_id || m.admin_name || "unknown";
    adminCounts[id] = (adminCounts[id] || 0) + 1;
  });

  const statusLabel = conversation.status === "closed" ? "ปิด" : conversation.status === "handoff" || conversation.status === "open" ? "เปิด" : conversation.status;
  const responsibleLabel = conversation.status === "bot"
    ? "บอท"
    : conversation.assigned_to
      ? (conversation.assigned_to_name || conversation.assigned_to.slice(0, 8))
      : "—";

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-sm">
      {/* ── ข้อมูลผู้ใช้ ── */}
      <Section title="ผู้ใช้" icon={User}>
        <InfoRow label="User ID" value={conversation.customer_id} mono />
        <InfoRow label="ชื่อ" value={conversation.customer_name} />
      </Section>

      {/* ── ข้อมูลแชท ── */}
      <Section title="แชท" icon={MessageSquare}>
        <InfoRow label="Conversation ID" value={conversation.id} mono />
        <InfoRow
          label="แอดมินผิดชอบ"
          value={responsibleLabel}
        />
        <InfoRow label="สถานะแชท" value={statusLabel} badge={conversation.status === "closed" ? "red" : "brand"} />
      </Section>

      {/* ── ข้อมูลร้าน ── */}
      <Section title="ร้านค้า" icon={Store}>
        <div className="flex items-center gap-2 mb-2">
          <PlatformIcon platform={conversation.platform} size={20} />
          <span className="text-text font-medium">{conversation.shop_name}</span>
        </div>
        <InfoRow label="Platform" value={conversation.platform} />
        <InfoRow label="Shop ID" value={conversation.shop_id} mono />
        <InfoRow label="ชื่อร้าน" value={conversation.shop_name} />
      </Section>

      {/* ── สินค้าที่ถูกพูดถึง ── */}
      {conversation.item_ids && conversation.item_ids.length > 0 && (
        <Section title={`สินค้าที่ถูกพูดถึง (${conversation.item_ids.length})`} icon={Store}>
          <div className="flex flex-wrap gap-1.5">
            {conversation.item_ids.map((id) => (
              <span key={id} className="text-xs px-2 py-1 rounded bg-surface-2 text-text-muted font-mono">
                {id}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* ── Statistics ── */}
      <Section title="สถิติการสนทนา" icon={MessageSquare}>
        <div className="space-y-2">
          <StatRow icon={<User size={12} />} label="user" count={userMsgs} tone="coral" />
          <StatRow icon={<Bot size={12} />} label="bot" count={botMsgs} tone="brand" />
          {Object.entries(adminCounts).map(([id, count]) => (
            <StatRow key={id} icon={<Headset size={12} />} label={`admin: ${id}`} count={count} tone="neutral" />
          ))}
          <div className="pt-2 border-t border-border text-xs text-text-muted">
            รวมทั้งหมด {messages.length} ข้อความ
          </div>
        </div>
      </Section>

      {/* ── ประวัติปิดแชท (card ยืด/หด ได้) ── */}
      <CloseHistoryCards history={closeHistory} />
    </div>
  );
}

/* ---------- Sub components ---------- */

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5 space-y-2">
      <div className="flex items-center gap-2 text-text-muted">
        <Icon size={14} />
        <h3 className="text-xs font-semibold uppercase tracking-wide">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono, badge }: { label: string; value: string; mono?: boolean; badge?: "brand" | "red" | "neutral" }) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="text-text-muted shrink-0">{label}</span>
      {badge ? (
        <Badge tone={badge}>{value}</Badge>
      ) : (
        <span className={`text-text text-right break-all ${mono ? "font-mono text-[11px]" : ""}`}>
          {value || "—"}
        </span>
      )}
    </div>
  );
}

function StatRow({ icon, label, count, tone }: { icon: React.ReactNode; label: string; count: number; tone: "coral" | "brand" | "neutral" }) {
  const toneClass = tone === "coral" ? "text-vibrant-coral" : tone === "brand" ? "text-brand" : "text-text-muted";
  return (
    <div className="flex items-center justify-between text-xs">
      <span className={`flex items-center gap-1.5 ${toneClass}`}>
        {icon}
        {label}
      </span>
      <span className="font-semibold text-text">{count}</span>
    </div>
  );
}

/* ---------- Close History Cards (ยืด/หด ได้) ---------- */

function CloseHistoryCards({ history }: { history: CloseHistoryRecord[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (history.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-2 text-text-muted mb-1">
          <History size={14} />
          <h3 className="text-xs font-semibold uppercase tracking-wide">ประวัติปิดแชท</h3>
        </div>
        <p className="text-xs text-text-subtle">ยังไม่มีประวัติ</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-text-muted px-1">
        <History size={14} />
        <h3 className="text-xs font-semibold uppercase tracking-wide">
          ประวัติปิดแชท ({history.length})
        </h3>
      </div>
      {history.map((rec) => {
        const expanded = expandedIds.has(rec.record_id);
        const isReopened = !!rec.reopened_at;
        return (
          <div key={rec.record_id} className="rounded-lg border border-border bg-surface overflow-hidden">
            <button
              onClick={() => toggle(rec.record_id)}
              className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-surface-2/50 transition-colors"
            >
              <div className="flex items-center gap-2 text-left">
                {expanded ? <ChevronDown size={14} className="text-text-muted shrink-0" /> : <ChevronRight size={14} className="text-text-muted shrink-0" />}
                <div>
                  <div className="text-xs font-medium text-text">
                    ครั้งที่ {rec.sequence} · {CATEGORY_LABELS[rec.category] || rec.category}
                  </div>
                  <div className="text-[11px] text-text-subtle">
                    {new Date(rec.closed_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                  </div>
                </div>
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${isReopened ? "bg-brand/10 text-brand" : "bg-surface-2 text-text-muted"}`}>
                {isReopened ? "เปิดใหม่แล้ว" : "ปิดอยู่"}
              </span>
            </button>
            {expanded && (
              <div className="px-3 pb-3 space-y-2 border-t border-border/60 pt-2">
                <DetailField label="เหตุผล" value={rec.reason} />
                <DetailField label="วิธีการแก้ไข" value={rec.resolution} />
                {rec.note && <DetailField label="หมายเหตุ" value={rec.note} muted />}
                {isReopened && (
                  <div className="pt-2 border-t border-border/40 text-[11px] text-text-muted">
                    เปิดใหม่โดย {rec.reopened_by === "bot" ? "บอท" : rec.reopened_by}
                    {" · "}
                    {new Date(rec.reopened_at!).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                    {rec.reopen_reason && <div className="mt-0.5">{rec.reopen_reason}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DetailField({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-text-muted mb-0.5">{label}</div>
      <div className={`text-xs ${muted ? "text-text-muted italic" : "text-text"}`}>{value}</div>
    </div>
  );
}

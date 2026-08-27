"use client";
// ChatLogTab — แสดง log แนวตั้ง ใครพิมพ์เวลาไหน, role, id, ชื่อ, ข้อความสั้นๆ
import { User, Bot, Headset, Info } from "lucide-react";
import type { ChatMessage } from "@/lib/types";

interface Props {
  messages: ChatMessage[];
}

const ROLE_CONFIG = {
  user: { icon: User, label: "ลูกค้า", tone: "text-vibrant-coral", bg: "bg-vibrant-coral/5", border: "border-vibrant-coral/20" },
  bot: { icon: Bot, label: "บอท", tone: "text-brand", bg: "bg-brand/5", border: "border-brand/20" },
  admin: { icon: Headset, label: "แอดมิน", tone: "text-deep-space", bg: "bg-pale-sky-soft", border: "border-pale-sky/30" },
  system: { icon: Info, label: "ระบบ", tone: "text-text-muted", bg: "bg-surface-2", border: "border-border" },
} as const;

export function ChatLogTab({ messages }: Props) {
  if (messages.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center mb-3">
          <Headset size={20} className="text-text-subtle" />
        </div>
        <p className="text-sm font-medium text-text">ยังไม่มีข้อความ</p>
        <p className="text-xs text-text-muted mt-1">log จะแสดงที่นี่เมื่อมีการสนทนา</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="space-y-1.5">
        {messages.map((msg, idx) => {
          const cfg = ROLE_CONFIG[msg.role] || ROLE_CONFIG.admin;
          const Icon = cfg.icon;
          const time = new Date(msg.timestamp).toLocaleString("th-TH", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            day: "2-digit",
            month: "short",
          });

          return (
            <div
              key={msg.id || idx}
              className={`rounded-lg border ${cfg.border} ${cfg.bg} px-3 py-2 space-y-1`}
            >
              {/* Row 1: role + name + time */}
              <div className="flex items-center justify-between gap-2">
                <div className={`flex items-center gap-1.5 text-xs font-medium ${cfg.tone}`}>
                  <Icon size={12} />
                  <span>{cfg.label}</span>
                  {msg.admin_name && (
                    <span className="text-text-muted font-normal">· {msg.admin_name}</span>
                  )}
                  {msg.admin_id && !msg.admin_name && (
                    <span className="text-text-muted font-normal font-mono text-[10px]">· {msg.admin_id.slice(0, 8)}</span>
                  )}
                </div>
                <span className="text-[10px] text-text-subtle shrink-0">{time}</span>
              </div>
              {/* Row 2: message text (สั้น) */}
              <div className="text-xs text-text line-clamp-3 break-words">
                {msg.text || "(ไม่มีข้อความ)"}
              </div>
              {/* Products attached */}
              {msg.products && msg.products.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {msg.products.map((p) => (
                    <span key={p.item_id} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">
                      📦 {p.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

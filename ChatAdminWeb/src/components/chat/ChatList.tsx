// ChatList — left column: list of conversations across 3 platforms (Zaapi-style)
"use client";
import { useState, useMemo } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Badge } from "@/components/ui/Badge";
import { Search, Filter } from "lucide-react";
import type { Conversation, Platform } from "@/lib/types";

interface Props {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const platformFilters: { value: Platform | "all"; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok" },
  { value: "lazada", label: "Lazada" },
];

const statusFilters: { value: Conversation["status"] | "all"; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "handoff", label: "รอแอดมิน" },
  { value: "bot", label: "บอท" },
  { value: "resolved", label: "เสร็จ" },
];

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.`;
  const d = Math.floor(h / 24);
  return `${d} วัน`;
}

const statusTone: Record<string, "brand" | "coral" | "neutral" | "pale"> = {
  bot: "brand",
  handoff: "coral",
  resolved: "neutral",
  pending: "pale",
};

const statusLabel: Record<string, string> = {
  bot: "บอท",
  handoff: "รอแอดมิน",
  resolved: "เสร็จ",
  pending: "รอตอบ",
};

export function ChatList({ conversations, selectedId, onSelect }: Props) {
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [status, setStatus] = useState<Conversation["status"] | "all">("all");

  const filtered = useMemo(() => {
    return conversations
      .filter((c) => platform === "all" || c.platform === platform)
      .filter((c) => status === "all" || c.status === status)
      .filter(
        (c) =>
          !search ||
          c.customer_name.toLowerCase().includes(search.toLowerCase()) ||
          c.last_message.toLowerCase().includes(search.toLowerCase()) ||
          c.shop_name.toLowerCase().includes(search.toLowerCase())
      )
      .sort((a, b) => new Date(b.last_timestamp).getTime() - new Date(a.last_timestamp).getTime());
  }, [conversations, search, platform, status]);

  return (
    <div className="w-full md:w-80 shrink-0 border-r border-border bg-surface flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-border space-y-2.5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-text">กล่องข้อความ</h2>
          <Badge tone="brand">{filtered.length}</Badge>
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหา..."
            className="w-full h-8 pl-8 pr-3 rounded-lg bg-surface-2 text-xs placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
        </div>

        {/* Platform filter */}
        <div className="flex items-center gap-1 flex-wrap">
          <Filter size={12} className="text-text-subtle" />
          {platformFilters.map((f) => (
            <button
              key={f.value}
              onClick={() => setPlatform(f.value)}
              className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
                platform === f.value
                  ? "bg-brand text-white"
                  : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex items-center gap-1 flex-wrap">
          {statusFilters.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={`px-2 py-0.5 text-[11px] rounded-md transition-colors ${
                status === f.value
                  ? "bg-deep-space text-white"
                  : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-text-muted">ไม่พบแชท</div>
        ) : (
          filtered.map((c) => {
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`w-full flex items-start gap-3 p-3 border-b border-border text-left transition-colors ${
                  active ? "bg-pale-sky-soft border-l-2 border-l-brand" : "hover:bg-surface-2"
                }`}
              >
                <div className="relative shrink-0">
                  <Avatar name={c.customer_name} src={c.customer_avatar} size={40} />
                  <div className="absolute -bottom-0.5 -right-0.5">
                    <PlatformIcon platform={c.platform} size={16} />
                  </div>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-sm font-medium text-text truncate">{c.customer_name}</span>
                    <span className="text-[10px] text-text-subtle shrink-0">{timeAgo(c.last_timestamp)}</span>
                  </div>
                  <div className="text-[11px] text-text-muted truncate">{c.shop_name}</div>
                  <div className="text-xs text-text-muted truncate mt-0.5">{c.last_message}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Badge tone={statusTone[c.status]}>{statusLabel[c.status]}</Badge>
                    {c.unread > 0 && (
                      <span className="ml-auto bg-vibrant-coral text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                        {c.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

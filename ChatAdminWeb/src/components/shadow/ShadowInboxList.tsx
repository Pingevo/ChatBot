// ShadowInboxList — left column: list of shadow replies
// แสดง: search + platform filter + rating filter + list
"use client";
import { useState, useMemo } from "react";
import { Badge } from "@/components/ui/Badge";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import {
  Search, ChevronDown, Check, ArrowDownUp,
  FlaskConical, CheckCircle2, XCircle, MinusCircle, AlertTriangle,
} from "lucide-react";
import type { Platform } from "@/lib/types";

export interface ShadowReplyListItem {
  shadow_reply_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  inbound_message_id?: string;
  inbound_text: string;
  bot_reply_text: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed_ms?: number;
  bot_tokens?: { prompt: number; output: number; total: number };
  bot_products?: any[];
  zaapi_reply_text?: string;
  rating?: "better" | "worse" | "tie" | "unrated";
  origin?: "worker" | "manual" | "manual_conversation";
  created_at: string;
}

interface Props {
  rows: ShadowReplyListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
  total?: number;
  headerExtra?: React.ReactNode;
}

type RatingFilter = "all" | "better" | "worse" | "tie" | "unrated";
type PlatformFilter = "all" | Platform;
type SortOption = "recent" | "oldest" | "platform";

const ratingMeta: Record<string, { label: string; icon: typeof CheckCircle2; color: string }> = {
  better: { label: "Bot ดีกว่า", icon: CheckCircle2, color: "text-green-600" },
  worse: { label: "Bot แย่กว่า", icon: XCircle, color: "text-red-600" },
  tie: { label: "เสมอ", icon: MinusCircle, color: "text-blue-600" },
  unrated: { label: "ยังไม่ให้คะแนน", icon: AlertTriangle, color: "text-yellow-600" },
};

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

export function ShadowInboxList({ rows, selectedId, onSelect, loading, total, headerExtra }: Props) {
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [showPlatformDd, setShowPlatformDd] = useState(false);
  const [showRatingDd, setShowRatingDd] = useState(false);
  const [showSortDd, setShowSortDd] = useState(false);

  const filtered = useMemo(() => {
    let result = rows;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((r) =>
        r.inbound_text.toLowerCase().includes(q) ||
        r.bot_reply_text.toLowerCase().includes(q) ||
        (r.zaapi_reply_text || "").toLowerCase().includes(q) ||
        r.conversation_id.toLowerCase().includes(q)
      );
    }
    if (platformFilter !== "all") {
      result = result.filter((r) => r.platform === platformFilter);
    }
    if (ratingFilter !== "all") {
      const want = ratingFilter === "unrated" ? null : ratingFilter;
      result = result.filter((r) => (r.rating || null) === want);
    }
    const sorted = [...result];
    if (sortBy === "recent") {
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sortBy === "oldest") {
      sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else if (sortBy === "platform") {
      sorted.sort((a, b) => a.platform.localeCompare(b.platform));
    }
    return sorted;
  }, [rows, search, platformFilter, ratingFilter, sortBy]);

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <FlaskConical size={16} className="text-brand shrink-0" />
            <h2 className="text-sm font-semibold text-text truncate">Shadow Inbox</h2>
            <span className="text-[10px] text-text-subtle shrink-0">
              {filtered.length}{total != null && total !== filtered.length ? `/${total}` : ""}
            </span>
          </div>
          {headerExtra && <div className="shrink-0">{headerExtra}</div>}
        </div>

        {/* Search */}
        <div className="relative mb-2">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหา..."
            className="w-full h-8 pl-8 pr-3 rounded-lg border border-border bg-surface-2 text-xs focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </div>

        {/* Filters row */}
        <div className="flex items-center gap-1.5">
          {/* Platform */}
          <div className="relative flex-1">
            <button
              onClick={() => { setShowPlatformDd(!showPlatformDd); setShowRatingDd(false); setShowSortDd(false); }}
              className="w-full h-7 px-2 rounded-md border border-border bg-surface text-[11px] flex items-center justify-between gap-1 hover:bg-surface-2 transition-colors"
            >
              <span className="truncate">{platformFilter === "all" ? "แพลตฟอร์ม" : platformFilter === "shopee" ? "Shopee" : platformFilter === "tiktok" ? "TikTok" : "Lazada"}</span>
              <ChevronDown size={10} className="text-text-muted shrink-0" />
            </button>
            {showPlatformDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowPlatformDd(false)} />
                <div className="absolute top-full left-0 mt-1 w-full bg-surface border border-border rounded-md shadow-lg z-40 py-0.5">
                  {(["all", "shopee", "tiktok", "lazada"] as PlatformFilter[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => { setPlatformFilter(v); setShowPlatformDd(false); }}
                      className={`w-full text-left px-2 py-1 text-[11px] hover:bg-surface-2 flex items-center gap-1.5 ${platformFilter === v ? "text-brand font-medium" : "text-text"}`}
                    >
                      {platformFilter === v && <Check size={10} />}
                      {v === "all" ? "ทั้งหมด" : v === "shopee" ? "Shopee" : v === "tiktok" ? "TikTok" : "Lazada"}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Rating */}
          <div className="relative flex-1">
            <button
              onClick={() => { setShowRatingDd(!showRatingDd); setShowPlatformDd(false); setShowSortDd(false); }}
              className="w-full h-7 px-2 rounded-md border border-border bg-surface text-[11px] flex items-center justify-between gap-1 hover:bg-surface-2 transition-colors"
            >
              <span className="truncate">{ratingFilter === "all" ? "คะแนน" : ratingMeta[ratingFilter]?.label}</span>
              <ChevronDown size={10} className="text-text-muted shrink-0" />
            </button>
            {showRatingDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowRatingDd(false)} />
                <div className="absolute top-full left-0 mt-1 w-full bg-surface border border-border rounded-md shadow-lg z-40 py-0.5">
                  {(["all", "better", "worse", "tie", "unrated"] as RatingFilter[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => { setRatingFilter(v); setShowRatingDd(false); }}
                      className={`w-full text-left px-2 py-1 text-[11px] hover:bg-surface-2 flex items-center gap-1.5 ${ratingFilter === v ? "text-brand font-medium" : "text-text"}`}
                    >
                      {ratingFilter === v && <Check size={10} />}
                      {v === "all" ? "ทั้งหมด" : ratingMeta[v]?.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Sort */}
          <div className="relative">
            <button
              onClick={() => { setShowSortDd(!showSortDd); setShowPlatformDd(false); setShowRatingDd(false); }}
              className="w-7 h-7 rounded-md border border-border bg-surface flex items-center justify-center hover:bg-surface-2 transition-colors"
              title="เรียงลำดับ"
            >
              <ArrowDownUp size={12} className="text-text-muted" />
            </button>
            {showSortDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowSortDd(false)} />
                <div className="absolute top-full right-0 mt-1 w-32 bg-surface border border-border rounded-md shadow-lg z-40 py-0.5">
                  {([
                    { v: "recent", l: "ใหม่ล่าสุด" },
                    { v: "oldest", l: "เก่าสุด" },
                    { v: "platform", l: "ตามแพลตฟอร์ม" },
                  ] as { v: SortOption; l: string }[]).map((o) => (
                    <button
                      key={o.v}
                      onClick={() => { setSortBy(o.v); setShowSortDd(false); }}
                      className={`w-full text-left px-2 py-1 text-[11px] hover:bg-surface-2 flex items-center gap-1.5 ${sortBy === o.v ? "text-brand font-medium" : "text-text"}`}
                    >
                      {sortBy === o.v && <Check size={10} />}
                      {o.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8 text-xs text-text-muted">กำลังโหลด...</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <FlaskConical size={28} className="text-text-subtle mb-2" />
            <p className="text-xs text-text-muted">{rows.length === 0 ? "ยังไม่มี shadow replies" : "ไม่พบรายการที่ตรง"}</p>
          </div>
        ) : (
          filtered.map((r) => {
            const rating = r.rating || "unrated";
            const rm = ratingMeta[rating];
            const RatingIcon = rm.icon;
            const isSelected = r.shadow_reply_id === selectedId;
            return (
              <button
                key={r.shadow_reply_id}
                onClick={() => onSelect(r.shadow_reply_id)}
                className={`w-full text-left px-3 py-2.5 border-b border-border transition-colors ${
                  isSelected ? "bg-brand/8 border-l-2 border-l-brand" : "hover:bg-surface-2 border-l-2 border-l-transparent"
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <PlatformIcon platform={r.platform} size={12} />
                  <span className="text-[10px] text-text-subtle truncate">{r.conversation_id.slice(0, 18)}...</span>
                  <span className="ml-auto shrink-0">
                    <RatingIcon size={12} className={rm.color} />
                  </span>
                </div>
                <p className="text-xs text-text line-clamp-2 leading-snug">{r.inbound_text}</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] text-text-subtle">{timeAgo(r.created_at)}</span>
                  {r.zaapi_reply_text && (
                    <Badge tone="neutral" className="text-[9px] px-1 py-0">Zaapi</Badge>
                  )}
                  <Badge tone="brand" className="text-[9px] px-1 py-0">Bot</Badge>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

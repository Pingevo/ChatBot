// ShadowStatPanel — right column with tab menu: Per Chat | All History
// Per Chat: stats ของแชทที่เลือก (win rate, star, comment, cost)
// All History: stats รวมทุก shadow reply ที่ไม่ deleted
"use client";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import {
  CheckCircle2, XCircle, AlertTriangle, Star, MessageCircle,
  TrendingUp, BarChart3, Trophy, DollarSign, Clock, Cpu, MessageSquare, History,
} from "lucide-react";
import type { Platform } from "@/lib/types";

export interface ShadowStats {
  total: number;
  rated: number;
  good: number;
  bad: number;
  unrated: number;
  bot_win_rate: number;
  // star rating
  star_rated?: number;
  avg_star?: number;
  star_5?: number;
  star_4?: number;
  star_3?: number;
  star_below3?: number;
  // comment
  commented?: number;
  // cost + performance
  total_cost_usd?: number;
  total_cost_thb?: number;
  avg_cost_usd?: number;
  avg_elapsed_ms?: number;
  total_tokens?: number;
  avg_tokens?: number;
}

export interface PlatformStat {
  platform: Platform;
  total: number;
  good: number;
  bad: number;
  
  win_rate: number;
}

interface Props {
  stats: ShadowStats | null;          // all-history stats (ไม่ deleted)
  convStats?: ShadowStats | null;     // per-conversation stats
  platformStats?: PlatformStat[];
  title?: string;
}

function StarBadge({ value, size = 12 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-yellow-600">
      <Star size={size} className="fill-yellow-400 text-yellow-400" />
      <span className="font-semibold">{value.toFixed(1)}</span>
    </span>
  );
}

function StatsContent({ stats, platformStats }: { stats: ShadowStats | null; platformStats?: PlatformStat[] }) {
  if (!stats) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <BarChart3 size={28} className="text-text-subtle mb-2" />
        <p className="text-xs text-text-muted">ยังไม่มีสถิติ</p>
      </div>
    );
  }
  return (
    <>
      {/* Win rate hero */}
      <Card className="p-4 text-center">
        <div className="flex items-center justify-center gap-1.5 text-xs text-text-muted mb-1">
          <Trophy size={12} className="text-brand" />
          Bot Win Rate
        </div>
        <div className="text-3xl font-bold text-brand">
          {(stats.bot_win_rate * 100).toFixed(0)}%
        </div>
        <div className="text-[10px] text-text-subtle mt-1">
          จาก {stats.rated} รายการที่ให้คะแนน
        </div>
      </Card>

      {/* Star rating hero */}
      <Card className="p-4 text-center">
        <div className="flex items-center justify-center gap-1.5 text-xs text-text-muted mb-1">
          <Star size={12} className="text-yellow-400 fill-yellow-400" />
          คะแนนดาวเฉลี่ย
        </div>
        <div className="text-3xl font-bold text-yellow-500">
          {typeof stats.avg_star === "number" && stats.star_rated ? stats.avg_star.toFixed(1) : "—"}
          <span className="text-sm font-normal text-text-subtle"> / 5</span>
        </div>
        <div className="text-[10px] text-text-subtle mt-1">
          จาก {stats.star_rated || 0} รายการที่ให้ดาว
        </div>
        {stats.star_rated && stats.star_rated > 0 && (
          <div className="mt-2 flex items-center justify-center gap-2 text-[10px]">
            <span className="text-yellow-600">5★ {stats.star_5 || 0}</span>
            <span className="text-yellow-600/80">4★ {stats.star_4 || 0}</span>
            <span className="text-yellow-600/60">3★ {stats.star_3 || 0}</span>
            <span className="text-red-500">&lt;3★ {stats.star_below3 || 0}</span>
          </div>
        )}
      </Card>

      {/* Counts grid */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
            <CheckCircle2 size={10} className="text-green-600" /> Good
          </div>
          <div className="text-lg font-bold text-green-600 mt-0.5">{stats.good}</div>
        </Card>
        <Card className="p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
            <XCircle size={10} className="text-red-600" /> Bad
          </div>
          <div className="text-lg font-bold text-red-600 mt-0.5">{stats.bad}</div>
        </Card>
        <Card className="p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
            <AlertTriangle size={10} className="text-yellow-600" /> ยังไม่ให้คะแนน
          </div>
          <div className="text-lg font-bold text-yellow-600 mt-0.5">{stats.unrated}</div>
        </Card>
      </div>

      {/* Total + Commented */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-muted">แชทบอทตอบ</span>
            <span className="text-sm font-bold text-text">{stats.total}</span>
          </div>
        </Card>
        <Card className="p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-text-muted inline-flex items-center gap-1">
              <MessageCircle size={10} /> มีคอมเมนต์
            </span>
            <span className="text-sm font-bold text-text">{stats.commented || 0}</span>
          </div>
        </Card>
      </div>

      {/* Cost + Performance */}
      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-text-muted mb-2 mt-2">
          <DollarSign size={12} /> ต้นทุน & ประสิทธิภาพ
        </div>
        <div className="space-y-2">
          <Card className="p-2.5">
            <div className="text-[10px] text-text-muted mb-1">ต้นทุนรวม</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-bold text-green-700">
                ${typeof stats.total_cost_usd === "number" ? stats.total_cost_usd.toFixed(4) : "0.0000"}
              </span>
              <span className="text-[10px] text-text-subtle">
                ≈ ฿{typeof stats.total_cost_thb === "number" ? stats.total_cost_thb.toFixed(2) : "0.00"}
              </span>
            </div>
            <div className="text-[10px] text-text-subtle mt-0.5">
              เฉลี่ย ${typeof stats.avg_cost_usd === "number" ? stats.avg_cost_usd.toFixed(6) : "0.000000"}/ครั้ง
            </div>
          </Card>

          <Card className="p-2.5">
            <div className="flex items-center gap-1.5 text-[10px] text-text-muted mb-1">
              <Clock size={10} /> เวลาตอบเฉลี่ย
            </div>
            <div className="text-sm font-bold text-text">
              {typeof stats.avg_elapsed_ms === "number" ? stats.avg_elapsed_ms.toFixed(2) : "0"}s
            </div>
          </Card>

          <Card className="p-2.5">
            <div className="flex items-center gap-1.5 text-[10px] text-text-muted mb-1">
              <Cpu size={10} /> Tokens รวม
            </div>
            <div className="text-sm font-bold text-text">
              {typeof stats.total_tokens === "number" ? stats.total_tokens.toLocaleString() : "0"}
            </div>
            <div className="text-[10px] text-text-subtle mt-0.5">
              เฉลี่ย {typeof stats.avg_tokens === "number" ? Math.round(stats.avg_tokens) : 0}/ครั้ง
            </div>
          </Card>
        </div>
      </div>

      {/* Platform breakdown */}
      {platformStats && platformStats.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-text-muted mb-2 mt-2">
            <TrendingUp size={12} /> ตามแพลตฟอร์ม
          </div>
          <div className="space-y-2">
            {platformStats.map((p) => (
              <Card key={p.platform} className="p-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <PlatformIcon platform={p.platform} size={14} />
                    <span className="text-xs font-medium text-text">
                      {p.platform === "shopee" ? "Shopee" : p.platform === "tiktok" ? "TikTok" : "Lazada"}
                    </span>
                  </div>
                  <span className="text-sm font-bold text-brand">
                    {(p.win_rate * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-muted">
                  <span className="text-green-600">ดี {p.good}</span>
                  <span className="text-red-600">แย่ {p.bad}</span>
                  <span className="ml-auto">รวม {p.total}</span>
                </div>
                <div className="mt-1.5 h-1.5 bg-surface-2 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand rounded-full transition-all"
                    style={{ width: `${p.win_rate * 100}%` }}
                  />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export function ShadowStatPanel({ stats, convStats, platformStats, title = "สถิติ" }: Props) {
  const [tab, setTab] = useState<"perChat" | "allHistory">("allHistory");
  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Header + Tab menu */}
      <div className="px-3 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 size={16} className="text-brand" />
          <h2 className="text-sm font-semibold text-text">{title}</h2>
        </div>
        {/* Tab buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab("perChat")}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
              tab === "perChat"
                ? "bg-brand/10 border-brand/40 text-brand"
                : "border-border text-text-muted hover:bg-surface-2"
            }`}
          >
            <MessageSquare size={11} /> Per Chat
          </button>
          <button
            onClick={() => setTab("allHistory")}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-colors ${
              tab === "allHistory"
                ? "bg-brand/10 border-brand/40 text-brand"
                : "border-border text-text-muted hover:bg-surface-2"
            }`}
          >
            <History size={11} /> All History
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tab === "perChat" ? (
          convStats ? (
            <StatsContent stats={convStats} />
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <MessageSquare size={28} className="text-text-subtle mb-2" />
              <p className="text-xs text-text-muted">เลือกแชททางซ้ายเพื่อดูสถิติของแชทนั้น</p>
            </div>
          )
        ) : (
          <StatsContent stats={stats} platformStats={platformStats} />
        )}
      </div>
    </div>
  );
}

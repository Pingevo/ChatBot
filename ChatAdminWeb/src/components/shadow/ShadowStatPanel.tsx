// ShadowStatPanel — right column: stats + win rate + breakdown
// แสดง: total, better, worse, tie, unrated, win rate, platform breakdown
"use client";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import {
  CheckCircle2, XCircle, MinusCircle, AlertTriangle,
  TrendingUp, BarChart3, Trophy, DollarSign, Clock, Cpu,
} from "lucide-react";
import type { Platform } from "@/lib/types";

export interface ShadowStats {
  total: number;
  rated: number;
  better: number;
  worse: number;
  tie: number;
  unrated: number;
  bot_win_rate: number;
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
  better: number;
  worse: number;
  tie: number;
  win_rate: number;
}

interface Props {
  stats: ShadowStats | null;
  platformStats?: PlatformStat[];
}

export function ShadowStatPanel({ stats, platformStats }: Props) {
  return (
    <div className="h-full flex flex-col bg-surface">
      {/* Header */}
      <div className="px-3 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <BarChart3 size={16} className="text-brand" />
          <h2 className="text-sm font-semibold text-text">สถิติ</h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {stats ? (
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

            {/* Counts grid */}
            <div className="grid grid-cols-2 gap-2">
              <Card className="p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                  <CheckCircle2 size={10} className="text-green-600" /> ดีกว่า
                </div>
                <div className="text-lg font-bold text-green-600 mt-0.5">{stats.better}</div>
              </Card>
              <Card className="p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                  <XCircle size={10} className="text-red-600" /> แย่กว่า
                </div>
                <div className="text-lg font-bold text-red-600 mt-0.5">{stats.worse}</div>
              </Card>
              <Card className="p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                  <MinusCircle size={10} className="text-blue-600" /> เสมอ
                </div>
                <div className="text-lg font-bold text-blue-600 mt-0.5">{stats.tie}</div>
              </Card>
              <Card className="p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                  <AlertTriangle size={10} className="text-yellow-600" /> ยังไม่ให้คะแนน
                </div>
                <div className="text-lg font-bold text-yellow-600 mt-0.5">{stats.unrated}</div>
              </Card>
            </div>

            {/* Total */}
            <Card className="p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">ทั้งหมด</span>
                <span className="text-sm font-bold text-text">{stats.total}</span>
              </div>
            </Card>

            {/* Cost + Performance */}
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-text-muted mb-2 mt-2">
                <DollarSign size={12} /> ต้นทุน & ประสิทธิภาพ
              </div>
              <div className="space-y-2">
                {/* Total cost */}
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

                {/* Avg response time */}
                <Card className="p-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] text-text-muted mb-1">
                    <Clock size={10} /> เวลาตอบเฉลี่ย
                  </div>
                  <div className="text-sm font-bold text-text">
                    {typeof stats.avg_elapsed_ms === "number" ? stats.avg_elapsed_ms.toFixed(2) : "0"}s
                  </div>
                </Card>

                {/* Tokens */}
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
                        <span className="text-green-600">ดี {p.better}</span>
                        <span className="text-red-600">แย่ {p.worse}</span>
                        <span className="text-blue-600">เสมอ {p.tie}</span>
                        <span className="ml-auto">รวม {p.total}</span>
                      </div>
                      {/* Win rate bar */}
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
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <BarChart3 size={28} className="text-text-subtle mb-2" />
            <p className="text-xs text-text-muted">ยังไม่มีสถิติ</p>
          </div>
        )}
      </div>
    </div>
  );
}

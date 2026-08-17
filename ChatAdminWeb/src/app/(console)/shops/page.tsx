"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Store, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEdit } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import type { Platform } from "@/lib/types";

interface ShopRow {
  shop_id: string;
  shopname: string;
  platform: Platform;
  connected: boolean;
  conversation_count: number;
  product_count: number;
  last_sync_at?: string | null;
  created_at: string;
}

const platformFilters: { value: Platform | "all"; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok" },
  { value: "lazada", label: "Lazada" },
];

// Mock data — used when DB is empty
const mockShops: ShopRow[] = [
  { shop_id: "s1", shopname: "IMILabThailand", platform: "shopee", connected: true, conversation_count: 12, product_count: 58, last_sync_at: null, created_at: new Date().toISOString() },
  { shop_id: "s2", shopname: "KospetThailand", platform: "shopee", connected: true, conversation_count: 5, product_count: 35, last_sync_at: null, created_at: new Date().toISOString() },
  { shop_id: "s3", shopname: "Yaber", platform: "shopee", connected: true, conversation_count: 3, product_count: 24, last_sync_at: null, created_at: new Date().toISOString() },
  { shop_id: "s4", shopname: "YoupinOfficialStore", platform: "shopee", connected: true, conversation_count: 28, product_count: 550, last_sync_at: null, created_at: new Date().toISOString() },
  { shop_id: "s5", shopname: "TikTokGadget", platform: "tiktok", connected: false, conversation_count: 0, product_count: 120, last_sync_at: null, created_at: new Date().toISOString() },
  { shop_id: "s6", shopname: "LazadaTech", platform: "lazada", connected: false, conversation_count: 0, product_count: 80, last_sync_at: null, created_at: new Date().toISOString() },
];

export default function ShopsPage() {
  const { user } = useAuth();
  const editable = canEdit(user);
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ rows: ShopRow[]; total: number }>("/shops", {
        params: { platform: platform === "all" ? undefined : platform },
      });
      if (r.data.rows.length === 0) {
        setShops(mockShops);
        setUsingMock(true);
      } else {
        setShops(r.data.rows);
        setUsingMock(false);
      }
    } catch {
      setShops(mockShops);
      setUsingMock(true);
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggle(shop: ShopRow) {
    if (usingMock) {
      setShops((prev) =>
        prev.map((s) => (s.shop_id === shop.shop_id ? { ...s, connected: !s.connected } : s))
      );
      return;
    }
    setToggling(shop.shop_id);
    try {
      await api().patch(`/shops/${shop.shop_id}`, { connected: !shop.connected });
      await load();
    } catch {
      alert("เปลี่ยนสถานะไม่สำเร็จ");
    } finally {
      setToggling(null);
    }
  }

  const filtered = platform === "all" ? shops : shops.filter((s) => s.platform === platform);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-text">ร้านค้า</h1>
          <p className="text-sm text-text-muted">
            ร้านในเครือทั้ง 3 แพลตฟอร์ม
            {usingMock && " · ตัวอย่างข้อมูล (ยังไม่มีข้อมูลจริง)"}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
        </Button>
      </div>

      {/* Platform filter */}
      <div className="flex gap-1.5 mb-4">
        {platformFilters.map((f) => (
          <button
            key={f.value}
            onClick={() => setPlatform(f.value)}
            className={`px-3 py-1 text-xs rounded-lg transition-colors ${
              platform === f.value
                ? "bg-brand text-white"
                : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loading size={24} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Store} title="ไม่มีร้านค้า" description="ยังไม่มีร้านเชื่อมต่อ" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((s) => (
            <div
              key={s.shop_id}
              className="bg-surface rounded-xl border border-border p-4 hover:border-pale-sky transition-colors"
            >
              <div className="flex items-center gap-3 mb-3">
                <PlatformIcon platform={s.platform} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-text truncate">{s.shopname}</div>
                  <div className="text-xs text-text-muted capitalize">{s.platform}</div>
                </div>
                <Badge tone={s.connected ? "brand" : "neutral"}>
                  {s.connected ? "เชื่อมต่อ" : "ปิดอยู่"}
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-2 text-center mb-3">
                <div className="bg-surface-2 rounded-lg p-2">
                  <div className="text-sm font-semibold text-text">{s.product_count}</div>
                  <div className="text-[10px] text-text-muted">สินค้า</div>
                </div>
                <div className="bg-surface-2 rounded-lg p-2">
                  <div className="text-sm font-semibold text-text">{s.conversation_count}</div>
                  <div className="text-[10px] text-text-muted">แชท</div>
                </div>
              </div>

              {s.last_sync_at && (
                <div className="text-[10px] text-text-subtle mb-2">
                  ซิงค์ล่าสุด: {new Date(s.last_sync_at).toLocaleString("th-TH")}
                </div>
              )}

              {editable && (
                <Button
                  size="sm"
                  variant={s.connected ? "ghost" : "outline"}
                  className="w-full"
                  disabled={toggling === s.shop_id}
                  onClick={() => handleToggle(s)}
                >
                  {toggling === s.shop_id ? (
                    <Loading size={14} />
                  ) : s.connected ? (
                    "ปิดการเชื่อมต่อ"
                  ) : (
                    "เปิดการเชื่อมต่อ"
                  )}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

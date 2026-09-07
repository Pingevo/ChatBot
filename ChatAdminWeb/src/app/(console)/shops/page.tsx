"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Pagination } from "@/components/ui/Pagination";
import { ShopDetailDrawer } from "@/components/shops/ShopDetailDrawer";
import {
  Store, RefreshCw, Search,
  ArrowUpDown, ArrowUp, ArrowDown, MessageSquare, Package,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import type { Platform } from "@/lib/types";

interface ShopRow {
  shop_id: string;
  shopname: string;
  platform: Platform;
  connected: boolean;
  enabled_for_chat?: boolean;
  conversation_count: number;
  product_count: number;
  last_sync_at?: string | null;
  created_at: string;
}

interface ListResponse {
  rows: ShopRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type SortBy = "shopname" | "created_at" | "conversation_count" | "product_count";
type SortDir = "asc" | "desc";

const platformFilters: { value: Platform | "all"; label: string }[] = [
  { value: "all", label: "ทั้งหมด" },
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok" },
  { value: "lazada", label: "Lazada" },
];

const sortOptions: { value: SortBy; label: string }[] = [
  { value: "created_at", label: "วันที่เพิ่ม" },
  { value: "shopname", label: "ชื่อร้าน" },
  { value: "conversation_count", label: "จำนวนแชท" },
  { value: "product_count", label: "จำนวนสินค้า" },
];

export default function ShopsPage() {
  const { user } = useAuth();
  const editable = canEditPage(user, "shop");
  const { catchError } = useToastError();
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("created_at");
  // ⚡ G-fix — debounce search 300ms — พิมพ์แล้วค้นหาทันที ไม่ต้องกด Enter
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchInput]);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(12);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  // ⚡ G3 — toggling state ย้ายไปหน้า config แล้ว
  // ⚡ G4 — selected shop สำหรับ detail drawer
  const [selectedShop, setSelectedShop] = useState<ShopRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<ListResponse>("/shops", {
        params: {
          platform: platform === "all" ? undefined : platform,
          search: search || undefined,
          sortBy,
          sortDir,
          page,
          pageSize,
        },
      });
      setShops(r.data.rows);
      setTotal(r.data.total);
      setTotalPages(r.data.totalPages);
    } catch {
      setShops([]);
      setTotal(0);
      setTotalPages(0);
    } finally {
      setLoading(false);
    }
  }, [platform, search, sortBy, sortDir, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  // ⚡ G-fix — handleSearch ไม่ต้องแล้ว (debounce ทำให้)

  function handleSort(column: SortBy) {
    if (sortBy === column) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortDir("desc");
    }
    setPage(1);
  }

  function SortIcon({ column }: { column: SortBy }) {
    if (sortBy !== column) return <ArrowUpDown size={12} className="text-text-subtle" />;
    return sortDir === "asc"
      ? <ArrowUp size={12} className="text-brand" />
      : <ArrowDown size={12} className="text-brand" />;
  }

  // ⚡ G3 — handleToggle ย้ายไปหน้า config แล้ว (เปิด/ปิดระบบแชทร้านค้า)

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <Store size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">ร้านค้า</h1>
              <p className="text-xs text-text-muted">
                ร้านในเครือทั้งหมด {total} ร้าน
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1.5">
            {platformFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => { setPlatform(f.value); setPage(1); }}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  platform === f.value
                    ? "bg-brand text-white"
                    : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 ml-auto">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
              <input
                type="text"
                placeholder="ค้นหาร้าน... (พิมพ์แล้วค้นหาทันที)"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="w-56 h-9 pl-9 pr-3 rounded-lg border border-border bg-surface-2 text-text text-sm placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
            {search && (
              <Button size="sm" variant="ghost" onClick={() => { setSearchInput(""); }}>
                ล้าง
              </Button>
            )}
          </div>
        </div>

        {/* Sort options */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-muted">เรียงตาม:</span>
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleSort(opt.value)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors ${
                sortBy === opt.value
                  ? "bg-brand/15 text-brand"
                  : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
              }`}
            >
              {opt.label}
              <SortIcon column={opt.value} />
            </button>
          ))}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex justify-center py-12">
            <Loading size={24} />
          </div>
        ) : shops.length === 0 ? (
          <EmptyState
            icon={Store}
            title="ไม่มีร้านค้า"
            description={search ? "ไม่พบผลลัพธ์ที่ตรงกับการค้นหา" : "ยังไม่มีร้านในระบบ — รอ Phase 6 sync จาก dbWallet"}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {shops.map((s) => (
                <Card
                  key={`${s.platform}-${s.shop_id}`}
                  className="p-4 hover:border-brand cursor-pointer transition-colors"
                  onClick={() => setSelectedShop(s)}
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
                      <div className="flex items-center justify-center gap-1 text-sm font-semibold text-text">
                        <Package size={12} className="text-text-muted" />
                        {s.product_count}
                      </div>
                      <div className="text-[10px] text-text-muted">สินค้า</div>
                    </div>
                    <div className="bg-surface-2 rounded-lg p-2">
                      <div className="flex items-center justify-center gap-1 text-sm font-semibold text-text">
                        <MessageSquare size={12} className="text-text-muted" />
                        {s.conversation_count}
                      </div>
                      <div className="text-[10px] text-text-muted">แชท</div>
                    </div>
                  </div>

                  {s.last_sync_at && (
                    <div className="text-[10px] text-text-subtle mb-2">
                      ซิงค์ล่าสุด: {new Date(s.last_sync_at).toLocaleString("th-TH")}
                    </div>
                  )}

                  {/* ⚡ G3 — ย้าย toggle ไปหน้า config แล้ว ที่นี่แค่ badge */}
                  {s.enabled_for_chat === false && (
                    <div className="text-[10px] text-yellow-400 mb-2">
                      ⚠ ระบบแชทปิดอยู่ (เปิดได้ที่หน้า Config)
                    </div>
                  )}

                  {/* ⚡ G4 — hint ว่ากดเพื่อดูรายละเอียด */}
                  <div className="text-[10px] text-text-subtle text-center pt-1 border-t border-border/50">
                    กดเพื่อดู Workflow · Trigger · Persona · KB
                  </div>
                </Card>
              ))}
            </div>

            {/* Pagination — เลขหน้าสวยๆ */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">
                  หน้า {page} จาก {totalPages} · ทั้งหมด {total} ร้าน
                </span>
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              </div>
            )}
          </>
        )}
      </div>

      {/* ⚡ G4 — Shop detail drawer */}
      <ShopDetailDrawer shop={selectedShop} onClose={() => setSelectedShop(null)} />
    </div>
  );
}

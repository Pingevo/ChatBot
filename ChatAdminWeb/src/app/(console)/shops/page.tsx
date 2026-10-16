"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Pagination } from "@/components/ui/Pagination";
import { ShopDetailDrawer } from "@/components/shops/ShopDetailDrawer";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { botWorkerEffective, type BotWorkerMeta } from "@/lib/botworkerScope";
import {
  Store, RefreshCw, Search,
  ArrowUpDown, ArrowUp, ArrowDown, MessageSquare, Package, Bot,
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
  bot_worker_enabled?: boolean; // ⚡ Phase 2D — per-shop botworker admission (missing = OFF)
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
  bot_worker?: BotWorkerMeta; // ⚡ Phase 2D — scope meta (helper อยู่ใน @/lib/botworkerScope)
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
  // ⚡ Phase 2D — botworker scope meta (global + platform) จาก GET /api/shops
  const [botWorker, setBotWorker] = useState<BotWorkerMeta | null>(null);
  const [platformSaving, setPlatformSaving] = useState<Platform | null>(null);
  // ⚡ Phase 2D — per-shop switch อยู่บน card: lock เฉพาะร้านที่กำลัง save
  const [shopSavingId, setShopSavingId] = useState<string | null>(null);
  // PUT /api/config เป็น dev-only boundary — shop editor ไม่ใช่ dev จะเห็นแต่แก้ไม่ได้
  const configEditable = canEditPage(user ?? null, "config");
  // PATCH /api/shops/[id] boundary = page "shop" (ตรง requirePageEdit ของ route)
  const shopEditable = canEditPage(user ?? null, "shop");

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
      setBotWorker(r.data.bot_worker ?? null);
    } catch (err) {
      console.error("load shops failed", err);
      toast.error("โหลดร้านค้าไม่สำเร็จ", 0, { label: "ลองใหม่", onClick: () => load() });
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

  // ⚡ Phase 2D — platform-level botworker switch → PUT /api/config (dev boundary)
  //   ไม่ optimistic — แสดงค่าจริงหลัง persist + reload เท่านั้น
  //   payload = implemented keys เท่านั้น (latent true บน non-backend ไม่ถูก echo → ไม่ 422-ตัน)
  //   CAS: ส่ง expected = persisted value ที่ UI เห็น — admin อื่นเปลี่ยนก่อน → 409 reload
  async function handlePlatformToggle(p: Platform) {
    if (!botWorker || platformSaving) return;
    const next = !botWorker.platforms[p];
    setPlatformSaving(p);
    try {
      // single-command payload — key เดียวต่อ request (route reject multi-key
      //   เพราะ CAS เป็น per-key: หลาย key = partial-commit risk); expected =
      //   persisted value ที่ UI เห็น — admin อื่นเปลี่ยนก่อน → 409 reload
      await api().put("/config", {
        bot_worker_platforms: { [p]: next },
        expected_bot_worker_platforms: { [p]: botWorker.platforms[p] === true },
      });
      await load();
      toast.success(`${next ? "เปิด" : "ปิด"} Botworker สำหรับ ${p} แล้ว`);
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 409) {
        await load(); // persisted truth ชนะ — ดึงค่าจริงมาแสดง ไม่ retry/reapply
        toast.error("สถานะ platform ถูกเปลี่ยนโดยผู้ใช้อื่น กรุณาตรวจสอบแล้วลองใหม่");
      } else {
        catchError(err, "บันทึก platform switch ไม่สำเร็จ");
      }
    } finally {
      setPlatformSaving(null);
    }
  }

  // ⚡ Phase 2D — per-shop botworker switch บน card → PATCH /api/shops/[id]
  //   ไม่ optimistic — row อ่านจาก shops (server truth) หลัง load() เท่านั้น;
  //   CAS: ส่ง expected = persisted value ที่ UI เห็น — admin อื่นเปลี่ยนก่อน → 409
  //   browser-local serialize: save 1 ร้านต่อครั้ง (shopSavingId) — ไม่กระทบ admin/browser อื่น
  async function handleShopBotWorkerToggle(s: ShopRow) {
    if (shopSavingId !== null) return;
    const next = s.bot_worker_enabled !== true;
    setShopSavingId(s.shop_id);
    try {
      await api().patch(`/shops/${s.shop_id}`, {
        bot_worker_enabled: next,
        expected_bot_worker_enabled: s.bot_worker_enabled === true,
      });
      await load(); // authoritative rows ก่อน แล้วค่อย success
      toast.success(`${next ? "เปิด" : "ปิด"} บอทตอบกลับของ ${s.shopname} แล้ว`);
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 409) {
        await load(); // persisted truth ชนะ — ดึงค่าจริงมาแสดง ไม่ retry/reapply
        toast.error("สถานะร้านถูกเปลี่ยนโดยผู้ใช้อื่น กรุณาตรวจสอบแล้วลองใหม่");
      } else {
        catchError(err, "บันทึกสวิตช์บอทไม่สำเร็จ");
      }
    } finally {
      setShopSavingId(null);
    }
  }

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
    <PageShell
      icon={Store}
      title="ร้านค้า"
      helpHref="/help#shops"
      subtitle={`ร้านในเครือทั้งหมด ${total} ร้าน`}
      actions={
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
        </Button>
      }
    >
      {/* Search — full row */}
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              placeholder="ค้นหาร้าน... (พิมพ์แล้วค้นหาทันที)"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-surface-2 text-text text-sm placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40"
            />
          </div>
          {search && (
            <Button size="sm" variant="ghost" onClick={() => { setSearchInput(""); }}>
              ล้าง
            </Button>
          )}
        </div>

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
        </div>

        {/* ⚡ Phase 2D — Botworker platform scope (global meta + per-platform switches) */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 rounded-lg bg-surface-2 border border-border">
          <span className="text-xs font-semibold text-text">บอทตอบกลับ (Botworker)</span>
          <span className="text-[10px] text-text-subtle">
            ทั้งระบบ: {botWorker?.global === true ? "เปิด" : "ปิด"} (อ่านอย่างเดียว)
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {(["shopee", "tiktok", "lazada"] as Platform[]).map((p) => {
              const implemented = botWorker?.implemented.includes(p) ?? false;
              const on = botWorker?.platforms[p] === true;
              return (
                <div key={p} className="flex items-center gap-1.5"
                  title={!implemented ? "chatbot backend ยังไม่ implement — เปิดไม่ได้" : undefined}>
                  <PlatformIcon platform={p} size={16} />
                  <span className="text-xs text-text-muted capitalize">{p}</span>
                  {implemented ? (
                    <ToggleSwitch
                      size="sm"
                      enabled={on}
                      onChange={() => handlePlatformToggle(p)}
                      disabled={!configEditable || platformSaving !== null}
                      ariaLabel={`Botworker ${p}`}
                    />
                  ) : (
                    <span className="text-[10px] text-text-subtle">ยังไม่มี backend</span>
                  )}
                </div>
              );
            })}
          </div>
          {!configEditable && (
            <span className="text-[10px] text-text-subtle ml-auto">ตั้งค่า platform ได้เฉพาะ dev</span>
          )}
        </div>

        {/* Sort options */}
        <div className="flex items-center gap-2 text-xs overflow-x-auto pb-1">
          <span className="text-text-muted shrink-0">เรียงตาม:</span>
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleSort(opt.value)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap ${
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
                    <div className="text-[10px] text-warning mb-2">
                      ⚠ ระบบแชทปิดอยู่ (เปิดได้ที่หน้า Config)
                    </div>
                  )}

                  {/* ⚡ Phase 2D — per-shop Botworker switch (admission layer 3)
                      stopPropagation ที่ row — switch/row click ไม่เปิด drawer */}
                  {(() => {
                    const eff = botWorkerEffective(s, botWorker);
                    const impl = botWorker?.implemented.includes(s.platform) ?? false;
                    return (
                      <div
                        className="flex items-center gap-2 mb-2 flex-wrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-text shrink-0">
                          <Bot size={12} className="text-text-muted" /> บอทตอบกลับ
                        </span>
                        <span className={`flex-1 min-w-0 text-[10px] ${eff.on ? "text-brand" : "text-text-subtle"}`}>
                          {eff.on ? "เปิด" : `ปิด — ${eff.reason}`}
                        </span>
                        {shopSavingId === s.shop_id && <Loading size={12} />}
                        <ToggleSwitch
                          size="sm"
                          enabled={s.bot_worker_enabled === true}
                          onChange={() => handleShopBotWorkerToggle(s)}
                          // เปิดได้เฉพาะ platform ที่มี backend (API 422 enforce อยู่แล้ว);
                          //   latent true บน platform ไม่รองรับ → ปิดได้เสมอ;
                          //   save ร้านหนึ่งอยู่ → switch ทุกร้านใน browser นี้ disabled ชั่วคราว
                          disabled={
                            !shopEditable ||
                            shopSavingId !== null ||
                            (!impl && s.bot_worker_enabled !== true)
                          }
                          ariaLabel={`บอทตอบกลับ ${s.shopname}`}
                        />
                      </div>
                    );
                  })()}

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

      {/* ⚡ G4 — Shop detail drawer */}
      <ShopDetailDrawer shop={selectedShop} onClose={() => setSelectedShop(null)} />
    </PageShell>
  );
}

"use client";
// ProductsTab — รายการสินค้าของร้าน + search + กดส่งเข้าแชท + coupon placeholder
import { useState, useEffect, useCallback } from "react";
import { Search, Send, Ticket, Package, Loader2 } from "lucide-react";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Pagination } from "@/components/ui/Pagination";
import { api } from "@/lib/apiClient";
import type { Conversation } from "@/lib/types";

interface ProductRow {
  itemid?: string;
  item_id?: string;
  id?: string;
  name?: string;
  item_name?: string;
  product_name?: string;
  title?: string;          // TikTok ใช้ title
  price?: number;
  new_check_price?: number;
  gen_price?: number;
  images?: string[] | { image_url_list?: string[]; image_id_list?: string[] };
  main_images?: { thumb_urls?: string[]; url?: string }[];  // TikTok
  image_url?: string;
  image?: string;
  url?: unknown;
  short_link?: unknown;
  product_link?: unknown;
  shopname?: string;
  stock?: number;
}

interface Props {
  conversation: Conversation;
  onSendProduct: (product: ProductRow) => void;
}

// ดึง URL รูปจาก schema ต่างๆ ของ Shopee/TikTok/Lazada
function extractImage(p: ProductRow): string | undefined {
  // Lazada: images เป็น array ของ URL string
  if (Array.isArray(p.images) && p.images.length > 0) {
    const first = String(p.images[0]);
    return first.startsWith("http") ? first : undefined;
  }
  // Shopee: images เป็น object { image_id_list: [hash, ...] }
  if (p.images && typeof p.images === "object" && !Array.isArray(p.images)) {
    const imgObj = p.images as { image_url_list?: string[]; image_id_list?: string[] };
    const list = imgObj.image_url_list || imgObj.image_id_list;
    if (Array.isArray(list) && list.length > 0) {
      const first = String(list[0]);
      if (first.startsWith("http")) return first;
      // Shopee hash → cf.shopee.co.th/file/
      return "https://cf.shopee.co.th/file/" + first;
    }
  }
  // TikTok: main_images เป็น array ของ { thumb_urls: [...], url: ... }
  if (Array.isArray(p.main_images) && p.main_images.length > 0) {
    const mi = p.main_images[0];
    if (mi?.thumb_urls && mi.thumb_urls.length > 0) return mi.thumb_urls[0];
    if (mi?.url) return mi.url;
  }
  // Fallback
  if (typeof p.image_url === "string") return p.image_url;
  if (typeof p.image === "string") return p.image;
  return undefined;
}

function extractName(p: ProductRow): string {
  return p.name || p.item_name || p.title || p.product_name || "ไม่มีชื่อ";
}

function extractPrice(p: ProductRow): number {
  return Number(p.price || p.new_check_price || p.gen_price || 0);
}

function extractUrl(p: ProductRow): string | undefined {
  const candidates = [p.short_link, p.url, p.product_link];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
  }
  return undefined;
}

export function ProductsTab({ conversation, onSendProduct }: Props) {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"products" | "coupons">("products");

  const loadProducts = useCallback(async (q?: string, p?: number) => {
    setLoading(true);
    setError(null);
    try {
      const curPage = p ?? page;
      // ใช้ shop_name กรอง (product collections ใช้ shopname ไม่ใช่ shop_id)
      const r = await api().get<{ products: ProductRow[]; total: number }>("/products", {
        params: {
          platform: conversation.platform,
          shop_name: conversation.shop_name || undefined,
          shop_id: conversation.shop_id || undefined,
          search: q || undefined,
          limit: pageSize,
          skip: (curPage - 1) * pageSize,
        },
      });
      setProducts(r.data.products || []);
      setTotal(r.data.total || 0);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "โหลดสินค้าไม่สำเร็จ";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [conversation.platform, conversation.shop_name, conversation.shop_id, page]);

  useEffect(() => {
    if (tab === "products") loadProducts(undefined, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, conversation.platform, conversation.shop_name, conversation.shop_id]);

  // debounce search — reset to page 1
  useEffect(() => {
    if (tab !== "products") return;
    setPage(1);
    const t = setTimeout(() => loadProducts(search, 1), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, tab]);

  // load เมื่อเปลี่ยนหน้า
  useEffect(() => {
    if (tab !== "products") return;
    loadProducts(search, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="h-full flex flex-col">
      {/* Sub-tab: สินค้า / คูปอง */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setTab("products")}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
            tab === "products" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"
          }`}
        >
          <Package size={12} /> สินค้า
        </button>
        <button
          onClick={() => setTab("coupons")}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
            tab === "coupons" ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"
          }`}
        >
          <Ticket size={12} /> คูปอง
        </button>
      </div>

      {tab === "products" ? (
        <>
          {/* Search bar */}
          <div className="p-3 border-b border-border shrink-0">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาสินค้า..."
                className="w-full h-9 rounded-lg border border-border bg-surface pl-8 pr-3 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-text-muted">
              <PlatformIcon platform={conversation.platform} size={14} />
              <span>{conversation.shop_name}</span>
            </div>
          </div>

          {/* Product list */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={18} className="animate-spin text-text-muted" />
              </div>
            ) : error ? (
              <div className="text-center py-8 text-xs text-vibrant-coral">{error}</div>
            ) : products.length === 0 ? (
              <div className="text-center py-8 text-xs text-text-muted">ไม่พบสินค้า</div>
            ) : (
              <>
                <div className="text-[10px] text-text-subtle mb-1">{total} สินค้า · หน้า {page}/{totalPages}</div>
                {products.map((p, idx) => {
                  const itemId = String(p.itemid || p.item_id || p.id || idx);
                  const name = extractName(p);
                  const img = extractImage(p);
                  const price = extractPrice(p);
                  return (
                    <div
                      key={itemId}
                      className="flex items-center gap-2.5 rounded-lg border border-border bg-surface p-2.5 hover:border-brand/30 transition-colors"
                    >
                      {/* Thumbnail — เล็กลงเพื่อโหลดไวขึ้น */}
                      <div className="w-10 h-10 rounded-lg bg-surface-2 flex items-center justify-center shrink-0 overflow-hidden">
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={img}
                            alt={name}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            width={40}
                            height={40}
                          />
                        ) : (
                          <Package size={14} className="text-text-subtle" />
                        )}
                      </div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-text line-clamp-2">{name}</div>
                        {price > 0 && (
                          <div className="text-xs text-brand font-semibold mt-0.5">฿{price.toLocaleString()}</div>
                        )}
                        <div className="text-[10px] text-text-subtle font-mono mt-0.5 truncate">{itemId}</div>
                      </div>
                      {/* Send button */}
                      <button
                        onClick={() => onSendProduct(p)}
                        className="w-8 h-8 rounded-lg bg-brand/10 text-brand hover:bg-brand hover:text-white flex items-center justify-center transition-colors shrink-0"
                        title="ส่งสินค้าเข้าแชท"
                      >
                        <Send size={14} />
                      </button>
                    </div>
                  );
                })}
                {/* Pagination — เลขหน้าสวยๆ */}
                <Pagination page={page} totalPages={totalPages} onChange={setPage} />
              </>
            )}
          </div>
        </>
      ) : (
        /* ── Coupon placeholder ── */
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <div className="w-12 h-12 rounded-xl bg-surface-2 flex items-center justify-center mb-3">
            <Ticket size={20} className="text-text-subtle" />
          </div>
          <p className="text-sm font-medium text-text">ระบบคูปอง</p>
          <p className="text-xs text-text-muted mt-1 max-w-[240px]">
            รองรับการส่งคูปองของแพลตฟอร์ม (Shopee/Lazada/TikTok) ให้ลูกค้าในแชท
            <br />
            กำลังอยู่ระหว่างพัฒนา — ยังไม่เชื่อม API จริง
          </p>
        </div>
      )}
    </div>
  );
}

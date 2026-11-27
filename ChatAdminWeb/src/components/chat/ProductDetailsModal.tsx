"use client";
import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Package, ShoppingBag, X } from "lucide-react";
import type { Platform, ProductCard, ProductDetails } from "@/lib/types";

interface Props {
  product: ProductCard;
  platform: Platform;
  onClose: () => void;
}

interface ViewProps {
  product: ProductCard;
  platform: Platform;
  details: ProductDetails | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

function _printable(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return undefined;
  return JSON.stringify(value, null, 2);
}

export function ProductDetailsModal({ product, platform, onClose }: Props) {
  const [details, setDetails] = useState<ProductDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setDetails(null);
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/products/${platform}/${encodeURIComponent(product.item_id)}`);
        const payload = await response.json() as { product?: ProductDetails; detail?: string };
        if (!response.ok || !payload.product) {
          throw new Error(payload.detail || "โหลดรายละเอียดสินค้าไม่สำเร็จ");
        }
        if (!cancelled) setDetails(payload.product);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "โหลดรายละเอียดสินค้าไม่สำเร็จ");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [platform, product.item_id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <ProductDetailsModalView product={product} platform={platform} details={details} loading={loading} error={error} onClose={onClose} />;
}

export function ProductDetailsModalView({ product, platform, details, loading, error, onClose }: ViewProps) {
  const productName = details?.name || details?.item_name || details?.product_name || details?.title || product.name;
  const productShop = details?.shopname || details?.shop_name || product.shop;
  const productPrice = details?.price ?? details?.new_check_price ?? details?.gen_price ?? product.price;
  const productImage = product.image;
  const description = details?.description?.trim()
    || details?.description_info?.extended_description?.field_list
      ?.map((block) => block.text?.trim() || "")
      .filter(Boolean)
      .join("\n")
    || "";
  const brand = typeof details?.brand === "string" ? details.brand : details?.brand?.original_brand_name;
  const rawUrl = product.url ?? (product as ProductCard & { short_link?: string }).short_link;
  const externalUrl = typeof rawUrl === "string" && rawUrl.startsWith("http") ? rawUrl : undefined;
  const externalLabel = platform === "shopee" ? "เปิดใน Shopee" : "เปิดหน้าสินค้า";
  const rows = [
    ["รหัสสินค้า", _printable(details?.item_id ?? details?.itemid ?? product.item_id)],
    ["ร้านค้า", _printable(details?.shopname ?? details?.shop_name ?? product.shop)],
    ["ยี่ห้อ", _printable(brand)],
    ["หมวดหมู่", _printable(details?.cat_name)],
    ["สถานะ", _printable(details?.item_status ?? details?.status)],
    ["คงเหลือ", _printable(details?.total_stock ?? details?.stock)],
    ["รับประกัน", _printable(details?.warranty)],
    ["สภาพสินค้า", _printable(details?.condition)],
    ["น้ำหนัก", _printable(details?.weight)],
    ["ขนาด", _printable(details?.dimension)],
  ].filter((row): row is [string, string] => !!row[1]);
  const models = Array.isArray(details?.model) ? details.model : [];
  const extraData = details?.field_list ?? details?.attribute_list ?? details?.tier_variation;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-2 sm:p-5"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`รายละเอียดสินค้า ${productName}`}
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
          <ShoppingBag size={18} className="shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-text">{productName}</h2>
            {productShop && <p className="truncate text-xs text-text-muted">{productShop}</p>}
          </div>
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={externalLabel}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
            >
              <ExternalLink size={14} />
              <span className="hidden sm:inline">{externalLabel}</span>
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 hover:text-text"
            aria-label="ปิดรายละเอียดสินค้า"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
            <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-lg bg-surface-2">
              {productImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={productImage} alt={productName} className="max-h-64 w-full object-contain" />
              ) : (
                <Package size={32} className="text-text-subtle" />
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-text">{productName}</h3>
              {productPrice > 0 && (
                <div className="mt-2 text-lg font-semibold text-brand">
                  ฿{productPrice.toLocaleString()}
                </div>
              )}
              {productShop && <div className="mt-1 text-sm text-text-muted">ร้าน {productShop}</div>}
            </div>
          </div>

          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" /> กำลังโหลดรายละเอียดสินค้า...
            </div>
          )}
          {error && <p className="mt-5 rounded-lg bg-vibrant-coral/10 p-3 text-sm text-vibrant-coral">{error}</p>}
          {details && (
            <div className="mt-5 space-y-5">
              <section>
                <h3 className="mb-2 text-sm font-semibold text-text">รายละเอียดสินค้า</h3>
                {description ? (
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-muted">{description}</p>
                ) : (
                  <p className="text-sm text-text-subtle">ไม่มีรายละเอียดสินค้า</p>
                )}
              </section>

              {rows.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-text">ข้อมูลสินค้า</h3>
                  <dl className="grid gap-2 rounded-lg bg-surface-2 p-3 sm:grid-cols-2">
                    {rows.map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <dt className="text-[11px] text-text-subtle">{label}</dt>
                        <dd className="whitespace-pre-wrap break-words text-sm text-text">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {models.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-text">ตัวเลือกสินค้า ({models.length})</h3>
                  <div className="space-y-2">
                    {models.map((model, index) => (
                      <div key={String(model.model_id ?? index)} className="rounded-lg border border-border p-3">
                        <div className="text-sm font-medium text-text">{model.model_name || `ตัวเลือก ${index + 1}`}</div>
                        <div className="mt-1 grid gap-x-4 gap-y-1 text-xs text-text-muted sm:grid-cols-2">
                          {model.model_sku && <span>SKU: {model.model_sku}</span>}
                          {model.model_status && <span>สถานะ: {model.model_status}</span>}
                          {model.price_info?.[0]?.current_price != null && <span>ราคา: ฿{model.price_info[0].current_price.toLocaleString()}</span>}
                          {model.stock_info_v2?.summary_info?.total_available_stock != null && (
                            <span>คงเหลือ: {model.stock_info_v2.summary_info.total_available_stock.toLocaleString()}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {extraData != null && (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-text">ข้อมูลคุณสมบัติเพิ่มเติม</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-xs text-text-muted">
                    {_printable(extraData)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

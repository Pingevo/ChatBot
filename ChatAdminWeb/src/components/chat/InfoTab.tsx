"use client";
// InfoTab — แสดงข้อมูล conversation + stats + ประวัติปิดแชท (card ยืด/หด ได้)
import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, User, Store, MessageSquare, Bot, Headset, History, Package, ShoppingCart, ShieldCheck, X } from "lucide-react";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/ConfirmDialog";
import { ZAAPI_COLOR, BOT_COLOR, ADMIN_COLOR } from "@/lib/bubbleColors";
import type { Conversation, ChatMessage, CloseHistoryRecord, ProblemCategory, ProductCard } from "@/lib/types";
import { ProductDetailsModal } from "./ProductDetailsModal";

const CATEGORY_LABELS: Record<ProblemCategory, string> = {
  shipping: "การจัดส่ง",
  product: "สินค้า",
  payment: "การชำระเงิน",
  return_refund: "คืนสินค้า/คืนเงิน",
  warranty: "รับประกัน",
  account: "บัญชี/ล็อกอิน",
  promotion: "โปรโมชั่น/ส่วนลด",
  other: "อื่นๆ",
};

interface Props {
  conversation: Conversation;
  messages: ChatMessage[];
  closeHistory: CloseHistoryRecord[];
  onSuggestProduct?: () => void;
  onCreateTicket?: () => void;
  onSendCode?: () => void;
}

export function InfoTab({ conversation, messages, closeHistory }: Props) {
  const [selectedProduct, setSelectedProduct] = useState<ProductCard | null>(null);
  // คำนวณ stats
  const userMsgs = messages.filter((m) => m.role === "user").length;
  const botMsgs = messages.filter((m) => m.role === "bot").length;
  const adminMsgs = messages.filter((m) => m.role === "admin");

  // นับ admin คนไหนตอบกี่ msg — dedup ตาม admin_id แต่แสดง admin_name
  const adminCounts: Record<string, { name: string; count: number }> = {};
  adminMsgs.forEach((m) => {
    const id = m.admin_id || "unknown";
    const name = m.admin_name || m.admin_id || "unknown";
    if (!adminCounts[id]) adminCounts[id] = { name, count: 0 };
    adminCounts[id].count += 1;
    // อัปเดต name ถ้ายังเป็น id แต่ได้ name มาในภายหลัง
    if (m.admin_name && adminCounts[id].name === id) adminCounts[id].name = m.admin_name;
  });

  const statusLabel = conversation.status === "closed" ? "ปิด" : conversation.status === "handoff" || conversation.status === "open" ? "เปิด" : conversation.status;
  const responsibleLabel = conversation.status === "bot"
    ? "บอท"
    : conversation.assigned_to
      ? (conversation.assigned_to_name || conversation.assigned_to.slice(0, 8))
      : "—";

  // รวมสินค้าที่ถูกเสนอ/แชร์ในแชททั้งหมด — จากทุก message (item card ที่ลูกค้าแชร์ + สินค้าที่ bot/admin แนบ)
  // dedup ตาม item_id เพื่อกันซ้ำ (สินค้าเดียวกันอาจถูกแชร์หลายครั้ง)
  const productsOffered: ProductCard[] = (() => {
    const seen = new Map<string, ProductCard>();
    for (const m of messages) {
      if (!m.products) continue;
      for (const p of m.products) {
        if (p.item_id && !seen.has(p.item_id)) {
          seen.set(p.item_id, p);
        }
      }
    }
    return [...seen.values()];
  })();

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-sm">
      {/* ── ข้อมูลผู้ใช้ ── */}
      <Section title="ผู้ใช้" icon={User}>
        <InfoRow label="User ID" value={conversation.customer_id} mono />
        <InfoRow label="ชื่อ" value={conversation.customer_name} />
      </Section>

      {/* ── ข้อมูลแชท ── */}
      <Section title="แชท" icon={MessageSquare}>
        <InfoRow label="Conversation ID" value={conversation.id} mono />
        <InfoRow
          label="แอดมินรับผิดชอบ"
          value={responsibleLabel}
        />
        <InfoRow label="สถานะแชท" value={statusLabel} badge={conversation.status === "closed" ? "red" : "brand"} />
      </Section>

      {/* ── ข้อมูลร้าน ── */}
      <Section title="ร้านค้า" icon={Store}>
        <div className="flex items-center gap-2 mb-2">
          <PlatformIcon platform={conversation.platform} size={20} />
          <span className="text-text font-medium">{conversation.shop_name}</span>
        </div>
        <InfoRow label="Platform" value={conversation.platform} />
        <InfoRow label="Shop ID" value={conversation.shop_id} mono />
        <InfoRow label="ชื่อร้าน" value={conversation.shop_name} />
      </Section>

      {/* ── สินค้าที่ถูกพูดถึง ── */}
      {conversation.item_ids && conversation.item_ids.length > 0 && (
        <Section title={`สินค้าที่ถูกพูดถึง (${conversation.item_ids.length})`} icon={Store}>
          <div className="flex flex-wrap gap-1.5">
            {conversation.item_ids.map((id) => (
              <span key={id} className="text-xs px-2 py-1 rounded bg-surface-2 text-text-muted font-mono">
                {id}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* ── สินค้าที่ถูกเสนอในแชท ── */}
      {productsOffered.length > 0 && (
        <Section title={`สินค้าที่ถูกเสนอในแชท (${productsOffered.length})`} icon={Package}>
          <div className="space-y-1.5">
            {productsOffered.map((p, idx) => {
              return (
                <button
                  key={`${p.item_id}-${idx}`}
                  type="button"
                  onClick={() => setSelectedProduct(p)}
                  aria-label={`ดูข้อมูลสินค้า ${p.name}`}
                  className="flex w-full items-center gap-2 rounded-md bg-surface-2 p-1.5 text-left transition-colors hover:bg-pale-sky-soft"
                >
                  {p.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image} alt={p.name} className="w-9 h-9 rounded object-cover shrink-0" loading="lazy" />
                  ) : (
                    <div className="w-9 h-9 rounded bg-surface shrink-0 flex items-center justify-center">
                      <Package size={14} className="text-text-subtle" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-text truncate">{p.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {p.price > 0 && (
                        <span className="text-[10px] text-brand font-medium">฿{p.price.toLocaleString()}</span>
                      )}
                      {p.shop && (
                        <span className="text-[10px] text-text-muted truncate">{p.shop}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Statistics ── */}
      <Section title="สถิติการสนทนา" icon={MessageSquare}>
        <div className="space-y-2">
          <StatRow icon={<User size={12} />} label="user" count={userMsgs} tone="coral" />
          <StatRow icon={<Bot size={12} />} label="bot" count={botMsgs} tone="brand" />
          {Object.entries(adminCounts).map(([id, { name, count }]) => (
            <StatRow key={id} icon={<Headset size={12} />} label={`admin: ${name}`} count={count} tone="neutral" />
          ))}
          <div className="pt-2 border-t border-border text-xs text-text-muted">
            รวมทั้งหมด {messages.length} ข้อความ
          </div>
        </div>

        {/* ⚡ Legend สี role — ย้ายมาจาก botworker topbar */}
        <div className="mt-3 pt-2 border-t border-border">
          <div className="text-[10px] text-text-muted mb-1.5 font-medium uppercase tracking-wide">สีบอทบู</div>
          <div className="flex items-center gap-3 text-[10px] text-text-muted flex-wrap">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-surface-2 border border-border" />
              <span>user</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: ZAAPI_COLOR }} />
              <span>zaapi</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: ADMIN_COLOR }} />
              <span>admin</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: BOT_COLOR }} />
              <span>bot</span>
            </div>
          </div>
        </div>
      </Section>

      {/* ── เคลม/ประกัน — explicit admin claim outcome (Phase 2B.6) ── */}
      {/* key = conversation+episode identity → remount reset busy/applied/error
          เมื่อเปลี่ยน conversation หรือ episode (ห้าม state รั่วข้าม identity) */}
      <ClaimSection
        key={`${conversation.id}|${conversation.active_claim_episode_id ?? "-"}`}
        conversation={conversation}
      />

      {/* ── ประวัติปิดแชท (card ยืด/หด ได้) ── */}
      {/* ── ประวัติคำสั่งซื้อ ── */}
      <OrderHistorySection conversationId={conversation.id} platform={conversation.platform} />

      <CloseHistoryCards history={closeHistory} />
      {selectedProduct && (
        <ProductDetailsModal
          product={selectedProduct}
          platform={conversation.platform}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}

/* ---------- Claim Section (explicit admin outcome — Phase 2B.6) ---------- */

function ClaimSection({ conversation }: { conversation: Conversation }) {
  const [busy, setBusy] = useState<"resolved" | "cancelled" | null>(null);
  const [applied, setApplied] = useState<"resolved" | "cancelled" | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const episodeId = conversation.active_claim_episode_id;
  const outcome = applied
    ? { outcome: applied }
    : conversation.claim_outcome;
  const open = !!episodeId && !outcome;
  const info = conversation.bot_claim_info;

  // section แสดงเฉพาะเมื่อมี episode เปิดอยู่ หรือ outcome/info ที่ transport มาแล้ว
  if (!episodeId && !conversation.claim_outcome && !info) return null;

  async function submit(o: "resolved" | "cancelled") {
    if (!episodeId || busy) return; // repeated-click guard
    const ok = await confirm.ask({
      title: o === "resolved" ? "ปิดเคลมนี้?" : "ยกเลิกเคลมนี้?",
      message: "คำสั่งผูกกับ claim episode นี้เท่านั้น — ไม่ใช่การปิดแชท (แชทปิดแยกต่างหาก)",
      confirmText: o === "resolved" ? "ปิดเคลม" : "ยกเลิกเคลม",
      variant: o === "cancelled" ? "danger" : "primary",
    });
    if (!ok) return;
    setBusy(o);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/admin/conversations/${encodeURIComponent(conversation.id)}/claim-outcome`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ episode_id: episodeId, outcome: o }),
        }
      );
      const body = await res.json().catch(() => null);
      if (res.ok && (body?.result === "applied" || body?.result === "already_applied")) {
        // ⚡ authoritative persisted outcome เท่านั้น — conflicting retry
        //   (เช่นกด cancelled แต่ episode จบ resolved ไปแล้ว) ต้องแสดง terminal จริง
        const persisted = body?.claim_outcome?.outcome;
        if (persisted === "resolved" || persisted === "cancelled") {
          setApplied(persisted);
        } else {
          setErrorMsg("ผลลัพธ์จาก server ไม่สมบูรณ์ — รีเฟรชเพื่อดูสถานะจริง");
        }
      } else {
        setErrorMsg(
          body?.result === "stale_episode"
            ? "claim episode เปลี่ยนไปแล้ว — รีเฟรชแชทอีกครั้ง"
            : body?.result === "no_active_claim"
              ? "ไม่มี claim ที่เปิดอยู่สำหรับ episode นี้"
              : body?.error || `สั่งไม่สำเร็จ (HTTP ${res.status})`
        );
      }
    } catch {
      setErrorMsg("เชื่อมต่อไม่ได้ — ลองใหม่อีกครั้ง");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="เคลม/ประกัน" icon={ShieldCheck}>
      {episodeId && <InfoRow label="Claim Episode" value={episodeId} mono />}
      {info?.customer_name && <InfoRow label="ชื่อลูกค้า" value={info.customer_name} />}
      {info?.customer_phone && <InfoRow label="เบอร์" value={info.customer_phone} mono />}
      {info?.customer_order_id && <InfoRow label="ออเดอร์" value={info.customer_order_id} mono />}
      {info?.purchase_date && <InfoRow label="วันที่ซื้อ" value={info.purchase_date} />}
      {outcome && (
        <InfoRow
          label="ผลเคลม"
          value={outcome.outcome === "resolved" ? "ปิดเคลมแล้ว" : "ยกเลิกเคลมแล้ว"}
          badge={outcome.outcome === "resolved" ? "brand" : "red"}
        />
      )}
      {open && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="primary" disabled={!!busy} onClick={() => submit("resolved")}>
            {busy === "resolved" ? "กำลังสั่ง…" : "ปิดเคลม"}
          </Button>
          <Button size="sm" variant="danger" disabled={!!busy} onClick={() => submit("cancelled")}>
            {busy === "cancelled" ? "กำลังสั่ง…" : "ยกเลิกเคลม"}
          </Button>
        </div>
      )}
      {errorMsg && <p className="text-xs text-vibrant-coral">{errorMsg}</p>}
    </Section>
  );
}

/* ---------- Order History Section ---------- */

interface OrderItem {
  name: string;
  model_name: string;
  quantity: number;
  price?: number;
  image_url?: string;
  sku?: string;
  item_id?: string;
  model_id?: string;
}
interface OrderPackageRecord {
  shipping_carrier: string;
  logistics_status: string;
  tracking_numbers: string[];
  tracking_info?: unknown;
}
interface OrderRecord {
  order_sn: string;
  order_status: string;
  order_status_raw: string;
  logistics_status?: string;
  create_time: string;
  create_time_raw?: number;
  shopname: string;
  shipping_carrier: string;
  checkout_shipping_carrier?: string;
  tracking_info?: unknown;
  packages?: OrderPackageRecord[];
  tracking_no?: string;
  tracking_numbers?: string[];
  items: OrderItem[];
  item_count: number;
  total_quantity: number;
  total_amount?: number;
  currency?: string;
  buyer_username?: string;
  payment_method?: string;
}

function _formatTrackingValue(value: unknown, fieldName?: string): string {
  if (value === null || value === undefined || value === "") return "";
  if (fieldName === "update_time") {
    const timestamp = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : null;
    if (date && !Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("th-TH", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Bangkok",
      }).format(date);
    }
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return _formatTrackingValue(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => _formatTrackingValue(item)).filter(Boolean).join(" · ");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => {
        const formatted = _formatTrackingValue(item, key);
        return formatted ? `${key.replaceAll("_", " ")}: ${formatted}` : "";
      })
      .filter(Boolean)
      .join(" · ");
  }
  return String(value);
}

function TrackingTimeline({ value }: { value: unknown }) {
  let timelineValue = value;
  if (typeof timelineValue === "string") {
    try {
      timelineValue = JSON.parse(timelineValue);
    } catch {
      // Keep plain-text tracking details as a single timeline entry.
    }
  }
  const events = (Array.isArray(timelineValue)
    ? timelineValue
    : timelineValue === null || timelineValue === undefined || timelineValue === ""
      ? []
      : [timelineValue]
  ).filter((event) => _formatTrackingValue(event) !== "");

  if (!events.length) return null;

  return (
    <ol aria-label="ประวัติการติดตาม" className="space-y-0">
      {events.map((event, index) => {
        const record = event && typeof event === "object" && !Array.isArray(event)
          ? event as Record<string, unknown>
          : null;
        const fields = record ? Object.entries(record) : [];
        const time = _formatTrackingValue(record?.update_time, "update_time");
        const description = _formatTrackingValue(record?.description, "description");
        const status = _formatTrackingValue(record?.logistics_status, "logistics_status");
        const details = fields.filter(([key]) => key !== "update_time" && key !== "description" && key !== "logistics_status");
        const fallback = record ? "" : _formatTrackingValue(event);

        return (
          <li key={index} className="relative grid grid-cols-[12px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
            {index < events.length - 1 && (
              <span aria-hidden="true" className="absolute bottom-[-12px] left-[6px] top-3 w-px bg-border" />
            )}
            <span aria-hidden="true" className="relative z-10 mt-1.5 h-3 w-3 rounded-full border-2 border-brand bg-surface" />
            <div className="min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
              {(time || status) && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {time && (
                    <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                      <History size={12} aria-hidden="true" />
                      <span>อัปเดตเมื่อ</span>
                      <time className="font-medium tabular-nums text-text">{time}</time>
                    </div>
                  )}
                  {status && (
                    <span className="inline-flex rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-brand">
                      {status}
                    </span>
                  )}
                </div>
              )}
              {description && <p className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-text ${(time || status) ? "mt-2" : ""}`}>{description}</p>}
              {fallback && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text">{fallback}</p>}
              {details.length > 0 && (
                <dl className={`space-y-1.5 ${time || description || status ? "mt-2 border-t border-border/60 pt-2" : ""}`}>
                  {details.map(([key, item]) => {
                    const formatted = _formatTrackingValue(item, key);
                    if (!formatted) return null;
                    return (
                      <div key={key}>
                        <dt className="text-[10px] font-medium text-text-subtle">{key.replaceAll("_", " ")}</dt>
                        <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-text">{formatted}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function OrderHistorySection({ conversationId, platform }: { conversationId: string; platform: Conversation["platform"] }) {
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // ⚡ Phase 1C — collapsible per-order card
  const [openOrders, setOpenOrders] = useState<Set<string>>(new Set());
  const [previewOrderId, setPreviewOrderId] = useState<string | null>(null);

  useEffect(() => {
    if (!previewOrderId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewOrderId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewOrderId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/conversations/${encodeURIComponent(conversationId)}/orders`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setOrders(data.orders || []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message || "โหลดไม่ได้");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [conversationId]);

  const shown = expanded ? orders : orders.slice(0, 5);
  const previewOrder = previewOrderId ? orders.find((order) => order.order_sn === previewOrderId) : undefined;

  const toggleOrder = (sn: string) => {
    setOpenOrders((prev) => {
      const next = new Set(prev);
      if (next.has(sn)) next.delete(sn);
      else next.add(sn);
      return next;
    });
  };

  return (
    <div className="rounded-xl border border-border bg-surface p-3.5 space-y-2">
      <div className="flex items-center gap-2 text-text-muted">
        <ShoppingCart size={14} />
        <h3 className="text-xs font-semibold uppercase tracking-wide">
          ประวัติคำสั่งซื้อ {orders.length > 0 && `(${orders.length})`}
        </h3>
      </div>

      {loading && (
        <p className="text-xs text-text-subtle">กำลังโหลด…</p>
      )}

      {error && (
        <p className="text-xs text-vibrant-coral">โหลดไม่ได้: {error}</p>
      )}

      {!loading && !error && orders.length === 0 && (
        <p className="text-xs text-text-subtle">ยังไม่มีประวัติการสั่งซื้อ</p>
      )}

      {!loading && !error && orders.length > 0 && (
        <>
          <div className="space-y-2">
            {shown.map((o) => {
              const isOpen = openOrders.has(o.order_sn);
              return (
                <div key={o.order_sn} className="rounded-lg bg-surface-2 p-2 space-y-1.5">
                  {/* Header row — click to expand */}
                  <button
                    onClick={() => toggleOrder(o.order_sn)}
                    className="w-full flex items-center justify-between gap-2 text-left"
                  >
                    <span className="text-[11px] font-mono text-text-muted truncate">{o.order_sn}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        o.order_status_raw === "COMPLETED" ? "bg-green-100 text-green-700" :
                        o.order_status_raw === "CANCELLED" ? "bg-red-100 text-red-700" :
                        o.order_status_raw === "SHIPPED" || o.order_status_raw === "TO_CONFIRM_RECEIVE" ? "bg-info/10 text-info-dark" :
                        "bg-surface text-text-muted"
                      }`}>
                        {o.order_status}
                      </span>
                      <span className="text-[10px] text-text-subtle">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </button>
                  {/* Summary row — always visible */}
                  <div className="text-[11px] text-text-muted">
                    {o.create_time} · {o.shipping_carrier || "ไม่ระบุขนส่ง"} · {o.shopname}
                  </div>
                  {/* Items preview — always visible (first 2) */}
                  {o.items.length > 0 && !isOpen && (
                    <div className="text-[11px] text-text space-y-0.5">
                      {o.items.slice(0, 2).map((i, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => platform === "shopee" && setPreviewOrderId(o.order_sn)}
                          disabled={platform !== "shopee"}
                          className="flex w-full items-center gap-1.5 truncate rounded-md px-1 text-left hover:bg-surface disabled:cursor-default disabled:hover:bg-transparent"
                          title={platform === "shopee" ? "ดูรายละเอียดออเดอร์" : undefined}
                        >
                          {i.image_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={i.image_url} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
                          )}
                          <span className="truncate">
                            {i.name} {i.quantity > 1 && `×${i.quantity}`}
                          </span>
                        </button>
                      ))}
                      {o.items.length > 2 && (
                        <div className="text-text-subtle">+{o.items.length - 2} รายการ (กดเปิดดู)</div>
                      )}
                    </div>
                  )}
                  {/* Expanded details */}
                  {isOpen && (
                    <div className="pt-1.5 border-t border-border/40 space-y-1.5">
                      {/* All items with image + price + variant */}
                      {o.items.length > 0 && (
                        <div className="space-y-1.5">
                          {o.items.map((i, idx) => (
                            <div
                              key={idx}
                              role={platform === "shopee" ? "button" : undefined}
                              tabIndex={platform === "shopee" ? 0 : undefined}
                              onClick={() => { if (platform === "shopee") setPreviewOrderId(o.order_sn); }}
                              onKeyDown={(event) => {
                                if (platform === "shopee" && (event.key === "Enter" || event.key === " ")) {
                                  event.preventDefault();
                                  setPreviewOrderId(o.order_sn);
                                }
                              }}
                              aria-label={platform === "shopee" ? `ดูรายละเอียดออเดอร์ ${o.order_sn}: ${i.name}` : undefined}
                              className={`flex w-full items-start gap-2 rounded-md p-1 text-left ${platform === "shopee" ? "cursor-pointer hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" : ""}`}
                            >
                              {i.image_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={i.image_url} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
                              ) : (
                                <div className="w-12 h-12 rounded bg-surface shrink-0 flex items-center justify-center text-[10px] text-text-subtle">ไม่มีรูป</div>
                              )}
                              <div className="flex-1 min-w-0 space-y-0.5">
                                <div className="text-[11px] text-text leading-tight">{i.name}</div>
                                {i.model_name && i.model_name !== i.name && (
                                  <div className="text-[10px] text-text-muted">รุ่น: {i.model_name}</div>
                                )}
                                <div className="flex items-center gap-2 text-[10px] text-text-muted">
                                  <span>×{i.quantity}</span>
                                  {i.price ? <span>฿{i.price.toLocaleString()}</span> : null}
                                  {i.sku && <span className="truncate">SKU: {i.sku}</span>}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Order meta */}
                      <div className="pt-1 border-t border-border/40 text-[10px] text-text-muted space-y-0.5">
                        {o.total_amount ? (
                          <div>ยอดรวม: ฿{(o.total_amount || 0).toLocaleString()} {o.currency || "THB"}</div>
                        ) : null}
                        {o.tracking_no && (
                          <div>เลขพัสดุ: <span className="font-mono">{o.tracking_numbers?.length && o.tracking_numbers.length > 1 ? o.tracking_numbers.join(", ") : o.tracking_no}</span></div>
                        )}
                        {o.logistics_status && (
                          <div>สถานะขนส่ง: {o.logistics_status}</div>
                        )}
                        {o.payment_method && (
                          <div>ชำระเงิน: {o.payment_method}</div>
                        )}
                        {o.buyer_username && (
                          <div>ผู้ซื้อ: {o.buyer_username}</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {orders.length > 5 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-full text-xs text-brand hover:underline py-1"
            >
              {expanded ? "ย่อ" : `ดูทั้งหมด (${orders.length})`}
            </button>
          )}
        </>
      )}
      {previewOrder && platform === "shopee" && (
        <OrderDetailsPanel order={previewOrder} onClose={() => setPreviewOrderId(null)} />
      )}
    </div>
  );
}

export function OrderDetailsPanel({ order, onClose }: { order: OrderRecord; onClose: () => void }) {
  const trackingNumbers = order.tracking_numbers?.length ? order.tracking_numbers : order.tracking_no ? [order.tracking_no] : [];
  const packages = order.packages?.length
    ? order.packages
    : [{ shipping_carrier: order.shipping_carrier || "", logistics_status: order.logistics_status || "", tracking_numbers: trackingNumbers }];
  const packageTrackingNumbers = new Set(packages.flatMap((pkg) => pkg.tracking_numbers));
  const orderLevelTrackingNumbers = trackingNumbers.filter((trackingNumber) => !packageTrackingNumbers.has(trackingNumber));

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-3 sm:p-6"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`รายละเอียดคำสั่งซื้อ ${order.order_sn}`}
        className="flex max-h-[min(88dvh,820px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Package size={18} className="shrink-0 text-brand" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-text">ข้อมูลการจัดส่ง</h2>
              <p className="truncate font-mono text-xs text-text-muted">{order.order_sn}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-surface-2 hover:text-text"
            aria-label="ปิดรายละเอียดคำสั่งซื้อ"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <section className="rounded-xl border border-border bg-surface-2 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-[11px] text-text-muted">วิธีการจัดส่ง</div>
                <div className="mt-1 text-sm font-medium text-text">{order.checkout_shipping_carrier || "ไม่ระบุ"}</div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted">สถานะคำสั่งซื้อ</div>
                <div className="mt-1 text-sm font-medium text-text">{order.order_status || "—"}</div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted">วันที่สั่งซื้อ</div>
                <div className="mt-1 text-sm text-text">{order.create_time || "—"}</div>
              </div>
              {order.total_amount ? (
                <div>
                  <div className="text-[11px] text-text-muted">ยอดรวม</div>
                  <div className="mt-1 text-sm text-text">฿{order.total_amount.toLocaleString()} {order.currency || "THB"}</div>
                </div>
              ) : null}
            </div>
          </section>

          {order.items.length > 0 && (
            <section className="rounded-xl border border-border p-3">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-text">สินค้าในออเดอร์</h3>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted">{order.items.length} รายการ</span>
              </div>
              <div className="space-y-2">
                {order.items.map((item, index) => (
                  <article key={`${item.item_id || item.name}-${index}`} aria-label={item.name} className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-2.5">
                    {item.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.image_url} alt={item.name} className="h-16 w-16 shrink-0 rounded-lg bg-surface object-cover" />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-surface text-text-subtle" aria-hidden="true">
                        <Package size={20} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium leading-snug text-text">{item.name}</p>
                      {item.model_name && item.model_name !== item.name && (
                        <p className="mt-0.5 truncate text-[11px] text-text-muted">ตัวเลือก: {item.model_name}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        {item.price != null && item.price > 0 ? (
                          <span className="text-sm font-semibold text-brand">฿{item.price.toLocaleString("th-TH")}</span>
                        ) : <span />}
                        <span className="rounded-full bg-surface px-2 py-1 text-[10px] font-medium text-text-muted">จำนวน ×{item.quantity}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className="rounded-xl border border-border p-3">
            <h3 className="mb-2 text-xs font-semibold text-text">สถานะพัสดุและ Tracking</h3>
            <div className="space-y-2">
              {orderLevelTrackingNumbers.length > 0 && (
                <div className="rounded-lg bg-surface-2 p-3">
                  <div className="text-xs text-text-muted">เลขพัสดุ</div>
                  <div className="mt-1 space-y-1">
                    {orderLevelTrackingNumbers.map((trackingNumber) => (
                      <div key={trackingNumber} className="font-mono text-xs text-text">{trackingNumber}</div>
                    ))}
                  </div>
                </div>
              )}
              {_formatTrackingValue(order.tracking_info) && (
                <div className="rounded-lg bg-surface-2 p-3">
                  <div className="mb-1 text-xs text-text-muted">ข้อมูลติดตาม</div>
                  <TrackingTimeline value={order.tracking_info} />
                </div>
              )}
              {packages.map((pkg, index) => (
                <div key={`${order.order_sn}-${index}`} className="rounded-lg bg-surface-2 p-3">
                  {packages.length > 1 && <div className="mb-1 text-[10px] font-medium text-text-subtle">พัสดุ {index + 1}</div>}
                  {pkg.shipping_carrier && <div className="text-xs text-text-muted">ขนส่ง: <span className="text-text">{pkg.shipping_carrier}</span></div>}
                  <div className="text-xs text-text-muted">สถานะ: <span className="text-text">{pkg.logistics_status || "ยังไม่มีสถานะ"}</span></div>
                  {_formatTrackingValue(pkg.tracking_info) && (
                    <div className="mt-2">
                      <div className="mb-1 text-xs text-text-muted">ข้อมูลติดตามพัสดุ</div>
                      <TrackingTimeline value={pkg.tracking_info} />
                    </div>
                  )}
                  <div className="mt-1 text-xs text-text-muted">เลขพัสดุ:</div>
                  {pkg.tracking_numbers.length > 0 ? (
                    <div className="mt-1 space-y-1">
                      {pkg.tracking_numbers.map((trackingNumber) => (
                        <div key={trackingNumber} className="font-mono text-xs text-text">{trackingNumber}</div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-text-subtle">
                      {orderLevelTrackingNumbers.length > 0 ? "เลขพัสดุแสดงไว้ระดับคำสั่งซื้อด้านบน" : "ยังไม่มีเลขพัสดุ"}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

/* ---------- Sub components ---------- */

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5 space-y-2">
      <div className="flex items-center gap-2 text-text-muted">
        <Icon size={14} />
        <h3 className="text-xs font-semibold uppercase tracking-wide">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono, badge }: { label: string; value: string; mono?: boolean; badge?: "brand" | "red" | "neutral" }) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="text-text-muted shrink-0">{label}</span>
      {badge ? (
        <Badge tone={badge}>{value}</Badge>
      ) : (
        <span className={`text-text text-right break-all ${mono ? "font-mono text-[11px]" : ""}`}>
          {value || "—"}
        </span>
      )}
    </div>
  );
}

function StatRow({ icon, label, count, tone }: { icon: React.ReactNode; label: string; count: number; tone: "coral" | "brand" | "neutral" }) {
  const toneClass = tone === "coral" ? "text-vibrant-coral" : tone === "brand" ? "text-brand" : "text-text-muted";
  return (
    <div className="flex items-center justify-between text-xs">
      <span className={`flex items-center gap-1.5 ${toneClass}`}>
        {icon}
        {label}
      </span>
      <span className="font-semibold text-text">{count}</span>
    </div>
  );
}

/* ---------- Close History Cards (ยืด/หด ได้) ---------- */

function CloseHistoryCards({ history }: { history: CloseHistoryRecord[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (history.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-2 text-text-muted mb-1">
          <History size={14} />
          <h3 className="text-xs font-semibold uppercase tracking-wide">ประวัติปิดแชท</h3>
        </div>
        <p className="text-xs text-text-subtle">ยังไม่มีประวัติ</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-text-muted px-1">
        <History size={14} />
        <h3 className="text-xs font-semibold uppercase tracking-wide">
          ประวัติปิดแชท ({history.length})
        </h3>
      </div>
      {history.map((rec) => {
        const expanded = expandedIds.has(rec.record_id);
        const isReopened = !!rec.reopened_at;
        return (
          <div key={rec.record_id} className="rounded-lg border border-border bg-surface overflow-hidden">
            <button
              onClick={() => toggle(rec.record_id)}
              className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-surface-2/50 transition-colors"
            >
              <div className="flex items-center gap-2 text-left">
                {expanded ? <ChevronDown size={14} className="text-text-muted shrink-0" /> : <ChevronRight size={14} className="text-text-muted shrink-0" />}
                <div>
                  <div className="text-xs font-medium text-text">
                    ครั้งที่ {rec.sequence} · {CATEGORY_LABELS[rec.category] || rec.category}
                  </div>
                  <div className="text-[11px] text-text-subtle">
                    {new Date(rec.closed_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                  </div>
                </div>
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${isReopened ? "bg-brand/10 text-brand" : "bg-surface-2 text-text-muted"}`}>
                {isReopened ? "เปิดใหม่แล้ว" : "ปิดแล้ว"}
              </span>
            </button>
            {expanded && (
              <div className="px-3 pb-3 space-y-2 border-t border-border/60 pt-2">
                <DetailField label="เหตุผล" value={rec.reason} />
                <DetailField label="วิธีการแก้ไข" value={rec.resolution} />
                {rec.note && <DetailField label="หมายเหตุ" value={rec.note} muted />}
                {isReopened && (
                  <div className="pt-2 border-t border-border/40 text-[11px] text-text-muted">
                    เปิดใหม่โดย {rec.reopened_by === "bot" ? "บอท" : rec.reopened_by}
                    {" · "}
                    {new Date(rec.reopened_at!).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                    {rec.reopen_reason && <div className="mt-0.5">{rec.reopen_reason}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DetailField({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-text-muted mb-0.5">{label}</div>
      <div className={`text-xs ${muted ? "text-text-muted italic" : "text-text"}`}>{value}</div>
    </div>
  );
}

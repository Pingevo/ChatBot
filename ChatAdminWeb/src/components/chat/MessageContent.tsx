// MessageContent — render rich media content ของ ChatMessage
// รองรับ: text, image, video, image_with_text, item (product card), variation_card,
//         order, sticker, notification, table
// ใช้ใน ChatWindow, TicketChatPanel, Shadow Inbox
"use client";
import { useState } from "react";
import { Package, ShoppingBag, Image as ImageIcon, Video, Sticker, Bell } from "lucide-react";
import type { ChatMessage, ProductCard } from "@/lib/types";

interface Props {
  msg: ChatMessage;
  /** "user" = ลูกค้าส่งเข้า (bubble ซ้าย, สีอ่อน) | "out" = ร้าน/bot ตอบ (bubble ขวา, สีเข้ม) */
  variant: "user" | "out";
}

export function MessageContent({ msg, variant }: Props) {
  const isUser = variant === "user";
  const bubbleText = isUser ? "text-text" : "text-white";
  const subBg = isUser ? "bg-surface-2" : "bg-white/10";

  // ── notification → system-style ──
  if (msg.message_type === "notification" || msg.notification_text) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Bell size={11} className="text-text-muted" />
        <span className="text-text-muted">{msg.notification_text || msg.text}</span>
      </div>
    );
  }

  // ── sticker ──
  if (msg.message_type === "sticker") {
    return (
      <div className={`flex items-center gap-1.5 ${bubbleText}`}>
        <Sticker size={16} />
        <span className="text-sm">{msg.text}</span>
      </div>
    );
  }

  // ── order card ──
  if (msg.message_type === "order" && msg.order_sn) {
    return (
      <div className={`flex items-center gap-2 rounded-lg ${subBg} p-2.5 ${bubbleText}`}>
        <ShoppingBag size={18} className={isUser ? "text-brand" : "text-white/80"} />
        <div>
          <div className="text-xs opacity-70">คำสั่งซื้อ</div>
          <div className="font-mono text-sm font-medium">{msg.order_sn}</div>
        </div>
      </div>
    );
  }

  // ── image ──
  if (msg.message_type === "image" && msg.media?.url) {
    return (
      <div className="space-y-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={msg.media.url}
          alt={msg.text || "รูปภาพ"}
          className="rounded-lg max-w-[240px] max-h-[240px] object-cover cursor-pointer"
          loading="lazy"
        />
        {msg.text && msg.text !== "(รูปภาพ)" && (
          <div className={`text-xs ${bubbleText} opacity-80`}>{msg.text}</div>
        )}
      </div>
    );
  }

  // ── video ──
  if (msg.message_type === "video" && msg.media?.url) {
    return (
      <div className="space-y-1">
        <video
          src={msg.media.url}
          poster={msg.media.thumb_url}
          controls
          className="rounded-lg max-w-[240px] max-h-[240px]"
        />
        {msg.text && msg.text !== "(วิดีโอ)" && (
          <div className={`text-xs ${bubbleText} opacity-80`}>{msg.text}</div>
        )}
      </div>
    );
  }

  // ── image_with_text ──
  if (msg.message_type === "image_with_text" && msg.media?.url) {
    return (
      <div className="space-y-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={msg.media.url}
          alt={msg.text || "รูปภาพ"}
          className="rounded-lg max-w-[240px] max-h-[240px] object-cover"
          loading="lazy"
        />
        {msg.text && (
          <div className={`text-sm ${bubbleText}`}>{msg.text}</div>
        )}
      </div>
    );
  }

  // ── item / variation_card → product card ──
  if ((msg.message_type === "item" || msg.message_type === "variation_card") && msg.products && msg.products.length > 0) {
    return (
      <div className="space-y-1.5">
        {msg.text && msg.text !== "(สินค้า)" && msg.text !== "(สินค้าพร้อมตัวเลือก)" && (
          <div className={`text-sm ${bubbleText}`}>{msg.text}</div>
        )}
        {msg.products.map((p) => (
          <ProductCardView key={p.item_id} product={p} variant={variant} />
        ))}
        {msg.table && <TableView table={msg.table} variant={variant} />}
      </div>
    );
  }

  // ── fallback: text + product cards (กรณี bot/admin ตอบพร้อม product) ──
  return (
    <div className="space-y-1.5">
      {msg.text && <div className={bubbleText}>{msg.text}</div>}
      {msg.products && msg.products.length > 0 && (
        <div className="space-y-1.5">
          {msg.products.map((p) => (
            <ProductCardView key={p.item_id} product={p} variant={variant} />
          ))}
        </div>
      )}
      {msg.table && <TableView table={msg.table} variant={variant} />}
    </div>
  );
}

// ─── Product card ──────────────────────────────────────────
function ProductCardView({ product, variant }: { product: ProductCard; variant: "user" | "out" }) {
  const isUser = variant === "user";
  // กัน url เป็น object หรือค่าผิดประเภท — ต้องเป็น string URL เท่านั้น
  const safeUrl = typeof product.url === "string" && product.url.startsWith("http") ? product.url : undefined;
  const CardTag = safeUrl ? "a" : "div";
  return (
    <CardTag
      {...(safeUrl ? { href: safeUrl, target: "_blank", rel: "noopener noreferrer" } : {})}
      className={`flex items-center gap-2.5 rounded-lg p-2 transition-colors ${
        isUser ? "bg-surface-2 hover:bg-pale-sky-soft" : "bg-white/10 hover:bg-white/15"
      }`}
    >
      {product.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={product.image}
          alt={product.name}
          className="w-14 h-14 rounded object-cover shrink-0"
          loading="lazy"
        />
      ) : (
        <div className={`w-14 h-14 rounded flex items-center justify-center shrink-0 ${
          isUser ? "bg-surface" : "bg-white/10"
        }`}>
          <Package size={20} className={isUser ? "text-text-subtle" : "text-white/60"} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm font-medium ${isUser ? "text-text" : "text-white"}`}>
          {product.name}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {product.price > 0 && (
            <span className={`text-xs font-medium ${isUser ? "text-brand" : "text-white/90"}`}>
              ฿{product.price.toLocaleString()}
            </span>
          )}
          {product.shop && (
            <span className={`text-[10px] truncate ${isUser ? "text-text-muted" : "text-white/60"}`}>
              {product.shop}
            </span>
          )}
        </div>
      </div>
    </CardTag>
  );
}

// ─── Table view (structured content) ───────────────────────
function TableView({ table, variant }: { table: NonNullable<ChatMessage["table"]>; variant: "user" | "out" }) {
  const isUser = variant === "user";
  return (
    <div className={`rounded-lg overflow-x-auto max-w-full text-[11px] ${isUser ? "bg-surface-2" : "bg-white/10"}`}>
      <table className="w-full max-w-full table-fixed">
        <thead>
          <tr className={isUser ? "bg-surface" : "bg-white/10"}>
            {table.headers.map((h, i) => (
              <th key={i} className={`text-left px-2 py-1 font-medium whitespace-nowrap overflow-hidden text-ellipsis ${isUser ? "text-text-muted" : "text-white/80"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri} className="border-t border-white/5">
              {row.map((cell, ci) => (
                <td key={ci} className={`px-2 py-1 break-words ${isUser ? "text-text" : "text-white/90"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

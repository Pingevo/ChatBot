// MessageContent — render rich media content ของ ChatMessage
// รองรับ: text, image, video, image_with_text, item (product card), variation_card,
//         order, sticker, notification, table
// ใช้ใน ChatWindow, TicketChatPanel, Shadow Inbox
"use client";
import { useState, type ReactNode } from "react";
import { Package, ShoppingBag, Image as ImageIcon, Video, Sticker, Bell, Headset } from "lucide-react";
import { imageViewer } from "@/components/ui/ImageViewer";
import type { ChatMessage, ProductCard } from "@/lib/types";

// ─── Markdown inline parser (image + link + bold) ─────────────
// แปลง ![alt](url), [text](url), **bold** ในข้อความเป็น React elements
// รองรับหลายรูป/link ในข้อความเดียว + text รอบๆ
function renderMarkdownInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // pattern (เรียงตาม priority): ![alt](url) | [text](url) | **bold**
  const pattern = /(!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\))|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*(.+?)\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    // text ก่อน match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined && match[3]) {
      // ![alt](url) → <img> (click to zoom)
      nodes.push(
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`img-${key++}`}
          src={match[3]}
          alt={match[2] || "รูปภาพ"}
          className="rounded-lg max-w-[200px] max-h-[200px] object-cover my-1 cursor-pointer hover:opacity-80 transition-opacity"
          loading="lazy"
          onClick={() => imageViewer.show(match![3], { type: "image", alt: match![2] || "รูปภาพ" })}
        />
      );
    } else if (match[5] && match[6]) {
      // [text](url) → <a>
      nodes.push(
        <a
          key={`a-${key++}`}
          href={match[6]}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:opacity-80"
        >
          {match[5]}
        </a>
      );
    } else if (match[8]) {
      // **bold** → <strong>
      nodes.push(<strong key={`b-${key++}`}>{match[8]}</strong>);
    }
    lastIndex = match.index + match[0].length;
  }
  // text หลัง match สุดท้าย
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : [text];
}

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

  // ── faq_liveagent → system-style (โอนไปเจ้าหน้าที่) ──
  if (msg.message_type === "faq_liveagent") {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Headset size={11} className="text-amber-400" />
        <span className="text-amber-400/90">{msg.text || "โอนไปยังเจ้าหน้าที่"}</span>
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
  if (msg.message_type === "image") {
    if (msg.media?.url) {
      return (
        <div className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={msg.media.url}
            alt={msg.text || "รูปภาพ"}
            className="rounded-lg max-w-[240px] max-h-[240px] object-cover cursor-pointer hover:opacity-80 transition-opacity"
            loading="lazy"
            onClick={() => imageViewer.show(msg.media!.url!, { type: "image", alt: msg.text || "รูปภาพ" })}
          />
          {msg.text && msg.text !== "(รูปภาพ)" && (
            <div className={`text-xs ${bubbleText} opacity-80`}>{renderMarkdownInline(msg.text)}</div>
          )}
        </div>
      );
    }
    // image แต่ไม่มี url → แสดง placeholder
    return (
      <div className={`flex items-center gap-1.5 ${bubbleText}`}>
        <ImageIcon size={16} className={isUser ? "text-text-muted" : "text-white/60"} />
        <span className="text-sm opacity-80">{msg.text && msg.text !== "(รูปภาพ)" ? msg.text : "รูปภาพ"}</span>
      </div>
    );
  }

  // ── video ──
  if (msg.message_type === "video") {
    if (msg.media?.url) {
      return (
        <div className="space-y-1">
          <div
            className="relative cursor-pointer rounded-lg overflow-hidden group"
            onClick={() => imageViewer.show(msg.media!.url!, { type: "video", alt: msg.text || "วิดีโอ" })}
          >
            <video
              src={msg.media.url}
              poster={msg.media.thumb_url}
              className="rounded-lg max-w-[240px] max-h-[240px]"
              preload="metadata"
            />
            {/* Play overlay */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
              <div className="w-12 h-12 rounded-full bg-white/80 flex items-center justify-center">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="black"><path d="M8 5v14l11-7z" /></svg>
              </div>
            </div>
          </div>
          {msg.text && msg.text !== "(วิดีโอ)" && (
            <div className={`text-xs ${bubbleText} opacity-80`}>{renderMarkdownInline(msg.text)}</div>
          )}
        </div>
      );
    }
    // video แต่ไม่มี url → แสดง placeholder
    return (
      <div className={`flex items-center gap-1.5 ${bubbleText}`}>
        <Video size={16} className={isUser ? "text-text-muted" : "text-white/60"} />
        <span className="text-sm opacity-80">{msg.text && msg.text !== "(วิดีโอ)" ? msg.text : "วิดีโอ"}</span>
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
          className="rounded-lg max-w-[240px] max-h-[240px] object-cover cursor-pointer hover:opacity-80 transition-opacity"
          loading="lazy"
          onClick={() => imageViewer.show(msg.media!.url!, { type: "image", alt: msg.text || "รูปภาพ" })}
        />
        {msg.text && (
          <div className={`text-sm ${bubbleText}`}>{renderMarkdownInline(msg.text)}</div>
        )}
      </div>
    );
  }

  // ── item / variation_card → product card ──
  if (msg.message_type === "item" || msg.message_type === "variation_card") {
    // มี products → แสดง product card
    if (msg.products && msg.products.length > 0) {
      return (
        <div className="space-y-1.5">
          {msg.text && msg.text !== "(สินค้า)" && msg.text !== "(สินค้าพร้อมตัวเลือก)" && msg.text !== "[item]" && msg.text !== "[variation_card]" && (
            <div className={`text-sm ${bubbleText}`}>{renderMarkdownInline(msg.text)}</div>
          )}
          {msg.products.map((p) => (
            <ProductCardView key={p.item_id} product={p} variant={variant} />
          ))}
          {msg.table && <TableView table={msg.table} variant={variant} />}
        </div>
      );
    }
    // เป็น item แต่ไม่มี products (lookup ไม่เจอ) → แสดง placeholder สวยๆ
    return (
      <div className={`flex items-center gap-2 ${bubbleText}`}>
        <Package size={16} className={isUser ? "text-text-muted" : "text-white/60"} />
        <span className="text-sm opacity-80">สินค้า{msg.products === undefined ? "" : " (ไม่พบข้อมูล)"}</span>
      </div>
    );
  }

  // ── fallback: text + product cards (กรณี bot/admin ตอบพร้อม product) ──
  return (
    <div className="space-y-1.5">
      {msg.text && <div className={bubbleText}>{renderMarkdownInline(msg.text)}</div>}
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
  // ⚡ รองรับทั้ง url (Next.js) และ short_link (Python bot) — กัน url เป็น object หรือค่าผิดประเภท
  const rawUrl = (product.url ?? (product as unknown as { short_link?: string }).short_link) as unknown;
  const safeUrl = typeof rawUrl === "string" && rawUrl.startsWith("http") ? rawUrl : undefined;
  // ⚡ รองรับทั้ง image (Next.js) และ image_url (Python bot)
  const rawImage = (product.image ?? (product as unknown as { image_url?: string }).image_url) as unknown;
  const safeImage = typeof rawImage === "string" && rawImage.startsWith("http") ? rawImage : undefined;
  const CardTag = safeUrl ? "a" : "div";
  return (
    <CardTag
      {...(safeUrl ? { href: safeUrl, target: "_blank", rel: "noopener noreferrer" } : {})}
      className={`flex items-center gap-2.5 rounded-lg p-2 transition-colors ${
        isUser ? "bg-surface-2 hover:bg-pale-sky-soft" : "bg-white/10 hover:bg-white/15"
      }`}
    >
      {safeImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={safeImage}
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

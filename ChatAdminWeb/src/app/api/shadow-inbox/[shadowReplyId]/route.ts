// GET   /api/shadow-inbox/[shadowReplyId] — get one shadow reply (enriched with media)
// PATCH /api/shadow-inbox/[shadowReplyId] — rate a shadow reply (better/worse/tie/unrated)
// DELETE /api/shadow-inbox/[shadowReplyId] — delete a shadow reply
//
// ⛔ IRON RULE: ห้ามส่งข้อความจริง — rating เป็น metadata เท่านั้น
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { shadowReplyService } from "@/backend/service/shadowReplyService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { messageService } from "@/backend/service/messageService";
import { conversationService } from "@/backend/service/conversationService";
import { productService } from "@/backend/service/productService";
import { parseRawMessage, toProductCard } from "@/backend/service/messageMediaParser";
import type { ChatMessage, ProductCard } from "@/lib/types";

// GET — ดึง shadow reply พร้อม enrich media จาก inbound message's raw_payload
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ shadowReplyId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { shadowReplyId } = await params;
  const doc = await shadowReplyService.get(shadowReplyId);
  if (!doc) return error("shadow reply not found", 404);

  // enrich: ดึง raw_payload ของ inbound message เพื่อ parse media + ดึง chat history
  let inboundMessage: ChatMessage | undefined;
  let chatHistory: ChatMessage[] = [];
  try {
    const conv = await conversationService.getConversation(doc.conversation_id);
    if (conv) {
      const messages = await messageService.listMessages(doc.conversation_id, {
        platform: conv.platform,
        limit: 5000,
      });
      // สร้าง chat history — ข้อความทั้งหมดใน conversation เรียงตามเวลา
      const adminIds = new Set<string>();
      for (const m of messages) {
        if (m.actor && m.role === "admin") adminIds.add(m.actor);
      }
      const adminNameMap = new Map<string, string>();
      if (adminIds.size > 0) {
        const { auth } = await import("@/backend/service/authService");
        for (const aid of adminIds) {
          try {
            const a = await auth.getAdminById(aid);
            if (a) adminNameMap.set(aid, a.name || a.username || aid);
          } catch { /* ignore */ }
        }
      }
      chatHistory = messages.map((d) => {
        const parsed = parseRawMessage(d.raw_payload, d.text);
        const products: ProductCard[] = [];
        if (parsed.product_ref?.item_id) {
          // skip per-message product lookup for history (performance) — only do for inbound
        }
        return {
          id: d.message_id,
          role: d.role,
          text: parsed.text || d.text,
          timestamp: d.created_timestamp.toISOString(),
          source: d.source,
          message_type: parsed.message_type,
          media: parsed.media,
          order_sn: parsed.order_sn,
          notification_text: parsed.notification_text,
          table: parsed.table,
          admin_id: d.actor,
          admin_name: d.actor ? adminNameMap.get(d.actor) : undefined,
        };
      });
      const inboundDoc = messages.find((m) => m.message_id === doc.inbound_message_id);
      if (inboundDoc) {
        const parsed = parseRawMessage(inboundDoc.raw_payload, inboundDoc.text);
        // lookup product ถ้าเป็น item/variation_card
        const products: ProductCard[] = [];
        if (parsed.product_ref?.item_id) {
          try {
            const productDocs = await productService.getProductsByIds({
              platform: conv.platform,
              itemIds: [parsed.product_ref.item_id],
            });
            for (const p of productDocs) {
              products.push(toProductCard(p as Record<string, unknown>, conv.platform));
            }
          } catch { /* ignore product lookup errors */ }
        }
        inboundMessage = {
          id: inboundDoc.message_id,
          role: inboundDoc.role,
          text: parsed.text || inboundDoc.text,
          timestamp: inboundDoc.created_timestamp.toISOString(),
          products: products.length > 0 ? products : undefined,
          message_type: parsed.message_type,
          media: parsed.media,
          order_sn: parsed.order_sn,
          notification_text: parsed.notification_text,
          table: parsed.table,
        };
      }
    }
  } catch { /* ignore enrichment errors — still return the doc */ }

  // แปลง bot_products (unknown[]) → ProductCard[] ถ้าเป็น object ที่มี item_id
  let botProducts: ProductCard[] | undefined;
  if (doc.bot_products && Array.isArray(doc.bot_products)) {
    botProducts = (doc.bot_products as any[]).map((p) => {
      if (p && typeof p === "object" && (p.item_id || p.itemid)) {
        return toProductCard(p as Record<string, unknown>, doc.platform);
      }
      return null;
    }).filter(Boolean) as ProductCard[];
    if (botProducts.length === 0) botProducts = undefined;
  }

  return json({
    shadow_reply: {
      ...doc,
      inbound_message: inboundMessage,
      chat_history: chatHistory,
      bot_products: botProducts,
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ shadowReplyId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { shadowReplyId } = await params;
  const body = await readJson<{
    rating?: "good" | "bad" | "unrated";
    notes?: string;
    star_rating?: number;   // 0-5
    comment?: string;       // คอมเมนต์
  }>(req);

  if (!body) {
    return error("body required", 422);
  }

  // ⚡ ไม่บังคับ rating อีกต่อไป — ถ้าไม่ส่ง rating มา ให้ใช้ค่าเดิม (ถ้ามี) หรือ "unrated"
  let rating = body.rating;
  if (!rating) {
    // ดึงค่าปัจจุบันมาก่อน
    const existing = await shadowReplyService.get(shadowReplyId);
    rating = (existing?.rating as "good" | "bad" | "unrated" | undefined) || "unrated";
  }

  const validRatings = ["good", "bad", "unrated"];
  if (!validRatings.includes(rating)) {
    return error("rating must be better|worse|tie|unrated", 422);
  }

  // validate star_rating ถ้าส่งมา
  if (body.star_rating != null) {
    if (typeof body.star_rating !== "number" || body.star_rating < 0 || body.star_rating > 5) {
      return error("star_rating must be a number 0-5", 422);
    }
  }

  const ok = await shadowReplyService.rate(shadowReplyId, rating, r.ctx.admin.admin_id, {
    notes: body.notes,
    starRating: body.star_rating,
    comment: body.comment,
  });
  if (!ok) return error("shadow reply not found", 404);

  await logAdminEvent({
    action_type: "shadow_reply.rate",
    actor: r.ctx.admin.admin_id,
    metadata: {
      shadow_reply_id: shadowReplyId,
      rating,
      notes: body.notes,
      star_rating: body.star_rating,
      comment: body.comment,
    },
  });

  return json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ shadowReplyId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { shadowReplyId } = await params;
  // soft delete — เก็บประวัติ
  const ok = await shadowReplyService.delete(shadowReplyId, r.ctx.admin.admin_id, "manual_delete");
  if (!ok) return error("shadow reply not found (or already deleted)", 404);

  await logAdminEvent({
    action_type: "shadow_reply.delete",
    actor: r.ctx.admin.admin_id,
    metadata: { shadow_reply_id: shadowReplyId, soft_delete: true },
  });

  return json({ ok: true, soft_deleted: true });
}

// POST /api/shadow-inbox/[shadowReplyId]?action=restore — restore soft-deleted
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ shadowReplyId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { shadowReplyId } = await params;
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "restore") {
    const ok = await shadowReplyService.restore(shadowReplyId);
    if (!ok) return error("shadow reply not found", 404);
    await logAdminEvent({
      action_type: "shadow_reply.restore",
      actor: r.ctx.admin.admin_id,
      metadata: { shadow_reply_id: shadowReplyId },
    });
    return json({ ok: true, restored: true });
  }

  return error("unknown action — use ?action=restore", 422);
}

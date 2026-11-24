// Internal bridge used by replay_compare.py; engine transport stays in botCallService.
import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { serverConfig } from "@/backend/lib/config";
import { json, error, readJson } from "@/backend/lib/http";
import { ChatEngineDispatchError, dispatchChatEngine } from "@/backend/service/botCallService";
import type { ChatEngine, Platform } from "@/backend/service/systemConfigService";

const ENGINES: ChatEngine[] = ["legacy", "v2", "v3", "v4"];
const PLATFORMS: Platform[] = ["shopee", "tiktok", "lazada"];

function hasValidBridgeSecret(value: string | null): boolean {
  if (!value) return false;
  const expected = Buffer.from(serverConfig.chatbotInternalSecret);
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function POST(req: NextRequest) {
  if (!hasValidBridgeSecret(req.headers.get("x-chatadmin-replay-secret"))) {
    return error("unauthorized", 401);
  }

  const body = await readJson<{
    engine?: ChatEngine;
    platform?: Platform;
    python_payload?: Record<string, unknown>;
    v4?: {
      message?: string; shop_id?: string; shop_name?: string; history?: BotHistory;
      images?: string[]; item_id?: string; order_sn?: string;
      conversation_id?: string; message_id?: string;
    };
  }>(req);
  if (!body || !body.engine || !ENGINES.includes(body.engine) || !body.platform || !PLATFORMS.includes(body.platform)) {
    return error("engine and platform are required", 422);
  }
  if (!body.python_payload || typeof body.python_payload !== "object" || Array.isArray(body.python_payload)) {
    return error("python_payload object is required", 422);
  }
  const v4 = body.v4 || {};
  try {
    const result = await dispatchChatEngine({
      engine: body.engine,
      platform: body.platform,
      pythonPayload: body.python_payload,
      v4Params: {
        platform: body.platform,
        message: v4.message || "",
        shopId: v4.shop_id || "",
        shopName: v4.shop_name,
        history: v4.history || [],
        images: v4.images,
        itemId: v4.item_id,
        orderSn: v4.order_sn,
        conversationId: v4.conversation_id,
        messageId: v4.message_id,
        includePersona: false,
        persistImageDescription: false,
      },
    });
    return json({ ...result.data, chat_engine: result.chat_engine });
  } catch (cause) {
    if (cause instanceof ChatEngineDispatchError) {
      const responseBody = cause.responseBody && typeof cause.responseBody === "object"
        ? cause.responseBody as Record<string, unknown> : { detail: cause.message };
      return json(responseBody, cause.status);
    }
    return json({ detail: cause instanceof Error ? cause.message : "engine dispatch failed" }, 502);
  }
}

type BotHistory = { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[];

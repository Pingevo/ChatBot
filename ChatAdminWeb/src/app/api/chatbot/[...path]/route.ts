// Compatibility route for older /api/chatbot callers; chat requests use the selected engine.
// Other proxied paths still forward to the configured private Python service.
//
// Routing: first path segment = platform → picks the right bot's base URL
//   /api/chatbot/shopee/* → CHATBOT_BASE_URL_SHOPEE  (default 8010)
//   /api/chatbot/lazada/* → CHATBOT_BASE_URL_LAZADA  (default 8011)
//   /api/chatbot/tiktok/* → CHATBOT_BASE_URL_TIKTOK  (default 8012)
//
// Legacy fallback: if first segment is NOT a known platform (e.g. /api/chatbot/chat),
// it uses shopee's base URL (backward compat with old callers).
import { NextRequest, NextResponse } from "next/server";
import { serverConfig } from "@/backend/lib/config";
import { requireAuth } from "@/backend/middleware/authorize";
import { getChatEngine } from "@/backend/service/systemConfigService";
import { ChatEngineDispatchError, dispatchChatEngine } from "@/backend/service/botCallService";

type Platform = "shopee" | "lazada" | "tiktok";

function pickUpstream(segments: string[]): { upstream: string; remaining: string[] } {
  const first = (segments[0] || "").toLowerCase() as Platform;
  const known: Platform[] = ["shopee", "lazada", "tiktok"];
  if (known.includes(first)) {
    return {
      upstream: serverConfig.chatbotBaseUrls[first].replace(/\/$/, ""),
      remaining: segments.slice(1),
    };
  }
  // Legacy — no platform prefix, route to shopee (default bot)
  return {
    upstream: serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, ""),
    remaining: segments,
  };
}

async function proxy(req: NextRequest, segments: string[]) {
  // 🔒 ต้อง login ก่อนถึงจะใช้ chatbot proxy ได้
  const authResult = await requireAuth(req);
  if (!authResult.ok) return authResult.response;

  const { upstream, remaining } = pickUpstream(segments);
  const path = remaining.join("/");
  if ((path === "admin/generations" || path.startsWith("admin/generations/")) &&
      await getChatEngine() === "v4") {
    return NextResponse.json({ error: "python_engine_required" }, { status: 409 });
  }
  if (req.method === "POST" && path === "chat") {
    let parsed: Record<string, any>;
    try {
      const value = await req.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
      parsed = value;
    } catch {
      return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
    }
    const requestedPlatform = (segments[0] || "").toLowerCase();
    const platform: Platform = ["shopee", "lazada", "tiktok"].includes(requestedPlatform)
      ? requestedPlatform as Platform : "shopee";
    const shopName = typeof parsed.shop_name === "string" ? parsed.shop_name :
      typeof parsed.shop === "string" ? parsed.shop : "";
    const shopId = typeof parsed.shop_id === "string" ? parsed.shop_id : "";
    try {
      const { data } = await dispatchChatEngine({
        platform,
        pythonPayload: parsed,
        pythonHeaders: {
          "X-Admin-Id": authResult.ctx.admin.admin_id,
          "X-Admin-Name": encodeURIComponent(authResult.ctx.admin.name || ""),
        },
        v4Params: {
          platform,
          shopId,
          shopName,
          message: typeof parsed.message === "string" ? parsed.message : "",
          history: Array.isArray(parsed.history) ? parsed.history : [],
          images: Array.isArray(parsed.images) ? parsed.images : [],
          itemId: typeof parsed.item_id === "string" ? parsed.item_id : undefined,
          orderSn: typeof parsed.order_sn === "string" ? parsed.order_sn : undefined,
          conversationId: typeof parsed.conversation_id === "string" ? parsed.conversation_id : undefined,
          messageId: typeof parsed.message_id === "string" ? parsed.message_id : undefined,
          simulate: parsed.simulate_assignment === true,
          testSource: parsed.simulate_assignment === true ? "test_chat" : undefined,
        },
      });
      return NextResponse.json(data);
    } catch (cause) {
      if (cause instanceof ChatEngineDispatchError) {
        if (cause.chat_engine === "v4") {
          return NextResponse.json({
            error: "chat_engine_unavailable",
            message: cause.message,
          }, { status: 502 });
        }
        if (cause.status !== 502 || Object.keys((cause.responseBody || {}) as object).length > 0) {
          return NextResponse.json(cause.responseBody || {}, { status: cause.status });
        }
      }
      const msg = cause instanceof Error ? cause.message : "chatbot unreachable";
      console.error("[chatbot-proxy] upstream error:", msg, "upstream:", upstream);
      return NextResponse.json(
        { error: "chatbot_proxy_error", message: "chatbot service unreachable" },
        { status: 502 }
      );
    }
  }
  const url = `${upstream}/${path}${req.nextUrl.search}`;

  const method = req.method;
  const headers = new Headers(req.headers);
  // Remove hop-by-hop headers
  headers.delete("host");
  headers.delete("connection");
  // Attach internal secret
  headers.set("X-Internal-Secret", serverConfig.chatbotInternalSecret);

  // ⚡ Attach admin identity (for logging in Python)
  headers.set("X-Admin-Id", authResult.ctx.admin.admin_id);
  headers.set("X-Admin-Name", encodeURIComponent(authResult.ctx.admin.name || ""));

  const body = method !== "GET" && method !== "HEAD" ? await req.text() : undefined;

  try {
    const upstreamResp = await fetch(url, {
      method,
      headers,
      body,
    });

    const respHeaders = new Headers(upstreamResp.headers);
    respHeaders.delete("transfer-encoding");
    return new NextResponse(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    const msg = (err as Error).message || "chatbot unreachable";
    // 🔒 อย่าเปิดเผย upstream URL ให้ client — log ฝั่ง server เท่านั้น
    console.error("[chatbot-proxy] upstream error:", msg, "upstream:", upstream);
    return NextResponse.json(
      { error: "chatbot_proxy_error", message: "chatbot service unreachable" },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest) {
  const segments = req.nextUrl.pathname.replace(/^\/api\/chatbot\//, "").split("/");
  return proxy(req, segments);
}

export async function POST(req: NextRequest) {
  const segments = req.nextUrl.pathname.replace(/^\/api\/chatbot\//, "").split("/");
  return proxy(req, segments);
}

export async function PUT(req: NextRequest) {
  const segments = req.nextUrl.pathname.replace(/^\/api\/chatbot\//, "").split("/");
  return proxy(req, segments);
}

export async function DELETE(req: NextRequest) {
  const segments = req.nextUrl.pathname.replace(/^\/api\/chatbot\//, "").split("/");
  return proxy(req, segments);
}

export async function PATCH(req: NextRequest) {
  const segments = req.nextUrl.pathname.replace(/^\/api\/chatbot\//, "").split("/");
  return proxy(req, segments);
}

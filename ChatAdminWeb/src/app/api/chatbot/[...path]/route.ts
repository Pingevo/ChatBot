// Proxy route handler — forwards /api/chatbot/<platform>/* to the Python chatbot service.
// Adds the internal secret header so the chatbot accepts the request.
// The chatbot is never exposed publicly; only Next.js can reach it.
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
  const { upstream, remaining } = pickUpstream(segments);
  const path = remaining.join("/");
  const url = `${upstream}/${path}${req.nextUrl.search}`;

  const method = req.method;
  const headers = new Headers(req.headers);
  // Remove hop-by-hop headers
  headers.delete("host");
  headers.delete("connection");
  // Attach internal secret
  headers.set("X-Internal-Secret", serverConfig.chatbotInternalSecret);

  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.text();
  }

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
    return NextResponse.json(
      { error: "chatbot_proxy_error", message: msg, upstream },
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

// Python-owned generation tooling; v4 requests stop here without forwarding to the bot.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";
import { getChatEngine } from "@/backend/service/systemConfigService";

type RouteContext = { params: Promise<{ segments: string[] }> };

async function proxy(req: NextRequest, context: RouteContext, method: "GET" | "POST") {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { segments } = await context.params;
  const first = segments[0] || "";

  if (await getChatEngine() === "v4") {
    if (first === "list") return json({ active: "", previous: "", runs: [], unavailable: true });
    if (first === "pending") return json({ runs: [], unavailable: true });
    return error("Python generation tools require a Python chat engine", 409);
  }

  const suffix = ["list", "pending"].includes(first)
    ? ""
    : `/${segments.map((part) => encodeURIComponent(part)).join("/")}`;
  const base = serverConfig.chatbotBaseUrls.shopee.replace(/\/$/, "");
  const target = `${base}/admin/generations${suffix}${req.nextUrl.search}`;
  const headers = new Headers({
    "X-Internal-Secret": serverConfig.chatbotInternalSecret,
    "X-Admin-Id": auth.ctx.admin.admin_id,
    "X-Admin-Name": encodeURIComponent(auth.ctx.admin.name || ""),
  });
  let body: string | undefined;
  if (method === "POST") {
    body = await req.text();
    headers.set("Content-Type", req.headers.get("content-type") || "application/json");
  }
  try {
    const upstream = await fetch(target, { method, headers, ...(body ? { body } : {}) });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("transfer-encoding");
    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (cause) {
    console.error("[generations-proxy] upstream error:", cause instanceof Error ? cause.message : String(cause));
    return error("generation service unavailable", 502);
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  return proxy(req, context, "GET");
}

export async function POST(req: NextRequest, context: RouteContext) {
  return proxy(req, context, "POST");
}

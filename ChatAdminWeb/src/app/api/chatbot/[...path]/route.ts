// Proxy route handler — forwards /api/chatbot/* to the Python chatbot service.
// Adds the internal secret header so the chatbot accepts the request.
// The chatbot is never exposed publicly; only Next.js can reach it.
import { NextRequest, NextResponse } from "next/server";
import { serverConfig } from "@/backend/lib/config";

const UPSTREAM = serverConfig.chatbotBaseUrl.replace(/\/$/, "");

async function proxy(req: NextRequest, segments: string[]) {
  const path = segments.join("/");
  const url = `${UPSTREAM}/${path}${req.nextUrl.search}`;

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

  const upstream = await fetch(url, {
    method,
    headers,
    body,
  });

  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("transfer-encoding");
  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
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

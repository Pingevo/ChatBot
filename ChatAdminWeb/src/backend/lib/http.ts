// Shared HTTP helpers for route handlers.
import { NextResponse } from "next/server";

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function error(detail: string, status = 400): NextResponse {
  return NextResponse.json({ detail }, { status });
}

export function unauthorized(detail = "unauthorized"): NextResponse {
  return error(detail, 401);
}

export function forbidden(detail = "forbidden"): NextResponse {
  return error(detail, 403);
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "";
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// POST /api/internal/inbound-lifecycle
// External Sellcenter writer calls this AFTER durably persisting each inbound
// customer message (insert/upsert ack). It is a transport adapter only:
//   auth (x-internal-secret) → validate → map snake_case → delegate once.
// All Mongo/CAS/ownership logic lives in statusConversationService.
import { NextRequest } from "next/server";
import { json, error, readJson } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";
import { applyInboundOwnershipTransition } from "@/backend/service/statusConversationService";

export const dynamic = "force-dynamic";

const MAX_ID_LEN = 256;
const MAX_TS_LEN = 64;

// Strict ISO-8601 parse — explicit timezone required (Z or ±HH:MM) and the
// components must describe a REAL instant. `new Date()` alone silently
// normalizes invalid input (2026-02-30 → Mar 2), which would feed an invented
// timestamp into the closed→bot staleness fence — rejected by re-computing the
// instant from captured components and comparing exact milliseconds.
// Fractional seconds are canonicalized to millisecond precision by
// TRUNCATION (".999999"→999ms, never a carry into the next second) —
// sub-millisecond precision is not stored (Mongo/JS ms resolution).
function parseInboundTimestamp(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(raw);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, F, , sgn, OH, OMi] = m;
  const year = +Y, month = +Mo, day = +D;
  const hour = +H, minute = +Mi, second = S ? +S : 0;
  const offHour = +(OH ?? "0"), offMin = +(OMi ?? "0");
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || offHour > 23 || offMin > 59) {
    return null;
  }
  const fracMs = F ? Number(F.slice(0, 3).padEnd(3, "0")) : 0;
  const offMs = (sgn === "+" ? 1 : -1) * (offHour * 3_600_000 + offMin * 60_000);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, fracMs) - offMs;
  // reverse-check: components re-applied to the instant must map back exactly
  // (Date.UTC normalizes overflow like Feb 30 / day 0 before we compare)
  const back = new Date(utcMs + offMs);
  if (
    back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day ||
    back.getUTCHours() !== hour || back.getUTCMinutes() !== minute || back.getUTCSeconds() !== second
  ) {
    return null;
  }
  return new Date(utcMs);
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-secret");
  if (!secret || secret !== serverConfig.chatbotInternalSecret) {
    return error("unauthorized — internal secret required", 401);
  }

  const body = await readJson<Record<string, unknown>>(req);
  const conversationId = typeof body?.conversation_id === "string" ? body.conversation_id.trim() : "";
  const messageId = typeof body?.message_id === "string" ? body.message_id.trim() : "";
  const inboundAtRaw = typeof body?.inbound_at === "string" ? body.inbound_at.trim() : "";
  if (
    !conversationId || conversationId.length > MAX_ID_LEN ||
    !messageId || messageId.length > MAX_ID_LEN ||
    !inboundAtRaw || inboundAtRaw.length > MAX_TS_LEN
  ) {
    return error("invalid payload — conversation_id, message_id, inbound_at required", 422);
  }
  const inboundAt = parseInboundTimestamp(inboundAtRaw);
  if (!inboundAt) {
    return error("invalid inbound_at — ISO-8601 with timezone and real calendar date required", 422);
  }

  try {
    const outcome = await applyInboundOwnershipTransition({ conversationId, messageId, inboundAt });
    return json({ ok: true, outcome });
  } catch (e) {
    console.error("[inbound-lifecycle] transition failed:", e);
    return json({ error: "internal error" }, 500);
  }
}

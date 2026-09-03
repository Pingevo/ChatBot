// POST /api/test-chat/workflow-step — Test Chat ผ่าน workflow engine (เหมือน bot-worker ①②)
// body: { session_id, message, shop?, platform?, history?, phase? }
//
// phase:
//   "entry" (default) — จุดเริ่มส่งข้อความ → ① resume active flow + ② workflow_first/both
//   "after_trigger"   — trigger ไม่ match แล้ว → ② trigger_first (ลอง workflow ก่อนไปบอท)
//
// คืน:
//   { status: "workflow_actioned" | "workflow_resumed", messages: [...], handoff?, detail }
//     → client render messages ของ flow แล้วจบ (ไม่ไปบอท)
//   { status: "exit_drop", detail }
//     → client ไม่ตอบอะไร (flow cancel + ทิ้งข้อความ)
//   { status: "no_workflow", detail }
//     → client ไป trigger/bot ต่อตาม flow เดิมของ test chat
//
// ⚠️ test chat session ไม่มีใน conversations collection → condition ที่อ่าน
// conversation (conversation_status / assignee) จะ false แบบ graceful — engine รองรับแล้ว
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { getSystemConfig, type Platform } from "@/backend/service/systemConfigService";
import { workflowEngine } from "@/backend/service/workflowEngine";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    session_id?: string;
    message?: string;
    shop?: string;
    platform?: string;
    history?: { role: "user" | "model"; text: string }[];
    phase?: "entry" | "after_trigger";
  }>(req);

  if (!body?.session_id) return error("session_id is required", 422);
  if (!body?.message?.trim()) return error("message is required", 422);

  const sessionId = String(body.session_id);
  const message = String(body.message);
  const shop = body.shop ? String(body.shop) : "";
  const platform: Platform = (String(body.platform || "shopee") as Platform);
  const phase = body.phase === "after_trigger" ? "after_trigger" : "entry";

  // Engine ทำงานเฉพาะเมื่อเปิด workflow_enabled
  const config = await getSystemConfig();
  if (!config.workflow_enabled) {
    return json({ status: "no_workflow", detail: "workflow engine disabled" });
  }

  const engineMsg = {
    message_id: `testwf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: sessionId, // test chat ใช้ session_id เป็น conversation_id (แยกโซนกับ worker)
    shop_id: shop,
    platform,
    text: message,
    history: body.history, // test chat ส่ง history จาก client → engine ไม่ต้องดึงจาก messages
  };

  // ① Active Flow Resume — flow รอ reply อยู่ → ข้อความใหม่เข้า flow ก่อนเสมอ (ทุก phase)
  const activeRun = await workflowEngine.getActiveRun(sessionId);
  if (activeRun) {
    const result = await workflowEngine.resumeFlow(activeRun, engineMsg);
    if (result.status === "error") {
      // resume พัง → ให้ client ไป trigger/bot ตามเดิม (ไม่ทิ้งข้อความ)
      return json({ status: "no_workflow", detail: `resume error: ${result.detail}` });
    }
    return json({
      status: "workflow_resumed",
      messages: result.delivered,
      handoff: result.handoff || null,
      detail: result.detail,
      run_id: result.run_id,
      workflow_id: result.workflow_id,
    });
  }

  // ② Priority
  // entry + trigger_first → ให้ client ไปเช็ค trigger ก่อน (แล้วค่อยเรียก phase=after_trigger)
  if (phase === "entry" && config.workflow_priority === "trigger_first") {
    return json({ status: "no_workflow", detail: "trigger_first — check trigger first, then call with phase=after_trigger" });
  }

  // entry + workflow_first/both หรือ after_trigger (ทุก priority) → ลอง match workflow
  const result = await workflowEngine.matchAndRun(engineMsg);
  if (result.status === "actioned" || result.status === "resumed") {
    return json({
      status: result.status === "resumed" ? "workflow_resumed" : "workflow_actioned",
      messages: result.delivered,
      handoff: result.handoff || null,
      detail: result.detail,
      run_id: result.run_id,
      workflow_id: result.workflow_id,
    });
  }

  if (result.status === "exit_drop") {
    return json({ status: "exit_drop", detail: result.detail });
  }

  // exit_to_bot / no_match / error → client ไป trigger/bot ตาม flow เดิมของ test chat
  return json({ status: "no_workflow", detail: result.detail });
}

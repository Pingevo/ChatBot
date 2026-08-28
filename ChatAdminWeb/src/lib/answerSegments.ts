/**
 * Split bot answer เป็นหลาย segment ด้วย delimiter `|||`
 *
 * Bot (Python) ใช้ `|||` แบ่งคำตอบเป็นหลายข้อความ (multi-bubble)
 * และคืน field `answer_segments: list[str]` ด้วย
 *
 * ใช้กับ:
 *   - คำตอบจาก /api/chatbot/chat (TestChatClient)
 *   - คำตอบที่เก็บใน messages collection (TicketChatPanel, ShadowConversationPanel)
 *
 * ถ้าไม่มี ||| → คืน [text] (1 segment เดียวกับ text ตัวเดิม)
 * ถ้ามี ||| → แยก, trim, ตัด segment ว่างออก
 */

const SEGMENT_DELIMITER = "|||";

export function splitAnswerSegments(text: string | undefined | null): string[] {
  if (!text || typeof text !== "string") return [];
  // ถ้าไม่มี delimiter → คืนเดิม
  if (!text.includes(SEGMENT_DELIMITER)) return [text];
  // split + trim + กรอง segment ว่าง
  return text
    .split(SEGMENT_DELIMITER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

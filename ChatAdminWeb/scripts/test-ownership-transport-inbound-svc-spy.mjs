// Leaf spy for statusConversationService — เฉพาะ inbound-lifecycle transport
// route ที่อยู่ใต้ /src/app/api/internal/ (importer filter ใน hooks)
//
// ⚡ ไม่ใช่ production implementation — เป็น leaf-boundary mock สำหรับ
//    route contract tests เท่านั้น: นับ calls + คืนค่า/throw ตาม state ที่ตั้ง
//    (เหมือน mongoClient/systemConfigService mocks — leaf เท่านั้น)
//    service contract tests ยังเรียก real statusConversationService →
//    applyInboundOwnershipTransition missing = RED ตรง boundary
//
import { state } from "./test-ownership-transport-mocks.mjs";

export async function applyInboundOwnershipTransition(ev) {
  state.inboundTransitionCalls++;
  state.inboundTransitionArgs.push(ev);
  if (state.inboundTransitionError) throw state.inboundTransitionError;
  return state.inboundTransitionResult;
}

export const statusConversationService = { applyInboundOwnershipTransition };

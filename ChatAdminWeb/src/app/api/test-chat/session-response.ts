import { error } from "@/backend/lib/http";
import { TestChatSessionError } from "@/backend/service/testChatSessionService";

export function testChatSessionErrorResponse(cause: unknown) {
  if (cause instanceof TestChatSessionError) return error(cause.message, cause.status);
  console.error("[test-chat/sessions] error:", cause);
  return error("internal server error", 500);
}

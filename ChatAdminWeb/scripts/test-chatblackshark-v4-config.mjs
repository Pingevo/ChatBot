export async function shouldUseChatV2() { return false; }
export async function shouldUseChatV3() { return false; }
export async function getBotProductLimit() { return 10; }
export async function getSystemConfig() {
  return { chat_engine: process.env.TEST_CHAT_ENGINE || "v4", bot_concurrency_limit: 1, llm_context_limit: 10 };
}
export async function getChatEngine() { return process.env.TEST_CHAT_ENGINE || "v4"; }

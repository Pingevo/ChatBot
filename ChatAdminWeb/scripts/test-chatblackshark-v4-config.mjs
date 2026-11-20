export async function shouldUseChatV2() { return false; }
export async function shouldUseChatV3() { return false; }
export async function getBotProductLimit() { return 10; }
export async function getSystemConfig() { return { bot_concurrency_limit: 1, llm_context_limit: 10 }; }

import type { Conversation } from "@/lib/types";

type BotworkerConversationCache = {
  key: string;
  data: Conversation[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
  ts: number;
};

const CACHE_TTL_MS = 5_000;
let cache: BotworkerConversationCache | null = null;

export function getBotworkerConversationCache(key: string): BotworkerConversationCache | null {
  if (!cache || cache.key !== key) return null;
  if (Date.now() - cache.ts >= CACHE_TTL_MS) {
    cache = null;
    return null;
  }
  return cache;
}

export function setBotworkerConversationCache(value: BotworkerConversationCache): void {
  cache = value;
}

export function invalidateBotworkerCache(): void {
  cache = null;
}

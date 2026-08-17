// Message service — stores every chat message tied to a conversation_id.
// This is what makes "multichat" real: each conversation's history lives
// here, independent of any other conversation, and the orchestrator reads
// exactly this conversation's messages before calling the (stateless)
// Python chatbot.
//
// Collection shape mirrors the indexes already provisioned on `messages`:
//   shop_id_1, conversation_id_1, message_id_1,
//   conversation_id_1_created_timestamp_1, shop_id_1_created_timestamp_-1
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { touchLastMessage } from "./conversationService";

export type MessageRole = "user" | "bot" | "admin" | "system";

export interface MessageProduct {
  item_id: string;
  name: string;
  price?: number;
  image?: string;
  shop?: string;
  url?: string;
}

export interface MessageDoc extends Document {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  role: MessageRole;
  text: string;
  products?: MessageProduct[];
  source?: string; // product_store | knowledge_base | general:* | admin
  topic?: string;
  tokens?: { prompt: number; output: number; total: number };
  created_timestamp: Date;
}

function genMessageId(): string {
  return "msg_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function addMessage(opts: {
  conversationId: string;
  shopId: string;
  role: MessageRole;
  text: string;
  products?: MessageProduct[];
  source?: string;
  topic?: string;
  tokens?: { prompt: number; output: number; total: number };
}): Promise<MessageDoc> {
  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  const doc: MessageDoc = {
    message_id: genMessageId(),
    conversation_id: opts.conversationId,
    shop_id: opts.shopId,
    role: opts.role,
    text: opts.text,
    products: opts.products || [],
    source: opts.source,
    topic: opts.topic,
    tokens: opts.tokens,
    created_timestamp: new Date(),
  };
  await coll.insertOne(doc);

  // Update conversation preview — unread only bumps for customer-originated
  // messages (admin/bot replies are already "seen" by the console).
  await touchLastMessage(opts.conversationId, opts.text, opts.role === "user");

  return doc;
}

export async function listMessages(
  conversationId: string,
  limit = 200
): Promise<MessageDoc[]> {
  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  return coll
    .find({ conversation_id: conversationId })
    .sort({ created_timestamp: 1 })
    .limit(limit)
    .toArray();
}

/** Get the last N messages formatted for the chatbot's `history` param. */
export async function getHistoryForBot(
  conversationId: string,
  maxMessages = 10
): Promise<{ role: "user" | "model"; text: string }[]> {
  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  const docs = await coll
    .find({ conversation_id: conversationId, role: { $in: ["user", "bot"] } })
    .sort({ created_timestamp: -1 })
    .limit(maxMessages)
    .toArray();
  return docs
    .reverse()
    .map((d) => ({ role: d.role === "user" ? ("user" as const) : ("model" as const), text: d.text }));
}

export const messageService = {
  addMessage,
  listMessages,
  getHistoryForBot,
};

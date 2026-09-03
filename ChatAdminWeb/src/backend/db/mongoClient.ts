// MongoDB connection singleton — server-side only.
import { MongoClient, Db, Document, IndexSpecification, CreateIndexesOptions } from "mongodb";
import { serverConfig } from "../lib/config";

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (_db) return _db;
  _client = new MongoClient(serverConfig.mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });
  await _client.connect();
  _db = _client.db(serverConfig.mongoDbName);
  return _db;
}

export async function getCollection<T extends Document = Document>(
  name: string
) {
  const db = await getDb();
  return db.collection<T>(name);
}

// Collection names (from config — matches ADMIN_MONGO_COLLECTION_* env vars)
export const COLLECTIONS = serverConfig.collections;

/** Create an index, ignoring "already exists with different options" errors
 * (codes 85/86) — several collections were pre-provisioned with equivalent
 * indexes (e.g. different `background` flag) before this codebase existed. */
async function safeCreateIndex(
  db: Db,
  collectionName: string,
  spec: IndexSpecification,
  options?: CreateIndexesOptions
): Promise<void> {
  try {
    await db.collection(collectionName).createIndex(spec, options);
  } catch (e) {
    const code = (e as { code?: number })?.code;
    if (code === 85 || code === 86) return; // IndexOptionsConflict / IndexKeySpecsConflict
    throw e;
  }
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    safeCreateIndex(db, COLLECTIONS.admins, { email: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.admins, { username: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.admins, { admin_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.sessions, { token_hash: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.sessions, { admin_id: 1 }, { sparse: true }),
    safeCreateIndex(db, COLLECTIONS.authTokens, { token_hash: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.authTokens, { expires_at: 1 }, { expireAfterSeconds: 0 }),
    safeCreateIndex(db, COLLECTIONS.authTokens, { admin_id: 1, purpose: 1, used: 1 }, { sparse: true }),
    // conversations / messages — these indexes already exist in production
    // (created previously, likely from the original architecture); creating
    // them again here is idempotent (safeCreateIndex tolerates option
    // mismatches) and keeps fresh environments in sync.
    safeCreateIndex(db, COLLECTIONS.conversations, { shop_id: 1 }),
    safeCreateIndex(db, COLLECTIONS.conversations, { conversation_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.conversations, { shop_id: 1, conversation_id: 1 }),
    safeCreateIndex(db, COLLECTIONS.conversations, { platform: 1, shop_id: 1, pinned: -1, last_message_timestamp: -1 }),
    safeCreateIndex(db, COLLECTIONS.conversations, { platform: 1, shop_id: 1, unread_count: 1, pinned: -1, last_message_timestamp: -1 }),
    safeCreateIndex(db, COLLECTIONS.conversations, { shop_id: 1, to_name: 1 }),
    safeCreateIndex(db, COLLECTIONS.messages, { shop_id: 1 }),
    safeCreateIndex(db, COLLECTIONS.messages, { conversation_id: 1 }),
    safeCreateIndex(db, COLLECTIONS.messages, { message_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.messages, { conversation_id: 1, created_timestamp: 1 }),
    safeCreateIndex(db, COLLECTIONS.messages, { shop_id: 1, created_timestamp: -1 }),
    // Phase 7 — platform field + idempotency + data writer monitoring
    safeCreateIndex(db, COLLECTIONS.messages, { platform: 1, shop_id: 1, created_timestamp: -1 }),
    safeCreateIndex(db, COLLECTIONS.messages, { reply_to_message_id: 1 }, { sparse: true }),
    safeCreateIndex(db, COLLECTIONS.messages, { data_received_at: -1 }, { sparse: true }),
    safeCreateIndex(db, COLLECTIONS.conversations, { platform: 1, status: 1, unread_count: 1 }),
    safeCreateIndex(db, COLLECTIONS.tickets, { ticket_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.tickets, { status: 1 }),
    safeCreateIndex(db, COLLECTIONS.tickets, { channel: 1 }),
    safeCreateIndex(db, COLLECTIONS.tickets, { assigned_to: 1 }),
    safeCreateIndex(db, COLLECTIONS.shops, { shop_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.shops, { shopname: 1 }),
    safeCreateIndex(db, COLLECTIONS.shops, { platform: 1, shop_id: 1 }),
    safeCreateIndex(db, COLLECTIONS.customers, { platform: 1 }),
    safeCreateIndex(db, COLLECTIONS.customers, { buyer_id: 1 }),
    safeCreateIndex(db, COLLECTIONS.customers, { name: 1 }),
    safeCreateIndex(db, COLLECTIONS.customers, { platform: 1, buyer_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.customers, { platform: 1, last_active_at: -1 }),
    safeCreateIndex(db, COLLECTIONS.customers, { platform: 1, name: 1 }),
    safeCreateIndex(db, COLLECTIONS.adminLogs, { admin_id: 1 }),
    safeCreateIndex(db, COLLECTIONS.adminLogs, { ticket_id: 1 }, { sparse: true }),
    safeCreateIndex(db, COLLECTIONS.adminLogs, { timestamp: 1 }),
    safeCreateIndex(db, COLLECTIONS.adminLogs, { action_type: 1, timestamp: -1 }),
    // triggers — brand new collection.
    safeCreateIndex(db, COLLECTIONS.triggers, { trigger_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.triggers, { shop_id: 1 }, { sparse: true }),
    safeCreateIndex(db, COLLECTIONS.triggers, { enabled: 1 }),
    // knowledge_base — existing collection, add index for admin UI filtering.
    safeCreateIndex(db, COLLECTIONS.knowledgeBase, { type: 1, active: 1 }),
    // Phase 0 — new collections adapted from ChatBotPDigg
    // system_configs — single config key (main_config)
    safeCreateIndex(db, COLLECTIONS.systemConfigs, { config_key: 1 }, { unique: true, sparse: true }),
    // assignment_configs — mode selection (equal_global/equal_per_shop/equal_per_platform)
    safeCreateIndex(db, COLLECTIONS.assignmentConfigs, { config_key: 1 }, { unique: true, sparse: true }),
    // assignment_cursors — one cursor per pool (global/shop_id/platform)
    safeCreateIndex(db, COLLECTIONS.assignmentCursors, { pool_key: 1 }, { unique: true, sparse: true }),
    // shop_team_assignments — agent membership per shop
    safeCreateIndex(db, COLLECTIONS.shopTeamAssignments, { shop_id: 1, admin_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.shopTeamAssignments, { admin_id: 1, active: 1 }),
    // platform_team_assignments — agent membership per platform
    safeCreateIndex(db, COLLECTIONS.platformTeamAssignments, { platform: 1, admin_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.platformTeamAssignments, { admin_id: 1, is_active: 1 }),
    // shadow_replies — bot output stored locally (never sent to Shopee)
    safeCreateIndex(db, COLLECTIONS.shadowReplies, { inbound_message_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.shadowReplies, { shop_id: 1, created_at: -1 }),
    safeCreateIndex(db, COLLECTIONS.shadowReplies, { conversation_id: 1, created_at: -1 }),
    // quick_replies — admin-configurable canned responses
    safeCreateIndex(db, COLLECTIONS.quickReplies, { quick_reply_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.quickReplies, { shop_id: 1, enabled: 1 }),
    safeCreateIndex(db, COLLECTIONS.quickReplies, { category: 1, enabled: 1 }),
    // chat_accept_sessions — track เวลาเปิด/ปิดรับแชทของ admin
    safeCreateIndex(db, COLLECTIONS.chatAcceptSessions, { session_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.chatAcceptSessions, { admin_id: 1, started_at: -1 }),
    safeCreateIndex(db, COLLECTIONS.chatAcceptSessions, { admin_id: 1, state: 1, started_at: -1 }),
    // Phase 3 — shop_personas (per-shop bot persona: bot_name + platform)
    // 1 persona per shop — unique on (shopname, platform) หรือแค่ shopname ถ้า cross-platform
    safeCreateIndex(db, COLLECTIONS.shopPersonas, { persona_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.shopPersonas, { shopname: 1, platform: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.shopPersonas, { platform: 1, enabled: 1 }),
    // ⚡ test_chat_ratings — unique on (session_id, msg_index)
    safeCreateIndex(db, COLLECTIONS.testChatRatings, { session_id: 1, msg_index: 1 }, { unique: true }),
    safeCreateIndex(db, COLLECTIONS.testChatRatings, { platform: 1, rated_at: -1 }),
    // ⚡ test_assignment — replay results + ratings
    safeCreateIndex(db, COLLECTIONS.testAssignment, { conversation_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.testAssignment, { platform: 1, created_at: -1 }),
    safeCreateIndex(db, COLLECTIONS.testAssignment, { final_status: 1, created_at: -1 }),
    // ⚡ buffer_messages — message buffering (debounce) ก่อนเข้า processMessage
    safeCreateIndex(db, COLLECTIONS.bufferMessages, { message_id: 1 }, { unique: true, sparse: true }),
    safeCreateIndex(db, COLLECTIONS.bufferMessages, { conversation_id: 1, received_at: 1 }),
    safeCreateIndex(db, COLLECTIONS.bufferMessages, { shop_id: 1, received_at: -1 }),
  ]);
}

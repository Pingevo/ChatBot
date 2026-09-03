// Server-side configuration — reads from environment variables only.
// NEVER import this from a Client Component.
// Matches the env var names used by the Python admin/db.py.

function required(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v || fallback;
}

// Strict required — throws if env var is missing. Use for secrets.
function requiredStrict(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Required env var ${name} is not set — refusing to start with insecure default`);
  }
  return v;
}

// Build MongoDB URI from ADMIN_MONGO_* env vars (same logic as admin/db.py)
function buildAdminMongoUri(): string {
  const directUri = process.env.ADMIN_MONGO_URI?.trim();
  if (directUri) return directUri;

  const host = required("ADMIN_MONGO_HOST", "127.0.0.1:27017");
  const username = process.env.ADMIN_MONGO_USERNAME?.trim() || "";
  const password = process.env.ADMIN_MONGO_PASSWORD?.trim() || "";
  const authSource = required("ADMIN_MONGO_AUTH_SOURCE", "admin");
  const tls = (process.env.ADMIN_MONGO_TLS?.trim().toLowerCase() || "false") === "true";

  const params = new URLSearchParams();
  params.set("authSource", authSource);
  params.set("tls", String(tls));
  const creds = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  return `mongodb://${creds}${host}/?${params.toString()}`;
}

export const serverConfig = {
  mongoUri: buildAdminMongoUri(),
  mongoDbName: required("ADMIN_MONGO_DB", "chatbot_admin"),
  // Collection names (from ADMIN_MONGO_COLLECTION_*)
  collections: {
    admins: required("ADMIN_MONGO_COLLECTION_ADMINS", "admins"),
    authTokens: required("ADMIN_MONGO_COLLECTION_AUTH_TOKENS", "auth_tokens"),
    sessions: required("ADMIN_MONGO_COLLECTION_SESSIONS", "sessions"),
    knowledgeBase: required("ADMIN_MONGO_COLLECTION_KB", "knowledge_base"),
    guardrails: required("ADMIN_MONGO_COLLECTION_GUARDRAILS", "guardrails"),
    tickets: required("ADMIN_MONGO_COLLECTION_TICKETS", "tickets"),
    adminLogs: required("ADMIN_MONGO_COLLECTION_LOGS", "admin_logs"),
    // Added for real conversation/message storage, shops, customers, triggers.
    conversations: required("ADMIN_MONGO_COLLECTION_CONVERSATIONS", "conversations"),
    messages: required("ADMIN_MONGO_COLLECTION_MESSAGES", "messages"),
    shops: required("ADMIN_MONGO_COLLECTION_SHOPS", "shops"),
    customers: required("ADMIN_MONGO_COLLECTION_CUSTOMERS", "customers"),
    triggers: required("ADMIN_MONGO_COLLECTION_TRIGGERS", "triggers"),
    pushEvents: required("ADMIN_MONGO_COLLECTION_PUSH_EVENTS", "pushevents"),
    requestLogs: required("ADMIN_MONGO_COLLECTION_REQUEST_LOGS", "requestlogs"),
    // Phase 0 — new collections adapted from ChatBotPDigg (all in our own chatbot DB)
    systemConfigs: required("ADMIN_MONGO_COLLECTION_SYSTEM_CONFIGS", "system_configs"),
    assignmentConfigs: required("ADMIN_MONGO_COLLECTION_ASSIGNMENT_CONFIGS", "assignment_configs"),
    assignmentCursors: required("ADMIN_MONGO_COLLECTION_ASSIGNMENT_CURSORS", "assignment_cursors"),
    shopTeamAssignments: required("ADMIN_MONGO_COLLECTION_SHOP_TEAM_ASSIGNMENTS", "shop_team_assignments"),
    platformTeamAssignments: required("ADMIN_MONGO_COLLECTION_PLATFORM_TEAM_ASSIGNMENTS", "platform_team_assignments"),
    shadowReplies: required("ADMIN_MONGO_COLLECTION_SHADOW_REPLIES", "shadow_replies"),
    quickReplies: required("ADMIN_MONGO_COLLECTION_QUICK_REPLIES", "quick_replies"),
    // Phase 5 — conversation close history (open/close workflow)
    closeHistory: required("ADMIN_MONGO_COLLECTION_CLOSE_HISTORY", "close_history"),
    // Phase 8 — admin chat accept/pause sessions (track รับแชท/พัก + เวลาทำงาน)
    chatAcceptSessions: required("ADMIN_MONGO_COLLECTION_CHAT_ACCEPT_SESSIONS", "chat_accept_sessions"),
    // Phase 9 — bot worker (polling pipeline: trigger → bot → handoff)
    // ⚠️ คำตอบบอทเก็บใน shadow_replies (ไม่เขียนลง messages_shp)
    chatProcessing: required("ADMIN_MONGO_COLLECTION_CHAT_PROCESSING", "chat_processing"),
    // Phase 3 — per-shop bot persona (admin ตั้งชื่อตัวแทนบอทของแต่ละร้านในหน้า /persona)
    shopPersonas: required("ADMIN_MONGO_COLLECTION_SHOP_PERSONAS", "shop_personas"),
    // Phase 10 — per-shop behavior settings (faq_liveagent handoff toggle, etc.)
    shopSettings: required("ADMIN_MONGO_COLLECTION_SHOP_SETTINGS", "shop_settings"),
    // ⚡ test chat ratings — เก็บคะแนน/คอมเมนต์/ดาว ของ test chat messages (admin mongo)
    testChatRatings: required("ADMIN_MONGO_COLLECTION_TEST_CHAT_RATINGS", "test_chat_ratings"),
    // ⚡ test_assignment — replay results + ratings (per-message + overall conversation)
    testAssignment: required("ADMIN_MONGO_COLLECTION_TEST_ASSIGNMENT", "test_assignment"),
    // ⚡ buffer_messages — message buffering (debounce) ก่อนเข้า processMessage
    bufferMessages: required("ADMIN_MONGO_COLLECTION_BUFFER_MESSAGES", "buffer_messages"),
  },
  jwtSecret: requiredStrict("ADMIN_JWT_SECRET"),
  jwtAlgo: "HS256" as const,
  sessionHours: parseInt(required("ADMIN_SESSION_TIMEOUT_HOURS", "8"), 10),
  cookieName: "cc_session",
  // Internal secret for Next.js -> Python chatbot calls (shared across all bots)
  chatbotInternalSecret: requiredStrict("CHATBOT_INTERNAL_SECRET"),
  // Per-platform chatbot base URLs (3 separate FastAPI processes)
  // shopee  → CHATBOT_BASE_URL_SHOPEE (default 8010)
  // lazada  → CHATBOT_BASE_URL_LAZADA (default 8011)
  // tiktok  → CHATBOT_BASE_URL_TIKTOK (default 8012)
  // Legacy: CHATBOT_BASE_URL falls back to shopee for backward compat
  chatbotBaseUrls: {
    shopee: required("CHATBOT_BASE_URL_SHOPEE", required("CHATBOT_BASE_URL", "http://127.0.0.1:8010")),
    lazada: required("CHATBOT_BASE_URL_LAZADA", "http://127.0.0.1:8011"),
    tiktok: required("CHATBOT_BASE_URL_TIKTOK", "http://127.0.0.1:8012"),
  } as Record<"shopee" | "lazada" | "tiktok", string>,
  // Legacy single base URL (kept for backward compat — points to shopee)
  get chatbotBaseUrl() { return this.chatbotBaseUrls.shopee; },
  // Email service (Resend) — only used for signup/reset emails
  resendApiKey: process.env.RESEND_API_KEY?.trim() || "",
  emailFrom: process.env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev",
  appBaseUrl: required("APP_BASE_URL", "http://localhost:3000"),
  isProd: process.env.NODE_ENV === "production",
};

// Max failed login attempts before lockout
export const MAX_FAILED_LOGIN = 5;
export const LOCK_MINUTES = 15;

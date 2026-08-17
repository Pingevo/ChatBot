// Server-side configuration — reads from environment variables only.
// NEVER import this from a Client Component.
// Matches the env var names used by the Python admin/db.py.

function required(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v || fallback;
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
  },
  jwtSecret: required("ADMIN_JWT_SECRET", "dev-only-secret-change-me"),
  jwtAlgo: "HS256" as const,
  sessionHours: parseInt(required("ADMIN_SESSION_TIMEOUT_HOURS", "8"), 10),
  authTokenMinutes: parseInt(required("AUTH_TOKEN_EXPIRES_MINUTES", "15"), 10),
  cookieName: "cc_session",
  // Internal secret for Next.js -> Python chatbot calls
  chatbotInternalSecret: required("CHATBOT_INTERNAL_SECRET", "dev-internal-secret-change-me"),
  chatbotBaseUrl: required("CHATBOT_BASE_URL", "http://127.0.0.1:8010"),
  // Email service (Resend) — only used for signup/reset emails
  resendApiKey: process.env.RESEND_API_KEY?.trim() || "",
  emailFrom: process.env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev",
  appBaseUrl: required("APP_BASE_URL", "http://localhost:3000"),
  isProd: process.env.NODE_ENV === "production",
};

// Max failed login attempts before lockout
export const MAX_FAILED_LOGIN = 5;
export const LOCK_MINUTES = 15;

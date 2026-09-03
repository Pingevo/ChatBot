// Shared types for the ChatCenter console

export type Platform = "shopee" | "tiktok" | "lazada";

export type Topic =
  | "product_inquiry"
  | "product_compare"
  | "usage_help"
  | "claim"
  | "warranty"
  | "problem_report"
  | "tax_invoice"
  | "shipping"
  | "general"
  | "handoff";

export type ChatStatus = "open" | "closed" | "bot" | "handoff" | "resolved" | "pending";

// Phase 5 — ประเภทปัญหาตอนปิดแชท
export type ProblemCategory =
  | "shipping" | "product" | "payment" | "return_refund"
  | "warranty" | "account" | "promotion" | "other";

// Phase 5 — ประวัติการปิด/เปิดแชท
export interface CloseHistoryRecord {
  record_id: string;
  conversation_id: string;
  closed_by: string;
  closed_at: string; // ISO
  reason: string;
  category: ProblemCategory;
  resolution: string;
  note?: string;
  reopened_by?: string;
  reopened_at?: string; // ISO
  reopen_reason?: string;
  sequence: number;
}

export type MessageRole = "user" | "bot" | "admin" | "system";

// ประเภทข้อความตาม raw_payload.data.content.message_type ของ Shopee mirror
export type MessageType =
  | "text"
  | "image"
  | "video"
  | "item"
  | "variation_card"
  | "sticker"
  | "order"
  | "notification"
  | "image_with_text"
  | "faq_liveagent"
  | "rating_card"
  | "bundle_message"
  | "bundle_deal"
  | "unknown";

// ข้อมูล media (รูป/วิดีโอ) ที่ดึงจาก raw_payload
export interface MessageMedia {
  type: "image" | "video";
  url?: string;          // full URL
  thumb_url?: string;    // thumbnail (อาจเป็น hash ต้อง prepend host)
  thumb_width?: number;
  thumb_height?: number;
  duration_seconds?: number; // video only
}

// รายการตาราง/structured content (เช่น variation_card)
export interface MessageTable {
  headers: string[];
  rows: string[][];
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: string; // ISO
  products?: ProductCard[];
  source?: string; // product_store | knowledge_base | general:* | admin
  topic?: Topic;
  tokens?: { prompt: number; output: number; total: number };
  // Phase 5 — ใช้ใน log เพื่อระบุว่า admin คนไหนตอบ
  admin_id?: string;
  admin_name?: string;
  // Rich media — ดึงจาก raw_payload.data.content
  message_type?: MessageType;
  media?: MessageMedia;
  order_sn?: string;          // สำหรับ message_type=order
  notification_text?: string; // สำหรับ message_type=notification
  table?: MessageTable;       // สำหรับ structured content (variation_card)
  // ⚡ bundle_message — sub-messages หลายตัว
  bundle?: ChatMessage[];
  // Derived — ไม่ได้มาจาก sellcenter โดยตรง
  replied?: boolean;          // user message: มี admin/bot ตอบแล้วไหม (derive จาก timestamp)
}

export interface ProductCard {
  item_id: string;
  name: string;
  price: number;
  image?: string;
  shop?: string;
  url?: string;
}

export interface Conversation {
  id: string; // conversation_id
  platform: Platform;
  shop_id: string;
  shop_name: string;
  customer_id: string;
  customer_name: string;
  customer_avatar?: string;
  item_ids?: string[]; // locked product context
  status: ChatStatus;
  topic: Topic;
  last_message: string;
  last_timestamp: string; // ISO
  unread: number;
  assigned_to?: string; // admin id
  assigned_to_name?: string; // admin display name (lookup)

  // Ticket metadata — embedded in every conversation (Zaapi-style)
  // A conversation becomes a ticket the moment these are filled in
  ticket_id?: string;
  ticket_status?: "open" | "in_progress" | "resolved" | "closed";
  ticket_priority?: "low" | "medium" | "high" | "urgent";
  ticket_issue_type?: Topic;
  ticket_resolution?: string;
  ticket_summary?: string;
  ticket_handled_by?: string; // admin id
  ticket_created_at?: string; // ISO
  ticket_updated_at?: string; // ISO
}

export interface AdminUser {
  admin_id: string;
  email: string;
  username: string;
  name: string;
  role: "superadmin" | "admin" | "dev";
  channels_access?: string[];
  active?: boolean;
  is_accepting_chats?: boolean; // Phase 7.9 — เปิด/ปิดรับแชท
  last_login_at?: string | null;
  created_at?: string;
}

export interface Ticket {
  ticket_id: string;
  conversation_id: string;
  platform: Platform;
  shop_name: string;
  customer_name: string;
  topic: Topic;
  status: "open" | "in_progress" | "resolved" | "closed";
  priority: "low" | "medium" | "high" | "urgent";
  assigned_to?: string;
  created_at: string;
  updated_at: string;
  summary: string;
}

export interface KnowledgeEntry {
  id: string;
  topic: string;
  question: string;
  answer: string;
  shop?: string;
  tags: string[];
  updated_at: string;
  updated_by: string;
}

export interface TriggerRule {
  id: string;
  name?: string;
  shop_ids: string[]; // [] = all shops
  platforms: Platform[]; // [] = all platforms
  keywords: string[];
  topic: Topic;
  action: "bot_answer" | "handoff_admin";
  bot_template?: string;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
  admin_id?: string; // created by
  updated_by?: string; // edited by
}

export interface DashboardStats {
  has_real_data?: boolean;
  total_conversations: number;      // แชททั้งหมด
  bot_answered?: number;            // บอทตอบ (ไม่มี assigned_to, ไม่มี closed_at)
  with_admin?: number;              // กำลังตอบอยู่ (มี assigned_to, ไม่มี closed_at)
  closed?: number;                  // ปิดแล้ว (มี closed_at)
  // legacy fields (kept for backward compat)
  active_now?: number;
  bot_resolved?: number;
  handoff_count?: number;
  closed_count?: number;
  unread_count?: number;
  messages_received?: number;
  messages_sent?: number;
  avg_response_time: number; // seconds — diff ลูกค้าถาม → ตอบ
  platform_breakdown: { platform: Platform; count: number }[];
  topic_breakdown: { topic: Topic; count: number }[];
  daily_trend: { date: string; count: number }[];
}

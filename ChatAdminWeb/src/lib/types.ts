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

export type ChatStatus = "bot" | "handoff" | "resolved" | "pending";

export type MessageRole = "user" | "bot" | "admin" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: string; // ISO
  products?: ProductCard[];
  source?: string; // product_store | knowledge_base | general:* | admin
  topic?: Topic;
  tokens?: { prompt: number; output: number; total: number };
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
  shop_id?: string; // null = all shops
  keywords: string[];
  topic: Topic;
  action: "bot_answer" | "handoff_admin";
  bot_template?: string;
  enabled: boolean;
}

export interface DashboardStats {
  total_conversations: number;
  active_now: number;
  bot_resolved: number;
  handoff_count: number;
  avg_response_time: number; // seconds
  platform_breakdown: { platform: Platform; count: number }[];
  topic_breakdown: { topic: Topic; count: number }[];
  daily_trend: { date: string; count: number }[];
}

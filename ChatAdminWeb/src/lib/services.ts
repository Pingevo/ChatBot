// Service layer — all API calls live here.
// Each function returns typed data or throws.
// Routes are placeholders ready to wire to real backend.

import { api } from "./apiClient";
import type {
  Conversation,
  ChatMessage,
  Ticket,
  KnowledgeEntry,
  TriggerRule,
  DashboardStats,
  Platform,
  CloseHistoryRecord,
} from "./types";

// ---- Auth (re-export from authService.ts) ----
export { authService } from "./authService";

// ---- Conversations ----
// API routes อยู่ที่ /api/admin/conversations/*
export const chatService = {
  list: (params?: { platform?: Platform; status?: string; shop?: string; q?: string; assigned_to?: string }) =>
    api().get<Conversation[]>("/admin/conversations", { params }).then((r) => r.data),
  // ⚡ list พร้อม total_count (จำนวนจริงทั้งหมด ไม่จำกัดด้วย limit)
  // ⚠️ API อาจคืน array ตรงๆ (cache hit) หรือ { rows, total_count } — frontend ต้อง guard
  listWithCount: (params?: { platform?: Platform; status?: string; shop?: string; q?: string; assigned_to?: string; limit?: number }) =>
    api().get<{ rows: Conversation[]; total_count: number } | Conversation[]>("/admin/conversations", {
      params: { ...params, include_count: "true" },
    }).then((r) => r.data),
  get: (id: string) =>
    api().get<Conversation>(`/admin/conversations/${id}`).then((r) => r.data),
  messages: (id: string) =>
    api().get<ChatMessage[]>(`/admin/conversations/${id}/messages?all=1`).then((r) => r.data),
  messagesPage: (id: string, opts?: { limit?: number; before?: string; after?: string }) => {
    const params: Record<string, string> = {};
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.before) params.before = opts.before;
    if (opts?.after) params.after = opts.after;
    return api().get<{ messages: ChatMessage[]; total: number; has_more: boolean; oldest?: string; newest?: string }>(
      `/admin/conversations/${id}/messages`, { params }
    ).then((r) => r.data);
  },
  send: (id: string, text: string, force?: boolean) =>
    api().post<{ message: ChatMessage; assigned_to?: string | null; conflict?: boolean; ok?: boolean }>(
      `/admin/conversations/${id}/send`,
      { text, force }
    ).then((r) => r.data),
  assign: (id: string, adminId: string) =>
    api().post(`/admin/conversations/${id}/assign`, { admin_id: adminId }).then((r) => r.data),
  resolve: (id: string) =>
    api().post(`/admin/conversations/${id}/resolve`).then((r) => r.data),
  handoff: (id: string) =>
    api().post(`/admin/conversations/${id}/handoff`).then((r) => r.data),
  // Phase 5 — open/close workflow
  close: (id: string, data: { reason: string; category: string; resolution: string; note?: string }) =>
    api().post(`/conversations/${id}/close`, data).then((r) => r.data),
  reopen: (id: string, reason?: string) =>
    api().post(`/conversations/${id}/reopen`, { reason }).then((r) => r.data),
  closeHistory: (id: string) =>
    api().get<{ history: CloseHistoryRecord[] }>(`/conversations/${id}/close-history`).then((r) => r.data),
  // Phase 7.9 — toggle สถานะรับแชทของตัวเอง
  setAcceptingChats: (accepting: boolean) =>
    api().patch<{ ok: boolean; is_accepting_chats: boolean }>("/profile/accepting-chats", {
      is_accepting_chats: accepting,
    }).then((r) => r.data),
};

// ---- Tickets ----
export const ticketService = {
  list: (params?: { status?: string; assigned_to?: string }) =>
    api().get<Ticket[]>("/admin/tickets", { params }).then((r) => r.data),
  get: (id: string) => api().get<Ticket>(`/admin/tickets/${id}`).then((r) => r.data),
  assign: (id: string, adminId: string) =>
    api().post(`/admin/tickets/${id}/assign`, { admin_id: adminId }).then((r) => r.data),
  updateStatus: (id: string, status: string) =>
    api().post(`/admin/tickets/${id}/status`, { status }).then((r) => r.data),
};

// ---- Knowledge Base ----
export interface KbRow {
  _id?: string;
  type: "general_faq" | "product_spec";
  topic?: string;
  question?: string;
  answer?: string;
  question_patterns?: string[];
  brand?: string;
  model?: string;
  category?: string;
  highlights?: string;
  description?: string;
  warranty_period?: string;
  platform?: string;
  active?: boolean;
  created_at?: string;
  updated_at?: string;
  admin_id?: string; // created by
  updated_by?: string; // edited by
  source_file?: string;
}

export const kbService = {
  list: (params?: { type?: string; search?: string; active_only?: string }) =>
    api().get<{ rows: KbRow[]; total: number }>("/kb", { params }).then((r) => r.data),
  create: (data: { topic: string; answer: string; question_patterns?: string[]; platform?: string }) =>
    api().post<KbRow>("/kb", data).then((r) => r.data),
  update: (id: string, data: Partial<{ topic: string; answer: string; question_patterns: string[]; platform: string; brand: string; model: string; category: string; highlights: string; description: string; warranty_period: string }>) =>
    api().put(`/kb/${id}`, data).then((r) => r.data),
  delete: (id: string) => api().delete(`/kb/${id}`).then((r) => r.data),
  toggle: (id: string, active: boolean) =>
    api().patch(`/kb/${id}/toggle`, { active }).then((r) => r.data),
  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api()
      .post<{ ok: boolean; upserted: number; total_rows: number; source_file: string }>(
        "/kb/upload",
        form,
        { headers: { "Content-Type": "multipart/form-data" } }
      )
      .then((r) => r.data);
  },
  templateUrl: "/api/kb/template",
};

// ---- Quick Replies (per-admin) ----
export interface QuickReplyRow {
  quick_reply_id: string;
  admin_id: string;
  platforms: string[];
  shop_ids: string[];
  category: string;
  title: string;
  body: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  updated_by?: string; // edited by
}

export const quickReplyService = {
  list: (params?: { platform?: string; shop_id?: string; category?: string; enabled_only?: string }) =>
    api().get<{ rows: QuickReplyRow[] }>("/quick-replies", { params }).then((r) => r.data.rows),
  create: (data: { category?: string; title: string; body: string; platforms?: string[]; shop_ids?: string[]; sort_order?: number }) =>
    api().post<QuickReplyRow>("/quick-replies", data).then((r) => r.data),
  update: (id: string, data: Partial<{ category: string; title: string; body: string; platforms: string[]; shop_ids: string[]; enabled: boolean; sort_order: number }>) =>
    api().put(`/quick-replies/${id}`, data).then((r) => r.data),
  delete: (id: string) => api().delete(`/quick-replies/${id}`).then((r) => r.data),
};

// ---- Trigger Rules ----
// Phase 7.10 — trigger ใช้ API จริง (ไม่ใช่ mockup)
export const triggerService = {
  list: (params?: { shop_id?: string; platform?: string; enabled_only?: boolean }) =>
    api().get<{ rows: TriggerRule[]; total: number }>("/triggers", { params }).then((r) => r.data.rows),
  create: (data: {
    name: string;
    keywords: string[];
    shop_ids?: string[];
    platforms?: Platform[];
    topic?: string;
    action: "bot_answer" | "handoff_admin";
    bot_template?: string;
    enabled?: boolean;
  }) => api().post<{ trigger: TriggerRule }>("/triggers", data).then((r) => r.data.trigger),
  update: (id: string, data: Partial<{
    name: string;
    keywords: string[];
    shop_ids: string[];
    platforms: Platform[];
    topic: string;
    action: "bot_answer" | "handoff_admin";
    bot_template: string;
    enabled: boolean;
  }>) => api().patch(`/triggers/${id}`, data).then((r) => r.data),
  toggle: (id: string, enabled: boolean) =>
    api().post(`/triggers/${id}/toggle`, { enabled }).then((r) => r.data),
  delete: (id: string) => api().delete(`/triggers/${id}`).then((r) => r.data),
};

// ---- Dashboard / Analytics ----
export interface LiveStats {
  has_real_data: boolean;
  range?: string;
  connected_shops: number;
  open_total: number;
  open_assigned: number;
  open_unassigned: number;
  closed_total: number;
  unanswered_total: number;
  unanswered_threshold_minutes: number;
  workload_by_admin: { admin_id: string; name: string; count: number }[];
  breakdown_by_connection: { name: string; value: number }[];
  breakdown_by_status: { status: string; count: number }[];
  generated_at: string;
}

export interface PerformanceKpi {
  value: number;
  spark: { date: string; value: number }[];
}

export interface PerformanceStats {
  has_real_data: boolean;
  connected_shops: number;
  date_range_label: string;
  compare_label: string;
  overview: {
    new_vs_existing: { new: number; existing: number };
    conversations: PerformanceKpi;
    unanswered_12h: PerformanceKpi;
    response_rate_12h: PerformanceKpi;
    response_rate_10min: PerformanceKpi;
    avg_response_time_seconds: PerformanceKpi;
    messages_received: PerformanceKpi;
    messages_sent: PerformanceKpi;
  };
  insight: {
    customers_by_channel: Record<string, unknown>[];
    unanswered_by_channel: Record<string, unknown>[];
    response_rate_12h_by_channel: Record<string, unknown>[];
    response_rate_10min_by_channel: Record<string, unknown>[];
    avg_response_time_by_channel: Record<string, unknown>[];
  };
  heatmap: {
    rows: string[];
    cols: string[];
    values: number[][];
  };
}

export interface AdminPerformanceRow {
  admin_id: string;
  name: string;
  role: string;
  conversations: number;
  unanswered_12h: number;
  response_rate_12h: number;
  response_rate_10min: number;
  avg_response_time_seconds: number;
}

export interface AdminActivityStats {
  has_real_data: boolean;
  connected_shops: number;
  date_range_label: string;
  compare_label: string;
  conversations_by_admin_per_day: Record<string, unknown>[];
  admin_series_keys: string[];
  rankings: {
    most_conversations: AdminPerformanceRow | null;
    least_responses: AdminPerformanceRow | null;
    fastest_10min: AdminPerformanceRow | null;
    fastest_overall: AdminPerformanceRow | null;
  };
  individual_performance: AdminPerformanceRow[];
}

export const statsService = {
  dashboard: (params?: { range?: string; start_date?: string; end_date?: string }) =>
    api().get<DashboardStats & { has_real_data: boolean }>("/stats/dashboard", { params }).then((r) => r.data),
  live: (params?: { range?: string; start_date?: string; end_date?: string }) =>
    api().get<LiveStats>("/stats/live", { params }).then((r) => r.data),
  performance: (params?: { range?: string; start_date?: string; end_date?: string }) =>
    api().get<PerformanceStats>("/stats/performance", { params }).then((r) => r.data),
  adminActivity: (params?: { range?: string; start_date?: string; end_date?: string }) =>
    api().get<AdminActivityStats>("/stats/admin-activity", { params }).then((r) => r.data),
};

// ---- Shops (proxied to chatbot service) ----
export const shopService = {
  list: () => api().get<{ shops: string[] }>("/chatbot/shops").then((r) => r.data),
};

// ---- Shop Personas (per-shop bot persona — admin ตั้งชื่อตัวแทนบอทของแต่ละร้าน) ----
export type PersonaPlatform = "shopee" | "tiktok" | "lazada";

export interface ShopPersonaRow {
  persona_id: string;
  shopname: string;
  platform: PersonaPlatform;
  bot_name: string;
  enabled: boolean;
  notes?: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
}

export const personaService = {
  list: (params?: { platform?: PersonaPlatform; search?: string; enabled_only?: boolean }) => {
    const query: Record<string, string> = {};
    if (params?.platform) query.platform = params.platform;
    if (params?.search) query.search = params.search;
    if (params?.enabled_only) query.enabled_only = "1";
    return api().get<{ rows: ShopPersonaRow[] }>("/persona", { params: query }).then((r) => r.data.rows);
  },
  upsert: (data: { shopname: string; platform: PersonaPlatform; bot_name: string; enabled?: boolean; notes?: string }) =>
    api().post<ShopPersonaRow>("/persona", data).then((r) => r.data),
  patch: (id: string, data: Partial<{ enabled: boolean; notes: string; bot_name: string }>) =>
    api().patch<ShopPersonaRow>(`/persona/${id}`, data).then((r) => r.data),
  toggle: (id: string, enabled: boolean) =>
    api().patch<{ ok: boolean; enabled: boolean }>(`/persona/${id}`, { enabled }).then((r) => r.data),
  delete: (id: string) => api().delete(`/persona/${id}`).then((r) => r.data),
};

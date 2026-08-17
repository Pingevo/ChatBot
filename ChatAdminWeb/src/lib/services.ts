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
} from "./types";

// ---- Auth (re-export from authService.ts) ----
export { authService } from "./authService";

// ---- Conversations ----
// NOTE: these endpoints will be implemented in the Next.js API layer later.
// For now they point to /api/admin/* which will be wired up when chat
// integration is built.
export const chatService = {
  list: (params?: { platform?: Platform; status?: string; shop?: string; q?: string }) =>
    api().get<Conversation[]>("/admin/conversations", { params }).then((r) => r.data),
  get: (id: string) =>
    api().get<Conversation>(`/admin/conversations/${id}`).then((r) => r.data),
  messages: (id: string) =>
    api().get<ChatMessage[]>(`/admin/conversations/${id}/messages`).then((r) => r.data),
  send: (id: string, text: string) =>
    api().post<{ message: ChatMessage }>(`/admin/conversations/${id}/send`, { text }).then((r) => r.data),
  assign: (id: string, adminId: string) =>
    api().post(`/admin/conversations/${id}/assign`, { admin_id: adminId }).then((r) => r.data),
  resolve: (id: string) =>
    api().post(`/admin/conversations/${id}/resolve`).then((r) => r.data),
  handoff: (id: string) =>
    api().post(`/admin/conversations/${id}/handoff`).then((r) => r.data),
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
  updated_at?: string;
  updated_by?: string;
  source_file?: string;
}

export const kbService = {
  list: (params?: { type?: string; search?: string; active_only?: string }) =>
    api().get<{ rows: KbRow[]; total: number }>("/kb", { params }).then((r) => r.data),
  create: (data: { topic: string; answer: string; question_patterns?: string[]; platform?: string }) =>
    api().post<KbRow>("/kb", data).then((r) => r.data),
  update: (id: string, data: Partial<{ topic: string; answer: string; question_patterns: string[]; platform: string }>) =>
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

// ---- Trigger Rules ----
export const triggerService = {
  list: (shopId?: string) =>
    api().get<TriggerRule[]>("/admin/triggers", { params: { shop_id: shopId } }).then((r) => r.data),
  create: (data: Partial<TriggerRule>) =>
    api().post<TriggerRule>("/admin/triggers", data).then((r) => r.data),
  update: (id: string, data: Partial<TriggerRule>) =>
    api().put<TriggerRule>(`/admin/triggers/${id}`, data).then((r) => r.data),
  delete: (id: string) => api().delete(`/admin/triggers/${id}`).then((r) => r.data),
};

// ---- Dashboard / Analytics ----
export interface LiveStats {
  has_real_data: boolean;
  connected_shops: number;
  open_total: number;
  open_assigned: number;
  open_unassigned: number;
  unanswered_total: number;
  unanswered_threshold_minutes: number;
  workload_by_admin: { admin_id: string; name: string; count: number }[];
  breakdown_by_connection: { name: string; value: number }[];
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
  dashboard: () => api().get<DashboardStats & { has_real_data: boolean }>("/stats/dashboard").then((r) => r.data),
  live: () => api().get<LiveStats>("/stats/live").then((r) => r.data),
  performance: () => api().get<PerformanceStats>("/stats/performance").then((r) => r.data),
  adminActivity: () => api().get<AdminActivityStats>("/stats/admin-activity").then((r) => r.data),
};

// ---- Shops (proxied to chatbot service) ----
export const shopService = {
  list: () => api().get<{ shops: string[] }>("/chatbot/shops").then((r) => r.data),
};

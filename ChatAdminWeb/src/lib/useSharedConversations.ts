"use client";
// ⚡ G-share — Shared conversation store
//   หน้า tickets / shadow-inbox / replay-compare ดึง /admin/conversations ซ้ำกัน
//   ใช้ store เดียว poll ครั้งเดียว แชร์กันหลายหน้า — ลดโหลด DB
//
//   วิธีใช้:
//     const { conversations, totalCount, loading, refresh } = useSharedConversations({ filter });
//
//   filter: { assigned_to?, platform?, status?, shop?, q?, limit? }
//   ถ้า filter เหมือนกัน → ใช้ cache ร่วมกัน (poll ครั้งเดียว)
//   ถ้า filter ต่างกัน → ดึงแยก (แต่ยังใช้ store ร่วม)
import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/apiClient";
import type { Conversation } from "@/lib/types";

// ─── Module-level singleton store ───────────────────────────
// ⚡ stable empty array — กัน infinite loop ใน useEffect ที่ depend บน conversations
const EMPTY_CONVERSATIONS: Conversation[] = [];

interface StoreState {
  data: Conversation[];
  totalCount: number;
  loading: boolean;
  error: unknown;
  lastFetch: number;
  filterKey: string;
}

let store: StoreState = {
  data: [],
  totalCount: 0,
  loading: false,
  error: null,
  lastFetch: 0,
  filterKey: "",
};

// subscribers ทั้งหมด — เรียก setState เมื่อ store เปลี่ยน
const subscribers = new Set<() => void>();

function notifyAll() {
  subscribers.forEach((fn) => fn());
}

function setStore(patch: Partial<StoreState>) {
  store = { ...store, ...patch };
  notifyAll();
}

// ─── Polling controller ─────────────────────────────────────
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL = 3000; // ⚡ 3 วิ — เท่า tickets เดิม
let activeFilterKey = "";
let activeFilter: Record<string, string> = {};

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (store.loading) return; // กันซ้อน
    await fetchConversations(activeFilterKey, activeFilter, true);
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function fetchConversations(
  filterKey: string,
  filter: Record<string, string>,
  isPoll: boolean
): Promise<void> {
  // ถ้า filter เปลี่ยน → reset และ fetch ใหม่
  if (filterKey !== store.filterKey) {
    setStore({ filterKey, data: [], totalCount: 0, loading: true });
  } else if (isPoll && store.loading) {
    return; // กันซ้อน
  }
  // ⚡ ไม่ตั้ง loading: true ตอน poll — กัน spinner ขึ้นรัวๆ ทุก 3 วิ
  //   (เฉพาะ initial fetch / filter change เท่านั้นที่ loading=true)

  try {
    const r = await api().get<{ rows: Conversation[]; total_count: number } | Conversation[]>(
      "/admin/conversations",
      {
        params: { ...filter, include_count: "true" },
        timeout: 45000,
      }
    );
    const rows = Array.isArray(r.data) ? r.data : (r.data.rows || []);
    const totalCount = Array.isArray(r.data) ? rows.length : (r.data.total_count ?? 0);
    // dedupe
    const seen = new Set<string>();
    const deduped = rows.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    setStore({
      data: deduped,
      totalCount,
      loading: false,
      error: null,
      lastFetch: Date.now(),
      filterKey,
    });
  } catch (err) {
    // ⚡ ไม่ clear data เดิมเวลา poll ล้มเหลว (กันหน้าว่าง)
    setStore({ loading: false, error: err });
  }
}

// ─── Hook ───────────────────────────────────────────────────
export interface ConversationFilter {
  assigned_to?: string; // "me" | "all" | "<admin_id>"
  platform?: string;
  status?: string;
  shop?: string;
  q?: string;
  limit?: number;
}

function buildFilterKey(filter: ConversationFilter): string {
  return [
    filter.assigned_to || "all",
    filter.platform || "",
    filter.status || "",
    filter.shop || "",
    filter.q || "",
    String(filter.limit || 2000),
  ].join("|");
}

function buildFilterParams(filter: ConversationFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.assigned_to) params.assigned_to = filter.assigned_to;
  if (filter.platform) params.platform = filter.platform;
  if (filter.status) params.status = filter.status;
  if (filter.shop) params.shop = filter.shop;
  if (filter.q) params.q = filter.q;
  if (filter.limit) params.limit = String(filter.limit);
  return params;
}

export function useSharedConversations(filter: ConversationFilter = {}) {
  const filterKey = buildFilterKey(filter);
  const filterParams = buildFilterParams(filter);
  const [, forceRender] = useState(0);
  const subscribedRef = useRef(false);

  // subscribe to store changes
  useEffect(() => {
    const rerender = () => forceRender((n) => n + 1);
    subscribers.add(rerender);
    subscribedRef.current = true;
    return () => {
      subscribers.delete(rerender);
      subscribedRef.current = false;
    };
  }, []);

  // เมื่อ filter เปลี่ยน → fetch ใหม่ + ตั้งเป็น active filter สำหรับ polling
  useEffect(() => {
    activeFilterKey = filterKey;
    activeFilter = filterParams;
    fetchConversations(filterKey, filterParams, false);
    startPolling();
    return () => {
      // ถ้าไม่มี subscriber แล้ว → หยุด polling
      //   ใช้ setTimeout เพื่อรอให้ cleanup ของ component อื่นทำก่อน
      setTimeout(() => {
        if (subscribers.size === 0) stopPolling();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const refresh = useCallback(async () => {
    await fetchConversations(filterKey, filterParams, false);
  }, [filterKey, filterParams]);

  return {
    conversations: store.filterKey === filterKey ? store.data : EMPTY_CONVERSATIONS,
    totalCount: store.filterKey === filterKey ? store.totalCount : 0,
    loading: store.filterKey === filterKey ? store.loading : true,
    error: store.filterKey === filterKey ? store.error : null,
    refresh,
  };
}

// ⚡ ใช้สำหรับ invalidate cache เมื่อมี mutation (send/assign/close)
export function invalidateSharedConversations() {
  store = { ...store, lastFetch: 0 };
  // trigger immediate refetch on next poll
  fetchConversations(activeFilterKey, activeFilter, false).catch(() => {});
}

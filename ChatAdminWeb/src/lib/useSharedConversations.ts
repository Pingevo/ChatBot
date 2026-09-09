"use client";
// ⚡ G-share — Shared conversation store with pagination
//   หน้า tickets / shadow-inbox / replay-compare ดึง /admin/conversations ซ้ำกัน
//   ใช้ store เดียว poll ครั้งเดียว แชร์กันหลายหน้า — ลดโหลด DB
//
//   ⚡ Phase 1 pagination:
//     - head = page 1 (50 ล่าสุด) — poll ทุก 3 วิ (real-time)
//     - tail = page 2+ — โหลดเพิ่มตอน scroll (loadMore)
//     - cursor = last_message_timestamp ของ tail สุดท้าย
//     - hasMore = ยังมีของให้โหลดไหม
//
//   วิธีใช้:
//     const { conversations, totalCount, loading, loadMore, hasMore, loadingMore, refresh } = useSharedConversations({ filter });
//
//   filter: { assigned_to?, platform?, status?, shop?, q?, pageSize? }
//   ถ้า filter เหมือนกัน → ใช้ cache ร่วมกัน (poll ครั้งเดียว)
//   ถ้า filter ต่างกัน → ดึงแยก (แต่ยังใช้ store ร่วม)
import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/apiClient";
import type { Conversation } from "@/lib/types";

// ─── Module-level singleton store ───────────────────────────
// ⚡ stable empty array — กัน infinite loop ใน useEffect ที่ depend บน conversations
const EMPTY_CONVERSATIONS: Conversation[] = [];

interface StoreState {
  head: Conversation[];          // ⚡ page 1 (newest) — poll ทุก 3 วิ
  tail: Conversation[];          // ⚡ page 2+ — โหลดเพิ่มตอน scroll
  totalCount: number;
  hasMore: boolean;              // ⚡ ยังมี page ถัดไปไหม
  cursor: string | null;         // ⚡ cursor สำหรับ page ถัดไป
  loading: boolean;              // loading head (initial / filter change)
  loadingMore: boolean;          // ⚡ loading tail (scroll)
  error: unknown;
  lastFetch: number;
  filterKey: string;
}

let store: StoreState = {
  head: [],
  tail: [],
  totalCount: 0,
  hasMore: false,
  cursor: null,
  loading: false,
  loadingMore: false,
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
const POLL_INTERVAL = 3000; // ⚡ 3 วิ — real-time
let activeFilterKey = "";
let activeFilter: Record<string, string> = {};
let activePageSize = 50;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (store.loading) return; // กันซ้อน
    await fetchHead(activeFilterKey, activeFilter, activePageSize, true);
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ⚡ fetchHead — ดึง page 1 (newest) — ใช้สำหรับ initial load + poll
async function fetchHead(
  filterKey: string,
  filter: Record<string, string>,
  pageSize: number,
  isPoll: boolean
): Promise<void> {
  // ถ้า filter เปลี่ยน → reset และ fetch ใหม่
  if (filterKey !== store.filterKey) {
    setStore({ filterKey, head: [], tail: [], totalCount: 0, hasMore: false, cursor: null, loading: true, loadingMore: false });
  } else if (isPoll && store.loading) {
    return; // กันซ้อน
  }
  // ⚡ ไม่ตั้ง loading: true ตอน poll — กัน spinner ขึ้นรัวๆ ทุก 3 วิ
  //   (เฉพาะ initial fetch / filter change เท่านั้นที่ loading=true)

  try {
    const r = await api().get<{ rows: Conversation[]; total_count: number; has_more: boolean; cursor: string | null } | Conversation[]>(
      "/admin/conversations",
      {
        params: { ...filter, include_count: "true", limit: String(pageSize) },
        timeout: 15000,
      }
    );
    const rows = Array.isArray(r.data) ? r.data : (r.data.rows || []);
    const totalCount = Array.isArray(r.data) ? rows.length : (r.data.total_count ?? 0);
    const hasMore = Array.isArray(r.data) ? false : (r.data.has_more ?? false);
    const cursor = Array.isArray(r.data) ? null : (r.data.cursor ?? null);
    // dedupe
    const seen = new Set<string>();
    const deduped = rows.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    // ⚡ merge head — ถ้ามี tail อยู่ ให้เอา head ใหม่ แล้วตัด tail ที่ซ้ำกับ head ออก
    const headIds = new Set(deduped.map((c) => c.id));
    const newTail = store.tail.filter((c) => !headIds.has(c.id));
    setStore({
      head: deduped,
      tail: newTail,
      totalCount,
      hasMore,
      cursor,
      loading: false,
      loadingMore: false,
      error: null,
      lastFetch: Date.now(),
      filterKey,
    });
  } catch (err) {
    // ⚡ ไม่ clear data เดิมเวลา poll ล้มเหลว (กันหน้าว่าง)
    setStore({ loading: false, error: err });
  }
}

// ⚡ fetchTail — ดึง page ถัดไป (เก่ากว่า cursor) — ใช้สำหรับ scroll load more
async function fetchTail(
  filterKey: string,
  filter: Record<string, string>,
  pageSize: number
): Promise<void> {
  // ต้องเป็น filter เดียวกัน + มี cursor + ไม่กำลังโหลดอยู่
  if (filterKey !== store.filterKey) return;
  if (!store.cursor || !store.hasMore) return;
  if (store.loadingMore) return;

  setStore({ loadingMore: true });

  try {
    const r = await api().get<{ rows: Conversation[]; total_count: number; has_more: boolean; cursor: string | null } | Conversation[]>(
      "/admin/conversations",
      {
        params: { ...filter, include_count: "true", limit: String(pageSize), cursor: store.cursor },
        timeout: 15000,
      }
    );
    const rows = Array.isArray(r.data) ? r.data : (r.data.rows || []);
    const hasMore = Array.isArray(r.data) ? false : (r.data.has_more ?? false);
    const cursor = Array.isArray(r.data) ? null : (r.data.cursor ?? null);
    // dedupe — กันซ้ำกับ head + tail ที่มีอยู่
    const existingIds = new Set([...store.head.map((c) => c.id), ...store.tail.map((c) => c.id)]);
    const newRows = rows.filter((c) => {
      if (existingIds.has(c.id)) return false;
      existingIds.add(c.id);
      return true;
    });
    setStore({
      tail: [...store.tail, ...newRows],
      hasMore,
      cursor,
      loadingMore: false,
      error: null,
    });
  } catch (err) {
    setStore({ loadingMore: false, error: err });
  }
}

// ─── Hook ───────────────────────────────────────────────────
export interface ConversationFilter {
  assigned_to?: string; // "me" | "all" | "<admin_id>"
  platform?: string;
  status?: string;
  shop?: string;
  q?: string;
  pageSize?: number; // ⚡ จำนวนต่อ page (default 50)
  // ⚡ backward compat — หน้าเก่าส่ง limit มา แต่ตอนนี้ใช้ pageSize แทน
  limit?: number;
}

function buildFilterKey(filter: ConversationFilter): string {
  return [
    filter.assigned_to || "all",
    filter.platform || "",
    filter.status || "",
    filter.shop || "",
    filter.q || "",
    String(filter.pageSize || filter.limit || 200),
  ].join("|");
}

function buildFilterParams(filter: ConversationFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.assigned_to) params.assigned_to = filter.assigned_to;
  if (filter.platform) params.platform = filter.platform;
  if (filter.status) params.status = filter.status;
  if (filter.shop) params.shop = filter.shop;
  if (filter.q) params.q = filter.q;
  return params;
}

export function useSharedConversations(filter: ConversationFilter = {}) {
  const filterKey = buildFilterKey(filter);
  const filterParams = buildFilterParams(filter);
  const pageSize = filter.pageSize || filter.limit || 200;
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
    activePageSize = pageSize;
    fetchHead(filterKey, filterParams, pageSize, false);
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
    await fetchHead(filterKey, filterParams, pageSize, false);
  }, [filterKey, filterParams, pageSize]);

  // ⚡ loadMore — เรียกตอน scroll ใกล้ล่างเพื่อโหลด page ถัดไป
  const loadMore = useCallback(async () => {
    await fetchTail(filterKey, filterParams, pageSize);
  }, [filterKey, filterParams, pageSize]);

  // ⚡ conversations = head + tail — ใช้ ref-based comparison แทน useMemo
  //   useMemo dep บน module-level store ไม่เสถียรในบางกรณี → infinite loop
  //   ใช้ ref เก็บ reference เดิม + เปรียบเทียบโดยตรง → ได้ reference เดียวกันถ้า head/tail ไม่เปลี่ยน
  const prevConvsRef = useRef<Conversation[]>(EMPTY_CONVERSATIONS);
  const prevHeadRef = useRef<Conversation[] | null>(null);
  const prevTailRef = useRef<Conversation[] | null>(null);
  const prevFilterKeyRef = useRef<string>("");
  let allConversations: Conversation[];
  if (store.filterKey !== filterKey) {
    allConversations = EMPTY_CONVERSATIONS;
  } else if (store.head === prevHeadRef.current && store.tail === prevTailRef.current && filterKey === prevFilterKeyRef.current) {
    // head/tail เดิม → ใช้ reference เดิม (กัน infinite loop)
    allConversations = prevConvsRef.current;
  } else {
    allConversations = store.head.length === 0 ? store.tail
      : store.tail.length === 0 ? store.head
      : [...store.head, ...store.tail];
    prevConvsRef.current = allConversations;
    prevHeadRef.current = store.head;
    prevTailRef.current = store.tail;
    prevFilterKeyRef.current = filterKey;
  }

  return {
    conversations: allConversations,
    totalCount: store.filterKey === filterKey ? store.totalCount : 0,
    loading: store.filterKey === filterKey ? store.loading : true,
    loadingMore: store.filterKey === filterKey ? store.loadingMore : false,
    hasMore: store.filterKey === filterKey ? store.hasMore : false,
    error: store.filterKey === filterKey ? store.error : null,
    refresh,
    loadMore,
  };
}

// ⚡ ใช้สำหรับ invalidate cache เมื่อมี mutation (send/assign/close)
export function invalidateSharedConversations() {
  store = { ...store, lastFetch: 0 };
  // trigger immediate refetch on next poll (head only — tail ไม่ reset)
  fetchHead(activeFilterKey, activeFilter, activePageSize, false).catch(() => {});
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/apiClient";
import type { Conversation } from "@/lib/types";

interface PinRecord {
  conversation_id: string;
  pin_global: boolean;
  pin_personal: boolean;
}

export function useInboxPins(scope: "tickets" | "botworker", assignedTo: string, q: string, filters: string) {
  const [rows, setRows] = useState<Conversation[]>([]);
  const [canPin, setCanPin] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const pins = await api().get<{ rows: PinRecord[]; can_pin: boolean }>("/conversation-pins", { params: { scope } });
      if (request === sequence.current) setCanPin(pins.data.can_pin === true);
      const records = pins.data.rows || [];
      if (!records.length) {
        if (request === sequence.current) setRows([]);
        return;
      }
      const path = scope === "tickets" ? "/admin/conversations" : "/botworker/conversations";
      const pages = await Promise.all(Array.from({ length: Math.ceil(records.length / 100) }, (_, index) => {
        const ids = records.slice(index * 100, (index + 1) * 100).map((pin) => pin.conversation_id);
        return api().get<{ rows: Conversation[] }>(path, { params: {
          assigned_to: assignedTo, q: q || undefined, filters, pin_ids: JSON.stringify(ids),
          limit: String(ids.length), include_count: "true",
        } });
      }));
      if (request !== sequence.current) return;
      const pinMap = new Map(records.map((record) => [record.conversation_id, record]));
      const unique = new Map<string, Conversation>();
      for (const page of pages) for (const row of page.data.rows || []) {
        const pin = pinMap.get(row.id);
        if (pin) unique.set(row.id, { ...row, pin_global: pin.pin_global, pin_personal: pin.pin_personal });
      }
      const order = (JSON.parse(filters) as { sort?: string }).sort;
      setRows([...unique.values()].sort((a, b) => {
        const rank = Number(!!b.pin_personal) - Number(!!a.pin_personal) ||
          Number(!!b.pin_global) - Number(!!a.pin_global);
        if (rank) return rank;
        if (order === "name") return a.customer_name.localeCompare(b.customer_name, "th");
        const time = new Date(a.last_timestamp).getTime() - new Date(b.last_timestamp).getTime();
        return order === "oldest" ? time : -time;
      }));
    } catch {
      // Keep the last visible pin list on a transient read failure.
    }
  }, [scope, assignedTo, q, filters]);
  useEffect(() => {
    setRows([]);
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => { sequence.current += 1; clearInterval(timer); };
  }, [refresh]);
  return { rows, refresh, canPin };
}

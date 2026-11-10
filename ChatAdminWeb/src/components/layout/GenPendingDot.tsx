"use client";
// จุดแดงแจ้ง generation รอ accept — poll /admin/generations?status=pending ทุก 30s
import React, { useEffect, useState } from "react";
import { api } from "@/lib/apiClient";

export function GenPendingDot({ collapsed }: { collapsed?: boolean }) {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const r = await api().get<{ runs: { status: string }[] }>(
          "/chatbot/shopee/admin/generations?status=pending");
        if (!dead) setPending((r.data.runs || []).length);
      } catch { /* poll best-effort */ }
    };
    tick();
    const t = setInterval(tick, 30000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  if (!pending) return null;
  return (
    <span className={collapsed
      ? "absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400 animate-pulse-soft"
      : "w-2 h-2 rounded-full bg-amber-400 animate-pulse-soft shrink-0"}
      title={`${pending} generation รอ accept`} />
  );
}

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
        const mode = await api().get<{ python_tools_available: boolean }>("/system/chat-engine");
        if (dead) return;
        if (!mode.data.python_tools_available) {
          setPending(0);
          return;
        }
        const r = await api().get<{ runs: { status: string }[]; unavailable?: boolean }>(
          "/generations/pending?status=pending");
        if (r.data.unavailable) { setPending(0); return; }
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

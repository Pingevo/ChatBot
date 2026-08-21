// Toast — global notification system (zustand store + renderer)
// ใช้: import { toast } from "@/components/ui/Toast"
//       toast.error("ลบไม่สำเร็จ")
//       toast.success("บันทึกแล้ว")
//       toast.info("กำลังโหลด...")
"use client";
import { create } from "zustand";
import { useCallback, useEffect } from "react";
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from "lucide-react";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  add: (type: ToastType, message: string, duration?: number) => void;
  remove: (id: string) => void;
}

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (type, message, duration = 4000) => {
    const id = "t_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    set((s) => ({ toasts: [...s.toasts, { id, type, message, duration }] }));
    // auto-remove
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, duration);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (msg: string, dur?: number) => useToastStore.getState().add("success", msg, dur),
  error: (msg: string, dur?: number) => useToastStore.getState().add("error", msg, dur ?? 6000),
  info: (msg: string, dur?: number) => useToastStore.getState().add("info", msg, dur),
  warning: (msg: string, dur?: number) => useToastStore.getState().add("warning", msg, dur ?? 6000),
};

const config: Record<ToastType, { icon: typeof CheckCircle2; bg: string; border: string; text: string }> = {
  success: { icon: CheckCircle2, bg: "bg-green-50", border: "border-green-200", text: "text-green-800" },
  error: { icon: XCircle, bg: "bg-red-50", border: "border-red-200", text: "text-red-800" },
  info: { icon: Info, bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-800" },
  warning: { icon: AlertTriangle, bg: "bg-yellow-50", border: "border-yellow-200", text: "text-yellow-800" },
};

export function ToastContainer() {
  const { toasts, remove } = useToastStore();

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((t) => {
        const c = config[t.type];
        const Icon = c.icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2.5 ${c.bg} ${c.border} ${c.text} border rounded-lg shadow-lg px-4 py-3 animate-slide-in`}
          >
            <Icon size={18} className="shrink-0 mt-0.5" />
            <div className="flex-1 text-sm leading-snug">{t.message}</div>
            <button
              onClick={() => remove(t.id)}
              className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * useToastError — helper hook สำหรับ catch error แล้วแสดง toast อัตโนมัติ
 * ใช้: const { catchError } = useToastError()
 *       try { ... } catch (e) { catchError(e, "ลบไม่สำเร็จ") }
 */
export function useToastError() {
  const catchError = useCallback((err: unknown, fallbackMsg: string) => {
    console.error(fallbackMsg, err);
    const msg =
      (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
      (err as Error)?.message ||
      fallbackMsg;
    toast.error(`${fallbackMsg}: ${msg}`);
  }, []);
  return { catchError };
}

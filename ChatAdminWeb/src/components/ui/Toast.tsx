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

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
  add: (type: ToastType, message: string, duration?: number, action?: ToastAction) => void;
  remove: (id: string) => void;
}

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (type, message, duration = 4000, action) => {
    const id = "t_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
    set((s) => ({ toasts: [...s.toasts, { id, type, message, duration, action }] }));
    // auto-remove (duration 0 = persistent until dismissed)
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (msg: string, dur?: number, action?: ToastAction) => useToastStore.getState().add("success", msg, dur, action),
  error: (msg: string, dur?: number, action?: ToastAction) => useToastStore.getState().add("error", msg, dur ?? 6000, action),
  info: (msg: string, dur?: number, action?: ToastAction) => useToastStore.getState().add("info", msg, dur, action),
  warning: (msg: string, dur?: number, action?: ToastAction) => useToastStore.getState().add("warning", msg, dur ?? 6000, action),
};

const config: Record<ToastType, { icon: typeof CheckCircle2; bg: string; border: string; text: string }> = {
  success: { icon: CheckCircle2, bg: "bg-success/5", border: "border-success/20", text: "text-success-dark" },
  error: { icon: XCircle, bg: "bg-error/5", border: "border-error/20", text: "text-error" },
  info: { icon: Info, bg: "bg-info/5", border: "border-info/20", text: "text-info-dark" },
  warning: { icon: AlertTriangle, bg: "bg-warning/5", border: "border-warning/20", text: "text-warning" },
};

export function ToastContainer() {
  const { toasts, remove } = useToastStore();

  return (
    // 🔒 P2a: aria-live region for screen reader announcements
    // role="alert" on error toasts, aria-live="polite" on the container for others
    <div
      className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => {
        const c = config[t.type];
        const Icon = c.icon;
        return (
          <div
            key={t.id}
            role={t.type === "error" || t.type === "warning" ? "alert" : "status"}
            className={`pointer-events-auto flex items-start gap-2.5 ${c.bg} ${c.border} ${c.text} border rounded-lg shadow-lg px-4 py-3 animate-slide-in`}
          >
            <Icon size={18} className="shrink-0 mt-0.5" />
            <div className="flex-1 text-sm leading-snug">{t.message}</div>
            {t.action && (
              <button
                onClick={() => { t.action?.onClick(); remove(t.id); }}
                className="shrink-0 text-xs font-semibold underline hover:no-underline transition-all"
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => remove(t.id)}
              title="ปิด" aria-label="ปิด"
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

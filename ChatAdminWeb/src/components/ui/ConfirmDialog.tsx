// ConfirmDialog — confirmation modal สำหรับยืนยันการกระทำสำคัญ
// ใช้ผ่าน zustand store: import { confirm } from "@/components/ui/ConfirmDialog"
//   const ok = await confirm.ask("ยืนยันการลบ?", "คุณแน่ใจหรือไม่ว่าต้องการลบรายการนี้?")
//   if (ok) { ... }
"use client";
import { create } from "zustand";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "primary";
}

interface ConfirmState {
  open: boolean;
  options: ConfirmOptions | null;
  resolver: ((ok: boolean) => void) | null;
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set) => ({
  open: false,
  options: null,
  resolver: null,
  ask: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, options: opts, resolver: resolve });
    }),
  resolve: (ok) => {
    set((s) => {
      if (s.resolver) s.resolver(ok);
      return { open: false, options: null, resolver: null };
    });
  },
}));

export const confirm = {
  ask: (opts: ConfirmOptions) => useConfirmStore.getState().ask(opts),
};

export function ConfirmDialog() {
  const { open, options, resolve } = useConfirmStore();
  if (!open || !options) return null;

  const isDanger = options.variant === "danger";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onClick={() => resolve(false)}
    >
      <div
        className="bg-surface rounded-xl shadow-xl max-w-sm w-full p-5 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
              isDanger ? "bg-vibrant-coral/15" : "bg-brand/15"
            }`}
          >
            <AlertTriangle size={20} className={isDanger ? "text-vibrant-coral" : "text-brand"} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-text">{options.title}</h3>
            {options.message && (
              <p className="text-xs text-text-muted mt-1 leading-relaxed">{options.message}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 mt-4 justify-end">
          <Button variant="outline" size="sm" onClick={() => resolve(false)}>
            {options.cancelText || "ยกเลิก"}
          </Button>
          <Button variant={isDanger ? "danger" : "primary"} size="sm" onClick={() => resolve(true)}>
            {options.confirmText || "ยืนยัน"}
          </Button>
        </div>
      </div>
    </div>
  );
}

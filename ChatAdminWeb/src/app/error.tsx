// error.tsx — หน้า error สำหรับ Next.js App Router (catches errors in routes)
"use client";
import { AlertCircle } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-error/10 flex items-center justify-center">
        <AlertCircle size={32} className="text-error" />
      </div>
      <div>
        <h1 className="text-xl font-bold text-text mb-1">เกิดข้อผิดพลาดในหน้านี้</h1>
        <p className="text-sm text-text-muted">
          {error.message || "ไม่สามารถโหลดหน้านี้ได้ กรุณาลองใหม่"}
        </p>
      </div>
      <button
        onClick={() => reset()}
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark transition-colors"
      >
        ลองใหม่
      </button>
    </div>
  );
}

// global-error.tsx — หน้า error สำหรับ Next.js App Router (catches errors in root layout)
"use client";
import { useEffect } from "react";
import { AlertCircle } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Global error:", error);
  }, [error]);

  return (
    <html>
      <body>
        <div className="h-screen flex flex-col items-center justify-center auth-gradient-bg gap-4 px-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-error/10 flex items-center justify-center">
            <AlertCircle size={32} className="text-error" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-text mb-2">เกิดข้อผิดพลาด</h1>
            <p className="text-sm text-text-muted">
              ระบบไม่สามารถดำเนินการต่อได้ กรุณาลองใหม่อีกครั้ง
            </p>
          </div>
          <button
            onClick={() => reset()}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark transition-colors"
          >
            ลองใหม่
          </button>
        </div>
      </body>
    </html>
  );
}

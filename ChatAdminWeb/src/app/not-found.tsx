// not-found.tsx — หน้า 404 สำหรับ Next.js App Router
import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="h-screen flex flex-col items-center justify-center auth-gradient-bg gap-4 px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-brand/10 flex items-center justify-center">
        <Compass size={32} className="text-brand" />
      </div>
      <div>
        <h1 className="text-2xl font-bold text-text mb-2">ไม่พบหน้าที่ค้นหา</h1>
        <p className="text-sm text-text-muted">หน้าที่คุณกำลังมองหาอาจถูกย้ายหรือลบไปแล้ว</p>
      </div>
      <Link
        href="/dashboard"
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark transition-colors"
      >
        กลับหน้าแดชบอร์ด
      </Link>
    </div>
  );
}

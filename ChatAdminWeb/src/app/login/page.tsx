"use client";
// /login — SSO login page
// ปุ่ม "เข้าสู่ระบบด้วย SSO" จะ redirect ไป /api/auth/sso/login → system81 login
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Loading } from "@/components/ui/Loading";

const ERROR_MESSAGES: Record<string, string> = {
  sso_failed: "การเข้าสู่ระบบผ่าน ITSR ไม่สำเร็จ กรุณาลองใหม่",
  no_token: "ไม่ได้รับ token จาก ITSR กรุณาลองใหม่",
  userinfo_failed: "ไม่สามารถตรวจสอบ token กับ ITSR ได้",
  invalid_token: "ITSR token ไม่ถูกต้อง",
  not_allowed: "บัญชี ITSR นี้ไม่มีสิทธิ์เข้าถึง Chat Admin",
  account_disabled: "บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ",
};

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, initialized, fetchMe } = useAuth();
  const errorCode = searchParams.get("error");
  const errorMsg = errorCode ? ERROR_MESSAGES[errorCode] || "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" : null;

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    if (initialized && user) router.replace("/dashboard");
  }, [initialized, user, router]);

  if (initialized && user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center auth-gradient-bg gap-3">
        <Loading size={32} />
        <p className="text-pale-sky/70 text-sm">กำลังเข้าระบบ...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center auth-gradient-bg px-4 py-8">
      <div className="w-full max-w-sm bg-surface rounded-2xl shadow-[var(--shadow-xl)] p-8 space-y-6 ring-1 ring-black/5">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-accent flex items-center justify-center font-bold text-white text-2xl mx-auto shadow-lg shadow-accent/30">
            IT
          </div>
          <div>
            <h1 className="text-xl font-bold text-text tracking-tight">ITSRC Panel</h1>
            <p className="text-sm text-text-muted mt-1">ระบบบริหารแชทและทีมซัพพอร์ต</p>
          </div>
        </div>

        {errorMsg && (
          <div className="bg-error-soft text-error text-sm rounded-lg px-3 py-2.5 text-center border border-error/20">
            {errorMsg}
          </div>
        )}

        <a
          href="/api/auth/sso/login"
          className="w-full h-11 rounded-lg bg-brand text-white font-medium flex items-center justify-center hover:bg-brand-dark transition-all duration-150 shadow-sm hover:shadow-[var(--shadow-brand)]"
        >
          เข้าสู่ระบบด้วย SSO
        </a>

        <p className="text-xs text-text-subtle text-center leading-relaxed">
          ระบบใช้ Single Sign-On ขององค์กร — กรุณาติดต่อผู้ดูแลระบบหากไม่สามารถเข้าได้
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="h-screen flex flex-col items-center justify-center auth-gradient-bg">
        <Loading size={32} />
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}

"use client";
import { useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Loading } from "@/components/ui/Loading";
import { authService } from "@/lib/authService";
import { Mail, CheckCircle2, ArrowLeft } from "lucide-react";

type Step = "request" | "confirm" | "done";

function Logo() {
  return (
    <div className="flex flex-col items-center mb-6">
      <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mb-4 shadow-lg">
        <span className="text-white font-bold text-lg">IT</span>
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[420px] bg-surface rounded-2xl shadow-2xl p-8 animate-fade-in">
      {children}
    </div>
  );
}

function ResetForm() {
  const { resetConfirm, loading, error, clearError } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const tokenFromUrl = params.get("token") ?? "";

  const [step, setStep] = useState<Step>(tokenFromUrl ? "confirm" : "request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [requestSent, setRequestSent] = useState(false);

  async function handleRequest(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    try {
      await authService.resetRequest(email);
      setRequestSent(true);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "ไม่สามารถส่งอีเมลได้";
      setLocalError(msg);
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (password !== confirm) {
      setLocalError("รหัสผ่านไม่ตรงกัน");
      return;
    }
    if (password.length < 8) {
      setLocalError("รหัสผ่านต้องอย่างน้อย 8 ตัวอักษร");
      return;
    }
    const ok = await resetConfirm(tokenFromUrl, password);
    if (ok) setStep("done");
  }

  // ---- Step: done ----
  if (step === "done") {
    return (
      <Card>
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-brand-soft flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 size={32} className="text-brand" />
          </div>
          <h2 className="text-lg font-bold text-deep-space mb-2">รีเซ็ตรหัสผ่านสำเร็จ</h2>
          <p className="text-sm text-text-muted mb-6">กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่</p>
          <Button size="lg" className="w-full" onClick={() => router.push("/login")}>
            ไปหน้าเข้าสู่ระบบ
          </Button>
        </div>
      </Card>
    );
  }

  // ---- Step: request sent ----
  if (requestSent) {
    return (
      <Card>
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-pale-sky-soft flex items-center justify-center mx-auto mb-4">
            <Mail size={28} className="text-deep-space" />
          </div>
          <h2 className="text-lg font-bold text-deep-space mb-2">ส่งลิงก์รีเซ็ตแล้ว</h2>
          <p className="text-sm text-text-muted mb-6">
            หากอีเมล <span className="font-medium text-text">{email}</span> มีในระบบ
            จะได้รับลิงก์รีเซ็ตรหัสผ่านภายในไม่กี่นาที
          </p>
          <Button size="lg" variant="outline" className="w-full" onClick={() => router.push("/login")}>
            <ArrowLeft size={16} /> กลับไปหน้าเข้าสู่ระบบ
          </Button>
        </div>
      </Card>
    );
  }

  // ---- Step: request ----
  if (step === "request") {
    return (
      <Card>
        <Logo />
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-deep-space">รีเซ็ตรหัสผ่าน</h1>
          <p className="text-text-muted text-sm mt-1">กรุณากรอกอีเมลเพื่อรีเซ็ตรหัสผ่าน</p>
        </div>
        <form onSubmit={handleRequest} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">อีเมลระบบ</label>
            <input
              type="email"
              placeholder="name@itsrc.co.th"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (localError) setLocalError(null); }}
              required
              autoFocus
              className="w-full h-11 px-3.5 rounded-lg bg-surface-2 border border-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-brand focus:bg-surface transition-colors"
            />
          </div>
          {localError && (
            <div className="text-sm text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">
              {localError}
            </div>
          )}
          <button
            type="submit"
            className="w-full h-12 rounded-xl bg-brand hover:bg-brand-dark text-white font-semibold text-base transition-colors mt-2"
          >
            ส่งลิงก์รีเซ็ต
          </button>
        </form>
        <div className="mt-5 text-center">
          <button
            onClick={() => router.push("/login")}
            className="text-sm text-brand hover:underline"
          >
            กลับไปหน้าเข้าสู่ระบบ
          </button>
        </div>
      </Card>
    );
  }

  // ---- Step: confirm (from email link) ----
  return (
    <Card>
      <Logo />
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-deep-space">ตั้งรหัสผ่านใหม่</h1>
        <p className="text-text-muted text-sm mt-1">กรอกรหัสผ่านใหม่ของคุณ</p>
      </div>
      {!tokenFromUrl && (
        <div className="mb-4 text-sm text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">
          ไม่พบ token ในลิงก์ — กรุณาเปิดลิงก์ที่ได้รับจากอีเมล
        </div>
      )}
      <form onSubmit={handleConfirm} className="space-y-4">
        <Input
          label="รหัสผ่านใหม่"
          type="password"
          placeholder="อย่างน้อย 8 ตัวอักษร"
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (error || localError) { clearError(); setLocalError(null); } }}
          required
          minLength={8}
          autoFocus
        />
        <Input
          label="ยืนยันรหัสผ่านใหม่"
          type="password"
          placeholder="••••••••"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); if (error || localError) { clearError(); setLocalError(null); } }}
          required
        />
        {(error || localError) && (
          <div className="text-sm text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">
            {localError ?? error}
          </div>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={loading || !tokenFromUrl}>
          {loading ? <Loading size={18} /> : "ตั้งรหัสผ่านใหม่"}
        </Button>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center auth-gradient-bg p-4">
      <Suspense fallback={<div className="text-white"><Loading size={24} /></div>}>
        <ResetForm />
      </Suspense>
    </div>
  );
}

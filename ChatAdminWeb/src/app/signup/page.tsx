"use client";
import { useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Loading } from "@/components/ui/Loading";
import { MessageSquare, UserPlus, CheckCircle2 } from "lucide-react";

function SignupForm() {
  const { signupConfirm, loading, error, clearError } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!token) {
      setLocalError("ไม่พบ token ในลิงก์ กรุณาตรวจสอบลิงก์ที่ได้รับ");
      return;
    }
    if (password !== confirm) {
      setLocalError("รหัสผ่านไม่ตรงกัน");
      return;
    }
    if (password.length < 8) {
      setLocalError("รหัสผ่านต้องอย่างน้อย 8 ตัวอักษร");
      return;
    }
    const ok = await signupConfirm(token, username, password, name);
    if (ok) setDone(true);
  }

  if (done) {
    return (
      <div className="w-full max-w-sm">
        <div className="bg-surface rounded-2xl shadow-xl p-8 text-center animate-fade-in">
          <div className="w-14 h-14 rounded-full bg-brand-soft flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 size={32} className="text-brand" />
          </div>
          <h2 className="text-lg font-bold text-text mb-2">สมัครสมาชิกสำเร็จ</h2>
          <p className="text-sm text-text-muted mb-6">กรุณาเข้าสู่ระบบเพื่อเริ่มใช้งาน</p>
          <Button size="lg" className="w-full" onClick={() => router.push("/login")}>
            ไปหน้าเข้าสู่ระบบ
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col items-center mb-8">
        <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mb-3 shadow-lg">
          <UserPlus size={28} className="text-white" />
        </div>
        <h1 className="text-2xl font-bold text-white">สมัครสมาชิก</h1>
        <p className="text-pale-sky/70 text-sm mt-1">กรอกข้อมูลเพื่อสร้างบัญชีแอดมิน</p>
      </div>

      <div className="bg-surface rounded-2xl shadow-xl p-6 animate-fade-in">
        {!token && (
          <div className="mb-4 text-sm text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">
            ไม่พบ token ในลิงก์ — กรุณาเปิดลิงก์ที่ได้รับจากอีเมล
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="ชื่อผู้ใช้"
            placeholder="username"
            value={username}
            onChange={(e) => { setUsername(e.target.value); if (error || localError) { clearError(); setLocalError(null); } }}
            required
            minLength={3}
            autoFocus
          />
          <Input
            label="ชื่อ-นามสกุล (ไม่บังคับ)"
            placeholder="ชื่อ นามสกุล"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label="รหัสผ่าน"
            type="password"
            placeholder="อย่างน้อย 8 ตัวอักษร"
            value={password}
            onChange={(e) => { setPassword(e.target.value); if (error || localError) { clearError(); setLocalError(null); } }}
            required
            minLength={8}
          />
          <Input
            label="ยืนยันรหัสผ่าน"
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

          <Button type="submit" size="lg" className="w-full" disabled={loading || !token}>
            {loading ? <Loading size={18} /> : "สมัครสมาชิก"}
          </Button>
        </form>

        <div className="mt-5 pt-5 border-t border-border text-center">
          <button
            onClick={() => router.push("/login")}
            className="text-sm text-text-muted hover:text-brand transition-colors"
          >
            มีบัญชีแล้ว? เข้าสู่ระบบ
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center auth-gradient-bg p-4">
      <Suspense fallback={<div className="text-white"><Loading size={24} /></div>}>
        <SignupForm />
      </Suspense>
    </div>
  );
}

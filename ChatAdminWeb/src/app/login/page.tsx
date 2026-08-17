"use client";
import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/authStore";
import { Loading } from "@/components/ui/Loading";
import { Eye, EyeOff } from "lucide-react";

export default function LoginPage() {
  const { login, loading, error, clearError } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await login(email, password);
    if (ok) router.push("/chats");
  }

  return (
    <div className="min-h-screen flex items-center justify-center auth-gradient-bg p-4">
      <div className="w-full max-w-[420px] bg-surface rounded-2xl shadow-2xl p-8 animate-fade-in">
        {/* Logo */}
        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-brand flex items-center justify-center mb-4 shadow-lg">
            <span className="text-white font-bold text-lg">IT</span>
          </div>
          <h1 className="text-2xl font-bold text-deep-space tracking-wide">ITSRC PANEL</h1>
          <p className="text-text-muted text-sm mt-1">ระบบจัดการห้องแชทอัจฉริยะ</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">อีเมลผู้ใช้งาน</label>
            <input
              type="email"
              placeholder="name@itsrc.co.th"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (error) clearError(); }}
              required
              autoFocus
              className="w-full h-11 px-3.5 rounded-lg bg-surface-2 border border-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-brand focus:bg-surface transition-colors"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-text">รหัสผ่าน</label>
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="text-xs font-medium text-brand hover:underline"
              >
                {showPassword ? "ซ่อน" : "แสดง"}
              </button>
            </div>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (error) clearError(); }}
                required
                className="w-full h-11 px-3.5 pr-10 rounded-lg bg-surface-2 border border-transparent text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-brand focus:bg-surface transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-subtle hover:text-text-muted"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="text-sm text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 rounded-xl bg-brand hover:bg-brand-dark text-white font-semibold text-base transition-colors disabled:opacity-60 flex items-center justify-center mt-2"
          >
            {loading ? <Loading size={18} /> : "เข้าสู่ระบบ"}
          </button>
        </form>

        <div className="mt-5 text-center">
          <button
            onClick={() => router.push("/reset-password")}
            className="text-sm text-brand hover:underline"
          >
            ลืมรหัสผ่าน?
          </button>
        </div>
      </div>
    </div>
  );
}

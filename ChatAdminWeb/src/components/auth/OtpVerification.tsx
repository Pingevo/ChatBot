"use client";
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Loading } from "@/components/ui/Loading";
import { ShieldCheck, RefreshCw } from "lucide-react";
import { api } from "@/lib/apiClient";

interface Props {
  purpose: string;
  onVerified: () => void;
  onCancel: () => void;
}

export function OtpVerification({ purpose, onVerified, onCancel }: Props) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Request OTP on mount
  useEffect(() => {
    requestOtp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  async function requestOtp() {
    setRequesting(true);
    setError(null);
    setInfo(null);
    try {
      const r = await api().post<{
        message: string;
        email_sent: boolean;
        dev_mode: boolean;
        dev_code?: string;
        expires_in_minutes: number;
      }>("/auth/otp/request", { purpose });
      setInfo(r.data.message);
      setDevCode(r.data.dev_code ?? null);
      setSecondsLeft(r.data.expires_in_minutes * 60);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "ขอ OTP ไม่สำเร็จ";
      setError(msg);
    } finally {
      setRequesting(false);
    }
  }

  function handleChange(i: number, val: string) {
    const v = val.replace(/\D/g, "").slice(0, 1);
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    setError(null);
    if (v && i < 5) inputsRef.current[i + 1]?.focus();
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      inputsRef.current[i - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (text.length > 0) {
      const next = text.split("");
      while (next.length < 6) next.push("");
      setDigits(next);
      inputsRef.current[Math.min(text.length, 5)]?.focus();
    }
  }

  async function handleVerify() {
    const code = digits.join("");
    if (code.length !== 6) {
      setError("กรุณากรอกรหัส 6 หลักให้ครบ");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api().post("/auth/otp/verify", { code });
      onVerified();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "รหัสไม่ถูกต้อง";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-text">
        <ShieldCheck size={20} className="text-brand" />
        <span className="text-sm font-medium">ยืนยันตัวตนด้วย OTP</span>
      </div>

      <p className="text-xs text-text-muted">
        สำหรับ{purpose} — ระบบส่งรหัส 6 หลักไปยังอีเมลของคุณ
      </p>

      {info && (
        <div className="text-xs bg-brand-soft text-brand rounded-lg px-3 py-2">{info}</div>
      )}

      {devCode && (
        <div className="text-xs bg-surface-2 rounded-lg px-3 py-2 border border-dashed border-border">
          <span className="text-text-subtle">Dev mode — รหัส OTP: </span>
          <span className="font-mono font-bold text-deep-space">{devCode}</span>
        </div>
      )}

      {/* OTP input */}
      <div className="flex justify-center gap-2" onPaste={handlePaste}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { inputsRef.current[i] = el; }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={d}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            className="w-11 h-14 text-center text-xl font-bold rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
            autoFocus={i === 0}
          />
        ))}
      </div>

      {error && (
        <div className="text-xs text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">{error}</div>
      )}

      {/* Resend */}
      <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
        {secondsLeft > 0 ? (
          <span>ขอรหัสใหม่ได้ใน {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</span>
        ) : (
          <button
            onClick={requestOtp}
            disabled={requesting}
            className="inline-flex items-center gap-1 text-brand hover:underline disabled:opacity-50"
          >
            <RefreshCw size={12} /> ขอรหัสใหม่
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={onCancel}>
          ยกเลิก
        </Button>
        <Button className="flex-1" onClick={handleVerify} disabled={loading || digits.join("").length !== 6}>
          {loading ? <Loading size={16} /> : "ยืนยัน"}
        </Button>
      </div>
    </div>
  );
}

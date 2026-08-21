"use client";
import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { useAuth } from "@/lib/authStore";
import { canEdit } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { OtpVerification } from "@/components/auth/OtpVerification";
import { Shield, Key, Bell, Save, CheckCircle2, Mail } from "lucide-react";

export default function SettingsPage() {
  const { user, fetchMe } = useAuth();
  const editable = canEdit(user);
  const { catchError } = useToastError();

  // Profile
  const [name, setName] = useState(user?.name ?? "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // Password
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState(false);

  // Notifications (local state only — no backend yet)
  const [notifNewTicket, setNotifNewTicket] = useState(true);
  const [notifHandoff, setNotifHandoff] = useState(true);
  const [notifUnanswered, setNotifUnanswered] = useState(true);

  async function handleSaveProfile() {
    if (!name.trim()) return;
    const ok = await confirm.ask({
      title: "บันทึกโปรไฟล์?",
      message: "ยืนยันการเปลี่ยนชื่อของคุณ",
      confirmText: "บันทึก",
    });
    if (!ok) return;
    setSavingProfile(true);
    try {
      await api().patch("/profile", { name: name.trim() });
      await fetchMe?.();
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
      toast.success("บันทึกโปรไฟล์แล้ว");
    } catch (e: unknown) {
      catchError(e, "บันทึกไม่สำเร็จ");
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleChangePassword() {
    setPwdError(null);
    if (!currentPwd || !newPwd || !confirmPwd) {
      setPwdError("กรุณากรอกข้อมูลให้ครบ");
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdError("รหัสผ่านใหม่ไม่ตรงกัน");
      return;
    }
    if (newPwd.length < 8) {
      setPwdError("รหัสผ่านใหม่ต้องอย่างน้อย 8 ตัวอักษร");
      return;
    }
    setShowOtp(true);
  }

  async function handleOtpVerified() {
    setPwdLoading(true);
    setPwdError(null);
    try {
      await api().post("/profile/password", {
        current_password: currentPwd,
        new_password: newPwd,
        otp_code: "", // OTP already consumed by verify endpoint; backend re-checks
      });
      setPwdSuccess(true);
      setShowOtp(false);
      setCurrentPwd("");
      setNewPwd("");
      setConfirmPwd("");
      setTimeout(() => setPwdSuccess(false), 3500);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "เปลี่ยนรหัสผ่านไม่สำเร็จ";
      setPwdError(msg);
      setShowOtp(false);
    } finally {
      setPwdLoading(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Page header */}
      <div className="px-4 md:px-8 pt-6 pb-4 border-b border-border bg-surface">
        <h1 className="text-xl font-bold text-text">โปรไฟล์และการตั้งค่า</h1>
        <p className="text-sm text-text-muted mt-1">จัดการบัญชีและความปลอดภัยของคุณ</p>
      </div>

      <div className="p-4 md:p-8 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Profile */}
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Shield size={18} className="text-deep-space" />
            <h3 className="font-semibold text-text">บัญชี</h3>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-text mb-1.5">ชื่อ</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!editable}
                className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1.5">อีเมล</label>
              <input
                value={user?.email ?? ""}
                disabled
                className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text-muted"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1.5">ชื่อผู้ใช้</label>
              <input
                value={user?.username ?? ""}
                disabled
                className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text-muted"
              />
            </div>
            <div>
              <span className="block text-sm font-medium text-text mb-1.5">บทบาท</span>
              <Badge tone="deep">{user?.role ?? "admin"}</Badge>
            </div>
            {editable && (
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={handleSaveProfile} disabled={savingProfile || !name.trim()}>
                  {savingProfile ? <Loading size={14} /> : <Save size={14} />} บันทึก
                </Button>
                {profileSaved && (
                  <span className="flex items-center gap-1 text-xs text-brand">
                    <CheckCircle2 size={14} /> บันทึกแล้ว
                  </span>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* Security — change password with OTP */}
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Key size={18} className="text-brand" />
            <h3 className="font-semibold text-text">ความปลอดภัย</h3>
          </div>

          {pwdSuccess ? (
            <div className="flex items-center gap-2 text-sm text-brand bg-brand-soft rounded-lg px-3 py-3">
              <CheckCircle2 size={18} />
              เปลี่ยนรหัสผ่านสำเร็จ
            </div>
          ) : showOtp ? (
            <OtpVerification
              purpose="เปลี่ยนรหัสผ่าน"
              onVerified={handleOtpVerified}
              onCancel={() => setShowOtp(false)}
            />
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">รหัสผ่านปัจจุบัน</label>
                <input
                  type="password"
                  value={currentPwd}
                  onChange={(e) => setCurrentPwd(e.target.value)}
                  placeholder="••••••••"
                  disabled={!editable}
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">รหัสผ่านใหม่</label>
                <input
                  type="password"
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder="อย่างน้อย 8 ตัวอักษร"
                  disabled={!editable}
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">ยืนยันรหัสผ่านใหม่</label>
                <input
                  type="password"
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  placeholder="••••••••"
                  disabled={!editable}
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
                />
              </div>
              {pwdError && (
                <div className="text-xs text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">
                  {pwdError}
                </div>
              )}
              <p className="text-xs text-text-muted flex items-center gap-1">
                <Mail size={11} /> ระบบจะส่งรหัส OTP ไปยังอีเมลของคุณเพื่อยืนยัน
              </p>
              {editable && (
                <Button size="sm" onClick={handleChangePassword} disabled={pwdLoading}>
                  {pwdLoading ? <Loading size={14} /> : <Key size={14} />} เปลี่ยนรหัสผ่าน
                </Button>
              )}
            </div>
          )}
        </Card>

        {/* Notifications */}
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <Bell size={18} className="text-pale-sky" />
            <h3 className="font-semibold text-text">การแจ้งเตือน</h3>
          </div>
          <div className="space-y-3">
            {[
              { label: "แจ้งเตือนเมื่อมีตั๋วใหม่", value: notifNewTicket, set: setNotifNewTicket },
              { label: "แจ้งเตือนเมื่อบอทส่งต่อแอดมิน", value: notifHandoff, set: setNotifHandoff },
              { label: "แจ้งเตือนแชทที่ยังไม่ตอบเกิน 30 นาที", value: notifUnanswered, set: setNotifUnanswered },
            ].map((item) => (
              <label
                key={item.label}
                className="flex items-center justify-between text-sm text-text cursor-pointer"
              >
                <span>{item.label}</span>
                <button
                  type="button"
                  onClick={() => item.set(!item.value)}
                  disabled={!editable}
                  className={`w-10 h-5 rounded-full transition-colors ${
                    item.value ? "bg-brand" : "bg-surface-2"
                  } disabled:opacity-60`}
                >
                  <div
                    className={`w-4 h-4 bg-white rounded-full transition-transform ${
                      item.value ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </label>
            ))}
            <p className="text-[11px] text-text-subtle pt-2">
              การตั้งค่านี้ยังเก็บในเครื่อง — จะเชื่อมกับ backend ในรอบถัดไป
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

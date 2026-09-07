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
import { Shield, Bell, Save, CheckCircle2 } from "lucide-react";

export default function SettingsPage() {
  const { user, fetchMe } = useAuth();
  const editable = canEdit(user);
  const { catchError } = useToastError();

  // Profile
  const [name, setName] = useState(user?.name ?? "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  // ⚡ Bubble color — สี bubble ของตัวเองในแชท
  const DEFAULT_BUBBLE_COLOR = "#560C0E";
  const PRESET_COLORS = [
    "#560C0E", // แดงเข้ม (default)
    "#0b2340", // navy
    "#11302e", // เขียวเข้มมาก
    "#4a0d4a", // ม่วงเข้ม
    "#0d4a2a", // เขียวเข้ม
    "#4a3b0d", // ทองเข้ม
    "#3b0d4a", // ม่วงน้ำเงิน
    "#4a0d0d", // แดงน้ำตาล
  ];
  const [bubbleColor, setBubbleColor] = useState(user?.bubble_color || DEFAULT_BUBBLE_COLOR);
  const [savingColor, setSavingColor] = useState(false);
  const [colorSaved, setColorSaved] = useState(false);

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

  // ⚡ บันทึกสี bubble
  async function handleSaveBubbleColor() {
    setSavingColor(true);
    try {
      await api().patch("/profile", { bubble_color: bubbleColor });
      await fetchMe?.();
      setColorSaved(true);
      setTimeout(() => setColorSaved(false), 2500);
      toast.success("บันทึกสีแชทแล้ว");
    } catch (e: unknown) {
      catchError(e, "บันทึกไม่สำเร็จ");
    } finally {
      setSavingColor(false);
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
            {/* ⚡ สี bubble ของตัวเอง */}
            <div className="pt-2 border-t border-border">
              <label className="block text-sm font-medium text-text mb-2">สีแชทบับเบิ้ลของคุณ</label>
              <div className="flex flex-wrap gap-2 mb-3">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setBubbleColor(c)}
                    className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                      bubbleColor.toLowerCase() === c.toLowerCase() ? "border-text ring-2 ring-brand/30" : "border-border"
                    }`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="color"
                  value={bubbleColor}
                  onChange={(e) => setBubbleColor(e.target.value)}
                  disabled={!editable}
                  className="w-10 h-10 rounded cursor-pointer border border-border bg-surface-2"
                />
                <input
                  type="text"
                  value={bubbleColor}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setBubbleColor(v);
                  }}
                  disabled={!editable}
                  className="w-28 h-10 px-3 rounded-lg border border-border bg-surface-2 text-text font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60"
                  placeholder="#560C0E"
                />
                {/* Preview bubble */}
                <div className="ml-2 flex items-center gap-1.5">
                  <span className="text-[10px] text-text-subtle">ตัวอย่าง:</span>
                  <span
                    className="rounded-2xl px-3 py-1.5 text-xs text-white"
                    style={{ backgroundColor: bubbleColor }}
                  >
                    สวัสดีครับ
                  </span>
                </div>
              </div>
              {editable && (
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleSaveBubbleColor} disabled={savingColor || bubbleColor === (user?.bubble_color || DEFAULT_BUBBLE_COLOR)}>
                    {savingColor ? <Loading size={14} /> : <Save size={14} />} บันทึกสี
                  </Button>
                  {colorSaved && (
                    <span className="flex items-center gap-1 text-xs text-brand">
                      <CheckCircle2 size={14} /> บันทึกแล้ว
                    </span>
                  )}
                </div>
              )}
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

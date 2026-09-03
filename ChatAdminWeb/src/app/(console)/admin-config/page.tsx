"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Loading } from "@/components/ui/Loading";
import {
  RefreshCw, Sliders, Clock, MessageCircle, Save,
  Check, AlertCircle, Info,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEdit } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";

// ─── Types ────────────────────────────────────────────────

interface AdminConfig {
  bot_buffer_enabled: boolean;
  bot_buffer_window_ms: number;
  bot_buffer_max_messages: number;
  updated_by: string;
  updated_at: string;
}

// ─── Slider (minimal — thin line + small dot, dark theme) ──

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  format?: (v: number) => string;
}

function MinimalSlider({ value, min, max, step, onChange, disabled, format }: SliderProps) {
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <div className={`flex items-center gap-3 ${disabled ? "opacity-50" : ""}`}>
      <div className="relative flex-1 h-6 flex items-center">
        {/* Track background */}
        <div className="absolute left-0 right-0 h-[3px] rounded-full bg-surface-1" />
        {/* Track fill */}
        <div
          className="absolute left-0 h-[3px] rounded-full bg-brand/60 transition-all"
          style={{ width: `${percent}%` }}
        />
        {/* Native input (transparent, on top) */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        />
        {/* Dot (visual) */}
        <div
          className="absolute w-3.5 h-3.5 rounded-full bg-white shadow-md border border-border transition-all pointer-events-none"
          style={{ left: `calc(${percent}% - 7px)` }}
        />
      </div>
      <span className="text-sm font-medium text-text tabular-nums min-w-[60px] text-right">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

// ─── Toggle Switch ────────────────────────────────────────

function ToggleSwitch({ enabled, onChange, disabled }: { enabled: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`relative rounded-full transition-colors flex-shrink-0 ${
        enabled ? "bg-green-500" : "bg-surface-1"
      } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
      style={{ width: "40px", height: "22px" }}
      title={enabled ? "คลิกเพื่อปิด" : "คลิกเพื่อเปิด"}
    >
      <span
        className="absolute rounded-full bg-white shadow-sm transition-transform"
        style={{
          width: "18px",
          height: "18px",
          top: "2px",
          left: "2px",
          transform: enabled ? "translateX(18px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

// ─── Section wrapper (สำหรับขยายในอนาคต) ──────────────────

interface SectionProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
  children: React.ReactNode;
  disabled?: boolean;
}

function ConfigSection({ icon, title, description, badge, children, disabled }: SectionProps) {
  return (
    <Card className={`p-5 transition-opacity ${disabled ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2.5 mb-1">
        <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center text-brand">
          {icon}
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
        </div>
        {badge && <Badge tone="brand">{badge}</Badge>}
      </div>
      <p className="text-xs text-text-muted mb-4 ml-10.5">{description}</p>
      <div className="space-y-4 ml-0">{children}</div>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────

export default function AdminConfigPage() {
  const { user } = useAuth();
  const editable = canEdit(user);
  const { catchError } = useToastError();
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Draft (local state ก่อน save)
  const [bufferEnabled, setBufferEnabled] = useState(false);
  const [bufferWindow, setBufferWindow] = useState(6000);
  const [bufferMaxMsgs, setBufferMaxMsgs] = useState(5);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ config: AdminConfig }>("/admin-config");
      setConfig(r.data.config);
      setBufferEnabled(r.data.config.bot_buffer_enabled);
      setBufferWindow(r.data.config.bot_buffer_window_ms);
      setBufferMaxMsgs(r.data.config.bot_buffer_max_messages);
    } catch (err) {
      catchError(err, "โหลดการตั้งค่าไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  useEffect(() => {
    load();
  }, [load]);

  // เช็คว่ามีการเปลี่ยนค่าไหม (สำหรับปุ่มบันทึก)
  const hasChanges = config
    ? bufferEnabled !== config.bot_buffer_enabled ||
      bufferWindow !== config.bot_buffer_window_ms ||
      bufferMaxMsgs !== config.bot_buffer_max_messages
    : false;

  async function handleSave() {
    const ok = await confirm.ask({
      title: "บันทึกการตั้งค่า?",
      message: "ยืนยันการบันทึกการตั้งค่าของแอดมิน",
      confirmText: "บันทึก",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await api().put<{ ok: boolean; config: AdminConfig }>("/admin-config", {
        bot_buffer_enabled: bufferEnabled,
        bot_buffer_window_ms: bufferWindow,
        bot_buffer_max_messages: bufferMaxMsgs,
      });
      setConfig(r.data.config);
      toast.success("บันทึกการตั้งค่าแล้ว");
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickToggle(key: "bot_buffer_enabled", value: boolean) {
    // Toggle แบบกดแล้วบันทึกทันที (ไม่ต้องกดปุ่มบันทึก)
    setSaving(true);
    try {
      const r = await api().put<{ ok: boolean; config: AdminConfig }>("/admin-config", {
        [key]: value,
      });
      setConfig(r.data.config);
      setBufferEnabled(r.data.config.bot_buffer_enabled);
      toast.success(`${value ? "เปิด" : "ปิด"} Buffering แล้ว`);
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
      setBufferEnabled(!value); // revert
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loading size={32} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <Sliders size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">ตั้งค่าแอดมิน</h1>
              <p className="text-xs text-text-muted">
                การตั้งค่าที่แอดมินปรับได้ · ส่วนตั้งค่าระบบเป็นสิทธิ์ Dev/SuperAdmin
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
            </Button>
            {hasChanges && (
              <Button size="sm" onClick={handleSave} disabled={saving || !editable}>
                {saving ? <Loading size={14} /> : <Save size={14} />} บันทึก
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="p-6 max-w-2xl space-y-4">
        {/* Read-only banner */}
        {!editable && (
          <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg p-2.5 text-xs text-text-muted">
            <AlertCircle size={14} className="text-text-subtle" />
            คุณเป็นผู้ดูแลระบบระดับอ่านได้อย่างเดียว — ต้องเป็น Admin ขึ้นไปถึงจะเปลี่ยนการตั้งค่าได้
          </div>
        )}

        {/* ─── Section: Bot Message Buffering ─── */}
        <ConfigSection
          icon={<MessageCircle size={16} />}
          title="การรวมข้อความ (Buffering)"
          description="รอให้ลูกค้าหยุดพิมพ์ แล้วรวมทุกข้อความเป็น 1 คำถาม — ลดการตอบเกินจำเป็นและประหยัด token"
          badge={bufferEnabled ? "เปิดอยู่" : "ปิดอยู่"}
        >
          {/* Toggle */}
          <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-2">
            <div className="flex-1 mr-3">
              <div className="text-sm font-medium text-text">เปิด Buffering</div>
              <div className="text-[11px] text-text-muted mt-0.5">
                รวมข้อความหลายท่อนเป็น 1 คำถามก่อนส่งบอท
              </div>
            </div>
            <ToggleSwitch
              enabled={bufferEnabled}
              onChange={() => editable && handleQuickToggle("bot_buffer_enabled", !bufferEnabled)}
              disabled={!editable || saving}
            />
          </div>

          {/* Window slider */}
          <div className={`py-3 px-3 rounded-lg bg-surface-2 space-y-2 ${!bufferEnabled ? "pointer-events-none" : ""}`}>
            <div className="flex items-center gap-2">
              <Clock size={13} className="text-text-muted" />
              <span className="text-sm font-medium text-text">รอ X วินาทีหลังข้อความสุดท้าย</span>
            </div>
            <p className="text-[11px] text-text-muted">
              ถ้าลูกค้าพิมพ์ต่อในช่วงเวลานี้ จะรีเซ็ตตัวนับใหม่ — รอจนกว่าจะหยุดพิมพ์
            </p>
            <MinimalSlider
              value={bufferWindow}
              min={1000}
              max={30000}
              step={500}
              onChange={setBufferWindow}
              disabled={!editable || !bufferEnabled}
              format={(v) => `${(v / 1000).toFixed(1)}s`}
            />
            <div className="flex justify-between text-[10px] text-text-subtle">
              <span>1s (เร็ว)</span>
              <span>30s (นาน)</span>
            </div>
          </div>

          {/* Max messages slider */}
          <div className={`py-3 px-3 rounded-lg bg-surface-2 space-y-2 ${!bufferEnabled ? "pointer-events-none" : ""}`}>
            <div className="flex items-center gap-2">
              <MessageCircle size={13} className="text-text-muted" />
              <span className="text-sm font-medium text-text">สูงสุด X ข้อความต่อ Buffer</span>
            </div>
            <p className="text-[11px] text-text-muted">
              ถ้าครบจำนวนนี้ในช่วงเวลารอ — ประมวลผลทันที ไม่รอต่อ
            </p>
            <MinimalSlider
              value={bufferMaxMsgs}
              min={1}
              max={20}
              step={1}
              onChange={setBufferMaxMsgs}
              disabled={!editable || !bufferEnabled}
              format={(v) => `${v} ข้อความ`}
            />
            <div className="flex justify-between text-[10px] text-text-subtle">
              <span>1 (ทันที)</span>
              <span>20 (รอนาน)</span>
            </div>
          </div>

          {/* Info box */}
          <div className="flex items-start gap-2 rounded-lg bg-blue-500/5 border border-blue-500/15 p-3">
            <Info size={14} className="text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="text-[11px] text-text-muted leading-relaxed">
              <span className="text-blue-400 font-medium">ตัวอย่าง:</span> ลูกค้าพิมพ์ &quot;สนใจหัวชาร์จ&quot; → &quot;มี 220W ไหม&quot; → &quot;ส่งรูปได้ไหม&quot; รัวๆ
              ระบบจะรวมเป็น 1 คำถาม ส่งบอท 1 ครั้ง ตอบ 1 คำตอบ
            </div>
          </div>
        </ConfigSection>

        {/* ─── Save bar (sticky bottom) ─── */}
        {hasChanges && (
          <div className="sticky bottom-0 -mx-6 px-6 py-3 bg-surface border-t border-border flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <AlertCircle size={14} className="text-yellow-400" />
              มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={load} disabled={saving}>
                ยกเลิก
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !editable}>
                {saving ? <Loading size={14} /> : <Save size={14} />} บันทึก
              </Button>
            </div>
          </div>
        )}

        {/* Last updated */}
        {config && (
          <div className="flex items-center gap-1.5 text-[10px] text-text-subtle pt-2">
            <Check size={10} className="text-green-400" />
            อัปเดตล่าสุดโดย {config.updated_by} · {new Date(config.updated_at).toLocaleString("th-TH")}
          </div>
        )}

        {/* ─── Placeholder for future sections ─── */}
        <div className="text-center py-4">
          <span className="text-[10px] text-text-subtle">
            การตั้งค่าเพิ่มเติมจะเพิ่มที่นี่ในอนาคต (Workflow, Routing, ฯลฯ)
          </span>
        </div>
      </div>
    </div>
  );
}

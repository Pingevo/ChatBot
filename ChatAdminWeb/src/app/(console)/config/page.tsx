"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Loading } from "@/components/ui/Loading";
import {
  Shield, ShieldAlert, ShieldCheck, RefreshCw,
  Database, Lock, Zap, Store, Clock, Power, AlertCircle,
  Bot, Activity, Cpu, Server,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canManage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import type { Platform } from "@/lib/types";

interface SystemConfig {
  config_key: string;
  // Shopee — ล็อค false ถาวร
  shopee_live_read_enabled: boolean;
  shopee_live_send_enabled: boolean;
  shopee_live_mark_read_enabled: boolean;
  shopee_live_pin_enabled: boolean;
  shopee_poll_enabled: boolean;
  // TikTok / Lazada — เผื่ออนาคต
  tiktok_live_send_enabled: boolean;
  tiktok_live_read_enabled: boolean;
  lazada_live_send_enabled: boolean;
  lazada_live_read_enabled: boolean;
  // ปลอดภัย
  mock_mode_enabled: boolean;
  shadow_bot_enabled: boolean;
  polling_interval_ms: number;
  bot_worker_enabled: boolean;
  bot_worker_interval_ms: number;
  // ⚡ Workflow engine (แบบ Zaapi Flow Builder)
  workflow_enabled: boolean;
  workflow_priority: "workflow_first" | "trigger_first" | "both";
  workflow_run_timeout_ms: number;
  // Bot URLs
  shopee_bot_url: string;
  tiktok_bot_url: string;
  lazada_bot_url: string;
  updated_by: string;
  updated_at: string;
}

interface ConfigResponse {
  config: SystemConfig;
  safety: Record<string, boolean>;
  envInfo: Record<string, unknown>;
  lockedSwitches: string[];
}

interface ShopRow {
  shop_id: string;
  shopname: string;
  platform: Platform;
  connected: boolean;
  enabled_for_chat?: boolean;
  disabled_by_user?: boolean;
  conversation_count: number;
  product_count: number;
}

interface TestResults {
  adminDb: { ok: boolean; message: string };
  dbWallet: { ok: boolean; message: string };
  shopeeBot: { ok: boolean; message: string };
  tiktokBot: { ok: boolean; message: string };
  lazadaBot: { ok: boolean; message: string };
  dataActivity: { ok: boolean; message: string };
}

// สวิตช์อันตราย — แสดงเป็น read-only ล็อคไว้ (แยกตาม platform)
const dangerousSwitchesByPlatform: {
  platform: Platform;
  switches: { key: keyof SystemConfig; label: string; description: string }[];
}[] = [
  {
    platform: "shopee",
    switches: [
      { key: "shopee_live_read_enabled", label: "Live Read", description: "ยิง get_conversation_list / get_message จริง" },
      { key: "shopee_live_send_enabled", label: "Live Send", description: "ยิง send_message จริง (ส่งข้อความให้ลูกค้า)" },
      { key: "shopee_live_mark_read_enabled", label: "Mark Read", description: "ยิง read_conversation จริง (กระทบ unread บน Shopee)" },
      { key: "shopee_live_pin_enabled", label: "Pin", description: "ยิง pin/unpin_conversation จริง" },
      { key: "shopee_poll_enabled", label: "Poll", description: "รัน pollWorker ยิง Shopee API จริง" },
    ],
  },
  {
    platform: "tiktok",
    switches: [
      { key: "tiktok_live_send_enabled", label: "Live Send", description: "ยิง TikTok send จริง (เผื่ออนาคต)" },
      { key: "tiktok_live_read_enabled", label: "Live Read", description: "ยิง TikTok read จริง (เผื่ออนาคต)" },
    ],
  },
  {
    platform: "lazada",
    switches: [
      { key: "lazada_live_send_enabled", label: "Live Send", description: "ยิง Lazada send จริง (เผื่ออนาคต)" },
      { key: "lazada_live_read_enabled", label: "Live Read", description: "ยิง Lazada read จริง (เผื่ออนาคต)" },
    ],
  },
];

// สวิตช์ปลอดภัย — เปิด/ปิดได้
const safeSwitches: { key: keyof SystemConfig; label: string; description: string }[] = [
  { key: "mock_mode_enabled", label: "Mock Mode", description: "ใช้ข้อมูลจำลอง ไม่ยิง API จริง" },
  { key: "shadow_bot_enabled", label: "Shadow Bot", description: "bot generate reply แต่เก็บใน shadow_replies ไม่ส่งจริง" },
  { key: "bot_worker_enabled", label: "Bot Worker (Auto)", description: "ประมวลผลแชทใหม่อัตโนมัติ: trigger → bot → handoff (ต้องรัน scripts/bot-worker.ts)" },
  // ⚡ workflow_enabled ย้ายไป /admin-config แล้ว — admin เปิด/ปิดเองได้
];

const platformColors: Record<Platform, string> = {
  shopee: "text-orange-400",
  tiktok: "text-pink-400",
  lazada: "text-blue-400",
};

export default function ConfigPage() {
  const { user } = useAuth();
  const editable = canManage(user); // superadmin or dev only
  const { catchError } = useToastError();
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [togglingShop, setTogglingShop] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<TestResults | null>(null);
  const [testing, setTesting] = useState(false);
  const [pollingInterval, setPollingInterval] = useState(1000);
  // ⚡ Workflow engine settings ย้ายไป /admin-config แล้ว
  const [editingBotUrl, setEditingBotUrl] = useState<Platform | null>(null);
  const [botUrlDraft, setBotUrlDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, shopsRes] = await Promise.all([
        api().get<ConfigResponse>("/config"),
        api().get<{ rows: ShopRow[]; total: number }>("/shops"),
      ]);
      setConfig(configRes.data.config);
      setPollingInterval(configRes.data.config.polling_interval_ms || 1000);
      setShops(shopsRes.data.rows || []);
    } catch (err) {
      console.error("load config failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSafeToggle(key: keyof SystemConfig, value: boolean) {
    if (!config) return;
    const labelMap: Record<string, string> = {
      mock_mode_enabled: "Mock Mode",
      shadow_bot_enabled: "Shadow Bot",
      bot_worker_enabled: "Bot Worker (Auto)",
    };
    const label = labelMap[key as string] || key;
    const ok = await confirm.ask({
      title: `${value ? "เปิด" : "ปิด"} ${label}?`,
      message: `ยืนยันการเปลี่ยนแปลงค่า "${label}" เป็น ${value ? "เปิด" : "ปิด"}`,
      confirmText: "บันทึก",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await api().put<{ ok: boolean; config: SystemConfig }>("/config", { [key]: value });
      setConfig(r.data.config);
      toast.success(`เปลี่ยน "${label}" เป็น ${value ? "เปิด" : "ปิด"} แล้ว`);
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveInterval() {
    const ok = await confirm.ask({
      title: "บันทึกค่า polling interval?",
      message: `เปลี่ยนเป็น ${pollingInterval} ms — ค่านี้มีผลต่อความถี่ในการอัพเดทข้อมูล`,
      confirmText: "บันทึก",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await api().put<{ ok: boolean; config: SystemConfig }>("/config", {
        polling_interval_ms: pollingInterval,
      });
      setConfig(r.data.config);
      toast.success("บันทึก polling interval แล้ว");
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  // ⚡ handleSaveWorkflow ย้ายไป /admin-config แล้ว

  async function handleShopToggle(shop: ShopRow) {
    const newState = !shop.enabled_for_chat;
    const ok = await confirm.ask({
      title: newState ? "เปิดรับแชทร้านนี้?" : "ปิดรับแชทร้านนี้?",
      message: `"${shop.shopname}" — ${newState ? "ระบบจะเริ่มประมวลผลแชทของร้านนี้" : "ระบบจะหยุดประมวลผลแชทของร้านนี้"}`,
      confirmText: newState ? "เปิด" : "ปิด",
    });
    if (!ok) return;
    setTogglingShop(shop.shop_id);
    try {
      await api().patch(`/config/shop/${shop.shop_id}`, {
        enabled_for_chat: newState,
      });
      await load();
      toast.success(`${newState ? "เปิด" : "ปิด"} "${shop.shopname}" แล้ว`);
    } catch (err) {
      catchError(err, "เปลี่ยนสถานะร้านไม่สำเร็จ");
    } finally {
      setTogglingShop(null);
    }
  }

  async function handleTestIntegration() {
    setTesting(true);
    setTestResults(null);
    try {
      const r = await api().post<{ ok: boolean; results: TestResults }>("/config/test-integration");
      setTestResults(r.data.results);
      toast.success("ทดสอบการเชื่อมต่อเสร็จแล้ว");
    } catch (err) {
      catchError(err, "ทดสอบการเชื่อมต่อไม่สำเร็จ");
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveBotUrl(platform: Platform) {
    if (!config) return;
    const key = `${platform}_bot_url` as keyof SystemConfig;
    const ok = await confirm.ask({
      title: `บันทึก Bot URL (${platform})?`,
      message: `เปลี่ยน URL เป็น "${botUrlDraft}" — ระบบจะใช้ URL นี้เรียก bot ของ ${platform}`,
      confirmText: "บันทึก",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await api().put<{ ok: boolean; config: SystemConfig }>("/config", {
        [key]: botUrlDraft,
      });
      setConfig(r.data.config);
      setEditingBotUrl(null);
      toast.success(`บันทึก Bot URL (${platform}) แล้ว`);
    } catch (err) {
      catchError(err, "บันทึก URL ไม่สำเร็จ");
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

  const enabledShops = shops.filter((s) => s.enabled_for_chat).length;
  const shopsByPlatform = (p: Platform) => shops.filter((s) => s.platform === p);

  return (
    <div className="h-full overflow-y-auto">
      {/* Header — navbar เดิม (เหมือน shops/team) */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <Shield size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">ตั้งค่าระบบ</h1>
              <p className="text-xs text-text-muted">
                3 platform (Shopee/TikTok/Lazada) · Bot services · สวิตช์อันตรายล็อค false ถาวร
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {/* Read-only banner for admin role */}
        {!editable && (
          <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg p-2.5 text-xs text-text-muted">
            <AlertCircle size={14} className="text-text-subtle" />
            คุณเป็น Admin — ดูได้อย่างเดียว ต้องเป็น SuperAdmin หรือ Dev ถึงจะเปลี่ยนการตั้งค่าได้
          </div>
        )}

        {/* Iron Rules Banner */}
        <div className="rounded-xl border border-blue-900/50 bg-[#0a1628] p-4">
          <div className="flex items-center gap-2 mb-2.5">
            <ShieldAlert size={16} className="text-blue-400" />
            <span className="text-sm font-semibold text-white">กฎเหล็ก (Iron Rules) — รองรับ 3 platform</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div className="flex items-center gap-2 text-white">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
              ห้ามยิง Shopee / TikTok / Lazada API ทุก endpoint
            </div>
            <div className="flex items-center gap-2 text-white">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
              ห้ามส่ง/อ่านข้อความจริงจาก platform ใดๆ
            </div>
            <div className="flex items-center gap-2 text-white">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
              แชทเข้าผ่าน data writer (พี่เขาเขียนลง MongoDB ของเรา)
            </div>
            <div className="flex items-center gap-2 text-white">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
              bot แยก platform + conversation_id prefix (shp_/tt_/lz_)
            </div>
          </div>
        </div>

        {/* Bot Services — 3 ตัว แยก port */}
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Bot size={14} className="text-brand" />
            <h2 className="text-sm font-semibold text-text">Bot Services (3 ตัว แยก port)</h2>
            <Badge tone="brand" className="ml-auto">3 platform</Badge>
          </div>
          <div className="space-y-2">
            {(["shopee", "tiktok", "lazada"] as Platform[]).map((p) => {
              const url = config?.[`${p}_bot_url` as keyof SystemConfig] as string;
              const isEditing = editingBotUrl === p;
              return (
                <div key={p} className="rounded-lg bg-surface-2 p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Server size={13} className={platformColors[p]} />
                      <span className="text-sm font-medium capitalize text-text">
                        {p} Bot
                      </span>
                    </div>
                    {editable && !isEditing && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingBotUrl(p);
                          setBotUrlDraft(url || "");
                        }}
                      >
                        แก้ไข
                      </Button>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={botUrlDraft}
                        onChange={(e) => setBotUrlDraft(e.target.value)}
                        placeholder="http://127.0.0.1:80xx"
                        className="flex-1 rounded-md bg-surface border border-border px-2 py-1 text-xs text-text"
                      />
                      <Button size="sm" onClick={() => handleSaveBotUrl(p)} disabled={saving}>
                        {saving ? <Loading size={12} /> : "บันทึก"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingBotUrl(null)}>
                        ยกเลิก
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs">
                      <code className="bg-surface px-2 py-0.5 rounded text-text-muted font-mono">
                        {url}
                      </code>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Two-column: switches left, shops/test right */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left — switches */}
          <div className="space-y-4">
            {/* Dangerous switches — แยกตาม platform */}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Lock size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text">สวิตช์อันตราย (ล็อค)</h2>
                <Badge tone="neutral" className="ml-auto">false ถาวร</Badge>
              </div>
              <div className="space-y-3">
                {dangerousSwitchesByPlatform.map(({ platform, switches }) => (
                  <div key={platform}>
                    <div className={`text-[11px] font-semibold uppercase mb-1.5 ${platformColors[platform]}`}>
                      {platform}
                    </div>
                    <div className="space-y-1.5">
                      {switches.map((sw) => (
                        <div key={sw.key} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-2/50">
                          <div className="min-w-0">
                            <div className="text-sm text-text">{sw.label}</div>
                            <div className="text-[11px] text-text-muted truncate">{sw.description}</div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className="text-xs font-mono text-text-subtle">false</span>
                            <Lock size={11} className="text-text-subtle" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Safe switches */}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck size={14} className="text-green-400" />
                <h2 className="text-sm font-semibold text-text">สวิตช์ปลอดภัย</h2>
                <Badge tone="brand" className="ml-auto">เปิด/ปิดได้</Badge>
              </div>
              <div className="space-y-1.5">
                {safeSwitches.map((sw) => {
                  const enabled = config?.[sw.key] as boolean | undefined;
                  return (
                    <div key={sw.key} className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-surface-2">
                      <div className="min-w-0 flex-1 mr-3">
                        <div className="text-sm font-medium text-text">{sw.label}</div>
                        <div className="text-[11px] text-text-muted truncate">{sw.description}</div>
                      </div>
                      <ToggleSwitch
                        enabled={!!enabled}
                        onChange={() => editable && handleSafeToggle(sw.key, !enabled)}
                        disabled={saving || !editable}
                      />
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Polling interval (realtime inbox) */}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Clock size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text">Realtime Polling</h2>
              </div>
              <p className="text-xs text-text-muted mb-3">
                ดึงข้อความใหม่จาก chatbot DB ทุกๆ กี่มิลลิวินาที (ค่าแนะนำ: 1000-3000)
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={500}
                  max={10000}
                  step={500}
                  value={pollingInterval}
                  onChange={(e) => setPollingInterval(parseInt(e.target.value) || 1000)}
                  disabled={!editable}
                  className="w-24 rounded-md bg-surface border border-border px-2 py-1.5 text-sm text-text"
                />
                <span className="text-xs text-text-muted">ms</span>
                <Button size="sm" onClick={handleSaveInterval} disabled={saving || !editable}>
                  {saving ? <Loading size={14} /> : "บันทึก"}
                </Button>
              </div>
              {config && (
                <div className="text-[10px] text-text-subtle mt-2">
                  ค่าปัจจุบัน: {config.polling_interval_ms}ms · อัปเดตโดย {config.updated_by}
                </div>
              )}
            </Card>

            {/* ⚡ Workflow Engine ย้ายไป /admin-config แล้ว — admin เปิด/ปิด + priority + timeout ได้เอง */}
          </div>

          {/* Right — per-shop toggle + test + data activity */}
          <div className="space-y-4">
            {/* Data Activity (collection monitor) */}
            {testResults?.dataActivity && (
              <Card className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Activity size={14} className="text-green-400" />
                  <h2 className="text-sm font-semibold text-text">Data Activity</h2>
                </div>
                <TestRow label="การเข้าของ data writer" result={testResults.dataActivity} />
                <div className="text-[10px] text-text-subtle mt-2">
                  ข้อมูลเข้าผ่าน MongoDB write โดย sellcenter — เราแค่อ่าน
                </div>
              </Card>
            )}

            {/* Per-shop toggle — แยกตาม platform */}
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Store size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text">ร้านที่เปิดใช้งาน</h2>
                <Badge tone="brand" className="ml-auto">{enabledShops}/{shops.length}</Badge>
              </div>
              <p className="text-xs text-text-muted mb-3">
                เปิด/ปิดร้านที่จะแสดงในหน้า inbox (แยกตาม platform)
              </p>
              {shops.length === 0 ? (
                <div className="text-xs text-text-muted bg-surface-2 rounded-lg p-3 text-center">
                  ยังไม่มีร้านในระบบ
                </div>
              ) : (
                <div className="space-y-3">
                  {(["shopee", "tiktok", "lazada"] as Platform[]).map((p) => {
                    const shopsP = shopsByPlatform(p);
                    if (shopsP.length === 0) return null;
                    return (
                      <div key={p}>
                        <div className={`text-[11px] font-semibold uppercase mb-1.5 ${platformColors[p]}`}>
                          {p} ({shopsP.length} ร้าน)
                        </div>
                        <div className="space-y-1.5">
                          {shopsP.map((shop) => (
                            <div
                              key={shop.shop_id}
                              className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-surface-2"
                            >
                              <div className="min-w-0 flex-1 mr-3">
                                <div className="text-sm font-medium text-text truncate">
                                  {shop.shopname || shop.shop_id}
                                </div>
                                <div className="text-[11px] text-text-muted">
                                  {shop.conversation_count} แชท
                                </div>
                              </div>
                              {togglingShop === shop.shop_id ? (
                                <Loading size={16} />
                              ) : (
                                <ToggleSwitch
                                  enabled={!!shop.enabled_for_chat}
                                  onChange={() => editable && handleShopToggle(shop)}
                                  disabled={!editable}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* Test connection */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Zap size={14} className="text-yellow-400" />
                  <h2 className="text-sm font-semibold text-text">ทดสอบการเชื่อมต่อ</h2>
                </div>
                <Button size="sm" variant="outline" onClick={handleTestIntegration} disabled={testing}>
                  {testing ? <Loading size={14} /> : <Zap size={14} />} ทดสอบ
                </Button>
              </div>
              {testResults ? (
                <div className="space-y-2">
                  <TestRow label="Admin DB (chatbot)" result={testResults.adminDb} />
                  <TestRow label="dbWallet สินค้า" result={testResults.dbWallet} />
                  <TestRow label="Shopee Bot" result={testResults.shopeeBot} />
                  <TestRow label="TikTok Bot" result={testResults.tiktokBot} />
                  <TestRow label="Lazada Bot" result={testResults.lazadaBot} />
                  <TestRow label="Data Activity" result={testResults.dataActivity} />
                </div>
              ) : (
                <div className="text-xs text-text-muted bg-surface-2 rounded-lg p-3">
                  กดปุ่ม "ทดสอบ" เพื่อตรวจสอบ DB + Bot services + Data activity
                </div>
              )}
              <div className="text-[10px] text-text-subtle mt-2 flex items-center gap-1">
                <ShieldCheck size={10} className="text-green-400" />
                ไม่ยิง API ไป platform ใดๆ — ตรวจเฉพาะ DB + health endpoint ของ bot
              </div>
            </Card>
          </div>
        </div>

      </div>
    </div>
  );
}

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

function TestRow({ label, result }: { label: string; result: { ok: boolean; message: string } }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg p-2.5 border ${
      result.ok
        ? "bg-green-500/5 border-green-500/20"
        : "bg-red-500/5 border-red-500/20"
    }`}>
      <span className={`flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs ${
        result.ok ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
      }`}>
        {result.ok ? "✓" : "✗"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-text">{label}</div>
        <div className="text-xs text-text-muted">{result.message}</div>
      </div>
    </div>
  );
}

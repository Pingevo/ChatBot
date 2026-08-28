// /shop-settings — ตั้งค่าพฤติกรรมบอทของแต่ละร้าน
//
// ฟีเจอร์:
//   - Modal form เด้ง (ไม่ใช่ inline)
//   - เลือก platform ก่อน แล้วค่อยเลือกร้าน (multi-select ได้ทั้งคู่)
//   - แสดง log ใครทำอะไรตอนไหน
"use client";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import {
  Settings2,
  Search,
  Store,
  Globe,
  ChevronDown,
  Save,
  Headset,
  Bot,
  Power,
  Trash2,
  Plus,
  X,
  Check,
  History,
  User,
  Clock,
} from "lucide-react";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/apiClient";

type PersonaPlatform = "shopee" | "tiktok" | "lazada";
type FaqAction = "handoff" | "bot_reply";

interface ShopSettingsRow {
  settings_id: string;
  shopname: string;
  platform: PersonaPlatform;
  faq_liveagent_enabled: boolean;
  faq_liveagent_action: FaqAction;
  notes?: string;
  updated_at?: string;
  updated_by?: string;
}

interface ShopOption {
  shopname: string;
  platform: PersonaPlatform;
}

interface LogRow {
  admin_id: string;
  action_type: string;
  timestamp: string;
  username?: string;
  name?: string;
  meta?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const ALL_PLATFORMS: { value: PersonaPlatform; label: string }[] = [
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok" },
  { value: "lazada", label: "Lazada" },
];

export default function ShopSettingsPage() {
  const { catchError } = useToastError();
  const [rows, setRows] = useState<ShopSettingsRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [logLoading, setLogLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterPlatform, setFilterPlatform] = useState<PersonaPlatform | "all">("all");
  const [sortBy, setSortBy] = useState<"shopname" | "platform" | "updated" | "action">("shopname");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [allShops, setAllShops] = useState<ShopOption[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showLogPanel, setShowLogPanel] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── form state (multi-select) ──
  const [selectedPlatforms, setSelectedPlatforms] = useState<PersonaPlatform[]>(["shopee"]);
  const [selectedShops, setSelectedShops] = useState<string[]>([]);
  const [newAction, setNewAction] = useState<FaqAction>("handoff");
  const [newEnabled, setNewEnabled] = useState(true);
  const [shopSearch, setShopSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ rows: ShopSettingsRow[] }>("/shop-settings");
      setRows(r.data.rows || []);
    } catch (e) {
      catchError(e, "โหลด shop settings ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  const loadLogs = useCallback(async () => {
    setLogLoading(true);
    try {
      const r = await api().get<{ rows: LogRow[] }>("/admin/logs", {
        params: { action_type: "shop_settings", limit: 50 },
      });
      setLogs(r.data.rows || []);
    } catch {
      // admin ที่ไม่ใช่ superadmin อาจดู log ไม่ได้ — ไม่แสดง error
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadLogs();
  }, [load, loadLogs]);

  // โหลดร้านทั้งหมดจาก chatbot /shops
  useEffect(() => {
    api()
      .get<{ shops: string[] }>("/chatbot/shops")
      .then((r) => {
        const shops: ShopOption[] = (r.data.shops || []).map((s) => ({
          shopname: s,
          platform: "shopee" as PersonaPlatform,
        }));
        setAllShops(shops);
      })
      .catch(() => {});
  }, []);

  const filtered = rows
    .filter((r) => {
      if (filterPlatform !== "all" && r.platform !== filterPlatform) return false;
      if (search) {
        const s = search.toLowerCase();
        if (
          !r.shopname.toLowerCase().includes(s) &&
          !(r.notes || "").toLowerCase().includes(s)
        )
          return false;
      }
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortBy === "shopname") cmp = a.shopname.localeCompare(b.shopname);
      else if (sortBy === "platform") cmp = a.platform.localeCompare(b.platform);
      else if (sortBy === "action") cmp = a.faq_liveagent_action.localeCompare(b.faq_liveagent_action);
      else if (sortBy === "updated") {
        const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        cmp = ta - tb;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

  // ร้านที่ยังไม่มี settings (กรองตาม platform ที่เลือก)
  const availableShops = allShops
    .filter((s) => selectedPlatforms.includes(s.platform))
    .filter(
      (s) =>
        !rows.some(
          (r) => r.shopname === s.shopname && selectedPlatforms.includes(r.platform)
        )
    )
    .filter((s) => {
      if (!shopSearch) return true;
      return s.shopname.toLowerCase().includes(shopSearch.toLowerCase());
    });

  const platformLabel = (p: PersonaPlatform) =>
    ALL_PLATFORMS.find((x) => x.value === p)?.label || p;

  // ── toggle enabled ──
  const toggleEnabled = async (row: ShopSettingsRow) => {
    const newVal = !row.faq_liveagent_enabled;
    const ok = await confirm.ask({
      title: newVal ? "เปิดใช้งาน?" : "ปิดใช้งาน?",
      message: `ร้าน "${row.shopname}" — ${newVal ? "จะใช้งานได้" : "จะไม่ใช้งาน"} ต้องการจะ${newVal ? "เปิด" : "ปิด"}จริงๆ ใช่ไหมคะ?`,
      confirmText: newVal ? "เปิดใช้งาน" : "ปิดใช้งาน",
    });
    if (!ok) return;
    try {
      await api().post("/shop-settings", {
        shopname: row.shopname,
        platform: row.platform,
        faq_liveagent_enabled: newVal,
        faq_liveagent_action: row.faq_liveagent_action,
      });
      toast.success(`เปลี่ยนสถานะเป็น ${newVal ? "เปิด" : "ปิด"} แล้ว`);
      load();
      loadLogs();
    } catch (e) {
      catchError(e, "เปลี่ยนสถานะไม่สำเร็จ");
    }
  };

  // ── change action ──
  const changeAction = async (row: ShopSettingsRow, action: FaqAction) => {
    if (row.faq_liveagent_action === action) return;
    const ok = await confirm.ask({
      title: "เปลี่ยนพฤติกรรม?",
      message: `ร้าน "${row.shopname}" — เปลี่ยนจาก "${row.faq_liveagent_action === "handoff" ? "ส่งแอดมิน" : "บอทตอบ"}" เป็น "${action === "handoff" ? "ส่งแอดมิน" : "บอทตอบ"}" ต้องการจะเปลี่ยนจริงๆ ใช่ไหมคะ?`,
      confirmText: "เปลี่ยน",
    });
    if (!ok) return;
    try {
      await api().post("/shop-settings", {
        shopname: row.shopname,
        platform: row.platform,
        faq_liveagent_action: action,
      });
      toast.success(`เปลี่ยน action เป็น ${action === "handoff" ? "ส่งแอดมิน" : "บอทตอบ"} แล้ว`);
      load();
      loadLogs();
    } catch (e) {
      catchError(e, "เปลี่ยน action ไม่สำเร็จ");
    }
  };

  // ── delete ──
  const handleDelete = async (row: ShopSettingsRow) => {
    const ok = await confirm.ask({
      title: `ลบ settings ของร้าน ${row.shopname}?`,
      confirmText: "ลบ",
      cancelText: "ยกเลิก",
    });
    if (!ok) return;
    try {
      await api().delete(`/shop-settings/${row.settings_id}`);
      toast.success("ลบแล้ว");
      load();
      loadLogs();
    } catch (e) {
      catchError(e, "ลบไม่สำเร็จ");
    }
  };

  // ── save (batch) ──
  const handleSave = async () => {
    if (selectedShops.length === 0) {
      toast.error("กรุณาเลือกร้านอย่างน้อย 1 ร้าน");
      return;
    }
    if (selectedPlatforms.length === 0) {
      toast.error("กรุณาเลือกแพลตฟอร์มอย่างน้อย 1 แพลตฟอร์ม");
      return;
    }
    const total = selectedShops.length * selectedPlatforms.length;
    const ok = await confirm.ask({
      title: "ยืนยันการบันทึก?",
      message: `จะสร้าง/อัปเดต settings ${total} รายการ (${selectedShops.length} ร้าน × ${selectedPlatforms.length} แพลตฟอร์ม) — ต้องการจะบันทึกจริงๆ ใช่ไหมคะ?`,
      confirmText: "บันทึก",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await api().post("/shop-settings", {
        shops: selectedShops,
        platforms: selectedPlatforms,
        faq_liveagent_enabled: newEnabled,
        faq_liveagent_action: newAction,
      });
      const count = r.data?.created || r.data?.rows?.length || 0;
      toast.success(`บันทึก ${count} รายการแล้ว`);
      closeModal();
      load();
      loadLogs();
    } catch (e) {
      catchError(e, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  const closeModal = () => {
    setShowModal(false);
    setSelectedPlatforms(["shopee"]);
    setSelectedShops([]);
    setNewAction("handoff");
    setNewEnabled(true);
    setShopSearch("");
  };

  // ── toggle platform in form ──
  const togglePlatform = (p: PersonaPlatform) => {
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  // ── toggle shop in form ──
  const toggleShop = (shopname: string) => {
    setSelectedShops((prev) =>
      prev.includes(shopname) ? prev.filter((x) => x !== shopname) : [...prev, shopname]
    );
  };

  // ── select all shops ──
  const selectAllShops = () => {
    setSelectedShops(availableShops.map((s) => s.shopname));
  };

  const clearAllShops = () => {
    setSelectedShops([]);
  };

  // ── format log ──
  const formatLogAction = (action: string) => {
    if (action === "shop_settings.create") return "สร้าง";
    if (action === "shop_settings.update") return "แก้ไข";
    if (action === "shop_settings.delete") return "ลบ";
    return action;
  };

  const formatLogMeta = (log: LogRow) => {
    const m = log.meta || log.metadata || {};
    const parts: string[] = [];
    if (m.shopname) parts.push(String(m.shopname));
    if (m.platform) parts.push(platformLabel(m.platform as PersonaPlatform));
    if (m.faq_liveagent_action) {
      parts.push(m.faq_liveagent_action === "handoff" ? "ส่งแอดมิน" : "บอทตอบ");
    }
    if (m.faq_liveagent_enabled !== undefined) {
      parts.push(m.faq_liveagent_enabled ? "เปิด" : "ปิด");
    }
    return parts.join(" • ");
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-[calc(100vh-3.5rem)] bg-base">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <Settings2 size={22} className="text-brand" />
            <div className="flex-1">
              <h1 className="text-xl font-bold text-text">ตั้งค่าพฤติกรรมร้าน</h1>
              <p className="text-sm text-text-muted mt-0.5">
                ตั้งค่าการจัดการเมื่อเจอ message type พิเศษ (เช่น faq_liveagent) ของแต่ละร้าน
              </p>
            </div>
            <Button
              onClick={() => setShowLogPanel(!showLogPanel)}
              variant="ghost"
              size="sm"
              title="ดู log"
            >
              <History size={14} className="mr-1" />
              Log
            </Button>
            <Button
              onClick={() => setShowModal(true)}
              variant="primary"
              size="sm"
            >
              <Plus size={14} className="mr-1" />
              เพิ่มร้าน
            </Button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* ── Log panel (collapsible) ── */}
          {showLogPanel && (
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                  <History size={16} />
                  Activity Log — ใครทำอะไร
                </h3>
                <button
                  onClick={() => setShowLogPanel(false)}
                  className="text-text-muted hover:text-text"
                >
                  <X size={16} />
                </button>
              </div>
              {logLoading ? (
                <div className="flex justify-center py-4">
                  <Loading size={16} />
                </div>
              ) : logs.length === 0 ? (
                <p className="text-sm text-text-muted py-4 text-center">
                  ยังไม่มี log (อาจต้องเป็น superadmin/dev เพื่อดู)
                </p>
              ) : (
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {logs.map((log, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-1.5 shrink-0">
                        <User size={12} className="text-text-muted" />
                        <span className="text-text font-medium">
                          {log.name || log.username || log.admin_id}
                        </span>
                      </div>
                      <Badge
                        tone={
                          log.action_type === "shop_settings.delete"
                            ? "red"
                            : log.action_type === "shop_settings.create"
                            ? "brand"
                            : "neutral"
                        }
                      >
                        {formatLogAction(log.action_type)}
                      </Badge>
                      <span className="text-text-muted flex-1 truncate">
                        {formatLogMeta(log)}
                      </span>
                      <span className="text-text-subtle shrink-0 flex items-center gap-1">
                        <Clock size={10} />
                        {log.timestamp
                          ? new Date(log.timestamp).toLocaleString("th-TH", {
                              dateStyle: "short",
                              timeStyle: "short",
                            })
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Search + filter (dropdown) + sort ── */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาร้าน..."
                className="pl-9"
              />
            </div>
            {/* platform dropdown */}
            <select
              value={filterPlatform}
              onChange={(e) => setFilterPlatform(e.target.value as PersonaPlatform | "all")}
              className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="all">ทุกแพลตฟอร์ม</option>
              {ALL_PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            {/* sort by */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="shopname">เรียง: ชื่อร้าน</option>
              <option value="platform">เรียง: แพลตฟอร์ม</option>
              <option value="action">เรียง: action</option>
              <option value="updated">เรียง: แก้ล่าสุด</option>
            </select>
            {/* sort dir */}
            <button
              onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}
              className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text hover:bg-pale-sky-soft"
              title={sortDir === "asc" ? "น้อย→มาก" : "มาก→น้อย"}
            >
              {sortDir === "asc" ? "↑" : "↓"}
            </button>
            <span className="text-sm text-text-muted">{filtered.length} ร้าน</span>
          </div>

          {/* ── List ── */}
          {loading ? (
            <div className="flex justify-center py-12">
              <Loading />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Settings2}
              title="ยังไม่มี settings"
              description="คลิก 'เพิ่มร้าน' เพื่อตั้งค่าพฤติกรรม faq_liveagent"
            />
          ) : (
            <div className="space-y-2">
              {filtered.map((row) => (
                <div
                  key={row.settings_id}
                  className={`rounded-xl border border-border bg-surface p-4 transition-opacity ${
                    row.faq_liveagent_enabled ? "" : "opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {/* ชื่อร้าน */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Store size={16} className="text-text-muted shrink-0" />
                        <span className="font-medium text-text truncate">
                          {row.shopname}
                        </span>
                        <Badge tone="neutral">
                          <PlatformIcon platform={row.platform} size={10} />
                          <span className="ml-1">{platformLabel(row.platform)}</span>
                        </Badge>
                      </div>
                      {row.notes && (
                        <p className="text-xs text-text-muted mt-1 truncate">
                          {row.notes}
                        </p>
                      )}
                    </div>

                    {/* Toggle switch แบบ knowledge base */}
                    <button
                      onClick={() => toggleEnabled(row)}
                      className={`w-10 h-5 rounded-full transition-colors shrink-0 ${
                        row.faq_liveagent_enabled ? "bg-brand" : "bg-surface-2"
                      }`}
                      title={row.faq_liveagent_enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                    >
                      <div
                        className={`w-4 h-4 bg-white rounded-full transition-transform ${
                          row.faq_liveagent_enabled ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => handleDelete(row)}
                      className="text-text-muted hover:text-rose-400 shrink-0 p-1.5 rounded hover:bg-base"
                      title="ลบ"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                  {/* Action selector */}
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-text-muted flex items-center gap-1">
                      <Power size={12} />
                      faq_liveagent:
                    </span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => changeAction(row, "handoff")}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors ${
                          row.faq_liveagent_action === "handoff"
                            ? "bg-brand/15 text-brand font-medium"
                            : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
                        }`}
                      >
                        <Headset size={12} />
                        ส่งแอดมิน
                      </button>
                      <button
                        onClick={() => changeAction(row, "bot_reply")}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors ${
                          row.faq_liveagent_action === "bot_reply"
                            ? "bg-brand/15 text-brand font-medium"
                            : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
                        }`}
                      >
                        <Bot size={12} />
                        บอทตอบ
                      </button>
                    </div>
                    {!row.faq_liveagent_enabled && (
                      <span className="text-xs text-amber-400 ml-auto">
                        (ปิดอยู่ — บอทจะตอบต่อปกติ)
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════
        Modal — เพิ่ม settings (multi-select platform + shop)
      ══════════════════════════════════════════════════════════════════ */}
      {showModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
          onClick={closeModal}
        >
          <div
            className="bg-surface rounded-xl shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                <Plus size={16} className="text-brand" />
                เพิ่ม settings ร้านใหม่
              </h3>
              <button
                onClick={closeModal}
                className="text-text-muted hover:text-text"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* ── Step 1: เลือก platform (multi-select) ── */}
              <div>
                <label className="text-xs font-medium text-text-muted">
                  1. เลือกแพลตฟอร์ม (เลือกได้หลาย)
                </label>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {ALL_PLATFORMS.map((p) => {
                    const selected = selectedPlatforms.includes(p.value);
                    return (
                      <button
                        key={p.value}
                        onClick={() => togglePlatform(p.value)}
                        className={`flex items-center justify-center gap-1.5 rounded-lg border p-2.5 text-sm transition-colors ${
                          selected
                            ? "border-brand bg-brand/10 text-text"
                            : "border-border bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
                        }`}
                      >
                        {selected && <Check size={14} className="text-brand" />}
                        <PlatformIcon platform={p.value} size={12} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── Step 2: เลือกร้าน (multi-select) ── */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-text-muted">
                    2. เลือกร้าน (เลือกได้หลาย)
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={selectAllShops}
                      className="text-xs text-brand hover:underline"
                      disabled={availableShops.length === 0}
                    >
                      เลือกทั้งหมด
                    </button>
                    {selectedShops.length > 0 && (
                      <button
                        onClick={clearAllShops}
                        className="text-xs text-text-muted hover:underline"
                      >
                        ล้าง
                      </button>
                    )}
                  </div>
                </div>

                {/* shop search */}
                <div className="relative mt-1.5">
                  <Search
                    size={12}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                  />
                  <input
                    value={shopSearch}
                    onChange={(e) => setShopSearch(e.target.value)}
                    placeholder="ค้นหาร้าน..."
                    className="w-full rounded-lg border border-border bg-surface-2 pl-8 pr-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>

                {/* selected count */}
                {selectedShops.length > 0 && (
                  <div className="mt-1.5 text-xs text-brand">
                    เลือกแล้ว {selectedShops.length} ร้าน × {selectedPlatforms.length} แพลตฟอร์ม = {selectedShops.length * selectedPlatforms.length} รายการ
                  </div>
                )}

                {/* shop list */}
                <div className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-2">
                  {availableShops.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-text-subtle text-center">
                      {selectedPlatforms.length === 0
                        ? "เลือกแพลตฟอร์มก่อน"
                        : "ร้านทุกร้านมี settings แล้ว"}
                    </div>
                  ) : (
                    availableShops.map((s) => {
                      const selected = selectedShops.includes(s.shopname);
                      return (
                        <button
                          key={s.shopname}
                          onClick={() => toggleShop(s.shopname)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                            selected
                              ? "bg-brand/10 text-text"
                              : "text-text hover:bg-pale-sky-soft"
                          }`}
                        >
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                              selected
                                ? "border-brand bg-brand"
                                : "border-border"
                            }`}
                          >
                            {selected && <Check size={10} className="text-white" />}
                          </div>
                          <Store size={12} className="text-text-muted" />
                          <span className="truncate">{s.shopname}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* ── Step 3: เลือก action ── */}
              <div>
                <label className="text-xs font-medium text-text-muted">
                  3. เมื่อเจอ faq_liveagent
                </label>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setNewAction("handoff")}
                    className={`flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors ${
                      newAction === "handoff"
                        ? "border-brand bg-brand/10 text-text"
                        : "border-border bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
                    }`}
                  >
                    <Headset size={16} />
                    <div className="text-left">
                      <div className="font-medium">ส่งแอดมิน</div>
                      <div className="text-xs text-text-muted">โอนไปคนทันที</div>
                    </div>
                  </button>
                  <button
                    onClick={() => setNewAction("bot_reply")}
                    className={`flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors ${
                      newAction === "bot_reply"
                        ? "border-brand bg-brand/10 text-text"
                        : "border-border bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
                    }`}
                  >
                    <Bot size={16} />
                    <div className="text-left">
                      <div className="font-medium">บอทตอบ</div>
                      <div className="text-xs text-text-muted">ให้บอทตอบต่อ</div>
                    </div>
                  </button>
                </div>
              </div>

              {/* ── Step 4: Toggle enabled ── */}
              <div className="flex items-center justify-between">
                <label className="text-sm text-text">เปิดใช้งาน</label>
                <div className="flex items-center gap-2">
                  <Badge tone={newEnabled ? "brand" : "neutral"}>
                    {newEnabled ? "เปิดใช้" : "ปิดใช้"}
                  </Badge>
                  <button
                    onClick={() => setNewEnabled(!newEnabled)}
                    title={newEnabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                    className="p-1.5 rounded hover:bg-base text-text-subtle hover:text-text"
                  >
                    <Power size={14} />
                  </button>
                </div>
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex gap-2 px-5 py-4 border-t border-border justify-end">
              <Button onClick={closeModal} variant="ghost" size="sm">
                ยกเลิก
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || selectedShops.length === 0}
                variant="primary"
                size="sm"
              >
                <Save size={14} className="mr-1" />
                {saving
                  ? "กำลังบันทึก..."
                  : `บันทึก ${selectedShops.length * selectedPlatforms.length || ""} รายการ`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

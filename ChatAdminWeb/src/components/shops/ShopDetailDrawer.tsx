"use client";
// ⚡ G4 — ShopDetailDrawer — แสดง workflow/trigger/persona/kb ของร้านนั้น
//   เปิดจาก /shops card click — drawer แบบ full screen พร้อม 4 tabs
//   แต่ละ tab: ดึงข้อมูล + filter ตาม shop + inline edit (กด edit → ขยาย card เป็นฟอร์ม)
//   ⚡ G4-fix2 — เปลี่ยนจาก link ไปหน้าอื่น → inline edit card แทน
import { useState, useEffect, useCallback, useMemo } from "react";
import { X, Search, Trash2, Power, Pencil, Save, XCircle, Workflow, Zap, Bot, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";

interface ShopRow {
  shop_id: string;
  shopname: string;
  platform: string;
  connected: boolean;
  enabled_for_chat?: boolean;
}

interface Props {
  shop: ShopRow | null;
  onClose: () => void;
}

type Tab = "workflows" | "triggers" | "persona" | "kb";

const tabs: { id: Tab; label: string; icon: typeof Workflow }[] = [
  { id: "workflows", label: "Workflow", icon: Workflow },
  { id: "triggers", label: "Trigger", icon: Zap },
  { id: "persona", label: "Persona", icon: Bot },
  { id: "kb", label: "Knowledge Base", icon: BookOpen },
];

export function ShopDetailDrawer({ shop, onClose }: Props) {
  const { user } = useAuth();
  const editable = canEditPage(user ?? null, "shop");
  const { catchError } = useToastError();
  const [tab, setTab] = useState<Tab>("workflows");
  const [search, setSearch] = useState("");

  const handleTabChange = (t: Tab) => {
    setTab(t);
    setSearch("");
  };

  if (!shop) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/50" onClick={onClose}>
      <div
        className="bg-surface w-full max-w-3xl h-full flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-text truncate">{shop.shopname}</h2>
              <Badge tone={shop.connected ? "brand" : "neutral"}>
                {shop.connected ? "เชื่อมต่อ" : "ปิดอยู่"}
              </Badge>
              {shop.enabled_for_chat === false && (
                <Badge tone="coral">แชทปิด</Badge>
              )}
            </div>
            <div className="text-[11px] text-text-muted mt-0.5">
              {shop.platform} · {shop.shop_id}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-surface-2 flex items-center justify-center transition-colors"
            title="ปิด"
          >
            <X size={18} className="text-text-muted" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => handleTabChange(t.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                  tab === t.id ? "text-brand border-b-2 border-brand" : "text-text-muted hover:text-text"
                }`}
              >
                <Icon size={14} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Search bar — instant filter */}
        <div className="px-4 py-2 border-b border-border shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`ค้นหาใน ${tabs.find((t) => t.id === tab)?.label}...`}
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-md bg-surface-2 border border-border text-text placeholder:text-text-subtle focus:outline-none focus:border-brand"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "workflows" && <WorkflowsTab shop={shop} search={search} editable={editable} catchError={catchError} />}
          {tab === "triggers" && <TriggersTab shop={shop} search={search} editable={editable} catchError={catchError} />}
          {tab === "persona" && <PersonaTab shop={shop} search={search} editable={editable} catchError={catchError} />}
          {tab === "kb" && <KBTab shop={shop} search={search} editable={editable} catchError={catchError} />}
        </div>
      </div>
    </div>
  );
}

// ─── Shared input components ────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] text-text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full px-2 py-1 text-xs rounded-md bg-surface-2 border border-border text-text focus:outline-none focus:border-brand";

function EditActions({ onSave, onCancel, saving }: { onSave: () => void; onCancel: () => void; saving: boolean }) {
  return (
    <div className="flex items-center gap-2 mt-2">
      <button
        onClick={onSave}
        disabled={saving}
        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-brand text-white hover:bg-brand/90 disabled:opacity-50"
      >
        {saving ? <Loading size={12} /> : <Save size={12} />} บันทึก
      </button>
      <button
        onClick={onCancel}
        disabled={saving}
        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-border text-text-muted hover:text-text"
      >
        <XCircle size={12} /> ยกเลิก
      </button>
    </div>
  );
}

// ─── Workflows Tab ──────────────────────────────────────────
interface WorkflowRow {
  workflow_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  platforms?: string[];
  shop_ids?: string[];
  nodes?: unknown[];
  updated_at?: string;
}

function WorkflowsTab({ shop, search, editable, catchError }: {
  shop: ShopRow; search: string; editable: boolean; catchError: (e: unknown, msg: string) => void;
}) {
  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", priority: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ rows: WorkflowRow[]; total: number }>("/workflows", {
        params: { shop_id: shop.shop_id },
      });
      setRows(r.data.rows || []);
    } catch (err) {
      catchError(err, "โหลด workflow ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [shop.shop_id, catchError]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((w) =>
      w.name.toLowerCase().includes(q) ||
      (w.shop_ids || []).some((s) => s.toLowerCase().includes(q))
    );
  }, [rows, search]);

  function startEdit(w: WorkflowRow) {
    setEditingId(w.workflow_id);
    setForm({ name: w.name, description: w.description || "", priority: w.priority });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await api().patch(`/workflows/${editingId}`, {
        name: form.name,
        description: form.description,
        priority: Number(form.priority),
      });
      toast.success("บันทึก workflow แล้ว");
      setEditingId(null);
      load();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(w: WorkflowRow) {
    try {
      await api().post(`/workflows/${w.workflow_id}/toggle`, { enabled: !w.enabled });
      toast.success(`${w.enabled ? "ปิด" : "เปิด"} workflow แล้ว`);
      load();
    } catch (err) {
      catchError(err, "toggle ไม่สำเร็จ");
    }
  }

  async function handleDelete(w: WorkflowRow) {
    const ok = await confirm.ask({
      title: "ลบ workflow?",
      message: `"${w.name}" — ไม่สามารถกู้คืนได้`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api().delete(`/workflows/${w.workflow_id}`);
      toast.success("ลบ workflow แล้ว");
      load();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loading size={20} /></div>;
  if (filtered.length === 0) return <EmptyState icon={Workflow} label="workflow" search={search} />;

  return (
    <div className="space-y-2">
      {filtered.map((w) => {
        const isAllShops = !w.shop_ids || w.shop_ids.length === 0;
        const isEditing = editingId === w.workflow_id;
        return (
          <div key={w.workflow_id} className="p-3 rounded-lg bg-surface-2 border border-border">
            {isEditing ? (
              <div className="space-y-2">
                <Field label="ชื่อ">
                  <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="คำอธิบาย">
                  <textarea className={inputCls} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </Field>
                <Field label="Priority (ตัวเลข — น้อย = สำคัญกว่า)">
                  <input type="number" className={inputCls} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
                </Field>
                <div className="text-[10px] text-text-subtle">
                  ⚠ แก้ graph nodes/edges ได้ที่หน้า Workflow Editor เท่านั้น
                </div>
                <EditActions onSave={handleSave} onCancel={() => setEditingId(null)} saving={saving} />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text truncate flex items-center gap-2">
                    {w.name}
                    {isAllShops && <Badge tone="pale">ทุกร้าน</Badge>}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    priority: {w.priority} · {w.nodes?.length || 0} nodes ·
                    {w.enabled ? <span className="text-green-400"> เปิด</span> : <span className="text-text-subtle"> ปิด</span>}
                  </div>
                </div>
                {editable && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(w)} className="p-1.5 rounded hover:bg-surface-3" title="แก้ไข">
                      <Pencil size={14} className="text-text-muted" />
                    </button>
                    <button onClick={() => handleToggle(w)} className="p-1.5 rounded hover:bg-surface-3" title={w.enabled ? "ปิด" : "เปิด"}>
                      <Power size={14} className={w.enabled ? "text-green-400" : "text-text-subtle"} />
                    </button>
                    <button onClick={() => handleDelete(w)} className="p-1.5 rounded hover:bg-surface-3" title="ลบ">
                      <Trash2 size={14} className="text-red-400" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Triggers Tab ───────────────────────────────────────────
interface TriggerRow {
  trigger_id: string;
  name: string;
  enabled: boolean;
  action: string;
  platforms?: string[];
  shop_ids?: string[];
  keywords?: string[];
  topic?: string;
  bot_template?: string;
  updated_at?: string;
}

function TriggersTab({ shop, search, editable, catchError }: {
  shop: ShopRow; search: string; editable: boolean; catchError: (e: unknown, msg: string) => void;
}) {
  const [rows, setRows] = useState<TriggerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", keywords: "", action: "bot_answer", bot_template: "", topic: "general" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ rows: TriggerRow[]; total: number }>("/triggers", {
        params: { shop_id: shop.shop_id },
      });
      setRows(r.data.rows || []);
    } catch (err) {
      catchError(err, "โหลด trigger ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [shop.shop_id, catchError]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((t) =>
      t.name.toLowerCase().includes(q) ||
      (t.keywords || []).some((k) => k.toLowerCase().includes(q)) ||
      (t.shop_ids || []).some((s) => s.toLowerCase().includes(q))
    );
  }, [rows, search]);

  function startEdit(t: TriggerRow) {
    setEditingId(t.trigger_id);
    setForm({
      name: t.name,
      keywords: (t.keywords || []).join(", "),
      action: t.action || "bot_answer",
      bot_template: t.bot_template || "",
      topic: t.topic || "general",
    });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await api().patch(`/triggers/${editingId}`, {
        name: form.name,
        keywords: form.keywords.split(",").map((k) => k.trim()).filter(Boolean),
        action: form.action,
        bot_template: form.bot_template,
        topic: form.topic,
      });
      toast.success("บันทึก trigger แล้ว");
      setEditingId(null);
      load();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(t: TriggerRow) {
    try {
      await api().post(`/triggers/${t.trigger_id}/toggle`, { enabled: !t.enabled });
      toast.success(`${t.enabled ? "ปิด" : "เปิด"} trigger แล้ว`);
      load();
    } catch (err) {
      catchError(err, "toggle ไม่สำเร็จ");
    }
  }

  async function handleDelete(t: TriggerRow) {
    const ok = await confirm.ask({
      title: "ลบ trigger?",
      message: `"${t.name}" — ไม่สามารถกู้คืนได้`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api().delete(`/triggers/${t.trigger_id}`);
      toast.success("ลบ trigger แล้ว");
      load();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loading size={20} /></div>;
  if (filtered.length === 0) return <EmptyState icon={Zap} label="trigger" search={search} />;

  return (
    <div className="space-y-2">
      {filtered.map((t) => {
        const isAllShops = !t.shop_ids || t.shop_ids.length === 0;
        const isEditing = editingId === t.trigger_id;
        return (
          <div key={t.trigger_id} className="p-3 rounded-lg bg-surface-2 border border-border">
            {isEditing ? (
              <div className="space-y-2">
                <Field label="ชื่อ">
                  <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="คำค้นหา (คั่นด้วยจุลภาค)">
                  <input className={inputCls} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="เช่น ราคา, ลด, โปรโมชั่น" />
                </Field>
                <Field label="การกระทำ">
                  <select className={inputCls} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                    <option value="bot_answer">บอทตอบ</option>
                    <option value="handoff_admin">ส่งแอดมิน</option>
                  </select>
                </Field>
                {form.action === "bot_answer" && (
                  <Field label="Template คำตอบบอท">
                    <textarea className={inputCls} rows={2} value={form.bot_template} onChange={(e) => setForm({ ...form, bot_template: e.target.value })} />
                  </Field>
                )}
                <Field label="หัวข้อ">
                  <select className={inputCls} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}>
                    <option value="general">ทั่วไป</option>
                    <option value="product">สินค้า</option>
                    <option value="shipping">จัดส่ง</option>
                    <option value="payment">การชำระเงิน</option>
                    <option value="warranty">รับประกัน</option>
                    <option value="return">คืนสินค้า</option>
                  </select>
                </Field>
                <EditActions onSave={handleSave} onCancel={() => setEditingId(null)} saving={saving} />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text truncate flex items-center gap-2">
                    {t.name}
                    {isAllShops && <Badge tone="pale">ทุกร้าน</Badge>}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    action: {t.action} · {(t.keywords || []).slice(0, 3).join(", ")}
                    {t.keywords && t.keywords.length > 3 && "..."}
                    {t.enabled ? <span className="text-green-400"> · เปิด</span> : <span className="text-text-subtle"> · ปิด</span>}
                  </div>
                </div>
                {editable && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(t)} className="p-1.5 rounded hover:bg-surface-3" title="แก้ไข">
                      <Pencil size={14} className="text-text-muted" />
                    </button>
                    <button onClick={() => handleToggle(t)} className="p-1.5 rounded hover:bg-surface-3" title={t.enabled ? "ปิด" : "เปิด"}>
                      <Power size={14} className={t.enabled ? "text-green-400" : "text-text-subtle"} />
                    </button>
                    <button onClick={() => handleDelete(t)} className="p-1.5 rounded hover:bg-surface-3" title="ลบ">
                      <Trash2 size={14} className="text-red-400" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Persona Tab ────────────────────────────────────────────
interface PersonaRow {
  persona_id: string;
  shopname: string;
  platform: string;
  bot_name: string;
  enabled: boolean;
  notes?: string;
  updated_at?: string;
}

function PersonaTab({ shop, search, editable, catchError }: {
  shop: ShopRow; search: string; editable: boolean; catchError: (e: unknown, msg: string) => void;
}) {
  const [rows, setRows] = useState<PersonaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ bot_name: "", notes: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ rows: PersonaRow[] }>("/persona", {
        params: { platform: shop.platform },
      });
      const all = r.data.rows || [];
      const matched = all.filter((p) =>
        p.shopname === shop.shopname ||
        p.shopname === "all" ||
        p.shopname === "" ||
        p.shopname === "*"
      );
      setRows(matched.length > 0 ? matched : all.filter((p) => p.platform === shop.platform));
    } catch (err) {
      catchError(err, "โหลด persona ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [shop.shopname, shop.platform, catchError]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((p) =>
      p.bot_name.toLowerCase().includes(q) ||
      p.shopname.toLowerCase().includes(q) ||
      (p.notes || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  function startEdit(p: PersonaRow) {
    setEditingId(p.persona_id);
    setForm({ bot_name: p.bot_name, notes: p.notes || "" });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await api().patch(`/persona/${editingId}`, {
        bot_name: form.bot_name,
        notes: form.notes,
      });
      toast.success("บันทึก persona แล้ว");
      setEditingId(null);
      load();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(p: PersonaRow) {
    try {
      // ⚡ persona ไม่มี toggle endpoint แยก — ใช้ PATCH ส่ง enabled
      await api().patch(`/persona/${p.persona_id}`, { enabled: !p.enabled });
      toast.success(`${p.enabled ? "ปิด" : "เปิด"} persona แล้ว`);
      load();
    } catch (err) {
      catchError(err, "toggle ไม่สำเร็จ");
    }
  }

  async function handleDelete(p: PersonaRow) {
    const ok = await confirm.ask({
      title: "ลบ persona?",
      message: `"${p.bot_name}" — ไม่สามารถกู้คืนได้`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api().delete(`/persona/${p.persona_id}`);
      toast.success("ลบ persona แล้ว");
      load();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loading size={20} /></div>;
  if (filtered.length === 0) return <EmptyState icon={Bot} label="persona" search={search} />;

  return (
    <div className="space-y-2">
      {filtered.map((p) => {
        const isThisShop = p.shopname === shop.shopname;
        const isEditing = editingId === p.persona_id;
        return (
          <div key={p.persona_id} className="p-3 rounded-lg bg-surface-2 border border-border">
            {isEditing ? (
              <div className="space-y-2">
                <Field label="ชื่อบอท">
                  <input className={inputCls} value={form.bot_name} onChange={(e) => setForm({ ...form, bot_name: e.target.value })} />
                </Field>
                <Field label="Notes">
                  <textarea className={inputCls} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </Field>
                <EditActions onSave={handleSave} onCancel={() => setEditingId(null)} saving={saving} />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text truncate flex items-center gap-2">
                    {p.bot_name}
                    {isThisShop
                      ? <Badge tone="brand">ร้านนี้</Badge>
                      : <Badge tone="pale">ทุกร้าน/{p.shopname}</Badge>
                    }
                  </div>
                  <div className="text-[10px] text-text-muted">
                    {p.platform} · {p.notes || "ไม่มี notes"}
                    {p.enabled ? <span className="text-green-400"> · เปิด</span> : <span className="text-text-subtle"> · ปิด</span>}
                  </div>
                </div>
                {editable && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(p)} className="p-1.5 rounded hover:bg-surface-3" title="แก้ไข">
                      <Pencil size={14} className="text-text-muted" />
                    </button>
                    <button onClick={() => handleToggle(p)} className="p-1.5 rounded hover:bg-surface-3" title={p.enabled ? "ปิด" : "เปิด"}>
                      <Power size={14} className={p.enabled ? "text-green-400" : "text-text-subtle"} />
                    </button>
                    <button onClick={() => handleDelete(p)} className="p-1.5 rounded hover:bg-surface-3" title="ลบ">
                      <Trash2 size={14} className="text-red-400" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── KB Tab ─────────────────────────────────────────────────
interface KBRow {
  _id?: string;
  kb_id?: string;
  topic: string;
  type: string;
  platform: string;
  active: boolean;
  answer?: string;
  brand?: string;
  model?: string;
  category?: string;
  highlights?: string;
  description?: string;
  warranty_period?: string;
  updated_at?: string;
}

function KBTab({ shop, search, editable, catchError }: {
  shop: ShopRow; search: string; editable: boolean; catchError: (e: unknown, msg: string) => void;
}) {
  const [rows, setRows] = useState<KBRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{ topic: string; answer: string; brand: string; model: string; category: string; highlights: string; description: string; warranty_period: string }>({
    topic: "", answer: "", brand: "", model: "", category: "", highlights: "", description: "", warranty_period: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<{ rows: KBRow[]; total: number }>("/kb", {
        params: { platform: shop.platform, limit: 500 },
      });
      setRows(r.data.rows || []);
    } catch (err) {
      catchError(err, "โหลด KB ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [shop.platform, catchError]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((k) =>
      k.topic.toLowerCase().includes(q) ||
      (k.brand || "").toLowerCase().includes(q) ||
      (k.model || "").toLowerCase().includes(q) ||
      (k.category || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  function startEdit(k: KBRow) {
    const id = k.kb_id || k._id || "";
    setEditingId(id);
    setForm({
      topic: k.topic || "",
      answer: k.answer || "",
      brand: k.brand || "",
      model: k.model || "",
      category: k.category || "",
      highlights: k.highlights || "",
      description: k.description || "",
      warranty_period: k.warranty_period || "",
    });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await api().put(`/kb/${editingId}`, form);
      toast.success("บันทึก KB แล้ว");
      setEditingId(null);
      load();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(k: KBRow) {
    const id = k.kb_id || k._id;
    if (!id) return;
    try {
      // ⚡ KB toggle เป็น PATCH ไม่ใช่ POST
      await api().patch(`/kb/${id}/toggle`, { active: !k.active });
      toast.success(`${k.active ? "ปิด" : "เปิด"} KB แล้ว`);
      load();
    } catch (err) {
      catchError(err, "toggle ไม่สำเร็จ");
    }
  }

  async function handleDelete(k: KBRow) {
    const id = k.kb_id || k._id;
    if (!id) return;
    const ok = await confirm.ask({
      title: "ลบ KB entry?",
      message: `"${k.topic}" — ไม่สามารถกู้คืนได้`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api().delete(`/kb/${id}`);
      toast.success("ลบ KB แล้ว");
      load();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loading size={20} /></div>;
  if (filtered.length === 0) return <EmptyState icon={BookOpen} label="knowledge base" search={search} />;

  return (
    <div className="space-y-2">
      {filtered.map((k, idx) => {
        const key = k.kb_id || k._id || `kb-${idx}`;
        const id = k.kb_id || k._id || "";
        const isAllPlatform = k.platform === "all" || !k.platform;
        const isEditing = editingId === id;
        const isProductSpec = k.type === "product_spec";
        return (
          <div key={key} className="p-3 rounded-lg bg-surface-2 border border-border">
            {isEditing ? (
              <div className="space-y-2">
                <Field label="หัวข้อ">
                  <input className={inputCls} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} />
                </Field>
                {isProductSpec ? (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <Field label="แบรนด์">
                        <input className={inputCls} value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
                      </Field>
                      <Field label="รุ่น">
                        <input className={inputCls} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
                      </Field>
                      <Field label="หมวดหมู่">
                        <input className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                      </Field>
                    </div>
                    <Field label="จุดเด่น">
                      <textarea className={inputCls} rows={2} value={form.highlights} onChange={(e) => setForm({ ...form, highlights: e.target.value })} />
                    </Field>
                    <Field label="คำอธิบาย">
                      <textarea className={inputCls} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                    </Field>
                    <Field label="ระยะเวลารับประกัน">
                      <input className={inputCls} value={form.warranty_period} onChange={(e) => setForm({ ...form, warranty_period: e.target.value })} />
                    </Field>
                  </>
                ) : (
                  <Field label="คำตอบ">
                    <textarea className={inputCls} rows={4} value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} />
                  </Field>
                )}
                <EditActions onSave={handleSave} onCancel={() => setEditingId(null)} saving={saving} />
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text truncate flex items-center gap-2">
                    {k.topic}
                    {isAllPlatform && <Badge tone="pale">ทุกแพลตฟอร์ม</Badge>}
                  </div>
                  <div className="text-[10px] text-text-muted">
                    {k.type} · {k.brand || "-"} · {k.model || "-"} · {k.category || "-"}
                    {k.active ? <span className="text-green-400"> · เปิด</span> : <span className="text-text-subtle"> · ปิด</span>}
                  </div>
                </div>
                {editable && (
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(k)} className="p-1.5 rounded hover:bg-surface-3" title="แก้ไข">
                      <Pencil size={14} className="text-text-muted" />
                    </button>
                    <button onClick={() => handleToggle(k)} className="p-1.5 rounded hover:bg-surface-3" title={k.active ? "ปิด" : "เปิด"}>
                      <Power size={14} className={k.active ? "text-green-400" : "text-text-subtle"} />
                    </button>
                    <button onClick={() => handleDelete(k)} className="p-1.5 rounded hover:bg-surface-3" title="ลบ">
                      <Trash2 size={14} className="text-red-400" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Empty State ────────────────────────────────────────────
function EmptyState({ icon: Icon, label, search }: { icon: typeof Workflow; label: string; search: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon size={32} className="text-text-subtle mb-2" />
      <p className="text-xs text-text-muted">
        {search ? `ไม่พบ${label}ที่ match "${search}"` : `ยังไม่มี${label}สำหรับร้านนี้`}
      </p>
    </div>
  );
}

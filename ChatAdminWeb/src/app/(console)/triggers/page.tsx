"use client";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Zap, Plus, X, Pencil, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEdit } from "@/lib/roles";
import type { TriggerRule, Topic } from "@/lib/types";

const mockTriggers: TriggerRule[] = [
  {
    id: "tr_001",
    name: "เคลมสินค้า",
    keywords: ["เคลม", "ส่งซ่อม", "พัง", "เสีย"],
    topic: "claim",
    action: "bot_answer",
    bot_template: "กรุณาแนบวิดีโอและเลขคำสั่งซื้อ แอดมินจะรับเรื่องค่ะ",
    enabled: true,
  },
  {
    id: "tr_002",
    name: "ขอใบกำกับภาษี",
    keywords: ["ใบกำกับภาษี", "ใบกำกับ", "tax invoice"],
    topic: "tax_invoice",
    action: "handoff_admin",
    enabled: true,
  },
  {
    id: "tr_003",
    name: "แจ้งปัญหา",
    keywords: ["แจ้งปัญหา", "ไม่ทำงาน", "error"],
    topic: "problem_report",
    action: "handoff_admin",
    enabled: false,
  },
];

const topicLabels: Record<string, string> = {
  product_inquiry: "สินค้า",
  product_compare: "เปรียบเทียบ",
  usage_help: "การใช้งาน",
  claim: "เคลม",
  warranty: "รับประกัน",
  problem_report: "แจ้งปัญหา",
  tax_invoice: "ใบกำกับภาษี",
  shipping: "จัดส่ง",
  general: "ทั่วไป",
  handoff: "ส่งแอดมิน",
};

interface FormData {
  id?: string;
  name: string;
  keywords: string[];
  topic: Topic;
  action: "bot_answer" | "handoff_admin";
  bot_template: string;
  shop_id: string;
  enabled: boolean;
}

const emptyForm: FormData = {
  name: "",
  keywords: [],
  topic: "general",
  action: "bot_answer",
  bot_template: "",
  shop_id: "",
  enabled: true,
};

export default function TriggersPage() {
  const { user } = useAuth();
  const editable = canEdit(user);
  const [triggers, setTriggers] = useState<TriggerRule[]>(mockTriggers);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TriggerRule | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [keywordInput, setKeywordInput] = useState("");

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setKeywordInput("");
    setShowForm(true);
  }

  function openEdit(t: TriggerRule) {
    setEditing(t);
    setForm({
      id: t.id,
      name: t.name || "",
      keywords: t.keywords,
      topic: t.topic,
      action: t.action,
      bot_template: t.bot_template || "",
      shop_id: t.shop_id || "",
      enabled: t.enabled,
    });
    setKeywordInput("");
    setShowForm(true);
  }

  function addKeyword() {
    const kw = keywordInput.trim();
    if (!kw) return;
    if (!form.keywords.includes(kw)) {
      setForm({ ...form, keywords: [...form.keywords, kw] });
    }
    setKeywordInput("");
  }

  function removeKeyword(kw: string) {
    setForm({ ...form, keywords: form.keywords.filter((k) => k !== kw) });
  }

  function handleSave() {
    if (form.keywords.length === 0) return;
    if (editing) {
      setTriggers((prev) =>
        prev.map((t) =>
          t.id === editing.id
            ? { ...t, ...form, shop_id: form.shop_id || undefined }
            : t
        )
      );
    } else {
      const newTrigger: TriggerRule = {
        id: `tr_${String(Date.now()).slice(-6)}`,
        ...form,
        shop_id: form.shop_id || undefined,
      };
      setTriggers((prev) => [newTrigger, ...prev]);
    }
    setShowForm(false);
  }

  function handleDelete(id: string) {
    if (!confirm("ต้องการลบทริกเกอร์นี้ใช่ไหม?")) return;
    setTriggers((prev) => prev.filter((t) => t.id !== id));
  }

  function toggleEnabled(id: string) {
    setTriggers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t))
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text">ทริกเกอร์</h1>
          <p className="text-sm text-text-muted">
            {editable ? "ตั้งค่าคีย์เวิร์ดที่บอทจะส่งต่อแอดมิน" : "ดูคีย์เวิร์ดที่บอทจะส่งต่อแอดมิน"}
          </p>
        </div>
        {editable && (
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} /> เพิ่มทริกเกอร์
          </Button>
        )}
      </div>

      {triggers.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="ไม่มีทริกเกอร์"
          description="สร้างทริกเกอร์เพื่อกำหนดว่าคำไหนส่งแอดมิน"
        />
      ) : (
        <div className="space-y-2">
          {triggers.map((t) => (
            <div
              key={t.id}
              className="bg-surface rounded-xl border border-border p-4 hover:border-pale-sky transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Title row */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-sm font-semibold text-text">
                      {t.name || `ทริกเกอร์ ${t.id}`}
                    </span>
                    <Badge tone={t.action === "handoff_admin" ? "coral" : "brand"}>
                      {t.action === "handoff_admin" ? "ส่งแอดมิน" : "บอทตอบ"}
                    </Badge>
                    <Badge tone="pale">{topicLabels[t.topic] || t.topic}</Badge>
                    {!t.enabled && <Badge tone="neutral">ปิดอยู่</Badge>}
                    {t.shop_id && <Badge tone="neutral">ร้าน: {t.shop_id}</Badge>}
                  </div>

                  {/* Keywords */}
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {t.keywords.map((k) => (
                      <span
                        key={k}
                        className="text-xs bg-surface-2 rounded-md px-2 py-0.5 font-mono text-text"
                      >
                        {k}
                      </span>
                    ))}
                  </div>

                  {/* Bot template */}
                  {t.bot_template && (
                    <div className="bg-surface-2 rounded-md px-3 py-2 mt-2">
                      <div className="text-[10px] text-text-subtle uppercase tracking-wide mb-0.5">
                        คำตอบบอท
                      </div>
                      <p className="text-xs text-text-muted italic">
                        &quot;{t.bot_template}&quot;
                      </p>
                    </div>
                  )}
                </div>

                {editable && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => toggleEnabled(t.id)}
                      className={`w-10 h-5 rounded-full transition-colors ${
                        t.enabled ? "bg-brand" : "bg-surface-2"
                      }`}
                      title={t.enabled ? "ปิด" : "เปิด"}
                    >
                      <div
                        className={`w-4 h-4 bg-white rounded-full transition-transform ${
                          t.enabled ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                    <button
                      onClick={() => openEdit(t)}
                      className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
                      title="แก้ไข"
                    >
                      <Pencil size={13} className="text-text-muted" />
                    </button>
                    <button
                      onClick={() => handleDelete(t.id)}
                      className="w-7 h-7 rounded-md hover:bg-vibrant-coral-soft flex items-center justify-center"
                      title="ลบ"
                    >
                      <Trash2 size={13} className="text-text-muted" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Trigger Form Modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowForm(false)}
        >
          <div
            className="bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface">
              <h2 className="text-base font-semibold text-text">
                {editing ? "แก้ไขทริกเกอร์" : "เพิ่มทริกเกอร์"}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center"
              >
                <X size={16} className="text-text-muted" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">ชื่อทริกเกอร์</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="เช่น เคลมสินค้า"
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </div>

              {/* Keywords */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">คีย์เวิร์ด *</label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={keywordInput}
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addKeyword();
                      }
                    }}
                    placeholder="พิมพ์แล้วกด Enter"
                    className="flex-1 h-10 px-3 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
                  />
                  <Button variant="outline" size="md" onClick={addKeyword} className="shrink-0">
                    เพิ่ม
                  </Button>
                </div>
                {form.keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {form.keywords.map((k) => (
                      <span
                        key={k}
                        className="inline-flex items-center gap-1 text-xs bg-brand-soft text-brand rounded-md px-2 py-1 font-mono"
                      >
                        {k}
                        <button onClick={() => removeKeyword(k)} className="hover:text-vibrant-coral">
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Action */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">การกระทำ</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setForm({ ...form, action: "bot_answer" })}
                    className={`flex-1 h-10 rounded-lg border text-sm transition-colors ${
                      form.action === "bot_answer"
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border text-text-muted hover:bg-surface-2"
                    }`}
                  >
                    บอทตอบ
                  </button>
                  <button
                    onClick={() => setForm({ ...form, action: "handoff_admin" })}
                    className={`flex-1 h-10 rounded-lg border text-sm transition-colors ${
                      form.action === "handoff_admin"
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border text-text-muted hover:bg-surface-2"
                    }`}
                  >
                    ส่งแอดมิน
                  </button>
                </div>
              </div>

              {/* Topic */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">หัวข้อ</label>
                <select
                  value={form.topic}
                  onChange={(e) => setForm({ ...form, topic: e.target.value as Topic })}
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/30"
                >
                  {Object.entries(topicLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              {/* Shop scope */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">
                  ร้านค้า (ไม่ใส่ = ทุกร้าน)
                </label>
                <input
                  type="text"
                  value={form.shop_id}
                  onChange={(e) => setForm({ ...form, shop_id: e.target.value })}
                  placeholder="เช่น shop_123"
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </div>

              {/* Bot template (only for bot_answer) */}
              {form.action === "bot_answer" && (
                <div>
                  <label className="block text-sm font-medium text-text mb-1.5">คำตอบบอท</label>
                  <textarea
                    value={form.bot_template}
                    onChange={(e) => setForm({ ...form, bot_template: e.target.value })}
                    placeholder="เช่น กรุณาแนบวิดีโอและเลขคำสั่งซื้อ แอดมินจะรับเรื่องค่ะ"
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30 resize-none"
                  />
                </div>
              )}

              {/* Enabled */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="w-4 h-4 rounded accent-brand"
                />
                <span className="text-sm text-text">เปิดใช้งาน</span>
              </label>

              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowForm(false)}>
                  ยกเลิก
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleSave}
                  disabled={form.keywords.length === 0}
                >
                  {editing ? "บันทึก" : "สร้าง"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

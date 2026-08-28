// /persona — ตั้งชื่อตัวแทนบอท (persona) ของแต่ละร้านในเครือ
//
// Schema แบบเรียบง่ายตามที่ user ยืนยัน:
//   - ร้านละ 1 persona (shopname + platform = key)
//   - ตั้งแค่ bot_name ของร้านนั้น
//   - ถ้าไม่ได้ตั้ง → chatbot ใช้ "ชื่อร้าน" แบบเดิม (default behavior)
//
// บุคลิกหลัก (ค่ะ/นะคะ/ผู้หญิง) อยู่ใน SYSTEM_INSTRUCTION ส่วนกลาง — เหมือนกันทุกร้าน
// persona ร้านเป็นชั้นบนสุดที่เพิ่ม "ชื่อ" ให้บอทของร้านนั้น
"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Avatar } from "@/components/ui/Avatar";
import { PlatformIcon } from "@/components/ui/PlatformIcon";
import {
  Bot, Plus, Pencil, Trash2, X, Search, Store, Globe, ChevronDown, Save,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { personaService, type ShopPersonaRow, type PersonaPlatform } from "@/lib/services";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/apiClient";

interface FormState {
  shopname: string;
  platform: PersonaPlatform;
  bot_name: string;
  notes: string;
}

const emptyForm: FormState = {
  shopname: "",
  platform: "shopee",
  bot_name: "",
  notes: "",
};

const ALL_PLATFORMS: { value: PersonaPlatform; label: string }[] = [
  { value: "shopee", label: "Shopee" },
  { value: "tiktok", label: "TikTok" },
  { value: "lazada", label: "Lazada" },
];

interface ShopOption {
  shopname: string;
  platform: PersonaPlatform;
}

export default function PersonaPage() {
  const { catchError } = useToastError();
  const [rows, setRows] = useState<ShopPersonaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterPlatform, setFilterPlatform] = useState<PersonaPlatform | "all">("all");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ShopPersonaRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [allShops, setAllShops] = useState<ShopOption[]>([]);
  const [showShopDd, setShowShopDd] = useState(false);
  const [showPlatformDd, setShowPlatformDd] = useState(false);
  const [saving, setSaving] = useState(false);

  // โหลดร้านทั้งหมดจาก chatbot /shops (ใช้ shopname ที่ chatbot รู้จักจริง
  // เพราะ chatbot รับ req.shop แล้วดึง persona ด้วย shopname นี้ — ต้องตรงกัน)
  // chatbot /shops คืน { shops: ["shopname1", "shopname2", ...] } — string[] อย่างเดียว
  // เรา assume platform = "shopee" เพราะ chatbot นี้เป็น shopee bot เท่านั้น
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
      .catch(() => setAllShops([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await personaService.list({
        platform: filterPlatform === "all" ? undefined : filterPlatform,
        search: search || undefined,
      });
      setRows(data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filterPlatform, search]);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(row: ShopPersonaRow) {
    setEditing(row);
    setForm({
      shopname: row.shopname,
      platform: row.platform,
      bot_name: row.bot_name,
      notes: row.notes || "",
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.shopname.trim() || !form.bot_name.trim()) {
      toast.error("ต้องระบุร้านและชื่อตัวแทน");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        // ใช้ PATCH แก้ bot_name + notes (แก้ผ่าน persona_id)
        await personaService.patch(editing.persona_id, {
          bot_name: form.bot_name.trim(),
          notes: form.notes.trim() || undefined,
        });
        toast.success(`แก้ไข "${form.bot_name}" ของร้าน ${form.shopname} แล้ว`);
      } else {
        // สร้างใหม่ใช้ POST (upsert)
        await personaService.upsert({
          shopname: form.shopname.trim(),
          platform: form.platform,
          bot_name: form.bot_name.trim(),
          notes: form.notes.trim() || undefined,
        });
        toast.success(`ตั้ง "${form.bot_name}" เป็นตัวแทนร้าน ${form.shopname} แล้ว`);
      }
      setShowForm(false);
      await load();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(row: ShopPersonaRow) {
    const newState = !row.enabled;
    const ok = await confirm.ask({
      title: newState ? "เปิดใช้งาน?" : "ปิดใช้งาน?",
      message: `"${row.bot_name}" — ${newState ? "จะใช้งานได้" : "จะไม่ใช้งาน"} ต้องการจะ${newState ? "เปิด" : "ปิด"}จริงๆ ใช่ไหมคะ?`,
      confirmText: newState ? "เปิดใช้งาน" : "ปิดใช้งาน",
    });
    if (!ok) return;
    try {
      await personaService.toggle(row.persona_id, newState);
      toast.success(`${newState ? "เปิด" : "ปิด"} "${row.bot_name}" แล้ว`);
      await load();
    } catch (err) {
      catchError(err, "เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  async function handleDelete(row: ShopPersonaRow) {
    const yes = await confirm.ask({
      title: `ลบตัวแทน "${row.bot_name}"?`,
      message: `หลังลบ บอทของร้าน ${row.shopname} จะกลับไปใช้ "ชื่อร้าน" แบบเดิม (ไม่มีชื่อตัวแทน)`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!yes) return;
    try {
      await personaService.delete(row.persona_id);
      toast.success(`ลบ "${row.bot_name}" ของร้าน ${row.shopname} แล้ว`);
      await load();
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  // กรองร้านที่ยังไม่มี persona สำหรับ dropdown ตอนสร้างใหม่ (ป้องกัน duplicate)
  const availableShops = useMemo(() => {
    const existing = new Set(rows.map((r) => `${r.shopname}|${r.platform}`));
    return allShops.filter((s) => !existing.has(`${s.shopname}|${s.platform}`));
  }, [allShops, rows]);

  const platformLabel = (p: PersonaPlatform) => ALL_PLATFORMS.find((x) => x.value === p)?.label || p;

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-base">
      {/* Header */}
      <div className="border-b border-border bg-surface">
        <div className="px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-text flex items-center gap-2">
              <Bot size={20} className="text-brand" />
              ตัวแทนร้าน (Persona)
            </h1>
            <p className="text-sm text-text-subtle mt-1">
              ตั้งชื่อตัวแทนบอทของแต่ละร้าน — บุคลิกหลัก (ค่ะ/นะคะ) เหมือนกันทุกร้าน
              <br />
              ถ้าร้านยังไม่ได้ตั้ง persona บอทจะใช้ "ชื่อร้าน" แบบเดิม
            </p>
          </div>
          <Button onClick={openCreate} disabled={availableShops.length === 0}>
            <Plus size={16} className="mr-1" />
            เพิ่ม persona
          </Button>
        </div>

        {/* Filter bar */}
        <div className="px-6 pb-4 flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              placeholder="ค้นหาด้วยชื่อร้านหรือชื่อตัวแทน..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9 pr-3 rounded-lg border border-border bg-surface text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/30 w-72"
            />
          </div>

          {/* Platform filter dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowPlatformDd(!showPlatformDd)}
              className="h-9 px-3 rounded-lg border border-border bg-surface text-sm text-text flex items-center gap-2 hover:bg-base"
            >
              <Globe size={14} className="text-text-subtle" />
              {filterPlatform === "all" ? "ทุกแพลตฟอร์ม" : platformLabel(filterPlatform)}
              <ChevronDown size={14} className="text-text-subtle" />
            </button>
            {showPlatformDd && (
              <div className="absolute top-full left-0 mt-1 z-10 w-44 rounded-lg border border-border bg-surface shadow-lg">
                <button
                  onClick={() => { setFilterPlatform("all"); setShowPlatformDd(false); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-base rounded-t-lg"
                >ทุกแพลตฟอร์ม</button>
                {ALL_PLATFORMS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => { setFilterPlatform(p.value); setShowPlatformDd(false); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-base"
                  >{p.label}</button>
                ))}
              </div>
            )}
          </div>

          <span className="text-xs text-text-subtle ml-auto">{rows.length} ร้าน</span>
        </div>
      </div>

      {/* Content */}
      <div className="px-6 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loading size={32} />
            <p className="text-sm text-text-subtle">กำลังโหลด...</p>
          </div>
        ) : rows.length === 0 ? (
          <>
            <EmptyState
              icon={Bot as LucideIcon}
              title="ยังไม่มี persona ของร้าน"
              description="กด 'เพิ่ม persona' เพื่อตั้งชื่อตัวแทนบอทของร้านในเครือ — บอทของร้านที่ไม่ได้ตั้ง persona จะใช้ชื่อร้านแบบเดิม"
            />
            <div className="flex justify-center mt-4">
              <Button onClick={openCreate} disabled={availableShops.length === 0}>
                <Plus size={16} className="mr-1" />
                เพิ่ม persona
              </Button>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map((row) => (
              <div
                key={row.persona_id}
                className={`rounded-xl border bg-surface p-4 transition-shadow hover:shadow-md ${
                  row.enabled ? "border-border" : "border-border opacity-60"
                }`}
              >
                <div className="flex items-start gap-3">
                  <Avatar name={row.bot_name} size={40} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-text truncate">{row.bot_name}</h3>
                      <Badge tone={row.enabled ? "brand" : "neutral"}>
                        {row.enabled ? "เปิดใช้" : "ปิดใช้"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-text-subtle mt-1">
                      <Store size={12} />
                      <span className="truncate">{row.shopname}</span>
                      <PlatformIcon platform={row.platform} size={12} />
                      <span>{platformLabel(row.platform)}</span>
                    </div>
                    {row.notes && (
                      <p className="text-xs text-text-subtle mt-2 line-clamp-2">{row.notes}</p>
                    )}
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                  <span className="text-[11px] text-text-subtle">
                    แก้ล่าสุด {new Date(row.updated_at).toLocaleDateString("th-TH")}
                  </span>
                  <div className="flex items-center gap-2">
                    {/* toggle switch แบบ knowledge base */}
                    <button
                      onClick={() => handleToggle(row)}
                      className={`w-10 h-5 rounded-full transition-colors ${
                        row.enabled ? "bg-brand" : "bg-surface-2"
                      }`}
                      title={row.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                    >
                      <div
                        className={`w-4 h-4 bg-white rounded-full transition-transform ${
                          row.enabled ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                    <button
                      onClick={() => openEdit(row)}
                      title="แก้ไข"
                      className="p-1.5 rounded hover:bg-base text-text-subtle hover:text-text"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(row)}
                      title="ลบ"
                      className="p-1.5 rounded hover:bg-base text-vibrant-coral/70 hover:text-vibrant-coral"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Inline form modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-surface rounded-xl border border-border shadow-xl w-full max-w-md">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="font-semibold text-text">
                {editing ? "แก้ไข persona" : "เพิ่ม persona"}
              </h2>
              <button onClick={() => setShowForm(false)} className="p-1 rounded hover:bg-base text-text-subtle">
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {!editing && (
                <>
                  {/* เลือกร้าน (เฉพาะตอนสร้างใหม่) */}
                  <div className="relative">
                    <label className="block text-sm font-medium text-text mb-1.5">ร้านค้า</label>
                    <button
                      onClick={() => setShowShopDd(!showShopDd)}
                      className="w-full h-10 px-3 rounded-lg border border-border bg-surface text-sm text-text flex items-center justify-between hover:bg-base"
                    >
                      <span className={form.shopname ? "text-text" : "text-text-subtle"}>
                        {form.shopname || "เลือกร้าน..."}
                      </span>
                      <ChevronDown size={14} className="text-text-subtle" />
                    </button>
                    {showShopDd && (
                      <div className="absolute top-full left-0 right-0 mt-1 z-10 max-h-60 overflow-auto rounded-lg border border-border bg-surface shadow-lg">
                        {availableShops.length === 0 ? (
                          <div className="px-3 py-2 text-sm text-text-subtle">ร้านทุกร้านมี persona แล้ว</div>
                        ) : (
                          availableShops.map((s) => (
                            <button
                              key={`${s.shopname}|${s.platform}`}
                              onClick={() => {
                                setForm({ ...form, shopname: s.shopname, platform: s.platform });
                                setShowShopDd(false);
                              }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-base flex items-center gap-2"
                            >
                              <Store size={12} className="text-text-subtle" />
                              <span className="flex-1 truncate">{s.shopname}</span>
                              <span className="text-xs text-text-subtle">{s.platform}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* Platform (disabled — ใช้จากร้านที่เลือก) */}
                  <div>
                    <label className="block text-sm font-medium text-text mb-1.5">แพลตฟอร์ม</label>
                    <div className="h-10 px-3 rounded-lg border border-border bg-base text-sm text-text-subtle flex items-center gap-2">
                      <PlatformIcon platform={form.platform} size={14} />
                      {platformLabel(form.platform)}
                    </div>
                  </div>
                </>
              )}

              {editing && (
                <div className="rounded-lg bg-base p-3 text-sm">
                  <div className="flex items-center gap-2 text-text-subtle">
                    <Store size={14} />
                    <span>{editing.shopname}</span>
                    <PlatformIcon platform={editing.platform} size={12} />
                    <span>{platformLabel(editing.platform)}</span>
                  </div>
                </div>
              )}

              {/* bot_name */}
              <Input
                label="ชื่อตัวแทนบอท"
                placeholder="เช่น พิม, น้ำหวาน, มะยม"
                value={form.bot_name}
                onChange={(e) => setForm({ ...form, bot_name: e.target.value })}
                maxLength={50}
              />
              <p className="text-xs text-text-subtle -mt-2">
                บุคลิกหลัก (ค่ะ/นะคะ/ผู้หญิง) เหมือนกันทุกร้าน — เปลี่ยนแค่ชื่อเรียกตัวเองของบอทร้านนี้
              </p>

              {/* notes */}
              <Input
                label="หมายเหตุ (ไม่บังคับ)"
                placeholder="เช่น เปิดใช้ชั่วคราว หรือ เปลี่ยนเป็นชื่ออื่นในเทศกาล..."
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                maxLength={200}
              />
            </div>

            <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowForm(false)}>ยกเลิก</Button>
              <Button onClick={handleSave} disabled={saving || !form.bot_name.trim()}>
                <Save size={16} className="mr-1" />
                {saving ? "กำลังบันทึก..." : "บันทึก"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

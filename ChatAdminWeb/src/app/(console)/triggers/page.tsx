"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Zap, Plus, X, Pencil, Trash2, RefreshCw, Check, ChevronDown, Search, ArrowDownUp } from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEdit } from "@/lib/roles";
import { triggerService } from "@/lib/services";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import type { TriggerRule, Topic, Platform } from "@/lib/types";
import { api } from "@/lib/apiClient";

interface ShopOption {
  shop_id: string;
  shopname: string;
  platform: Platform;
}

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

const platformLabels: Record<Platform, string> = {
  shopee: "Shopee",
  tiktok: "TikTok",
  lazada: "Lazada",
};

interface FormData {
  id?: string;
  name: string;
  keywords: string[];
  topic: Topic;
  action: "bot_answer" | "handoff_admin";
  bot_template: string;
  platforms: Platform[];
  shop_ids: string[];
  enabled: boolean;
}

const emptyForm: FormData = {
  name: "",
  keywords: [],
  topic: "general",
  action: "bot_answer",
  bot_template: "",
  platforms: [],
  shop_ids: [],
  enabled: true,
};

// Multi-select dropdown (ใช้สำหรับ platforms และ shop_ids)
function MultiSelect<T extends string>({
  label,
  options,
  selected,
  onChange,
  allLabel,
  selectAll = true,
  disabled = false,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T[];
  onChange: (next: T[]) => void;
  allLabel: string; // ข้อความเมื่อเลือกทั้งหมด (= ไม่เลือก = applies to all)
  selectAll?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const allSelected = selected.length === 0;
  const displayLabel = allSelected
    ? allLabel
    : selected.length > 2
      ? `${selected.length} รายการ`
      : options.filter((o) => selected.includes(o.value)).map((o) => o.label).join(", ");

  function toggle(v: T) {
    if (selected.includes(v)) {
      onChange(selected.filter((x) => x !== v));
    } else {
      onChange([...selected, v]);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text flex items-center justify-between gap-2 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/30"
      >
        <span className="text-sm truncate">
          <span className="text-text-subtle">{label}: </span>
          <span className="font-medium">{displayLabel}</span>
        </span>
        <ChevronDown size={14} className="text-text-muted flex-shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-30 py-1 max-h-60 overflow-y-auto">
            {selectAll && (
              <button
                type="button"
                onClick={() => { onChange([]); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${allSelected ? "text-brand font-medium" : "text-text"}`}
              >
                <Check size={12} className={allSelected ? "" : "opacity-0"} />
                {allLabel} (ทุกร้าน/ทุกแพลตฟอร์ม)
              </button>
            )}
            {options.map((o) => {
              const sel = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${sel ? "text-brand font-medium" : "text-text"}`}
                >
                  <Check size={12} className={sel ? "" : "opacity-0"} />
                  {o.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function TriggersPage() {
  const { user } = useAuth();
  const editable = canEdit(user);
  const { catchError } = useToastError();
  const [triggers, setTriggers] = useState<TriggerRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TriggerRule | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [keywordInput, setKeywordInput] = useState("");
  const [allShops, setAllShops] = useState<ShopOption[]>([]);
  // Phase 7.10 — filter bar (search + platform + shop + enabled + sort)
  const [search, setSearch] = useState("");
  const [filterPlatforms, setFilterPlatforms] = useState<Platform[]>([]);
  const [filterShopIds, setFilterShopIds] = useState<string[]>([]);
  const [filterEnabled, setFilterEnabled] = useState<"all" | "enabled" | "disabled">("all");
  const [sortBy, setSortBy] = useState<"recent" | "oldest" | "recent_edit" | "oldest_edit" | "name">("recent");
  const [showPlatformDd, setShowPlatformDd] = useState(false);
  const [showShopDd, setShowShopDd] = useState(false);
  const [showEnabledDd, setShowEnabledDd] = useState(false);
  const [showSortDd, setShowSortDd] = useState(false);
  const [filterCreatedBy, setFilterCreatedBy] = useState<string>("all");
  const [filterUpdatedBy, setFilterUpdatedBy] = useState<string>("all");
  const [showCreatedDd, setShowCreatedDd] = useState(false);
  const [showUpdatedDd, setShowUpdatedDd] = useState(false);
  const [admins, setAdmins] = useState<{ admin_id: string; name?: string; username?: string }[]>([]);

  // โหลด shops list (สำหรับ multi-select ในฟอร์ม)
  // ⚡ dedupe by shop_id — /api/shops ส่งกลับ shop เดียวหลายบรรทัด (หนึ่งบรรทัดต่อ platform)
  //    รวม platform ทั้งหมดของร้านนั้นเป็น list ใน record เดียว — กัน duplicate React key
  useEffect(() => {
    api().get<{ rows: ShopOption[]; total: number }>("/shops")
      .then((r) => {
        const rows = r.data.rows || [];
        const map = new Map<string, ShopOption>();
        for (const s of rows) {
          const existing = map.get(s.shop_id);
          if (existing) {
            // ร้านเดียวกัน — รักษาไว้ ไม่เพิ่มซ้ำ (platform แรกที่เจอ)
          } else {
            map.set(s.shop_id, s);
          }
        }
        setAllShops(Array.from(map.values()));
      })
      .catch(() => setAllShops([]));
    api().get<{ users: { admin_id: string; name?: string; username?: string }[] }>("/users/list")
      .then((r) => setAdmins(r.data.users || []))
      .catch(() => setAdmins([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await triggerService.list();
      // แปลงจาก API shape → TriggerRule (map created_by → admin_id)
      setTriggers(rows.map((r) => {
        const raw = r as unknown as { trigger_id?: string; created_by?: string; updated_by?: string };
        return {
          ...r,
          id: raw.trigger_id || r.id,
          shop_ids: r.shop_ids || [],
          platforms: r.platforms || [],
          admin_id: raw.created_by,
          updated_by: raw.updated_by,
        };
      }) as TriggerRule[]);
    } catch (err) {
      console.error("load triggers failed", err);
      setTriggers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      platforms: t.platforms || [],
      shop_ids: t.shop_ids || [],
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

  async function handleSave() {
    if (!form.name.trim() || form.keywords.length === 0) return;
    setSaving(true);
    try {
      if (editing) {
        await triggerService.update(editing.id, {
          name: form.name,
          keywords: form.keywords,
          topic: form.topic,
          action: form.action,
          bot_template: form.bot_template,
          platforms: form.platforms,
          shop_ids: form.shop_ids,
          enabled: form.enabled,
        });
        toast.success(`แก้ไขทริกเกอร์ "${form.name}" แล้ว`);
      } else {
        await triggerService.create({
          name: form.name,
          keywords: form.keywords,
          topic: form.topic,
          action: form.action,
          bot_template: form.bot_template,
          platforms: form.platforms,
          shop_ids: form.shop_ids,
          enabled: form.enabled,
        });
        toast.success(`สร้างทริกเกอร์ "${form.name}" แล้ว`);
      }
      setShowForm(false);
      await load();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    const t = triggers.find((x) => x.id === id);
    const ok = await confirm.ask({
      title: "ลบทริกเกอร์?",
      message: `คุณแน่ใจหรือไม่ว่าต้องการลบ "${t?.name || id}" — ไม่สามารถกู้คืนได้`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await triggerService.delete(id);
      await load();
      toast.success("ลบทริกเกอร์แล้ว");
    } catch (err) {
      catchError(err, "ลบทริกเกอร์ไม่สำเร็จ");
    }
  }

  async function toggleEnabled(t: TriggerRule) {
    const newState = !t.enabled;
    const ok = await confirm.ask({
      title: newState ? "เปิดใช้งานทริกเกอร์?" : "ปิดใช้งานทริกเกอร์?",
      message: `"${t.name}" — ${newState ? "จะเริ่มตอบคีย์เวิร์ดที่ตรงเงื่อนไข" : "จะหยุดตอบคีย์เวิร์ด"}`,
      confirmText: newState ? "เปิดใช้งาน" : "ปิดใช้งาน",
    });
    if (!ok) return;
    try {
      await triggerService.toggle(t.id, newState);
      await load();
      toast.success(`${newState ? "เปิด" : "ปิด"}ทริกเกอร์ "${t.name}" แล้ว`);
    } catch (err) {
      catchError(err, "เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  // shops ที่กรองตาม platform ที่เลือกในฟอร์ม
  const filteredShops = form.platforms.length === 0
    ? allShops
    : allShops.filter((s) => form.platforms.includes(s.platform));
  const shopOptions = filteredShops.map((s) => ({ value: s.shop_id, label: `${s.shopname} (${platformLabels[s.platform]})` }));

  // Phase 7.10 — filter logic (search + platform + shop + enabled + created by + updated by + sort)
  const filteredTriggers = triggers
    .filter((t) => {
      // search
      if (search) {
        const q = search.toLowerCase();
        const inName = (t.name || "").toLowerCase().includes(q);
        const inKeywords = t.keywords.some((k) => k.toLowerCase().includes(q));
        if (!inName && !inKeywords) return false;
      }
      // platform filter
      if (filterPlatforms.length > 0) {
        if (t.platforms.length === 0) return true; // applies to all
        if (!t.platforms.some((p) => filterPlatforms.includes(p))) return false;
      }
      // shop filter
      if (filterShopIds.length > 0) {
        if (t.shop_ids.length === 0) return true; // applies to all
        if (!t.shop_ids.some((s) => filterShopIds.includes(s))) return false;
      }
      // enabled filter
      if (filterEnabled === "enabled" && !t.enabled) return false;
      if (filterEnabled === "disabled" && t.enabled) return false;
      // created by filter
      if (filterCreatedBy !== "all" && t.admin_id !== filterCreatedBy) return false;
      // updated by filter
      if (filterUpdatedBy !== "all" && t.updated_by !== filterUpdatedBy) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
      // recent/oldest → เรียงตาม created_at; recent_edit/oldest_edit → เรียงตาม updated_at
      if (sortBy === "recent_edit" || sortBy === "oldest_edit") {
        const ta = new Date(a.updated_at || a.created_at || 0).getTime();
        const tb = new Date(b.updated_at || b.created_at || 0).getTime();
        return sortBy === "recent_edit" ? tb - ta : ta - tb;
      }
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return sortBy === "recent" ? tb - ta : ta - tb;
    });

  // shops ที่กรองตาม platform ที่เลือก
  const filterShopOptions = filterPlatforms.length === 0
    ? allShops
    : allShops.filter((s) => filterPlatforms.includes(s.platform));

  const activeFilterCount =
    (filterPlatforms.length > 0 ? 1 : 0) +
    (filterShopIds.length > 0 ? 1 : 0) +
    (filterEnabled !== "all" ? 1 : 0) +
    (filterCreatedBy !== "all" ? 1 : 0) +
    (filterUpdatedBy !== "all" ? 1 : 0);

  function clearFilters() {
    setSearch("");
    setFilterPlatforms([]);
    setFilterShopIds([]);
    setFilterEnabled("all");
    setFilterCreatedBy("all");
    setFilterUpdatedBy("all");
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Header — navbar เดิม (เหมือน shops/team) */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <Zap size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">ทริกเกอร์</h1>
              <p className="text-xs text-text-muted">
                {editable ? "ตั้งค่าคีย์เวิร์ดที่บอทจะส่งต่อแอดมิน" : "ดูคีย์เวิร์ดที่บอทจะส่งต่อแอดมิน"} · {filteredTriggers.length}/{triggers.length} ตัว
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
            </Button>
            {editable && (
              <Button size="sm" onClick={openCreate}>
                <Plus size={14} /> เพิ่มทริกเกอร์
              </Button>
            )}
          </div>
        </div>

        {/* Filter bar — search + platform + shop + enabled + sort */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหา ชื่อ / คีย์เวิร์ด..."
              className="w-full h-8 pl-8 pr-3 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
            />
          </div>

          {/* Platform filter (multi) */}
          <div className="relative">
            <button
              onClick={() => { setShowPlatformDd(!showPlatformDd); setShowShopDd(false); setShowEnabledDd(false); setShowSortDd(false); }}
              style={{ minWidth: "110px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterPlatforms.length > 0 ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">แพลตฟอร์ม:</span>
              <span className="font-medium truncate" style={{ minWidth: "40px", maxWidth: "60px" }}>
                {filterPlatforms.length === 0 ? "ทั้งหมด" : filterPlatforms.length === 1 ? filterPlatforms[0] : `${filterPlatforms.length} เลือก`}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showPlatformDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowPlatformDd(false)} />
                <div className="absolute top-full left-0 mt-1 min-w-[140px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {(["shopee", "tiktok", "lazada"] as Platform[]).map((p) => {
                    const sel = filterPlatforms.includes(p);
                    return (
                      <button key={p} onClick={() => setFilterPlatforms(sel ? filterPlatforms.filter((x) => x !== p) : [...filterPlatforms, p])}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${sel ? "text-brand font-medium" : "text-text"}`}>
                        <Check size={11} className={sel ? "" : "opacity-0"} />
                        <span className="capitalize">{p}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Shop filter (multi) */}
          <div className="relative">
            <button
              onClick={() => { setShowShopDd(!showShopDd); setShowPlatformDd(false); setShowEnabledDd(false); setShowSortDd(false); }}
              disabled={filterShopOptions.length === 0}
              style={{ minWidth: "90px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors disabled:opacity-40 ${filterShopIds.length > 0 ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">ร้าน:</span>
              <span className="font-medium truncate" style={{ minWidth: "30px", maxWidth: "50px" }}>
                {filterShopIds.length === 0 ? "ทั้งหมด" : `${filterShopIds.length} ร้าน`}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showShopDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowShopDd(false)} />
                <div className="absolute top-full left-0 mt-1 min-w-[180px] max-h-60 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {filterShopOptions.map((s) => {
                    const sel = filterShopIds.includes(s.shop_id);
                    return (
                      <button key={s.shop_id} onClick={() => setFilterShopIds(sel ? filterShopIds.filter((x) => x !== s.shop_id) : [...filterShopIds, s.shop_id])}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${sel ? "text-brand font-medium" : "text-text"}`}>
                        <Check size={11} className={sel ? "" : "opacity-0"} />
                        <span className="truncate">{s.shopname}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Enabled filter */}
          <div className="relative">
            <button
              onClick={() => { setShowEnabledDd(!showEnabledDd); setShowPlatformDd(false); setShowShopDd(false); setShowSortDd(false); }}
              style={{ minWidth: "90px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterEnabled !== "all" ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">สถานะ:</span>
              <span className="font-medium" style={{ minWidth: "40px" }}>
                {filterEnabled === "all" ? "ทั้งหมด" : filterEnabled === "enabled" ? "เปิดใช้" : "ปิดใช้"}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showEnabledDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowEnabledDd(false)} />
                <div className="absolute top-full left-0 mt-1 min-w-[100px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {([
                    { v: "all", l: "ทั้งหมด" },
                    { v: "enabled", l: "เปิดใช้" },
                    { v: "disabled", l: "ปิดใช้" },
                  ] as const).map((s) => (
                    <button key={s.v} onClick={() => { setFilterEnabled(s.v); setShowEnabledDd(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterEnabled === s.v ? "text-brand font-medium" : "text-text"}`}>
                      <Check size={11} className={filterEnabled === s.v ? "" : "opacity-0"} />
                      {s.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Sort */}
          <div className="relative">
            <button
              onClick={() => { setShowSortDd(!showSortDd); setShowPlatformDd(false); setShowShopDd(false); setShowEnabledDd(false); }}
              style={{ minWidth: "90px" }}
              className="h-8 px-2.5 text-xs rounded-lg border border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky flex items-center gap-1.5 transition-colors"
            >
              <ArrowDownUp size={11} className="text-text-muted shrink-0" />
              <span className="font-medium" style={{ minWidth: "60px" }}>
                {sortBy === "recent" ? "สร้างใหม่" : sortBy === "oldest" ? "สร้างเก่า" : sortBy === "recent_edit" ? "แก้ไขใหม่" : sortBy === "oldest_edit" ? "แก้ไขเก่า" : "A-Z"}
              </span>
            </button>
            {showSortDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowSortDd(false)} />
                <div className="absolute top-full right-0 mt-1 min-w-[120px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {([
                    { v: "recent", l: "สร้างใหม่สุด" },
                    { v: "oldest", l: "สร้างเก่าสุด" },
                    { v: "recent_edit", l: "แก้ไขใหม่สุด" },
                    { v: "oldest_edit", l: "แก้ไขเก่าสุด" },
                    { v: "name", l: "ชื่อ A-Z" },
                  ] as const).map((s) => (
                    <button key={s.v} onClick={() => { setSortBy(s.v); setShowSortDd(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${sortBy === s.v ? "text-brand font-medium" : "text-text"}`}>
                      <Check size={11} className={sortBy === s.v ? "" : "opacity-0"} />
                      {s.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Created by filter */}
          <div className="relative">
            <button
              onClick={() => { setShowCreatedDd(!showCreatedDd); setShowPlatformDd(false); setShowShopDd(false); setShowEnabledDd(false); setShowSortDd(false); setShowUpdatedDd(false); }}
              style={{ minWidth: "100px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterCreatedBy !== "all" ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">สร้างโดย:</span>
              <span className="font-medium truncate" style={{ minWidth: "30px", maxWidth: "60px" }}>
                {filterCreatedBy === "all" ? "ทั้งหมด" : (admins.find((a) => a.admin_id === filterCreatedBy)?.name || admins.find((a) => a.admin_id === filterCreatedBy)?.username || filterCreatedBy)}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showCreatedDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowCreatedDd(false)} />
                <div className="absolute top-full left-0 mt-1 min-w-[140px] max-h-60 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  <button onClick={() => { setFilterCreatedBy("all"); setShowCreatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterCreatedBy === "all" ? "text-brand font-medium" : "text-text"}`}>
                    <Check size={11} className={filterCreatedBy === "all" ? "" : "opacity-0"} /> ทั้งหมด
                  </button>
                  <div className="border-t border-border my-1" />
                  {admins.map((a) => (
                    <button key={a.admin_id} onClick={() => { setFilterCreatedBy(a.admin_id); setShowCreatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterCreatedBy === a.admin_id ? "text-brand font-medium" : "text-text"}`}>
                      <Check size={11} className={filterCreatedBy === a.admin_id ? "" : "opacity-0"} /> {a.name || a.username}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Updated by filter */}
          <div className="relative">
            <button
              onClick={() => { setShowUpdatedDd(!showUpdatedDd); setShowPlatformDd(false); setShowShopDd(false); setShowEnabledDd(false); setShowSortDd(false); setShowCreatedDd(false); }}
              style={{ minWidth: "100px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterUpdatedBy !== "all" ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">แก้ไขโดย:</span>
              <span className="font-medium truncate" style={{ minWidth: "30px", maxWidth: "60px" }}>
                {filterUpdatedBy === "all" ? "ทั้งหมด" : (admins.find((a) => a.admin_id === filterUpdatedBy)?.name || admins.find((a) => a.admin_id === filterUpdatedBy)?.username || filterUpdatedBy)}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showUpdatedDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowUpdatedDd(false)} />
                <div className="absolute top-full left-0 mt-1 min-w-[140px] max-h-60 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  <button onClick={() => { setFilterUpdatedBy("all"); setShowUpdatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterUpdatedBy === "all" ? "text-brand font-medium" : "text-text"}`}>
                    <Check size={11} className={filterUpdatedBy === "all" ? "" : "opacity-0"} /> ทั้งหมด
                  </button>
                  <div className="border-t border-border my-1" />
                  {admins.map((a) => (
                    <button key={a.admin_id} onClick={() => { setFilterUpdatedBy(a.admin_id); setShowUpdatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterUpdatedBy === a.admin_id ? "text-brand font-medium" : "text-text"}`}>
                      <Check size={11} className={filterUpdatedBy === a.admin_id ? "" : "opacity-0"} /> {a.name || a.username}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Clear */}
          {(activeFilterCount > 0 || search) && (
            <button onClick={clearFilters} className="h-8 px-2 text-xs text-text-muted hover:text-vibrant-coral hover:bg-surface-2 rounded-lg flex items-center gap-1 transition-colors">
              <X size={11} /> ล้าง
            </button>
          )}
        </div>
      </div>

      <div className="p-6">
        {loading ? (
          <div className="text-center py-12 text-text-muted text-sm">กำลังโหลด...</div>
        ) : triggers.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="ไม่มีทริกเกอร์"
            description="สร้างทริกเกอร์เพื่อกำหนดว่าคำไหนส่งแอดมิน"
          />
        ) : filteredTriggers.length === 0 ? (
          <div className="text-center py-12 text-text-muted text-sm">ไม่พบทริกเกอร์ตรงเงื่อนไข</div>
        ) : (
          <div className="space-y-2">
            {filteredTriggers.map((t) => (
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
                      {/* Platform badges */}
                      {(t.platforms || []).length === 0 ? (
                        <Badge tone="neutral">ทุกแพลตฟอร์ม</Badge>
                      ) : (
                        (t.platforms || []).map((p) => (
                          <Badge key={p} tone="neutral">{platformLabels[p]}</Badge>
                        ))
                      )}
                      {/* Shop badges */}
                      {(t.shop_ids || []).length === 0 ? (
                        <Badge tone="neutral">ทุกร้าน</Badge>
                      ) : (t.shop_ids || []).length <= 2 ? (
                        (t.shop_ids || []).map((s) => (
                          <Badge key={s} tone="neutral">{s.slice(0, 12)}</Badge>
                        ))
                      ) : (
                        <Badge tone="neutral">{(t.shop_ids || []).length} ร้าน</Badge>
                      )}
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
                        onClick={() => toggleEnabled(t)}
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
      </div>

      {/* Trigger Form Modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setShowForm(false)}
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
                disabled={saving}
                className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center disabled:opacity-50"
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

              {/* Platforms (multi-select) */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">แพลตฟอร์ม</label>
                <MultiSelect<Platform>
                  label="แพลตฟอร์ม"
                  allLabel="ทุกแพลตฟอร์ม"
                  options={[
                    { value: "shopee", label: "Shopee" },
                    { value: "tiktok", label: "TikTok" },
                    { value: "lazada", label: "Lazada" },
                  ]}
                  selected={form.platforms}
                  onChange={(next) => setForm({ ...form, platforms: next })}
                />
                <p className="text-[10px] text-text-subtle mt-1">
                  เลือกหลายได้ · ไม่เลือก = ใช้กับทุกแพลตฟอร์ม
                </p>
              </div>

              {/* Shops (multi-select — กรองตาม platform ที่เลือก) */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">ร้านค้า</label>
                <MultiSelect<string>
                  label="ร้านค้า"
                  allLabel="ทุกร้าน"
                  options={shopOptions}
                  selected={form.shop_ids}
                  onChange={(next) => setForm({ ...form, shop_ids: next })}
                />
                <p className="text-[10px] text-text-subtle mt-1">
                  โชว์ตามแพลตฟอร์มที่เลือก{form.platforms.length > 0 ? ` (${filteredShops.length} ร้าน)` : ` (ทั้งหมด ${allShops.length} ร้าน)`} · ไม่เลือก = ใช้กับทุกร้าน
                </p>
              </div>

              {/* Action */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">การตอบ</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, action: "bot_answer" })}
                    className={`flex-1 h-10 rounded-lg border text-sm font-medium transition-colors ${
                      form.action === "bot_answer"
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border bg-surface-2 text-text-muted hover:border-pale-sky"
                    }`}
                  >
                    บอทตอบ
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, action: "handoff_admin" })}
                    className={`flex-1 h-10 rounded-lg border text-sm font-medium transition-colors ${
                      form.action === "handoff_admin"
                        ? "border-vibrant-coral bg-vibrant-coral/10 text-vibrant-coral"
                        : "border-border bg-surface-2 text-text-muted hover:border-pale-sky"
                    }`}
                  >
                    ส่งแอดมิน
                  </button>
                </div>
              </div>

              {/* Bot template (เฉพาะ action = bot_answer) */}
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

              {/* Topic */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">หัวข้อ</label>
                <select
                  value={form.topic}
                  onChange={(e) => setForm({ ...form, topic: e.target.value as Topic })}
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/30"
                >
                  {Object.entries(topicLabels).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>

              {/* Enabled */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="w-4 h-4 rounded border-border"
                />
                <span className="text-sm text-text">เปิดใช้งาน</span>
              </label>
            </div>

            <div className="p-4 border-t border-border flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setShowForm(false)} disabled={saving}>
                ยกเลิก
              </Button>
              <Button onClick={handleSave} disabled={saving || !form.name.trim() || form.keywords.length === 0}>
                {saving ? "กำลังบันทึก..." : "บันทึก"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

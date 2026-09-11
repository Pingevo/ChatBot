"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterChips } from "@/components/ui/FilterChips";
import { FormField } from "@/components/ui/FormField";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { Zap, Plus, X, Pencil, Trash2, RefreshCw, Check, ChevronDown, Search, ArrowDownUp, Info } from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { triggerService } from "@/lib/services";
import { useSearchShortcut, useEscToClear, useListboxNav, useFocusTrap } from "@/lib/useKeyboardShortcuts";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import type { TriggerRule, Topic, Platform } from "@/lib/types";
import { api } from "@/lib/apiClient";
import { Tooltip } from "@/components/ui/Tooltip";
import { FilterPresets } from "@/components/ui/FilterPresets";

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
        className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text flex items-center justify-between gap-2 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/40"
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
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const handleSearchEsc = useEscToClear(() => setSearch(""));
  const { user } = useAuth();
  const editable = canEditPage(user, "trigger");
  const { catchError } = useToastError();
  const [triggers, setTriggers] = useState<TriggerRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const formModalRef = useFocusTrap<HTMLDivElement>(showForm);
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
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const formSnapshot = useRef("");

  // arrow-key navigation for filter dropdowns
  const platformNav = useListboxNav(3, (i) => {
    const p = (["shopee", "tiktok", "lazada"] as Platform[])[i];
    const sel = filterPlatforms.includes(p);
    setFilterPlatforms(sel ? filterPlatforms.filter((x) => x !== p) : [...filterPlatforms, p]);
  }, () => setShowPlatformDd(false));
  const enabledNav = useListboxNav(3, (i) => {
    const v = (["all", "enabled", "disabled"] as const)[i];
    setFilterEnabled(v); setShowEnabledDd(false);
  }, () => setShowEnabledDd(false));
  const sortNav = useListboxNav(5, (i) => {
    const v = (["recent", "oldest", "recent_edit", "oldest_edit", "name"] as const)[i];
    setSortBy(v); setShowSortDd(false);
  }, () => setShowSortDd(false));
  const createdNav = useListboxNav(admins.length + 1, (i) => {
    if (i === 0) { setFilterCreatedBy("all"); setShowCreatedDd(false); return; }
    const a = admins[i - 1];
    if (a) { setFilterCreatedBy(a.admin_id); setShowCreatedDd(false); }
  }, () => setShowCreatedDd(false));
  const updatedNav = useListboxNav(admins.length + 1, (i) => {
    if (i === 0) { setFilterUpdatedBy("all"); setShowUpdatedDd(false); return; }
    const a = admins[i - 1];
    if (a) { setFilterUpdatedBy(a.admin_id); setShowUpdatedDd(false); }
  }, () => setShowUpdatedDd(false));

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
      .catch((e) => {
        catchError(e, "โหลดรายชื่อร้านไม่สำเร็จ");
        setAllShops([]);
      });
    api().get<{ users: { admin_id: string; name?: string; username?: string }[] }>("/users/list")
      .then((r) => setAdmins(r.data.users || []))
      .catch((e) => {
        catchError(e, "โหลดรายชื่อแอดมินไม่สำเร็จ");
        setAdmins([]);
      });
  }, []);

  const closeForm = async () => {
    if (saving) return;
    const current = JSON.stringify({ name: form.name, keywords: form.keywords, topic: form.topic, action: form.action, bot_template: form.bot_template, platforms: form.platforms, shop_ids: form.shop_ids, enabled: form.enabled });
    const isDirty = current !== formSnapshot.current;
    if (!isDirty) { setEditing(null); setShowForm(false); return; }
    const ok = await confirm.ask({
      title: "ปิดฟอร์มโดยไม่บันทึก?",
      message: "การเปลี่ยนแปลงที่ยังไม่บันทึกจะหายไป",
      confirmText: "ปิด",
      variant: "primary",
    });
    if (!ok) return;
    setEditing(null);
    setShowForm(false);
  };

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
      toast.error("โหลดทริกเกอร์ไม่สำเร็จ", 0, { label: "ลองใหม่", onClick: () => load() });
      setTriggers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredTriggers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredTriggers.map(t => t.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm.ask({
      title: `ลบ ${selectedIds.size} ทริกเกอร์?`,
      message: "การลบเป็นถาวร — ไม่สามารถกู้คืนได้",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(ids.map(id => triggerService.delete(id)));
      setSelectedIds(new Set());
      await load();
      toast.success(`ลบ ${ids.length} ทริกเกอร์แล้ว`);
    } catch (err) {
      catchError(err, "ลบหลายรายการไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  };

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setKeywordInput("");
    setTouched({});
    setShowForm(true);
    formSnapshot.current = JSON.stringify({ name: "", keywords: [], topic: "general", action: "bot_answer", bot_template: "", platforms: [], shop_ids: [], enabled: true });
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
    setTouched({});
    setShowForm(true);
    formSnapshot.current = JSON.stringify({ name: t.name || "", keywords: t.keywords, topic: t.topic, action: t.action, bot_template: t.bot_template || "", platforms: t.platforms || [], shop_ids: t.shop_ids || [], enabled: t.enabled });
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
    const firstError = !form.name.trim() ? "trigger-form-name" : form.keywords.length === 0 ? "trigger-form-keywords" : null;
    if (firstError) {
      setTouched({ name: true, keywords: true });
      document.getElementById(firstError)?.focus();
      return;
    }
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
      toast.success(`ลบ "${t?.name || id}" แล้ว`);
    } catch (err) {
      catchError(err, "ลบทริกเกอร์ไม่สำเร็จ");
    }
  }

  async function toggleEnabled(t: TriggerRule) {
    const newState = !t.enabled;
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

  const shopNav = useListboxNav(filterShopOptions.length, (i) => {
    const s = filterShopOptions[i];
    if (!s) return;
    const sel = filterShopIds.includes(s.shop_id);
    setFilterShopIds(sel ? filterShopIds.filter((x) => x !== s.shop_id) : [...filterShopIds, s.shop_id]);
  }, () => setShowShopDd(false));

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
    // Header — navbar เดิม (เหมือน shops/team)
    <PageShell
      icon={Zap}
      title="ทริกเกอร์"
      helpHref="/help#triggers"
      subtitle={
        <>
          {editable ? "ตั้งค่าคีย์เวิร์ดที่บอทจะส่งต่อแอดมิน" : "ดูคีย์เวิร์ดที่บอทจะส่งต่อแอดมิน"} · {filteredTriggers.length}/{triggers.length} ตัว
        </>
      }
      actions={
        <>
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
          {editable && (
            <Button size="sm" onClick={openCreate}>
              <Plus size={14} /> เพิ่มทริกเกอร์
            </Button>
          )}
        </>
      }
      filterBarBelow
      filterBar={
        <>
        {/* Filter bar — search + platform + shop + enabled + sort */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchEsc}
              placeholder="ค้นหา ชื่อ / คีย์เวิร์ด..."
              className="w-full h-8 pl-8 pr-8 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
            />
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-text-subtle border border-border rounded px-1 py-0.5 pointer-events-none">/</kbd>
          </div>

          {/* Platform filter (multi) */}
          <div className="relative">
            <button
              onClick={() => { setShowPlatformDd(!showPlatformDd); setShowShopDd(false); setShowEnabledDd(false); setShowSortDd(false); }}
              aria-expanded={showPlatformDd}
              aria-haspopup="listbox"
              style={{ minWidth: "110px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterPlatforms.length > 0 ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">แพลตฟอร์ม:</span>
              <span className="font-medium truncate" style={{ minWidth: "40px", maxWidth: "120px" }}>
                {filterPlatforms.length === 0 ? "ทั้งหมด" : filterPlatforms.length === 1 ? filterPlatforms[0] : `${filterPlatforms.length} เลือก`}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showPlatformDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowPlatformDd(false)} />
                <div ref={(el) => { if (showPlatformDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามแพลตฟอร์ม" aria-activedescendant={`platform-option-${platformNav.activeIndex}`} onKeyDown={(e) => { platformNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[140px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {(["shopee", "tiktok", "lazada"] as Platform[]).map((p, i) => {
                    const sel = filterPlatforms.includes(p);
                    return (
                      <button key={p} id={`platform-option-${i}`} role="option" aria-selected={sel} onClick={() => setFilterPlatforms(sel ? filterPlatforms.filter((x) => x !== p) : [...filterPlatforms, p])}
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
              aria-expanded={showShopDd}
              aria-haspopup="listbox"
              disabled={filterShopOptions.length === 0}
              style={{ minWidth: "90px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors disabled:opacity-40 ${filterShopIds.length > 0 ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">ร้าน:</span>
              <span className="font-medium truncate" style={{ minWidth: "30px", maxWidth: "120px" }}>
                {filterShopIds.length === 0 ? "ทั้งหมด" : filterShopIds.length <= 2
                  ? filterShopIds.map(id => allShops.find(s => s.shop_id === id)?.shopname || id).join(", ")
                  : `${filterShopIds.length} ร้าน`}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showShopDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowShopDd(false)} />
                <div ref={(el) => { if (showShopDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามร้าน" aria-activedescendant={`shop-option-${shopNav.activeIndex}`} onKeyDown={(e) => { shopNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[180px] max-h-60 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {filterShopOptions.map((s, i) => {
                    const sel = filterShopIds.includes(s.shop_id);
                    return (
                      <button key={s.shop_id} id={`shop-option-${i}`} role="option" aria-selected={sel} onClick={() => setFilterShopIds(sel ? filterShopIds.filter((x) => x !== s.shop_id) : [...filterShopIds, s.shop_id])}
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
              aria-expanded={showEnabledDd}
              aria-haspopup="listbox"
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
                <div ref={(el) => { if (showEnabledDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามสถานะ" aria-activedescendant={`enabled-option-${enabledNav.activeIndex}`} onKeyDown={(e) => { enabledNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[100px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {([
                    { v: "all", l: "ทั้งหมด" },
                    { v: "enabled", l: "เปิดใช้" },
                    { v: "disabled", l: "ปิดใช้" },
                  ] as const).map((s, i) => (
                    <button key={s.v} id={`enabled-option-${i}`} role="option" aria-selected={filterEnabled === s.v} onClick={() => { setFilterEnabled(s.v); setShowEnabledDd(false); }}
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
              aria-expanded={showSortDd}
              aria-haspopup="listbox"
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
                <div ref={(el) => { if (showSortDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="เรียงลำดับ" aria-activedescendant={`sort-option-${sortNav.activeIndex}`} onKeyDown={(e) => { sortNav.onKeyDown(e); }} className="absolute top-full right-0 mt-1 min-w-[120px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {([
                    { v: "recent", l: "สร้างใหม่สุด" },
                    { v: "oldest", l: "สร้างเก่าสุด" },
                    { v: "recent_edit", l: "แก้ไขใหม่สุด" },
                    { v: "oldest_edit", l: "แก้ไขเก่าสุด" },
                    { v: "name", l: "ชื่อ A-Z" },
                  ] as const).map((s, i) => (
                    <button key={s.v} id={`sort-option-${i}`} role="option" aria-selected={sortBy === s.v} onClick={() => { setSortBy(s.v); setShowSortDd(false); }}
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
              aria-expanded={showCreatedDd}
              aria-haspopup="listbox"
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
                <div ref={(el) => { if (showCreatedDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามผู้สร้าง" aria-activedescendant={`created-option-${createdNav.activeIndex}`} onKeyDown={(e) => { createdNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[140px] max-h-60 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  <button id="created-option-0" role="option" aria-selected={filterCreatedBy === "all"} onClick={() => { setFilterCreatedBy("all"); setShowCreatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterCreatedBy === "all" ? "text-brand font-medium" : "text-text"}`}>
                    <Check size={11} className={filterCreatedBy === "all" ? "" : "opacity-0"} /> ทั้งหมด
                  </button>
                  <div className="border-t border-border my-1" />
                  {admins.map((a, i) => (
                    <button key={a.admin_id} id={`created-option-${i + 1}`} role="option" aria-selected={filterCreatedBy === a.admin_id} onClick={() => { setFilterCreatedBy(a.admin_id); setShowCreatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterCreatedBy === a.admin_id ? "text-brand font-medium" : "text-text"}`}>
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
              aria-expanded={showUpdatedDd}
              aria-haspopup="listbox"
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
                <div ref={(el) => { if (showUpdatedDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามผู้แก้ไข" aria-activedescendant={`updated-option-${updatedNav.activeIndex}`} onKeyDown={(e) => { updatedNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[140px] max-h-60 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  <button id="updated-option-0" role="option" aria-selected={filterUpdatedBy === "all"} onClick={() => { setFilterUpdatedBy("all"); setShowUpdatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterUpdatedBy === "all" ? "text-brand font-medium" : "text-text"}`}>
                    <Check size={11} className={filterUpdatedBy === "all" ? "" : "opacity-0"} /> ทั้งหมด
                  </button>
                  <div className="border-t border-border my-1" />
                  {admins.map((a, i) => (
                    <button key={a.admin_id} id={`updated-option-${i + 1}`} role="option" aria-selected={filterUpdatedBy === a.admin_id} onClick={() => { setFilterUpdatedBy(a.admin_id); setShowUpdatedDd(false); }} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterUpdatedBy === a.admin_id ? "text-brand font-medium" : "text-text"}`}>
                      <Check size={11} className={filterUpdatedBy === a.admin_id ? "" : "opacity-0"} /> {a.name || a.username}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Preset */}
          <FilterPresets
            pageKey="triggers"
            adminId={user?.admin_id || "anon"}
            currentValues={{
              search,
              filterPlatforms,
              filterShopIds,
              filterEnabled,
              sortBy,
              filterCreatedBy,
              filterUpdatedBy,
            }}
            onApply={(v) => {
              setSearch(v.search || "");
              setFilterPlatforms(v.filterPlatforms || []);
              setFilterShopIds(v.filterShopIds || []);
              setFilterEnabled(v.filterEnabled || "all");
              setSortBy(v.sortBy || "recent");
              setFilterCreatedBy(v.filterCreatedBy || "all");
              setFilterUpdatedBy(v.filterUpdatedBy || "all");
            }}
          />

          {/* Clear */}
          {(activeFilterCount > 0 || search) && (
            <button onClick={clearFilters} className="h-8 px-2 text-xs text-text-muted hover:text-vibrant-coral hover:bg-surface-2 rounded-lg flex items-center gap-1 transition-colors">
              <X size={11} /> ล้าง
            </button>
          )}
        </div>

        {/* Active filter chips */}
        {(activeFilterCount > 0 || search) && (
          <div className="mt-2">
            <FilterChips
              chips={[
                ...(search ? [{ key: "search", label: `ค้นหา: ${search}`, onRemove: () => setSearch("") }] : []),
                ...(filterPlatforms.length > 0 ? [{ key: "platforms", label: `แพลตฟอร์ม: ${filterPlatforms.join(", ")}`, onRemove: () => setFilterPlatforms([]) }] : []),
                ...(filterShopIds.length > 0 ? [{ key: "shops", label: `ร้าน: ${filterShopIds.length <= 3 ? filterShopIds.map(id => allShops.find(s => s.shop_id === id)?.shopname || id).join(", ") : `${filterShopIds.length} ร้าน`}`, onRemove: () => setFilterShopIds([]) }] : []),
                ...(filterEnabled !== "all" ? [{ key: "enabled", label: `สถานะ: ${filterEnabled === "enabled" ? "เปิดใช้" : "ปิดใช้"}`, onRemove: () => setFilterEnabled("all") }] : []),
                ...(filterCreatedBy !== "all" ? [{ key: "createdBy", label: `สร้างโดย: ${admins.find(a => a.admin_id === filterCreatedBy)?.name || filterCreatedBy}`, onRemove: () => setFilterCreatedBy("all") }] : []),
                ...(filterUpdatedBy !== "all" ? [{ key: "updatedBy", label: `แก้โดย: ${admins.find(a => a.admin_id === filterUpdatedBy)?.name || filterUpdatedBy}`, onRemove: () => setFilterUpdatedBy("all") }] : []),
              ]}
              onClearAll={clearFilters}
            />
          </div>
        )}
        </>
      }
      contentClassName="p-6"
    >
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loading /></div>
        ) : triggers.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="ไม่มีทริกเกอร์"
            description="สร้างทริกเกอร์เพื่อกำหนดว่าคำไหนส่งแอดมิน"
          />
        ) : filteredTriggers.length === 0 ? (
          <div className="text-center py-12 text-text-muted text-sm">ไม่พบทริกเกอร์ตรงเงื่อนไข</div>
        ) : (
          <>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 bg-warning-soft border-b border-warning/30 rounded-xl mb-2">
              <span className="text-xs text-warning-dark font-medium">เลือกแล้ว {selectedIds.size} รายการ</span>
              <button
                onClick={handleBulkDelete}
                disabled={saving}
                className="text-xs px-2 py-1 rounded-md border border-error/30 text-error hover:bg-error/5 disabled:opacity-50 transition-colors"
              >
                ลบที่เลือก
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs px-2 py-1 rounded-md text-text-muted hover:bg-surface-2 transition-colors"
              >
                ยกเลิกเลือก
              </button>
            </div>
          )}
          <div className="space-y-2">
            {filteredTriggers.length > 0 && (
              <div className="flex items-center gap-2 px-4 py-1">
                <input
                  type="checkbox"
                  checked={selectedIds.size === filteredTriggers.length && filteredTriggers.length > 0}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-border accent-brand"
                  aria-label="เลือกทั้งหมดในหน้านี้"
                />
                <span className="text-xs text-text-muted">เลือกทั้งหมดในหน้านี้</span>
              </div>
            )}
            {filteredTriggers.map((t) => (
              <div
                key={t.id}
                className="bg-surface rounded-xl border border-border p-4 hover:border-pale-sky transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                      className="w-4 h-4 rounded border-border accent-brand mt-1 shrink-0"
                      aria-label={`เลือก ${t.name}`}
                    />
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
                          <Badge key={s} tone="neutral">{allShops.find(shop => shop.shop_id === s)?.shopname || s}</Badge>
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
                  </div>

                  {editable && (
                    <div className="flex items-center gap-2 shrink-0">
                      <ToggleSwitch
                        enabled={t.enabled}
                        onChange={() => toggleEnabled(t)}
                      />
                      <button
                        onClick={() => openEdit(t)}
                        className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
                        title="แก้ไข"
                        aria-label="แก้ไข"
                      >
                        <Pencil size={13} className="text-text-muted" />
                      </button>
                      <button
                        onClick={() => handleDelete(t.id)}
                        className="w-7 h-7 rounded-md hover:bg-vibrant-coral-soft flex items-center justify-center"
                        title="ลบ"
                        aria-label="ลบ"
                      >
                        <Trash2 size={13} className="text-text-muted" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          </>
        )}

      {/* Trigger Form Modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => closeForm()}
        >
          <div
            className="bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trigger-form-modal-title"
            ref={formModalRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface">
              <h2 id="trigger-form-modal-title" className="text-base font-semibold text-text">
                {editing ? "แก้ไขทริกเกอร์" : "เพิ่มทริกเกอร์"}
              </h2>
              <button
                onClick={() => closeForm()}
                disabled={saving}
                title="ปิด" aria-label="ปิด"
                className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center disabled:opacity-50"
              >
                <X size={16} className="text-text-muted" />
              </button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
            <div className="p-4 space-y-4">
              {/* Name */}
              <FormField
                id="trigger-form-name"
                label="ชื่อทริกเกอร์"
                error={touched.name && !form.name.trim() ? "กรุณาตั้งชื่อทริกเกอร์" : undefined}
              >
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  onBlur={() => setTouched({ ...touched, name: true })}
                  placeholder="เช่น เคลมสินค้า"
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40"
                />
              </FormField>

              {/* Keywords */}
              <div>
                <label htmlFor="trigger-form-keywords" className="block text-sm font-medium text-text mb-1.5">คีย์เวิร์ด *</label>
                <div className="flex gap-2 mb-2">
                  <input
                    id="trigger-form-keywords"
                    type="text"
                    value={keywordInput}
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onBlur={() => setTouched({ ...touched, keywords: true })}
                    aria-invalid={touched.keywords && form.keywords.length === 0 ? "true" : "false"}
                    aria-describedby={touched.keywords && form.keywords.length === 0 ? "trigger-form-keywords-error" : undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addKeyword();
                      }
                    }}
                    placeholder="พิมพ์แล้วกด Enter"
                    className="flex-1 h-10 px-3 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40"
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
                        <button onClick={() => removeKeyword(k)} title="นำคีย์เวิร์ดออก" aria-label="นำคีย์เวิร์ดออก" className="hover:text-vibrant-coral">
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {touched.keywords && form.keywords.length === 0 && (
                  <p id="trigger-form-keywords-error" className="mt-1 text-xs text-error">กรุณาเพิ่มคำสำคัญอย่างน้อย 1 คำ</p>
                )}
              </div>

              {/* Platforms (multi-select) */}
              <div>
                <label htmlFor="trigger-form-platforms" className="block text-sm font-medium text-text mb-1.5">แพลตฟอร์ม</label>
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
                <label htmlFor="trigger-form-shops" className="block text-sm font-medium text-text mb-1.5">ร้านค้า</label>
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
                <label className="block text-sm font-medium text-text mb-1.5">
                  การตอบ
                  <Tooltip text="ประเภทการตอบ — bot_answer = บอทตอบอัตโนมัติ, handoff = ส่งต่อแอดมิน"><Info size={12} className="text-text-subtle ml-1 inline" /></Tooltip>
                </label>
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
                  <label htmlFor="trigger-form-bot-template" className="block text-sm font-medium text-text mb-1.5">คำตอบบอท</label>
                  <textarea
                    id="trigger-form-bot-template"
                    value={form.bot_template}
                    onChange={(e) => setForm({ ...form, bot_template: e.target.value })}
                    placeholder="เช่น กรุณาแนบวิดีโอและเลขคำสั่งซื้อ แอดมินจะรับเรื่องค่ะ"
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 resize-none"
                  />
                </div>
              )}

              {/* Topic */}
              <div>
                <label htmlFor="trigger-form-topic" className="block text-sm font-medium text-text mb-1.5">
                  หัวข้อ
                  <Tooltip text="หมวดหมู่ของทริกเกอร์ — ใช้จัดกลุ่มคำสำคัญ"><Info size={12} className="text-text-subtle ml-1 inline" /></Tooltip>
                </label>
                <select
                  id="trigger-form-topic"
                  value={form.topic}
                  onChange={(e) => setForm({ ...form, topic: e.target.value as Topic })}
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text focus:outline-none focus:ring-2 focus:ring-brand/40"
                >
                  {Object.entries(topicLabels).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>

              {/* Enabled */}
              <label htmlFor="trigger-form-enabled" className="flex items-center gap-2 cursor-pointer">
                <input
                  id="trigger-form-enabled"
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="w-4 h-4 rounded border-border"
                />
                <span className="text-sm text-text">เปิดใช้งาน</span>
              </label>
            </div>

            <div className="p-4 border-t border-border flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => closeForm()} disabled={saving}>
                ยกเลิก
              </Button>
              <Button type="submit" disabled={saving || !form.name.trim() || form.keywords.length === 0}>
                {saving ? "กำลังบันทึก..." : "บันทึก"}
              </Button>
            </div>
            </form>
          </div>
        </div>
      )}
    </PageShell>
  );
}

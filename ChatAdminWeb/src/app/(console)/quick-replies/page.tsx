"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterChips } from "@/components/ui/FilterChips";
import { FormField } from "@/components/ui/FormField";
import { PageShell } from "@/components/ui/PageShell";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  Reply, Plus, Pencil, Trash2, X, Search, MessageSquare, Store, Globe, ChevronDown, ArrowDownUp, Check,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { quickReplyService, type QuickReplyRow } from "@/lib/services";
import { useSearchShortcut, useEscToClear, useListboxNav, useFocusTrap } from "@/lib/useKeyboardShortcuts";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/apiClient";

interface FormState {
  category: string;
  title: string;
  body: string;
  platforms: string[];
  shop_ids: string[];
  sort_order: number;
}

const emptyForm: FormState = {
  category: "ทั่วไป",
  title: "",
  body: "",
  platforms: [],
  shop_ids: [],
  sort_order: 0,
};

const ALL_PLATFORMS = ["shopee", "tiktok", "lazada"];

interface ShopOption {
  shop_id: string;
  shopname: string;
  platform: string;
}

export default function QuickRepliesPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const handleSearchEsc = useEscToClear(() => setSearch(""));
  const { user } = useAuth();
  const editable = canEditPage(user, "quickreply");
  const { catchError } = useToastError();
  const [rows, setRows] = useState<QuickReplyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const formModalRef = useFocusTrap<HTMLDivElement>(showForm);
  const [editing, setEditing] = useState<QuickReplyRow | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [allShops, setAllShops] = useState<ShopOption[]>([]);
  // Phase 7.10 — filter bar (platform + shop + enabled + created by + updated by + sort)
  const [filterPlatforms, setFilterPlatforms] = useState<string[]>([]);
  const [filterShopIds, setFilterShopIds] = useState<string[]>([]);
  const [filterEnabled, setFilterEnabled] = useState<"all" | "enabled" | "disabled">("all");
  const [filterCreatedBy, setFilterCreatedBy] = useState<string>("all");
  const [filterUpdatedBy, setFilterUpdatedBy] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"recent" | "oldest" | "recent_edit" | "oldest_edit" | "name">("recent");
  const [showPlatformDd, setShowPlatformDd] = useState(false);
  const [showShopDd, setShowShopDd] = useState(false);
  const [showEnabledDd, setShowEnabledDd] = useState(false);
  const [showSortDd, setShowSortDd] = useState(false);
  const [showCreatedDd, setShowCreatedDd] = useState(false);
  const [showUpdatedDd, setShowUpdatedDd] = useState(false);
  const [admins, setAdmins] = useState<{ admin_id: string; name?: string; username?: string }[]>([]);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const formSnapshot = useRef("");

  // arrow-key navigation for filter dropdowns
  const platformNav = useListboxNav(3, (i) => {
    const p = (["shopee", "tiktok", "lazada"])[i];
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

  // โหลดร้านค้า + admins list (สำหรับเลือกในฟอร์ม + filter)
  useEffect(() => {
    api().get<{ rows: ShopOption[] }>("/shops").then((r) => {
      // deduplicate by shop_id + platform (same shop may appear on multiple platforms)
      const seen = new Set<string>();
      const deduped = (r.data.rows || []).filter((s) => {
        const k = `${s.shop_id}|${s.platform}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setAllShops(deduped);
    }).catch((e) => {
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
    const current = JSON.stringify({ category: form.category, title: form.title, body: form.body, platforms: form.platforms, shop_ids: form.shop_ids, sort_order: form.sort_order });
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

  // ESC to close form modal (closeForm มี dirty-check อยู่แล้ว)
  useEffect(() => {
    if (!showForm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeForm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showForm, closeForm]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await quickReplyService.list();
      setRows(data);
    } catch (err) {
      console.error("load quick-replies failed", err);
      toast.error("โหลดคำตอบเร็วไม่สำเร็จ", 0, { label: "ลองใหม่", onClick: () => load() });
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map(r => r.quick_reply_id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm.ask({
      title: `ลบ ${selectedIds.size} คำตอบเร็ว?`,
      message: "การลบเป็นถาวร — ไม่สามารถกู้คืนได้",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(ids.map(id => quickReplyService.delete(id)));
      setSelectedIds(new Set());
      await load();
      toast.success(`ลบ ${ids.length} คำตอบเร็วแล้ว`);
    } catch (err) {
      catchError(err, "ลบหลายรายการไม่สำเร็จ");
    }
  };

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setTouched({});
    setShowForm(true);
    formSnapshot.current = JSON.stringify({ category: "ทั่วไป", title: "", body: "", platforms: [], shop_ids: [], sort_order: 0 });
  }

  function openEdit(row: QuickReplyRow) {
    setEditing(row);
    setForm({
      category: row.category || "ทั่วไป",
      title: row.title || "",
      body: row.body || "",
      platforms: row.platforms || [],
      shop_ids: row.shop_ids || [],
      sort_order: row.sort_order || 0,
    });
    setTouched({});
    setShowForm(true);
    formSnapshot.current = JSON.stringify({ category: row.category || "ทั่วไป", title: row.title || "", body: row.body || "", platforms: row.platforms || [], shop_ids: row.shop_ids || [], sort_order: row.sort_order || 0 });
  }

  async function handleSave() {
    const firstError = !form.title.trim() ? "qr-form-title" : !form.body.trim() ? "qr-form-body" : null;
    if (firstError) {
      setTouched({ title: true, body: true });
      document.getElementById(firstError)?.focus();
      return;
    }
    try {
      if (editing) {
        await quickReplyService.update(editing.quick_reply_id, {
          category: form.category,
          title: form.title,
          body: form.body,
          platforms: form.platforms,
          shop_ids: form.shop_ids,
          sort_order: form.sort_order,
        });
        toast.success(`แก้ไข "${form.title}" แล้ว`);
      } else {
        await quickReplyService.create({
          category: form.category,
          title: form.title,
          body: form.body,
          platforms: form.platforms,
          shop_ids: form.shop_ids,
          sort_order: form.sort_order,
        });
        toast.success(`สร้าง "${form.title}" แล้ว`);
      }
      setShowForm(false);
      await load();
    } catch (err) {
      catchError(err, "บันทึกไม่สำเร็จ");
    }
  }

  async function handleDelete(id: string) {
    const r = rows.find((x) => x.quick_reply_id === id);
    const ok = await confirm.ask({
      title: "ลบคำตอบเร็ว?",
      message: `คุณแน่ใจหรือไม่ว่าต้องการลบ "${r?.title || id}" — ไม่สามารถกู้คืนได้`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await quickReplyService.delete(id);
      await load();
      toast.success(`ลบ "${r?.title || id}" แล้ว`);
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  async function handleToggle(row: QuickReplyRow) {
    const newState = !row.enabled;
    try {
      await quickReplyService.update(row.quick_reply_id, { enabled: newState });
      await load();
      toast.success(`${newState ? "เปิด" : "ปิด"} "${row.title}" แล้ว`);
    } catch (err) {
      catchError(err, "เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  // toggle platform selection
  function togglePlatform(p: string) {
    setForm((f) => {
      const nextPlatforms = f.platforms.includes(p)
        ? f.platforms.filter((x) => x !== p)
        : [...f.platforms, p];
      return {
        ...f,
        platforms: nextPlatforms,
        // กรอง shop_ids ให้เหลือเฉพาะร้านที่อยู่ใน platform ที่เลือก (ใช้ nextPlatforms ไม่ใช่ f.platforms)
        shop_ids: f.shop_ids.filter((sid) => {
          const shop = allShops.find((s) => s.shop_id === sid);
          return shop && nextPlatforms.includes(shop.platform);
        }),
      };
    });
  }

  // toggle shop selection
  function toggleShop(shopId: string) {
    setForm((f) => ({
      ...f,
      shop_ids: f.shop_ids.includes(shopId)
        ? f.shop_ids.filter((x) => x !== shopId)
        : [...f.shop_ids, shopId],
    }));
  }

  // ร้านค้าที่อยู่ใน platform ที่เลือก (หรือทั้งหมดถ้าไม่ได้เลือก platform)
  const availableShops = form.platforms.length > 0
    ? allShops.filter((s) => form.platforms.includes(s.platform))
    : allShops;

  const filtered = rows
    .filter((r) => {
      if (search) {
        const q = search.toLowerCase();
        if (!(r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))) return false;
      }
      if (filterPlatforms.length > 0) {
        if (r.platforms.length === 0) return true; // ใช้กับทุกแพลตฟอร์ม
        if (!r.platforms.some((p) => filterPlatforms.includes(p))) return false;
      }
      if (filterShopIds.length > 0) {
        if (r.shop_ids.length === 0) return true;
        if (!r.shop_ids.some((s) => filterShopIds.includes(s))) return false;
      }
      if (filterEnabled === "enabled" && !r.enabled) return false;
      if (filterEnabled === "disabled" && r.enabled) return false;
      if (filterCreatedBy !== "all" && r.admin_id !== filterCreatedBy) return false;
      if (filterUpdatedBy !== "all" && r.updated_by !== filterUpdatedBy) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "name") return a.title.localeCompare(b.title);
      if (sortBy === "recent_edit" || sortBy === "oldest_edit") {
        const ta = new Date(a.updated_at || a.created_at || 0).getTime();
        const tb = new Date(b.updated_at || b.created_at || 0).getTime();
        return sortBy === "recent_edit" ? tb - ta : ta - tb;
      }
      const ta = new Date(a.created_at || 0).getTime();
      const tb = new Date(b.created_at || 0).getTime();
      return sortBy === "recent" ? tb - ta : ta - tb;
    });

  const categories = [...new Set(filtered.map((r) => r.category))].sort();

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
    // Header — navbar เดิม (เหมือน shops/team/triggers)
    <PageShell
      icon={Reply}
      title="คำตอบเร็ว"
      helpHref="/help#quick-replies"
      subtitle={
        <>
          {editable ? "ตั้งคำตอบสำเร็จรูป — กดปุ่มในแชทเพื่อตอบลูกค้าทันที" : "ดูคำตอบสำเร็จรูป — กดปุ่มในแชทเพื่อตอบลูกค้าทันที"} · {filtered.length}/{rows.length} รายการ
        </>
      }
      actions={
        editable && (
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} /> เพิ่มคำตอบเร็ว
          </Button>
        )
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
              placeholder="ค้นหาชื่อ เนื้อหา หมวดหมู่..."
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
                  {["shopee", "tiktok", "lazada"].map((p, i) => {
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

          {/* Toggle ตัวกรองเพิ่มเติม — แสดงเฉพาะจอ <lg */}
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            aria-expanded={filtersOpen}
            className="lg:hidden h-8 px-2.5 text-xs rounded-lg border border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky flex items-center gap-1.5 transition-colors"
          >
            ตัวกรองเพิ่มเติม
            <ChevronDown size={11} className={`text-text-muted shrink-0 transition-transform ${filtersOpen ? "rotate-180" : ""}`} />
          </button>

          {/* ตัวกรองที่เหลือ — <lg ซ่อนไว้หลังปุ่ม toggle, lg+ แสดงตลอด */}
          <div className={`${filtersOpen ? "flex" : "hidden"} lg:flex flex-wrap items-center gap-2`}>
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
                      <button key={`${s.shop_id}|${s.platform}`} id={`shop-option-${i}`} role="option" aria-selected={sel} onClick={() => setFilterShopIds(sel ? filterShopIds.filter((x) => x !== s.shop_id) : [...filterShopIds, s.shop_id])}
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

          {/* Clear */}
          {(activeFilterCount > 0 || search) && (
            <button onClick={clearFilters} className="h-8 px-2 text-xs text-text-muted hover:text-vibrant-coral hover:bg-surface-2 rounded-lg flex items-center gap-1 transition-colors">
              <X size={11} /> ล้าง
            </button>
          )}
          </div>
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
      contentClassName="p-6 space-y-6"
    >
      {loading ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={search ? "ไม่พบคำตอบเร็วที่ค้นหา" : "ยังไม่มีคำตอบเร็ว"}
          description={search ? "ลองค้นหาด้วยคำอื่น" : "กดเพิ่มคำตอบเร็วเพื่อเริ่มตั้งค่า"}
        />
      ) : (
        <div className="space-y-4">
          {editable && selectedIds.size > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 bg-warning-soft border-b border-warning/30 rounded-xl">
              <span className="text-xs text-warning-dark font-medium">เลือกแล้ว {selectedIds.size} รายการ</span>
              <button onClick={handleBulkDelete} className="text-xs px-2 py-1 rounded-md border border-error/30 text-error hover:bg-error/5 transition-colors">ลบที่เลือก</button>
              <button onClick={() => setSelectedIds(new Set())} className="text-xs px-2 py-1 rounded-md text-text-muted hover:bg-surface-2 transition-colors">ยกเลิกเลือก</button>
            </div>
          )}
          {editable && filtered.length > 0 && (
            <div className="flex items-center gap-2 px-1">
              <input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={toggleSelectAll} className="w-4 h-4 rounded border-border accent-brand" aria-label="เลือกทั้งหมดในหน้านี้" />
              <span className="text-xs text-text-muted">เลือกทั้งหมดในหน้านี้ ({filtered.length})</span>
            </div>
          )}
          {categories.map((cat) => (
            <div key={cat}>
              <h2 className="text-sm font-medium text-text-muted mb-2">{cat}</h2>
              <div className="grid gap-2">
                {filtered.filter((r) => r.category === cat).map((row) => (
                  <div
                    key={row.quick_reply_id}
                    className="bg-surface border border-border rounded-lg p-3 flex items-start gap-3"
                  >
                    {editable && (
                      <input type="checkbox" checked={selectedIds.has(row.quick_reply_id)} onChange={() => toggleSelect(row.quick_reply_id)} className="w-4 h-4 rounded border-border accent-brand mt-1 shrink-0" aria-label={`เลือก ${row.title}`} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-sm font-medium text-text">{row.title}</span>
                        {row.enabled ? (
                          <Badge tone="brand">เปิดใช้</Badge>
                        ) : (
                          <Badge tone="neutral">ปิดอยู่</Badge>
                        )}
                        {row.platforms.length === 0 ? (
                          <Badge tone="neutral">ทุกแพลตฟอร์ม</Badge>
                        ) : (
                          row.platforms.map((p) => <Badge key={p} tone="pale">{p.charAt(0).toUpperCase() + p.slice(1)}</Badge>)
                        )}
                        {row.shop_ids.length === 0 ? (
                          <Badge tone="neutral">ทุกร้าน</Badge>
                        ) : (
                          <Badge tone="neutral">{row.shop_ids.length} ร้าน</Badge>
                        )}
                      </div>
                      <p className="text-xs text-text-muted line-clamp-2 whitespace-pre-wrap">{row.body}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {editable && (
                        <ToggleSwitch
                          enabled={row.enabled}
                          onChange={() => handleToggle(row)}
                        />
                      )}
                      {editable && (
                        <button
                          onClick={() => openEdit(row)}
                          className="w-9 h-9 rounded-md hover:bg-surface-2 flex items-center justify-center"
                          title="แก้ไข"
                          aria-label="แก้ไข"
                        >
                          <Pencil size={13} className="text-text-muted" />
                        </button>
                      )}
                      {editable && (
                        <button
                          onClick={() => handleDelete(row.quick_reply_id)}
                          className="w-9 h-9 rounded-md hover:bg-vibrant-coral-soft flex items-center justify-center"
                          title="ลบ"
                          aria-label="ลบ"
                        >
                          <Trash2 size={13} className="text-vibrant-coral" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => closeForm()}
        >
          <div
            className="bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qr-form-modal-title"
            ref={formModalRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface">
              <h2 id="qr-form-modal-title" className="text-base font-semibold text-text">
                {editing ? "แก้ไขคำตอบเร็ว" : "เพิ่มคำตอบเร็วใหม่"}
              </h2>
              <button
                onClick={() => closeForm()}
                title="ปิด" aria-label="ปิด"
                className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center"
              >
                <X size={16} className="text-text-muted" />
              </button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
            <div className="p-4 space-y-3">
              <div>
                <label htmlFor="qr-form-category" className="text-xs text-text-muted">หมวดหมู่</label>
                <input
                  id="qr-form-category"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="เช่น ทั่วไป, พัสดุ, เคลม"
                  className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </div>
              <FormField
                id="qr-form-title"
                label="ชื่อปุ่ม"
                required
                labelClassName="text-xs text-text-muted"
                error={touched.title && !form.title.trim() ? "กรุณาตั้งชื่อคำตอบเร็ว" : undefined}
              >
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  onBlur={() => setTouched({ ...touched, title: true })}
                  placeholder="เช่น ขอเลขพัสดุ"
                  className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </FormField>
              <FormField
                id="qr-form-body"
                label="เนื้อหาคำตอบ"
                required
                labelClassName="text-xs text-text-muted"
                error={touched.body && !form.body.trim() ? "กรุณากรอกเนื้อหาคำตอบเร็ว" : undefined}
              >
                <textarea
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  onBlur={() => setTouched({ ...touched, body: true })}
                  rows={5}
                  placeholder="พิมพ์คำตอบที่จะส่งให้ลูกค้า..."
                  className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                />
              </FormField>

              {/* Platform selection — multi-select */}
              <div>
                <label htmlFor="qr-form-platforms" className="text-xs text-text-muted flex items-center gap-1">
                  <Globe size={12} /> แพลตฟอร์ม (ไม่เลือก = ทุกแพลตฟอร์ม)
                </label>
                <div className="flex gap-2 mt-1">
                  {ALL_PLATFORMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePlatform(p)}
                      aria-pressed={form.platforms.includes(p) ? "true" : "false"}
                      className={`px-3 h-9 rounded-lg border text-sm capitalize transition-colors ${
                        form.platforms.includes(p)
                          ? "border-brand bg-brand/10 text-brand"
                          : "border-border text-text-muted hover:bg-surface-2"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* Shop selection — multi-select, filtered by platform */}
              <div>
                <label htmlFor="qr-form-shops" className="text-xs text-text-muted flex items-center gap-1">
                  <Store size={12} /> ร้านค้า (ไม่เลือก = ทุกร้าน{form.platforms.length > 0 ? "ในแพลตฟอร์มที่เลือก" : ""})
                </label>
                {availableShops.length === 0 ? (
                  <p className="text-xs text-text-subtle mt-1 italic">ไม่มีร้านค้า{form.platforms.length > 0 ? "ในแพลตฟอร์มที่เลือก" : "ในระบบ"}</p>
                ) : (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-surface-2">
                    {availableShops.map((shop) => (
                      <label
                        key={`${shop.shop_id}|${shop.platform}`}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-surface cursor-pointer border-b border-border last:border-0"
                      >
                        <input
                          type="checkbox"
                          checked={form.shop_ids.includes(shop.shop_id)}
                          onChange={() => toggleShop(shop.shop_id)}
                          className="w-4 h-4 rounded accent-brand"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-text truncate">{shop.shopname}</div>
                          <div className="text-xs text-text-subtle">{shop.shop_id} · {shop.platform}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
                {form.shop_ids.length > 0 && (
                  <p className="text-xs text-text-muted mt-1">เลือก {form.shop_ids.length} ร้าน</p>
                )}
              </div>

              {/* ⚡ sort_order — สร้างใหม่: auto (ซ่อน input) / แก้ไข: ให้เปลี่ยนได้ */}
              {editing ? (
                <div>
                  <label htmlFor="qr-form-sort-order" className="text-xs text-text-muted">ลำดับ</label>
                  <input
                    id="qr-form-sort-order"
                    type="number"
                    value={form.sort_order}
                    onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
                    className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                  />
                </div>
              ) : (
                <div>
                  <label htmlFor="qr-form-sort-order" className="text-xs text-text-muted">ลำดับ</label>
                  <div className="mt-1 h-9 rounded-lg border border-border bg-surface-2/50 px-3 flex items-center text-sm text-text-muted">
                    กำหนดอัตโนมัติ (ต่อจากอันล่าสุด)
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => closeForm()}>ยกเลิก</Button>
                <Button
                  type="submit"
                  disabled={!form.title.trim() || !form.body.trim()}
                >
                  บันทึก
                </Button>
              </div>
            </div>
            </form>
          </div>
        </div>
      )}
    </PageShell>
  );
}

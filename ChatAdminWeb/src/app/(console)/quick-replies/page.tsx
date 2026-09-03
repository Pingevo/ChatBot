"use client";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Reply, Plus, Pencil, Trash2, X, Search, MessageSquare, Store, Globe, ChevronDown, ArrowDownUp, Check,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { quickReplyService, type QuickReplyRow } from "@/lib/services";
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
  const { user } = useAuth();
  const { catchError } = useToastError();
  const [rows, setRows] = useState<QuickReplyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
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
    }).catch(() => setAllShops([]));
    api().get<{ users: { admin_id: string; name?: string; username?: string }[] }>("/users/list")
      .then((r) => setAdmins(r.data.users || []))
      .catch(() => setAdmins([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await quickReplyService.list();
      setRows(data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
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
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.title.trim() || !form.body.trim()) return;
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
      toast.success("ลบคำตอบเร็วแล้ว");
    } catch (err) {
      catchError(err, "ลบไม่สำเร็จ");
    }
  }

  async function handleToggle(row: QuickReplyRow) {
    const newState = !row.enabled;
    const ok = await confirm.ask({
      title: newState ? "เปิดใช้งาน?" : "ปิดใช้งาน?",
      message: `"${row.title}" — ${newState ? "จะแสดงในรายการคำตอบเร็ว" : "จะซ่อนจากรายการ"}`,
      confirmText: newState ? "เปิดใช้งาน" : "ปิดใช้งาน",
    });
    if (!ok) return;
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
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(p)
        ? f.platforms.filter((x) => x !== p)
        : [...f.platforms, p],
      // กรอง shop_ids ให้เหลือเฉพาะร้านที่อยู่ใน platform ที่เลือก
      shop_ids: f.shop_ids.filter((sid) => {
        const shop = allShops.find((s) => s.shop_id === sid);
        return shop && (f.platforms.includes(p) ? [...f.platforms, p] : f.platforms).includes(shop.platform);
      }),
    }));
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
      {/* Header — navbar เดิม (เหมือน shops/team/triggers) */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <Reply size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">คำตอบเร็ว</h1>
              <p className="text-xs text-text-muted">
                ตั้งคำตอบสำเร็จรูป — กดปุ่มในแชทเพื่อตอบลูกค้าทันที · {filtered.length}/{rows.length} รายการ
              </p>
            </div>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} /> เพิ่มคำตอบเร็ว
          </Button>
        </div>

        {/* Filter bar — search + platform + shop + enabled + sort */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหา title, body, category..."
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
                  {["shopee", "tiktok", "lazada"].map((p) => {
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
                      <button key={`${s.shop_id}|${s.platform}`} onClick={() => setFilterShopIds(sel ? filterShopIds.filter((x) => x !== s.shop_id) : [...filterShopIds, s.shop_id])}
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

      <div className="p-6 space-y-6">
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
          {categories.map((cat) => (
            <div key={cat}>
              <h2 className="text-sm font-medium text-text-muted mb-2">{cat}</h2>
              <div className="grid gap-2">
                {filtered.filter((r) => r.category === cat).map((row) => (
                  <div
                    key={row.quick_reply_id}
                    className="bg-surface border border-border rounded-lg p-3 flex items-start gap-3"
                  >
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
                          row.platforms.map((p) => <Badge key={p} tone="pale">{p}</Badge>)
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
                      <button
                        onClick={() => handleToggle(row)}
                        className={`w-10 h-5 rounded-full transition-colors ${row.enabled ? "bg-brand" : "bg-surface-2"}`}
                        title={row.enabled ? "ปิด" : "เปิด"}
                      >
                        <div className={`w-4 h-4 bg-white rounded-full transition-transform ${row.enabled ? "translate-x-5" : "translate-x-0.5"}`} />
                      </button>
                      <button
                        onClick={() => openEdit(row)}
                        className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
                        title="แก้ไข"
                      >
                        <Pencil size={13} className="text-text-muted" />
                      </button>
                      <button
                        onClick={() => handleDelete(row.quick_reply_id)}
                        className="w-7 h-7 rounded-md hover:bg-vibrant-coral-soft flex items-center justify-center"
                        title="ลบ"
                      >
                        <Trash2 size={13} className="text-vibrant-coral" />
                      </button>
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
          onClick={() => setShowForm(false)}
        >
          <div
            className="bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface">
              <h2 className="text-base font-semibold text-text">
                {editing ? "แก้ไขคำตอบเร็ว" : "เพิ่มคำตอบเร็วใหม่"}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center"
              >
                <X size={16} className="text-text-muted" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs text-text-muted">หมวดหมู่</label>
                <input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="เช่น ทั่วไป, พัสดุ, เคลม"
                  className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted">ชื่อปุ่ม *</label>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="เช่น ขอเลขพัสดุ"
                  className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted">เนื้อหาคำตอบ *</label>
                <textarea
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  rows={5}
                  placeholder="พิมพ์คำตอบที่จะส่งให้ลูกค้า..."
                  className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                />
              </div>

              {/* Platform selection — multi-select */}
              <div>
                <label className="text-xs text-text-muted flex items-center gap-1">
                  <Globe size={12} /> แพลตฟอร์ม (ไม่เลือก = ทุกแพลตฟอร์ม)
                </label>
                <div className="flex gap-2 mt-1">
                  {ALL_PLATFORMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePlatform(p)}
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
                <label className="text-xs text-text-muted flex items-center gap-1">
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

              <div>
                <label className="text-xs text-text-muted">ลำดับ</label>
                <input
                  type="number"
                  value={form.sort_order}
                  onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
                  className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setShowForm(false)}>ยกเลิก</Button>
                <Button
                  onClick={handleSave}
                  disabled={!form.title.trim() || !form.body.trim()}
                >
                  บันทึก
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

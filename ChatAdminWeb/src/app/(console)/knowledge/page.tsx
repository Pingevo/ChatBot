"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterChips, type FilterChip } from "@/components/ui/FilterChips";
import { FormField } from "@/components/ui/FormField";
import { PageShell } from "@/components/ui/PageShell";
import { Loading } from "@/components/ui/Loading";
import { Pagination } from "@/components/ui/Pagination";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  BookOpen,
  Plus,
  Search,
  Pencil,
  Trash2,
  Upload,
  Download,
  X,
  FileSpreadsheet,
  ChevronDown,
  Check,
  ArrowDownUp,
  Info,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { kbService, type KbRow } from "@/lib/services";
import { useSearchShortcut, useEscToClear, useListboxNav, useFocusTrap } from "@/lib/useKeyboardShortcuts";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/apiClient";
import { Tooltip } from "@/components/ui/Tooltip";
import { ModalSelect } from "@/components/ui/ModalSelect";
import { FilterPresets } from "@/components/ui/FilterPresets";

type Tab = "all" | "general_faq" | "product_spec";

interface FormState {
  id?: string;
  type: "general_faq" | "product_spec";
  // general_faq fields
  topic: string;
  answer: string;
  platform: string;
  question_patterns: string[];
  // product_spec fields
  brand: string;
  model: string;
  category: string;
  highlights: string;
  description: string;
  warranty_period: string;
}

const emptyForm: FormState = {
  type: "general_faq",
  topic: "",
  answer: "",
  platform: "all",
  question_patterns: [],
  brand: "",
  model: "",
  category: "",
  highlights: "",
  description: "",
  warranty_period: "",
};

export default function KnowledgePage() {
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const handleSearchEsc = useEscToClear(() => setSearch(""));
  const { user } = useAuth();
  const editable = canEditPage(user, "kb");
  const { catchError } = useToastError();
  const [rows, setRows] = useState<KbRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [showForm, setShowForm] = useState(false);
  const formModalRef = useFocusTrap<HTMLDivElement>(showForm);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editing, setEditing] = useState<KbRow | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 50;
  // Phase 7.10 — filter bar (platform + active + created by + updated by + sort)
  const [filterPlatform, setFilterPlatform] = useState<string>("all");
  const [filterActive, setFilterActive] = useState<"all" | "active" | "inactive">("all");
  const [filterCreatedBy, setFilterCreatedBy] = useState<string>("all");
  const [filterUpdatedBy, setFilterUpdatedBy] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"recent" | "oldest" | "recent_edit" | "oldest_edit" | "name">("recent");
  const [showPlatformDd, setShowPlatformDd] = useState(false);
  const [showActiveDd, setShowActiveDd] = useState(false);
  const [showCreatedDd, setShowCreatedDd] = useState(false);
  const [showUpdatedDd, setShowUpdatedDd] = useState(false);
  const [showSortDd, setShowSortDd] = useState(false);
  const [admins, setAdmins] = useState<{ admin_id: string; name?: string; username?: string }[]>([]);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const formSnapshot = useRef("");

  // arrow-key navigation for filter dropdowns
  const platformNav = useListboxNav(4, (i) => {
    const v = (["all", "shopee", "tiktok", "lazada"])[i];
    setFilterPlatform(v); setShowPlatformDd(false); setPage(0);
  }, () => setShowPlatformDd(false));
  const activeNav = useListboxNav(3, (i) => {
    const v = (["all", "active", "inactive"] as const)[i];
    setFilterActive(v); setShowActiveDd(false); setPage(0);
  }, () => setShowActiveDd(false));
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
  const sortNav = useListboxNav(5, (i) => {
    const v = (["recent", "oldest", "recent_edit", "oldest_edit", "name"] as const)[i];
    setSortBy(v); setShowSortDd(false);
  }, () => setShowSortDd(false));

  const closeForm = async () => {
    const current = JSON.stringify({ type: form.type, topic: form.topic, answer: form.answer, platform: form.platform, question_patterns: form.question_patterns, brand: form.brand, model: form.model, category: form.category, highlights: form.highlights, description: form.description, warranty_period: form.warranty_period });
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
      const r = await kbService.list({
        type: tab === "all" ? undefined : tab,
        search: search || undefined,
      });
      setRows(r.rows as unknown as KbRow[]);
      setTotal(r.total);
    } catch (err) {
      console.error("load knowledge failed", err);
      toast.error("โหลดฐานความรู้ไม่สำเร็จ", 0, { label: "ลองใหม่", onClick: () => load() });
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

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
    const ids = paged.map(r => r._id).filter((id): id is string => !!id);
    if (selectedIds.size === ids.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(ids));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm.ask({
      title: `ลบ ${selectedIds.size} รายการ?`,
      message: "การลบเป็นถาวร — ไม่สามารถกู้คืนได้",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(ids.map(id => kbService.delete(id)));
      setSelectedIds(new Set());
      await load();
      toast.success(`ลบ ${ids.length} รายการแล้ว`);
    } catch (err) {
      catchError(err, "ลบหลายรายการไม่สำเร็จ");
    }
  };

  // โหลด admins list สำหรับ filter "created by" / "updated by"
  useEffect(() => {
    api().get<{ users: { admin_id: string; name?: string; username?: string }[] }>("/users/list")
      .then((r) => setAdmins(r.data.users || []))
      .catch((e) => {
        catchError(e, "โหลดรายชื่อแอดมินไม่สำเร็จ");
        setAdmins([]);
      });
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm, type: "general_faq" });
    setTouched({});
    setShowForm(true);
    formSnapshot.current = JSON.stringify({ type: "general_faq", topic: "", answer: "", platform: "all", question_patterns: [], brand: "", model: "", category: "", highlights: "", description: "", warranty_period: "" });
  }

  function openEdit(row: KbRow) {
    setEditing(row);
    setForm({
      id: row._id,
      type: row.type || "general_faq",
      // general_faq fields
      topic: row.topic || "",
      answer: row.answer || "",
      platform: row.platform || "all",
      question_patterns: row.question_patterns || [],
      // product_spec fields
      brand: row.brand || "",
      model: row.model || "",
      category: row.category || "",
      highlights: row.highlights || "",
      description: row.description || "",
      warranty_period: row.warranty_period || "",
    });
    setTouched({});
    setShowForm(true);
    formSnapshot.current = JSON.stringify({ type: row.type || "general_faq", topic: row.topic || "", answer: row.answer || "", platform: row.platform || "all", question_patterns: row.question_patterns || [], brand: row.brand || "", model: row.model || "", category: row.category || "", highlights: row.highlights || "", description: row.description || "", warranty_period: row.warranty_period || "" });
  }

  async function handleSave() {
    let firstError: string | null = null;
    if (form.type === "general_faq") {
      if (!form.topic.trim()) firstError = "kb-form-topic";
      else if (!form.answer.trim()) firstError = "kb-form-answer";
    } else {
      // product_spec — ต้องกรอกยี่ห้อหรือรุ่นอย่างน้อย 1 อย่าง
      if (!form.brand.trim() && !form.model.trim()) firstError = "kb-form-brand";
    }
    if (firstError) {
      setTouched({ topic: true, answer: true, brand: true, model: true });
      document.getElementById(firstError)?.focus();
      return;
    }
    try {
      if (editing?._id) {
        if (form.type === "general_faq") {
          await kbService.update(editing._id, {
            topic: form.topic,
            answer: form.answer,
            platform: form.platform,
            question_patterns: form.question_patterns,
          });
        } else {
          await kbService.update(editing._id, {
            brand: form.brand,
            model: form.model,
            category: form.category,
            highlights: form.highlights,
            description: form.description,
            warranty_period: form.warranty_period,
          } as Partial<{ topic: string; answer: string; question_patterns: string[]; platform: string; brand: string; model: string; category: string; highlights: string; description: string; warranty_period: string }>);
        }
        toast.success("แก้ไขรายการแล้ว");
      } else {
        if (form.type === "general_faq") {
          await kbService.create({
            topic: form.topic,
            answer: form.answer,
            platform: form.platform,
            question_patterns: form.question_patterns,
          });
          toast.success("สร้างรายการใหม่แล้ว");
        } else {
          // product_spec — สร้างใหม่ไม่ได้ผ่าน UI ต้อง upload Excel
          toast.warning("สินค้า (product_spec) ต้องนำเข้าผ่าน Excel เท่านั้น ไม่รองรับการสร้างใหม่ผ่านฟอร์มนี้");
          return;
        }
      }
      setShowForm(false);
      await load();
    } catch (e) {
      catchError(e, "บันทึกไม่สำเร็จ");
    }
  }

  async function handleDelete(id: string) {
    const r = rows.find((x) => x._id === id);
    const ok = await confirm.ask({
      title: "ลบรายการ?",
      message: `คุณแน่ใจหรือไม่ว่าต้องการลบ "${r?.topic || r?.model || id}" — ไม่สามารถกู้คืนได้`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await kbService.delete(id);
      await load();
      toast.success(`ลบ "${r?.topic || r?.model || id}" แล้ว`);
    } catch (e) {
      catchError(e, "ลบไม่สำเร็จ");
    }
  }

  async function handleToggle(row: KbRow) {
    if (!row._id) return;
    const newState = !row.active;
    try {
      await kbService.toggle(row._id, newState);
      await load();
      toast.success(`${newState ? "เปิด" : "ปิด"} "${row.topic || row.model}" แล้ว`);
    } catch (e) {
      catchError(e, "เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  function handleDownloadTemplate() {
    // Cookie-based auth — browser will send session cookie automatically
    window.open(kbService.templateUrl, "_blank");
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg(null);
    try {
      const r = await kbService.upload(file);
      setUploadMsg(`อัปโหลดสำเร็จ: ${r.upserted}/${r.total_rows} แถว จากไฟล์ ${r.source_file}`);
      await load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "อัปโหลดไม่สำเร็จ";
      setUploadMsg(`ผิดพลาด: ${msg}`);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  // Phase 7.10 — filter + sort logic
  const filteredRows = rows
    .filter((r) => {
      // search
      if (search) {
        const q = search.toLowerCase();
        const inTopic = (r.topic || "").toLowerCase().includes(q);
        const inAnswer = (r.answer || "").toLowerCase().includes(q);
        const inQuestion = (r.question || "").toLowerCase().includes(q);
        const inBrand = (r.brand || "").toLowerCase().includes(q);
        const inModel = (r.model || "").toLowerCase().includes(q);
        if (!inTopic && !inAnswer && !inQuestion && !inBrand && !inModel) return false;
      }
      // tab (type)
      if (tab !== "all" && r.type !== tab) return false;
      // platform filter
      if (filterPlatform !== "all") {
        if (!r.platform || r.platform === "all") return true; // ใช้กับทุกแพลตฟอร์ม
        if (r.platform !== filterPlatform) return false;
      }
      // active filter
      if (filterActive === "active" && r.active === false) return false;
      if (filterActive === "inactive" && r.active !== false) return false;
      // created by filter
      if (filterCreatedBy !== "all" && r.admin_id !== filterCreatedBy) return false;
      // updated by filter
      if (filterUpdatedBy !== "all" && r.updated_by !== filterUpdatedBy) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "name") return (a.topic || "").localeCompare(b.topic || "");
      if (sortBy === "recent_edit" || sortBy === "oldest_edit") {
        const ta = new Date(a.updated_at || a.created_at || 0).getTime();
        const tb = new Date(b.updated_at || b.created_at || 0).getTime();
        return sortBy === "recent_edit" ? tb - ta : ta - tb;
      }
      const ta = new Date(a.created_at || a.updated_at || 0).getTime();
      const tb = new Date(b.created_at || b.updated_at || 0).getTime();
      return sortBy === "recent" ? tb - ta : ta - tb;
    });

  const activeFilterCount =
    (filterPlatform !== "all" ? 1 : 0) +
    (filterActive !== "all" ? 1 : 0) +
    (filterCreatedBy !== "all" ? 1 : 0) +
    (filterUpdatedBy !== "all" ? 1 : 0);

  function clearFilters() {
    setSearch("");
    setFilterPlatform("all");
    setFilterActive("all");
    setFilterCreatedBy("all");
    setFilterUpdatedBy("all");
  }

  const paged = filteredRows.slice(page * pageSize, (page + 1) * pageSize);

  return (
    // Header — navbar แบบ shops/team
    <PageShell
      icon={BookOpen}
      title="ฐานความรู้"
      helpHref="/help#knowledge"
      subtitle={
        <>
          {editable ? "คำตอบที่บอทใช้ตอบลูกค้า — แก้ไขได้" : "คำตอบที่บอทใช้ตอบลูกค้า — ดูอย่างเดียว"}
          {" · "}{filteredRows.length}/{total} รายการ
        </>
      }
      actions={
        editable && (
          <>
            <Button size="sm" variant="outline" onClick={handleDownloadTemplate}>
              <Download size={14} /> ดาวน์โหลด Template
            </Button>
            <label className="inline-flex items-center gap-1.5 px-3 h-8 text-xs rounded-lg border border-border bg-surface-2 text-text-muted hover:bg-pale-sky-soft cursor-pointer">
              <Upload size={14} />
              {uploading ? "กำลังอัปโหลด..." : "อัปโหลด Excel"}
              <input type="file" accept=".xlsx" onChange={handleUpload} className="hidden" disabled={uploading} />
            </label>
            <Button size="sm" onClick={openCreate}>
              <Plus size={14} /> เพิ่ม
            </Button>
          </>
        )
      }
      filterBarBelow
      filterBar={
        <>
        {/* Filter bar — search + platform + active + created by + updated by + sort */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              ref={searchRef}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              onKeyDown={handleSearchEsc}
              placeholder="ค้นหาหัวข้อ คำตอบ คำถาม ยี่ห้อ รุ่น..."
              className="w-full h-8 pl-8 pr-8 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
            />
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-text-subtle border border-border rounded px-1 py-0.5 pointer-events-none">/</kbd>
          </div>

          {/* Platform filter (single — knowledge มี platform เดียว) */}
          <div className="relative">
            <button
              onClick={() => { setShowPlatformDd(!showPlatformDd); setShowActiveDd(false); setShowCreatedDd(false); setShowUpdatedDd(false); setShowSortDd(false); }}
              aria-expanded={showPlatformDd}
              aria-haspopup="listbox"
              style={{ minWidth: "110px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterPlatform !== "all" ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">แพลตฟอร์ม:</span>
              <span className="font-medium truncate" style={{ minWidth: "40px", maxWidth: "120px" }}>
                {filterPlatform === "all" ? "ทั้งหมด" : filterPlatform.charAt(0).toUpperCase() + filterPlatform.slice(1)}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showPlatformDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowPlatformDd(false)} />
                <div ref={(el) => { if (showPlatformDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามแพลตฟอร์ม" aria-activedescendant={`platform-option-${platformNav.activeIndex}`} onKeyDown={(e) => { platformNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[120px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {[
                    { v: "all", l: "ทั้งหมด" },
                    { v: "shopee", l: "Shopee" },
                    { v: "tiktok", l: "TikTok" },
                    { v: "lazada", l: "Lazada" },
                  ].map((s, i) => (
                    <button key={s.v} id={`platform-option-${i}`} role="option" aria-selected={filterPlatform === s.v} onClick={() => { setFilterPlatform(s.v); setShowPlatformDd(false); setPage(0); }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterPlatform === s.v ? "text-brand font-medium" : "text-text"}`}>
                      <Check size={11} className={filterPlatform === s.v ? "" : "opacity-0"} />
                      {s.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Active filter */}
          <div className="relative">
            <button
              onClick={() => { setShowActiveDd(!showActiveDd); setShowPlatformDd(false); setShowCreatedDd(false); setShowUpdatedDd(false); setShowSortDd(false); }}
              aria-expanded={showActiveDd}
              aria-haspopup="listbox"
              style={{ minWidth: "90px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterActive !== "all" ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">สถานะ:</span>
              <span className="font-medium" style={{ minWidth: "40px" }}>
                {filterActive === "all" ? "ทั้งหมด" : filterActive === "active" ? "เปิดใช้" : "ปิดใช้"}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showActiveDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowActiveDd(false)} />
                <div ref={(el) => { if (showActiveDd && el) el.focus(); }} role="listbox" tabIndex={-1} aria-label="กรองตามสถานะ" aria-activedescendant={`active-option-${activeNav.activeIndex}`} onKeyDown={(e) => { activeNav.onKeyDown(e); }} className="absolute top-full left-0 mt-1 min-w-[100px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {([
                    { v: "all", l: "ทั้งหมด" },
                    { v: "active", l: "เปิดใช้" },
                    { v: "inactive", l: "ปิดใช้" },
                  ] as const).map((s, i) => (
                    <button key={s.v} id={`active-option-${i}`} role="option" aria-selected={filterActive === s.v} onClick={() => { setFilterActive(s.v); setShowActiveDd(false); setPage(0); }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-2 ${filterActive === s.v ? "text-brand font-medium" : "text-text"}`}>
                      <Check size={11} className={filterActive === s.v ? "" : "opacity-0"} />
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
              onClick={() => { setShowCreatedDd(!showCreatedDd); setShowPlatformDd(false); setShowActiveDd(false); setShowUpdatedDd(false); setShowSortDd(false); }}
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
              onClick={() => { setShowUpdatedDd(!showUpdatedDd); setShowPlatformDd(false); setShowActiveDd(false); setShowCreatedDd(false); setShowSortDd(false); }}
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

          {/* Sort */}
          <div className="relative">
            <button
              onClick={() => { setShowSortDd(!showSortDd); setShowPlatformDd(false); setShowActiveDd(false); setShowCreatedDd(false); setShowUpdatedDd(false); }}
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

          {/* Preset */}
          <FilterPresets
            pageKey="knowledge"
            adminId={user?.admin_id || "anon"}
            currentValues={{
              search,
              tab,
              filterPlatform,
              filterActive,
              filterCreatedBy,
              filterUpdatedBy,
              sortBy,
            }}
            onApply={(v) => {
              setSearch(v.search || "");
              setTab(v.tab || "all");
              setFilterPlatform(v.filterPlatform || "all");
              setFilterActive(v.filterActive || "all");
              setFilterCreatedBy(v.filterCreatedBy || "all");
              setFilterUpdatedBy(v.filterUpdatedBy || "all");
              setSortBy(v.sortBy || "recent");
              setPage(0);
            }}
          />

          {/* Clear */}
          {(activeFilterCount > 0 || search) && (
            <button onClick={clearFilters} className="h-8 px-2 text-xs text-text-muted hover:text-vibrant-coral hover:bg-surface-2 rounded-lg flex items-center gap-1 transition-colors">
              <X size={11} /> ล้าง
            </button>
          )}
        </div>

        {/* Active filter chips — แสดงตัวกรองที่เปิดอยู่เป็น chip ลบได้ */}
        {(activeFilterCount > 0 || search) && (
          <div className="mt-2">
            <FilterChips
              chips={[
                ...(search ? [{ key: "search", label: `ค้นหา: ${search}`, onRemove: () => setSearch("") }] : []),
                ...(filterPlatform !== "all" ? [{ key: "platform", label: `แพลตฟอร์ม: ${filterPlatform.charAt(0).toUpperCase() + filterPlatform.slice(1)}`, onRemove: () => { setFilterPlatform("all"); setPage(0); } }] : []),
                ...(filterActive !== "all" ? [{ key: "active", label: `สถานะ: ${filterActive === "active" ? "เปิดใช้" : "ปิดใช้"}`, onRemove: () => { setFilterActive("all"); setPage(0); } }] : []),
                ...(filterCreatedBy !== "all" ? [{ key: "createdBy", label: `สร้างโดย: ${admins.find(a => a.admin_id === filterCreatedBy)?.name || filterCreatedBy}`, onRemove: () => { setFilterCreatedBy("all"); setPage(0); } }] : []),
                ...(filterUpdatedBy !== "all" ? [{ key: "updatedBy", label: `แก้โดย: ${admins.find(a => a.admin_id === filterUpdatedBy)?.name || filterUpdatedBy}`, onRemove: () => { setFilterUpdatedBy("all"); setPage(0); } }] : []),
              ]}
              onClearAll={clearFilters}
            />
          </div>
        )}
        </>
      }
      contentClassName="p-4 md:p-6"
    >
      {uploadMsg && (
        <div
          className={`text-sm rounded-lg px-3 py-2 mb-4 ${
            uploadMsg.startsWith("ผิดพลาด")
              ? "bg-vibrant-coral-soft text-vibrant-coral"
              : "bg-brand-soft text-brand"
          }`}
        >
          {uploadMsg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1.5 mb-4" role="tablist" aria-label="ประเภทความรู้">
        {([
          { v: "all", l: "ทั้งหมด" },
          { v: "general_faq", l: "FAQ/นโยบาย" },
          { v: "product_spec", l: "สินค้า" },
        ] as { v: Tab; l: string }[]).map((t) => (
          <button
            key={t.v}
            onClick={() => { setTab(t.v); setPage(0); }}
            role="tab"
            aria-selected={tab === t.v ? "true" : "false"}
            aria-controls="kb-tabpanel"
            id={`kb-tab-${t.v}`}
            tabIndex={tab === t.v ? 0 : -1}
            className={`px-3 py-1 text-xs rounded-lg transition-colors ${
              tab === t.v ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
            }`}
          >
            {t.l}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="kb-tabpanel" aria-labelledby={`kb-tab-${tab}`}>
      {loading ? (
        <div className="flex justify-center py-12">
          <Loading size={24} />
        </div>
      ) : paged.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={filteredRows.length === 0 && rows.length > 0 ? "ไม่พบรายการตรงเงื่อนไข" : "ไม่มีรายการ"}
          description={filteredRows.length === 0 && rows.length > 0 ? "ลองล้าง filter หรือค้นหาด้วยคำอื่น" : "เพิ่มคำตอบหรืออัปโหลด Excel"}
        />
      ) : (
        <>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 bg-warning-soft border-b border-warning/30 rounded-xl mb-2">
              <span className="text-xs text-warning-dark font-medium">เลือกแล้ว {selectedIds.size} รายการ</span>
              <button onClick={handleBulkDelete} className="text-xs px-2 py-1 rounded-md border border-error/30 text-error hover:bg-error/5 transition-colors">ลบที่เลือก</button>
              <button onClick={() => setSelectedIds(new Set())} className="text-xs px-2 py-1 rounded-md text-text-muted hover:bg-surface-2 transition-colors">ยกเลิกเลือก</button>
            </div>
          )}
          {paged.length > 0 && (
            <div className="flex items-center gap-2 px-1 mb-2">
              <input type="checkbox" checked={selectedIds.size === paged.length && paged.length > 0} onChange={toggleSelectAll} className="w-4 h-4 rounded border-border accent-brand" aria-label="เลือกทั้งหมดในหน้านี้" />
              <span className="text-xs text-text-muted">เลือกทั้งหมดในหน้านี้ ({paged.length})</span>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {paged.map((row) => (
              <div
                key={row._id}
                className="bg-surface rounded-xl border border-border p-4 hover:border-pale-sky transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <input type="checkbox" checked={row._id ? selectedIds.has(row._id) : false} onChange={() => row._id && toggleSelect(row._id)} className="w-4 h-4 rounded border-border accent-brand shrink-0" aria-label={`เลือก ${row.topic || row.model || row._id}`} />
                    <Badge tone={row.type === "product_spec" ? "pale" : "brand"}>
                      {row.type === "product_spec" ? "สินค้า" : "FAQ"}
                    </Badge>
                    {row.topic && <Badge tone="pale">{row.topic}</Badge>}
                    {row.platform && row.platform !== "all" && (
                      <Badge tone="neutral">{row.platform.charAt(0).toUpperCase() + row.platform.slice(1)}</Badge>
                    )}
                    {row.active === false && <Badge tone="neutral">ปิดอยู่</Badge>}
                  </div>
                  {editable && (
                    <div className="flex items-center gap-1 shrink-0">
                      <ToggleSwitch
                        enabled={row.active !== false}
                        onChange={() => handleToggle(row)}
                      />
                      <button
                        onClick={() => openEdit(row)}
                        className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
                        title="แก้ไข"
                        aria-label="แก้ไข"
                      >
                        <Pencil size={13} className="text-text-muted" />
                      </button>
                      <button
                        onClick={() => handleDelete(row._id!)}
                        className="w-7 h-7 rounded-md hover:bg-vibrant-coral-soft flex items-center justify-center"
                        title="ลบ"
                        aria-label="ลบ"
                      >
                        <Trash2 size={13} className="text-text-muted" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Content */}
                {row.type === "product_spec" ? (
                  <>
                    <div className="text-sm font-medium text-text">
                      {row.brand} {row.model}
                    </div>
                    {row.category && (
                      <div className="text-xs text-text-muted mt-0.5">หมวด: {row.category}</div>
                    )}
                    {row.highlights && (
                      <p className="text-xs text-text-muted mt-1 line-clamp-2">{row.highlights}</p>
                    )}
                    {row.warranty_period && (
                      <div className="text-[11px] text-text-subtle mt-1">รับประกัน: {row.warranty_period}</div>
                    )}
                    {row.source_file && (
                      <div className="flex items-center gap-1 mt-2 text-[10px] text-text-subtle">
                        <FileSpreadsheet size={10} /> {row.source_file}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-sm font-medium text-text mb-1">{row.topic}</div>
                    <p className="text-xs text-text-muted line-clamp-2">{row.answer}</p>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Pagination */}
          {filteredRows.length > pageSize && (
            <Pagination
              page={page + 1}
              totalPages={Math.ceil(filteredRows.length / pageSize)}
              onChange={(p) => setPage(p - 1)}
            />
          )}
        </>
      )}
      </div>

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
            aria-labelledby="kb-form-modal-title"
            ref={formModalRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface">
              <h2 id="kb-form-modal-title" className="text-base font-semibold text-text">
                {editing ? "แก้ไขคำตอบ" : "เพิ่มคำตอบใหม่"}
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
              {/* Type selector — disabled when editing */}
              <div>
                <label htmlFor="kb-form-type" className="text-xs text-text-muted">
                  ประเภท
                  <Tooltip text="FAQ/นโยบาย = คำถาม-คำตอบทั่วไป, สินค้า = ข้อมูลสินค้าจาก Excel"><Info size={12} className="text-text-subtle ml-1 inline" /></Tooltip>
                </label>
                <ModalSelect
                  id="kb-form-type"
                  value={form.type}
                  onChange={(v) => setForm({ ...form, type: v as "general_faq" | "product_spec" })}
                  disabled={!!editing}
                  options={[
                    { value: "general_faq", label: "FAQ/นโยบาย" },
                    { value: "product_spec", label: "สินค้า (ดู/แก้ไขเท่านั้น — นำเข้าผ่าน Excel)", disabled: !editing },
                  ]}
                />
              </div>

              {form.type === "general_faq" ? (
                <>
                  <FormField
                    id="kb-form-topic"
                    label="หัวข้อ"
                    required
                    labelClassName="text-xs text-text-muted"
                    error={touched.topic && !form.topic.trim() ? "กรุณากรอกหัวข้อ" : undefined}
                  >
                    <input
                      value={form.topic}
                      onChange={(e) => setForm({ ...form, topic: e.target.value })}
                      onBlur={() => setTouched({ ...touched, topic: true })}
                      placeholder="เช่น รับประกันสินค้า"
                      className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </FormField>
                  <div>
                    <label htmlFor="kb-form-platform" className="text-xs text-text-muted">
                      แพลตฟอร์ม
                      <Tooltip text="แพลตฟอร์มที่ความรู้นี้ใช้ได้ — ทุกแพลตฟอร์ม = ใช้ได้ทั้งหมด"><Info size={12} className="text-text-subtle ml-1 inline" /></Tooltip>
                    </label>
                    <ModalSelect
                      id="kb-form-platform"
                      value={form.platform}
                      onChange={(v) => setForm({ ...form, platform: v })}
                      options={[
                        { value: "all", label: "ทุกแพลตฟอร์ม" },
                        { value: "shopee", label: "Shopee" },
                        { value: "tiktok", label: "TikTok" },
                        { value: "lazada", label: "Lazada" },
                      ]}
                    />
                  </div>
                  <FormField
                    id="kb-form-answer"
                    label="เนื้อหาคำตอบ"
                    required
                    labelClassName="text-xs text-text-muted"
                    error={touched.answer && !form.answer.trim() ? "กรุณากรอกคำตอบ" : undefined}
                  >
                    <textarea
                      value={form.answer}
                      onChange={(e) => setForm({ ...form, answer: e.target.value })}
                      onBlur={() => setTouched({ ...touched, answer: true })}
                      rows={6}
                      placeholder="พิมพ์คำตอบที่บอทจะใช้..."
                      className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                    />
                  </FormField>
                </>
              ) : (
                <>
                  {!editing && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs text-text-muted flex items-start gap-2">
                      <Info size={12} className="text-warning shrink-0 mt-0.5" />
                      <span>สินค้า (product_spec) ต้องนำเข้าผ่าน Excel เท่านั้น — ฟอร์มนี้สำหรับดู/แก้ไขข้อมูลที่มีอยู่เท่านั้น</span>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      id="kb-form-brand"
                      label="แบรนด์"
                      labelClassName="text-xs text-text-muted"
                      error={touched.brand && !form.brand.trim() && !form.model.trim() ? "กรุณากรอกยี่ห้อหรือรุ่นอย่างน้อย 1 อย่าง" : undefined}
                    >
                      <input
                        value={form.brand}
                        onChange={(e) => setForm({ ...form, brand: e.target.value })}
                        onBlur={() => setTouched({ ...touched, brand: true })}
                        placeholder="เช่น Samsung"
                        className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                    </FormField>
                    <FormField id="kb-form-model" label="รุ่น" labelClassName="text-xs text-text-muted">
                      <input
                        value={form.model}
                        onChange={(e) => setForm({ ...form, model: e.target.value })}
                        onBlur={() => setTouched({ ...touched, model: true })}
                        placeholder="เช่น Galaxy S24"
                        className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                    </FormField>
                  </div>
                  <FormField id="kb-form-category" label="หมวดหมู่" labelClassName="text-xs text-text-muted">
                    <input
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      placeholder="เช่น สมาร์ทโฟน"
                      className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </FormField>
                  <FormField id="kb-form-highlights" label="จุดเด่น" labelClassName="text-xs text-text-muted">
                    <textarea
                      value={form.highlights}
                      onChange={(e) => setForm({ ...form, highlights: e.target.value })}
                      rows={3}
                      placeholder="จุดเด่นของสินค้า..."
                      className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                    />
                  </FormField>
                  <FormField id="kb-form-description" label="รายละเอียด" labelClassName="text-xs text-text-muted">
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      rows={4}
                      placeholder="รายละเอียดสินค้า..."
                      className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                    />
                  </FormField>
                  <FormField id="kb-form-warranty-period" label="ระยะเวลารับประกัน" labelClassName="text-xs text-text-muted">
                    <input
                      value={form.warranty_period}
                      onChange={(e) => setForm({ ...form, warranty_period: e.target.value })}
                      placeholder="เช่น 1 ปี"
                      className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </FormField>
                </>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => closeForm()}>
                  ยกเลิก
                </Button>
                <Button
                  type="submit"
                  disabled={
                    form.type === "general_faq"
                      ? !form.topic.trim() || !form.answer.trim()
                      : !form.brand.trim() && !form.model.trim()
                  }
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

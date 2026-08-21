"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Loading } from "@/components/ui/Loading";
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
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEdit } from "@/lib/roles";
import { kbService, type KbRow } from "@/lib/services";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/apiClient";

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
  const { user } = useAuth();
  const editable = canEdit(user);
  const { catchError } = useToastError();
  const [rows, setRows] = useState<KbRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [showForm, setShowForm] = useState(false);
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await kbService.list({
        type: tab === "all" ? undefined : tab,
        search: search || undefined,
      });
      setRows(r.rows as unknown as KbRow[]);
      setTotal(r.total);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  useEffect(() => {
    load();
  }, [load]);

  // โหลด admins list สำหรับ filter "created by" / "updated by"
  useEffect(() => {
    api().get<{ users: { admin_id: string; name?: string; username?: string }[] }>("/users/list")
      .then((r) => setAdmins(r.data.users || []))
      .catch(() => setAdmins([]));
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm, type: "general_faq" });
    setShowForm(true);
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
    setShowForm(true);
  }

  async function handleSave() {
    if (form.type === "general_faq") {
      if (!form.topic.trim() || !form.answer.trim()) return;
    } else {
      if (!form.brand.trim() && !form.model.trim()) return;
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
      toast.success("ลบรายการแล้ว");
    } catch (e) {
      catchError(e, "ลบไม่สำเร็จ");
    }
  }

  async function handleToggle(row: KbRow) {
    if (!row._id) return;
    const newState = !row.active;
    const ok = await confirm.ask({
      title: newState ? "เปิดใช้งาน?" : "ปิดใช้งาน?",
      message: `"${row.topic || row.model}" — ${newState ? "จะใช้งานได้" : "จะไม่ใช้งาน"}`,
      confirmText: newState ? "เปิดใช้งาน" : "ปิดใช้งาน",
    });
    if (!ok) return;
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
    <div className="h-full overflow-y-auto">
      {/* Header — navbar แบบ shops/team */}
      <div className="px-6 py-5 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand/15 flex items-center justify-center">
              <BookOpen size={20} className="text-brand" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-text">ฐานความรู้</h1>
              <p className="text-xs text-text-muted">
                {editable ? "คำตอบที่บอทใช้ตอบลูกค้า — แก้ไขได้" : "คำตอบที่บอทใช้ตอบลูกค้า — ดูอย่างเดียว"}
                {" · "}{filteredRows.length}/{total} รายการ
              </p>
            </div>
          </div>
          {editable && (
            <div className="flex items-center gap-2">
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
            </div>
          )}
        </div>

        {/* Filter bar — search + platform + active + created by + updated by + sort */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="ค้นหา topic, answer, question, brand, model..."
              className="w-full h-8 pl-8 pr-3 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
            />
          </div>

          {/* Platform filter (single — knowledge มี platform เดียว) */}
          <div className="relative">
            <button
              onClick={() => { setShowPlatformDd(!showPlatformDd); setShowActiveDd(false); setShowCreatedDd(false); setShowUpdatedDd(false); setShowSortDd(false); }}
              style={{ minWidth: "110px" }}
              className={`h-8 px-2.5 text-xs rounded-lg border flex items-center gap-1.5 transition-colors ${filterPlatform !== "all" ? "border-brand/40 bg-brand/5 text-text" : "border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky"}`}
            >
              <span className="text-text-subtle shrink-0">แพลตฟอร์ม:</span>
              <span className="font-medium truncate" style={{ minWidth: "40px", maxWidth: "60px" }}>
                {filterPlatform === "all" ? "ทั้งหมด" : filterPlatform}
              </span>
              <ChevronDown size={11} className="text-text-muted shrink-0" />
            </button>
            {showPlatformDd && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowPlatformDd(false)} />
                <div className="absolute top-full left-0 mt-1 min-w-[120px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {[
                    { v: "all", l: "ทั้งหมด" },
                    { v: "shopee", l: "Shopee" },
                    { v: "tiktok", l: "TikTok" },
                    { v: "lazada", l: "Lazada" },
                  ].map((s) => (
                    <button key={s.v} onClick={() => { setFilterPlatform(s.v); setShowPlatformDd(false); setPage(0); }}
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
                <div className="absolute top-full left-0 mt-1 min-w-[100px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1">
                  {([
                    { v: "all", l: "ทั้งหมด" },
                    { v: "active", l: "เปิดใช้" },
                    { v: "inactive", l: "ปิดใช้" },
                  ] as const).map((s) => (
                    <button key={s.v} onClick={() => { setFilterActive(s.v); setShowActiveDd(false); setPage(0); }}
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
              onClick={() => { setShowUpdatedDd(!showUpdatedDd); setShowPlatformDd(false); setShowActiveDd(false); setShowCreatedDd(false); setShowSortDd(false); }}
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

          {/* Sort */}
          <div className="relative">
            <button
              onClick={() => { setShowSortDd(!showSortDd); setShowPlatformDd(false); setShowActiveDd(false); setShowCreatedDd(false); setShowUpdatedDd(false); }}
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

          {/* Clear */}
          {(activeFilterCount > 0 || search) && (
            <button onClick={clearFilters} className="h-8 px-2 text-xs text-text-muted hover:text-vibrant-coral hover:bg-surface-2 rounded-lg flex items-center gap-1 transition-colors">
              <X size={11} /> ล้าง
            </button>
          )}
        </div>
      </div>

      <div className="p-4 md:p-6">
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
      <div className="flex gap-1.5 mb-4">
        {([
          { v: "all", l: "ทั้งหมด" },
          { v: "general_faq", l: "FAQ/นโยบาย" },
          { v: "product_spec", l: "สินค้า" },
        ] as { v: Tab; l: string }[]).map((t) => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            className={`px-3 py-1 text-xs rounded-lg transition-colors ${
              tab === t.v ? "bg-brand text-white" : "bg-surface-2 text-text-muted hover:bg-pale-sky-soft"
            }`}
          >
            {t.l}
          </button>
        ))}
      </div>

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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {paged.map((row) => (
              <div
                key={row._id}
                className="bg-surface rounded-xl border border-border p-4 hover:border-pale-sky transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge tone={row.type === "product_spec" ? "pale" : "brand"}>
                      {row.type === "product_spec" ? "สินค้า" : "FAQ"}
                    </Badge>
                    {row.topic && <Badge tone="pale">{row.topic}</Badge>}
                    {row.platform && row.platform !== "all" && (
                      <Badge tone="neutral">{row.platform}</Badge>
                    )}
                    {row.active === false && <Badge tone="neutral">ปิดอยู่</Badge>}
                  </div>
                  {editable && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleToggle(row)}
                        className={`w-10 h-5 rounded-full transition-colors ${
                          row.active !== false ? "bg-brand" : "bg-surface-2"
                        }`}
                        title={row.active !== false ? "ปิด" : "เปิด"}
                      >
                        <div
                          className={`w-4 h-4 bg-white rounded-full transition-transform ${
                            row.active !== false ? "translate-x-5" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                      <button
                        onClick={() => openEdit(row)}
                        className="w-7 h-7 rounded-md hover:bg-surface-2 flex items-center justify-center"
                        title="แก้ไข"
                      >
                        <Pencil size={13} className="text-text-muted" />
                      </button>
                      <button
                        onClick={() => handleDelete(row._id!)}
                        className="w-7 h-7 rounded-md hover:bg-vibrant-coral-soft flex items-center justify-center"
                        title="ลบ"
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
          {rows.length > pageSize && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                ก่อนหน้า
              </Button>
              <span className="text-xs text-text-muted">
                {page + 1} / {Math.ceil(rows.length / pageSize)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={(page + 1) * pageSize >= rows.length}
                onClick={() => setPage((p) => p + 1)}
              >
                ถัดไป
              </Button>
            </div>
          )}
        </>
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
                {editing ? "แก้ไขคำตอบ" : "เพิ่มคำตอบใหม่"}
              </h2>
              <button
                onClick={() => setShowForm(false)}
                className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center"
              >
                <X size={16} className="text-text-muted" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {/* Type selector — disabled when editing */}
              <div>
                <label className="text-xs text-text-muted">ประเภท</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as "general_faq" | "product_spec" })}
                  disabled={!!editing}
                  className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 disabled:opacity-60"
                >
                  <option value="general_faq">FAQ/นโยบาย</option>
                  <option value="product_spec">สินค้า</option>
                </select>
              </div>

              {form.type === "general_faq" ? (
                <>
                  <div>
                    <label className="text-xs text-text-muted">หัวข้อ *</label>
                    <input
                      value={form.topic}
                      onChange={(e) => setForm({ ...form, topic: e.target.value })}
                      placeholder="เช่น รับประกันสินค้า"
                      className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-muted">แพลตฟอร์ม</label>
                    <select
                      value={form.platform}
                      onChange={(e) => setForm({ ...form, platform: e.target.value })}
                      className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    >
                      <option value="all">ทุกแพลตฟอร์ม</option>
                      <option value="shopee">Shopee</option>
                      <option value="tiktok">TikTok</option>
                      <option value="lazada">Lazada</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-text-muted">เนื้อหาคำตอบ *</label>
                    <textarea
                      value={form.answer}
                      onChange={(e) => setForm({ ...form, answer: e.target.value })}
                      rows={6}
                      placeholder="พิมพ์คำตอบที่บอทจะใช้..."
                      className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-text-muted">แบรนด์</label>
                      <input
                        value={form.brand}
                        onChange={(e) => setForm({ ...form, brand: e.target.value })}
                        placeholder="เช่น Samsung"
                        className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-text-muted">รุ่น</label>
                      <input
                        value={form.model}
                        onChange={(e) => setForm({ ...form, model: e.target.value })}
                        placeholder="เช่น Galaxy S24"
                        className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-text-muted">หมวดหมู่</label>
                    <input
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      placeholder="เช่น สมาร์ทโฟน"
                      className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-muted">จุดเด่น</label>
                    <textarea
                      value={form.highlights}
                      onChange={(e) => setForm({ ...form, highlights: e.target.value })}
                      rows={3}
                      placeholder="จุดเด่นของสินค้า..."
                      className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-muted">รายละเอียด</label>
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      rows={4}
                      placeholder="รายละเอียดสินค้า..."
                      className="w-full mt-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 resize-y"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-muted">ระยะเวลารับประกัน</label>
                    <input
                      value={form.warranty_period}
                      onChange={(e) => setForm({ ...form, warranty_period: e.target.value })}
                      placeholder="เช่น 1 ปี"
                      className="w-full mt-1 h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                    />
                  </div>
                </>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setShowForm(false)}>
                  ยกเลิก
                </Button>
                <Button
                  onClick={handleSave}
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
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

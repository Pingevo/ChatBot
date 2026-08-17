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
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEdit } from "@/lib/roles";
import { kbService, type KbRow } from "@/lib/services";

type Tab = "all" | "general_faq" | "product_spec";

interface FormState {
  id?: string;
  topic: string;
  answer: string;
  platform: string;
  question_patterns: string[];
}

const emptyForm: FormState = {
  topic: "",
  answer: "",
  platform: "all",
  question_patterns: [],
};

export default function KnowledgePage() {
  const { user } = useAuth();
  const editable = canEdit(user);
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

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(row: KbRow) {
    setEditing(row);
    setForm({
      id: row._id,
      topic: row.topic || "",
      answer: row.answer || "",
      platform: row.platform || "all",
      question_patterns: row.question_patterns || [],
    });
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.topic.trim() || !form.answer.trim()) return;
    try {
      if (editing?._id) {
        await kbService.update(editing._id, {
          topic: form.topic,
          answer: form.answer,
          platform: form.platform,
          question_patterns: form.question_patterns,
        });
      } else {
        await kbService.create({
          topic: form.topic,
          answer: form.answer,
          platform: form.platform,
          question_patterns: form.question_patterns,
        });
      }
      setShowForm(false);
      await load();
    } catch (e) {
      alert("บันทึกไม่สำเร็จ");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("ต้องการลบรายการนี้ใช่ไหม?")) return;
    try {
      await kbService.delete(id);
      await load();
    } catch {
      alert("ลบไม่สำเร็จ");
    }
  }

  async function handleToggle(row: KbRow) {
    if (!row._id) return;
    try {
      await kbService.toggle(row._id, !row.active);
      await load();
    } catch {
      alert("เปลี่ยนสถานะไม่สำเร็จ");
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

  const paged = rows.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-text">ฐานความรู้</h1>
          <p className="text-sm text-text-muted">
            {editable ? "คำตอบที่บอทใช้ตอบลูกค้า — แก้ไขได้" : "คำตอบที่บอทใช้ตอบลูกค้า — ดูอย่างเดียว"}
            {" · "}ทั้งหมด {total} รายการ
          </p>
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

      {/* Search */}
      <div className="relative mb-4 max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหา topic, answer, brand, model..."
          className="w-full h-9 pl-9 pr-3 rounded-lg bg-surface-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
        />
      </div>

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
        <EmptyState icon={BookOpen} title="ไม่มีรายการ" description="เพิ่มคำตอบหรืออัปโหลด Excel" />
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
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
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setShowForm(false)}>
                  ยกเลิก
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={!form.topic.trim() || !form.answer.trim()}
                >
                  บันทึก
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

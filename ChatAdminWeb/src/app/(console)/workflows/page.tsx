"use client";
// Workflows list — หน้าหลัก Flow Builder (แบบ Zaapi)
//
// ⚡ โครงสร้าง flow:
//   - flow เป็นของรายร้าน (1 ร้านมีได้หลาย flow) หรือใช้ร่วมทั้งระบบ (shop_ids ว่าง = ทุกร้าน)
//   - platforms ว่าง = ทุก platform
//   - เปิด/ปิดราย flow ได้ (toggle)
//
// Features: search ชื่อ / sort (อัปเดตล่าสุด, ชื่อ, priority, จำนวน node) /
//           filter (status, enabled, platform) / inline rename / toggle / กดแถวเข้า editor / ลบ (soft)
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { toast } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import {
  GitBranch, Plus, Trash2, Pencil, RefreshCw, Search, Check, X, Info,
} from "lucide-react";
import { useSearchShortcut, useEscToClear } from "@/lib/useKeyboardShortcuts";
import { FilterSelect } from "@/components/ui/FilterSelect";
import { Tooltip } from "@/components/ui/Tooltip";

interface WorkflowRow {
  workflow_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  status: string;
  shop_ids: string[];
  platforms: string[];
  trigger_frequency: string;
  false_branch_policy: string;
  priority: number;
  version: number;
  nodes: unknown[];
  edges: unknown[];
  updated_at: string;
}

type Platform = "shopee" | "tiktok" | "lazada";
const ALL_PLATFORMS: Platform[] = ["shopee", "tiktok", "lazada"];
const platformLabels: Record<Platform, string> = {
  shopee: "Shopee",
  tiktok: "TikTok",
  lazada: "Lazada",
};

interface ShopOption {
  shop_id: string;
  shopname: string;
  platform: string;
}

type SortKey = "updated" | "name" | "priority" | "nodes";

const freqLabels: Record<string, string> = {
  every_time: "ทุกครั้ง",
  once_per_conversation: "แชทละ 1 ครั้ง",
  once_per_customer: "ลูกค้าละ 1 ครั้ง",
};

const policyLabels: Record<string, string> = {
  exit_to_bot: "ไม่ผ่าน → บอทตอบ",
  exit_drop: "ไม่ผ่าน → ทิ้งข้อความ",
  stay_retry: "ไม่ผ่าน → ทวงคำตอบ",
};

const sortLabels: Record<SortKey, string> = {
  updated: "อัปเดตล่าสุด",
  name: "ชื่อ (ก-ฮ)",
  priority: "Priority สูง→ต่ำ",
  nodes: "จำนวน node",
};

export default function WorkflowsPage() {
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchShortcut(searchRef);
  const handleSearchEsc = useEscToClear(() => setSearch(""));
  const router = useRouter();
  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [shops, setShops] = useState<ShopOption[]>([]);
  const [loading, setLoading] = useState(true);

  // ⚡ Search / Sort / Filter
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("updated");
  const [fStatus, setFStatus] = useState<"all" | "draft" | "published">("all");
  const [fEnabled, setFEnabled] = useState<"all" | "on" | "off">("all");
  const [fPlatform, setFPlatform] = useState<"all" | "shopee" | "tiktok" | "lazada">("all");

  // ⚡ Inline rename
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // ⚡ Create modal — เลือก name/description/platform→ร้าน ก่อนเข้า editor
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cPlatforms, setCPlatforms] = useState<Platform[]>([]);
  const [cShopIds, setCShopIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const openCreate = () => {
    setCName("");
    setCDesc("");
    setCPlatforms([]);
    setCShopIds([]);
    setShowCreate(true);
  };

  // ⚡ ร้านที่กรองตาม platform ที่เลือก — ถ้ายังไม่เลือก platform ให้โชว์ร้านทั้งหมด (เพราะ platforms ว่าง = ทุก platform)
  // dedupe by shop_id เพราะ /api/shops ส่งกลับ shop เดียวหลายบรรทัด (หนึ่งบรรทัดต่อ platform)
  // แล้วรวม platform ทั้งหมดของร้านนั้นเป็น list ใน label เดียว — กัน duplicate React key
  const filteredShops = useMemo(() => {
    const base = cPlatforms.length === 0
      ? shops
      : shops.filter((s) => cPlatforms.includes(s.platform as Platform));
    const map = new Map<string, { shop_id: string; shopname: string; platforms: string[] }>();
    for (const s of base) {
      const existing = map.get(s.shop_id);
      if (existing) {
        if (!existing.platforms.includes(s.platform)) existing.platforms.push(s.platform);
      } else {
        map.set(s.shop_id, { shop_id: s.shop_id, shopname: s.shopname, platforms: [s.platform] });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.shopname.localeCompare(b.shopname, "th"));
  }, [shops, cPlatforms]);

  const togglePlatform = (p: Platform) => {
    // เมื่อ platform เปลี่ยน → เอา shop ที่ไม่ตรง platform ออกจากการเลือก
    const nextPlats = cPlatforms.includes(p)
      ? cPlatforms.filter((x) => x !== p)
      : [...cPlatforms, p];
    setCPlatforms(nextPlats);
    if (nextPlats.length > 0) {
      setCShopIds((prev) => {
        const allowed = new Set(shops.filter((s) => nextPlats.includes(s.platform as Platform)).map((s) => s.shop_id));
        return prev.filter((id) => allowed.has(id));
      });
    }
  };

  const toggleShop = (id: string) => {
    setCShopIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submitCreate = async () => {
    const name = cName.trim();
    if (!name) { toast.error("ตั้งชื่อ workflow ก่อน"); return; }
    setCreating(true);
    try {
      const r = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: cDesc.trim() || undefined,
          platforms: cPlatforms,
          shop_ids: cShopIds,
          nodes: [],
          edges: [],
          status: "draft",
          enabled: false,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      toast.success("สร้าง workflow แล้ว — ไปที่ editor");
      setShowCreate(false);
      const id = d.workflow?.workflow_id;
      if (id) router.push(`/workflows/${id}`);
      else load();
    } catch (err) {
      toast.error(`สร้างไม่สำเร็จ: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  // ESC to close create modal (ไม่ปิดขณะกำลังสร้าง)
  useEffect(() => {
    if (!showCreate) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!creating) setShowCreate(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCreate, creating]);

  const shopNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shops) m.set(s.shop_id, s.shopname);
    return m;
  }, [shops]);

  const load = async () => {
    setLoading(true);
    try {
      const [wfRes, shopRes] = await Promise.all([
        fetch("/api/workflows"),
        fetch("/api/shops").catch(() => null),
      ]);
      if (!wfRes.ok) throw new Error(`HTTP ${wfRes.status}`);
      const d = await wfRes.json();
      setRows(d.rows || []);
      if (shopRes?.ok) {
        const sd = await shopRes.json().catch(() => ({ rows: [] }));
        setShops(sd.rows || []);
      }
    } catch (err) {
      toast.error(`โหลด workflows ไม่ได้: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ⚡ Filter + sort + search (client-side — flow จำนวนไม่มาก)
  const visible = useMemo(() => {
    let list = [...rows];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((wf) => {
        const inName = wf.name.toLowerCase().includes(q);
        const inShops = (wf.shop_ids || []).some((id) => (shopNameById.get(id) || id).toLowerCase().includes(q));
        return inName || inShops;
      });
    }
    if (fStatus !== "all") list = list.filter((wf) => wf.status === fStatus);
    if (fEnabled !== "all") list = list.filter((wf) => (fEnabled === "on") === wf.enabled);
    if (fPlatform !== "all") {
      list = list.filter((wf) => (wf.platforms || []).length === 0 || wf.platforms.includes(fPlatform));
    }
    switch (sortBy) {
      case "name":
        list.sort((a, b) => a.name.localeCompare(b.name, "th"));
        break;
      case "priority":
        list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        break;
      case "nodes":
        list.sort((a, b) => (b.nodes?.length || 0) - (a.nodes?.length || 0));
        break;
      default: // updated
        list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }
    return list;
  }, [rows, search, sortBy, fStatus, fEnabled, fPlatform, shopNameById]);

  const toggle = async (wf: WorkflowRow) => {
    // 🔒 P2a: Confirm before toggling — affects live bot routing
    const action = wf.enabled ? "ปิด" : "เปิด";
    if (!(await confirm.ask({
      title: `${action} workflow "${wf.name}"?`,
      message: `การ${action}จะมีผลต่อการ routing ข้อความทันที`,
      variant: wf.enabled ? "danger" : "primary",
    }))) return;
    try {
      const r = await fetch(`/api/workflows/${wf.workflow_id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !wf.enabled }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      }
      toast.success(wf.enabled ? `ปิด "${wf.name}" แล้ว` : `เปิด "${wf.name}" แล้ว`);
      load();
    } catch (err) {
      toast.error(`เปลี่ยนสถานะผิดพลาด: ${(err as Error).message}`);
    }
  };

  const remove = async (wf: WorkflowRow) => {
    if (!(await confirm.ask({
      title: `ลบ workflow "${wf.name}"?`,
      message: "การลบเป็น soft delete — เก็บประวัติไว้ สามารถกู้คืนได้",
      variant: "danger",
    }))) return;
    try {
      const r = await fetch(`/api/workflows/${wf.workflow_id}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      }
      // 🔒 P4e: Undo action — restore the workflow
      toast.success("ลบแล้ว (soft delete)", 6000, {
        label: "กู้คืน",
        onClick: async () => {
          try {
            const rr = await fetch(`/api/workflows/${wf.workflow_id}/restore`, { method: "POST" });
            if (!rr.ok) throw new Error("restore failed");
            toast.success("กู้คืน workflow แล้ว");
            load();
          } catch {
            toast.error("กู้คืนไม่สำเร็จ");
          }
        },
      });
      load();
    } catch (err) {
      toast.error(`ลบผิดพลาด: ${(err as Error).message}`);
    }
  };

  // ⚡ Inline rename — กด pencil → ช่อง input → Enter = PATCH / Esc = cancel
  const startRename = (wf: WorkflowRow) => {
    setRenamingId(wf.workflow_id);
    setRenameDraft(wf.name);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const name = renameDraft.trim();
    if (!name) { setRenamingId(null); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/workflows/${renamingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || d.error || `HTTP ${r.status}`);
      }
      toast.success("เปลี่ยนชื่อแล้ว");
      setRenamingId(null);
      load();
    } catch (err) {
      toast.error(`เปลี่ยนชื่อไม่สำเร็จ: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell
      icon={GitBranch}
      title="เวิร์กโฟลว์"
      helpHref="/help#workflows"
      subtitle="Flow หลายขั้นตอนแบบ Zaapi — แต่ละร้านมีได้หลาย flow (ไม่เลือกร้าน = ใช้ร่วมทุกร้าน) · ลำดับ workflow/trigger ตั้งได้ใน System Config"
      actions={
        <>
          <Button size="sm" variant="outline" onClick={load}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus size={14} /> สร้างเวิร์กโฟลว์
          </Button>
        </>
      }
      filterBarBelow
      filterBar={
        <>
          {/* ⚡ Toolbar: search + sort + filter */}
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-subtle" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearchEsc}
                placeholder="ค้นหาชื่อ flow หรือชื่อร้าน…"
                className="w-full h-8 pl-8 pr-8 rounded-lg border border-border bg-surface text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand/40"
              />
              <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-text-subtle border border-border rounded px-1 py-0.5 pointer-events-none">/</kbd>
            </div>
            <FilterSelect
              value={sortBy}
              onChange={(v) => setSortBy(v as SortKey)}
              labelPrefix="เรียง: "
              options={Object.entries(sortLabels).map(([k, v]) => ({ value: k, label: v }))}
            />
            <span className="inline-flex items-center gap-1">
              <Tooltip text="สถานะเวิร์กโฟลว์ — เผยแพร่ = ใช้งานได้, ฉบับร่าง = ยังไม่เผยแพร่"><Info size={12} className="text-text-subtle" /></Tooltip>
              <FilterSelect
                value={fStatus}
                onChange={(v) => setFStatus(v as typeof fStatus)}
                labelPrefix="สถานะ: "
                options={[
                  { value: "all", label: "ทั้งหมด" },
                  { value: "published", label: "เผยแพร่" },
                  { value: "draft", label: "ฉบับร่าง" },
                ]}
              />
            </span>
            <span className="inline-flex items-center gap-1">
              <Tooltip text="เปิด/ปิดการทำงานของเวิร์กโฟลว์"><Info size={12} className="text-text-subtle" /></Tooltip>
              <FilterSelect
                value={fEnabled}
                onChange={(v) => setFEnabled(v as typeof fEnabled)}
                labelPrefix="ใช้งาน: "
                options={[
                  { value: "all", label: "ทั้งหมด" },
                  { value: "on", label: "เปิดใช้งาน" },
                  { value: "off", label: "ปิดอยู่" },
                ]}
              />
            </span>
            <FilterSelect
              value={fPlatform}
              onChange={(v) => setFPlatform(v as typeof fPlatform)}
              labelPrefix="แพลตฟอร์ม: "
              options={[
                { value: "all", label: "ทั้งหมด" },
                { value: "shopee", label: "Shopee" },
                { value: "tiktok", label: "TikTok" },
                { value: "lazada", label: "Lazada" },
              ]}
            />
            <span className="text-xs text-text-subtle">{visible.length}/{rows.length} flow</span>
          </div>
        </>
      }
      contentClassName="p-4 md:p-6 space-y-4"
    >
      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><Loading /></div>
      ) : rows.length === 0 ? (
        <div>
          <EmptyState
            icon={GitBranch}
            title="ยังไม่มี workflow"
            description="สร้าง flow แรกของคุณ — เช่น ลูกค้าถามสเปค → บอทตอบ → ถามสนใจซื้อ → รอตอบ → แตกกิ่งสั่งซื้อ/ทีมขาย"
          />
          <div className="flex justify-center mt-2">
            <Button onClick={openCreate}><Plus size={14} /> สร้าง Workflow</Button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">
          ไม่เจอ flow ตามเงื่อนไขที่กรอง — ลองล้างการค้นหาและตัวกรอง
          <div className="mt-2.5">
            <Button variant="outline" onClick={() => { setSearch(""); setFStatus("all"); setFEnabled("all"); setFPlatform("all"); }}>
              ล้างตัวกรอง
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((wf) => {
            const shopBadges = (wf.shop_ids || []).length === 0
              ? null
              : (wf.shop_ids || []).slice(0, 3).map((id) => shopNameById.get(id) || id);
            const moreShops = (wf.shop_ids || []).length - 3;
            return (
              <div
                key={wf.workflow_id}
                role="button"
                tabIndex={0}
                onClick={() => renamingId !== wf.workflow_id && router.push(`/workflows/${wf.workflow_id}`)}
                onKeyDown={(e) => {
                  // กด Enter/Space ที่ตัวการ์ด = เข้า editor (ข้ามถ้าโฟกัสอยู่ที่ปุ่ม/input ลูก)
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (renamingId !== wf.workflow_id) router.push(`/workflows/${wf.workflow_id}`);
                  }
                }}
                className={`bg-surface rounded-xl border border-border p-4 hover:border-pale-sky transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${wf.enabled ? "" : "opacity-60"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Name + badges */}
                    {renamingId === wf.workflow_id ? (
                      <div onClick={(e) => e.stopPropagation()} className="flex gap-1.5 items-center">
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="h-9 px-2.5 rounded-lg border border-border bg-surface-2 text-text text-sm font-semibold w-72 focus:outline-none focus:ring-2 focus:ring-brand/40"
                        />
                        <Button size="sm" onClick={commitRename} disabled={saving || !renameDraft.trim()}>
                          <Check size={13} /> บันทึก
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRenamingId(null)} title="ยกเลิก" aria-label="ยกเลิก">
                          <X size={13} />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="text-sm font-semibold text-text">{wf.name}</span>
                        <Badge tone={wf.status === "published" ? "brand" : "neutral"}>
                          {wf.status === "published" ? "เผยแพร่" : "ฉบับร่าง"}
                        </Badge>
                        {wf.priority !== 0 && (
                          <span className="inline-flex items-center gap-0.5">
                            <Badge tone="deep">P{wf.priority}</Badge>
                            <Tooltip text="ลำดับความสำคัญ — ตัวเลขยิ่งสูงยิ่งจับคู่ก่อน"><Info size={12} className="text-text-subtle" /></Tooltip>
                          </span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); startRename(wf); }}
                          title="เปลี่ยนชื่อ"
                          aria-label="เปลี่ยนชื่อ"
                          className="w-6 h-6 rounded-md hover:bg-surface-2 flex items-center justify-center text-text-muted hover:text-text"
                        >
                          <Pencil size={12} />
                        </button>
                      </div>
                    )}

                    {/* Meta row */}
                    <div className="flex items-center gap-3 flex-wrap text-xs text-text-muted">
                      <span>{(wf.nodes || []).length} nodes · {(wf.edges || []).length} edges · v{wf.version}</span>
                      <span>{freqLabels[wf.trigger_frequency] || wf.trigger_frequency}</span>
                      <span>{policyLabels[wf.false_branch_policy] || wf.false_branch_policy}</span>
                      <span>{(wf.platforms || []).length === 0 ? "ทุก platform" : wf.platforms.join("/")}</span>
                      <span>
                        {(wf.shop_ids || []).length === 0
                          ? "ใช้ร่วมทุกร้าน"
                          : <>ร้าน: {shopBadges!.join(", ")}{moreShops > 0 ? ` +${moreShops}` : ""}</>}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 shrink-0">
                    {/* Toggle switch — เหมือน triggers page */}
                    <ToggleSwitch
                      enabled={wf.enabled}
                      onChange={() => toggle(wf)}
                    />
                    <button
                      onClick={() => router.push(`/workflows/${wf.workflow_id}`)}
                      className="w-9 h-9 rounded-md hover:bg-surface-2 flex items-center justify-center"
                      title="แก้ไข"
                      aria-label="แก้ไข"
                    >
                      <Pencil size={13} className="text-text-muted" />
                    </button>
                    <button
                      onClick={() => remove(wf)}
                      className="w-9 h-9 rounded-md hover:bg-vibrant-coral-soft flex items-center justify-center"
                      title="ลบ"
                      aria-label="ลบ"
                    >
                      <Trash2 size={13} className="text-text-muted hover:text-vibrant-coral" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ⚡ Create modal — เลือก name/description/platform→ร้าน ก่อนเข้า editor */}
      {showCreate && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => !creating && setShowCreate(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-create-modal-title"
            className="bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface z-10">
              <div className="flex items-center gap-2">
                <Plus size={18} className="text-brand" />
                <h2 id="workflow-create-modal-title" className="text-base font-semibold text-text">สร้าง Workflow ใหม่</h2>
              </div>
              <button
                onClick={() => !creating && setShowCreate(false)}
                disabled={creating}
                className="w-8 h-8 rounded-md hover:bg-surface-2 flex items-center justify-center disabled:opacity-50"
                title="ปิด"
                aria-label="ปิด"
              >
                <X size={16} className="text-text-muted" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">
                  ชื่อ workflow <span className="text-vibrant-coral">*</span>
                </label>
                <input
                  autoFocus
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && cName.trim() && !creating) submitCreate(); }}
                  placeholder="เช่น ขายหัวชาร์จ / ทักแรก / สนใจสั่งซื้อ"
                  className="w-full h-10 px-3 rounded-lg border border-border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">
                  คำอธิบาย <span className="text-text-subtle font-normal">(ไม่บังคับ)</span>
                </label>
                <textarea
                  value={cDesc}
                  onChange={(e) => setCDesc(e.target.value)}
                  placeholder="อธิบายสั้นๆ ว่า flow นี้ทำอะไร — แก้ไขภายหลังได้"
                  rows={3}
                  className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-brand/40"
                />
              </div>

              {/* Platform */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">
                  Platform <span className="text-text-subtle font-normal">(เลือกได้มากกว่า 1 — ไม่เลือก = ทุก platform)</span>
                </label>
                <div className="flex gap-2 flex-wrap">
                  {ALL_PLATFORMS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => togglePlatform(p)}
                      className={`h-9 px-3 rounded-lg border text-sm transition-colors flex items-center gap-1.5 ${
                        cPlatforms.includes(p)
                          ? "border-brand bg-brand/10 text-brand"
                          : "border-border text-text-muted hover:border-brand/40"
                      }`}
                    >
                      {cPlatforms.includes(p) && <Check size={12} />}
                      {platformLabels[p]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Shops */}
              <div>
                <label className="block text-sm font-medium text-text mb-1.5">
                  ร้านค้า
                  <span className="text-text-subtle font-normal ml-1">
                    ({cPlatforms.length > 0 ? `${filteredShops.length} ร้านตาม platform` : `${filteredShops.length} ร้านทั้งหมด`} — เลือกได้หลายร้าน · ไม่เลือก = ใช้ร่วมทุกร้าน)
                  </span>
                </label>
                {shops.length === 0 ? (
                  <div className="text-xs text-text-muted p-3 rounded-lg border border-border bg-surface-2">
                    โหลดร้านไม่ได้ — ยังสร้างได้ แต่จะใช้กับทุกร้าน (สามารถเลือกภายหลังใน editor)
                  </div>
                ) : filteredShops.length === 0 ? (
                  <div className="text-xs text-text-muted p-3 rounded-lg border border-border bg-surface-2">
                    ไม่มีร้านใน platform ที่เลือก
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 max-h-44 overflow-y-auto p-2 rounded-lg border border-border bg-surface-2">
                    {filteredShops.map((s) => (
                      <label key={s.shop_id} className="flex items-center gap-2 text-xs cursor-pointer px-1 py-1 rounded hover:bg-surface">
                        <input
                          type="checkbox"
                          checked={cShopIds.includes(s.shop_id)}
                          onChange={() => toggleShop(s.shop_id)}
                          className="accent-brand"
                        />
                        <span className="text-text truncate">{s.shopname}</span>
                        <span className="text-[10px] text-text-subtle shrink-0">
                          ({s.platforms.map((p) => platformLabels[p as Platform] || p).join(", ")})
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-2 pt-4 border-t border-border mt-2">
                <Button variant="ghost" className="flex-1" onClick={() => setShowCreate(false)} disabled={creating}>
                  ยกเลิก
                </Button>
                <Button className="flex-1" onClick={submitCreate} disabled={creating || !cName.trim()}>
                  {creating ? "กำลังสร้าง…" : "สร้างและเปิด editor"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}

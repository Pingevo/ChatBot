"use client";
// หน้า /llm — runtime LLM config (dev-only)
// - key pool: list + toggle on/off + rename + add/remove — shape {name,value,enabled}
// - models: searchable dropdown ต่อ role — เปลี่ยนแล้ว confirm ก่อนบันทึก (ไม่มีปุ่ม save)
// - bot อ่าน config ทุก ~10s — ทุก mutation มีผลอัตโนมัติ
import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  KeyRound, Cpu, Plus, Trash2, RefreshCw, Eye, MessageSquare,
  ScanSearch, Globe, ShieldAlert, Search, Check, ChevronDown, X, Pencil,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";

interface MaskedKey {
  index: number;
  sha256: string;
  tail: string;
  name: string;
  enabled: boolean;
}

type ModelRole = "chat" | "vision" | "intent" | "openrouter_search";

interface LlmConfigResponse {
  ok: boolean;
  keys: MaskedKey[];
  models: Partial<Record<ModelRole, string>>;
  model_roles: ModelRole[];
  updated_by?: string;
  updated_at?: string;
}

const ROLE_META: Record<ModelRole, { label: string; desc: string; icon: typeof Cpu; placeholder: string }> = {
  chat: {
    label: "Chat",
    desc: "ตอบแชทลูกค้า (answer / answer_with_kb / answer_general)",
    icon: MessageSquare,
    placeholder: "gemini-3.5-flash-lite",
  },
  vision: {
    label: "Vision",
    desc: "อ่านรูป/วิดีโอที่ลูกค้าส่ง",
    icon: Eye,
    placeholder: "gemini-3.1-flash-lite",
  },
  intent: {
    label: "Intent",
    desc: "จำแนกเจตนาข้อความก่อน route",
    icon: ScanSearch,
    placeholder: "gemini-3.1-flash-lite",
  },
  openrouter_search: {
    label: "Web Search (OpenRouter)",
    desc: "สกัดคำตอบจากเว็บเมื่อสินค้า/KB ไม่พอ",
    icon: Globe,
    placeholder: "google/gemini-2.5-flash:online",
  },
};

const GEMINI_MODELS = [
  "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.5-pro",
  "gemini-3.1-flash-lite", "gemini-3.1-flash", "gemini-3.1-pro",
  "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash",
];
const OPENROUTER_MODELS = [
  "google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash:online", "google/gemini-2.5-flash",
  "google/gemini-2.0-flash-001", "openai/gpt-4o-mini", "anthropic/claude-haiku-4.5",
];

/* ------------------------------------------------------------------ */
/* SearchableSelect — combobox พิมพ์ค้นหาได้ + ใส่ค่าเองได้              */
/* ------------------------------------------------------------------ */

function SearchableSelect({
  value, options, placeholder, onPick, disabled,
}: {
  value: string;
  options: { value: string; label: string; hint?: string }[];
  placeholder: string;
  onPick: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const h = Math.min(300, spaceBelow - 8);
    setMenuStyle({
      position: "fixed",
      top: spaceBelow > 240 ? r.bottom + 4 : Math.max(8, r.top - h - 4),
      left: r.left,
      width: Math.max(r.width, 260),
      zIndex: 9999,
    });
    setQ("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const filtered = options.filter((o) =>
    o.value.toLowerCase().includes(q.toLowerCase()) || o.label.toLowerCase().includes(q.toLowerCase())
  );
  const custom = q.trim() && !options.some((o) => o.value === q.trim()) ? q.trim() : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left font-mono text-sm text-text transition-colors hover:border-accent/50 disabled:opacity-50"
      >
        <span className="truncate">{value || <span className="text-text-subtle">{placeholder}</span>}</span>
        <ChevronDown size={14} className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div ref={menuRef} style={menuStyle}
          className="overflow-hidden rounded-lg border border-border bg-surface shadow-lg shadow-black/10">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search size={14} className="shrink-0 text-text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (custom || filtered[0])) {
                  onPick(custom ?? filtered[0].value); setOpen(false);
                }
              }}
              placeholder="ค้นหา หรือพิมพ์ชื่อ model..."
              className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-subtle"
            />
            {q && <button onClick={() => setQ("")} aria-label="ล้าง"><X size={13} className="text-text-muted" /></button>}
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            <OptionRow
              active={!value}
              label={placeholder}
              sub="ค่า default จาก env"
              onClick={() => { onPick(""); setOpen(false); }}
            />
            {filtered.map((o) => (
              <OptionRow key={o.value} active={o.value === value} label={o.value} sub={o.hint}
                onClick={() => { onPick(o.value); setOpen(false); }} />
            ))}
            {custom && (
              <OptionRow label={`ใช้ "${custom}"`} sub="custom — ไม่มีใน list" accent
                onClick={() => { onPick(custom); setOpen(false); }} />
            )}
            {!filtered.length && !custom && (
              <p className="px-3 py-3 text-xs text-text-subtle">ไม่พบ model</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function OptionRow({ label, sub, active, accent, onClick }: {
  label: React.ReactNode; sub?: string; active?: boolean; accent?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2">
      <span className="w-4 shrink-0">{active && <Check size={14} className="text-accent" />}</span>
      <span className={`min-w-0 flex-1 truncate font-mono text-sm ${accent ? "text-accent" : "text-text"}`}>{label}</span>
      {sub && <span className="shrink-0 text-[11px] text-text-subtle">{sub}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

export default function LlmConfigPage() {
  const { user } = useAuth();
  const { catchError } = useToastError();
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<MaskedKey[]>([]);
  const [models, setModels] = useState<Partial<Record<ModelRole, string>>>({});
  const [meta, setMeta] = useState<{ updated_by?: string; updated_at?: string }>({});
  const [saving, setSaving] = useState(false);

  // add-key inline form
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  // rename inline
  const [editingSha, setEditingSha] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const allowed = canEditPage(user, "llm");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<LlmConfigResponse>("/llm-config");
      setKeys(r.data.keys ?? []);
      setModels(r.data.models ?? {});
      setMeta({ updated_by: r.data.updated_by, updated_at: r.data.updated_at });
    } catch (e) {
      catchError(e, "โหลด config ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  async function mutate(body: Record<string, unknown>, okMsg: string) {
    setSaving(true);
    try {
      await api().put("/llm-config", body);
      toast.success(okMsg);
      await load();
    } catch (e) { catchError(e, "บันทึกไม่สำเร็จ"); } finally { setSaving(false); }
  }

  /* ---- keys ---- */

  async function addKey() {
    const v = newKey.trim();
    if (v.length <= 10) { toast.error("key สั้นเกินไป"); return; }
    await mutate({ add_keys: [{ name: newName.trim() || undefined, value: v }] },
      "เพิ่ม key แล้ว — bot จะหยิบไปใช้ใน ~10 วินาที");
    setNewKey(""); setNewName(""); setAdding(false);
  }

  async function toggleKey(k: MaskedKey) {
    const toEnabled = !k.enabled;
    const enabledAfter = keys.filter((x) => x.enabled && x.sha256 !== k.sha256).length;
    const warn = !toEnabled && enabledAfter === 0
      ? " ⚠️ นี่คือ key ที่เปิดอยู่ตัวสุดท้าย — ปิดแล้ว bot จะ fallback ไปใช้ keys จาก .env"
      : "";
    const ok = await confirm.ask({
      title: toEnabled ? `เปิดใช้ ${k.name}?` : `ปิดใช้ ${k.name}?`,
      message: toEnabled
        ? "key นี้จะถูกหยิบเข้า rotation ใน ~10 วินาที"
        : `bot จะหยุดใช้ key นี้ใน ~10 วินาที${warn}`,
      confirmText: toEnabled ? "เปิดใช้" : "ปิดใช้",
      variant: toEnabled ? "primary" : "danger",
    });
    if (!ok) return;
    await mutate({ set_enabled: [{ sha256: k.sha256, enabled: toEnabled }] },
      toEnabled ? `เปิดใช้ ${k.name} แล้ว` : `ปิดใช้ ${k.name} แล้ว`);
  }

  async function removeKey(k: MaskedKey) {
    const ok = await confirm.ask({
      title: `ลบ ${k.name}?`,
      message: `sha256:${k.sha256} (••••${k.tail}) — ลบออกจาก pool ถาวร bot จะหยุดใช้ใน ~10 วินาที`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    await mutate({ remove_sha256: [k.sha256] }, `ลบ ${k.name} แล้ว`);
  }

  async function saveRename(k: MaskedKey) {
    const name = editName.trim();
    setEditingSha(null);
    if (!name || name === k.name) return;
    await mutate({ rename: [{ sha256: k.sha256, name }] }, `เปลี่ยนชื่อเป็น ${name} แล้ว`);
  }

  /* ---- models ---- */

  async function pickModel(role: ModelRole, value: string) {
    const cur = models[role] ?? "";
    if (value === cur) return;
    const label = ROLE_META[role].label;
    const ok = await confirm.ask({
      title: `เปลี่ยน model — ${label}`,
      message: value
        ? `${cur || `(default: ${ROLE_META[role].placeholder})`} → ${value}\nมีผลใน ~10 วินาที`
        : `กลับไปใช้ default จาก env (${ROLE_META[role].placeholder})`,
      confirmText: "เปลี่ยน",
    });
    if (!ok) return;
    await mutate({ models: { [role]: value } },
      value ? `${label} → ${value}` : `${label} กลับเป็น env default`);
  }

  if (!allowed) {
    return (
      <PageShell title="LLM & API Keys">
        <Card className="p-8 text-center">
          <ShieldAlert className="mx-auto mb-3 text-text-muted" size={28} />
          <p className="text-text-muted">หน้านี้สำหรับ role dev เท่านั้น</p>
        </Card>
      </PageShell>
    );
  }

  const activeCount = keys.filter((k) => k.enabled).length;

  return (
    <PageShell
      title="LLM & API Keys"
      subtitle="ปรับ model และจัดการ Gemini key pool แบบสด — bot อ่าน config ทุก ~10 วินาที ไม่ต้อง restart"
      actions={
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
        </Button>
      }
    >
      {loading ? (
        <div className="flex justify-center py-16"><Loading size={28} /></div>
      ) : (
        <div className="grid gap-4">
          {/* ---- Key pool ---- */}
          <Card className="p-4 sm:p-5">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound size={16} className="text-accent" />
                <h2 className="font-semibold text-text">Gemini key pool</h2>
                <Badge tone={keys.length ? "success" : "neutral"}>
                  {keys.length ? `${activeCount}/${keys.length} เปิดใช้` : "env fallback"}
                </Badge>
              </div>
              <Button variant="secondary" size="sm" onClick={() => {
                setAdding((a) => !a);
                setNewName(`GEMINI_API_KEY_${keys.length + 1}`);
              }}>
                <Plus size={14} /> เพิ่ม key
              </Button>
            </div>
            <p className="mb-4 text-xs text-text-muted">
              bot หมุนใช้เฉพาะ key ที่เปิดอยู่ทุก request · list ว่าง/ปิดหมด = fallback ไป <code>GEMINI_API_KEY_*</code> ใน .env
            </p>

            {adding && (
              <div className="mb-4 grid gap-2 rounded-lg border border-accent/40 bg-accent-soft/40 p-3 sm:grid-cols-[180px_1fr_auto]">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="ชื่อ key"
                  className="font-mono text-sm"
                />
                <Input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="วาง Gemini API key (AIza...)"
                  type="password"
                  autoComplete="off"
                  className="font-mono text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={addKey} disabled={saving || !newKey.trim()}>เพิ่ม</Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>ยกเลิก</Button>
                </div>
              </div>
            )}

            {keys.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted">
                ยังไม่มี key ใน DB — bot ใช้ keys จาก .env อยู่
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {keys.map((k) => (
                  <li key={k.sha256} className={`py-2.5 transition-opacity ${k.enabled ? "" : "opacity-50"}`}>
                    <div className="flex items-center gap-2 sm:gap-3">
                      <ToggleSwitch
                        enabled={k.enabled}
                        onChange={() => toggleKey(k)}
                        disabled={saving}
                        size="sm"
                        ariaLabel={k.enabled ? `ปิดใช้ ${k.name}` : `เปิดใช้ ${k.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        {editingSha === k.sha256 ? (
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={() => saveRename(k)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveRename(k);
                              if (e.key === "Escape") setEditingSha(null);
                            }}
                            className="w-full max-w-xs rounded-md border border-accent bg-surface px-2 py-0.5 font-mono text-sm text-text outline-none"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setEditingSha(k.sha256); setEditName(k.name); }}
                            className="group flex max-w-full items-center gap-1.5 text-left"
                            title="คลิกเพื่อแก้ชื่อ"
                          >
                            <span className="truncate font-mono text-sm font-medium text-text">{k.name}</span>
                            <Pencil size={11} className="shrink-0 text-text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                          </button>
                        )}
                        <code className="block truncate text-[11px] text-text-subtle">
                          sha256:{k.sha256} · ••••{k.tail}
                        </code>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => removeKey(k)} disabled={saving} aria-label={`ลบ ${k.name}`}>
                        <Trash2 size={15} className="text-error" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning-dark">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              keys ถูกเก็บใน MongoDB แบบ plaintext (bot ต้องใช้จริง) — หน้านี้แสดงแค่ hash + 4 ตัวท้าย และจำกัดเฉพาะ dev
            </p>
          </Card>

          {/* ---- Models ---- */}
          <Card className="p-4 sm:p-5">
            <div className="mb-1 flex items-center gap-2">
              <Cpu size={16} className="text-accent" />
              <h2 className="font-semibold text-text">Models ต่อ role</h2>
            </div>
            <p className="mb-4 text-xs text-text-muted">
              เลือกจาก list หรือพิมพ์ชื่อเอง · ว่าง = env default · 429 ที่ model หลัก fallback ข้าม 3.5↔3.1 อัตโนมัติ
            </p>

            <div className="grid gap-3">
              {(Object.keys(ROLE_META) as ModelRole[]).map((role) => {
                const m = ROLE_META[role];
                const Icon = m.icon;
                const opts = (role === "openrouter_search" ? OPENROUTER_MODELS : GEMINI_MODELS)
                  .map((v) => ({ value: v, label: v }));
                const cur = models[role] ?? "";
                return (
                  <div key={role}
                    className="grid gap-2 rounded-lg border border-border px-3.5 py-3 sm:grid-cols-[200px_1fr] sm:items-center sm:gap-3">
                    <div className="flex items-center gap-2.5">
                      <Icon size={16} className="shrink-0 text-text-muted" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text">{m.label}</div>
                        <div className="text-[11px] leading-tight text-text-subtle">{m.desc}</div>
                      </div>
                    </div>
                    <SearchableSelect
                      value={cur}
                      options={opts}
                      placeholder={`default: ${m.placeholder}`}
                      disabled={saving}
                      onPick={(v) => pickModel(role, v)}
                    />
                  </div>
                );
              })}
            </div>
          </Card>

          {meta.updated_at && (
            <p className="text-[11px] text-text-subtle">
              แก้ล่าสุดโดย {meta.updated_by || "-"} · {new Date(meta.updated_at).toLocaleString("th-TH")}
            </p>
          )}
        </div>
      )}
    </PageShell>
  );
}

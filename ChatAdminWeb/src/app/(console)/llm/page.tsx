"use client";
// หน้า /llm — runtime LLM config (dev-only)
// - key pools ×2 (Gemini/OpenRouter): source env|db|single + list toggle/rename/add/remove
// - providers ต่อ role: gemini ↔ openrouter สลับได้ทีละ role หรือทั้งหมด (bot fallback gemini ถ้า OR พัง)
// - models: searchable dropdown (live list จาก provider API) — openrouter_search บังคับ :online
// - ไม่มีปุ่ม save — ทุก mutation confirm popup แล้วบันทึกทันที (bot อ่าน config ทุก ~10s)
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
  ScanSearch, Globe, ShieldAlert, Search, Check, ChevronDown, X, Pencil, Sparkles,
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

type KeyPool = "gemini" | "openrouter";
type KeySource = "env" | "db" | "single";
type Provider = "gemini" | "openrouter";

interface LlmConfigResponse {
  ok: boolean;
  keys: MaskedKey[];
  openrouter_keys: MaskedKey[];
  key_source: Record<KeyPool, KeySource>;
  single_keys: Record<KeyPool, { sha256: string; tail: string } | null>;
  providers: Partial<Record<string, Provider>>;
  models: Partial<Record<string, string>>;
  model_roles: string[];
  updated_by?: string;
  updated_at?: string;
}

interface ModelsResponse {
  ok: boolean;
  gemini: string[];
  openrouter: string[];
  live: boolean;
}

const ROLE_META: Record<string, { label: string; desc: string; icon: typeof Cpu; placeholder: string }> = {
  chat: {
    label: "Chat",
    desc: "ตอบแชทลูกค้า",
    icon: MessageSquare,
    placeholder: "gemini-3.5-flash-lite",
  },
  vision: {
    label: "Vision",
    desc: "อ่านรูป/วิดีโอลูกค้า",
    icon: Eye,
    placeholder: "gemini-3.1-flash-lite",
  },
  intent: {
    label: "Intent",
    desc: "จำแนกเจตนาก่อน route",
    icon: ScanSearch,
    placeholder: "gemini-3.1-flash-lite",
  },
  openrouter_search: {
    label: "Web Search",
    desc: "OpenRouter · ต้องลงท้าย :online",
    icon: Globe,
    placeholder: "google/gemini-2.5-flash:online",
  },
};
const roleMeta = (r: string) =>
  ROLE_META[r] ?? { label: r, desc: "role เพิ่มเติมจาก config", icon: Sparkles, placeholder: "" };

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
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left font-mono text-[13px] text-text transition-colors hover:border-accent/50 disabled:opacity-50"
      >
        <span className="truncate">{value || <span className="text-text-subtle">{placeholder}</span>}</span>
        <ChevronDown size={13} className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
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
              sub="env default"
              onClick={() => { onPick(""); setOpen(false); }}
            />
            {filtered.map((o) => (
              <OptionRow key={o.value} active={o.value === value} label={o.value} sub={o.hint}
                onClick={() => { onPick(o.value); setOpen(false); }} />
            ))}
            {custom && (
              <OptionRow label={`ใช้ "${custom}"`} sub="custom" accent
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
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2">
      <span className="w-4 shrink-0">{active && <Check size={14} className="text-accent" />}</span>
      <span className={`min-w-0 flex-1 truncate font-mono text-[13px] ${accent ? "text-accent" : "text-text"}`}>{label}</span>
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
  const [orKeys, setOrKeys] = useState<MaskedKey[]>([]);
  const [keySource, setKeySource] = useState<Record<KeyPool, KeySource>>({ gemini: "db", openrouter: "db" });
  const [singleKeys, setSingleKeys] = useState<LlmConfigResponse["single_keys"]>({ gemini: null, openrouter: null });
  const [providers, setProviders] = useState<Partial<Record<string, Provider>>>({});
  const [models, setModels] = useState<Partial<Record<string, string>>>({});
  const [roles, setRoles] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ updated_by?: string; updated_at?: string }>({});
  const [saving, setSaving] = useState(false);
  const [avail, setAvail] = useState<ModelsResponse>({ ok: false, gemini: [], openrouter: [], live: false });

  const allowed = canEditPage(user, "llm");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<LlmConfigResponse>("/llm-config");
      setKeys(r.data.keys ?? []);
      setOrKeys(r.data.openrouter_keys ?? []);
      setKeySource(r.data.key_source ?? { gemini: "db", openrouter: "db" });
      setSingleKeys(r.data.single_keys ?? { gemini: null, openrouter: null });
      setProviders(r.data.providers ?? {});
      setModels(r.data.models ?? {});
      setRoles(r.data.model_roles ?? Object.keys(ROLE_META));
      setMeta({ updated_by: r.data.updated_by, updated_at: r.data.updated_at });
    } catch (e) {
      catchError(e, "โหลด config ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  const loadModels = useCallback(async () => {
    try {
      const r = await api().get<ModelsResponse>("/llm-config/models");
      setAvail(r.data);
    } catch { /* dropdown จะใช้ custom input ได้อยู่ */ }
  }, []);

  useEffect(() => { if (allowed) { load(); loadModels(); } }, [allowed, load, loadModels]);

  async function mutate(body: Record<string, unknown>, okMsg: string) {
    setSaving(true);
    try {
      await api().put("/llm-config", body);
      toast.success(okMsg);
      await load();
    } catch (e) { catchError(e, "บันทึกไม่สำเร็จ"); } finally { setSaving(false); }
  }

  /* ---- models ---- */

  async function pickModel(role: string, value: string) {
    const cur = models[role] ?? "";
    if (value === cur) return;
    const label = roleMeta(role).label;
    const ok = await confirm.ask({
      title: `เปลี่ยน model — ${label}`,
      message: value
        ? `${cur || `(default: ${roleMeta(role).placeholder})`} → ${value}\nมีผลใน ~10 วินาที`
        : `กลับไปใช้ default จาก env (${roleMeta(role).placeholder})`,
      confirmText: "เปลี่ยน",
    });
    if (!ok) return;
    await mutate({ models: { [role]: value } },
      value ? `${label} → ${value}` : `${label} กลับเป็น env default`);
  }

  async function pickProvider(role: string, p: Provider) {
    const cur = providers[role] ?? "gemini";
    if (p === cur) return;
    const ok = await confirm.ask({
      title: `สลับ provider — ${roleMeta(role).label}`,
      message: p === "openrouter"
        ? `role นี้จะ call ผ่าน OpenRouter (model เดิม map เป็น google/…) — OpenRouter พัง → fallback Gemini อัตโนมัติ`
        : "role นี้จะกลับไป call Gemini โดยตรง",
      confirmText: "สลับ",
      variant: p === "openrouter" ? "primary" : "primary",
    });
    if (!ok) return;
    await mutate({ providers: { [role]: p } },
      `${roleMeta(role).label} → ${p === "openrouter" ? "OpenRouter" : "Gemini"}`);
  }

  async function setAllProviders(p: Provider) {
    const ok = await confirm.ask({
      title: p === "openrouter" ? "สลับทุก role ไป OpenRouter?" : "สลับทุก role กลับ Gemini?",
      message: p === "openrouter"
        ? "chat / vision / intent ทั้งหมดจะ call ผ่าน OpenRouter ด้วย model เดิม — พัง → fallback Gemini ต่อ role"
        : "ทุก role กลับไป call Gemini โดยตรง",
      confirmText: "สลับทั้งหมด",
      variant: p === "openrouter" ? "danger" : "primary",
    });
    if (!ok) return;
    await mutate({ set_all_providers: p },
      p === "openrouter" ? "ทุก role → OpenRouter" : "ทุก role → Gemini");
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

  const allOpenRouter = ["chat", "vision", "intent"].every(
    (r) => (providers[r] ?? "gemini") === "openrouter"
  );

  return (
    <PageShell
      title="LLM & API Keys"
      subtitle="สลับ provider/key/model สด — bot อ่าน config ทุก ~10 วินาที"
      actions={
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
        </Button>
      }
    >
      {loading ? (
        <div className="flex justify-center py-16"><Loading size={28} /></div>
      ) : (
        <div className="grid gap-3">
          {/* ---- master provider strip ---- */}
          <Card className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <Cpu size={15} className="text-accent" />
              <span className="font-medium text-text">Provider หลัก</span>
              <span className="text-xs text-text-muted">call LLM ผ่าน Gemini โดยตรง หรือผ่าน OpenRouter (model เดิม)</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={allOpenRouter ? "warning" : "success"}>
                {allOpenRouter ? "OpenRouter ทั้งหมด" : "Gemini"}
              </Badge>
              <ToggleSwitch
                enabled={allOpenRouter}
                onChange={() => setAllProviders(allOpenRouter ? "gemini" : "openrouter")}
                disabled={saving}
                ariaLabel="สลับ provider ทั้งหมด"
              />
            </div>
          </Card>

          {/* ---- key pools — 2 cols บน lg ---- */}
          <div className="grid gap-3 lg:grid-cols-2">
            <KeyPoolCard
              title="Gemini keys"
              icon={KeyRound}
              pool="gemini"
              prefix="GEMINI_API_KEY"
              keys={keys}
              source={keySource.gemini}
              single={singleKeys.gemini}
              saving={saving}
              mutate={mutate}
              envHint="GEMINI_API_KEY_*"
              keyPlaceholder="AIza..."
            />
            <KeyPoolCard
              title="OpenRouter keys"
              icon={Globe}
              pool="openrouter"
              prefix="OPENROUTER_API_KEY"
              keys={orKeys}
              source={keySource.openrouter}
              single={singleKeys.openrouter}
              saving={saving}
              mutate={mutate}
              envHint="OPENROUTER_API_KEY"
              keyPlaceholder="sk-or-..."
            />
          </div>

          {/* ---- models + provider per role ---- */}
          <Card className="p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Cpu size={15} className="text-accent" />
                <h2 className="text-sm font-semibold text-text">Models ต่อ role</h2>
              </div>
              {avail.live === false && avail.gemini.length > 0 && (
                <span className="text-[11px] text-text-subtle">list แบบ fallback (provider API ไม่ตอบ)</span>
              )}
            </div>
            <p className="mb-3 text-[11px] text-text-muted">
              G = Gemini โดยตรง · OR = ผ่าน OpenRouter (model เดิม, พัง→fallback Gemini) · ว่าง = env default
            </p>

            <div className="grid gap-2">
              {roles.map((role) => {
                const m = roleMeta(role);
                const Icon = m.icon;
                const cur = models[role] ?? "";
                const isSearch = role === "openrouter_search";
                const provider = providers[role] ?? "gemini";
                const opts = isSearch
                  ? avail.openrouter.map((v) => ({ value: `${v}:online`, label: `${v}:online` }))
                  : (provider === "openrouter" ? avail.openrouter : avail.gemini)
                      .map((v) => ({ value: v, label: v }));
                return (
                  <div key={role}
                    className="grid items-center gap-2 rounded-md border border-border px-3 py-2 sm:grid-cols-[160px_72px_1fr]">
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon size={14} className="shrink-0 text-text-muted" />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-text">{m.label}</div>
                        <div className="truncate text-[10px] text-text-subtle">{m.desc}</div>
                      </div>
                    </div>
                    <div>
                      {isSearch ? (
                        <span className="text-[10px] font-mono text-text-subtle">OR only</span>
                      ) : (
                        <div className="inline-flex overflow-hidden rounded-md border border-border text-[10px] font-semibold">
                          {(["gemini", "openrouter"] as Provider[]).map((p) => (
                            <button
                              key={p}
                              type="button"
                              disabled={saving}
                              onClick={() => pickProvider(role, p)}
                              className={`px-2 py-1 transition-colors ${
                                provider === p
                                  ? "bg-accent text-white"
                                  : "bg-surface text-text-muted hover:bg-surface-2"
                              }`}
                            >
                              {p === "gemini" ? "G" : "OR"}
                            </button>
                          ))}
                        </div>
                      )}
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

/* ------------------------------------------------------------------ */
/* KeyPoolCard — source env|db|single + list จัดการ key 1 pool          */
/* ------------------------------------------------------------------ */

const SOURCE_LABEL: Record<KeySource, string> = {
  env: ".env",
  db: "MongoDB",
  single: "key เดียว",
};

function KeyPoolCard({
  title, icon: Icon, pool, prefix, keys, source, single, saving, mutate, envHint, keyPlaceholder,
}: {
  title: string;
  icon: typeof KeyRound;
  pool: KeyPool;
  prefix: string;
  keys: MaskedKey[];
  source: KeySource;
  single: { sha256: string; tail: string } | null;
  saving: boolean;
  mutate: (body: Record<string, unknown>, okMsg: string) => Promise<void>;
  envHint: string;
  keyPlaceholder: string;
}) {
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [editingSha, setEditingSha] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [singleDraft, setSingleDraft] = useState("");
  const [editingSingle, setEditingSingle] = useState(false);

  const activeCount = keys.filter((k) => k.enabled).length;

  async function changeSource(s: KeySource) {
    if (s === source) return;
    const ok = await confirm.ask({
      title: `เปลี่ยนแหล่ง ${title} → ${SOURCE_LABEL[s]}?`,
      message:
        s === "env" ? `bot จะใช้ ${envHint} จาก .env เท่านั้น (list ใน DB ถูกข้าม)`
        : s === "db" ? "bot จะหมุนใช้ key ที่เปิดอยู่ใน list นี้"
        : `bot จะใช้ key เดียวที่ตั้งไว้บน MongoDB (${prefix})`,
      confirmText: "เปลี่ยน",
      variant: s === "env" ? "primary" : "primary",
    });
    if (!ok) return;
    await mutate({ set_source: { pool, source: s } }, `${title} → ${SOURCE_LABEL[s]}`);
  }

  async function addKey() {
    const v = newKey.trim();
    if (v.length <= 10) { toast.error("key สั้นเกินไป"); return; }
    await mutate(
      { pool, add_keys: [{ name: newName.trim() || undefined, value: v }] },
      "เพิ่ม key แล้ว — bot จะหยิบไปใช้ใน ~10 วินาที"
    );
    setNewKey(""); setNewName(""); setAdding(false);
  }

  async function toggleKey(k: MaskedKey) {
    const toEnabled = !k.enabled;
    const enabledAfter = keys.filter((x) => x.enabled && x.sha256 !== k.sha256).length;
    const warn = !toEnabled && enabledAfter === 0
      ? ` ⚠️ key เปิดอยู่ตัวสุดท้าย — ปิดแล้ว bot จะ fallback ไป ${envHint}`
      : "";
    const ok = await confirm.ask({
      title: toEnabled ? `เปิดใช้ ${k.name}?` : `ปิดใช้ ${k.name}?`,
      message: `bot จะ${toEnabled ? "หยิบ key นี้เข้า rotation" : "หยุดใช้ key นี้"}ใน ~10 วินาที${warn}`,
      confirmText: toEnabled ? "เปิดใช้" : "ปิดใช้",
      variant: toEnabled ? "primary" : "danger",
    });
    if (!ok) return;
    await mutate({ pool, set_enabled: [{ sha256: k.sha256, enabled: toEnabled }] },
      toEnabled ? `เปิดใช้ ${k.name} แล้ว` : `ปิดใช้ ${k.name} แล้ว`);
  }

  async function removeKey(k: MaskedKey) {
    const ok = await confirm.ask({
      title: `ลบ ${k.name}?`,
      message: `sha256:${k.sha256} (••••${k.tail}) — ลบออกจาก pool ถาวร`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    await mutate({ pool, remove_sha256: [k.sha256] }, `ลบ ${k.name} แล้ว`);
  }

  async function saveRename(k: MaskedKey) {
    const name = editName.trim();
    setEditingSha(null);
    if (!name || name === k.name) return;
    await mutate({ pool, rename: [{ sha256: k.sha256, name }] }, `เปลี่ยนชื่อเป็น ${name} แล้ว`);
  }

  async function saveSingle() {
    const v = singleDraft.trim();
    if (v.length <= 10) { toast.error("key สั้นเกินไป"); return; }
    const ok = await confirm.ask({
      title: `ตั้ง ${prefix} บน MongoDB?`,
      message: `source "key เดียว" จะใช้ key นี้ — เก็บ plaintext ใน DB`,
      confirmText: "บันทึก",
    });
    if (!ok) return;
    await mutate({ set_single: { pool, value: v } }, `บันทึก ${prefix} แล้ว`);
    setSingleDraft(""); setEditingSingle(false);
  }

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={15} className="shrink-0 text-accent" />
          <h2 className="truncate text-sm font-semibold text-text">{title}</h2>
          {source === "db" && (
            <Badge tone={keys.length ? "success" : "neutral"}>
              {keys.length ? `${activeCount}/${keys.length} เปิด` : "ว่าง"}
            </Badge>
          )}
        </div>
        {/* source segmented: env | MongoDB | key เดียว */}
        <div className="inline-flex overflow-hidden rounded-md border border-border text-[10px] font-semibold">
          {(["env", "db", "single"] as KeySource[]).map((s) => (
            <button
              key={s}
              type="button"
              disabled={saving}
              onClick={() => changeSource(s)}
              className={`px-2 py-1 transition-colors ${
                source === s ? "bg-accent text-white" : "bg-surface text-text-muted hover:bg-surface-2"
              }`}
            >
              {SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {source === "env" && (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
          ใช้ <code>{envHint}</code> จาก .env — list ใน DB ถูกข้าม
        </div>
      )}

      {source === "single" && (
        <div className="rounded-md border border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <code className="text-[13px] font-mono font-medium text-text">{prefix}</code>
              <code className="block truncate text-[11px] text-text-subtle">
                {single ? `sha256:${single.sha256} · ••••${single.tail}` : "ยังไม่ได้ตั้ง key"}
              </code>
            </div>
            <Button variant="secondary" size="sm" onClick={() => { setEditingSingle((e) => !e); setSingleDraft(""); }}>
              {editingSingle ? "ยกเลิก" : single ? "เปลี่ยน key" : "ตั้ง key"}
            </Button>
          </div>
          {editingSingle && (
            <div className="mt-2 flex gap-2">
              <Input
                value={singleDraft}
                onChange={(e) => setSingleDraft(e.target.value)}
                placeholder={keyPlaceholder}
                type="password"
                autoComplete="off"
                className="flex-1 font-mono text-sm"
              />
              <Button size="sm" onClick={saveSingle} disabled={saving || !singleDraft.trim()}>บันทึก</Button>
            </div>
          )}
        </div>
      )}

      {source === "db" && (
        <>
          {adding && (
            <div className="mb-3 grid gap-2 rounded-md border border-accent/40 bg-accent-soft/40 p-2.5 sm:grid-cols-[150px_1fr_auto]">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="ชื่อ key"
                className="font-mono text-[13px]"
              />
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={keyPlaceholder}
                type="password"
                autoComplete="off"
                className="font-mono text-[13px]"
              />
              <div className="flex gap-1.5">
                <Button size="sm" onClick={addKey} disabled={saving || !newKey.trim()}>เพิ่ม</Button>
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>ยกเลิก</Button>
              </div>
            </div>
          )}

          {keys.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-text-muted">
              ยังไม่มี key — fallback ไป {envHint} ใน .env
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {keys.map((k) => (
                <li key={k.sha256} className={`py-2 transition-opacity ${k.enabled ? "" : "opacity-50"}`}>
                  <div className="flex items-center gap-2">
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
                          className="w-full max-w-[200px] rounded border border-accent bg-surface px-1.5 py-0.5 font-mono text-[13px] text-text outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setEditingSha(k.sha256); setEditName(k.name); }}
                          className="group flex max-w-full items-center gap-1.5 text-left"
                          title="คลิกเพื่อแก้ชื่อ"
                        >
                          <span className="truncate font-mono text-[13px] font-medium text-text">{k.name}</span>
                          <Pencil size={10} className="shrink-0 text-text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                      )}
                      <code className="block truncate text-[10px] text-text-subtle">
                        sha256:{k.sha256} · ••••{k.tail}
                      </code>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => removeKey(k)} disabled={saving} aria-label={`ลบ ${k.name}`}>
                      <Trash2 size={14} className="text-error" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="flex items-start gap-1 text-[10px] leading-relaxed text-warning-dark">
              <ShieldAlert size={11} className="mt-0.5 shrink-0" />
              เก็บ plaintext ใน MongoDB — แสดงแค่ hash+ท้าย
            </p>
            <Button variant="secondary" size="sm" onClick={() => {
              setAdding((a) => !a);
              setNewName(`${prefix}_${keys.length + 1}`);
            }}>
              <Plus size={13} /> เพิ่ม key
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

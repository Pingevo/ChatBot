"use client";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import {
  KeyRound, Cpu, Plus, Trash2, RefreshCw, Eye, MessageSquare,
  ScanSearch, Globe, ShieldAlert,
} from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canEditPage } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";

interface MaskedKey { index: number; sha256: string; tail: string }

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

export default function LlmConfigPage() {
  const { user } = useAuth();
  const { catchError } = useToastError();
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<MaskedKey[]>([]);
  const [models, setModels] = useState<Partial<Record<ModelRole, string>>>({});
  const [draftModels, setDraftModels] = useState<Partial<Record<ModelRole, string>>>({});
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState<{ updated_by?: string; updated_at?: string }>({});

  const allowed = canEditPage(user, "llm");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<LlmConfigResponse>("/llm-config");
      setKeys(r.data.keys ?? []);
      setModels(r.data.models ?? {});
      setDraftModels(r.data.models ?? {});
      setMeta({ updated_by: r.data.updated_by, updated_at: r.data.updated_at });
    } catch (e) {
      catchError(e, "โหลด config ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  async function addKey() {
    const k = newKey.trim();
    if (k.length <= 10) { toast.error("key สั้นเกินไป"); return; }
    setSaving(true);
    try {
      await api().put("/llm-config", { add_keys: [k] });
      setNewKey("");
      toast.success("เพิ่ม key แล้ว — bot จะหยิบไปใช้ใน ~10 วินาที");
      await load();
    } catch (e) { catchError(e, "บันทึกไม่สำเร็จ"); } finally { setSaving(false); }
  }

  async function removeKey(k: MaskedKey) {
    const ok = await confirm.ask({
      title: "ลบ key นี้?",
      message: `sha256:${k.sha256} (••••${k.tail}) — bot จะหยุดใช้ key นี้ใน ~10 วินาที`,
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await api().put("/llm-config", { remove_sha256: [k.sha256] });
      toast.success("ลบ key แล้ว");
      await load();
    } catch (e) { catchError(e, "บันทึกไม่สำเร็จ"); } finally { setSaving(false); }
  }

  async function saveModels() {
    setSaving(true);
    try {
      await api().put("/llm-config", { models: draftModels });
      toast.success("บันทึก models แล้ว — มีผลใน ~10 วินาที");
      await load();
    } catch (e) { catchError(e, "บันทึกไม่สำเร็จ"); } finally { setSaving(false); }
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

  const modelsDirty = JSON.stringify(models) !== JSON.stringify(draftModels);

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
        <div className="grid gap-4 max-w-3xl">
          {/* ---- Key pool ---- */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <KeyRound size={16} className="text-accent" />
                <h2 className="font-semibold text-text">Gemini key pool</h2>
                <Badge tone={keys.length ? "success" : "neutral"}>
                  {keys.length ? `${keys.length} keys — round-robin` : "env fallback"}
                </Badge>
              </div>
            </div>
            <p className="text-xs text-text-muted mb-4">
              bot หมุนใช้ keys เหล่านี้ทุก request · ถ้า list ว่างจะใช้ <code>GEMINI_API_KEY_1..n</code> จาก .env แทน
            </p>

            {keys.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-text-muted mb-4">
                ยังไม่มี key ใน DB — bot ใช้ keys จาก .env อยู่
              </div>
            ) : (
              <ul className="divide-y divide-border mb-4">
                {keys.map((k) => (
                  <li key={k.sha256} className="flex items-center gap-3 py-2.5">
                    <span className="w-7 text-xs text-text-subtle font-mono">#{k.index}</span>
                    <code className="flex-1 text-sm font-mono text-text">
                      sha256:{k.sha256} <span className="text-text-muted">••••{k.tail}</span>
                    </code>
                    <Button variant="ghost" size="icon" onClick={() => removeKey(k)} disabled={saving} aria-label="ลบ key">
                      <Trash2 size={15} className="text-error" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-2">
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="วาง Gemini API key ใหม่ (AIza...)"
                type="password"
                autoComplete="off"
                className="flex-1"
              />
              <Button onClick={addKey} disabled={saving || !newKey.trim()}>
                <Plus size={15} /> เพิ่ม key
              </Button>
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning-dark">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              keys ถูกเก็บใน MongoDB แบบ plaintext (bot ต้องใช้จริง) — หน้านี้แสดงแค่ hash + 4 ตัวท้าย และจำกัดเฉพาะ dev
            </p>
          </Card>

          {/* ---- Models ---- */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Cpu size={16} className="text-accent" />
                <h2 className="font-semibold text-text">Models ต่อ role</h2>
              </div>
              <Button size="sm" onClick={saveModels} disabled={saving || !modelsDirty}>
                บันทึก models
              </Button>
            </div>
            <p className="text-xs text-text-muted mb-4">
              เว้นว่าง = ใช้ค่า default จาก env · 429 ที่ model หลักจะ fallback ข้าม 3.5↔3.1 อัตโนมัติ
            </p>

            <div className="grid gap-3">
              {(["chat", "vision", "intent", "openrouter_search"] as ModelRole[]).map((role) => {
                const meta = ROLE_META[role];
                const Icon = meta.icon;
                return (
                  <div key={role} className="flex items-center gap-3 rounded-lg border border-border px-3.5 py-3">
                    <Icon size={16} className="shrink-0 text-text-muted" />
                    <div className="w-44 shrink-0">
                      <div className="text-sm font-medium text-text">{meta.label}</div>
                      <div className="text-[11px] text-text-subtle leading-tight">{meta.desc}</div>
                    </div>
                    <Input
                      value={draftModels[role] ?? ""}
                      onChange={(e) => setDraftModels((p) => ({ ...p, [role]: e.target.value }))}
                      placeholder={meta.placeholder}
                      className="flex-1 font-mono text-sm"
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

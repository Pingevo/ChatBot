"use client";
// หน้าจัดการ roles + permission matrix — dev only (hardcode ทั้งฝั่ง client และ API)
// matrix ถูกเก็บใน system_configs.role_permissions — server cache 30s
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Loading } from "@/components/ui/Loading";
import { PageShell } from "@/components/ui/PageShell";
import { RefreshCw, ShieldAlert, UserPlus, Trash2, Save } from "lucide-react";
import { useAuth } from "@/lib/authStore";
import { canManageRoles, loadPermissions } from "@/lib/roles";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";
import { PAGES, type AccessLevel, type PageDef } from "@/lib/pages";

interface RoleDef { key: string; label: string; builtin: boolean }

interface PermissionsResponse {
  ok: boolean;
  pages: PageDef[];
  roles: RoleDef[];
  permissions: Record<string, Record<string, AccessLevel>>;
}

const LEVEL_TONE: Record<AccessLevel, string> = {
  none: "text-text-subtle",
  read: "text-warning-dark",
  edit: "text-success",
};

export default function RolesPage() {
  const { user } = useAuth();
  const { catchError } = useToastError();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [matrix, setMatrix] = useState<Record<string, Record<string, AccessLevel>>>({});
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const allowed = canManageRoles(user);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api().get<PermissionsResponse>("/permissions");
      setRoles(r.data.roles ?? []);
      setMatrix(r.data.permissions ?? {});
    } catch (e) {
      catchError(e, "โหลดสิทธิ์ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, [catchError]);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  function setLevel(page: string, role: string, lvl: AccessLevel) {
    setMatrix((m) => ({ ...m, [page]: { ...m[page], [role]: lvl } }));
  }

  function levelOf(page: string, role: RoleDef): AccessLevel {
    if (role.key === "dev") return "edit"; // dev ได้ edit เสมอ (server บังคับ)
    return matrix[page]?.[role.key] ?? "none";
  }

  async function save() {
    setSaving(true);
    try {
      await api().put("/permissions", { roles, permissions: matrix });
      toast.success("บันทึกสิทธิ์แล้ว — มีผลภายใน ~30 วินาที");
      await loadPermissions(); // รีเฟรช client matrix ของตัวเอง
      await load();
    } catch (e) { catchError(e, "บันทึกไม่สำเร็จ"); } finally { setSaving(false); }
  }

  function addRole() {
    const key = newKey.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,30}$/.test(key)) {
      toast.error("role key ต้องเป็น a-z 0-9 _ - ยาว 2-30 ตัว"); return;
    }
    if (roles.some((r) => r.key === key)) { toast.error("role นี้มีอยู่แล้ว"); return; }
    setRoles((rs) => [...rs, { key, label: newLabel.trim() || key, builtin: false }]);
    setNewKey(""); setNewLabel("");
    toast.success(`เพิ่ม role '${key}' — กดบันทึกเพื่อยืนยัน`);
  }

  async function removeRole(role: RoleDef) {
    if (role.builtin) return;
    const ok = await confirm.ask({
      title: `ลบ role '${role.key}'?`,
      message: "user ที่ถือ role นี้จะเข้าใช้ไม่ได้ทุกหน้า (deny-by-default)",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    setRoles((rs) => rs.filter((r) => r.key !== role.key));
    setMatrix((m) => {
      const out = { ...m };
      for (const p of Object.keys(out)) {
        const { [role.key]: _dropped, ...rest } = out[p];
        out[p] = rest;
      }
      return out;
    });
    toast.success(`ลบ role '${role.key}' แล้ว — กดบันทึกเพื่อยืนยัน`);
  }

  if (!allowed) {
    return (
      <PageShell title="สิทธิ์การใช้งาน">
        <Card className="p-8 text-center">
          <ShieldAlert className="mx-auto mb-3 text-text-muted" size={28} />
          <p className="text-text-muted">หน้านี้สำหรับ role dev เท่านั้น</p>
        </Card>
      </PageShell>
    );
  }

  const groups = [...new Set(PAGES.map((p) => p.group))];

  return (
    <PageShell
      title="สิทธิ์การใช้งาน"
      subtitle="กำหนดว่า role ไหนเข้าหน้าไหนได้ — none = มองไม่เห็น · read = ดูอย่างเดียว · edit = แก้ไขได้"
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> รีเฟรช
          </Button>
          <Button size="sm" onClick={save} disabled={saving || loading}>
            <Save size={14} /> บันทึก
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="flex justify-center py-16"><Loading size={28} /></div>
      ) : (
        <div className="grid gap-4">
          {/* ---- เพิ่ม role ---- */}
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <UserPlus size={16} className="text-accent" />
              <h2 className="font-semibold text-text">Roles</h2>
            </div>
            <div className="flex flex-wrap gap-2 mb-4">
              {roles.map((r) => (
                <span key={r.key} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm">
                  <code className="font-mono font-medium text-text">{r.key}</code>
                  {r.label !== r.key && <span className="text-text-muted text-xs">{r.label}</span>}
                  {r.builtin ? (
                    <Badge tone="neutral">builtin</Badge>
                  ) : (
                    <button onClick={() => removeRole(r)} className="text-error hover:opacity-70" aria-label={`ลบ ${r.key}`}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="flex gap-2 max-w-lg">
              <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="key เช่น viewer" className="w-40 font-mono" />
              <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="ชื่อแสดง (optional)" className="flex-1" />
              <Button variant="secondary" onClick={addRole}><UserPlus size={15} /> เพิ่ม</Button>
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning-dark">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              role dev และ builtin roles ลบไม่ได้ · หน้านี้ dev เข้าได้เสมอ (hardcode กันล็อกตัวเอง) ·
              การ assign role ให้ user ทำใน collection admins
            </p>
          </Card>

          {/* ---- Matrix ---- */}
          <Card className="p-5 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-4 font-medium text-text-muted">หน้า</th>
                  {roles.map((r) => (
                    <th key={r.key} className="py-2 px-3 font-medium text-text text-center">
                      <code className="font-mono">{r.key}</code>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows
                    key={g}
                    group={g}
                    roles={roles}
                    levelOf={levelOf}
                    setLevel={setLevel}
                  />
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-text-subtle">
              หน้าใหม่ที่เพิ่มใน page registry จะขึ้นที่นี่อัตโนมัติ — ค่าเริ่มต้นของหน้าใหม่คือ dev:edit, อื่นๆ:none
            </p>
          </Card>
        </div>
      )}
    </PageShell>
  );
}

function GroupRows({
  group, roles, levelOf, setLevel,
}: {
  group: string;
  roles: RoleDef[];
  levelOf: (page: string, role: RoleDef) => AccessLevel;
  setLevel: (page: string, role: string, lvl: AccessLevel) => void;
}) {
  const pages = PAGES.filter((p) => p.group === group);
  if (!pages.length) return null;
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
          {group}
        </td>
      </tr>
      {pages.map((p) => (
        <tr key={p.key} className="border-b border-border/50 last:border-0">
          <td className="py-2 pr-4">
            <div className="text-text">{p.label}</div>
            <code className="text-[11px] text-text-subtle font-mono">{p.key}</code>
          </td>
          {roles.map((r) => {
            const lvl = levelOf(p.key, r);
            return (
              <td key={r.key} className="py-2 px-3 text-center">
                {r.key === "dev" ? (
                  <span className={`text-xs font-medium ${LEVEL_TONE.edit}`}>edit</span>
                ) : (
                  <select
                    value={lvl}
                    onChange={(e) => setLevel(p.key, r.key, e.target.value as AccessLevel)}
                    className={`rounded-md border border-border bg-surface px-1.5 py-1 text-xs font-medium ${LEVEL_TONE[lvl]}`}
                  >
                    <option value="none">none</option>
                    <option value="read">read</option>
                    <option value="edit">edit</option>
                  </select>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

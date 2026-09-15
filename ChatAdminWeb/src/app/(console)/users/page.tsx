"use client";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/authStore";
import { canAccessPage } from "@/lib/roles";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageShell } from "@/components/ui/PageShell";
import { Power, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { api } from "@/lib/apiClient";
import { toast, useToastError } from "@/components/ui/Toast";
import { confirm } from "@/components/ui/ConfirmDialog";

interface UserRow {
  admin_id: string;
  email: string;
  username: string;
  name: string;
  role: "superadmin" | "admin" | "dev";
  channels_access: string[];
  active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export default function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canEditFlag, setCanEditFlag] = useState(false);
  const { catchError } = useToastError();

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api().get<{ users: UserRow[]; canEdit: boolean }>("/users/list");
      setUsers(r.data.users);
      setCanEditFlag(r.data.canEdit);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "โหลดรายการไม่สำเร็จ";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canAccessPage(user, "user")) loadUsers();
    else setLoading(false);
  }, [user, loadUsers]);

  async function handleToggleActive(u: UserRow) {
    const newState = !u.active;
    const ok = await confirm.ask({
      title: newState ? "เปิดใช้งานผู้ใช้?" : "ปิดใช้งานผู้ใช้?",
      message: `"${u.name || u.username}" — ${newState ? "จะสามารถเข้าสู่ระบบได้" : "จะไม่สามารถเข้าสู่ระบบได้"}`,
      confirmText: newState ? "เปิดใช้งาน" : "ปิดใช้งาน",
      variant: newState ? "primary" : "danger",
    });
    if (!ok) return;
    setError(null);
    try {
      await api().patch(`/users/${u.admin_id}`, { active: newState });
      await loadUsers();
      toast.success(`${newState ? "เปิด" : "ปิด"} "${u.name || u.username}" แล้ว`);
    } catch (e: unknown) {
      catchError(e, "เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  // Access control
  if (!canAccessPage(user, "user")) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Users}
          title="ไม่มีสิทธิ์เข้าถึง"
          description="หน้านี้สำหรับ superadmin และ dev เท่านั้น"
        />
      </div>
    );
  }

  const roleTone = (r: string) => r === "superadmin" ? "deep" : r === "dev" ? "brand" : "neutral";

  return (
    <PageShell
      icon={Users}
      title="จัดการผู้ใช้"
      helpHref="/help#users"
      subtitle={canEditFlag ? "เปิด/ปิดสถานะผู้ใช้ — ผู้ใช้ใหม่เข้าผ่าน SSO อัตโนมัติ" : "ดูรายการผู้ใช้ (read-only)"}
      contentClassName="p-4 sm:p-6 space-y-4 sm:space-y-6"
    >
      {error && (
        <div className="text-sm text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">{error}</div>
      )}

      {/* Info banner */}
      <div className="bg-pale-sky-soft rounded-lg px-4 py-3 text-sm text-text-muted">
        ผู้ใช้ใหม่ login ผ่าน SSO แล้วจะถูกสร้างเป็น <Badge tone="neutral">admin</Badge> อัตโนมัติ
        — หากต้องการเปลี่ยน role เป็น superadmin หรือ dev ให้แก้ใน collection <code className="text-brand">admins</code> โดยตรง
      </div>

      {/* User list — card บนจอ <lg, ตารางบนจอ lg+ */}
      {loading ? (
        <div className="flex justify-center py-12"><Loading size={24} /></div>
      ) : users.length === 0 ? (
        <EmptyState icon={Users} title="ยังไม่มีผู้ใช้" description="ผู้ใช้จะเข้ามาเองผ่าน SSO" />
      ) : (
        <>
          {/* ── Mobile/Tablet (<lg): card list ── */}
          <ul className="lg:hidden space-y-3">
            {users.map((u) => (
              <li key={u.admin_id} className="bg-surface rounded-xl border border-border p-4">
                {/* Header: avatar + ชื่อ + สถานะ */}
                <div className="flex items-start gap-3">
                  <Avatar name={u.name || u.username} size={40} className="flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-text truncate">{u.name || u.username}</div>
                    <div className="text-xs text-text-subtle truncate">@{u.username}</div>
                  </div>
                  {u.active ? <Badge tone="brand">ใช้งาน</Badge> : <Badge tone="red">ปิดใช้งาน</Badge>}
                </div>

                {/* รายละเอียด */}
                <dl className="mt-3 space-y-1.5 text-xs">
                  <div className="flex gap-2">
                    <dt className="w-28 flex-shrink-0 text-text-muted">อีเมล</dt>
                    <dd className="min-w-0 text-text break-all">{u.email}</dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <dt className="w-28 flex-shrink-0 text-text-muted">บทบาท</dt>
                    <dd><Badge tone={roleTone(u.role)}>{u.role}</Badge></dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-28 flex-shrink-0 text-text-muted">เข้าระบบล่าสุด</dt>
                    <dd className="min-w-0 text-text-muted">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString("th-TH") : "—"}
                    </dd>
                  </div>
                </dl>

                {/* การจัดการ — ห้าม toggle ตัวเอง (เหมือนตาราง) */}
                {canEditFlag && (
                  <div className="mt-3 pt-3 border-t border-border flex justify-end">
                    {u.admin_id !== user?.admin_id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggleActive(u)}
                        title={u.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                      >
                        <Power size={14} /> {u.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                      </Button>
                    ) : (
                      <span className="text-xs text-text-subtle">—</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* ── Desktop (lg+): table ── */}
          <div className="hidden lg:block bg-surface rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-text-muted">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">ชื่อ</th>
                    <th className="text-left px-4 py-3 font-medium">อีเมล</th>
                    <th className="text-left px-4 py-3 font-medium">บทบาท</th>
                    <th className="text-left px-4 py-3 font-medium">สถานะ</th>
                    <th className="text-left px-4 py-3 font-medium">เข้าระบบล่าสุด</th>
                    {canEditFlag && <th className="text-right px-4 py-3 font-medium">การจัดการ</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((u) => (
                    <tr key={u.admin_id} className="hover:bg-surface-2/50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-text">{u.name || u.username}</div>
                        <div className="text-xs text-text-subtle">@{u.username}</div>
                      </td>
                      <td className="px-4 py-3 text-text-muted">{u.email}</td>
                      <td className="px-4 py-3"><Badge tone={roleTone(u.role)}>{u.role}</Badge></td>
                      <td className="px-4 py-3">
                        {u.active ? <Badge tone="brand">ใช้งาน</Badge> : <Badge tone="red">ปิดใช้งาน</Badge>}
                      </td>
                      <td className="px-4 py-3 text-text-muted text-xs whitespace-nowrap">
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString("th-TH") : "—"}
                      </td>
                      {canEditFlag && (
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {/* Toggle active/inactive — เฉพาะ superadmin/dev เท่านั้น (canEditFlag) */}
                            {/* ห้าม toggle ตัวเอง */}
                            {u.admin_id !== user?.admin_id ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleToggleActive(u)}
                                title={u.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                              >
                                <Power size={14} /> {u.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                              </Button>
                            ) : (
                              <span className="text-xs text-text-subtle">—</span>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}

"use client";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/authStore";
import { canManageUsers, canViewUsers } from "@/lib/roles";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Loading } from "@/components/ui/Loading";
import { EmptyState } from "@/components/ui/EmptyState";
import { UserPlus, KeyRound, Trash2, Power, Mail, Users, X } from "lucide-react";
import { api } from "@/lib/apiClient";

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

  // Invite modal
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "dev">("admin");
  const [inviteResult, setInviteResult] = useState<{ message: string; link?: string; email_sent: boolean; dev_mode: boolean } | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  // Reset password modal
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

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
    if (canViewUsers(user)) loadUsers();
    else setLoading(false);
  }, [user, loadUsers]);

  async function handleInvite() {
    if (!inviteEmail || !inviteEmail.includes("@")) return;
    setInviteLoading(true);
    setError(null);
    try {
      const r = await api().post<{
        message: string;
        link?: string;
        email_sent: boolean;
        dev_mode: boolean;
      }>("/users/invite", { email: inviteEmail, name: inviteName, role: inviteRole });
      setInviteResult(r.data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "เชิญไม่สำเร็จ";
      setError(msg);
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleResetPassword() {
    if (!resetTarget || newPassword.length < 8) return;
    setResetLoading(true);
    setError(null);
    try {
      await api().post(`/users/${resetTarget.admin_id}/reset-password`, { password: newPassword });
      setResetTarget(null);
      setNewPassword("");
      await loadUsers();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "รีเซตรหัสผ่านไม่สำเร็จ";
      setError(msg);
    } finally {
      setResetLoading(false);
    }
  }

  async function handleToggleActive(u: UserRow) {
    setError(null);
    try {
      await api().patch(`/users/${u.admin_id}`, { active: !u.active });
      await loadUsers();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "เปลี่ยนสถานะไม่สำเร็จ";
      setError(msg);
    }
  }

  async function handleDelete(u: UserRow) {
    if (!confirm(`ต้องการลบผู้ใช้ "${u.email}" ใช่ไหม?`)) return;
    setError(null);
    try {
      await api().delete(`/users/${u.admin_id}`);
      await loadUsers();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "ลบไม่สำเร็จ";
      setError(msg);
    }
  }

  // Access control
  if (!canViewUsers(user)) {
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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">จัดการผู้ใช้</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {canEditFlag ? "เชิญ เพิ่ม รีเซตรหัสผ่าน และจัดการแอดมิน" : "ดูรายการผู้ใช้ (read-only)"}
          </p>
        </div>
        {canEditFlag && (
          <Button onClick={() => { setShowInvite(true); setInviteResult(null); setInviteEmail(""); setInviteName(""); }}>
            <UserPlus size={16} /> เชิญสมาชิก
          </Button>
        )}
      </div>

      {error && (
        <div className="text-sm text-vibrant-coral bg-vibrant-coral-soft rounded-lg px-3 py-2">{error}</div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12"><Loading size={24} /></div>
      ) : users.length === 0 ? (
        <EmptyState icon={Users} title="ยังไม่มีผู้ใช้" description="เชิญสมาชิกเพื่อเริ่มต้น" />
      ) : (
        <div className="bg-surface rounded-xl border border-border overflow-hidden">
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
                  <td className="px-4 py-3 text-text-muted text-xs">
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleString("th-TH") : "—"}
                  </td>
                  {canEditFlag && (
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {/* Only show action buttons for admin role (not superadmin/dev) */}
                        {u.role === "admin" && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => { setResetTarget(u); setNewPassword(""); }}>
                              <KeyRound size={14} /> รีเซต
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleToggleActive(u)}>
                              <Power size={14} /> {u.active ? "ปิด" : "เปิด"}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleDelete(u)}>
                              <Trash2 size={14} />
                            </Button>
                          </>
                        )}
                        {u.role !== "admin" && (
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
      )}

      {/* Invite Modal */}
      {showInvite && (
        <Modal onClose={() => setShowInvite(false)} title="เชิญสมาชิกใหม่">
          {inviteResult ? (
            <div className="space-y-3">
              {inviteResult.email_sent ? (
                <>
                  <div className="flex items-center gap-2 text-brand">
                    <Mail size={18} />
                    <span className="text-sm font-medium">ส่งคำเชิญไปยังอีเมลเรียบร้อย</span>
                  </div>
                  <p className="text-sm text-text-muted">
                    ระบบได้ส่งลิงก์สมัครไปยัง <strong>{inviteEmail}</strong> แล้ว
                    ผู้ใช้ใหม่สามารถกดลิงก์ในอีเมลเพื่อสมัครได้โดยตรง
                  </p>
                </>
              ) : inviteResult.dev_mode ? (
                <>
                  <div className="flex items-center gap-2 text-deep-space">
                    <Mail size={18} />
                    <span className="text-sm font-medium">โหมดพัฒนา — ยังไม่ได้ตั้งค่า Resend</span>
                  </div>
                  <p className="text-sm text-text-muted">
                    ระบบสร้างลิงก์สมัครแล้ว แต่ยังไม่ส่งอีเมลอัตโนมัติเพราะไม่ได้ตั้งค่า RESEND_API_KEY
                    ก๊อปลิงก์ด้านล่างส่งให้ผู้ใช้เอง:
                  </p>
                  <div className="bg-surface-2 rounded-lg p-3 text-xs break-all font-mono text-brand">
                    {inviteResult.link}
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => inviteResult.link && navigator.clipboard?.writeText(inviteResult.link)}
                  >
                    คัดลอกลิงก์
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-vibrant-coral">
                    <Mail size={18} />
                    <span className="text-sm font-medium">ส่งอีเมลไม่สำเร็จ</span>
                  </div>
                  <p className="text-sm text-text-muted">{inviteResult.message}</p>
                </>
              )}
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => { setInviteResult(null); setInviteEmail(""); setInviteName(""); }}
              >
                เชิญเพิ่มอีก
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Input label="อีเมล" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="user@example.com" />
              <Input label="ชื่อ (ไม่บังคับ)" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="ชื่อที่แสดง" />
              <div>
                <span className="block text-sm font-medium text-text mb-1.5">บทบาท</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setInviteRole("admin")}
                    className={`flex-1 h-10 rounded-lg border text-sm ${inviteRole === "admin" ? "border-brand bg-brand/10 text-brand" : "border-border text-text-muted"}`}
                  >admin</button>
                  <button
                    onClick={() => setInviteRole("dev")}
                    className={`flex-1 h-10 rounded-lg border text-sm ${inviteRole === "dev" ? "border-brand bg-brand/10 text-brand" : "border-border text-text-muted"}`}
                  >dev</button>
                </div>
              </div>
              <p className="text-xs text-text-muted">
                ระบบจะส่งลิงก์สมัครไปยังอีเมลโดยอัตโนมัติ (ใช้ Resend)
              </p>
              <Button className="w-full" onClick={handleInvite} disabled={inviteLoading || !inviteEmail}>
                {inviteLoading ? <Loading size={16} /> : <Mail size={16} />} ส่งคำเชิญทางอีเมล
              </Button>
            </div>
          )}
        </Modal>
      )}

      {/* Reset Password Modal */}
      {resetTarget && (
        <Modal onClose={() => setResetTarget(null)} title={`รีเซตรหัสผ่าน — ${resetTarget.email}`}>
          <div className="space-y-4">
            <Input
              label="รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
            />
            <p className="text-xs text-text-muted">เซสชันทั้งหมดของผู้ใช้นี้จะถูกยกเลิกทันที</p>
            <Button
              className="w-full"
              onClick={handleResetPassword}
              disabled={resetLoading || newPassword.length < 8}
            >
              {resetLoading ? <Loading size={16} /> : <KeyRound size={16} />} รีเซตรหัสผ่าน
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-text">{title}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

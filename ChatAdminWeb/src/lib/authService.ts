// Auth service — calls Next.js route handlers (same origin).
// Token is managed via HttpOnly cookie by the server.
// ⚠️ ระบบใช้ SSO ขององค์กร — ไม่มี signin/signup/reset ผ่าน API ของเราอีกต่อไป
// ปุ่ม "เข้าสู่ระบบด้วย SSO" ในหน้า /login จะ redirect ไป /api/auth/sso/login โดยตรง
import { api } from "./apiClient";
import type { AdminUser } from "./types";

export const authService = {
  // POST /api/auth/logout
  logout: () => api().post("/auth/logout").then((r) => r.data),

  // GET /api/auth/me
  me: () => api().get<{ admin: AdminUser }>("/auth/me").then((r) => r.data),
};

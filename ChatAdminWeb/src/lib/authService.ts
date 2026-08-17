// Auth service — calls Next.js route handlers (same origin).
// Token is managed via HttpOnly cookie by the server.
import { api } from "./apiClient";
import type { AdminUser } from "./types";

export const authService = {
  // POST /api/auth/signin
  signin: (email: string, password: string) =>
    api().post<{ admin: AdminUser }>("/auth/signin", { email, password }).then((r) => r.data),

  // POST /api/auth/signup/request — superadmin invites
  signupRequest: (email: string) =>
    api().post("/auth/signup/request", { email }).then((r) => r.data),

  // POST /api/auth/signup/confirm — confirm signup with token
  signupConfirm: (token: string, username: string, password: string, name?: string) =>
    api().post<{ admin: AdminUser }>("/auth/signup/confirm", {
      token, username, password, name,
    }).then((r) => r.data),

  // POST /api/auth/reset/request
  resetRequest: (email: string) =>
    api().post("/auth/reset/request", { email }).then((r) => r.data),

  // POST /api/auth/reset/confirm — accepts `password` (matches backend)
  resetConfirm: (token: string, password: string) =>
    api().post("/auth/reset/confirm", { token, password }).then((r) => r.data),

  // POST /api/auth/logout
  logout: () => api().post("/auth/logout").then((r) => r.data),

  // GET /api/auth/me
  me: () => api().get<{ admin: AdminUser }>("/auth/me").then((r) => r.data),
};

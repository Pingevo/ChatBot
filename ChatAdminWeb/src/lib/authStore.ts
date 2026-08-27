// Auth store (zustand) — manages admin session state.
// Token is stored in an HttpOnly cookie by the server; this store only
// tracks the user profile and auth flow state (no token handling).
// ⚠️ ระบบใช้ SSO ขององค์กร — ไม่มี login/signup/reset ผ่าน store อีกต่อไป
// login ทำผ่าน browser redirect ไป /api/auth/sso/login โดยตรง

import { create } from "zustand";
import { AdminUser } from "./types";
import { authService } from "./authService";

interface AuthState {
  user: AdminUser | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  // session
  logout: () => Promise<void>;
  fetchMe: () => Promise<void>;
  clearError: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: false,
  error: null,
  initialized: false,

  fetchMe: async () => {
    try {
      const data = await authService.me();
      set({ user: data.admin, initialized: true });
    } catch {
      set({ user: null, initialized: true });
    }
  },

  logout: async () => {
    try {
      await authService.logout();
    } catch {
      // ignore — still clear local state
    }
    set({ user: null, initialized: true });
  },

  clearError: () => set({ error: null }),
}));

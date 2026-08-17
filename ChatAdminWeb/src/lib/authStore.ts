// Auth store (zustand) — manages admin session state.
// Token is stored in an HttpOnly cookie by the server; this store only
// tracks the user profile and auth flow state (no token handling).

import { create } from "zustand";
import { AdminUser } from "./types";
import { authService } from "./authService";

interface AuthState {
  user: AdminUser | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  // login flow
  login: (email: string, password: string) => Promise<boolean>;
  // signup flow
  signupConfirm: (token: string, username: string, password: string, name?: string) => Promise<boolean>;
  // reset flow
  resetConfirm: (token: string, password: string) => Promise<boolean>;
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

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const data = await authService.signin(email, password);
      set({ user: data.admin, loading: false, initialized: true });
      return true;
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "เข้าสู่ระบบไม่สำเร็จ";
      set({ loading: false, error: msg });
      return false;
    }
  },

  signupConfirm: async (token, username, password, name) => {
    set({ loading: true, error: null });
    try {
      await authService.signupConfirm(token, username, password, name);
      set({ loading: false });
      return true;
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "สมัครสมาชิกไม่สำเร็จ";
      set({ loading: false, error: msg });
      return false;
    }
  },

  resetConfirm: async (token, password) => {
    set({ loading: true, error: null });
    try {
      await authService.resetConfirm(token, password);
      set({ loading: false });
      return true;
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "รีเซตรหัสผ่านไม่สำเร็จ";
      set({ loading: false, error: msg });
      return false;
    }
  },

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

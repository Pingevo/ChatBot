// Central axios instance — same-origin, cookie-based auth.
// Token is stored in an HttpOnly cookie (set by the server); the browser
// sends it automatically. No localStorage, no manual token handling.

import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from "axios";

// Same origin — Next.js route handlers proxy to backend services.
const BASE_URL = "/api";

// Request interceptor: withCredentials so cookies are sent cross-site (not
// strictly needed for same-origin, but explicit).
function attachConfig(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  config.withCredentials = true;
  return config;
}

// Response interceptor: handle 401 globally — redirect to /login once.
let redirecting = false;
function handle401(error: AxiosError): Promise<never> {
  if (error.response?.status === 401 && typeof window !== "undefined") {
    if (!redirecting && !window.location.pathname.startsWith("/login")) {
      redirecting = true;
      window.location.href = "/login";
    }
  }
  return Promise.reject(error);
}

let _instance: AxiosInstance | null = null;

export function api(): AxiosInstance {
  if (_instance) return _instance;
  _instance = axios.create({
    baseURL: BASE_URL,
    timeout: 30_000,
    headers: { "Content-Type": "application/json" },
    withCredentials: true,
  });
  _instance.interceptors.request.use(attachConfig);
  _instance.interceptors.response.use((r) => r, handle401);
  return _instance;
}

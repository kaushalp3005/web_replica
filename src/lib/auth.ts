// Mirrors the Android client's auth flow:
//   1. POST /api/v1/auth/login  →  store tokens
//   2. GET  /api/v1/auth/me     →  hydrate user, route on must_change_password / inactive
// Error envelope codes (invalid_credentials, account_locked, rate_limit_exceeded,
// account_suspended, account_disabled) are mapped to user-visible strings, matching
// LoginActivity.handleLoginError.

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const TOKEN_KEYS = {
  access: "auth.access_token",
  refresh: "auth.refresh_token",
  accessExpiresAt: "auth.access_expires_at",
  refreshExpiresAt: "auth.refresh_expires_at",
} as const;

// Tiny safe-storage shim — returns null / no-ops during SSR so callers can
// stay synchronous without scattering `typeof window` checks. localStorage
// access is also wrapped in try/catch so Safari private mode (which throws
// QuotaExceededError on every write) doesn't crash the app.
function safeGet(k: string): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(k, v); } catch { /* private mode or quota — swallow */ }
}
function safeRemove(k: string): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}

export interface DeviceInfo {
  device_id: string;
  device_name: string;
  app_version: string;
  platform: string;
}

export interface LoginRequest {
  phone: string;
  password: string;
  device_info?: DeviceInfo;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  must_change_password: boolean;
  user?: unknown;
}

export interface MeResponse {
  user_id?: string;
  phone?: string;
  full_name?: string;
  email?: string;
  status: string;
  must_change_password: boolean;
  is_admin?: boolean;
  roles?: unknown[];
  permissions?: unknown[];
  [key: string]: unknown;
}

const ME_KEY = "auth.me";

export const userStore = {
  save(me: MeResponse) {
    safeSet(ME_KEY, JSON.stringify(me));
  },
  load(): MeResponse | null {
    const raw = safeGet(ME_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MeResponse;
    } catch {
      return null;
    }
  },
  clear() {
    safeRemove(ME_KEY);
  },
};

export interface ErrorEnvelope {
  error?: string;
  message?: string;
  locked_until?: string;
  retry_after_seconds?: number;
}

export class AuthError extends Error {
  code: string;
  envelope: ErrorEnvelope;
  httpStatus: number;
  constructor(code: string, envelope: ErrorEnvelope, httpStatus: number) {
    super(envelope.message || code);
    this.code = code;
    this.envelope = envelope;
    this.httpStatus = httpStatus;
  }
}

export const tokenStore = {
  save(r: LoginResponse) {
    const now = Date.now();
    safeSet(TOKEN_KEYS.access, r.access_token);
    safeSet(TOKEN_KEYS.refresh, r.refresh_token);
    safeSet(TOKEN_KEYS.accessExpiresAt, String(now + r.expires_in * 1000));
    safeSet(TOKEN_KEYS.refreshExpiresAt, String(now + r.refresh_expires_in * 1000));
  },
  clear() {
    Object.values(TOKEN_KEYS).forEach(safeRemove);
  },
  accessToken(): string | null {
    return safeGet(TOKEN_KEYS.access);
  },
  hasRefreshToken(): boolean {
    return !!safeGet(TOKEN_KEYS.refresh);
  },
  isRefreshExpired(): boolean {
    const exp = Number(safeGet(TOKEN_KEYS.refreshExpiresAt) ?? 0);
    return !exp || Date.now() >= exp;
  },
};

// ── Sign-out + scoped-cache cleanup ─────────────────────────────────────
//
// Module-scoped registry of "things that need clearing when a user signs
// out". Each module that holds tab-scoped state in sessionStorage (the JC
// list cache today; future modules will follow) registers its cleanup once
// at import time, and `signOut()` drains the registry. This keeps the auth
// module from importing `lib/jc-list-cache` (would be a cycle) while still
// giving us a single place to call from every sign-out button.
const cacheCleanups = new Set<() => void>();
// Returns an unregister callback so test or hot-reload scenarios can avoid
// leaking stale closures into the registry. Production modules typically
// call this once at import time and never need the return value.
export function registerOnSignOut(fn: () => void): () => void {
  cacheCleanups.add(fn);
  return () => { cacheCleanups.delete(fn); };
}
export function signOut(): void {
  tokenStore.clear();
  userStore.clear();
  for (const fn of cacheCleanups) {
    try { fn(); } catch { /* one cleanup failure shouldn't stop the others */ }
  }
}

function stableDeviceId(): string {
  // Best-effort browser analogue of Android's ANDROID_ID — a per-install UUID
  // persisted in localStorage. Good enough for /sessions device tagging.
  const KEY = "auth.device_id";
  let id = safeGet(KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    safeSet(KEY, id);
  }
  return id;
}

function deviceName(): string {
  if (typeof navigator === "undefined") return "web";
  return navigator.userAgent.slice(0, 200);
}

export function buildDeviceInfo(): DeviceInfo {
  return {
    device_id: stableDeviceId(),
    device_name: deviceName(),
    app_version: "web-0.1.0",
    platform: "web",
  };
}

async function parseEnvelope(res: Response): Promise<ErrorEnvelope> {
  try {
    return (await res.json()) as ErrorEnvelope;
  } catch {
    return { error: "unknown_error", message: `HTTP ${res.status}` };
  }
}

export async function login(phone: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password, device_info: buildDeviceInfo() }),
  });
  if (!res.ok) {
    const env = await parseEnvelope(res);
    throw new AuthError(env.error ?? "unknown_error", env, res.status);
  }
  return (await res.json()) as LoginResponse;
}

export async function fetchMe(): Promise<MeResponse> {
  const res = await apiFetch("/api/v1/auth/me");
  if (!res.ok) {
    const env = await parseEnvelope(res);
    throw new AuthError(env.error ?? "unknown_error", env, res.status);
  }
  return (await res.json()) as MeResponse;
}

// Authed fetch: attaches the access token. Non-2xx other than 401 stays the
// caller's problem. A 401 means the access token has expired (or was
// rejected) — there is no client-side refresh wired up yet, so we treat it
// as a hard sign-out: clear stores, drain module caches, and bounce to the
// login page. Using `window.location.assign` rather than `router.replace`
// because apiFetch has no access to the Next.js router and a hard refresh
// is the safest way to drop any stale in-memory React state along the way.
//
// Setting a "signing out" flag prevents redirect loops when multiple
// in-flight requests all 401 at once: only the first triggers the
// redirect; the rest see the flag and return the original response.
let signingOut = false;
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = tokenStore.accessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401 && !signingOut && typeof window !== "undefined") {
    signingOut = true;
    // Stash the path the user was on so the login page can bounce them
    // back after re-auth. We can't import lib/user.ts here without
    // creating a cycle, so duplicate the sessionStorage key contract.
    try {
      const dest = window.location.pathname + window.location.search;
      if (dest && dest !== "/") {
        sessionStorage.setItem("auth.redirect_after_login", dest);
      }
    } catch { /* sessionStorage disabled — fall back to /modules later */ }
    signOut();
    window.location.assign("/");
  }
  return res;
}

// Mirrors LoginActivity.handleLoginError — keep messages generic enough that
// invalid_credentials does NOT distinguish unknown phone vs wrong password.
export function describeLoginError(err: unknown): string {
  if (!(err instanceof AuthError)) {
    return err instanceof Error ? `Connection failed: ${err.message}` : "Connection failed.";
  }
  const env = err.envelope;
  switch (err.code) {
    case "invalid_credentials":
      return "Incorrect phone number or password.";
    case "account_locked":
      return env.locked_until
        ? `Account locked until ${env.locked_until}.`
        : "Account locked. Try again later.";
    case "rate_limit_exceeded":
      return env.retry_after_seconds && env.retry_after_seconds > 0
        ? `Too many attempts. Retry in ${env.retry_after_seconds}s.`
        : "Too many attempts. Try again shortly.";
    case "account_suspended":
      return "Your account is suspended. Contact your admin.";
    case "account_disabled":
      return "Your account is disabled.";
    default:
      return env.message || `Sign-in failed (${err.code || err.httpStatus}).`;
  }
}

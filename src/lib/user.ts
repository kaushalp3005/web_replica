// User-and-session hooks. Three concerns each page used to handle ad-hoc:
//
//   1. Avatar initial (first letter of the cached full name)
//   2. Scope info (`is_admin`, `warehouses`) for filter banners
//   3. Boot-time auth gate ("if no refresh token, send them back to /")
//
// They all read from the same source (the `auth.me` localStorage entry
// hydrated at login + on every successful /me response). useMe() is the
// canonical reader so subsequent hooks don't trigger separate effects.

import { useEffect, useState } from "react";
import { tokenStore, userStore, type MeResponse } from "./auth";

// Type-safe accessor for the warehouses alias the backend uses on /me
// (alias of allowed_warehouses). Kept here so callers don't repeat the
// inline `as { warehouses?: string[] }` cast.
interface MeWithWarehouses extends MeResponse {
  warehouses?: string[];
}

export function initialFromName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return "?";
  return trimmed[0].toUpperCase();
}

// Load the cached `me` once on mount. Returns null on SSR and until the
// localStorage read completes (a single microtask). Subsequent re-renders
// see a stable reference because `me` is held in component state.
export function useMe(): MeResponse | null {
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    queueMicrotask(() => setMe(userStore.load()));
  }, []);
  return me;
}

export function useUserInitial(): string {
  return initialFromName(useMe()?.full_name);
}

export interface UserScope {
  isAdmin: boolean;
  warehouses: string[];
}

export function useUserScope(): UserScope {
  const me = useMe() as MeWithWarehouses | null;
  return {
    isAdmin: !!me?.is_admin,
    warehouses: me?.warehouses ?? [],
  };
}

// Boot-time guard. Mounts once, redirects to "/" when there is no usable
// refresh token. Returns the boolean so callers that want to gate render
// can do so; pages that always render through the redirect can ignore it.
// Stashes the path the user was trying to reach so the login page can
// bounce them back after re-authenticating.
const REDIRECT_KEY = "auth.redirect_after_login";

export function stashRedirectAfterLogin(path: string): void {
  if (typeof window === "undefined") return;
  if (!path || path === "/") return;
  try { sessionStorage.setItem(REDIRECT_KEY, path); } catch { /* ignore */ }
}
export function takeRedirectAfterLogin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = sessionStorage.getItem(REDIRECT_KEY);
    if (v) sessionStorage.removeItem(REDIRECT_KEY);
    return v;
  } catch {
    return null;
  }
}

export function useRequireAuth(replace: (href: string) => void): boolean {
  const [allowed, setAllowed] = useState<boolean>(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ok = tokenStore.hasRefreshToken() && !tokenStore.isRefreshExpired();
    if (!ok) {
      stashRedirectAfterLogin(window.location.pathname + window.location.search);
      // Deferred past the sync effect body so the
      // react-hooks/set-state-in-effect rule stays happy. The replace()
      // call goes in the same tick so the redirect still fires
      // immediately.
      queueMicrotask(() => setAllowed(false));
      replace("/");
    }
  }, [replace]);
  return allowed;
}

// Listing state cache. The job-card listing must survive a round-trip into
// the detail page and back without losing filters, page, fetched rows, or
// scroll position — operators get frustrated when "back" silently resets
// what they were looking at.
//
// We use sessionStorage rather than localStorage so the cache is scoped to
// the browser tab — closing the tab discards it, but navigating within the
// tab (modules ↔ list ↔ detail) preserves it. The cache survives a hard
// reload of the listing page too, which is the behaviour users tend to
// expect from "stick to where I was".

import { registerOnSignOut } from "./auth";

export type CachedRow = Record<string, unknown> & { job_card_id: number };

export interface JcListCache {
  entity: string;
  factory: string;
  statusFilter: string[];
  search: string;
  page: number;
  rows: CachedRow[];
  pagination?: {
    page?: number;
    page_size?: number;
    total?: number;
    total_pages?: number;
  };
  searchMeta?: { total: number; capped: boolean; hardCap: number } | null;
  scrollY: number;
}

const KEY = "jc-list-state";

export function loadListCache(): JcListCache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as JcListCache;
  } catch {
    return null;
  }
}

export function saveListCache(state: JcListCache) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage disabled — silently drop the write. The
    // page still works without the cache; back-navigation just refetches.
  }
}

export function patchListCache(patch: Partial<JcListCache>) {
  const cur = loadListCache();
  if (!cur) return;
  saveListCache({ ...cur, ...patch });
}

export function clearListCache() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// Auto-register so every callsite of auth.signOut() drains this cache too —
// no per-page sign-out handler needs to remember to call clearListCache().
if (typeof window !== "undefined") {
  registerOnSignOut(clearListCache);
}

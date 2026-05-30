// Listing state cache for /modules/production/so-creation. Mirrors
// lib/jc-list-cache.ts in spirit: tab-scoped sessionStorage entry that
// preserves filters, sort, pagination, and expanded-rows across back
// navigation and refresh. Drains on sign-out so a new operator on the
// same machine doesn't inherit the previous user's view.
//
// Why a dedicated file rather than useSessionCache from lib/session-state:
// the page state is 9 primitives + 2 Sets, which doesn't compose cleanly
// into a single object passed through a hook. The fundamentals are still
// shared (sessionLoad/Save/Clear); this is just the SO-specific shape +
// the module-level signOut registration that hooks can't do.

import { registerOnSignOut } from "./auth";
import { sessionLoad, sessionSave, sessionClear } from "./session-state";

const KEY = "so-creation.list-state";

export interface SoListCache {
  search: string;
  status: "all" | "ok" | "mismatch" | "warning" | "unmatched";
  dateFrom: string;
  dateTo: string;
  // Sets serialized as arrays — JSON.stringify of a Set returns "{}".
  // Page lazy-init reconstructs `new Set(arr)`.
  advFilters: Record<string, string[]>;
  sortBy: "so_number" | "so_date" | "gst_status" | "customer_name" | "company";
  sortOrder: "asc" | "desc";
  page: number;
  expanded: number[];
}

export function loadSoListCache(): SoListCache | null {
  return sessionLoad<SoListCache>(KEY);
}

export function saveSoListCache(value: SoListCache): void {
  sessionSave<SoListCache>(KEY, value);
}

export function clearSoListCache(): void {
  sessionClear(KEY);
}

// Module-load registration so sign-out drains the cache even when this
// page isn't currently mounted. Mirrors lib/jc-list-cache.ts.
if (typeof window !== "undefined") {
  registerOnSignOut(clearSoListCache);
}

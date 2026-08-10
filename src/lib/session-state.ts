// Generic sessionStorage-backed state helpers.
//
// Generalizes the pattern proven by jc-list-cache.ts: tab-scoped persistence
// that survives back-navigation and refresh, drains on sign-out, and falls
// back gracefully when storage is unavailable. Two flavours:
//   useSessionCache — listing state (filters, sort, scroll). Survives until
//                     the tab is closed or the user signs out.
//   useSessionDraft — form draft. Same lifecycle PLUS an explicit clear()
//                     the page calls on successful submit / cancel.
//
// jc-list-cache.ts is intentionally NOT migrated to these helpers — it's
// load-bearing as-is and serves as the reference implementation.

import { useCallback, useEffect, useState } from "react";
import { registerOnSignOut } from "./auth";

// ── Pure helpers ─────────────────────────────────────────────────────────

export function sessionLoad<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt JSON or schema change between deploys — drop the bad entry
    // so the page falls back to its initial value cleanly.
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
}

export function sessionSave<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled (Safari private mode, etc.) —
    // silent drop. The page still works, just without persistence.
  }
}

export function sessionClear(key: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────

type Updater<T> = T | ((prev: T) => T);

function applyUpdater<T>(prev: T, next: Updater<T>): T {
  return typeof next === "function" ? (next as (p: T) => T)(prev) : next;
}

/**
 * Listing-state hook. Lazy-init reads sessionStorage once on mount; the
 * setter writes through on every change. Returns a tuple matching useState.
 *
 * CRITICAL: lazy init runs ONCE. Do NOT call sessionLoad() on every render —
 * each call returns a fresh object reference, which would invalidate any
 * effect that depends on it and burn re-fetches. (Same trap jc-list-cache
 * documents at line 137.)
 */
export function useSessionCache<T>(
  key: string,
  initial: T,
): [T, (next: Updater<T>) => void] {
  const [state, setState] = useState<T>(() => sessionLoad<T>(key) ?? initial);

  // Setter is stable across renders so callers can put it in effect deps
  // without re-running them on every render.
  const setAndSave = useCallback(
    (next: Updater<T>) => {
      setState((prev) => {
        const value = applyUpdater(prev, next);
        sessionSave(key, value);
        return value;
      });
    },
    [key],
  );

  return [state, setAndSave];
}

/**
 * Form-draft hook. Same shape as useSessionCache but additionally registers
 * its clear() with auth.registerOnSignOut so the draft drains when the user
 * signs out (or a 401 forces a sign-out). Pages call clear() explicitly on
 * successful submit and on the Cancel button.
 */
export function useSessionDraft<T>(
  key: string,
  initial: T,
): {
  draft: T;
  setDraft: (next: Updater<T>) => void;
  clear: () => void;
} {
  const [draft, setDraftState] = useState<T>(() => sessionLoad<T>(key) ?? initial);

  // key flows through each callback's dep array so dynamic keys (e.g.
  // per-soId drafts) get fresh closures when the key changes. No refs —
  // the React refs lint rule disallows mid-render mutation.
  const setDraft = useCallback(
    (next: Updater<T>) => {
      setDraftState((prev) => {
        const value = applyUpdater(prev, next);
        sessionSave(key, value);
        return value;
      });
    },
    [key],
  );

  const clear = useCallback(() => {
    sessionClear(key);
    setDraftState(initial);
    // `initial` is intentionally captured by closure — drafts re-initialise
    // to the same empty shape the page declared at mount. If a page wants
    // to clear-and-replace it should call setDraft(newValue) instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    // Drains the draft on sign-out (avatar button or 401 interceptor). The
    // returned unregister callback fires on unmount so we don't accumulate
    // stale closures in the auth module's registry.
    return registerOnSignOut(() => {
      sessionClear(key);
    });
  }, [key]);

  return { draft, setDraft, clear };
}

"use client";

// W4-MED-3 + W4-MED-10 — single subscription point for the JC list + detail
// pages.
//
// Pre-fix, every render of RowActions / ActionButton / LockableButton /
// useRowLockIndicator independently called useMe (subscribes to userStore),
// useIsAdmin (subscribes via useMe), AND useSeesCost (separate subscription).
// On a list page with 50 row cards × 2-3 buttons each that's ~150 subscribers
// fanning out from the same store, all re-running on every /me push. The
// pub-sub fan-out was measurable (10-20ms re-render on every storage event).
//
// This provider calls the three hooks ONCE at the page level and broadcasts
// the values through React context. Children read via `useUserCtx()` and
// rerender only when the context value flips. ActionButton / LockableButton
// / RowActions / useRowLockIndicator all consume via context — they're only
// used inside the JC module so the provider is guaranteed to be mounted.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useIsAdmin, useMe } from "@/lib/user";
import { useSeesCost } from "@/lib/cost-gate";
import type { MeResponse } from "@/lib/auth";

export interface UserCtxValue {
  me: MeResponse | null;
  isAdmin: boolean;
  seesCost: boolean;
}

const UserCtx = createContext<UserCtxValue | null>(null);

export function UserProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const isAdmin = useIsAdmin();
  const { seesCost } = useSeesCost();
  // useMemo so children that only consume `me` don't see a fresh identity
  // when isAdmin/seesCost flip independently. (Today both derive from `me`
  // so the three values move in lock-step, but the memo keeps the contract
  // stable if that ever changes.)
  const value = useMemo<UserCtxValue>(() => ({ me, isAdmin, seesCost }), [me, isAdmin, seesCost]);
  return <UserCtx.Provider value={value}>{children}</UserCtx.Provider>;
}

// Consumer hook. Throws if used outside a <UserProvider> tree — that's a
// programmer error (every JC surface is wrapped) and we want it loud rather
// than silently re-introducing the per-subscriber pattern.
export function useUserCtx(): UserCtxValue {
  const ctx = useContext(UserCtx);
  if (!ctx) {
    throw new Error(
      "useUserCtx must be used inside <UserProvider>. Wrap the JC page tree with UserProvider.",
    );
  }
  return ctx;
}

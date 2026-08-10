// C3 — Lock state hook for JC operational forms.
//
// Reads `is_locked`, `locked_reason`, `force_unlocked`, and `status` straight
// off the JobCardDetail payload (already fetched by the parent JC detail page)
// and returns the derived effective lock state.
//
// Effective lock rule mirrors the backend's assert_not_locked (server_replica/
// app/modules/production/services/job_card_v2.py:59) — a JC is OPERATIONALLY
// locked when `is_locked` is true AND `force_unlocked` is false. Once an admin
// force-unlocks the JC, `force_unlocked` flips true and the operational forms
// re-enable even though `is_locked` itself may still read true (the row is
// kept as a historical breadcrumb).
//
// Operational endpoints that 409 with {"error":"locked", ...} are the ones
// gated by this hook:
//   outputs / accounting/consumption / accounting/byproducts /
//   accounting/summary / metal-detection / weight-checks / environment /
//   loss-reconciliation / remarks / qc / shifts / start
// Lifecycle endpoints (PATCH header, DELETE / cancel, force-unlock, sign-off,
// complete, close, dispatch-to-next) are intentionally NOT gated — they keep
// the JC moveable even while locked.

import { useMemo } from "react";
import type { MeResponse, MeRoleEnvelope } from "@/lib/auth";

// Lightweight subset of the JC detail payload the hook needs. Re-declared
// locally (rather than imported from page.tsx) so this module stays free of
// the page's enormous type graph and can be unit-tested in isolation.
export type LockSource = {
  is_locked?: boolean | null;
  locked_reason?: string | null;
  force_unlocked?: boolean | null;
  status?: string | null;
};

export type LockState = {
  /** True when operational forms must be disabled and the banner must show. */
  isLocked: boolean;
  /** Server-supplied human-readable reason. May be null on legacy rows. */
  lockedReason: string | null;
  /** Raw JC status (e.g. "locked", "in_progress"). Surfaced for context only. */
  status: string | null;
  /** True when an admin has force-unlocked — the banner stays informational
   *  but forms re-enable. Useful if a screen wants to render a softer note. */
  forceUnlocked: boolean;
};

export function useLockState(detail: LockSource | null | undefined): LockState {
  return useMemo<LockState>(() => {
    if (!detail) {
      return { isLocked: false, lockedReason: null, status: null, forceUnlocked: false };
    }
    const isLocked = !!detail.is_locked && !detail.force_unlocked;
    return {
      isLocked,
      lockedReason: detail.locked_reason ?? null,
      status: detail.status ?? null,
      forceUnlocked: !!detail.force_unlocked,
    };
  }, [detail]);
}

// C3-H1 + H2 — shared role gate used by both LockBanner CTA and the
// OverflowMenu's `showForceUnlock` item. Roles permitted to force-unlock a
// JC mirror the backend's unlock_authority check on PUT /force-unlock:
// admin, floor_manager, plant_manager, and inventory_manager. Previously
// inventory_manager was missing from the LockBanner gate (and the menu
// gated on `is_admin` only) so the two CTAs disagreed on who could trigger
// the action. This util is the single source of truth.
const UNLOCK_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "floor_manager",
  "plant_manager",
  "inventory_manager",
]);

export function userMayForceUnlock(me: MeResponse | null | undefined): boolean {
  if (!me) return false;
  if (me.is_admin) return true;
  if (typeof me.role_name === "string" && UNLOCK_ROLES.has(me.role_name)) return true;
  const roles = Array.isArray(me.roles) ? me.roles : [];
  for (const r of roles) {
    if (typeof r === "string" && UNLOCK_ROLES.has(r)) return true;
    if (r && typeof r === "object") {
      const env = r as MeRoleEnvelope;
      const code = env.code ?? env.role_name ?? "";
      if (UNLOCK_ROLES.has(code)) return true;
    }
  }
  return false;
}

// C3-MED-1 — tiny helper for operational form inputs that need to surface
// the lock banner as their description when disabled. Returns the disabled
// flag, the matching aria-disabled attr, and aria-describedby pointing at
// the banner's stable id (set on LockBanner via `jc-lock-banner-{jcId}`)
// only when the input is actually disabled. Keeps three repetitive props
// in one call site so we don't have to remember to wire them everywhere.
export function lockProps(disabled: boolean, bannerId: string): {
  disabled: boolean;
  "aria-disabled": boolean;
  "aria-describedby": string | undefined;
} {
  return {
    disabled,
    "aria-disabled": disabled,
    "aria-describedby": disabled ? bannerId : undefined,
  };
}

/** Stable DOM id for a JC lock banner. Used by `aria-describedby` on
 *  disabled inputs and by the OverflowMenu's deep-link fallback. */
export function lockBannerId(jcId: number | string): string {
  return `jc-lock-banner-${jcId}`;
}

"use client";

// C10 (Wave 4) — canonical role-gated action button primitive.
//
// Replaces the ad-hoc inline gates the list page and detail page used to
// scatter at every CTA (`if (me?.is_admin) <button ...>`,
// `disabled={loading || lock.isLocked}` etc.). One component decides:
//   - whether to render at all (role allow-list / admin bypass),
//   - whether to disable (lock state, loading, caller-supplied flags),
//   - which palette to render (primary / secondary / danger / warn).
//
// IMPORTANT — render-vs-disable contract:
//
//   * Role denial → renders NOTHING (returns null). Operators never see a
//     greyed-out button they can't act on; the surface stays clean.
//   * Lock denial → renders disabled WITH a tooltip explaining why.
//     Force-unlock-capable users (`mayForceUnlock`) keep the button
//     interactive — the server is still the authority, this is just a
//     courtesy gate that says "ok, you can try".
//   * Loading / caller-disabled → renders disabled, no tooltip override.
//
// Cost gate (`costRequired`): when true, the button only renders for
// users whose role passes useSeesCost. Mirrors the cost-bearing-field
// vocabulary in lib/cost-gate.ts. Most action buttons don't need this —
// it exists for the (rare) future case where a CTA writes a cost figure.
//
// Responsive contract:
//   - 32px tap target on all viewports (h-8 / py-1 keeps the box ≥ 32px).
//   - Text + spinner inline; no fixed widths so the button reflows in
//     narrow toolbars at 360px and below.
//   - Variants only restyle colours; layout stays identical so a tab strip
//     of mixed variants stays vertically aligned.

import { useMemo } from "react";
import { userMayForceUnlock } from "./_useLockState";
import type { LockState } from "./_useLockState";
import type { MeResponse, MeRoleEnvelope } from "@/lib/auth";
// W4-MED-3/M10 — single subscription via context; see _UserContext.tsx.
import { useUserCtx } from "./_UserContext";

// ── Variant palettes ─────────────────────────────────────────────────────
//
// AWS-console-leaning tokens, matching the existing buttons on the list
// + detail pages. `secondary` is the only outline-style variant; the rest
// are filled.

export type ActionVariant = "primary" | "secondary" | "danger" | "warn";

const VARIANT_CLS: Record<ActionVariant, { enabled: string; disabled: string }> = {
  primary: {
    enabled:
      "bg-[var(--aws-orange)] border-[var(--aws-orange-active)] hover:bg-[var(--aws-orange-hover)] text-white",
    disabled:
      "bg-[#c98f92] border-[#c98f92] cursor-not-allowed text-[var(--text-primary)] opacity-80",
  },
  secondary: {
    enabled:
      "bg-white border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)] text-[var(--text-primary)]",
    disabled:
      "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed",
  },
  danger: {
    enabled:
      "bg-white border-[#f0c7be] text-[#b1361e] hover:bg-[#fbeced] focus:ring-1 focus:ring-[#b1361e]",
    disabled:
      "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed",
  },
  warn: {
    enabled:
      "bg-[#fff8e1] border-[#f3d27a] text-[#7a5d0c] hover:bg-[#fdefb8]",
    disabled:
      "bg-[var(--surface-disabled)] border-[var(--aws-border)] text-[var(--text-disabled)] cursor-not-allowed",
  },
};

// ── Role gate ────────────────────────────────────────────────────────────
//
// Allow list is a comma-separated string for ergonomic JSX use:
//   <ActionButton roleAllow="admin,floor_manager,plant_manager">…</…>
// An explicit `admin` entry is OPTIONAL — admins are always allowed (the
// hook short-circuits before the list is checked). An empty / undefined
// allow list means "anyone signed in".

function hasAnyRole(me: MeResponse | null, allow: ReadonlySet<string>): boolean {
  if (allow.size === 0) return true;
  if (!me) return false;
  if (typeof me.role_name === "string" && allow.has(me.role_name)) return true;
  const roles = Array.isArray(me.roles) ? me.roles : [];
  for (const r of roles) {
    if (typeof r === "string" && allow.has(r)) return true;
    if (r && typeof r === "object") {
      const env = r as MeRoleEnvelope;
      const code = env.code ?? env.role_name ?? "";
      if (code && allow.has(code)) return true;
    }
  }
  return false;
}

function parseAllow(roleAllow: string | undefined): ReadonlySet<string> {
  if (!roleAllow) return new Set();
  return new Set(
    roleAllow
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

// ── Base button ──────────────────────────────────────────────────────────

export interface ActionButtonProps {
  /** Comma-separated allow list, e.g. "floor_manager,plant_manager". Admin
   *  is always allowed regardless of the list. Empty / omitted = no role
   *  gate (anyone signed in renders). */
  roleAllow?: string;
  /** When true, hide the button from users whose role can't see cost (see
   *  lib/cost-gate.ts useSeesCost). Defaults to false. */
  costRequired?: boolean;
  /** Caller-controlled disabled flag (in-flight save, missing input, etc.).
   *  Combines with the lock / loading state inside LockableButton. */
  disabled?: boolean;
  /** Caller-controlled busy state. Renders the spinner + busyLabel. */
  busy?: boolean;
  /** Label rendered while `busy` is true. Defaults to "Working…". */
  busyLabel?: string;
  variant?: ActionVariant;
  /** Native title attribute. Falls back to the lock reason on LockableButton. */
  title?: string;
  /** aria-describedby — typically pointed at the lock banner id. */
  ariaDescribedBy?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  /** Extra Tailwind classes appended after the variant classes. */
  className?: string;
  children: React.ReactNode;
}

export function ActionButton({
  roleAllow,
  costRequired = false,
  disabled = false,
  busy = false,
  busyLabel = "Working…",
  variant = "primary",
  title,
  ariaDescribedBy,
  onClick,
  type = "button",
  className = "",
  children,
}: ActionButtonProps) {
  const { me, isAdmin, seesCost } = useUserCtx();

  const allow = useMemo(() => parseAllow(roleAllow), [roleAllow]);
  const roleOk = isAdmin || hasAnyRole(me, allow);
  // Role denial — render nothing. We deliberately do NOT render a disabled
  // button here: the operator should not see a CTA they aren't allowed to
  // operate (the surface stays clean). The DENIED variant of the call is
  // therefore invisible, matching the audit's `RoleGated<ActionButton>`
  // contract.
  if (!roleOk) return null;
  if (costRequired && !seesCost) return null;

  const isDisabled = disabled || busy;
  const palette = VARIANT_CLS[variant];
  const cls = [
    // 32px tap target on every viewport. Identical layout across variants
    // so a row of mixed-variant buttons stays aligned in the toolbar.
    "h-8 px-3 rounded-[2px] text-[12px] font-semibold border whitespace-nowrap inline-flex items-center gap-2",
    isDisabled ? palette.disabled : palette.enabled,
    className,
  ].join(" ");

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-describedby={ariaDescribedBy}
      title={title}
      className={cls}
    >
      {busy ? (
        <>
          <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// ── Lockable variant ─────────────────────────────────────────────────────
//
// Extends ActionButton with a JC lock-state aware disabled flag. If the
// JC is operationally locked AND the user CANNOT force-unlock, the
// button is disabled and the lock reason is surfaced via the title
// attribute. Force-unlock-capable users (`userMayForceUnlock`) keep the
// button interactive — the backend is still the authority, but at this
// point the user is at least allowed to TRY (e.g. open the dispatch
// modal, which the server will then 409 if the lock genuinely blocks it).

export interface LockableButtonProps extends ActionButtonProps {
  /** Lock state from useLockState() / useRowLockIndicator(). */
  lockState: LockState | { isLocked: boolean; lockedReason: string | null; mayForceUnlock?: boolean };
}

export function LockableButton({
  lockState,
  disabled = false,
  title,
  ...rest
}: LockableButtonProps) {
  const { me } = useUserCtx();
  // For LockState (detail-page hook) we don't have `mayForceUnlock`; for
  // RowLockIndicator (list-page hook) we do. Fall back to the shared
  // userMayForceUnlock() walker when the prop didn't carry it through.
  const mayForceUnlock =
    "mayForceUnlock" in lockState && typeof lockState.mayForceUnlock === "boolean"
      ? lockState.mayForceUnlock
      : userMayForceUnlock(me);

  // Lock disables the button only when the user CAN'T override. Server-side
  // gate is still the authority — this just prevents the disabled-looking
  // button + 409 round-trip for users who clearly can't act on it.
  const lockDisables = lockState.isLocked && !mayForceUnlock;
  const lockTitle =
    lockDisables && lockState.lockedReason
      ? `Locked: ${lockState.lockedReason.replace(/_/g, " ")}`
      : undefined;

  return (
    <ActionButton
      {...rest}
      disabled={disabled || lockDisables}
      title={lockTitle ?? title}
    />
  );
}

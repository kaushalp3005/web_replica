"use client";

// C3 — Lock state banner for the JC operational tabs.
//
// Renders an amber/red banner above every operational form section (Output &
// Accounting, Quality, Annexures, Shifts, etc.) when the parent useLockState
// hook reports `isLocked === true`. The banner explains WHY the JC is locked
// (`locked_reason`) and — for admin / floor_manager / plant_manager /
// inventory_manager users — exposes a CTA that triggers the SAME
// `forceUnlockJc(authority, reason)` flow the page header's overflow ⋮ menu
// runs (passed in via the `onForceUnlockClick` prop — no more scroll-to-top
// deep link).
//
// Stable DOM id (C3-MED-1):
//   The banner renders with id=`jc-lock-banner-{jobCardId}` so disabled
//   operational form inputs can point `aria-describedby` at it. Use the
//   `lockBannerId(jcId)` / `lockProps(disabled, bannerId)` helpers exported
//   from _useLockState.ts to wire this consistently.
//
// Responsive contract (memory: web-replica-responsive-design):
//   - Full-width on mobile (default block layout); columns at sm: and lg:
//   - Text wraps on narrow screens; CTA stacks below message
//   - No fixed widths or overflow — the banner reflows cleanly at 360px

import { useEffect, useState } from "react";
import { userStore } from "@/lib/auth";
import { lockBannerId, userMayForceUnlock } from "./_useLockState";

export interface LockBannerProps {
  isLocked: boolean;
  lockedReason: string | null;
  status: string | null;
  /** Job card id — used to mint a stable DOM id for the banner so disabled
   *  form inputs can target it via `aria-describedby`. Optional so older
   *  callers don't break; when omitted the banner falls back to a non-id'd
   *  alert (still announced to AT via role/aria-live). */
  jcId?: number | string;
  /** Triggers the SAME force-unlock RPC the OverflowMenu uses
   *  (prompts for authority + reason, then PUTs /force-unlock). Required
   *  for the CTA to function — when omitted, the CTA is hidden so we
   *  don't render a button that does nothing. */
  onForceUnlockClick?: () => void;
}

export function LockBanner({
  isLocked,
  lockedReason,
  status,
  jcId,
  onForceUnlockClick,
}: LockBannerProps) {
  // userStore.load() reads localStorage, so the first SSR pass and the
  // first client render disagree if we call it inline. Hold the result in
  // an effect-bootstrapped state to keep hydration consistent. Defer the
  // setState past the effect body via queueMicrotask — the project's lint
  // (react-hooks/set-state-in-effect) flags a synchronous setState inside
  // useEffect as a cascading-render risk.
  //
  // C3-MED-3: also subscribe to userStore so a role change mid-session
  // (e.g. an admin grants the operator inventory_manager while the JC is
  // open) flips the CTA visibility without a page reload.
  const [canUnlock, setCanUnlock] = useState(false);
  useEffect(() => {
    queueMicrotask(() => setCanUnlock(userMayForceUnlock(userStore.load())));
    const unsubscribe = userStore.subscribe((next) => {
      setCanUnlock(userMayForceUnlock(next));
    });
    return unsubscribe;
  }, []);

  if (!isLocked) return null;

  const reason = (lockedReason ?? "").trim();
  const reasonText = reason
    ? humaniseReason(reason)
    : "This job card is locked. Operational entries are disabled until it's unlocked.";
  const id = jcId != null ? lockBannerId(jcId) : undefined;

  // Hide the CTA when we don't have a handler — clicking a button that
  // does nothing is worse than not showing one. The OverflowMenu remains
  // discoverable from the page header.
  const showCta = canUnlock && typeof onForceUnlockClick === "function";

  return (
    <div
      id={id}
      role="alert"
      aria-live="polite"
      className={[
        // Mobile: stack message + CTA vertically, full-width. lg+: row.
        "mb-4 rounded-md border px-3 py-2 sm:px-4 sm:py-3",
        "bg-[#fdf3f1] border-[#f0c7be] text-[#b1361e]",
        "flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between",
      ].join(" ")}
    >
      <div className="flex items-start gap-2 min-w-0">
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          className="shrink-0 mt-0.5 fill-current"
        >
          <path d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 8V6a3 3 0 1 1 6 0v3H9Z" />
        </svg>
        <div className="min-w-0">
          <div className="text-[13px] sm:text-[14px] font-semibold leading-tight">
            Job card is locked
            {status ? (
              <span className="ml-2 text-[11px] font-normal text-[#9a393e] uppercase tracking-wide">
                · status: {status.replace(/_/g, " ")}
              </span>
            ) : null}
          </div>
          <p className="text-[12px] sm:text-[13px] mt-1 break-words">{reasonText}</p>
        </div>
      </div>
      {showCta ? (
        <div className="shrink-0 lg:pt-0.5">
          <button
            type="button"
            onClick={onForceUnlockClick}
            className={[
              "h-8 px-3 rounded-[2px] text-[12px] font-semibold border",
              "bg-white border-[#f0c7be] text-[#b1361e]",
              "hover:bg-[#fbeced] focus:outline-none focus:ring-1 focus:ring-[#b1361e]",
            ].join(" ")}
          >
            Force unlock
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Translate snake_case server reasons into operator-friendly copy. */
function humaniseReason(raw: string): string {
  switch (raw) {
    case "awaiting_previous_stage":
      return "Waiting on the previous stage to dispatch material. Forms will unlock automatically when the upstream JC dispatches.";
    case "qc_hold":
      return "On QC hold. Resolve the QC finding before resuming.";
    case "audit_hold":
      return "Held for audit review. Operational edits are paused.";
    case "amendment_in_progress":
      return "BOM / plan amendment under review. Edits are paused until the amendment is approved or rejected.";
    default:
      // Fallback: render the raw reason but make snake_case readable.
      return raw.replace(/_/g, " ");
  }
}

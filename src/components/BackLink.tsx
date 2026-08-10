"use client";

// Inline "‹ Back to {label}" link used at the top of every non-root page.
// Smart back: uses router.back() when there's same-tab history, otherwise
// pushes the parent route (deep-link / fresh-tab case). Matches the styling
// of the original inline back button on job-card/[id] and SoChrome's
// showBackToSoCreation block.

import { useRouter } from "next/navigation";

interface BackLinkProps {
  /** Fallback route when there is no in-app history (deep link). */
  parentHref: string;
  /** Renders as "Back to {label}". */
  label: string;
  /** Extra classes appended after the defaults. */
  className?: string;
}

export function BackLink({ parentHref, label, className }: BackLinkProps) {
  const router = useRouter();

  function onClick() {
    // window.history.length > 1 is the same heuristic the existing inline
    // buttons use. Imperfect (a fresh tab can show length 1 even after an
    // initial nav), but matches site-wide behavior and avoids the complexity
    // of a custom history stack.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push(parentHref);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Back to ${label}`}
      className={[
        "inline-flex items-center gap-1.5 h-7 px-2 -ml-2 text-[12px] text-[var(--aws-link)] hover:underline",
        className ?? "",
      ].join(" ").trim()}
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </svg>
      Back to {label}
    </button>
  );
}

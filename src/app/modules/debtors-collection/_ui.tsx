"use client";

// Shared pieces for the DPD view: the age-bucket colours, the stacked ageing
// bar the summary, breakdown and phone cards all draw, and a small hover tip.

import { useCallback, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AGE_BUCKETS, compactInr, formatShare, hasDues, type AgeBucketKey, type Ageing } from "@/lib/debtors";

// Ordinal ramp for the four age buckets: one hue (the brand maroon, OKLCH
// h≈20), light → dark as the dues get older, so the order reads in the colour
// itself. Validated as an ordinal ramp against the white card surface:
// lightness monotone, adjacent steps ≥ 0.06 apart, lightest step 2.22:1.
// Change one step and re-check the set; never hand-pick a single swatch.
export const BUCKET_COLOR: Record<AgeBucketKey, string> = {
  lt30: "#dd9e9d",
  d30to60: "#cd7575",
  d60to90: "#b64e52",
  gt90: "#8a2e34",
};

/** Legend swatch — a small rect, mirroring the bar segments it keys. */
export function Swatch({ bucket }: { bucket: AgeBucketKey }) {
  return (
    <span
      aria-hidden
      className="inline-block w-2.5 h-2.5 rounded-[2px] shrink-0"
      style={{ backgroundColor: BUCKET_COLOR[bucket] }}
    />
  );
}

export function AgeLegend({ className = "" }: { className?: string }) {
  return (
    <ul
      aria-label="Age buckets"
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)] ${className}`}
    >
      {AGE_BUCKETS.map((b) => (
        <li key={b.key} className="flex items-center gap-1.5">
          <Swatch bucket={b.key} />
          {b.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Horizontal stacked bar of an ageing split. The segments are separated by a
 * 2px surface gap (never a stroke); the baseline end is square and the data
 * end rounded. A bucket too small to see still gets a 2px sliver, so a real
 * due never vanishes from the bar. Grows in from the left when it first mounts.
 */
export function AgeingBar({
  ageing,
  scale = 1,
  height = 10,
  focus = null,
  segmentProps,
  className = "",
}: {
  ageing: Ageing;
  /** Bar length against its track, 0–1: 1 for a part-to-whole bar,
   *  amount / largest amount when bars are compared across rows. */
  scale?: number;
  height?: number;
  /** Fade every other bucket, to echo a bucket the list is filtered to. */
  focus?: AgeBucketKey | null;
  segmentProps?: (bucket: AgeBucketKey) => HTMLAttributes<HTMLDivElement>;
  className?: string;
}) {
  const parts = AGE_BUCKETS.filter((b) => hasDues(ageing[b.key]));
  const sum = parts.reduce((s, b) => s + ageing[b.key], 0);
  const radius = Math.min(4, height / 2);
  const width = `${Math.max(0, Math.min(1, scale)) * 100}%`;
  if (parts.length === 0) return <div aria-hidden className={className} style={{ height }} />;
  return (
    <div
      className={`flex origin-left scale-x-100 transition-transform duration-700 ease-out starting:scale-x-0 motion-reduce:transition-none ${className}`}
      style={{ height, width, minWidth: 3 }}
    >
      {parts.map((b, i) => {
        const last = i === parts.length - 1;
        return (
          <div
            key={b.key}
            {...segmentProps?.(b.key)}
            className={`h-full min-w-[2px] transition-[opacity,filter] duration-200 hover:brightness-110 ${
              focus && focus !== b.key ? "opacity-30" : ""
            }`}
            style={{
              flexGrow: ageing[b.key] / sum,
              flexBasis: 0,
              marginLeft: i > 0 ? 2 : 0,
              backgroundColor: BUCKET_COLOR[b.key],
              borderTopRightRadius: last ? radius : 0,
              borderBottomRightRadius: last ? radius : 0,
            }}
          />
        );
      })}
    </div>
  );
}

// ── Hover tip ────────────────────────────────────────────────────────────────

export interface TipAnchor<K extends string> {
  key: K;
  /** Pointer x within the host, and the host's width (to keep the tip inside it). */
  x: number;
  width: number;
}

/** Mouse hover tracking for tips drawn inside a `relative` host marked with
 *  `data-tip-host`. Touch pointers are ignored on purpose: a tap is the row's
 *  click, and every value a tip shows is also on screen or in the table. */
export function useHoverTip<K extends string>() {
  const [tip, setTip] = useState<TipAnchor<K> | null>(null);
  const track = useCallback(
    (key: K) => ({
      onPointerMove(e: ReactPointerEvent<HTMLElement>) {
        if (e.pointerType !== "mouse") return;
        const host = e.currentTarget.closest<HTMLElement>("[data-tip-host]") ?? e.currentTarget;
        const r = host.getBoundingClientRect();
        setTip({ key, x: e.clientX - r.left, width: r.width });
      },
      onPointerLeave() {
        setTip((t) => (t && t.key === key ? null : t));
      },
    }),
    [],
  );
  return { tip, setTip, track };
}

const TIP_W = 224;

/** The tip box, beside the pointer and clamped inside its host. Hidden from
 *  assistive tech: what it says is also said by the row's label or the table. */
export function Tip({ at, top, children }: { at: { x: number; width: number }; top: number | string; children: ReactNode }) {
  const left = Math.max(0, Math.min(at.x + 14, at.width - TIP_W));
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 rounded-md border border-[var(--aws-border)] bg-white px-3 py-2 shadow-[0_4px_14px_rgba(0,28,36,0.18)]"
      style={{ left, top, width: TIP_W }}
    >
      {children}
    </div>
  );
}

/** Tip body for an ageing split: amounts lead, bucket names follow, each keyed
 *  by a short line of its colour. */
export function AgeingTipBody({ title, subtitle, ageing, total }: { title: string; subtitle?: string; ageing: Ageing; total: number }) {
  return (
    <>
      <p className="text-[12px] font-semibold text-[var(--text-primary)] truncate">{title}</p>
      {subtitle ? <p className="text-[11px] text-[var(--text-muted)]">{subtitle}</p> : null}
      <ul className="mt-1.5 space-y-1">
        {AGE_BUCKETS.map((b) => {
          const v = ageing[b.key];
          return (
            <li key={b.key} className="flex items-center gap-2 text-[11px]">
              <span className="h-[2px] w-3 rounded-full shrink-0" style={{ backgroundColor: BUCKET_COLOR[b.key] }} />
              <span className="min-w-[62px] font-semibold tabular-nums text-[var(--text-primary)]">
                {hasDues(v) ? compactInr(v) : "—"}
              </span>
              <span className="text-[var(--text-secondary)]">{b.label}</span>
              <span className="ml-auto tabular-nums text-[var(--text-muted)]">{hasDues(v) ? formatShare(v, total) : ""}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ── Small atoms ──────────────────────────────────────────────────────────────

/** A one-word remark ("LEGAL") is a flag; anything longer is a collection note. */
export function isFlag(text: string): boolean {
  return /^\S{1,12}$/.test(text);
}

/** A report remark: a flag reads as a badge, a note as text — cut to two lines
 *  in lists (the full note is on hover and in the call sheet). */
export function Remark({ text }: { text: string }) {
  if (!isFlag(text)) {
    return (
      // No `block` here: line-clamp sets its own display (-webkit-box), and block would undo it.
      <span className="mt-0.5 text-[11px] leading-[15px] font-normal text-[var(--text-secondary)] line-clamp-2" title={text}>
        {text}
      </span>
    );
  }
  return (
    <span className="ml-1.5 inline-block align-middle text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-sm bg-[#fce8e9] text-[#b0280e] whitespace-nowrap">
      {text}
    </span>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block text-[11px] font-medium px-1.5 py-0.5 rounded-sm bg-[var(--surface-divider)] text-[var(--text-secondary)] whitespace-nowrap">
      {children}
    </span>
  );
}

export function PhoneIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

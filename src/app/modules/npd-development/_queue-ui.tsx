"use client";

// Shared chrome for the NPD Development queues (requests + job cards).
//
// Both tables are `table-fixed` with no column widths: every column is an equal share
// of the shell's width, so the table can never grow a horizontal scrollbar and long
// values ellipsis instead. That trade only works because the cells that carry the most
// information open a hover panel with the full picture — which is what `Hover` is for.
// Keeping the pieces here rather than in either page is what stops the two queues from
// drifting apart on gridlines, gutters and hover behaviour.

import React from "react";

/** One definition of a queue cell's chrome, so every column gets the SAME gridline and
 *  the SAME gutter. An even grid is the point, and per-cell padding classes drift. */
export const CELL = "border border-[var(--surface-divider)] px-2";

/** Secondary value under a cell's primary one — these queues carry a lot of fields, and
 *  pairing the related ones keeps the number of columns sane. */
export function Sub({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="text-[11px] text-[var(--text-muted)] truncate" title={title}>{children}</div>
  );
}

/** Hover panel anchored to a cell.
 *
 *  Every text cell in these tables truncates, so the hover panel is how the full value
 *  stays reachable — a native `title` cannot render a list of articles or a labelled
 *  field grid. The trigger and the panel are SIBLINGS: the truncating element carries
 *  `overflow-hidden`, and anything nested inside it would be clipped away.
 *
 *  Anchored to the cell's LEFT edge and opening rightward, never centred: at a ninth of
 *  the table width a cell is ~137px, so a centred 360px panel would hang ~110px off the
 *  left of the first column and lose its labels. Every trigger lives in the leftmost
 *  columns, so opening rightward always has room.
 *
 *  `flip` opens upward — passed for the last rows on a page, so a hover near the bottom
 *  of a long queue never pushes the document taller.
 *
 *  Bounded to 60vh and scrollable, so a long card can never run off the screen. Three
 *  things have to hold together for that scroll to actually work:
 *    • pointer events are ON. A `pointer-events: none` panel passes the wheel straight
 *      through to whatever is underneath, so it can be capped but never scrolled.
 *    • there is NO gap between the trigger and the panel. The panel is out of flow, so
 *      a margin between them is dead space over neither element — the group stops being
 *      hovered mid-journey and the panel vanishes before the pointer arrives.
 *    • the click is swallowed, since the panel now sits over a row whose onClick opens
 *      the record; and `overscroll-contain` stops a flick at the end of the panel from
 *      scrolling the page behind it. */
export function Hover({ children, panel, flip }: {
  children: React.ReactNode; panel: React.ReactNode; flip?: boolean;
}) {
  return (
    <div className="relative group/hov">
      {children}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`invisible absolute left-0 z-30 opacity-0 transition-opacity
          group-hover/hov:visible group-hover/hov:opacity-100
          ${flip ? "bottom-full" : "top-full"}
          max-h-[60vh] overflow-y-auto overscroll-contain
          w-[360px] max-w-[86vw] rounded-md border border-[var(--aws-border-strong)]
          bg-white p-3 text-left shadow-lg`}
      >{panel}</div>
    </div>
  );
}

/** One labelled line inside a hover panel — for free-text values that need to wrap. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-[2px] text-[12px] leading-snug">
      <span className="w-[88px] shrink-0 text-[var(--text-muted)]">{label}</span>
      <span className="flex-1 text-[var(--text-primary)] break-words">{children}</span>
    </div>
  );
}

/** Two short scalars on one line. An entry panel holds ~16 fields; stacking every one
 *  of them made it taller than the viewport, and a panel you have to scroll to read is
 *  worse than the detail page it was meant to save you a trip to. */
export function Pair({ a, b }: { a: [string, React.ReactNode]; b?: [string, React.ReactNode] }) {
  const cell = (label: string, v: React.ReactNode) => (
    <div className="min-w-0 flex-1">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="truncate text-[12px] text-[var(--text-primary)]"
        title={typeof v === "string" ? v : undefined}>{v}</div>
    </div>
  );
  return (
    <div className="flex gap-3 py-[3px]">
      {cell(a[0], a[1])}
      {b ? cell(b[0], b[1]) : <div className="flex-1" />}
    </div>
  );
}

/** ISO timestamp → calendar date, blank when absent. */
export function day(v?: string | null): string {
  return v ? String(v).slice(0, 10) : "";
}

/** A multi-line native tooltip: the fields that don't earn a column of their own still
 *  have to be reachable without opening the record, so they ride the cell they belong to. */
export function joinLines(...parts: (string | null | undefined)[]): string {
  return parts.filter((x) => (x ?? "").toString().trim() !== "").join("\n");
}

/** Numeric value + its unit, for the article tables in the hover panels. */
export function qtyWithUom(q: unknown, uom?: string | null): string {
  if (q === null || q === undefined || q === "") return "—";
  return `${q} ${uom || "kg"}`;
}

/** The last rows on a page open their panels upward. Deterministic (no measurement), so
 *  it costs nothing per render. */
export function shouldFlip(index: number, total: number): boolean {
  return total > 4 && index >= total - 3;
}

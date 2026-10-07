"use client";

// Outstanding broken down by one text column: sales person for CD-CF, type or
// broker for APMC. One bar per group, its length the group's outstanding
// against the largest group and its segments the ageing split, so "who owes
// most" and "whose dues are oldest" read together. A row is also a filter:
// pressing it narrows the parties list to that group.

import { useMemo, useState, type FocusEvent } from "react";
import { compactInr, formatInr, groupParties, type DpdDimension, type DpdParty } from "@/lib/debtors";
import { AgeLegend, AgeingBar, AgeingTipBody, Tip, useHoverTip } from "./_ui";
import type { DimensionDef } from "./_sections";

const INITIAL_ROWS = 8;

// Phone: name + amount on one line, the bar under them. From sm up: name,
// party count, bar, amount — one line per group.
const ROW_GRID =
  "grid items-center gap-x-3 gap-y-1.5 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,13rem)_2.75rem_minmax(0,1fr)_5.5rem]";

export function BreakdownCard({
  parties,
  dimensions,
  dim,
  onDim,
  selected,
  onSelect,
}: {
  parties: readonly DpdParty[];
  dimensions: readonly DimensionDef[];
  dim: DpdDimension;
  onDim: (d: DpdDimension) => void;
  /** The group the list is filtered to in this dimension, if any. */
  selected: string | undefined;
  onSelect: (key: string) => void;
}) {
  const def = dimensions.find((d) => d.field === dim) ?? dimensions[0];
  const groups = useMemo(() => groupParties(parties, def.field, def.blank), [parties, def]);
  const [expanded, setExpanded] = useState(false);
  const { tip, setTip, track } = useHoverTip<string>();
  const max = groups[0]?.pending ?? 0;
  // A selected group past the fold stays visible.
  const selectedAt = groups.findIndex((g) => g.key === selected);
  const shown = expanded ? groups : groups.slice(0, Math.max(INITIAL_ROWS, selectedAt + 1));

  // Keyboard focus shows the same tip as hover; a mouse click's focus does not,
  // or the tip would stay pinned after the pointer has left.
  function tipOnFocus(e: FocusEvent<HTMLButtonElement>, key: string) {
    let keyboard = true;
    try {
      keyboard = e.currentTarget.matches(":focus-visible");
    } catch {
      // Engines without :focus-visible — treat every focus as keyboard focus.
    }
    if (!keyboard) return;
    const host = e.currentTarget.closest<HTMLElement>("[data-tip-host]") ?? e.currentTarget;
    const r = host.getBoundingClientRect();
    setTip({ key, x: r.width / 3, width: r.width });
  }

  return (
    <section
      aria-labelledby="dpd-breakdown-title"
      className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.12)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="dpd-breakdown-title" className="text-[14px] font-semibold text-[var(--text-primary)]">
          {def.title}
        </h2>
        {dimensions.length > 1 ? (
          <div role="group" aria-label="Break down by" className="inline-flex rounded-md border border-[var(--aws-border)] overflow-hidden text-[12px]">
            {dimensions.map((d) => (
              <button
                key={d.field}
                type="button"
                aria-pressed={d.field === def.field}
                onClick={() => onDim(d.field)}
                className={[
                  "px-3 py-1.5 transition-colors",
                  d.field === def.field
                    ? "bg-[var(--aws-navy)] text-white"
                    : "bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]",
                ].join(" ")}
              >
                {d.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <AgeLegend className="mt-2 mb-3" />

      <div aria-hidden className={`${ROW_GRID} hidden sm:grid px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]`}>
        <span>{def.label}</span>
        <span className="text-right">Parties</span>
        <span>Ageing</span>
        <span className="text-right">Outstanding</span>
      </div>

      <ul role="list" className="-mx-2 sm:mx-0">
        {shown.map((g) => {
          const on = selected === g.key;
          return (
            <li key={g.key || "\u0000blank"} data-tip-host className="relative">
              <button
                type="button"
                aria-pressed={on}
                aria-label={`${g.label}: ${formatInr(g.pending)} from ${g.count} ${g.count === 1 ? "party" : "parties"}, ${compactInr(g.ageing.gt90)} of it over 90 days`}
                onClick={() => onSelect(g.key)}
                {...track(g.key)}
                onFocus={(e) => tipOnFocus(e, g.key)}
                onBlur={() => setTip(null)}
                className={[
                  ROW_GRID,
                  "w-full text-left rounded-[4px] px-2 py-2 transition-colors duration-150",
                  on ? "bg-[#fdf6f6] shadow-[inset_3px_0_0_var(--aws-orange)]" : "hover:bg-[var(--surface-subtle)]",
                ].join(" ")}
              >
                <span className="col-start-1 row-start-1 flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">{g.label}</span>
                  <span className="sm:hidden shrink-0 text-[11px] text-[var(--text-muted)] tabular-nums">
                    {g.count} {g.count === 1 ? "party" : "parties"}
                  </span>
                </span>
                <span className="hidden sm:block sm:col-start-2 sm:row-start-1 text-right text-[12px] tabular-nums text-[var(--text-muted)]">
                  {g.count}
                </span>
                <span className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1 min-w-0">
                  <AgeingBar ageing={g.ageing} scale={max > 0 ? g.pending / max : 0} height={10} />
                </span>
                <span className="col-start-2 row-start-1 sm:col-start-4 text-right text-[13px] font-semibold tabular-nums text-[var(--text-primary)] whitespace-nowrap">
                  {compactInr(g.pending)}
                </span>
              </button>
              {tip && tip.key === g.key ? (
                <Tip at={tip} top="calc(100% - 4px)">
                  <AgeingTipBody
                    title={g.label}
                    subtitle={`${g.count} ${g.count === 1 ? "party" : "parties"} · ${formatInr(g.pending)}`}
                    ageing={g.ageing}
                    total={g.pending}
                  />
                </Tip>
              ) : null}
            </li>
          );
        })}
      </ul>

      {groups.length > INITIAL_ROWS ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 h-8 px-2 -ml-2 text-[12px] font-medium text-[var(--aws-link)] hover:underline"
        >
          {expanded ? "Show fewer" : `Show all ${groups.length}`}
        </button>
      ) : null}
    </section>
  );
}

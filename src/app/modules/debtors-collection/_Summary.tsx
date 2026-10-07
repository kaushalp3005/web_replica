"use client";

// Section summary: the total outstanding, its ageing split as one stacked bar,
// and a tile per age bucket. The tiles are the bar's legend and also a filter:
// pressing one narrows the parties list to the parties with dues in it.

import {
  AGE_BUCKETS, compactInr, formatAsOf, formatInr, formatShare, type AgeBucketKey, type DpdTotals,
} from "@/lib/debtors";
import { AgeingBar, Swatch, Tip, useHoverTip } from "./_ui";

export function SummaryCard({
  totals,
  asOf,
  source,
  bucket,
  onBucket,
}: {
  totals: DpdTotals;
  asOf: string | null;
  source: string | null;
  /** The bucket the list is filtered to, if any. */
  bucket: AgeBucketKey | null;
  onBucket: (b: AgeBucketKey | null) => void;
}) {
  const { tip, track } = useHoverTip<AgeBucketKey>();
  const asOfText = formatAsOf(asOf);
  const tipBucket = tip ? AGE_BUCKETS.find((b) => b.key === tip.key) : null;
  const barLabel = `Ageing split of the total: ${AGE_BUCKETS.map(
    (b) => `${b.label} ${formatShare(totals.ageing[b.key], totals.pending)}`,
  ).join(", ")}`;

  return (
    <section
      aria-label="Summary"
      className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.12)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-[var(--text-secondary)]">Total outstanding</p>
          <p className="mt-1.5 text-[28px] sm:text-[34px] leading-none font-semibold tracking-tight text-[var(--text-primary)]">
            {formatInr(totals.pending)}
          </p>
          <p className="mt-2 text-[12px] sm:text-[13px] text-[var(--text-secondary)]">
            {totals.count} {totals.count === 1 ? "party" : "parties"}
            {totals.pending > 0 ? (
              <>
                {" · "}
                <span className="font-semibold text-[var(--text-primary)]">
                  {formatShare(totals.ageing.gt90, totals.pending)}
                </span>{" "}
                over 90 days
              </>
            ) : null}
          </p>
        </div>
        {asOfText || source ? (
          <p className="text-[12px] text-[var(--text-secondary)] sm:text-right">
            {asOfText ? (
              <>
                As on <span className="font-semibold text-[var(--text-primary)]">{asOfText}</span>
              </>
            ) : (
              // Never guess a date: a report without one says so.
              "Report date not given"
            )}
            {source ? (
              <span className="block max-w-[280px] truncate text-[11px] text-[var(--text-muted)]" title={source}>
                {source}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      <div data-tip-host role="img" aria-label={barLabel} className="relative mt-4">
        <AgeingBar ageing={totals.ageing} height={14} focus={bucket} segmentProps={track} />
        {tip && tipBucket ? (
          <Tip at={tip} top={22}>
            <p className="text-[11px] text-[var(--text-secondary)]">{tipBucket.label}</p>
            <p className="text-[14px] font-semibold tabular-nums text-[var(--text-primary)]">
              {formatInr(totals.ageing[tip.key])}
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              {formatShare(totals.ageing[tip.key], totals.pending)} of the total · {totals.counts[tip.key]}{" "}
              {totals.counts[tip.key] === 1 ? "party" : "parties"}
            </p>
          </Tip>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        {AGE_BUCKETS.map((b) => {
          const amount = totals.ageing[b.key];
          const count = totals.counts[b.key];
          const on = bucket === b.key;
          return (
            <button
              key={b.key}
              type="button"
              aria-pressed={on}
              disabled={count === 0}
              onClick={() => onBucket(on ? null : b.key)}
              title={on ? "Show every party again" : "Show only the parties with dues in this bucket"}
              className={[
                "text-left rounded-md border px-3 py-2.5 transition-[border-color,background-color,box-shadow] duration-150 disabled:opacity-60 disabled:cursor-default",
                on
                  ? "border-[var(--aws-orange)] bg-[#fdf6f6] shadow-[0_0_0_1px_var(--aws-orange)]"
                  : "border-[var(--aws-border)] bg-white enabled:hover:border-[var(--aws-border-strong)] enabled:hover:bg-[var(--surface-subtle)]",
              ].join(" ")}
            >
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                <Swatch bucket={b.key} />
                {b.label}
              </span>
              <span className="mt-1 block text-[17px] sm:text-[19px] font-semibold text-[var(--text-primary)]">
                {compactInr(amount)}
              </span>
              <span className="mt-0.5 block text-[11px] text-[var(--text-muted)]">
                {formatShare(amount, totals.pending)} · {count} {count === 1 ? "party" : "parties"}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

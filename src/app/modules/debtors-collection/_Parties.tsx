"use client";

// The parties list: one filter row, then a sortable table on wide screens and
// one card per party below xl. The APMC table needs ~1,100px before its
// columns stop overflowing, and below that the ones that scroll out of view are
// the oldest buckets — the ones that matter most. `hidden xl:block` /
// `xl:hidden` keep exactly one of the two in the accessibility tree. The count
// line and the table footer total exactly the rows shown, so a filtered view
// never borrows the section total.

import { useMemo, useState, type RefObject } from "react";
import {
  AGE_BUCKETS, compactInr, dimensionValue, formatInr, groupParties, hasDues, isFiltered, sortParties, totalsOf,
  NO_FILTER, type AgeBucketKey, type DpdExcludedGroup, type DpdFilter, type DpdParty, type DpdSortKey, type SortDir,
} from "@/lib/debtors";
import { AgeingBar, PhoneIcon, Pill, Remark, Swatch } from "./_ui";
import { CallDialog } from "./_CallDialog";
import type { DimensionDef } from "./_sections";

export interface SortState {
  key: DpdSortKey;
  dir: SortDir;
}

const FIELD =
  "h-9 w-full px-3 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[var(--aws-orange)] focus:shadow-[0_0_0_1px_var(--aws-orange)]";
const LABEL = "block text-[11px] font-medium text-[var(--text-secondary)] mb-1";
const CARD_PAGE = 30;

const NUMERIC_SORTS: { key: DpdSortKey; label: string }[] = [
  { key: "pending", label: "Outstanding" },
  ...AGE_BUCKETS.map((b) => ({ key: b.key as DpdSortKey, label: b.label })).reverse(),
];

function isNumericSort(k: DpdSortKey): boolean {
  return NUMERIC_SORTS.some((s) => s.key === k);
}

function Amount({ n }: { n: number }) {
  return hasDues(n) ? <>{formatInr(n)}</> : <span className="text-[var(--text-disabled)]">—</span>;
}

function DimensionText({ def, party }: { def: DimensionDef; party: DpdParty }) {
  const v = dimensionValue(party, def.field);
  if (!v) return <span className="text-[var(--text-disabled)]">—</span>;
  return def.pill ? <Pill>{v}</Pill> : <>{v}</>;
}

/** Opens the call sheet for one party. Outlined, so a column of them stays quiet
 *  until hovered; the accessible name carries the party, not just "Call now". */
function CallNowButton({ party, onCall, size }: { party: DpdParty; onCall: (p: DpdParty) => void; size: "sm" | "md" }) {
  return (
    <button
      type="button"
      onClick={() => onCall(party)}
      aria-label={`Call now: ${party.customer}`}
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded-[2px] border border-[var(--aws-orange)] bg-white font-semibold text-[var(--aws-orange)] whitespace-nowrap transition-colors hover:bg-[var(--aws-orange)] hover:text-white",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-9 px-3.5 text-[13px]",
      ].join(" ")}
    >
      <PhoneIcon className="w-3.5 h-3.5" />
      Call now
    </button>
  );
}

export function PartiesList({
  anchorRef,
  all,
  rows,
  dimensions,
  searchPlaceholder,
  filter,
  onFilter,
  onBucket,
  sort,
  onSort,
}: {
  /** Scrolled to when a breakdown row narrows the list. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Every party in the section — the filter options come from these. */
  all: readonly DpdParty[];
  /** The parties to show, already filtered and sorted. */
  rows: readonly DpdParty[];
  dimensions: readonly DimensionDef[];
  searchPlaceholder: string;
  filter: DpdFilter;
  onFilter: (f: DpdFilter) => void;
  onBucket: (b: AgeBucketKey | null) => void;
  sort: SortState;
  onSort: (s: SortState) => void;
}) {
  const totals = useMemo(() => totalsOf(rows), [rows]);
  const filtered = isFiltered(filter);
  // Stable per-party keys for the whole section, whatever the sort.
  const keyOf = useMemo(() => new Map(all.map((p, i) => [p, i])), [all]);
  // The card list keeps its own "show more" count; a new filter starts it over.
  const filterKey = JSON.stringify([filter, sort]);
  const [calling, setCalling] = useState<DpdParty | null>(null);

  return (
    <section
      ref={anchorRef}
      aria-labelledby="dpd-parties-title"
      className="scroll-mt-4 bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.12)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
        <h2 id="dpd-parties-title" className="text-[14px] font-semibold text-[var(--text-primary)]">Parties</h2>
        <p aria-live="polite" className="text-[12px] text-[var(--text-secondary)] tabular-nums">
          {filtered ? (
            <>
              Showing <span className="font-semibold text-[var(--text-primary)]">{rows.length}</span> of {all.length}
            </>
          ) : (
            <>{all.length} parties</>
          )}
          {" · "}
          <span className="font-semibold text-[var(--text-primary)]">{compactInr(totals.pending)}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 sm:gap-3 mb-4">
        <div className="w-full sm:w-auto sm:flex-1 sm:min-w-[220px] sm:max-w-[340px]">
          <label htmlFor="dpd-search" className={LABEL}>Search</label>
          <input
            id="dpd-search"
            type="search"
            value={filter.search}
            onChange={(e) => onFilter({ ...filter, search: e.target.value })}
            placeholder={searchPlaceholder}
            autoComplete="off"
            className={FIELD}
          />
        </div>
        {dimensions.map((d) => (
          <DimensionSelect
            key={d.field}
            def={d}
            all={all}
            value={filter.dims[d.field]}
            onChange={(v) => onFilter({ ...filter, dims: { ...filter.dims, [d.field]: v } })}
          />
        ))}
        <div className="flex-1 min-w-[140px] sm:flex-none sm:w-[170px]">
          <label htmlFor="dpd-age" className={LABEL}>Ageing</label>
          <select
            id="dpd-age"
            value={filter.bucket ?? ""}
            onChange={(e) => onBucket((e.target.value || null) as AgeBucketKey | null)}
            className={FIELD}
          >
            <option value="">All ages</option>
            {AGE_BUCKETS.map((b) => (
              <option key={b.key} value={b.key}>Dues {b.label}</option>
            ))}
          </select>
        </div>
        {/* Min widths are sized so Ageing + Sort share a row inside a 390px phone's card. */}
        <SortSelect className="xl:hidden flex-1 min-w-[160px] sm:flex-none sm:w-[220px]" dimensions={dimensions} sort={sort} onSort={onSort} />
        {filtered ? (
          <button
            type="button"
            onClick={() => onFilter(NO_FILTER)}
            className="h-9 px-2 text-[13px] font-medium text-[var(--aws-link)] hover:underline"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--aws-border-strong)] py-10 px-4 text-center">
          <p className="text-[13px] text-[var(--text-secondary)]">No parties match these filters.</p>
          <button
            type="button"
            onClick={() => onFilter(NO_FILTER)}
            className="mt-2 text-[13px] font-medium text-[var(--aws-link)] hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <PartiesTable
            rows={rows}
            totals={totals}
            keyOf={keyOf}
            dimensions={dimensions}
            bucket={filter.bucket}
            sort={sort}
            onSort={onSort}
            onCall={setCalling}
          />
          <PartyCards
            key={filterKey}
            rows={rows}
            keyOf={keyOf}
            dimensions={dimensions}
            bucket={filter.bucket}
            onCall={setCalling}
          />
        </>
      )}
      <CallDialog party={calling} dimensions={dimensions} onClose={() => setCalling(null)} />
    </section>
  );
}

function DimensionSelect({
  def,
  all,
  value,
  onChange,
}: {
  def: DimensionDef;
  all: readonly DpdParty[];
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  // A to Z reads better in a dropdown than the breakdown's by-amount order;
  // the parties with no value go last.
  const options = useMemo(
    () =>
      groupParties(all, def.field, def.blank).sort(
        (a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.label.localeCompare(b.label, "en-IN", { sensitivity: "base" }),
      ),
    [all, def],
  );
  const id = `dpd-dim-${def.field}`;
  return (
    <div className="flex-1 min-w-[150px] sm:flex-none sm:w-[190px]">
      <label htmlFor={id} className={LABEL}>{def.label}</label>
      {/* "v:" prefixes a real value so the no-value group ("v:") can't collide with "All". */}
      <select
        id={id}
        value={value === undefined ? "all" : `v:${value}`}
        onChange={(e) => onChange(e.target.value === "all" ? undefined : e.target.value.slice(2))}
        className={FIELD}
      >
        <option value="all">All</option>
        {options.map((o) => (
          <option key={o.key || "\u0000blank"} value={`v:${o.key}`}>
            {o.label} ({o.count})
          </option>
        ))}
      </select>
    </div>
  );
}

function SortSelect({
  className,
  dimensions,
  sort,
  onSort,
}: {
  className: string;
  dimensions: readonly DimensionDef[];
  sort: SortState;
  onSort: (s: SortState) => void;
}) {
  const options: { value: string; label: string }[] = [
    ...NUMERIC_SORTS.flatMap((s) => [
      { value: `${s.key}:desc`, label: `${s.label}, high to low` },
      { value: `${s.key}:asc`, label: `${s.label}, low to high` },
    ]),
    { value: "customer:asc", label: "Customer, A to Z" },
    { value: "customer:desc", label: "Customer, Z to A" },
    ...dimensions.flatMap((d) => [
      { value: `${d.field}:asc`, label: `${d.label}, A to Z` },
      { value: `${d.field}:desc`, label: `${d.label}, Z to A` },
    ]),
  ];
  return (
    <div className={className}>
      <label htmlFor="dpd-sort" className={LABEL}>Sort by</label>
      <select
        id="dpd-sort"
        value={`${sort.key}:${sort.dir}`}
        onChange={(e) => {
          const [key, dir] = e.target.value.split(":") as [DpdSortKey, SortDir];
          onSort({ key, dir });
        }}
        className={FIELD}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── Wide screens: the table ──────────────────────────────────────────────────

// The wrapper is the scroll container (capped height) so the header and the
// totals row can stick to its edges while the rows scroll between them.
const TH =
  "sticky top-0 z-10 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] whitespace-nowrap shadow-[0_1px_0_var(--aws-border)]";
const TD = "px-3 py-2 border-t border-[var(--surface-divider)] align-middle";
const TD_NUM = `${TD} text-right tabular-nums whitespace-nowrap`;
const TF =
  "sticky bottom-0 z-10 bg-[#f6f7f7] px-3 py-2.5 text-[12px] font-semibold text-[var(--text-primary)] shadow-[0_-1px_0_var(--aws-border)] whitespace-nowrap";
const TF_NUM = `${TF} text-right tabular-nums`;
const FOCUS_TINT = "bg-[#fdf6f6]";

function PartiesTable({
  rows,
  totals,
  keyOf,
  dimensions,
  bucket,
  sort,
  onSort,
  onCall,
}: {
  rows: readonly DpdParty[];
  totals: ReturnType<typeof totalsOf>;
  keyOf: Map<DpdParty, number>;
  dimensions: readonly DimensionDef[];
  bucket: AgeBucketKey | null;
  sort: SortState;
  onSort: (s: SortState) => void;
  onCall: (p: DpdParty) => void;
}) {
  const header = (key: DpdSortKey, label: string, align: "left" | "right", swatch?: AgeBucketKey) => {
    const active = sort.key === key;
    const next: SortState = active
      ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
      : { key, dir: isNumericSort(key) ? "desc" : "asc" };
    return (
      <th
        key={key}
        scope="col"
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
        className={`${TH} ${align === "right" ? "text-right" : "text-left"} ${swatch && swatch === bucket ? "bg-[#fbeeee]" : "bg-[var(--surface-subtle)]"}`}
      >
        <button
          type="button"
          onClick={() => onSort(next)}
          className={`group inline-flex items-center gap-1.5 uppercase tracking-wide hover:text-[var(--text-primary)] ${
            active ? "text-[var(--text-primary)]" : ""
          }`}
        >
          {swatch ? <Swatch bucket={swatch} /> : null}
          {label}
          <svg
            aria-hidden
            viewBox="0 0 10 10"
            className={`w-2.5 h-2.5 transition-[opacity,transform] ${
              active ? "opacity-100" : "opacity-0 group-hover:opacity-40"
            } ${active && sort.dir === "asc" ? "rotate-180" : ""}`}
          >
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </th>
    );
  };

  return (
    <div className="hidden xl:block overflow-auto max-h-[70vh] rounded-md border border-[var(--aws-border)]">
      <table className="w-full text-[13px] border-collapse">
        <caption className="sr-only">
          Parties with outstanding dues, split by age. Column headers sort the table.
        </caption>
        <thead>
          <tr>
            {header("customer", "Customer", "left")}
            {dimensions.map((d) => header(d.field, d.label, "left"))}
            {header("pending", "Outstanding", "right")}
            {AGE_BUCKETS.map((b) => header(b.key, b.label, "right", b.key))}
            <th scope="col" className={`${TH} bg-[var(--surface-subtle)] text-center`}>
              Call now
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={keyOf.get(p)} className="transition-colors hover:bg-[var(--surface-subtle)]">
              <td className={`${TD} min-w-[220px]`}>
                <span className="font-medium text-[var(--text-primary)]">{p.customer}</span>
                {p.remarks ? <Remark text={p.remarks} /> : null}
              </td>
              {/* Pills stay on one line; names may wrap (broker names run to 30+ characters). */}
              {dimensions.map((d) => (
                <td
                  key={d.field}
                  className={`${TD} text-[var(--text-secondary)] ${d.pill ? "whitespace-nowrap" : "min-w-[110px] max-w-[190px]"}`}
                >
                  <DimensionText def={d} party={p} />
                </td>
              ))}
              <td className={`${TD_NUM} font-semibold text-[var(--text-primary)]`}>{formatInr(p.pending)}</td>
              {AGE_BUCKETS.map((b) => (
                <td key={b.key} className={`${TD_NUM} text-[var(--text-primary)] ${bucket === b.key ? FOCUS_TINT : ""}`}>
                  <Amount n={p.ageing[b.key]} />
                </td>
              ))}
              <td className={`${TD} text-center`}>
                <CallNowButton party={p} onCall={onCall} size="sm" />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className={TF}>
              Total · {rows.length} {rows.length === 1 ? "party" : "parties"}
            </td>
            {dimensions.map((d) => (
              <td key={d.field} className={TF} />
            ))}
            <td className={TF_NUM}>{formatInr(totals.pending)}</td>
            {AGE_BUCKETS.map((b) => (
              <td key={b.key} className={TF_NUM}>
                {formatInr(totals.ageing[b.key])}
              </td>
            ))}
            <td className={TF} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Below xl: one card per party ─────────────────────────────────────────────

function PartyCards({
  rows,
  keyOf,
  dimensions,
  bucket,
  onCall,
}: {
  rows: readonly DpdParty[];
  keyOf: Map<DpdParty, number>;
  dimensions: readonly DimensionDef[];
  bucket: AgeBucketKey | null;
  onCall: (p: DpdParty) => void;
}) {
  const [limit, setLimit] = useState(CARD_PAGE);
  const shown = rows.slice(0, limit);
  const left = rows.length - shown.length;

  return (
    <div className="xl:hidden">
      <ul role="list" aria-label="Parties" className="grid gap-2 sm:grid-cols-2">
        {shown.map((p) => {
          const id = `dpd-party-${keyOf.get(p)}`;
          const meta = dimensions.map((d) => dimensionValue(p, d.field)).filter(Boolean).join(" · ");
          return (
            <li
              key={keyOf.get(p)}
              role="listitem"
              aria-labelledby={id}
              className="rounded-md border border-[var(--aws-border)] bg-white px-3.5 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p id={id} className="text-[13px] font-semibold leading-[18px] text-[var(--text-primary)] break-words">
                    {p.customer}
                    {p.remarks ? <Remark text={p.remarks} /> : null}
                  </p>
                  {meta ? <p className="mt-0.5 text-[11px] text-[var(--text-muted)] break-words">{meta}</p> : null}
                </div>
                <p className="shrink-0 text-right text-[14px] font-semibold tabular-nums text-[var(--text-primary)]">
                  {formatInr(p.pending)}
                </p>
              </div>
              <AgeingBar ageing={p.ageing} height={6} focus={bucket} className="mt-2.5" />
              <dl className="mt-2 grid grid-cols-4 gap-1.5">
                {AGE_BUCKETS.map((b) => {
                  const v = p.ageing[b.key];
                  return (
                    <div key={b.key} className={`min-w-0 rounded-[3px] px-1 py-0.5 ${bucket === b.key ? FOCUS_TINT : ""}`}>
                      <dt className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                        <Swatch bucket={b.key} />
                        {b.short}
                      </dt>
                      <dd className="text-[12px] tabular-nums text-[var(--text-primary)] truncate" title={hasDues(v) ? formatInr(v) : undefined}>
                        {hasDues(v) ? compactInr(v) : <span className="text-[var(--text-disabled)]">—</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <div className="mt-2.5 pt-2.5 border-t border-[var(--surface-divider)] flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[12px] tabular-nums text-[var(--text-secondary)]" title={p.phone ?? undefined}>
                  {p.phone ?? ""}
                </span>
                <CallNowButton party={p} onCall={onCall} size="md" />
              </div>
            </li>
          );
        })}
      </ul>
      {left > 0 ? (
        <button
          type="button"
          onClick={() => setLimit((n) => n + CARD_PAGE)}
          className="mt-3 w-full h-10 rounded-md border border-[var(--aws-border)] bg-white text-[13px] font-medium text-[var(--aws-link)] hover:bg-[var(--surface-subtle)]"
        >
          Show {Math.min(CARD_PAGE, left)} more · {left} left
        </button>
      ) : null}
    </div>
  );
}

// ── Parties the report leaves out ───────────────────────────────────────────

/** A collapsed list of parties the report keeps out of its totals — one sheet
 *  of the workbook ("LEGAL", "write off", "Before APMC outlet" …) — with the
 *  report's reason when the whole sheet shares one. */
export function ExcludedParties({ group }: { group: DpdExcludedGroup }) {
  const total = useMemo(() => totalsOf(group.parties).pending, [group]);
  const sorted = useMemo(() => sortParties(group.parties, "pending", "desc"), [group]);
  return (
    <details className="group/ex bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.12)]">
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-md px-4 sm:px-5 py-3.5 hover:bg-[var(--surface-subtle)] [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="mt-[3px] w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-200 group-open/ex:rotate-90"
        >
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-[var(--text-primary)]">{group.title}</span>
          <span className="block mt-0.5 text-[12px] text-[var(--text-secondary)]">
            {group.parties.length} {group.parties.length === 1 ? "party" : "parties"}, not counted in the totals above
            {group.note ? ` — ${group.note}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">{formatInr(total)}</span>
      </summary>
      <ul role="list" className="border-t border-[var(--aws-border)] divide-y divide-[var(--surface-divider)]">
        {sorted.map((p, i) => (
          <li key={i} className="flex items-center gap-3 px-4 sm:px-5 py-2 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[var(--text-primary)]" title={p.customer}>{p.customer}</span>
              {p.remarks && p.remarks !== group.note ? <Remark text={p.remarks} /> : null}
            </span>
            {p.type ? (
              <span className="hidden sm:inline">
                <Pill>{p.type}</Pill>
              </span>
            ) : null}
            <span className="w-[108px] shrink-0 text-right tabular-nums font-medium text-[var(--text-primary)]">
              {formatInr(p.pending)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

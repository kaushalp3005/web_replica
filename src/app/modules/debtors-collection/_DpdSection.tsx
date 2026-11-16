"use client";

// One DPD section: the summary, the breakdown and the parties list. Owns the
// section's filter and sort; the page remounts it per section, so each tab
// opens unfiltered.
//
// The filter row sits directly above the list it scopes. The summary and the
// breakdown always show the whole section; their tiles and rows are shortcuts
// that set the list's filter, not filters of their own.

import { useMemo, useRef, useState } from "react";
import {
  filterParties, sortParties, totalsOf, NO_FILTER, type AgeBucketKey, type DpdDimension, type DpdFilter, type DpdParty,
  type DpdReport,
} from "@/lib/debtors";
import { SummaryCard } from "./_Summary";
import { BreakdownCard } from "./_Breakdown";
import { PartiesList, type SortState } from "./_Parties";
import { prefersReducedMotion } from "./_ui";
import type { SectionDef } from "./_sections";

const DEFAULT_SORT: SortState = { key: "pending", dir: "desc" };

export function DpdSection({
  report,
  def,
  onPartyChange,
}: {
  report: DpdReport;
  def: SectionDef;
  /** A party was edited on this screen: swap `before` for `after` in the report. */
  onPartyChange: (before: DpdParty, after: DpdParty) => void;
}) {
  const [filter, setFilter] = useState<DpdFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [breakdownBy, setBreakdownBy] = useState<DpdDimension>(def.defaultBreakdown ?? def.dimensions[0].field);
  const listRef = useRef<HTMLElement>(null);

  const totals = useMemo(() => totalsOf(report.parties), [report]);
  const rows = useMemo(
    () => sortParties(filterParties(report.parties, filter), sort.key, sort.dir),
    [report, filter, sort],
  );

  // Narrowing to a bucket also sorts by it, so the biggest dues in that bucket
  // come first; clearing it drops a sort that only made sense with the filter.
  function setBucket(b: AgeBucketKey | null) {
    setFilter((f) => ({ ...f, bucket: b }));
    if (b) setSort({ key: b, dir: "desc" });
    else if (sort.key === filter.bucket) setSort(DEFAULT_SORT);
  }

  function setFilterAndSort(f: DpdFilter) {
    if (f.bucket !== filter.bucket) setBucket(f.bucket);
    setFilter(f);
  }

  // A breakdown row toggles that group as the list's filter and brings the
  // list into view — on a phone it is a long way below the breakdown.
  function selectGroup(key: string) {
    const selecting = filter.dims[breakdownBy] !== key;
    setFilter((f) => ({ ...f, dims: { ...f.dims, [breakdownBy]: selecting ? key : undefined } }));
    if (selecting) {
      listRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    }
  }

  return (
    <div className="space-y-4">
      <SummaryCard
        totals={totals}
        loadedAt={report.loadedAt}
        bucket={filter.bucket}
        onBucket={setBucket}
      />
      <BreakdownCard
        parties={report.parties}
        dimensions={def.dimensions}
        dim={breakdownBy}
        onDim={setBreakdownBy}
        selected={filter.dims[breakdownBy]}
        onSelect={selectGroup}
      />
      <PartiesList
        anchorRef={listRef}
        section={report.section}
        onPartyChange={onPartyChange}
        all={report.parties}
        rows={rows}
        dimensions={def.dimensions}
        searchPlaceholder={def.searchPlaceholder}
        filter={filter}
        onFilter={setFilterAndSort}
        onBucket={setBucket}
        sort={sort}
        onSort={setSort}
      />
    </div>
  );
}

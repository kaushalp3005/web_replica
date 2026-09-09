"use client";

// Overview — the module's roll-up, ported from the Stock Take app's summary
// page (Stock_Take/frontend_st/pages/AllEntriesSummary.tsx).
//
// Same shape as that page, deliberately: a Totals TABLE rather than tinted
// tiles (figures line up on tabular numerals and read down a column), a sub-tab
// bar under it, a Table/Chart toggle, and horizontal bars sized against the
// largest row so small values stay visible while every row still prints its own
// figure. Its Warehouses/Categories tabs become Godowns/Groups here.
//
// TWO THINGS THAT COULD NOT BE PORTED AS-IS
//
// 1. QUANTITY IS NOT SUMMABLE. The floor app adds kilograms all the way down
//    one column. This module's leaves span UOM classes (416 kg rows, 273 nos
//    rows live), and adding them makes a number that means nothing. So every
//    comparison — share %, bar length, ranking — is on `value_indicative`,
//    which IS additive, and quantity is always shown broken out per UOM.
//
// 2. THE GROUP NAMES ARE NOT CANONICAL. The legacy feed carries "packaging"
//    (180 rows) and "Packaging" (93) as separate values, and the same for
//    dates/DATES and miscellaneous - rm/MISCELLANEOUS - RM. Grouping on the raw
//    string would list one real group two or three times and split its totals.
//    Rows are folded case-insensitively; the label shown is the most common
//    spelling, and a group folded from several spellings says so.
//
// The AI Insights tab is not ported: it calls the floor app's own analysis
// endpoint, which has no counterpart here.

import { useMemo, useState } from "react";
import type { LeafItem } from "@/lib/ledger";
import { useLedgerLeaves, ENTITY_LABELS } from "./_LedgerData";
import { canonName, filterLeaves, grandSubtotals } from "./_tree";
import { LedgerDateFilter } from "./_DateFilter";
import {
  ExportBar, SectionTabs, TableShell, thCls, tdCls,
  fmtQty, fmtVal, fmtInt, uomDp, UomBadge, type ExportSpec, type TabDef,
} from "./_ui";

// Verbatim from _StockSummary.tsx:181 and _CompanyViews.tsx:16 — the module's
// filter controls all look the same, and this tab's must not be the exception.
const selCls = "border border-[var(--aws-border)] rounded-[8px] px-[9px] py-[5px] text-[11px] bg-white font-mono text-[var(--text-primary)]";

type SubTab = "overview" | "godowns" | "groups";
type ViewMode = "table" | "chart";

const SUB_TABS: TabDef[] = [
  { key: "overview", label: "Overview" },
  { key: "godowns", label: "Godowns" },
  { key: "groups", label: "Groups" },
];

/** Horizontal bars — the chart-view counterpart of a table.
 *
 *  Ported from the floor app's BarRows. Bars are sized against the largest row
 *  so small values stay visible, and every row still prints its own figure, so
 *  nothing here is readable only by eye. */
function BarRows({ rows }: { rows: { name: string; value: number; label: string }[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  if (rows.length === 0) {
    return <p className="text-[12.5px] text-[var(--text-secondary)] m-0">No data.</p>;
  }
  return (
    <div className="flex flex-col gap-[10px]">
      {rows.map((r) => (
        <div key={r.name}>
          <div className="flex items-baseline justify-between gap-3 mb-[3px]">
            <span className="text-[12.5px] text-[var(--text-primary)] truncate" title={r.name}>{r.name}</span>
            <span className="font-mono text-[11px] text-[var(--text-secondary)] tabular-nums whitespace-nowrap">{r.label}</span>
          </div>
          <div
            className="h-[9px] rounded-[5px] bg-[var(--surface-subtle)] overflow-hidden"
            role="img"
            aria-label={`${r.name}: ${r.label}`}
          >
            <div className="h-full rounded-[5px] bg-[var(--aws-orange)]"
                 style={{ width: `${Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-[9px] flex items-baseline gap-2 flex-wrap">
      {children}
      {note && <span className="font-mono text-[10.5px] font-normal text-[var(--text-muted)]">{note}</span>}
    </h2>
  );
}

function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="inline-flex rounded-[7px] border border-[var(--aws-border)] overflow-hidden" role="group" aria-label="Data presentation">
      {(["table", "chart"] as ViewMode[]).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => onChange(m)}
          className={`font-mono text-[11px] px-[11px] py-[5px] ${
            mode === m ? "bg-[var(--aws-navy)] text-white" : "bg-white text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {m === "table" ? "Table" : "Chart"}
        </button>
      ))}
    </div>
  );
}

/** Per-UOM quantities for a set of leaves, rendered on one line.
 *
 *  Never a single total: "3,225,826 kg + 30,703 nos" is two facts, and adding
 *  them would be a third that is not true. */
function QtyByUom({ leaves }: { leaves: LeafItem[] }) {
  const subs = useMemo(() => grandSubtotals(leaves).filter((s) => s.closing_qty !== 0), [leaves]);
  if (subs.length === 0) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-[2px] justify-end">
      {subs.map((s) => (
        <span key={s.uom_class} className="tabular-nums whitespace-nowrap">
          {fmtQty(s.closing_qty, uomDp(s.uom_class))} <UomBadge uom={s.uom_class} />
        </span>
      ))}
    </span>
  );
}

interface Bucket {
  key: string;
  label: string;
  leaves: LeafItem[];
  value: number;
  /** How many distinct raw spellings folded into this bucket. >1 is a data note. */
  variants: number;
}

/** Fold leaves into buckets on a case-insensitive key.
 *
 *  The displayed label is the spelling that appears on the most rows, so the
 *  bucket is named the way the data mostly names it rather than by whichever
 *  row happened to sort first. */
function bucketBy(leaves: LeafItem[], pick: (l: LeafItem) => string): Bucket[] {
  const acc = new Map<string, { spellings: Map<string, number>; leaves: LeafItem[]; value: number }>();
  for (const l of leaves) {
    const raw = (pick(l) || "").trim() || "(unlabelled)";
    const key = canonName(raw);
    let b = acc.get(key);
    if (!b) { b = { spellings: new Map(), leaves: [], value: 0 }; acc.set(key, b); }
    b.spellings.set(raw, (b.spellings.get(raw) ?? 0) + 1);
    b.leaves.push(l);
    b.value += Number(l.value_indicative) || 0;
  }
  return [...acc.entries()]
    .map(([key, b]) => ({
      key,
      label: [...b.spellings.entries()].sort((x, y) => y[1] - x[1])[0][0],
      leaves: b.leaves,
      value: b.value,
      variants: b.spellings.size,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function share(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "—";
}

/** One bucket table: label, rows, items, quantity per UOM, value, share. */
function BucketTable({
  buckets, total, head, mode, minW = 720,
}: {
  buckets: Bucket[]; total: number; head: string; mode: ViewMode; minW?: number;
}) {
  if (mode === "chart") {
    return (
      <BarRows
        rows={buckets.map((b) => ({
          name: b.label,
          value: b.value,
          label: `${fmtVal(b.value)} (${share(b.value, total)})`,
        }))}
      />
    );
  }
  return (
    <TableShell minW={minW}>
      <thead>
        <tr>
          <th className={thCls}>{head}</th>
          <th className={`${thCls} text-right`}>Rows</th>
          <th className={`${thCls} text-right`}>Items</th>
          <th className={`${thCls} text-right`}>Quantity</th>
          <th className={`${thCls} text-right`}>Value</th>
          <th className={`${thCls} text-right`}>Share</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.key} className="hover:bg-[var(--surface-subtle)]">
            <td className={tdCls}>
              {b.label}
              {b.variants > 1 && (
                // Says so rather than silently merging: the totals on this row
                // are the sum of names the source treats as different.
                <span className="ml-[6px] font-mono text-[10px] text-[var(--text-muted)]"
                      title={`Folded from ${b.variants} spellings of this name in the source data`}>
                  +{b.variants - 1} spelling{b.variants > 2 ? "s" : ""}
                </span>
              )}
            </td>
            <td className={`${tdCls} text-right tabular-nums text-[var(--text-secondary)]`}>{fmtInt(b.leaves.length)}</td>
            <td className={`${tdCls} text-right tabular-nums text-[var(--text-secondary)]`}>
              {fmtInt(new Set(b.leaves.map((l) => canonName(l.label))).size)}
            </td>
            <td className={`${tdCls} text-right`}><QtyByUom leaves={b.leaves} /></td>
            <td className={`${tdCls} text-right tabular-nums`}>{fmtVal(b.value)}</td>
            <td className={`${tdCls} text-right tabular-nums text-[var(--text-secondary)]`}>{share(b.value, total)}</td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

export function LedgerOverview({ onDrillGroup }: { onDrillGroup?: (key: string) => void }) {
  const { leaves, entity, source } = useLedgerLeaves();
  const [tab, setTab] = useState<SubTab>("overview");
  const [mode, setMode] = useState<ViewMode>("table");
  const [search, setSearch] = useState("");
  const [godown, setGodown] = useState("");
  const [uom, setUom] = useState<"" | "kg" | "nos" | "no">("");

  // The SAME filterLeaves the Stock Summary tab uses, so a godown means the
  // same thing on both and the two tabs cannot drift apart.
  const filtered = useMemo(
    () => filterLeaves(leaves, { q: search, godown, uom }),
    [leaves, search, godown, uom],
  );
  const filterOn = Boolean(search.trim() || godown || uom);

  // Dropdown options come from the UNFILTERED set. Deriving them from `filtered`
  // would leave the godown select holding only the godown already chosen, with
  // no way back to any other one.
  const godownOptions = useMemo(
    () => Array.from(new Set(leaves.map((l) => l.godown))).sort(), [leaves]);

  // EVERYTHING below is derived from `filtered`, never from `leaves`. A share %
  // whose denominator ignored the filter would not add up to 100 on screen.
  const godowns = useMemo(() => bucketBy(filtered, (l) => l.godown), [filtered]);
  const groups = useMemo(() => bucketBy(filtered, (l) => l.group), [filtered]);
  const types = useMemo(() => bucketBy(filtered, (l) => l.item_type), [filtered]);
  const entities = useMemo(() => bucketBy(filtered, (l) => l.entity), [filtered]);
  const totalValue = useMemo(
    () => filtered.reduce((s, l) => s + (Number(l.value_indicative) || 0), 0), [filtered]);
  const subtotals = useMemo(() => grandSubtotals(filtered), [filtered]);
  // Folded the same way the buckets are: counting raw labels inside buckets that
  // were folded case-insensitively would count spellings and overstate the total.
  const itemCount = useMemo(
    () => new Set(filtered.map((l) => canonName(l.label))).size, [filtered]);
  const unassigned = useMemo(
    () => filtered.filter((l) => (l.godown || "").trim().toUpperCase() === "UNASSIGNED"), [filtered]);

  const topItems = useMemo(() => bucketBy(filtered, (l) => l.label).slice(0, 10), [filtered]);

  // The filter goes in the filename AND in a row, because a spreadsheet outlives
  // the screen it came from: a filtered total with no scope on it is
  // unattributable the moment it is emailed on.
  const scope = [godown, uom && uom.toUpperCase(), search.trim() && `"${search.trim()}"`]
    .filter(Boolean).join(" · ");
  const exportSpec: ExportSpec = {
    filename: `ledger-overview-${entity}${filterOn ? "-filtered" : ""}`,
    sheet: "Overview",
    rows: () => [
      [`Scope: ${ENTITY_LABELS[entity]}${scope ? ` · ${scope}` : " · no filter"}`,
       `${filtered.length} of ${leaves.length} rows`, "", "", "", ""],
      ["Dimension", "Name", "Rows", "Items", "Value", "Share"],
      ...([
        ["Godown", godowns], ["Group", groups], ["Item type", types],
      ] as [string, Bucket[]][]).flatMap(([dim, bs]) =>
        bs.map((b) => [dim, b.label, b.leaves.length,
                       new Set(b.leaves.map((l) => canonName(l.label))).size,
                       Number(b.value.toFixed(2)), share(b.value, totalValue)])),
    ],
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Filters first: every figure on this tab is a figure OF this set, so the
          controls that decide the set belong above the numbers, not beside them.
          Date comes first of the two because it decides which documents exist
          at all; godown/UOM/search then narrow what is already loaded. */}
      <LedgerDateFilter />
      <div className="flex flex-wrap gap-[7px] items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search item / group…"
          aria-label="Search"
          className={`${selCls} min-w-[160px] flex-1`}
        />
        <select value={godown} onChange={(e) => setGodown(e.target.value)} aria-label="Godown" className={selCls}>
          <option value="">Godown · All</option>
          {godownOptions.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={uom} onChange={(e) => setUom(e.target.value as typeof uom)} aria-label="UOM" className={selCls}>
          <option value="">UOM · All</option>
          <option value="kg">Kgs</option>
          <option value="nos">NOS</option>
          <option value="no">No</option>
        </select>
        {filterOn && (
          <button type="button" onClick={() => { setSearch(""); setGodown(""); setUom(""); }}
                  className={selCls}>Clear</button>
        )}
        {/* Says what was kept. Without it a filtered total reads as the whole
            warehouse, which is the one way this screen can mislead. */}
        <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
          {filterOn
            ? `${fmtInt(filtered.length)} of ${fmtInt(leaves.length)} rows`
            : `${fmtInt(leaves.length)} rows`}
        </span>
      </div>

      {/* Totals — a table rather than tinted tiles, so the figures line up on
          tabular numerals and can be read down a column. The floor app makes the
          same choice for the same reason. */}
      <section>
        <div className="flex items-center gap-3 mb-[9px] flex-wrap">
          <SectionTitle
            note={`${ENTITY_LABELS[entity]} · ${source === "live" ? "live" : "sample data"}`
                  + (scope ? ` · filtered to ${scope}` : "")}
          >
            Totals
          </SectionTitle>
          <div className="flex-1" />
          <ExportBar spec={exportSpec} />
        </div>
        <TableShell minW={560}>
          <thead>
            <tr>
              <th className={thCls}>Measure</th>
              <th className={`${thCls} text-right`}>Value</th>
              <th className={thCls}>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={tdCls}>Godowns</td>
              <td className={`${tdCls} text-right tabular-nums font-semibold`}>{fmtInt(godowns.length)}</td>
              <td className={`${tdCls} text-[var(--text-secondary)]`}>
                <button type="button" onClick={() => setTab("godowns")}
                        className="underline hover:text-[var(--aws-orange)]">View breakdown</button>
              </td>
            </tr>
            <tr>
              <td className={tdCls}>Groups</td>
              <td className={`${tdCls} text-right tabular-nums font-semibold`}>{fmtInt(groups.length)}</td>
              <td className={`${tdCls} text-[var(--text-secondary)]`}>
                <button type="button" onClick={() => setTab("groups")}
                        className="underline hover:text-[var(--aws-orange)]">View breakdown</button>
              </td>
            </tr>
            <tr>
              <td className={tdCls}>Leaf rows</td>
              <td className={`${tdCls} text-right tabular-nums font-semibold`}>{fmtInt(filtered.length)}</td>
              <td className={`${tdCls} text-[var(--text-secondary)]`}>{fmtInt(itemCount)} distinct item{itemCount === 1 ? "" : "s"}</td>
            </tr>
            {/* One row per UOM class. Never a single "total quantity" — the
                classes are different units and adding them says nothing. */}
            {subtotals.map((s) => (
              <tr key={s.uom_class}>
                <td className={tdCls}>Quantity ({s.uom_class})</td>
                <td className={`${tdCls} text-right tabular-nums font-semibold`}>{fmtQty(s.closing_qty, uomDp(s.uom_class))}</td>
                <td className={`${tdCls} text-[var(--text-secondary)]`}>inward only — not a stock balance</td>
              </tr>
            ))}
            <tr>
              <td className={tdCls}>Indicative value</td>
              <td className={`${tdCls} text-right tabular-nums font-semibold`}>{fmtVal(totalValue)}</td>
              <td className={`${tdCls} text-[var(--text-secondary)]`}>the only figure that is additive across UOM</td>
            </tr>
            <tr>
              <td className={tdCls}>Unassigned godown</td>
              <td className={`${tdCls} text-right tabular-nums`}>{fmtInt(unassigned.length)}</td>
              <td className={`${tdCls} text-[var(--text-secondary)]`}>
                {filtered.length > 0
                  ? `${share(unassigned.reduce((s, l) => s + (Number(l.value_indicative) || 0), 0), totalValue)} of value has no godown`
                  : "—"}
              </td>
            </tr>
          </tbody>
        </TableShell>
      </section>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <SectionTabs tabs={SUB_TABS} active={tab} onSelect={(k) => setTab(k as SubTab)} />
        </div>
        <ViewToggle mode={mode} onChange={setMode} />
      </div>

      {filtered.length === 0 ? (
        // Two different situations, and confusing them sends someone to look for
        // a backend fault that is really just a filter.
        <p className="text-[12.5px] text-[var(--text-secondary)]">
          {leaves.length === 0
            ? `No ledger rows for ${ENTITY_LABELS[entity]}.`
            : `No rows match this filter. ${fmtInt(leaves.length)} rows are available for ${ENTITY_LABELS[entity]}.`}
        </p>
      ) : tab === "overview" ? (
        <>
          <section>
            <SectionTitle note={`${godowns.length} godown${godowns.length === 1 ? "" : "s"} · by value`}>
              Value by godown
            </SectionTitle>
            <BucketTable buckets={godowns} total={totalValue} head="Godown" mode={mode} />
          </section>
          <section>
            <SectionTitle note="rm / pm / fg as the source records it">Item type</SectionTitle>
            <BucketTable buckets={types} total={totalValue} head="Item type" mode={mode} minW={640} />
          </section>
          {entity === "both" && (
            <section>
              <SectionTitle note="only meaningful while the scope is Both">Company</SectionTitle>
              <BucketTable buckets={entities} total={totalValue} head="Company" mode={mode} minW={640} />
            </section>
          )}
        </>
      ) : tab === "godowns" ? (
        <section>
          <SectionTitle note={`${godowns.length} godown${godowns.length === 1 ? "" : "s"}`}>
            Godown breakdown
          </SectionTitle>
          {mode === "chart" ? (
            <BucketTable buckets={godowns} total={totalValue} head="Godown" mode={mode} />
          ) : (
            <div className="flex flex-col gap-4">
              {godowns.map((g) => {
                const inner = bucketBy(g.leaves, (l) => l.group).slice(0, 8);
                return (
                  <div key={g.key} className="border border-[var(--aws-border)] rounded-[9px] overflow-hidden">
                    <div className="flex items-baseline gap-2 flex-wrap px-[11px] py-2 bg-[var(--surface-subtle)] border-b border-[var(--aws-border)]">
                      <b className="text-[13px] text-[var(--text-primary)]">{g.label}</b>
                      <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
                        {fmtInt(g.leaves.length)} rows · {fmtVal(g.value)} · {share(g.value, totalValue)} of value
                      </span>
                      <div className="flex-1" />
                      <span className="font-mono text-[10.5px] text-[var(--text-secondary)]"><QtyByUom leaves={g.leaves} /></span>
                    </div>
                    <BucketTable buckets={inner} total={g.value} head="Group in this godown" mode="table" minW={640} />
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : (
        <>
          <section>
            <SectionTitle note={`${groups.length} group${groups.length === 1 ? "" : "s"}`}>
              Group breakdown
            </SectionTitle>
            <BucketTable buckets={groups} total={totalValue} head="Group" mode={mode} />
            {onDrillGroup && mode === "table" && groups.length > 0 && (
              <p className="mt-2 font-mono text-[10.5px] text-[var(--text-muted)]">
                Open a group in the Stock Summary tab to drill into its sub-groups and items.
              </p>
            )}
          </section>
          <section>
            <SectionTitle note="top 10 by indicative value">Top items</SectionTitle>
            <BucketTable buckets={topItems} total={totalValue} head="Item" mode={mode} minW={760} />
          </section>
        </>
      )}
    </div>
  );
}

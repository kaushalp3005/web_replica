"use client";

// Stock Summary — the detailed, granular landing view. Shows the full ledger
// equation per node (Opening + Inward + Production + Returns − Consumption −
// Outward − Transfer = Closing), drilled group → sub-group → item IN PLACE
// (expand/collapse), with working filters (search / godown / UOM), sortable
// columns, toggleable movement columns, per-UOM sub-totals (never cross-summed),
// grand totals, and export of exactly what's shown. Fixtures today; swaps to
// LedgerApi.stockSummary() later.

import { useMemo, useState } from "react";
import type { LedgerNode, MovementKey, UomSubtotal } from "@/lib/ledger";
import { slugifySku } from "./_ItemSearch";
import {
  StatCard, ExportBar, QtyCell, ValCell, UomBadge, fmtQty, fmtInt, uomDp, type ExportSpec,
} from "./_ui";
import {
  buildLedgerTree, buildWarehouseTree, filterLeaves, grandSubtotals, allNodeKeys,
} from "./_tree";
import { COMPANY_KPIS } from "./_fixtures";
import { useLedgerLeaves } from "./_LedgerData";

type MoveField =
  | "opening_qty" | "inward_qty" | "consumption_qty" | "production_qty"
  | "returns_qty" | "outward_qty" | "transfer_out_qty";
type Tone = "pos" | "neg" | "xfer" | "plain";
interface MoveCol { key: MovementKey; label: string; field: MoveField; tone: Tone; }

const MOVE_COLS: MoveCol[] = [
  { key: "opening", label: "Opening", field: "opening_qty", tone: "plain" },
  { key: "inward", label: "Inward +", field: "inward_qty", tone: "pos" },
  { key: "consumption", label: "Consumed −", field: "consumption_qty", tone: "neg" },
  { key: "production", label: "Produced +", field: "production_qty", tone: "pos" },
  { key: "returns", label: "Returns +", field: "returns_qty", tone: "pos" },
  { key: "outward", label: "Outward −", field: "outward_qty", tone: "neg" },
  { key: "transfer_out", label: "Transfer −", field: "transfer_out_qty", tone: "xfer" },
];
const TONE_CLS: Record<Tone, string> = {
  pos: "text-[#1d8102]", neg: "text-[var(--aws-error)]", xfer: "text-[#2f74cf]", plain: "text-[var(--text-primary)]",
};

type SortKey = "label" | MovementKey | "closing" | "value";
type Row =
  | { kind: "node"; node: LedgerNode; depth: number }
  | { kind: "sub"; label: string; sub: UomSubtotal; depth: number };

const TH = "font-mono text-[9px] uppercase tracking-wide text-[var(--text-muted)] px-[9px] py-2 bg-[var(--surface-subtle)] border-b border-[var(--aws-border)] whitespace-nowrap font-semibold sticky top-0 z-10 cursor-pointer select-none";
const TD = "px-[9px] py-[6px] border-b border-[var(--surface-divider)] align-middle whitespace-nowrap";

function moveField(key: SortKey): MoveField | null {
  const c = MOVE_COLS.find((x) => x.key === key);
  return c ? c.field : null;
}
function sortVal(n: LedgerNode, key: SortKey): number | string | null {
  if (key === "label") return n.label.toLowerCase();
  if (key === "closing") return n.closing_qty;
  if (key === "value") return n.value_indicative;
  const f = moveField(key);
  return f ? n[f] : null;
}
function cmp(a: LedgerNode, b: LedgerNode, key: SortKey, dir: "asc" | "desc"): number {
  const va = sortVal(a, key);
  const vb = sortVal(b, key);
  // nulls always sort last, regardless of direction
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  const s = dir === "asc" ? 1 : -1;
  if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * s;
  return ((va as number) - (vb as number)) * s;
}

// Quantity is primary; a movement of 0 renders as a faint dot (Tally leaves it
// blank) so the eye tracks real movement, not a wall of zeros.
function MoveCell({ v, tone, uom }: { v: number | null; tone: Tone; uom: string }) {
  if (v === null) return <span className="text-[var(--text-muted)]">—</span>;
  if (v === 0) return <span className="text-[var(--text-disabled)]">·</span>;
  return <span className={`font-mono tabular-nums font-semibold ${TONE_CLS[tone]}`}>{fmtQty(v, uomDp(uom))}</span>;
}

export function StockSummary({
  onDrillGroup, onOpenItem,
}: {
  onDrillGroup: (slug: string) => void;
  onOpenItem: (skuSlug: string) => void;
}) {
  const [viewBy, setViewBy] = useState<"group" | "warehouse">("group");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [godown, setGodown] = useState("");
  const [uom, setUom] = useState<"" | "kg" | "nos" | "no">("");
  const [sortKey, setSortKey] = useState<SortKey>("label");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [hidden, setHidden] = useState<Set<MovementKey>>(new Set(["returns"]));

  const { leaves } = useLedgerLeaves();
  const godowns = useMemo(() => Array.from(new Set(leaves.map((l) => l.godown))).sort(), [leaves]);
  const filtered = useMemo(
    () => filterLeaves(leaves, { q: search, godown, uom }),
    [leaves, search, godown, uom],
  );
  const tree = useMemo(
    () => (viewBy === "group" ? buildLedgerTree(filtered) : buildWarehouseTree(filtered)),
    [filtered, viewBy],
  );
  const grand = useMemo(() => grandSubtotals(filtered), [filtered]);

  // when searching, auto-expand every match so hits are visible
  const effExpanded = useMemo(
    () => (search.trim() ? new Set(allNodeKeys(tree)) : expanded),
    [search, tree, expanded],
  );

  const visibleCols = MOVE_COLS.filter((c) => !hidden.has(c.key));

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (nodes: LedgerNode[], depth: number) => {
      for (const n of [...nodes].sort((a, b) => cmp(a, b, sortKey, sortDir))) {
        out.push({ kind: "node", node: n, depth });
        if (n.children.length && effExpanded.has(n.key)) {
          walk(n.children, depth + 1);
          for (const s of n.uom_subtotals) {
            out.push({ kind: "sub", label: `${n.label} · ${s.uom_class.toUpperCase()}`, sub: s, depth: depth + 1 });
          }
        }
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, effExpanded, sortKey, sortDir]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  function setSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "label" ? "asc" : "desc"); }
  }
  function onLabel(n: LedgerNode) {
    if (n.level === "item" && n.sku_id) onOpenItem(slugifySku(n.label));
    else if (n.drill_key && n.level === "group" && viewBy === "group") onDrillGroup(n.drill_key);
    else if (n.children.length) toggle(n.key);
  }

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  const exportSpec: ExportSpec = {
    filename: `stock-summary-${viewBy}`,
    sheet: "Stock Summary",
    rows: () => {
      const header = ["Particulars", ...visibleCols.map((c) => c.label), "Closing", "UOM", "Value(≈)"];
      const body = rows.map((r) => {
        if (r.kind === "node") {
          const n = r.node;
          return [
            `${"    ".repeat(r.depth)}${n.label}`,
            ...visibleCols.map((c) => n[c.field]),
            n.closing_qty, n.uom_class, n.value_indicative,
          ];
        }
        return [
          `${"    ".repeat(r.depth)}${r.label}`,
          ...visibleCols.map((c) => r.sub[c.field]),
          r.sub.closing_qty, r.sub.uom_class, r.sub.value_indicative,
        ];
      });
      const totals = grand.map((s) => [
        `Grand total · ${s.uom_class.toUpperCase()}`,
        ...visibleCols.map((c) => s[c.field]),
        s.closing_qty, s.uom_class, s.value_indicative,
      ]);
      return [header, ...body, [], ...totals];
    },
  };

  const selCls = "border border-[var(--aws-border)] rounded-[8px] px-[9px] py-[5px] text-[11px] bg-white font-mono text-[var(--text-primary)]";

  return (
    <div className="flex flex-col gap-[13px]">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-[9px]">
        <StatCard label="Closing value" value={COMPANY_KPIS.closing_value_cr} unit="Cr" delta="≈ indicative" />
        <StatCard label="Quantity" value={fmtInt(COMPANY_KPIS.quantity_kg)} unit="kg" delta="RM+FG bulk" />
        <StatCard label="Boxes / cartons" value={fmtInt(COMPANY_KPIS.boxes)} delta="all godowns" />
        <StatCard label="In transit" value={fmtInt(COMPANY_KPIS.in_transit_boxes)} unit="box" delta="5 open transfers" />
        <StatCard label="WIP / SFG" value={fmtInt(COMPANY_KPIS.wip_sfg_kg)} unit="kg" delta="42 job cards" />
        <StatCard label="Reconcile" value={String(COMPANY_KPIS.reconcile_flags)} flag delta="batch≠floor" />
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap gap-[7px] items-center">
        <div className="inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px]">
          {(["group", "warehouse"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setViewBy(v)}
              aria-pressed={viewBy === v}
              className={`font-mono text-[11px] px-[10px] py-[4px] rounded-[6px] ${
                viewBy === v ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]"
              }`}
            >{v === "group" ? "By Group" : "By Warehouse"}</button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search item / group…"
          aria-label="Search"
          className={`${selCls} min-w-[160px] flex-1`}
        />
        <select value={godown} onChange={(e) => setGodown(e.target.value)} aria-label="Godown" className={selCls}>
          <option value="">Godown · All</option>
          {godowns.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={uom} onChange={(e) => setUom(e.target.value as typeof uom)} aria-label="UOM" className={selCls}>
          <option value="">UOM · All</option>
          <option value="kg">Kgs</option>
          <option value="nos">NOS</option>
          <option value="no">No</option>
        </select>
        <button onClick={() => setExpanded(new Set(allNodeKeys(tree)))} className={selCls}>Expand all</button>
        <button onClick={() => setExpanded(new Set())} className={selCls}>Collapse</button>
        <ExportBar spec={exportSpec} />
      </div>

      {/* column toggles */}
      <div className="flex flex-wrap gap-[6px] items-center">
        <span className="font-mono text-[9.5px] uppercase tracking-wide text-[var(--text-muted)]">Columns:</span>
        {MOVE_COLS.map((c) => {
          const on = !hidden.has(c.key);
          return (
            <button
              key={c.key}
              onClick={() => setHidden((prev) => {
                const next = new Set(prev);
                if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
                return next;
              })}
              aria-pressed={on}
              className={`font-mono text-[10px] px-[8px] py-[3px] rounded-[6px] border ${
                on ? "border-[var(--aws-orange)] text-[var(--aws-orange)] bg-[#9a393e0d]" : "border-[var(--aws-border)] text-[var(--text-muted)] bg-white"
              }`}
            >{on ? "✓ " : ""}{c.label}</button>
          );
        })}
      </div>

      {/* table */}
      <div className="border border-[var(--aws-border)] rounded-[11px] overflow-hidden bg-white">
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full border-collapse text-[12px]" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th className={`${TH} text-left`} onClick={() => setSort("label")}>Particulars{sortArrow("label")}</th>
                {visibleCols.map((c) => (
                  <th key={c.key} className={`${TH} text-right`} onClick={() => setSort(c.key)}>{c.label}{sortArrow(c.key)}</th>
                ))}
                <th className={`${TH} text-right`} onClick={() => setSort("closing")}>Closing{sortArrow("closing")}</th>
                <th className={`${TH} text-left`}>UOM</th>
                <th className={`${TH} text-right`} onClick={() => setSort("value")}>Value ≈{sortArrow("value")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                if (r.kind === "sub") {
                  const uomStr = r.sub.uom_class;
                  return (
                    <tr key={`sub-${r.label}-${uomStr}`} className="bg-[#9a393e0d]">
                      <td className={`${TD} font-mono text-[10.5px] text-[var(--text-secondary)]`} style={{ paddingLeft: 9 + r.depth * 16 }}>↳ {r.label}</td>
                      {visibleCols.map((c) => (
                        <td key={c.key} className={`${TD} text-right`}><MoveCell v={r.sub[c.field]} tone={c.tone} uom={uomStr} /></td>
                      ))}
                      <td className={`${TD} text-right`}><QtyCell n={r.sub.closing_qty} uom={uomStr} /></td>
                      <td className={TD}>{uomStr.toUpperCase()}</td>
                      <td className={`${TD} text-right`}><ValCell n={r.sub.value_indicative} /></td>
                    </tr>
                  );
                }
                const n = r.node;
                const isGroup = n.level === "group";
                const isSub = n.level === "subgroup";
                const uomStr = n.uom_class === "mixed" ? "kg" : n.uom_class;
                const rowBg = isGroup ? "bg-[var(--surface-subtle)]" : "";
                const nameWt = isGroup ? "font-bold" : isSub ? "font-semibold" : "font-normal";
                return (
                  <tr key={n.key} className={`${rowBg} hover:bg-[var(--surface-subtle)]`}>
                    <td className={TD} style={{ paddingLeft: 9 + r.depth * 16 }}>
                      <span className="inline-flex items-center gap-[6px]">
                        {n.children.length > 0 ? (
                          <button
                            onClick={() => toggle(n.key)}
                            aria-label={effExpanded.has(n.key) ? "Collapse" : "Expand"}
                            className="w-[14px] text-[var(--text-muted)] font-mono text-[10px]"
                          >{effExpanded.has(n.key) ? "▾" : "▸"}</button>
                        ) : <span className="w-[14px] inline-block" />}
                        <button
                          onClick={() => onLabel(n)}
                          className={`${nameWt} ${n.level === "item" || (isGroup && viewBy === "group") ? "text-[var(--aws-link)] hover:underline" : "text-[var(--text-primary)]"} text-left`}
                        >{n.label}</button>
                        {isGroup && <span className="font-mono text-[9px] text-[var(--text-muted)]">({fmtInt(n.item_count)})</span>}
                      </span>
                    </td>
                    {visibleCols.map((c) => (
                      <td key={c.key} className={`${TD} text-right`}><MoveCell v={n[c.field]} tone={c.tone} uom={uomStr} /></td>
                    ))}
                    <td className={`${TD} text-right`}>
                      {n.closing_qty === null ? <span className="text-[var(--text-muted)]">—</span> : <QtyCell n={n.closing_qty} uom={uomStr} />}
                    </td>
                    <td className={TD}><UomBadge uom={n.uom_class} /></td>
                    <td className={`${TD} text-right`}><ValCell n={n.value_indicative} /></td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td className={`${TD} text-[var(--text-muted)]`} colSpan={visibleCols.length + 4}>No stock matches the current filters.</td></tr>
              )}
              {/* grand totals — one per UOM class, never cross-summed */}
              {grand.map((s) => (
                <tr key={`grand-${s.uom_class}`} className="bg-[var(--aws-navy)]">
                  <td className={`${TD} font-mono text-[11px] font-bold text-white`}>Grand total · {s.uom_class.toUpperCase()}</td>
                  {visibleCols.map((c) => (
                    <td key={c.key} className={`${TD} text-right font-mono tabular-nums text-[#f0d9da]`}>{s[c.field] === 0 ? "" : fmtQty(s[c.field], uomDp(s.uom_class))}</td>
                  ))}
                  <td className={`${TD} text-right font-mono tabular-nums font-bold text-white`}>{fmtQty(s.closing_qty, uomDp(s.uom_class))}</td>
                  <td className={`${TD} text-white`}>{s.uom_class.toUpperCase()}</td>
                  <td className={`${TD} text-right font-mono text-[#f0d9da] italic`}>≈ {fmtInt(s.value_indicative)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="font-mono text-[10px] text-[var(--text-muted)]">
        # Closing = Opening + Inward + Produced + Returns − Consumed − Outward − Transfer. Quantities never cross UOM classes — Kgs and NOS carry separate grand totals. Value (≈) is unreconciled and excluded from totals. Click a group to drill, an item to open its ledger; export reflects the current filter, columns and expansion.
      </p>
    </div>
  );
}

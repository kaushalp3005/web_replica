// Stock Summary tree engine. Builds a group → sub-group → item hierarchy from
// the flat leaf list and DERIVES every roll-up: closing = opening + inward +
// production + returns − consumption − outward − transfer-out. Quantities are
// only ever summed WITHIN a UOM class; a node spanning classes is "mixed" (its
// numeric columns are null) and carries a per-UOM breakdown in `uom_subtotals`.

import type { LeafItem, LedgerNode, MovementCols, UomClass, UomSubtotal } from "@/lib/ledger";

export const MCOLS: (keyof MovementCols)[] = [
  "opening_qty", "inward_qty", "production_qty", "returns_qty",
  "consumption_qty", "outward_qty", "transfer_out_qty",
];

export function computeClosing(m: MovementCols): number {
  return (
    m.opening_qty + m.inward_qty + m.production_qty + m.returns_qty -
    m.consumption_qty - m.outward_qty - m.transfer_out_qty
  );
}

function emptyCols(): MovementCols {
  return {
    opening_qty: 0, inward_qty: 0, production_qty: 0, returns_qty: 0,
    consumption_qty: 0, outward_qty: 0, transfer_out_qty: 0,
  };
}
function addInto(acc: MovementCols, m: MovementCols): void {
  for (const k of MCOLS) acc[k] += m[k];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// per-UOM subtotals for a set of leaves (insertion order of first appearance)
function perUom(leaves: LeafItem[]): UomSubtotal[] {
  const map = new Map<UomClass, { cols: MovementCols; value: number }>();
  for (const l of leaves) {
    const e = map.get(l.uom_class) ?? { cols: emptyCols(), value: 0 };
    addInto(e.cols, l);
    e.value += l.value_indicative;
    map.set(l.uom_class, e);
  }
  return Array.from(map.entries()).map(([uom, e]) => ({
    uom_class: uom, ...e.cols, closing_qty: computeClosing(e.cols), value_indicative: e.value,
  }));
}

function rollup(
  key: string, label: string, level: LedgerNode["level"], leaves: LeafItem[],
  children: LedgerNode[], drill_key?: string,
): LedgerNode {
  const subs = perUom(leaves);
  const single = subs.length === 1 ? subs[0] : null;
  const value = leaves.reduce((s, l) => s + l.value_indicative, 0);
  return {
    key, label, level,
    uom_class: single ? single.uom_class : "mixed",
    opening_qty: single ? single.opening_qty : null,
    inward_qty: single ? single.inward_qty : null,
    production_qty: single ? single.production_qty : null,
    returns_qty: single ? single.returns_qty : null,
    consumption_qty: single ? single.consumption_qty : null,
    outward_qty: single ? single.outward_qty : null,
    transfer_out_qty: single ? single.transfer_out_qty : null,
    closing_qty: single ? single.closing_qty : null,
    value_indicative: value,
    item_count: leaves.length,
    drill_key,
    uom_subtotals: single ? [] : subs,
    children,
  };
}

function leafNode(l: LeafItem): LedgerNode {
  return {
    key: `item-${l.sku_id}`, label: l.label, level: "item", uom_class: l.uom_class,
    opening_qty: l.opening_qty, inward_qty: l.inward_qty, production_qty: l.production_qty,
    returns_qty: l.returns_qty, consumption_qty: l.consumption_qty, outward_qty: l.outward_qty,
    transfer_out_qty: l.transfer_out_qty, closing_qty: computeClosing(l),
    value_indicative: l.value_indicative, item_count: 1,
    godown: l.godown, sku_id: l.sku_id, uom_subtotals: [], children: [],
  };
}

// group by a key preserving first-seen order
function groupBy<T>(rows: T[], keyOf: (r: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return Array.from(m.entries());
}

// group → sub-group → item
export function buildLedgerTree(leaves: LeafItem[]): LedgerNode[] {
  return groupBy(leaves, (l) => l.group).map(([group, gLeaves]) => {
    const subs = groupBy(gLeaves, (l) => l.subgroup).map(([sub, sLeaves]) =>
      rollup(`sub-${slug(group)}-${slug(sub)}`, sub, "subgroup", sLeaves, sLeaves.map(leafNode)),
    );
    return rollup(`grp-${slug(group)}`, group, "group", gLeaves, subs, slug(group));
  });
}

// warehouse → item (the "By Warehouse" perspective)
export function buildWarehouseTree(leaves: LeafItem[]): LedgerNode[] {
  return groupBy(leaves, (l) => l.godown).map(([wh, wLeaves]) =>
    rollup(`wh-${slug(wh)}`, wh, "group", wLeaves, wLeaves.map(leafNode)),
  );
}

export interface LeafFilter { q?: string; godown?: string; uom?: UomClass | ""; }
export function filterLeaves(leaves: LeafItem[], f: LeafFilter): LeafItem[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return leaves.filter((l) => {
    if (f.godown && l.godown !== f.godown) return false;
    if (f.uom && l.uom_class !== f.uom) return false;
    if (q && !(`${l.label} ${l.group} ${l.subgroup}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

// grand per-UOM subtotals across a leaf set
export function grandSubtotals(leaves: LeafItem[]): UomSubtotal[] {
  return perUom(leaves);
}

// every expandable node key (for "expand all" / search auto-expand)
export function allNodeKeys(nodes: LedgerNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: LedgerNode[]) => {
    for (const n of ns) if (n.children.length) { out.push(n.key); walk(n.children); }
  };
  walk(nodes);
  return out;
}

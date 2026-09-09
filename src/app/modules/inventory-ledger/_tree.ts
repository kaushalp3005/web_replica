// Stock Summary tree engine. Builds a group → sub-group → item hierarchy from
// the flat leaf list and DERIVES every roll-up: closing = opening + inward +
// production + returns − consumption − outward − transfer-out. Quantities are
// only ever summed WITHIN a UOM class; a node spanning classes is "mixed" (its
// numeric columns are null) and carries a per-UOM breakdown in `uom_subtotals`.

import type { Entity, LeafItem, LedgerNode, MovementCols, UomClass, UomSubtotal } from "@/lib/ledger";

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

// THE LEGACY FEED DOES NOT SPELL A NAME THE SAME WAY TWICE.
//
// Live, `group` arrives as 46 distinct strings that are 25 actual groups:
// "PISTA"/"pista", "ALMOND"/"almond", "Packaging"/"packaging" and 18 more.
// `subgroup` is worse. Grouping on the raw string therefore lists one real group
// two or three times, each holding a fraction of its own total — and because the
// node key was slug(group), which lowercases, those fragments then collided into
// ONE React key. Measured on the live feed: 21 duplicate `grp-` keys and 62
// duplicate `sub-` keys. The browser only warns about the ones it has rendered,
// so the console under-reports it.
//
// Identity is therefore the CASE-FOLDED name, and the label shown is whichever
// spelling appears on the most rows. The built-in fixtures have clean names,
// which is why none of this is reachable in Sample mode.
export function canonName(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

/** The spelling that appears on the most rows, so a folded node is named the way
 *  the data mostly names it. Ties break on first appearance, which keeps the
 *  label stable between renders rather than flickering between spellings.
 *
 *  Exported because every view that folds names has to LABEL the result, and two
 *  views picking different spellings for the same fold would look like two
 *  different groups. */
export function commonest(values: string[]): string {
  const n = new Map<string, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  let best = values[0] ?? "";
  let bestN = -1;
  for (const [v, c] of n) if (c > bestN) { best = v; bestN = c; }
  return best;
}

// A node key must be unique, and slug() cannot guarantee that: even AFTER
// case-folding, "ALMOND INSHELL" and "ALMOND - INSHELL" both slug to
// "almond-inshell". Keys are built from the canonical names themselves,
// "\u0000"-joined for the same reason leafKey() uses "\u0000" (see below). slug() survives
// only where it has to — in `drill_key`, which goes in a URL. That case is
// checked: the 25 canonical groups produce 25 distinct slugs.
function nodeKey(kind: string, ...parts: string[]): string {
  return [kind, ...parts].join("\u0000");
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

// A leaf is one (sku, godown, entity, item_type, group, subgroup) row — the
// backend emits one per godown per entity, so `item-${sku_id}` alone collides
// between sibling godowns (duplicate React key + unreliable row reconciliation).
// This mirrors the backend's leaf identity exactly, which matters for
// buildWarehouseTree: there, leaves are grouped by godown only, so two rows of
// one sku differing solely by category are siblings.
//
// The parts are joined on NUL because it cannot occur in any of them, so no
// combination of field values can forge another leaf's key. It must stay written
// as the escape sequence below, never as a literal control character: a raw NUL
// in the source makes git treat this file as binary — no textual diffs, no
// normal merges, and an invisible character for whoever edits it next.
// `label` belongs to the identity because the BACKEND's merge key carries it
// (leaves_service._leaf_key: entity, sku_id, label, item_type, category,
// sub_category, godown). Leaving it out did not mirror that key, it truncated
// it — sku_id is 0 on a large share of rows, so the label is what actually
// separates them, and 10 live leaves shared a key without it.
//
// Names are canonicalised for the same reason the tree folds them: two rows
// differing only in how their group is spelled are not two different items.
export function leafKey(l: LeafItem): string {
  return [
    "item", l.sku_id, l.entity, l.godown, l.label,
    canonName(l.item_type), canonName(l.group), canonName(l.subgroup),
  ].join("\u0000");
}

function leafNode(l: LeafItem): LedgerNode {
  return {
    key: leafKey(l), label: l.label, level: "item", uom_class: l.uom_class,
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
  return groupBy(leaves, (l) => canonName(l.group)).map(([gKey, gLeaves]) => {
    const gLabel = commonest(gLeaves.map((l) => l.group));
    const subs = groupBy(gLeaves, (l) => canonName(l.subgroup)).map(([sKey, sLeaves]) =>
      rollup(nodeKey("sub", gKey, sKey), commonest(sLeaves.map((l) => l.subgroup)),
             "subgroup", sLeaves, sLeaves.map(leafNode)),
    );
    return rollup(nodeKey("grp", gKey), gLabel, "group", gLeaves, subs, slug(gLabel));
  });
}

// warehouse → item (the "By Warehouse" perspective)
// Godowns are already canonicalised server-side by ledger_godown(), so nothing
// folds here on today's data. Built the same way regardless: that alias table is
// maintained by hand, and this should not be where a new alias silently breaks.
export function buildWarehouseTree(leaves: LeafItem[]): LedgerNode[] {
  return groupBy(leaves, (l) => canonName(l.godown)).map(([wKey, wLeaves]) =>
    rollup(nodeKey("wh", wKey), commonest(wLeaves.map((l) => l.godown)),
           "group", wLeaves, wLeaves.map(leafNode)),
  );
}

// `entity: "both"` (or omitted) means no entity filter — every other value keeps
// only leaves stamped with that company.
export interface LeafFilter {
  q?: string;
  godown?: string;
  uom?: UomClass | "";
  entity?: Entity | "both";
}
export function filterLeaves(leaves: LeafItem[], f: LeafFilter): LeafItem[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return leaves.filter((l) => {
    if (f.entity && f.entity !== "both" && l.entity !== f.entity) return false;
    if (f.godown && canonName(l.godown) !== canonName(f.godown)) return false;
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

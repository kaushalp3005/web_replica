// Company-level aggregation for the landing tabs (Batches & Lots, Ageing, FIFO,
// Reconcile). Derives from ALL items in the leaf set — not one sample item — so
// the company views are real roll-ups that tie to the Stock Summary. Reuses the
// per-item engine (_item.ts) so a lot shown here is the same lot shown on the
// item hub.

import type { Lot, FifoFlag, AgeingRow, ReconRow, LeafItem } from "@/lib/ledger";
import { computeClosing } from "./_tree";
import { buildLots, buildFifo } from "./_item";

const COLD = new Set(["Rishi", "Supreme", "Eskimo"]);
function r3(n: number): number { return Math.round(n * 1000) / 1000; }

export function companyLots(leaves: LeafItem[]): Lot[] {
  return leaves.flatMap((l) => buildLots(l));
}

export function companyFifo(leaves: LeafItem[]): FifoFlag[] {
  return leaves.flatMap((l) => buildFifo(l, buildLots(l)));
}

// ageing rolled up per sub-group × UOM class (never cross-summed)
export function companyAgeing(leaves: LeafItem[]): AgeingRow[] {
  const map = new Map<string, AgeingRow>();
  for (const l of leaves) {
    const lots = buildLots(l);
    if (!lots.length) continue;
    const key = `${l.subgroup}__${l.uom_class}`;
    let row = map.get(key);
    if (!row) {
      row = { group_key: l.subgroup, uom_class: l.uom_class, b_0_30: 0, b_31_60: 0, b_61_90: 0, b_90_plus: 0, total_qty: 0, expired_qty: 0, near_expiry_qty: 0 };
      map.set(key, row);
    }
    for (const lot of lots) {
      if (lot.age_days <= 30) row.b_0_30 += lot.current_qty;
      else if (lot.age_days <= 60) row.b_31_60 += lot.current_qty;
      else if (lot.age_days <= 90) row.b_61_90 += lot.current_qty;
      else row.b_90_plus += lot.current_qty;
      row.total_qty += lot.current_qty;
      if (lot.near_expiry) row.near_expiry_qty = (row.near_expiry_qty ?? 0) + lot.current_qty;
    }
  }
  return Array.from(map.values()).map((r) => ({
    ...r, b_0_30: r3(r.b_0_30), b_31_60: r3(r.b_31_60), b_61_90: r3(r.b_61_90),
    b_90_plus: r3(r.b_90_plus), total_qty: r3(r.total_qty),
    near_expiry_qty: r.near_expiry_qty ? r3(r.near_expiry_qty) : 0,
  }));
}

export interface ReconResult {
  rows: ReconRow[];
  stats: { computedVsPhysical: string; variances: number; storeGaps: number; netDelta: number; shrink: number; matched: number };
}
// computed closing (inventory_batch) vs a synthetic physical (floor) count.
// Cold godowns have no floor row → store_gap; a deterministic subset is short.
export function companyRecon(leaves: LeafItem[]): ReconResult {
  const rows: ReconRow[] = [];
  let matched = 0, variance = 0, gaps = 0, netDelta = 0, shrink = 0;
  for (const l of leaves) {
    const closing = r3(computeClosing(l));
    if (COLD.has(l.godown)) {
      rows.push({ sku_name: l.label, warehouse_code: l.godown, batch_qty: closing, floor_qty: null, delta_qty: null, status: "store_gap" });
      gaps++;
      continue;
    }
    const short = l.sku_id % 5 === 0 ? Math.max(1, Math.round(Math.abs(closing) * 0.02)) : 0;
    const floor = r3(closing - short);
    const delta = r3(closing - floor);
    const status: ReconRow["status"] = delta !== 0 ? "variance" : "matched";
    if (status === "variance") { variance++; netDelta += delta; shrink += Math.abs(delta); } else matched++;
    rows.push({ sku_name: l.label, warehouse_code: l.godown, batch_qty: closing, floor_qty: floor, delta_qty: delta, status });
  }
  const total = matched + variance;
  const pct = total ? Math.round((matched / total) * 1000) / 10 : 100;
  return { rows, stats: { computedVsPhysical: `${pct}%`, variances: variance, storeGaps: gaps, netDelta: r3(netDelta), shrink: r3(shrink), matched } };
}

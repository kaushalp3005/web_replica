// Company-level aggregation for the landing tabs (Batches & Lots, Ageing, FIFO,
// Reconcile). Derives from ALL items in the leaf set — not one sample item — so
// the company views are real roll-ups that tie to the Stock Summary. Reuses the
// per-item engine (_item.ts) so a lot shown here is the same lot shown on the
// item hub.

import type { Lot, FifoFlag, AgeingRow, ReconRow, LeafItem } from "@/lib/ledger";
import { canonName, commonest, computeClosing } from "./_tree";
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
  // Every raw spelling that folded into each row, so the row can be labelled
  // with the commonest one rather than with whichever arrived first.
  const spellings = new Map<string, string[]>();
  for (const l of leaves) {
    const lots = buildLots(l);
    if (!lots.length) continue;
    const k = `${canonName(l.subgroup)}__${l.uom_class}`;
    if (!spellings.has(k)) spellings.set(k, []);
    // Folded, for the same reason buildLedgerTree folds: the feed spells a
    // sub-group several ways (101 real sub-groups arrive as 163 spellings; 62
    // fold), so keying on the raw string emitted one real sub-group as two rows
    // holding a fraction of its quantity each. Chia came out as 117,129.465 kg
    // and 262,508.160 kg with its actual 379,637.625 kg total shown nowhere —
    // and silently, because the two raw spellings still made distinct React keys.
    const key = `${canonName(l.subgroup)}__${l.uom_class}`;
    let row = map.get(key);
    if (!row) {
      row = { group_key: canonName(l.subgroup), uom_class: l.uom_class, b_0_30: 0, b_31_60: 0, b_61_90: 0, b_90_plus: 0, total_qty: 0, expired_qty: 0, near_expiry_qty: 0 };
      map.set(key, row);
    }
    spellings.get(key)!.push(l.subgroup);
    for (const lot of lots) {
      if (lot.age_days <= 30) row.b_0_30 += lot.current_qty;
      else if (lot.age_days <= 60) row.b_31_60 += lot.current_qty;
      else if (lot.age_days <= 90) row.b_61_90 += lot.current_qty;
      else row.b_90_plus += lot.current_qty;
      row.total_qty += lot.current_qty;
      if (lot.near_expiry) row.near_expiry_qty = (row.near_expiry_qty ?? 0) + lot.current_qty;
    }
  }
  return Array.from(map.entries()).map(([key, r]) => ({
    ...r,
    group_key: commonest(spellings.get(key) ?? [r.group_key]),
    b_0_30: r3(r.b_0_30), b_31_60: r3(r.b_31_60), b_61_90: r3(r.b_61_90),
    b_90_plus: r3(r.b_90_plus), total_qty: r3(r.total_qty),
    near_expiry_qty: r.near_expiry_qty ? r3(r.near_expiry_qty) : 0,
  }));
}

export interface ReconResult {
  rows: ReconRow[];
  // shrink and netDelta are PER UOM CLASS. The leaf set is 416 kg rows and 273
  // nos rows; one scalar across both would be kilograms plus pieces, a figure no
  // write-off could be posted against — and the card that renders it says "kg".
  stats: {
    computedVsPhysical: string; variances: number; storeGaps: number; matched: number;
    netDelta: Partial<Record<LeafItem["uom_class"], number>>;
    shrink: Partial<Record<LeafItem["uom_class"], number>>;
  };
}
// computed closing (inventory_batch) vs a synthetic physical (floor) count.
// Cold godowns have no floor row → store_gap; a deterministic subset is short.
export function companyRecon(leaves: LeafItem[]): ReconResult {
  const rows: ReconRow[] = [];
  let matched = 0, variance = 0, gaps = 0;
  const netDelta: Partial<Record<LeafItem["uom_class"], number>> = {};
  const shrink: Partial<Record<LeafItem["uom_class"], number>> = {};
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
    if (status === "variance") {
      variance++;
      netDelta[l.uom_class] = (netDelta[l.uom_class] ?? 0) + delta;
      shrink[l.uom_class] = (shrink[l.uom_class] ?? 0) + Math.abs(delta);
    } else matched++;
    rows.push({ sku_name: l.label, warehouse_code: l.godown, batch_qty: closing, floor_qty: floor, delta_qty: delta, status });
  }
  const total = matched + variance;
  const pct = total ? Math.round((matched / total) * 1000) / 10 : 100;
  const round = (m: Partial<Record<LeafItem["uom_class"], number>>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, r3(v as number)]));
  return { rows, stats: { computedVsPhysical: `${pct}%`, variances: variance,
                          storeGaps: gaps, matched,
                          netDelta: round(netDelta), shrink: round(shrink) } };
}

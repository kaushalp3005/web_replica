// Per-item data engine for the Item hub. Resolves an item from its slug and
// DERIVES its vouchers, monthly summary, lots, ageing, godown split and FIFO
// flags from the same leaf record the Stock Summary uses — so every number on
// the hub ties back to the Stock Summary (e.g. closing = opening + Σinward −
// Σconsumed − …). Deterministic (no Date.now / Math.random) so SSR and client
// hydration agree. Swaps to LedgerApi.article* once the backend lands.

import type {
  LeafItem, VoucherRow, MonthlyRow, Lot, AgeingRow, FifoFlag, Direction,
} from "@/lib/ledger";
import { computeClosing } from "./_tree";
import { slugifySku } from "./_ItemSearch";

const AS_OF = "2026-07-07";
const MONTH_NAMES: Record<number, string> = { 4: "April", 5: "May", 6: "June", 7: "July" };

export function findLeaf(slug: string, leaves: LeafItem[]): LeafItem | undefined {
  return leaves.find((l) => slugifySku(l.label) === slug);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
// split v into `parts` chunks that sum EXACTLY to v (last chunk absorbs rounding)
function splitQty(v: number, parts: number): number[] {
  if (v <= 0) return [];
  const n = Math.max(1, parts);
  const base = round3(v / n);
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) { out.push(base); acc += base; }
  out.push(round3(v - acc));
  return out;
}
function partsFor(v: number): number {
  return v > 5000 ? 3 : v > 400 ? 2 : 1;
}
function daysAgoISO(age: number): string {
  const d = new Date(AS_OF);
  d.setUTCDate(d.getUTCDate() - age);
  return d.toISOString().slice(0, 10);
}
// derived indicative rate (value is not reconciled; this is display-only)
function rateOf(leaf: LeafItem): number {
  const closing = Math.abs(computeClosing(leaf));
  return Math.max(1, Math.round(Math.abs(leaf.value_indicative) / Math.max(1, closing)));
}

interface Ev {
  dir: Direction; mvt: string; type: string; qty: number;
  counterpart: string; ref_type: string; ref_id: string; synthetic: boolean;
  slot: number;
}

// Build the raw movement events for an item from its leaf columns. IN totals =
// inward + production + returns; OUT totals = consumption + outward + transfer.
function events(leaf: LeafItem): Ev[] {
  const evs: Ev[] = [];
  let slot = 0;
  const id = leaf.sku_id;
  const push = (
    dir: Direction, mvt: string, type: string, values: number[],
    counterpart: (i: number) => string, ref_type: string, ref: (i: number) => string, synthetic: boolean,
  ) => {
    values.forEach((qty, i) => {
      evs.push({ dir, mvt, type, qty, counterpart: counterpart(i), ref_type, ref_id: ref(i), synthetic, slot: slot++ });
    });
  };

  if (leaf.inward_qty > 0) {
    const vendor = leaf.item_type === "pm" ? "Uflex" : "Olam Agro";
    push("IN", "101", "Receipt", splitQty(leaf.inward_qty, partsFor(leaf.inward_qty)),
      () => `PO-${1000 + (id % 8999)} · ${vendor}`, "PO", (i) => `${1000 + (id % 8999) + i}`, true);
  }
  if (leaf.production_qty > 0) {
    push("IN", "531", "Job Card", splitQty(leaf.production_qty, partsFor(leaf.production_qty)),
      (i) => `Produced by JC-${2300 + (id % 600) + i}`, "JOB_CARD", (i) => `${2300 + (id % 600) + i}`, true);
  }
  if (leaf.returns_qty > 0) {
    push("IN", "451", "Cust. Return", splitQty(leaf.returns_qty, 1),
      () => "Returned by customer", "RTV", () => `RTV-${100 + (id % 900)}`, true);
  }
  if (leaf.consumption_qty > 0) {
    push("OUT", "261", "Job Card", splitQty(leaf.consumption_qty, partsFor(leaf.consumption_qty)),
      (i) => `Used in JC-${2400 + (id % 500) + i}`, "JOB_CARD", (i) => `${2400 + (id % 500) + i}`, false);
  }
  if (leaf.outward_qty > 0) {
    push("OUT", "601", "Dispatch", splitQty(leaf.outward_qty, partsFor(leaf.outward_qty)),
      () => "Dispatched → customer", "DISPATCH", (i) => `DN-${500 + (id % 400) + i}`, true);
  }
  if (leaf.transfer_out_qty > 0) {
    push("TRANSFER", "301", "Transfer", splitQty(leaf.transfer_out_qty, 1),
      () => "Transferred → Rishi", "TRANSFER", () => `TR-0${300 + (id % 90)}`, true);
  }
  return evs;
}

// spread events across Apr–Jul deterministically
function evDate(slot: number): { month: number; iso: string } {
  const month = 4 + (slot % 4);
  const day = 1 + ((slot * 3) % 27);
  return { month, iso: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

export interface ItemVouchers { rows: VoucherRow[]; totals: { in_qty: number; out_qty: number; closing: number }; opening: number; closing: number; }

export function buildVouchers(leaf: LeafItem): ItemVouchers {
  const evs = events(leaf).map((e) => ({ ...e, ...evDate(e.slot) }))
    .sort((a, b) => a.iso.localeCompare(b.iso) || a.slot - b.slot);

  const rows: VoucherRow[] = [];
  let bal = leaf.opening_qty;
  rows.push({
    ledger_id: leaf.sku_id * 100, posting_date: "2026-04-01", sku_name: leaf.label,
    vch_type: "Opening", vch_no: null, movement_type: "OB", direction: "IN",
    in_qty: null, out_qty: null, uom_class: leaf.uom_class, running_balance: bal,
    counterpart_label: "carried fwd", ref_type: null, ref_id: null, is_synthetic: false, fifo_flag: null,
  });
  let in_qty = 0, out_qty = 0;
  evs.forEach((e, i) => {
    const isIn = e.dir === "IN";
    if (isIn) { bal += e.qty; in_qty += e.qty; } else { bal -= e.qty; out_qty += e.qty; }
    // flag the first 261 consumption as a FIFO violation for items with 2+ inward lots
    const fifo = e.mvt === "261" && i === evs.findIndex((x) => x.mvt === "261") && leaf.inward_qty > 400
      ? "violation" as const : null;
    rows.push({
      ledger_id: leaf.sku_id * 100 + i + 1, posting_date: e.iso, sku_name: leaf.label,
      vch_type: e.type, vch_no: e.ref_id, movement_type: e.mvt, direction: e.dir,
      in_qty: isIn ? e.qty : null, out_qty: isIn ? null : e.qty, uom_class: leaf.uom_class,
      running_balance: round3(bal), counterpart_label: e.counterpart, ref_type: e.ref_type,
      ref_id: e.ref_id, is_synthetic: e.synthetic, fifo_flag: fifo,
    });
  });
  return {
    rows, opening: leaf.opening_qty, closing: computeClosing(leaf),
    totals: { in_qty: round3(in_qty), out_qty: round3(out_qty), closing: computeClosing(leaf) },
  };
}

export function buildMonthly(leaf: LeafItem): MonthlyRow[] {
  const { rows } = buildVouchers(leaf);
  const rate = rateOf(leaf);
  const months = [4, 5, 6, 7];
  const out: MonthlyRow[] = [{
    month: "Opening Balance", in_qty: null, in_value: null, out_qty: null, out_value: null,
    closing_qty: leaf.opening_qty, closing_value: Math.round(leaf.opening_qty * rate),
  }];
  let bal = leaf.opening_qty;
  for (const m of months) {
    const mr = rows.filter((r) => r.vch_type !== "Opening" && Number(r.posting_date.slice(5, 7)) === m);
    const inq = round3(mr.reduce((s, r) => s + (r.in_qty ?? 0), 0));
    const outq = round3(mr.reduce((s, r) => s + (r.out_qty ?? 0), 0));
    bal = round3(bal + inq - outq);
    out.push({
      month: MONTH_NAMES[m], in_qty: inq || null, in_value: inq ? Math.round(inq * rate) : null,
      out_qty: outq || null, out_value: outq ? Math.round(outq * rate) : null,
      closing_qty: bal, closing_value: Math.round(bal * rate),
    });
  }
  return out;
}

export function buildLots(leaf: LeafItem): Lot[] {
  const closing = computeClosing(leaf);
  if (closing <= 0) return []; // over-issued / negative — nothing positive on hand
  const chunks = splitQty(closing, Math.min(3, partsFor(closing) + 1));
  const ages = [92, 56, 24];
  const cold = leaf.godown === "Rishi" || leaf.godown === "Supreme" || leaf.godown === "Eskimo";
  return chunks.map((qty, i) => {
    const age = ages[i] ?? 30;
    const blocked = i === 0 && chunks.length >= 3;
    const near = i === 1 && !cold;
    return {
      batch_id: `BAT-${leaf.sku_id}-${String(i + 1).padStart(2, "0")}`,
      sku_name: leaf.label, lot_number: `LOT${12000 + (leaf.sku_id % 900) + i}`, box_id: null,
      current_qty: qty, uom_class: leaf.uom_class, warehouse_code: leaf.godown,
      floor_id: leaf.godown === "Savla D-39" ? "Factory" : null,
      status: blocked ? "BLOCKED" : "AVAILABLE",
      inward_date: daysAgoISO(age), expiry_date: cold ? null : daysAgoISO(age - 180),
      age_days: age, near_expiry: near, blocked_for_so: blocked ? `SO-${1100 + (leaf.sku_id % 90)}` : null,
      source_store: cold ? "cold_stocks" : "inventory_batch",
    };
  });
}

export function buildAgeing(lots: Lot[], uom: LeafItem["uom_class"], group: string): AgeingRow {
  const b = { b_0_30: 0, b_31_60: 0, b_61_90: 0, b_90_plus: 0 };
  let near = 0;
  for (const l of lots) {
    if (l.age_days <= 30) b.b_0_30 += l.current_qty;
    else if (l.age_days <= 60) b.b_31_60 += l.current_qty;
    else if (l.age_days <= 90) b.b_61_90 += l.current_qty;
    else b.b_90_plus += l.current_qty;
    if (l.near_expiry) near += l.current_qty;
  }
  const total = lots.reduce((s, l) => s + l.current_qty, 0);
  return {
    group_key: group, uom_class: uom,
    b_0_30: round3(b.b_0_30), b_31_60: round3(b.b_31_60), b_61_90: round3(b.b_61_90),
    b_90_plus: round3(b.b_90_plus), total_qty: round3(total),
    expired_qty: 0, near_expiry_qty: round3(near),
  };
}

export interface GodownRow { godown: string; qty: number; uom_class: string; note?: string; }
export function buildGodown(leaf: LeafItem): GodownRow[] {
  const closing = computeClosing(leaf);
  const rows: GodownRow[] = [{
    godown: `${leaf.godown}${leaf.godown === "Savla D-39" ? " · Factory" : ""}`,
    qty: round3(Math.max(closing, 0)), uom_class: leaf.uom_class,
  }];
  if (leaf.transfer_out_qty > 0) {
    rows.push({ godown: "Transferred out (period)", qty: round3(leaf.transfer_out_qty), uom_class: leaf.uom_class, note: "moved" });
  }
  if (closing < 0) {
    rows.push({ godown: "Negative balance (over-issue)", qty: round3(closing), uom_class: leaf.uom_class, note: "recon" });
  }
  return rows;
}

export function buildFifo(leaf: LeafItem, lots: Lot[]): FifoFlag[] {
  const out: FifoFlag[] = [];
  const oldest = lots.find((l) => l.status === "AVAILABLE");
  if (leaf.consumption_qty > 400 && lots.length >= 2) {
    out.push({
      flag_id: leaf.sku_id * 10 + 1, vch_no: `JC-${2400 + (leaf.sku_id % 500)}`, sku_name: leaf.label,
      consumed_lot: lots[1]?.lot_number ?? "—", oldest_available_lot: oldest?.lot_number ?? null,
      flag_type: "violation", reason: "newer lot issued first · logged fifo_skip_log", disposition: "leave_available",
    });
  }
  const blocked = lots.find((l) => l.status === "BLOCKED");
  if (blocked) {
    out.push({
      flag_id: leaf.sku_id * 10 + 2, vch_no: blocked.batch_id, sku_name: leaf.label,
      consumed_lot: blocked.lot_number, oldest_available_lot: null,
      flag_type: "blocked", reason: `block_for_so ${blocked.blocked_for_so} · excluded from pick`, disposition: null,
    });
  }
  const near = lots.find((l) => l.near_expiry);
  if (near) {
    out.push({
      flag_id: leaf.sku_id * 10 + 3, vch_no: near.batch_id, sku_name: leaf.label,
      consumed_lot: near.lot_number, oldest_available_lot: null,
      flag_type: "near_expiry", reason: "≤ shelf-life threshold · min_shelf_life not enforced", disposition: null,
    });
  }
  return out;
}

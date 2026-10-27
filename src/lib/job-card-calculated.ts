// Figures the Accounting tab works out instead of asking for them a second time.
//
// Operators typed the same numbers twice: "Qty consumed" beside the quantity
// they had just scanned, and FG kg here and then every box's weight again on
// Boxes printing. Decided 2026-10-26: the second entry is calculated —
//   • Qty consumed = the scanned quantity (less what this card's other batches
//     already recorded for that material), unless the operator presses Edit;
//   • FG kg = the batch's boxes (Boxes printing) once it has any.
// A figure saved earlier that differs from the calculation is the operator's
// own and stays as typed; "Use scanned" puts the calculation back.

import { KG_UOMS } from "./scanRollup.ts";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A quantity as the form holds it: up to 3 decimals, no trailing zeros. */
export function qtyText(n: number): string {
  return String(round3(n));
}

/**
 * What this batch consumed of one material, worked out from the scans.
 *
 * The scans are per job card (lib/scanRollup's header: a scan can't be tied to
 * an accounting batch), so on a card with several batches this batch gets what
 * was scanned less what the card's other batches already recorded — never below
 * zero. Null when there is nothing to calculate from: no scan, a packaging line
 * (never scanned), or a line not in kg (a scan is kg only).
 */
export function calculatedConsumption(opts: {
  scannedKg: number | null | undefined;
  uom: string | null | undefined;
  isPm: boolean;
  otherBatchesKg?: number;
}): number | null {
  const scanned = Number(opts.scannedKg);
  if (opts.isPm || opts.scannedKg == null || !Number.isFinite(scanned) || scanned <= 0) return null;
  if (!KG_UOMS.has((opts.uom ?? "").trim().toLowerCase())) return null;
  const other = Number(opts.otherBatchesKg) || 0;
  return round3(Math.max(0, scanned - other));
}

/**
 * Whether a line shows the calculation (read-only, with Edit) rather than an
 * input: there is one, the operator hasn't pressed Edit, and what is saved is
 * either nothing or the same figure (within a gram).
 */
export function followsCalculation(
  saved: string | null | undefined,
  calculated: number | null,
  edited: boolean,
): boolean {
  if (calculated == null || edited) return false;
  const t = (saved ?? "").trim();
  if (t === "") return true;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n - calculated) <= 0.0005;
}

/** One batch's boxes, as GET …/wip-boxes rolls them up in `by_batch`. */
export type BatchBoxes = { batch_id: number | null; boxes: number; net_kg: number };

/**
 * FG kg for a batch from its boxes: their total and count, or null when the
 * batch has none (FG kg is typed then, as before). Cancelled boxes are already
 * left out of `by_batch` by the server.
 */
export function boxedFg(byBatch: readonly BatchBoxes[], batchId: number | null): { kg: number; boxes: number } | null {
  if (batchId == null) return null;
  const e = byBatch.find((b) => b.batch_id === batchId);
  if (!e || !(e.boxes > 0)) return null;
  return { kg: round3(Number(e.net_kg) || 0), boxes: e.boxes };
}

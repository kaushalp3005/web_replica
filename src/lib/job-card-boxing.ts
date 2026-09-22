// "Is this job card finished boxing?" — the one rule the Boxes printing tab
// offers its "Mark job card completed" button on.
//
// The tab has two payloads that together answer it: GET …/batches (the
// accounting batches, each with the quantity it accounted for) and GET
// …/wip-boxes (the SFG boxes, rolled up per batch by the server). Neither is
// conclusive alone — a batch with no boxes looks identical to a batch nobody
// has accounted yet — so the decision lives here, once, as a pure function.
//
// THIS DOES NOT COMPLETE ANYTHING. It only decides whether to offer the button.
// PUT …/job-cards-v2/{id}/complete keeps its own gates (open shift, open batch,
// unbalanced accounting) and is the only thing that can refuse or allow the
// completion; a "ready" here is a hint, never a verdict.
//
// Cancelled batches are ignored throughout — a cancelled batch accounted for
// nothing and will never be boxed, so counting it would leave the job card
// permanently "not ready".

/** One batch's box rollup, as GET …/wip-boxes returns it in `by_batch`. */
export type BoxingBatch = {
  /** null for boxes not linked to any batch (legacy / unlinked). */
  batch_id: number | null;
  boxes: number;
  printed: number;
  net_kg: number;
};

/** The subset of a GET …/wip-boxes box row the fallback rollup needs. */
export type BoxingBoxRow = {
  batch_id?: number | null;
  net_weight: number | string | null;
  status?: string | null;
};

/** The subset of an accounting batch row this decision needs. */
export type BoxingBatchRow = {
  batch_id: number;
  batch_number?: number | null;
  status: string | null;
  produced_qty_kg: number | null;
  input_qty_kg: number | null;
  planned_qty_kg: number | null;
};

export type BoxingState = {
  ready: boolean;
  /** Plain English, for the muted line shown when not ready. Null when ready. */
  reason: string | null;
  /**
   * Total kg still to box across the closed batches, clamped at 0 per batch and
   * rounded to 3 dp. Raw — the tolerance applies to `ready`, not to this, so a
   * ready job card can still report a few grams here.
   */
  remainingKg: number;
  unprinted: number;
};

/** Server default (sfg_box_service.WEIGHT_TOLERANCE_KG). */
const DEFAULT_TOLERANCE_KG = 0.5;

/** A positive number, or null. Tolerates the numeric strings asyncpg/JSON emit. */
function positive(v: unknown): number | null {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a batch accounted for: the first of produced / input / planned that is a
 * number above zero. Mirrors the server's _batch_cap_kg, so the banner and the
 * server never disagree about how much a batch was supposed to yield.
 */
function capKg(b: BoxingBatchRow): number | null {
  return positive(b.produced_qty_kg) ?? positive(b.input_qty_kg) ?? positive(b.planned_qty_kg);
}

/** "Batch 3" — by batch number when the row carries one, else by its id. */
function batchName(b: BoxingBatchRow): string {
  const n = b.batch_number;
  return `Batch ${n != null && Number.isFinite(Number(n)) ? Number(n) : b.batch_id}`;
}

/** 3 dp without the noise: 12.500 → "12.5", 100.000 → "100". */
function kg(n: number): string {
  return n.toFixed(3).replace(/\.?0+$/, "");
}

function statusOf(b: BoxingBatchRow): string {
  return (b.status ?? "").trim().toLowerCase();
}

/**
 * Group the box rows of a GET …/wip-boxes payload the way its `by_batch`
 * rollup does. Only used when the server doesn't send one: the rows carry
 * batch_id, net_weight and status, so the banner keeps working rather than
 * quietly disappearing against an older server.
 *
 * A cancelled box is left out entirely — it is neither boxed material nor a
 * label waiting to be printed. Anything past PENDING has been printed: a box
 * can only become DISPATCHED / RECEIVED / CONSUMED after its label existed.
 */
export function rollupBoxesByBatch(boxes: readonly BoxingBoxRow[]): BoxingBatch[] {
  const m = new Map<number | null, BoxingBatch>();
  for (const b of boxes) {
    const status = (b.status ?? "").trim().toUpperCase();
    if (status === "CANCELLED") continue;
    const key = b.batch_id ?? null;
    const cur = m.get(key) ?? { batch_id: key, boxes: 0, printed: 0, net_kg: 0 };
    cur.boxes += 1;
    if (status !== "" && status !== "PENDING") cur.printed += 1;
    cur.net_kg += Number(b.net_weight) || 0;
    m.set(key, cur);
  }
  return [...m.values()].map((e) => ({ ...e, net_kg: Number(e.net_kg.toFixed(3)) }));
}

/**
 * Decide whether this job card has nothing left to box.
 *
 * Rules run in order and the first failure wins, so the operator is told the
 * one thing to do next rather than a list: close the batch, then account it,
 * then box the rest of it, then print the labels.
 *
 * A status that is neither 'open' nor 'cancelled' counts as closed — including
 * a missing one, which would otherwise let an unknown state pass every gate.
 */
export function boxingState(
  batches: readonly BoxingBatchRow[],
  byBatch: readonly BoxingBatch[],
  toleranceKg: number = DEFAULT_TOLERANCE_KG,
): BoxingState {
  const live = batches.filter((b) => statusOf(b) !== "cancelled");
  const closed = live.filter((b) => statusOf(b) !== "open");
  const netOf = (batchId: number) =>
    byBatch.find((e) => e.batch_id === batchId)?.net_kg ?? 0;

  // Boxes in scope: the closed batches' own, plus unlinked ones. An open batch
  // can't get this far, and a cancelled batch's boxes are not this JC's problem.
  const closedIds = new Set(closed.map((b) => b.batch_id));
  const entries = byBatch.filter((e) => e.batch_id == null || closedIds.has(e.batch_id));
  const boxes = entries.reduce((s, e) => s + (Number(e.boxes) || 0), 0);
  const unprinted = Math.max(
    0,
    boxes - entries.reduce((s, e) => s + (Number(e.printed) || 0), 0),
  );

  const remainingKg = Number(
    closed
      .reduce((s, b) => {
        const cap = capKg(b);
        return cap == null ? s : s + Math.max(0, cap - (Number(netOf(b.batch_id)) || 0));
      }, 0)
      .toFixed(3),
  );

  const no = (reason: string): BoxingState => ({ ready: false, reason, remainingKg, unprinted });

  if (live.length === 0) return no("No batches on this job card yet.");

  const open = live.find((b) => statusOf(b) === "open");
  if (open) return no(`${batchName(open)} is still open.`);

  const uncapped = closed.find((b) => capKg(b) == null);
  if (uncapped) return no(`${batchName(uncapped)} has no accounted quantity.`);

  for (const b of closed) {
    const short = (capKg(b) as number) - (Number(netOf(b.batch_id)) || 0);
    if (short > toleranceKg) return no(`${batchName(b)} still has ${kg(short)} kg to box.`);
  }

  if (unprinted > 0) {
    return no(`${unprinted} ${unprinted === 1 ? "box is" : "boxes are"} not printed yet.`);
  }
  if (boxes === 0) return no("No boxes have been printed yet.");

  return { ready: true, reason: null, remainingKg, unprinted };
}

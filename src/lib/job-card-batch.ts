// When the job card page offers Open Batch (the Accounting tab's New batch row) and
// Cancel batch (on a batch row), and what their confirms say.
// The server refuses a new batch on a finished card (job_card_batch_v2
// open_batch, NO_NEW_BATCH), except that an admin may still open one on a
// completed card to record a batch that was missed — closing it sends what it
// made on, capped at what is left to send. Never on a closed or cancelled card,
// and not before the card is assigned. Close JC is refused while any batch is
// open (job_card_v2 close_job_card, open_batch), so an open batch with nothing
// on it is cancelled (job_card_batch_v2 cancel_batch: only an empty one — no
// output, dispatch, shift or boxes). Pure, so it is tested without a browser
// (job-card-batch.test.ts).

const OPEN_BATCH_STATUSES = new Set(["assigned", "material_received", "in_progress"]);

/** Whether to show Open Batch on a card in this status (the caller also needs
 *  overview › start). */
export function openBatchOffered(status: string | null | undefined, isAdmin: boolean): boolean {
  const s = status ?? "";
  return OPEN_BATCH_STATUSES.has(s) || (s === "completed" && isAdmin);
}

/** The Open Batch confirm. On a completed card (only an admin gets there) it
 *  says that Close JC now waits for the new batch. */
export function openBatchConfirm(status: string | null | undefined, label: string): string {
  const what = label ? `Open a new batch named "${label}"` : "Open a new batch";
  if (status !== "completed") return `${what}?`;
  return `${what} on this completed job card?\n\nClose JC will wait until this batch is completed or cancelled.`;
}

/** Whether to show Cancel batch on a batch row (the caller also needs
 *  overview › close, the route's permission): an open batch with no output
 *  saved on it — no produced or FG kg, no output row and no boxes. The server
 *  checks the rest (dispatches, shifts) and says why when it refuses. */
export function cancelBatchOffered(
  batch: { status?: string | null; produced_qty_kg?: unknown; fg_actual_kg?: unknown },
  opts: { hasOutputRows?: boolean; boxes?: number } = {},
): boolean {
  if (batch.status !== "open") return false;
  if (batch.produced_qty_kg != null || batch.fg_actual_kg != null) return false;
  return !opts.hasOutputRows && !((opts.boxes ?? 0) > 0);
}

/** The Cancel batch confirm. */
export function cancelBatchConfirm(name: string): string {
  return `Cancel batch "${name}"? It has no output, so nothing else changes. This can't be undone.`;
}

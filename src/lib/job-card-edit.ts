// What Edit Job Card lets a planner change on an article that is already carded:
// the pop-up's half of the server's rules (backend job_card_v2
// apply_live_job_card_edits / replace_job_cards_for_line, which stay the
// authority). Agreed 2026-10-27:
//   • a chain may be one card, going from raw material straight to finished
//     goods — Edit used to need two rows, so such a card could not be edited;
//   • while a card runs: its floor and the quantity; its process name, and new
//     processes, only before anyone starts it; a finished card can't change;
//   • a new process goes in front of the last card only while that card still
//     waits for the stage before it ("locked") — once it has material, the new
//     card would never be released; nor in front of a one-card chain already
//     released to its floor (cancel it and card the chain again);
//   • a running stage (material in, or in progress) is stopped (Stop process),
//     not removed here — removing it left what it held on a dead card;
//   • the chain's first card, before it starts, can go — a team on it or not —
//     unless it holds material, or the floor has asked for material for it
//     (that requisition is cancelled first while store hasn't issued on it,
//     else an admin cancels the job card);
//   • a later card that already holds what the stage before sent it stays;
//   • the last row stays the card that makes the finished goods;
//   • nothing on a cancelled or executed plan.
// Pure, so it is tested without a browser (job-card-edit.test.ts).

/** Fewest rows the process list takes, in Create and Edit alike: one card can
 *  make the finished goods on its own. */
export const MIN_PROCESS_ROWS = 1;

const FINISHED = new Set(["completed", "closed", "cancelled"]);
// Material is in and being worked: such a card is stopped, never removed.
const RUNNING = new Set(["material_received", "in_progress"]);
// Nothing drawn on it yet.
const WAITING = new Set(["locked", "unlocked", "assigned"]);

/** One row of the pop-up's process list, as far as these rules need it. */
export interface EditRow {
  process: string;
  /** The saved card the row stands for; null/undefined for a new row. */
  jobCardId?: number | null;
  /** The card has moved past locked/unlocked. */
  started?: boolean;
  status?: string | null;
  /** The saved card holds material the stage before sent it (the server's
   *  holds_material); false or absent when it holds none. */
  holdsMaterial?: boolean;
  /** The floor has asked for material for the saved card (the server's
   *  has_requisition). */
  hasRequisition?: boolean;
}

/** A completed, closed or cancelled card: nothing on it changes. */
export function cardFinished(status: string | null | undefined): boolean {
  return FINISHED.has(status ?? "");
}

/** Whether a plan's job cards may be edited: not once it is cancelled (its
 *  cards went with it) or executed (they are all closed). */
export function planAllowsJobCardEdit(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s !== "cancelled" && s !== "executed";
}

/** Whether Edit changes the saved cards in place (apply-edits) rather than
 *  rebuilding them: once a card has started, or when the server says the
 *  un-started cards can't be rebuilt (editable=false). */
export function editsInPlace(cfg: { started?: boolean; editable?: boolean }): boolean {
  return cfg.started === true || cfg.editable === false;
}

/** Why Add process is off, or null. In an in-place edit a process goes in just
 *  before the last card, which must still be waiting for the stage before it.
 *  When that card is the saved chain's first (a one-card chain) it waits for
 *  nothing: released to its floor, it is cancelled and carded again instead. */
export function addProcessBlocked(
  inPlace: boolean,
  rows: readonly EditRow[],
  opts: { firstJobCardId?: number | null } = {},
): string | null {
  if (!inPlace || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  if (last.jobCardId == null || last.status === "locked") return null;
  if (opts.firstJobCardId != null && last.jobCardId === opts.firstJobCardId
    && (last.status === "unlocked" || last.status === "assigned")) {
    return `${last.process || "This process"} is the chain's first stage and is already released to its floor, so a `
      + "process can't be added before it. Ask an admin to cancel that job card, then create the job cards again with "
      + "the new process.";
  }
  return `${last.process || "The last process"} has already received material — a process can't be added before it.`;
}

/** Why row i can't be removed, or null. Never the only row. In an in-place
 *  edit (the server's apply-edits rules): never the last (it makes the finished
 *  goods, and the server matches it by its job card), never a finished card,
 *  and never a running one — Stop process on its job card sends on what it made
 *  first. A card that already holds material stays. The saved chain's first
 *  card (`firstJobCardId`, by the saved order, not where the row now sits) the
 *  floor asked material for stays until that requisition is cancelled (only
 *  while store hasn't issued on it) or an admin cancels the job card. A card
 *  still waiting with nothing — a team on it or not — can go. */
export function removeBlocked(
  i: number,
  rows: readonly EditRow[],
  opts: { inPlace: boolean; firstJobCardId?: number | null },
): string | null {
  if (rows.length <= MIN_PROCESS_ROWS) return "A job card needs at least one process.";
  if (!opts.inPlace) return null;
  const r = rows[i];
  if (!r) return null;
  if (i === rows.length - 1) return "The last process makes the finished goods, so it stays.";
  if (r.jobCardId == null) return null;
  const status = r.status ?? "";
  if (FINISHED.has(status)) return `${r.process || "This process"} has finished, so it stays.`;
  // A status this list doesn't know, on a started card, is treated as running.
  if (RUNNING.has(status) || (r.started && !WAITING.has(status))) {
    return `${r.process || "This stage"} has started. Use Stop process on its job card — it sends on what was made first.`;
  }
  const isFirst = opts.firstJobCardId != null && r.jobCardId === opts.firstJobCardId;
  if (r.holdsMaterial) {
    // The first card has no stage before it: what it holds is its own output.
    const what = isFirst ? "already has material on it" : "has already received material from the stage before";
    return `${r.process || "This stage"} ${what}, so it can't be removed. Keep it in the chain so that material is worked.`;
  }
  if (isFirst && r.hasRequisition) {
    // A requisition can be cancelled only while it is still 'raised'; Cancel JC
    // is an admin's.
    return `The floor has asked for material for ${r.process || "this stage"}. Cancel that requisition if store `
      + "hasn't issued anything on it yet, then remove the process here — or ask an admin to cancel this job card.";
  }
  return null;
}

/** Said, and Save kept off, when every saved card has finished: the server
 *  refuses any change then. null otherwise. */
export function chainFinishedNote(cards: readonly { status?: string | null }[]): string | null {
  if (!cards.length || !cards.every((c) => cardFinished(c.status))) return null;
  return "Every stage of this chain has finished, so nothing on it can change. Plan any more as a new job card.";
}

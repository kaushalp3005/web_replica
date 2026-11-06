// Plan Detail's half of the server's steps_locked_by_cards refusal (backend
// plan_v2._steps_locked_refusal): on a line whose job cards are in a merged
// process run, or that was carded as several chains, POST / reorder / DELETE of
// a plan step are refused (409), before anything is written. Such a line keeps
// its steps — none is added, moved or removed (merging steps removes the ones
// merged in) — while a step's fields (process, floor, time) still change.
// get_plan says so per line as `steps_locked`: {reason, message}, or null when
// the steps may change; an older server leaves it out (read as null). Pure, so
// it is tested without a browser (plan-steps-lock.test.ts).

export interface StepsLock {
  /** "merged_run" | "multiple_chains"; "" when the server did not say. */
  reason: string;
  /** The server's sentence, shown as the reason the controls are off. */
  message: string;
}

export const STEPS_LOCKED_FALLBACK = "This article's job cards are part of a merged process run or of several "
  + "chains, so its steps can't be added, moved or removed here. Leave the steps as they are.";

/** The line's steps lock, or null when its steps may be added, moved and removed. */
export function stepsLockOf(line: { steps_locked?: unknown } | null | undefined): StepsLock | null {
  const v = line?.steps_locked;
  if (v == null || v === false) return null;
  const o = (typeof v === "object" ? v : {}) as { reason?: unknown; message?: unknown };
  const message = typeof o.message === "string" ? o.message.trim() : "";
  return { reason: typeof o.reason === "string" ? o.reason : "", message: message || STEPS_LOCKED_FALLBACK };
}

/** Why Save is refused before anything is sent, or null: the line's steps are
 *  locked and the save would add, move or remove one. */
export function stepsLockRefusal(
  lock: StepsLock | null,
  change: { deletes: number; orderChanged: boolean; newSteps: number },
): string | null {
  if (!lock) return null;
  return change.deletes > 0 || change.orderChanged || change.newSteps > 0 ? lock.message : null;
}

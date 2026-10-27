// What the job card screen tells the operator to do next, as pure functions so
// the wording can be tested without a page.
//
// A locked card used to say "assign a team and START" — both are hidden while
// it is locked — and never said which stage it was waiting on. Saving output
// said "Output saved." even when the batch stayed open. Closing before the
// sign-off showed the raw code "missing_sign_offs".

/** The stage a card waits on, as the chain lists it. */
export type UpstreamCard = {
  jobCardId: number;
  number: string | null;
  process: string | null;
  status: string | null;
};

type ChainLike = {
  job_card_id: number;
  job_card_number: string | null;
  step_number: number;
  process_name: string | null;
  status: string | null;
};

/**
 * The card this one waits on: its prev_job_card_id when the chain has it, else
 * the chain's previous step. Null on a first stage or when neither is known.
 */
export function upstreamCard(
  chain: readonly ChainLike[],
  card: { prev_job_card_id?: number | null; step_number?: number | null },
): UpstreamCard | null {
  const prevId = card.prev_job_card_id ?? null;
  let step = prevId != null ? chain.find((s) => s.job_card_id === prevId) : undefined;
  if (!step && card.step_number != null && card.step_number > 1) {
    step = chain.find((s) => s.step_number === (card.step_number as number) - 1);
  }
  if (!step) return null;
  return {
    jobCardId: step.job_card_id,
    number: step.job_card_number,
    process: step.process_name,
    status: step.status,
  };
}

const words = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ").trim();

/** "Job card PLAN-7-L1-S1 (Roasting, in progress)" — or the bits that are known. */
export function upstreamLabel(u: UpstreamCard): string {
  const name = u.number?.trim() || String(u.jobCardId);
  const extra = [u.process?.trim(), words(u.status)].filter(Boolean).join(", ");
  return `job card ${name}${extra ? ` (${extra})` : ""}`;
}

/** The waiting-on-material sentence, naming the card when it is known. */
export function waitingText(u: UpstreamCard | null): string {
  const who = u ? upstreamLabel(u) : "the previous stage";
  return `Waiting on ${who} to send its material. This card unlocks by itself when it does.`;
}

export type LifecycleHint = { title: string; body: string };

/**
 * The strip above the tabs before production starts. Null once it has started
 * (in progress and later) — the tabs carry their own state then.
 */
export function lifecycleHint(opts: {
  status: string | null | undefined;
  locked: boolean;
  lockedReason: string | null | undefined;
  upstream: UpstreamCard | null;
}): LifecycleHint | null {
  // Only before START: a card locked later on (a QC hold mid-run) shows the
  // tabs' own lock banner, and has no team or START to talk about.
  const status = opts.status ?? "";
  if (!["locked", "unlocked", "assigned", "material_received"].includes(status)) return null;
  if (opts.locked || status === "locked") {
    const reason = (opts.lockedReason ?? "").trim();
    if (!reason || reason === "awaiting_previous_stage") {
      return {
        title: "Waiting on the previous stage.",
        body: `${waitingText(opts.upstream)} Then assign a team on the Overview tab and press START.`,
      };
    }
    return {
      title: "Job card is locked.",
      body: `${words(reason)}. Assign Team and START stay hidden until it is unlocked.`,
    };
  }
  if (status === "unlocked") {
    return {
      title: "Job card not started.",
      body: "Assign a team on the Overview tab, then press START to enable Output, Accounting, Quality and Remarks.",
    };
  }
  return {
    title: "Job card not started.",
    body: "Press START above to enable Output, Accounting, Quality and Remarks.",
  };
}

/**
 * The extra line after "Output saved" when the batch was left open — it used to
 * say only "Output saved." Null when completion was attempted (its own message
 * says how that went) or the batch isn't open.
 */
export function savedButOpenNote(opts: {
  batchOpen: boolean;
  completionAttempted: boolean;
  canComplete: boolean;
  fgKg: number;
}): string | null {
  if (!opts.batchOpen || opts.completionAttempted) return null;
  if (!opts.canComplete) {
    return "Output saved. The batch is still open: completing it needs the Complete permission — "
      + "ask a supervisor to open this batch and press Save.";
  }
  if (!(opts.fgKg > 0)) {
    return "Output saved. The batch is still open: enter the FG kg produced, then Save again to complete it.";
  }
  return null;
}

/** The refusal code in a job card error body ({detail: {error}} or {error}). */
export function refusalCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { error?: unknown; detail?: unknown };
  if (b.detail && typeof b.detail === "object") {
    const e = (b.detail as { error?: unknown }).error;
    if (typeof e === "string") return e;
  }
  return typeof b.error === "string" ? b.error : null;
}

// What the plan screen says after Approve / Cancel / Delete. Approve used to
// say "Plan approved" even when articles were skipped, and Cancel claimed the
// SO qty was released while the plan's job cards stayed live. The server now
// reports what it actually did; these put that into words. Pure, so it is
// tested without a browser (plan-outcome.test.ts).

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return v && typeof v === "object" ? (v as Obj) : {};
}

function n(v: unknown): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** After Approve. */
export function approveSummary(result: unknown): string {
  const r = asObj(result);
  const cards = n(r.job_card_count);
  const carded = n(r.articles_carded);
  const already = n(r.articles_already_carded);
  const parts = ["Plan approved"];
  if (cards > 0) parts.push(`${plural(cards, "job card")} made for ${plural(carded, "article")}`);
  if (already > 0) {
    parts.push(cards > 0
      ? `${plural(already, "article")} already had job cards`
      : "every article already had job cards");
  }
  return parts.join(" · ");
}

/** Appended after Create Job Card / a merged run: what carding the plan's last
 *  article did to the plan. It used to approve it unseen, for anyone allowed to
 *  card; now only someone who may approve plans does ("approved"), and for
 *  anyone else it waits ("awaits_approval"). A merge reports per plan id. */
export function planReleaseNote(release: unknown): string {
  const say = (outcome: unknown, plan?: string) => {
    const which = plan ? `plan ${plan}` : "the plan";
    if (outcome === "approved") return `every article is carded, so ${which} is now approved`;
    if (outcome === "awaits_approval") return `every article is carded; ${which} now waits for a planner to approve it`;
    return "";
  };
  if (typeof release === "string") {
    const s = say(release);
    return s ? ` · ${s}.` : "";
  }
  const parts = Object.entries(asObj(release)).map(([plan, outcome]) => say(outcome, plan)).filter(Boolean);
  return parts.length ? ` · ${parts.join("; ")}.` : "";
}

/** After Cancel ("cancelled") or Delete ("deleted"). */
export function retireSummary(result: unknown, verb: "cancelled" | "deleted"): string {
  const r = asObj(result);
  const cards = n(r.job_cards_cancelled);
  const released = asObj(r.released);
  const kg = n(released.kg);
  const parts = [`Plan ${verb}`];
  if (cards > 0) parts.push(`${plural(cards, "job card")} cancelled with it`);
  parts.push(kg > 0
    ? `${kg.toFixed(3)} kg is pending on the sales order again`
    : "nothing was reserved on a sales order");
  return parts.join(" · ");
}

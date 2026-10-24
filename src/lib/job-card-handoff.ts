// What the job card screen says after a stage hands its output on. Completing /
// closing a stage now sends what it produced but hadn't dispatched on to the
// next stage (the server's `sent_on`), and Distribute shares a merged run's
// whole output across its packaging cards — the screen reports what actually
// happened instead of a fixed "Distributed". Pure, so it is tested without a
// browser (job-card-handoff.test.ts).

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | null {
  return v && typeof v === "object" ? (v as Obj) : null;
}

function kg(v: unknown): string {
  return `${Number(v ?? 0).toFixed(3)} kg`;
}

function cards(n: number): string {
  return `${n} packaging card${n === 1 ? "" : "s"}`;
}

/** Appended to "Production completed." / "Job card closed."; "" when nothing moved. */
export function sentOnNote(result: unknown): string {
  const sent = asObj(asObj(result)?.sent_on);
  if (!sent) return "";
  if (typeof sent.error === "string") {
    const why = typeof sent.message === "string" ? sent.message : sent.error;
    return ` The remaining output was not sent on: ${why}.`;
  }
  const shared = Array.isArray(sent.results) ? sent.results.length : 0;
  return shared > 0
    ? ` ${kg(sent.qty_kg)} not yet dispatched was shared across ${cards(shared)}.`
    : ` ${kg(sent.qty_kg)} not yet dispatched was sent on to the next stage.`;
}

/** After Distribute to packaging. */
export function distributeSummary(result: unknown): string {
  const r = asObj(result) ?? {};
  const n = Array.isArray(r.results) ? r.results.length : 0;
  if (r.dispatched_kg == null) return `Shared the output across ${cards(n)}.`;
  const left = Number(r.remaining_kg ?? 0);
  return `Shared ${kg(r.dispatched_kg)} across ${cards(n)}.`
    + (left >= 0.001 ? ` ${kg(left)} is still on this card.` : "");
}

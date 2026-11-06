// What a completed job card offers next and what CLOSE JC says, from the kg it
// still has to send on. The server publishes that figure (remaining_to_send_kg:
// the rule its dispatch cap and its send-on at complete / close use); an older
// server without it falls back to output minus dispatched. These decisions used
// the 0.05 kg Accounting tolerance, so CLOSE JC hid while more than 50 g was left
// even though closing sends it all on, and the Dispatch prompt accepted 50 g the
// server then refused. Pure, so it is tested without a browser
// (job-card-send-on.test.ts).

/** Half a gram: the server's SEND_ON_EPS_KG (kg are kept to the gram). */
export const SEND_ON_EPS_KG = 0.0005;

export type SendOnCard = {
  output_kind?: string | null;
  next_job_card_id?: number | null;
  process_group_id?: number | null;
  dispatched_to_next_kg?: number | string | null;
  remaining_to_send_kg?: number | string | null;
  section_5_output?: { fg_actual_kg?: number | string | null } | null;
};

/** Where the remaining output goes: the next card, or a merged run's packaging cards. */
export type SendOnTarget = { kind: "next"; jobCardId: number } | { kind: "group" };

export type CompletedCardPlan = {
  /** The send-on button beside CLOSE JC; null when nothing is left or it has nowhere to go. */
  send: "dispatch" | "distribute" | null;
  remainingKg: number;
  target: SendOnTarget | null;
};

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function grams(kg: number): number {
  return Math.round(kg * 1000) / 1000;
}

export function kgText(kg: number): string {
  return `${kg.toFixed(3)} kg`;
}

/** kg this card made but hasn't sent on, to the gram; 0 when that is nothing. */
export function remainingToSendKg(card: SendOnCard): number {
  const left = toNum(card.remaining_to_send_kg)
    ?? grams((toNum(card.section_5_output?.fg_actual_kg) ?? 0) - (toNum(card.dispatched_to_next_kg) ?? 0));
  return left > SEND_ON_EPS_KG ? left : 0;
}

export function sendOnTarget(card: SendOnCard): SendOnTarget | null {
  if (card.next_job_card_id) return { kind: "next", jobCardId: card.next_job_card_id };
  const kind = (card.output_kind ?? "").toUpperCase();
  if (card.process_group_id != null && (kind === "SFG" || kind === "WIP")) return { kind: "group" };
  return null;
}

export function completedCardPlan(card: SendOnCard): CompletedCardPlan {
  const remainingKg = remainingToSendKg(card);
  const target = sendOnTarget(card);
  const send = remainingKg > 0 && target ? (target.kind === "next" ? "dispatch" : "distribute") : null;
  return { send, remainingKg, target };
}

/** CLOSE JC's confirm: says what closing sends on, and to which card. A merged
 *  run's packaging cards may all have finished, and nothing here says which are
 *  still open, so that confirm promises nothing: closing shares what the open
 *  ones take, and the rest stays recorded on the card. */
export function closeConfirmMessage(card: SendOnCard): string {
  const base = "Close this job card after sign-offs? It will become read-only.";
  const left = remainingToSendKg(card);
  const target = sendOnTarget(card);
  if (left <= 0 || !target) return base;
  if (target.kind === "group") {
    return `${base}\n\nClosing shares the remaining ${kgText(left)} across this merged run's packaging cards that are `
      + "still open; anything that can't be sent stays recorded on this card.";
  }
  return `${base}\n\nClosing sends the remaining ${kgText(left)} on to job card ${target.jobCardId}.`;
}

/** The Dispatch prompt's default: the remainder rounded DOWN to the gram, so it
 *  never asks for more than the server allows (a rounded-up 12.35 for 12.346 was
 *  refused). The 1e-6 keeps 12.346 * 1000 = 12345.999… from dropping a gram. */
export function dispatchPrefill(remainingKg: number): string {
  return (Math.floor(remainingKg * 1000 + 1e-6) / 1000).toFixed(3);
}

/** The typed dispatch qty to the gram, or why it can't be sent. */
export function readDispatchQty(typed: string, remainingKg: number): { qty: number } | { error: string } {
  const qty = grams(parseFloat(typed));
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Qty must be a positive number of kg." };
  if (qty > remainingKg + SEND_ON_EPS_KG) {
    return { error: `Only ${kgText(remainingKg)} is left to send on. Enter ${kgText(remainingKg)} or less.` };
  }
  return { qty };
}

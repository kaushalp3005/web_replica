// Linking a development job card to the request it was developed for, and the date floor
// for a request's expected dispatch date. Pure — no fetch — so it runs under
// `node src/lib/npd-link.test.ts`.
//
// Only a request's "Develop" button used to set the link, so a card made from the
// "Development job card" menu never told its request it was done (63 of 98 cards).

import type { Requisition } from "./sample";

/** Today as YYYY-MM-DD in the browser's calendar — never toISOString(), which is the UTC
 *  day and, for the first 5.5 h of an IST morning, still yesterday. The server refuses a
 *  new request's expected dispatch date before its own IST today. */
export function todayLocalISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Statuses a card can be linked to — the server's open set, less DRAFT (never sent to
 *  NPD) and PARTIALLY_CONVERTED (a non-NPD flow). */
export const LINKABLE_STATUSES = [
  "SUBMITTED", "ON_HOLD", "BH_APPROVED", "IN_PRODUCTION", "PACKING", "READY_FOR_DISPATCH",
] as const;

type LinkRow = Pick<Requisition, "id" | "request_id" | "sample_type" | "status" | "created_at"
  | "npd_target_name" | "npd_targets" | "company_name" | "customer_name" | "linked_dev_jc_id">;

/** Open NPD / TRIAL requests, the ones still waiting for a card first, newest first. */
export function linkCandidates<T extends LinkRow>(rows: T[]): T[] {
  const open = new Set<string>(LINKABLE_STATUSES);
  return rows
    .filter((r) => (r.sample_type === "NPD" || r.sample_type === "TRIAL") && open.has(r.status))
    .sort((a, b) =>
      Number(a.linked_dev_jc_id != null) - Number(b.linked_dev_jc_id != null)
      || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
}

/** "33461896 · Roasted salted cashew +2 more · More Retail Pvt Ltd" */
export function linkLabel(r: LinkRow): string {
  const more = (r.npd_targets?.length ?? 0) > 1 ? ` +${(r.npd_targets?.length ?? 0) - 1} more` : "";
  const who = r.company_name || r.customer_name;
  return [
    String(r.request_id ?? r.id),
    `${r.npd_target_name ?? "—"}${more}`,
    who || null,
    r.linked_dev_jc_id != null ? `already has job card ${r.linked_dev_jc_id}` : null,
  ].filter(Boolean).join(" · ");
}

/** Why an expected dispatch date can't be saved, or null. A date before today is refused
 *  (the server says the same) unless it is the request's own unchanged date: the edit
 *  form sends every field back, and an old request keeps its old date. */
export function dispatchDateError(value: string, original?: string | null,
                                  today: string = todayLocalISO()): string | null {
  const v = (value ?? "").slice(0, 10);
  if (!v || v === (original ?? "").slice(0, 10)) return null;
  return v < today ? "Expected dispatch date can't be before today" : null;
}

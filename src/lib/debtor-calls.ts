// Debtors Collection — everything the screen gets from the collections
// backend's database: the Parties table itself, and what the Sarvam
// Collections agent noted after calling a party. The backend keeps those
// summaries per party as a date-wise list; one the team no longer wants can be
// deleted from it (the call and its conversation stay).
//
// These go to this app's own /api/collections/* Route Handlers, never to the
// collections backend directly: its key must not reach the browser. See
// src/lib/server/collections.ts.

import { fetchMe, readApiErrorMessage, tokenStore } from "@/lib/auth";
import { partyKey, reportFromDatabase, type DpdParty, type DpdReport, type DpdSectionKey } from "@/lib/debtors";

export interface CallSummary {
  /** The call this summary came from. */
  id: string;
  /** The day the call was placed, YYYY-MM-DD, in IST. */
  date: string;
  /** When it was placed, ISO 8601 with the IST offset. */
  at: string;
  summary: string;
  /** The agent's outcome, e.g. "promised_to_pay"; null when it gave none. */
  disposition: string | null;
  /** YYYY-MM-DD. */
  promiseDate: string | null;
  promiseAmount: number | null;
  /** Placed in test mode: it rang the test phone, not the customer. */
  isTest: boolean;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function toSummary(v: unknown): CallSummary | null {
  const r = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const id = r ? text(r.id) : null;
  const summary = r ? text(r.summary) : null;
  const at = r ? text(r.at) : null;
  if (!r || !id || !summary || !at) return null;
  return {
    id,
    date: text(r.date) ?? at.slice(0, 10),
    at,
    summary,
    disposition: text(r.disposition),
    promiseDate: text(r.promise_date),
    promiseAmount: typeof r.promise_amount === "number" && Number.isFinite(r.promise_amount) ? r.promise_amount : null,
    isTest: r.is_test === true,
  };
}

// Same-origin on purpose (apiFetch would prefix the ERP backend's origin when
// one is configured). A 401 gets one retry after fetchMe has refreshed the
// session — or signed the user out, if it could not.
async function collectionsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () => {
    const headers = new Headers(init.headers);
    const token = tokenStore.accessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers, cache: "no-store" });
  };
  const first = await send();
  if (first.status !== 401) return first;
  try {
    await fetchMe();
  } catch {
    return first;
  }
  return send();
}

/** The section's parties, from the database — the screen's only source. null
 *  when nothing has been loaded for the section. Throws when the database
 *  cannot be reached; there is no other copy to fall back on. */
export async function loadDpdReport(section: DpdSectionKey, signal?: AbortSignal): Promise<DpdReport | null> {
  const res = await collectionsFetch(`/api/collections/parties?section=${encodeURIComponent(section)}`, { signal });
  if (!res.ok) {
    // 404 comes from a collections backend deployed before this endpoint existed.
    const fallback = res.status === 404
      ? "The collections service on this server is out of date and cannot list the parties yet."
      : `Couldn't load the parties from the database (HTTP ${res.status}).`;
    throw new Error(res.status === 404 ? fallback : await readApiErrorMessage(res, fallback));
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error("The parties list from the database is not valid JSON.");
  }
  return reportFromDatabase(section, raw);
}

const summariesUrl = (partyKey: string) => `/api/collections/summaries?party=${encodeURIComponent(partyKey)}`;

/** A party's call summaries, newest first. */
export async function fetchCallSummaries(partyKey: string, signal?: AbortSignal): Promise<CallSummary[]> {
  const res = await collectionsFetch(summariesUrl(partyKey), { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Couldn't load the call summaries (HTTP ${res.status}).`));
  const data = (await res.json().catch(() => null)) as { items?: unknown } | null;
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map(toSummary).filter((s): s is CallSummary => s !== null);
}

/** Remove one summary from a party's list. */
export async function deleteCallSummary(partyKey: string, summaryId: string): Promise<void> {
  const res = await collectionsFetch(`${summariesUrl(partyKey)}&id=${encodeURIComponent(summaryId)}`, { method: "DELETE" });
  // Already gone (deleted from another tab) is the outcome that was asked for.
  if (res.ok || res.status === 404) return;
  throw new Error(await readApiErrorMessage(res, `Couldn't delete the summary (HTTP ${res.status}).`));
}

// ── Calls ────────────────────────────────────────────────────────────────────

export type CallStatus = "initiated" | "connected" | "no_answer" | "busy" | "failed" | "unknown";

/** One turn of a call: who spoke, and what they said (in English). */
export interface ConversationTurn {
  role: "agent" | "customer";
  text: string;
}

export interface CollectionCall {
  id: string;
  /** "initiated" while the phone is ringing or the agent is still talking. */
  status: CallStatus;
  /** Placed in test mode: it rang the test phone, not the customer. */
  isTest: boolean;
  disposition: string | null;
  /** YYYY-MM-DD. */
  promiseDate: string | null;
  promiseAmount: number | null;
  durationSec: number | null;
  failureReason: string | null;
  /** The call, turn by turn; empty until it has finished, or if nobody spoke. */
  conversation: ConversationTurn[];
}

export interface PlacedCall {
  callId: string;
  isTest: boolean;
  /** The number actually rung — the test phone in test mode. */
  dialedNumber: string | null;
}

const STATUSES: readonly string[] = ["initiated", "connected", "no_answer", "busy", "failed", "unknown"];
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toTurns(v: unknown): ConversationTurn[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t): ConversationTurn[] => {
    const r = t !== null && typeof t === "object" ? (t as Record<string, unknown>) : null;
    const said = r ? text(r.en_text) ?? text(r.indic_text) : null;
    // Sarvam calls the person on the other end "user".
    return r && said ? [{ role: r.role === "agent" ? "agent" : "customer", text: said }] : [];
  });
}

/** Ask the collections agent to call a party now. The backend refuses — with a
 *  message worth showing as it is — when there is nothing outstanding, no
 *  mobile number, a call already in progress, a call too recently, or it is
 *  outside calling hours. */
export async function placeCall(section: DpdSectionKey, party: DpdParty): Promise<PlacedCall> {
  const res = await collectionsFetch(`/api/collections/call?party=${encodeURIComponent(partyKey(section, party))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      section,
      party_name: party.customer,
      // The whole field: the backend dials the first valid mobile number in it.
      phone: party.phone ?? "",
      division: party.division,
      sales_person: party.salesPerson,
      party_type: party.type,
      broker: party.broker,
      remarks: party.remarks,
      outstanding: party.pending,
      ageing: party.ageing,
    }),
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Couldn't start the call (HTTP ${res.status}).`));
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const callId = data ? text(data.call_id) : null;
  if (!data || !callId) throw new Error("The call was accepted but no call id came back.");
  return { callId, isTest: data.is_test === true, dialedNumber: text(data.dialed_number) };
}

/** A call's status, outcome and conversation. Poll it while status is "initiated". */
export async function fetchCall(callId: string, signal?: AbortSignal): Promise<CollectionCall> {
  const res = await collectionsFetch(`/api/collections/call?id=${encodeURIComponent(callId)}`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Couldn't load the call (HTTP ${res.status}).`));
  const r = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const status = r ? text(r.status) : null;
  if (!r || !status) throw new Error("The call is not in the expected format.");
  return {
    id: callId,
    status: (STATUSES.includes(status) ? status : "unknown") as CallStatus,
    isTest: r.is_test === true,
    disposition: text(r.disposition),
    promiseDate: text(r.promise_date),
    promiseAmount: finite(r.promise_amount),
    durationSec: finite(r.duration_sec),
    failureReason: text(r.failure_reason),
    conversation: toTurns(r.conversation),
  };
}

/** "promised_to_pay" → "Promised to pay". */
export function dispositionLabel(disposition: string): string {
  const s = disposition.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

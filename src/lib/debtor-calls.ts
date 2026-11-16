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
import {
  partyFromDatabase, reportFromDatabase, type AgeBucketKey, type DpdParty, type DpdReport, type DpdSectionKey,
} from "@/lib/debtors";

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

// ── Excel export ─────────────────────────────────────────────────────────────

/** One party as the export endpoint gives it: the table's columns under the
 *  database's names, its call summaries and its calls, newest first. */
export interface DpdExportParty extends DpdAmounts {
  party_id: string;
  customer: string;
  cd_cf: string | null;
  sales_person: string | null;
  type: string | null;
  remarks: string | null;
  contact_number: string | null;
  call_summary: {
    id: string; date: string; at: string; summary: string; status: string | null; disposition: string | null;
    promise_date: string | null; promise_amount: number | null; is_test: boolean;
  }[];
  calls: {
    id: string; date: string | null; created_at: string | null; status: string | null; is_test: boolean;
    disposition: string | null; promise_date: string | null; promise_amount: number | null; duration_sec: number | null;
    callback_time: string | null; dispute_reason: string | null;
    conversation: { role?: string; en_text?: string; indic_text?: string }[] | null;
  }[];
}

/** A tab's parties with their call summaries and calls, for the Excel export. */
export async function fetchDpdExport(section: DpdSectionKey): Promise<DpdExportParty[]> {
  const res = await collectionsFetch(`/api/collections/export?section=${encodeURIComponent(section)}`);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `The export failed (HTTP ${res.status}).`));
  const data = (await res.json().catch(() => null)) as { parties?: unknown } | null;
  if (!data || !Array.isArray(data.parties)) throw new Error("The export is not in the expected format.");
  return data.parties as DpdExportParty[];
}

// ── Uploading Tally's raw export ─────────────────────────────────────────────

/** The five figures of a row, under the database's column names. */
export interface DpdAmounts {
  outstanding: number;
  below_30_days: number;
  days_30_to_60: number;
  days_60_to_90: number;
  above_90_days: number;
}

/** What an upload would do to a section's DPD — or, after apply, what it did. */
export interface DpdUploadPlan {
  section: DpdSectionKey;
  /** layout: Tally's group report, or the ledger list (one row per customer, with a Sales person column and no
   *  company name). total_checked: the file had a Grand Total and its rows add up to it; a ledger list has none,
   *  and each of its rows was checked to add up to its own Pending Bills instead. */
  files: {
    division: "CF" | "CD"; company: string | null; period: string | null; layout: "groups" | "ledgers"; total_checked: boolean;
    rows: number; debit: number; credit: number;
  }[];
  /** Customers already in the DPD: new figures, everything else kept. */
  updated: { party_id: string; customer: string; division: string | null; sales_person: string | null; before: DpdAmounts; after: DpdAmounts }[];
  /** Customers that owe but are not in the DPD: added only when ticked. */
  new: {
    party_id: string; customer: string; division: string | null; sales_person: string | null; type: string | null;
    amounts: DpdAmounts; reason: string; include_by_default: boolean;
  }[];
  /** In the DPD but owing nothing now: removed, or kept with dues at zero when it has calls. */
  dropped: { party_id: string; customer: string; division: string | null; outstanding_before: number; has_history: boolean; why: string }[];
  /** Ledgers that are never DPD customers, and why. */
  left_out: { division: string | null; customer: string; where: string; debit: number; credit: number; net: number; reason: string }[];
  warnings: string[];
  /** After apply only. */
  result?: { updated: number; added: number; removed: number; kept_with_history: number; not_added: number; left_out: number };
}

/** The files of one upload, for either tab: CF and/or CD. Each replaces only its own company's rows in that tab. */
export interface DpdUploadFiles {
  cf?: File | null;
  cd?: File | null;
}

function uploadForm(section: DpdSectionKey, files: DpdUploadFiles, include?: string[]): FormData {
  const form = new FormData();
  form.set("section", section);
  if (files.cf) form.set("cf_file", files.cf, files.cf.name);
  if (files.cd) form.set("cd_file", files.cd, files.cd.name);
  if (include) form.set("include", JSON.stringify(include));
  return form;
}

async function upload(step: "preview" | "apply", form: FormData): Promise<DpdUploadPlan> {
  const res = await collectionsFetch(`/api/collections/upload?step=${step}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `The upload failed (HTTP ${res.status}).`));
  const plan = (await res.json().catch(() => null)) as DpdUploadPlan | null;
  if (!plan || !Array.isArray(plan.updated)) throw new Error("The reply to the upload is not in the expected format.");
  return plan;
}

/** What uploading these files would change. Writes nothing. */
export function previewDpdUpload(section: DpdSectionKey, files: DpdUploadFiles): Promise<DpdUploadPlan> {
  return upload("preview", uploadForm(section, files));
}

/** Replace the section's DPD (the part the files cover) with what they say.
 *  `include` is the party_ids of the new customers to add. */
export function applyDpdUpload(section: DpdSectionKey, files: DpdUploadFiles, include: string[]): Promise<DpdUploadPlan> {
  return upload("apply", uploadForm(section, files, include));
}

// ── Editing a row ────────────────────────────────────────────────────────────

/** What was changed on a row: only the fields that differ from what is saved.
 *  A text field set to "" is cleared (the customer name cannot be). */
export interface PartyChanges {
  customer?: string;
  division?: string;
  salesPerson?: string;
  type?: string;
  pending?: number;
  ageing?: Partial<Record<AgeBucketKey, number>>;
  remarks?: string;
  phone?: string;
}

const BUCKET_COLUMN: Record<AgeBucketKey, string> = {
  lt30: "below_30_days",
  d30to60: "days_30_to_60",
  d60to90: "days_60_to_90",
  gt90: "above_90_days",
};

/** Save an edited row and return it as the database now has it. Only the
 *  fields in `changes` are written. The backend refuses — with a message worth
 *  showing — a blank customer name, or a contact number nobody could dial.
 *
 *  The next report import for the section writes the report's values over an
 *  edit again, all but the contact number: an edit is a correction until the
 *  report catches up. */
export async function saveParty(section: DpdSectionKey, party: DpdParty, changes: PartyChanges): Promise<DpdParty> {
  const body: Record<string, unknown> = {};
  if (changes.customer !== undefined) body.customer = changes.customer;
  if (changes.division !== undefined) body.cd_cf = changes.division;
  if (changes.salesPerson !== undefined) body.sales_person = changes.salesPerson;
  if (changes.type !== undefined) body.type = changes.type;
  if (changes.pending !== undefined) body.outstanding = changes.pending;
  for (const [bucket, amount] of Object.entries(changes.ageing ?? {}) as [AgeBucketKey, number][]) {
    body[BUCKET_COLUMN[bucket]] = amount;
  }
  if (changes.remarks !== undefined) body.remarks = changes.remarks;
  if (changes.phone !== undefined) body.contact_number = changes.phone;

  const res = await collectionsFetch(`/api/collections/party?party=${encodeURIComponent(party.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Couldn't save the changes (HTTP ${res.status}).`));
  const saved = partyFromDatabase(section, await res.json().catch(() => null));
  if (!saved) throw new Error("The changes were saved but the row did not come back.");
  return saved;
}

// ── Contact number ───────────────────────────────────────────────────────────

/** Change the number the agent calls a party on; blank clears it. Returns the
 *  number as saved (tidied), or null when cleared. The text is free-form —
 *  "98200 12345 / 96112 74235" — but must hold at least one Indian mobile
 *  number; the backend refuses anything else with a message worth showing.
 *  A number saved here is never overwritten by a report import. */
export async function saveContactNumber(party: DpdParty, contactNumber: string): Promise<string | null> {
  const res = await collectionsFetch(`/api/collections/contact?party=${encodeURIComponent(party.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contact_number: contactNumber }),
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Couldn't save the number (HTTP ${res.status}).`));
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return data ? text(data.contact_number) : null;
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
  const res = await collectionsFetch(`/api/collections/call?party=${encodeURIComponent(party.id)}`, {
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

// Debtors Collection — DPD (days past due) reports.
//
// Two sections, each from a Tally "Sundry Debtors" ageing export:
//   cd-cf  one row per customer per division (CF or CD) with its sales person
//   apmc   APMC + Non-APMC customers with their type
//
// The screen has ONE source: the collections backend's database, table
// collection_parties (loadDpdReport in lib/debtor-calls.ts; reportFromDatabase
// below turns its rows into a DpdReport). Nothing is read from a file in this
// app. That table holds the Parties table's columns and a contact number —
// no set-aside sheets, no emails and no report date.
//
// The data gets there in two steps: scripts/import-dpd.mjs converts the Excel
// exports to JSON under debtors-data/ (outside public/, so it is never
// served; git-ignored, because this repo is public and these are customer
// balances), and the backend's scripts/load_dpd_parties.py loads that JSON
// into the table.

export type DpdSectionKey = "cd-cf" | "apmc";

export const AGE_BUCKETS = [
  { key: "lt30", label: "< 30 days", short: "< 30" },
  { key: "d30to60", label: "30–60 days", short: "30–60" },
  { key: "d60to90", label: "60–90 days", short: "60–90" },
  { key: "gt90", label: "> 90 days", short: "> 90" },
] as const;

export type AgeBucketKey = (typeof AGE_BUCKETS)[number]["key"];
export type Ageing = Record<AgeBucketKey, number>;

/** The text columns a section can be broken down and filtered by. */
export type DpdDimension = "division" | "salesPerson" | "type";

export interface DpdParty {
  /** The party's id in the database (collection_parties.party_id). Calls, call
   *  summaries and contact-number changes are all addressed by it — never by a
   *  name rebuilt here, which would miss a row somebody added by hand. */
  id: string;
  customer: string;
  /** Total outstanding — the report's own "Pending Bills" figure. */
  pending: number;
  ageing: Ageing;
  /** The company division the party is billed under, "CF" or "CD". The same
   *  customer can appear once under each. */
  division: string | null;
  salesPerson: string | null;
  type: string | null;
  /** Free-text collection notes; may run to several lines. */
  remarks: string | null;
  /** Contact number(s) as recorded — display text, possibly several numbers
   *  ("98200 12345 / 96112 74235"); see phoneNumbers and telHref for dialling. */
  phone: string | null;
}

export interface DpdReport {
  section: DpdSectionKey;
  /** When the section's rows were last written to the database, ISO 8601. The
   *  database carries no report date; this is the nearest thing to one. */
  loadedAt: string | null;
  parties: DpdParty[];
}

const BUCKET_KEYS: readonly AgeBucketKey[] = AGE_BUCKETS.map((b) => b.key);

/** An amount that prints as at least ₹1. Sub-rupee dust (a ₹0.26 remainder)
 *  would otherwise count as "a due" while showing as ₹0. */
export function hasDues(n: number): boolean {
  return n >= 0.5;
}

export function emptyAgeing(): Ageing {
  return { lt30: 0, d30to60: 0, d60to90: 0, gt90: 0 };
}

// ── From the database ───────────────────────────────────────────────────────

function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,\s₹]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// Tally exports pad names with spaces and embed "\r\r\n" line breaks.
function toText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

// Notes keep their line breaks; each line is tidied like any other text.
function toNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s === "" ? null : s;
}

// Phone numbers arrive as text, or — straight from a spreadsheet — as numbers.
function toPhone(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  return toText(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toParty(section: DpdSectionKey, v: unknown): DpdParty | null {
  const r = asRecord(v);
  const customer = r ? toText(r.customer) : null;
  if (!r || !customer) return null;
  const division = toText(r.division);
  const a = asRecord(r.ageing) ?? {};
  const ageing: Ageing = {
    lt30: toNumber(a.lt30),
    d30to60: toNumber(a.d30to60),
    d60to90: toNumber(a.d60to90),
    gt90: toNumber(a.gt90),
  };
  return {
    // Every row has an id; the slug is only for a reply that somehow lacks one.
    id: toText(r.id) ?? partyKey(section, { customer, division }),
    customer,
    pending: r.pending == null ? BUCKET_KEYS.reduce((s, k) => s + ageing[k], 0) : toNumber(r.pending),
    ageing,
    division,
    salesPerson: toText(r.salesPerson),
    type: toText(r.type),
    remarks: toNote(r.remarks),
    phone: toPhone(r.phone),
  };
}

/** One row of collection_parties, under the database's own column names
 *  (cd_cf, below_30_days, contact_number …), as a DpdParty. null for anything
 *  that is not a row with a customer. */
export function partyFromDatabase(section: DpdSectionKey, v: unknown): DpdParty | null {
  const row = asRecord(v);
  return row
    ? toParty(section, {
        id: row.party_id,
        customer: row.customer,
        pending: row.outstanding,
        ageing: {
          lt30: row.below_30_days,
          d30to60: row.days_30_to_60,
          d60to90: row.days_60_to_90,
          gt90: row.above_90_days,
        },
        division: row.cd_cf,
        salesPerson: row.sales_person,
        type: row.type,
        remarks: row.remarks,
        phone: row.contact_number,
      })
    : null;
}

/** The collections backend's GET /parties reply as a DpdReport, or null when
 *  the section has no parties loaded. Its rows carry the database's column
 *  names (cd_cf, below_30_days, contact_number …); rows without a customer are
 *  dropped. A reply with no parties list is rejected. */
export function reportFromDatabase(section: DpdSectionKey, raw: unknown): DpdReport | null {
  const r = asRecord(raw);
  if (!r || !Array.isArray(r.parties)) throw new Error("The parties list is not in the expected format.");
  const parties = r.parties.map((v) => partyFromDatabase(section, v)).filter((p): p is DpdParty => p !== null);
  if (parties.length === 0) return null;
  return { section, loadedAt: toText(r.updated_at), parties };
}

// ── Totals & grouping ───────────────────────────────────────────────────────

export interface DpdTotals {
  count: number;
  pending: number;
  ageing: Ageing;
  /** Parties with dues in each bucket. */
  counts: Record<AgeBucketKey, number>;
}

export function totalsOf(parties: readonly DpdParty[]): DpdTotals {
  const ageing = emptyAgeing();
  const counts = emptyAgeing();
  let pending = 0;
  for (const p of parties) {
    pending += p.pending;
    for (const k of BUCKET_KEYS) {
      ageing[k] += p.ageing[k];
      if (hasDues(p.ageing[k])) counts[k] += 1;
    }
  }
  return { count: parties.length, pending, ageing, counts };
}

/** A party's value for a dimension, "" when it has none. */
export function dimensionValue(p: DpdParty, dim: DpdDimension): string {
  return p[dim] ?? "";
}

export interface DpdGroup extends DpdTotals {
  /** The dimension value; "" for the parties that have none. */
  key: string;
  label: string;
}

/** Parties grouped by a dimension, largest outstanding first. */
export function groupParties(parties: readonly DpdParty[], dim: DpdDimension, blankLabel: string): DpdGroup[] {
  const byKey = new Map<string, DpdParty[]>();
  for (const p of parties) {
    const key = dimensionValue(p, dim);
    const list = byKey.get(key);
    if (list) list.push(p);
    else byKey.set(key, [p]);
  }
  return [...byKey]
    .map(([key, list]) => ({ key, label: key || blankLabel, ...totalsOf(list) }))
    .sort((a, b) => b.pending - a.pending || a.label.localeCompare(b.label));
}

const slug = (v: string | null) => (v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The id the backend's report loader gives a party: "cd-cf:cf:bigbasket" —
 *  section, division, customer (its helpers.party_slug). The report has no id
 *  of its own, and a customer billed under both CF and CD is two parties.
 *  The screen addresses a party by the id the database returns (DpdParty.id);
 *  this is only the fallback for a row that came without one. */
export function partyKey(section: DpdSectionKey, p: Pick<DpdParty, "customer" | "division">): string {
  return [slug(section), slug(p.division), slug(p.customer)].filter(Boolean).join(":");
}

// ── Filtering & sorting ─────────────────────────────────────────────────────

export interface DpdFilter {
  search: string;
  /** Keep only parties with this value ("" = the ones with none). An absent key is no filter. */
  dims: Partial<Record<DpdDimension, string>>;
  /** Keep only parties with dues in this bucket. */
  bucket: AgeBucketKey | null;
}

export const NO_FILTER: DpdFilter = { search: "", dims: {}, bucket: null };

export function isFiltered(f: DpdFilter): boolean {
  return f.search.trim() !== "" || f.bucket !== null || Object.values(f.dims).some((v) => v !== undefined);
}

export function filterParties(parties: readonly DpdParty[], f: DpdFilter): DpdParty[] {
  const q = f.search.trim().toLowerCase();
  const dims = (Object.entries(f.dims) as [DpdDimension, string | undefined][]).filter(
    (e): e is [DpdDimension, string] => e[1] !== undefined,
  );
  return parties.filter((p) => {
    if (f.bucket && !hasDues(p.ageing[f.bucket])) return false;
    if (dims.some(([dim, want]) => dimensionValue(p, dim) !== want)) return false;
    if (q) {
      const haystack = [p.customer, p.division, p.salesPerson, p.type, p.remarks].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export type DpdSortKey = "customer" | "pending" | AgeBucketKey | DpdDimension;
export type SortDir = "asc" | "desc";

function isBucketKey(k: DpdSortKey): k is AgeBucketKey {
  return (BUCKET_KEYS as readonly string[]).includes(k);
}

const byName = (a: DpdParty, b: DpdParty) => a.customer.localeCompare(b.customer, "en-IN", { sensitivity: "base" });

/** A sorted copy. Ties fall back to the customer name, A to Z; parties with no
 *  value for a dimension sort last whichever way the column is turned. */
export function sortParties(parties: readonly DpdParty[], key: DpdSortKey, dir: SortDir): DpdParty[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...parties].sort((a, b) => {
    let c: number;
    if (key === "customer") c = byName(a, b);
    else if (key === "pending") c = a.pending - b.pending;
    else if (isBucketKey(key)) c = a.ageing[key] - b.ageing[key];
    else {
      const av = dimensionValue(a, key);
      const bv = dimensionValue(b, key);
      if (!av !== !bv) return av ? -1 : 1;
      c = av.localeCompare(bv, "en-IN", { sensitivity: "base" });
    }
    return c !== 0 ? c * sign : byName(a, b);
  });
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Whole rupees with Indian digit grouping: ₹1,86,29,127. */
export function formatInr(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const r = Math.round(n);
  return `${r < 0 ? "−" : ""}₹${Math.abs(r).toLocaleString("en-IN")}`;
}

const trimDecimals = (v: number) => v.toFixed(2).replace(/\.?0+$/, "");

/** Crores and lakhs for headline figures (₹5.22 Cr, ₹22.4 L); smaller amounts
 *  in full. The unit is picked AFTER rounding, so ₹99,99,999 reads ₹1 Cr and
 *  never ₹100 L. */
export function compactInr(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  const lakhs = Math.round(a / 1e3) / 100;
  if (lakhs >= 100) return `${sign}₹${trimDecimals(Math.round(a / 1e5) / 100)} Cr`;
  if (lakhs >= 1) return `${sign}₹${trimDecimals(lakhs)} L`;
  return formatInr(n);
}

/** part as a share of whole, to one decimal: 53.4%, 25%, <0.1%. */
export function formatShare(part: number, whole: number): string {
  if (!(whole > 0) || !Number.isFinite(part)) return "—";
  const pct = (part / whole) * 100;
  if (pct <= 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

/** The separate dialable numbers in a phone field, in order, each without any
 *  label in front of it: "Mob: 98200 12345 / 022 2345 6789" gives two. */
export function phoneNumbers(phone: string | null): string[] {
  return (phone ?? "")
    .split(/[,;/]|\bor\b/i)
    .map((s) => s.replace(/^[^\d+]+/, "").trim())
    .filter((s) => s.replace(/\D/g, "").length >= 6);
}

/** A dialable tel: link for the first number in a phone field, or null when it
 *  holds nothing that could be one. A bare 10-digit number, or one with the 0
 *  trunk prefix, is taken as Indian and gets +91; anything else short is
 *  dialled as written. */
export function telHref(phone: string | null): string | null {
  const first = phoneNumbers(phone)[0];
  if (!first) return null;
  const digits = first.replace(/\D/g, "");
  if (first.startsWith("+")) return `tel:+${digits}`;
  if (digits.length === 10) return `tel:+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `tel:+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `tel:+${digits}`;
  return `tel:${digits}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-26" → "26 Sep 2026"; null for anything else. */
export function formatAsOf(iso: string | null): string | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

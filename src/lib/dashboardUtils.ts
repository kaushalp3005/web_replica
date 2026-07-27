// Generic dashboard helpers — ported from the legacy-frontend so the Customer
// Returns (and future) dashboards behave identically:
//   • record-level smart search (multi-term AND, case-insensitive substring)
//   • stale-while-revalidate localStorage cache
//   • customer-name canonicalization (strip legal suffixes → title-case; alias map)
// Sources: lib/search/recordSearch.ts, lib/cache/dashboardCache.ts,
//          lib/customers/canonicalize.ts, lib/constants/customerAliases.ts.

// ── Smart search ─────────────────────────────────────────────────────────────
export function parseSearchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

function buildHaystack(record: Record<string, unknown>, fields: string[]): string {
  let s = "";
  for (const f of fields) {
    const v = record[f];
    if (v === null || v === undefined) continue;
    s += String(v) + " ";
  }
  return s.toLowerCase();
}

function matchesAllTerms(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  return terms.every((t) => haystack.includes(t));
}

// Reusable predicate for a query over a fixed set of fields (empty query → all).
export function makeRecordSearch<T>(query: string, fields: (keyof T & string)[]): (record: T) => boolean {
  const terms = parseSearchTerms(query);
  if (terms.length === 0) return () => true;
  return (record: T) => matchesAllTerms(buildHaystack(record as Record<string, unknown>, fields), terms);
}

// ── Stale-while-revalidate cache ─────────────────────────────────────────────
export interface Cached<T> {
  payload: T;
  savedAt: number;
}

export function readDashboardCache<T>(key: string): Cached<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached<T>;
    if (!parsed || typeof parsed !== "object" || !("payload" in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDashboardCache<T>(key: string, payload: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ payload, savedAt: Date.now() }));
  } catch {
    // Quota exceeded / serialization failure — degrade silently (no instant paint).
  }
}

// ── Customer canonicalization ────────────────────────────────────────────────
// Trailing legal suffixes stripped during normalization (longest phrases first).
const LEGAL_SUFFIXES = [
  "private limited", "pvt ltd", "pvt limited", "private ltd", "pvt",
  "limited", "ltd", "llp", "incorporated", "inc", "corporation", "corp", "company", "co",
];
const TRAILING_PUNCT_RE = /[.,;:]+$/;

// Map of canonical display name -> raw variants that should collapse into it.
// Extend only when suffix-stripping alone can't merge two names. Starts empty.
export const CUSTOMER_ALIASES: Record<string, string[]> = {};

function normalize(name: string | null | undefined): string {
  if (!name) return name ?? "";
  let s = name.toLowerCase().trim().replace(/\s+/g, " ");
  let changed = true;
  while (changed) {
    changed = false;
    s = s.replace(TRAILING_PUNCT_RE, "").trim();
    for (const suffix of LEGAL_SUFFIXES) {
      if (s === suffix) break; // don't strip if the entire name IS the suffix
      if (s.endsWith(" " + suffix)) {
        s = s.slice(0, s.length - suffix.length - 1).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

function titleCase(s: string): string {
  if (!s) return s;
  return s.split(" ").map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
}

// Canonical display name for a raw customer name: normalize, then alias-map, else title-case.
export function canonicalize(name: string | null | undefined, aliases: Record<string, string[]> = {}): string {
  if (!name) return name ?? "";
  const normalized = normalize(name);
  if (!normalized) return name;
  for (const [canonical, variants] of Object.entries(aliases)) {
    for (const v of variants) if (normalize(v) === normalized) return canonical;
    if (normalize(canonical) === normalized) return canonical;
  }
  return titleCase(normalized);
}

// Group raw customer names by canonical form → Map<canonical, rawVariants[]>,
// keys sorted by variant count desc then alphabetically.
export function groupByCanonical(names: string[], aliases: Record<string, string[]> = {}): Map<string, string[]> {
  const bucket = new Map<string, Set<string>>();
  for (const raw of names) {
    if (!raw) continue;
    const can = canonicalize(raw, aliases);
    if (!bucket.has(can)) bucket.set(can, new Set());
    bucket.get(can)!.add(raw);
  }
  const entries = Array.from(bucket.entries()).map(([can, set]) => [can, Array.from(set)] as [string, string[]]);
  entries.sort((a, b) => (b[1].length !== a[1].length ? b[1].length - a[1].length : a[0].localeCompare(b[0])));
  return new Map(entries);
}

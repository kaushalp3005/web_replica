// The one site table: every warehouse, cold store and legacy site label the ERP
// knows, with every spelling of each. The data is sites.json, a byte-identical
// copy of backend app/core/sites.json (backend tests/services/test_sites.py fails
// when they differ), so edit both. This file mirrors backend app/core/sites.py,
// which adds scope_keys for SQL filters.
//
// Every lookup goes by siteKey(raw): upper case, every non-alphanumeric dropped.
// "W-202", "w 202" and "W202" are one spelling, so only real aliases
// ("Warehouse A185", "Old Savla", the grant code "D-39" for "Savla D-39") need
// a place in the table.
//
// The rules (user decisions, 2026-10-16):
//   - compare sites with sameSite(), never with === on stored strings;
//   - "Cold Storage" is a site of its own: cold in kind (isColdSite), but never
//     the same site as Rishi, Savla D-39 or any other store, and never a To;
//   - "Savla Bond" is a cold store of its own, not a spelling of Savla D-39;
//   - a spelling the table does not know (bare "Savla") stays an unknown site:
//     canonicalSite returns it trimmed, and it is the same site only as
//     spellings with the same key.

import SITES_DATA from "./sites.json" with { type: "json" };

export type SiteKind = "warehouse" | "cold" | "unknown";
export type SiteCompany = "cfpl" | "cdpl";

interface SiteRow {
  canonical: string;
  kind: SiteKind;
  company: SiteCompany | null;   // whose {company}_cold_stocks holds a cold store's rows
  grant_code: string | null;     // what the admin screen grants; null = not grantable
  display: string;               // the name printed on the delivery challan
  address: string;               // the challan address, "" when not known
  destination: boolean;          // offered as a transfer To
  aliases: string[];
}

interface Site extends SiteRow {
  key: string;          // siteKey(canonical)
  spellings: string[];  // canonical, display, grant code, then the aliases
}

/** Upper case with every non-alphanumeric dropped; "" for null / empty. The
 *  backend's site_key (warehouse_scope.normalise_warehouse_code). */
export function siteKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const SITES: readonly Site[] = (SITES_DATA.sites as SiteRow[]).map((row) => {
  const spellings: string[] = [];
  for (const raw of [row.canonical, row.display, row.grant_code, ...row.aliases]) {
    const spelling = (raw ?? "").trim();
    if (spelling && !spellings.includes(spelling)) spellings.push(spelling);
  }
  return { ...row, key: siteKey(row.canonical), spellings };
});

const BY_KEY = new Map<string, Site>();
for (const site of SITES) {
  for (const spelling of site.spellings) {
    const key = siteKey(spelling);
    if (key && !BY_KEY.has(key)) BY_KEY.set(key, site);
  }
}

function lookup(raw: string | null | undefined): Site | undefined {
  return BY_KEY.get(siteKey(raw));
}

function canonicalKey(raw: string | null | undefined): string {
  return lookup(raw)?.key ?? siteKey(raw);
}

/** The canonical name of a known spelling ("Warehouse A185" → "A185", "D-39" →
 *  "Savla D-39", "Supreme Cold" → "Supreme"); anything else comes back trimmed,
 *  and null / empty gives "". */
export function canonicalSite(raw: string | null | undefined): string {
  return lookup(raw)?.canonical ?? (raw ?? "").trim();
}

/** True when a and b name one site: "A185" / "Warehouse A185", "D-39" /
 *  "Savla D-39", "Supreme Cold" / "Supreme". An empty value never matches,
 *  not even another empty value. */
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = canonicalKey(a);
  return key !== "" && key === canonicalKey(b);
}

/** True for the cold stores and for the legacy "Cold Storage" label. A floor
 *  such as "A185 Cold" is a warehouse; an unknown name is not cold. */
export function isColdSite(raw: string | null | undefined): boolean {
  return lookup(raw)?.kind === "cold";
}

/** "cfpl" or "cdpl", whose {company}_cold_stocks table holds a cold store's rows.
 *  null for a warehouse, for "Cold Storage" (no one store) and for an unknown name. */
export function coldCompany(raw: string | null | undefined): SiteCompany | null {
  const site = lookup(raw);
  return site?.kind === "cold" ? site.company : null;
}

/** "warehouse", "cold" or "unknown" (an unknown name is "unknown"). */
export function siteKind(raw: string | null | undefined): SiteKind {
  return lookup(raw)?.kind ?? "unknown";
}

/** True when raw is a spelling of a site in the table, of any kind ("Dev Int" too,
 *  although its kind is "unknown"); false for a name the table does not know
 *  (bare "Savla") and for empty. */
export function isKnownSite(raw: string | null | undefined): boolean {
  return lookup(raw) !== undefined;
}

/** Every known spelling of the site raw names, canonical name, display name and
 *  grant code included. An unknown name is its own only spelling; empty gives []. */
export function siteAliases(raw: string | null | undefined): string[] {
  const site = lookup(raw);
  if (site) return [...site.spellings];
  const value = (raw ?? "").trim();
  return value ? [value] : [];
}

/** The name printed on the challan ("Supreme" → "Supreme Cold Storage",
 *  "W202" → "Warehouse W202"); an unknown name comes back trimmed. */
export function displaySite(raw: string | null | undefined): string {
  return lookup(raw)?.display ?? (raw ?? "").trim();
}

/** The challan address; "" when the site or its address is not known. */
export function siteAddress(raw: string | null | undefined): string {
  return lookup(raw)?.address ?? "";
}

const names = (keep: (site: Site) => boolean): readonly string[] =>
  Object.freeze(SITES.filter(keep).map((site) => site.canonical));

/** The warehouses: W202, A185, A101, A68, F53. */
export const WAREHOUSE_SITES = names((site) => site.kind === "warehouse");

/** The cold stores, by canonical name. "Cold Storage" is not one of them: it is
 *  cold in kind (isColdSite) but is no store to send to, relabel in or grant. */
export const COLD_SITES = names((site) => site.kind === "cold" && site.destination);

/** Every site a transfer may be sent to: the warehouses, then the cold stores. */
export const TO_SITES = names((site) => site.destination);

/** The codes the admin screen grants (auth_user.allowed_warehouses): W202, A185,
 *  ..., "D-39" for Savla D-39, "Savla Bond", "Eskimo". */
export const GRANTABLE_SITES: readonly string[] = Object.freeze(
  SITES.filter((site) => site.grant_code).map((site) => site.grant_code as string),
);

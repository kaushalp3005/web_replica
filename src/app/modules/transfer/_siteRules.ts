// The transfer pages' site lists and site matching, built on the shared site table
// (lib/sites, which the backend's app/core/sites reads too), so every page offers,
// compares and names a site the way the server judges it:
//
//  • A picker offers canonical names, one per site (siteOptions): "Warehouse A185",
//    "A-185" and "A185" are one option, "A185"; the grant "D-39" is "Savla D-39".
//  • A filter or a lock matches a row when they name one site (siteMatches, on
//    lib/sites sameSite); a column may hold a comma list ("Rishi, Savla D-39", the units
//    of a cold dispatch).
//  • "Cold Storage", the legacy cold From, is a site of its own: never one of the stores
//    and never a To. "Savla Bond" is a cold store of its own, not Savla D-39.
//  • A cold-stock row is at the store its unit names, else the store its storage
//    location names (coldRowSite): "Savla" + unit "D-39" is Savla D-39. That is the order
//    IMS's canonical_warehouse_fn reads them.
//
// Pure functions; exercised by _siteRules.test.ts
// (`node src/app/modules/transfer/_siteRules.test.ts`).

import { COLD_SITES, TO_SITES, canonicalSite, isKnownSite, sameSite } from "../../../lib/sites.ts";
import { articleKey, isRealBox, lotKey } from "../../../lib/transferBoxMatch.ts";

/** The legacy cold From of the old direct form and of IMS-created transfers. */
export const LEGACY_COLD_SITE = canonicalSite("Cold Storage");

/** Every site a list filter offers, and the From of an edited direct transfer: the
 *  warehouses, the cold stores, then the legacy "Cold Storage". */
export const ALL_SITES: readonly string[] = Object.freeze([...TO_SITES, LEGACY_COLD_SITE]);

/** Canonical names, one per site, in the order first seen; blanks are dropped. */
export function siteOptions(raw: Iterable<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of raw) {
    const name = canonicalSite(value);
    if (name && !out.some((o) => sameSite(o, name))) out.push(name);
  }
  return out;
}

/** `options`, plus `value` (canonical) when it names none of them: a select bound to a
 *  stored site the list does not offer still shows it. */
export function withSite(options: readonly string[], value: string | null | undefined): string[] {
  const name = canonicalSite(value);
  return name && !options.some((o) => sameSite(o, name)) ? [...options, name] : [...options];
}

/** True when any of `values` names the site `site` names; a value may be a comma list. */
export function siteMatches(site: string, ...values: (string | null | undefined)[]): boolean {
  return values.some((v) => (v || "").split(",").some((part) => sameSite(part, site)));
}

/** False for a site the table knows but never sends a transfer to ("Cold Storage", "Dev
 *  Int"); a site the table does not know is still offered as a To. */
export function isToSite(raw: string | null | undefined): boolean {
  return !isKnownSite(raw) || TO_SITES.some((s) => sameSite(s, raw));
}

/** The cold store a cold-stock row is at, by canonical name: the one its unit names, else
 *  the one its storage location names; "" when neither names a cold store. */
export function coldRowSite(row: { unit?: string | null; storage_location?: string | null }): string {
  for (const value of [row.unit, row.storage_location]) {
    const store = COLD_SITES.find((s) => sameSite(s, value));
    if (store) return store;
  }
  return "";
}

/** The boxes on a dispatch's list that a cold pick of `item` / `lot` must leave out, as the
 *  pick's `exclude` takes them ("box_id|transaction_no"). Only boxes of that item and lot:
 *  no other box can come back from the pick, and the query stays short. */
export function pickExclude(
  boxes: readonly { boxId: string; transactionNo: string; article: string; lotNumber: string }[],
  item: string, lot: string,
): string[] {
  const art = articleKey(item), l = lotKey(lot);
  const keys: string[] = [];
  for (const b of boxes) {
    if (!isRealBox(b) || articleKey(b.article) !== art || lotKey(b.lotNumber) !== l) continue;
    const key = `${b.boxId.trim()}|${b.transactionNo.trim()}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

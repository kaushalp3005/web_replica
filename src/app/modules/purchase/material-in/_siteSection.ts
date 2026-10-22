// The first Material In section: unreceived POs whose consignee address is for
// the user's plant. The backend reads the plant code off the start of the
// address ("W-202(A), MIDC…" → W202, "A-185 , MIDC…" → A185, "A-68 , Plot…" →
// A68; services/consignee_site.py) and partitions on the `site` list param:
// section=site keeps those sites, section=pending leaves them out.
//
// Which sites: the warehouses in the user's access; every warehouse for admins
// and for users with no warehouse lock. One site is used as is; with several
// the user picks one or "all of mine".
//
// The rest is enforced server side (services/po_site_scope.py): a locked
// receiving user never gets a PO addressed to a warehouse outside their access,
// in any section, export or detail read. POs with no consignee site stay visible.
// Plain .ts with relative imports so node can run the test next to it:
//
//     node src/app/modules/purchase/material-in/_siteSection.test.ts

import { WAREHOUSE_SITES } from "../../../../lib/sites.ts";
import { userHasWarehouse } from "../../../../lib/warehouseScope.ts";

/** The "every site I can pick" choice. */
export const ALL_SITES = "all";

/** True when the user sees every site: an admin, or no warehouse lock (an
 *  empty access list), as the backend's scope reads it. */
export function seesEverySite(isAdmin: boolean, granted: readonly string[]): boolean {
  return isAdmin || granted.length === 0;
}

/** The warehouses this user can pick for the site section, by canonical name. */
export function siteChoices(isAdmin: boolean, granted: readonly string[]): string[] {
  return seesEverySite(isAdmin, granted)
    ? [...WAREHOUSE_SITES]
    : WAREHOUSE_SITES.filter((w) => userHasWarehouse(granted, w));
}

/** The sites a choice stands for: one picked site, or every choice for "all"
 *  (also for a remembered pick the user no longer has). */
export function sitesFor(choice: string, choices: readonly string[]): string[] {
  return choice !== ALL_SITES && choices.includes(choice) ? [choice] : [...choices];
}

/** The choice to start on: the remembered one while it is still offered, else
 *  "all" (a single site is shown by name either way). */
export function initialChoice(remembered: string | null, choices: readonly string[]): string {
  return remembered && (remembered === ALL_SITES || choices.includes(remembered)) ? remembered : ALL_SITES;
}

/** The section's title: "W202 PO" for one site, else "My sites PO", or
 *  "All sites PO" for a user who sees every warehouse (seesEverySite). */
export function siteSectionLabel(choice: string, choices: readonly string[], everySite: boolean): string {
  const sites = sitesFor(choice, choices);
  if (sites.length === 1) return `${sites[0]} PO`;
  if (sites.length === 0) return "My site PO";
  return everySite ? "All sites PO" : "My sites PO";
}

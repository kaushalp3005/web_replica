// Where an inward can be booked, and which of those sites print box labels.
// Both come from the shared site table (lib/sites), so the Warehouse dropdown
// carries canonical names ("Savla D-39"; the old "Savla D-34" option was a typo
// of it) and every spelling of a site counts as that site. Plain .ts with
// relative imports so node can run the test next to it:
//
//     node "src/app/modules/purchase/material-in/[transaction_no]/_warehouses.test.ts"

import { COLD_SITES, WAREHOUSE_SITES, canonicalSite, isColdSite, sameSite } from "../../../../../lib/sites.ts";
import { userHasWarehouse } from "../../../../../lib/warehouseScope.ts";

/** Every warehouse, then every cold store, by canonical name. */
export const INWARD_WAREHOUSES: readonly string[] = Object.freeze([...WAREHOUSE_SITES, ...COLD_SITES]);

/** The Warehouse dropdown for one inward: the sites this user may book to
 *  (admins see all; a grant matches every spelling of its site, so "D-39"
 *  offers Savla D-39), and the option that shows the saved value. A saved
 *  spelling of a site ("Savla D-34", "D-39") selects that site's option; a
 *  saved site outside the user's scope, or unknown to the table, stays
 *  selectable. The saved value itself is only replaced when the user picks
 *  another option. */
export function inwardWarehouseChoices(
  saved: string | null | undefined,
  isAdmin: boolean,
  granted: readonly string[],
): { options: string[]; value: string } {
  const scoped = isAdmin
    ? [...INWARD_WAREHOUSES]
    : INWARD_WAREHOUSES.filter((w) => userHasWarehouse(granted, w));
  const value = canonicalSite(saved);
  const options = value && !scoped.some((w) => sameSite(w, value)) ? [value, ...scoped] : scoped;
  return { options, value };
}

/** Label printing is a cold-storage operation: Print all / Print range are
 *  offered only when the inward is booked to a cold store, under any spelling. */
export function printsColdLabels(warehouse: string | null | undefined): boolean {
  return isColdSite(warehouse);
}

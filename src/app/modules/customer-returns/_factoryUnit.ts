// A customer return's factory_unit is a site name, and it arrives in more than
// one spelling: the CR form stores the grant code ("D-39"), IMS RTV rows carry
// the store's name ("Savla D-39", "Supreme Cold"). These read it through the
// shared site table (lib/sites), so every spelling of one site behaves as that
// site. Plain .ts with relative imports so node can run the test next to it:
//
//     node src/app/modules/customer-returns/_factoryUnit.test.ts

import { GRANTABLE_SITES, canonicalSite, isColdSite, siteKind } from "../../../lib/sites.ts";

/** The CR form's Factory Unit choices: every site of the shared site table by the code a
 *  user is granted it under (lib/sites GRANTABLE_SITES), the spelling the form has always
 *  stored ("D-39" for Savla D-39), so the warehouses and every cold store, Eskimo and
 *  Savla Bond (a store of its own) included. The sample module keeps its own list, which
 *  its backend validates; a CR's factory_unit is free text. */
export const FACTORY_UNITS: readonly string[] = GRANTABLE_SITES;

/** True for a cold store under any spelling ("D-39", "Savla D-39", "Supreme
 *  Cold", "Savla Bond"), and for the legacy "Cold Storage" label. The cold-only
 *  line fields (lot_number / item_mark / spl_remarks / vakkal) show only then. */
export function isColdFactoryUnit(unit: string | null | undefined): boolean {
  return isColdSite(unit);
}

/** The dashboard's factory group and chip value: one per site, under its
 *  canonical name ("D-39" and "Savla D-39" are one "Savla D-39"). A name the
 *  table does not know keeps the dashboard's case fold ("ABC GODOWN" and
 *  "abc godown" are one "Abc Godown"). "" for an empty unit. */
export function factoryUnitGroup(unit: string | null | undefined): string {
  const site = canonicalSite(unit);
  return siteKind(site) === "unknown"
    ? site.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : site;
}

// Exercises the transfer pages' site rules (_siteRules) on the shared site table. No test
// runner is configured in this project, so this runs directly on Node's native TypeScript
// stripping:
//
//     node src/app/modules/transfer/_siteRules.test.ts

import {
  ALL_SITES, LEGACY_COLD_SITE, coldRowSite, isToSite, pickExclude, siteMatches, siteOptions, withSite,
} from "./_siteRules.ts";
import { TO_SITES, displaySite, isColdSite, sameSite, siteAddress } from "../../../lib/sites.ts";
import { userHasWarehouse } from "../../../lib/warehouseScope.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// ── the lists ──
check("every site a filter offers: the To sites, then the legacy Cold Storage", ALL_SITES,
  ["W202", "A185", "A101", "A68", "F53", "Rishi", "Savla D-39", "Savla D-514", "Savla Bond", "Supreme", "Eskimo", "Cold Storage"]);
check("the legacy cold From is 'Cold Storage'", LEGACY_COLD_SITE, "Cold Storage");
check("Savla Bond and Eskimo are To sites; Cold Storage is not",
  [TO_SITES.includes("Savla Bond"), TO_SITES.includes("Eskimo"), TO_SITES.includes("Cold Storage")], [true, true, false]);
check("the list cannot be changed", Object.isFrozen(ALL_SITES), true);

// ── options: canonical, one per site (P1-14 request page, P1-17 dashboard filter) ──
check("request options from warehouse_sites codes: deduped by site, shown canonically",
  siteOptions(["W202", "W-202", "Warehouse A185", "A185", "ESKIMO", "Eskimo", "D-39", "Savla D-39", "Savla Bond", " ", null, "Dev Int"]),
  ["W202", "A185", "Eskimo", "Savla D-39", "Savla Bond", "Dev Int"]);
check("a scoped user's grants as filter options", siteOptions(["D-39", "Savla D39", "Supreme"]), ["Savla D-39", "Supreme"]);
check("an unknown spelling stays as it is, trimmed", siteOptions([" Savla ", "savla"]), ["Savla"]);
check("no options", siteOptions([]), []);

// ── withSite: a stored value the list doesn't offer is kept (P1-31) ──
check("a stored alias maps onto its option", withSite(ALL_SITES, "Rishi Cold").length, ALL_SITES.length);
check("a stored unknown site is added", withSite(["W202"], "Dev Int"), ["W202", "Dev Int"]);
check("an empty value adds nothing", withSite(["W202"], ""), ["W202"]);
check("withSite never changes its input", (() => { const l = ["W202"]; withSite(l, "X"); return l; })(), ["W202"]);

// ── siteMatches: filters by site, comma lists split (P1-17, P1-32) ──
const MATCH: [string, (string | null)[], boolean][] = [
  ["A185", ["Warehouse A185"], true], ["A185", ["A-185"], true], ["A185", ["W202", "a 185"], true],
  ["Savla D-39", ["D-39"], true], ["Savla D-39", ["Rishi, Savla D39"], true], ["Supreme", ["Supreme Cold"], true],
  ["Eskimo", ["ESKIMO"], true], ["Rishi", ["Cold Storage", "Rishi"], true],
  ["Rishi", ["Cold Storage"], false], ["Cold Storage", ["Rishi"], false], ["Savla D-39", ["Savla Bond"], false],
  ["Savla Bond", ["Savla D-39"], false], ["A185", ["W202"], false], ["A185", [null, ""], false], ["A185", [], false],
];
check("siteMatches", MATCH.filter(([site, vals, want]) => siteMatches(site, ...vals) !== want).map(([s, v]) => `${s} / ${v}`), []);

// ── isToSite: the request page's To list ──
check("To sites", ["W202", "Warehouse A185", "Savla Bond", "ESKIMO", "Cold Storage", "cold-storage", "Dev Int", "dev_int", "Some New Site"].map(isToSite),
  [true, true, true, true, false, false, false, false, true]);

// ── coldRowSite: unit first, then storage location (P1-34, D4) ──
const ROWS: [string | null, string | null, string][] = [
  ["D-39", "Savla", "Savla D-39"], ["D-514", "Savla", "Savla D-514"], [null, "Savla D39", "Savla D-39"],
  ["Rishi Cold", "", "Rishi"], ["", "Supreme Cold Storage", "Supreme"], ["ESKIMO", null, "Eskimo"],
  ["Savla Bond", "Savla", "Savla Bond"], [null, "Savla Bond", "Savla Bond"], ["D-39", "Savla Bond", "Savla D-39"],
  [null, "Savla", ""], ["Cold Storage", "", ""], ["A185 Cold", "A185", ""], [null, null, ""],
];
check("coldRowSite",
  ROWS.filter(([unit, loc, want]) => coldRowSite({ unit, storage_location: loc }) !== want)
    .map(([u, l]) => `${u} / ${l} -> ${coldRowSite({ unit: u, storage_location: l })}`), []);

// ── pickExclude: the boxes already on the list, of the picked item and lot (P2-03) ──
const listed = [
  { boxId: "B-1", transactionNo: "TR-1", article: "Cashew W320", lotNumber: "L1" },
  { boxId: " B-2 ", transactionNo: " TR-1 ", article: "cashew  w320", lotNumber: " L1 " },
  { boxId: "B-1", transactionNo: "TR-1", article: "Cashew W320", lotNumber: "L1" },
  { boxId: "B-3", transactionNo: "TR-2", article: "Cashew W320", lotNumber: "L2" },
  { boxId: "B-4", transactionNo: "TR-2", article: "Almond", lotNumber: "L1" },
  { boxId: "", transactionNo: "DIRECT", article: "Cashew W320", lotNumber: "L1" },
  { boxId: "B-5", transactionNo: "DIRECT", article: "Cashew W320", lotNumber: "L1" },
];
check("exclude: the item and lot's real boxes, trimmed, once each", pickExclude(listed, "Cashew W320", "L1"), ["B-1|TR-1", "B-2|TR-1"]);
check("exclude: another lot", pickExclude(listed, "Cashew W320", "L2"), ["B-3|TR-2"]);
check("exclude: nothing listed", pickExclude([], "Cashew W320", "L1"), []);

// ── the lists and checks the pages use, on the table (P1-05, P1-18, P1-33) ──
check("Accept / Scan & send show for the grant of the request's From",
  [userHasWarehouse(["D-39"], "Savla D-39"), userHasWarehouse(["A185"], "Warehouse A185"),
    userHasWarehouse(["Supreme"], "Supreme Cold"), userHasWarehouse(["Rishi"], "Cold Storage"), userHasWarehouse(["D-39"], "Savla Bond")],
  [true, true, true, false, false]);
check("the challan names every spelling by its display name",
  ["Warehouse A185", "A-185", "Supreme Cold", "D-39", "ESKIMO", "Savla Bond", "Cold Storage", "Dev Int", "Somewhere"].map(displaySite),
  ["Warehouse A185", "Warehouse A185", "Supreme Cold Storage", "Savla D-39 Cold Storage", "Eskimo Cold Storage", "Savla Bond",
    "Cold Storage", "Dev Int", "Somewhere"]);
check("the challan address: known for the stores, empty for Savla Bond and an unknown site",
  [siteAddress("A-185") !== "", siteAddress("Supreme Cold") !== "", siteAddress("ESKIMO") !== "", siteAddress("Savla Bond"), siteAddress("Somewhere")],
  [true, true, true, "", ""]);
check("a cold From, every spelling (transferIn chip, the cold summary popup)",
  ["Supreme Cold", "Rishi Cold Storage", "D-39", "Savla D39", "Old Savla", "New Savla", "Savla Bond", "ESKIMO", "Cold Storage", "A185 Cold", "W202"]
    .map(isColdSite),
  [true, true, true, true, true, true, true, true, true, false, false]);
check("From and To are one site (request page, direct form)",
  [sameSite("A185", "Warehouse A185"), sameSite("Supreme", "Supreme Cold"), sameSite("A185", "A-185"), sameSite("Savla D-39", "Savla Bond")],
  [true, true, true, false]);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("transfer site rules: all checks passed");

// Exercises lib/sites (the shared site table) and the helpers rebuilt on it:
// lib/warehouseScope and lib/transferBuildSummary. No test runner is configured
// in this project, so this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/sites.test.ts
//
// The same cases are pinned on the backend in tests/services/test_sites.py.

import {
  COLD_SITES, GRANTABLE_SITES, TO_SITES, WAREHOUSE_SITES,
  canonicalSite, coldCompany, displaySite, isColdSite, isKnownSite, sameSite, siteAddress, siteAliases, siteKey, siteKind,
} from "./sites.ts";
import { normaliseWarehouseCode, userHasAnyWarehouse, userHasWarehouse } from "./warehouseScope.ts";
import { getDisplayWarehouseName, normalizeWarehouseName } from "./transferBuildSummary.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// ── keys ──
check("key: upper case, punctuation and spaces dropped",
  ["W-202", " w 202 ", "Savla-D39", "dev_int", "", null, undefined].map(siteKey),
  ["W202", "W202", "SAVLAD39", "DEVINT", "", "", ""]);
check("key is the warehouseScope normaliser",
  ["W-202", "A 185", "Savla D-39 Cold", "ESKIMO", ""].map((s) => normaliseWarehouseCode(s) === siteKey(s)),
  [true, true, true, true, true]);

// ── every spelling resolves to its site ──
const SPELLINGS: [string, string][] = [
  ["W202", "W202"], ["W-202", "W202"], ["Warehouse W202", "W202"], ["warehouse w-202", "W202"],
  ["A185", "A185"], ["A-185", "A185"], ["Warehouse A185", "A185"], ["A185 Cold", "A185"], ["A-185 Cold", "A185"],
  ["A101", "A101"], ["Warehouse A101", "A101"], ["A68", "A68"], ["A-68", "A68"], ["Warehouse A68", "A68"],
  ["F53", "F53"], ["Warehouse F53", "F53"], ["APMC F53", "F53"], ["apmc-f53", "F53"],
  ["Rishi", "Rishi"], ["RISHI", "Rishi"], ["Rishi Cold", "Rishi"], ["Rishi Cold Storage", "Rishi"],
  ["Rishi Cold Storage Pvt Ltd", "Rishi"],
  ["Savla D-39", "Savla D-39"], ["savla d39", "Savla D-39"], ["savla-d-39", "Savla D-39"], ["D-39", "Savla D-39"],
  ["D39", "Savla D-39"], ["Savla D-39 Cold", "Savla D-39"], ["Savla D-39 Cold Storage", "Savla D-39"],
  ["Old Savla", "Savla D-39"], ["old_savla", "Savla D-39"], ["Savla D-34", "Savla D-39"],
  ["Savla D-514", "Savla D-514"], ["savla d514", "Savla D-514"], ["D-514", "Savla D-514"], ["D514", "Savla D-514"],
  ["Savla D-514 Cold", "Savla D-514"], ["Savla D-514 Cold Storage", "Savla D-514"], ["New Savla", "Savla D-514"],
  ["Savla Bond", "Savla Bond"], ["SAVLA BOND", "Savla Bond"], ["savla_bond", "Savla Bond"],
  ["Supreme", "Supreme"], ["SUPREME", "Supreme"], ["Supreme Cold", "Supreme"], ["Supreme Cold Storage", "Supreme"],
  ["Eskimo", "Eskimo"], ["ESKIMO", "Eskimo"], ["Eskimo Cold", "Eskimo"], ["Eskimo Cold Storage", "Eskimo"],
  ["Cold Storage", "Cold Storage"], ["COLD STORAGE", "Cold Storage"], ["cold-storage", "Cold Storage"],
  ["Dev Int", "Dev Int"], ["dev_int", "Dev Int"],
];
check("every spelling resolves to its site",
  SPELLINGS.filter(([raw, want]) => canonicalSite(raw) !== want).map(([raw]) => raw), []);
check("an unknown name comes back trimmed, empty as empty",
  [canonicalSite("  Savla "), canonicalSite("Some Godown"), canonicalSite(""), canonicalSite(null), canonicalSite(undefined)],
  ["Savla", "Some Godown", "", "", ""]);

// ── same site ──
const SAME: [string | null, string | null, boolean][] = [
  ["Warehouse A185", "A185", true], ["A-185", "A185", true], ["A185 Cold", "A185", true],
  ["D-39", "Savla D-39", true], ["Savla D39", "Savla D-39", true], ["Savla D-39 Cold", "Savla D-39", true],
  ["Savla D-34", "Savla D-39", true], ["Old Savla", "D-39", true], ["New Savla", "D-514", true],
  ["Supreme Cold", "Supreme", true], ["Supreme Cold Storage", "Supreme", true],
  ["ESKIMO", "Eskimo", true], ["Rishi Cold Storage Pvt Ltd", "Rishi", true], ["W-202", "Warehouse W202", true],
  ["Dev Int", "dev_int", true], ["Savla Bond", "savla bond", true], ["Cold Storage", "cold storage", true],
  ["Savla Bond", "Savla D-39", false], ["Savla Bond", "D-39", false], ["Savla D-39", "Savla D-514", false],
  ["Cold Storage", "Rishi", false], ["Cold Storage", "Savla D-39", false], ["Cold Storage", "Supreme", false],
  ["Savla", "Savla D-39", false], ["Savla", "Savla D-514", false], ["W202", "A185", false], ["A185", "A101", false],
  ["Some Godown", "some-godown", true], ["Some Godown", "Other Godown", false],
  ["", "", false], ["", "A185", false], ["A185", "", false], [null, null, false], ["  ", "  ", false],
];
check("same-site truth table",
  SAME.filter(([a, b, want]) => sameSite(a, b) !== want || sameSite(b, a) !== want).map(([a, b]) => `${a} / ${b}`), []);

// ── kind, company, display, address ──
check("cold stores and the legacy Cold Storage label are cold",
  ["Rishi", "Savla D-39", "D-514", "Savla Bond", "Supreme Cold", "Eskimo", "Cold Storage"].map(isColdSite),
  [true, true, true, true, true, true, true]);
check("warehouses, the A185 Cold floor, Dev Int and unknown names are not",
  ["W202", "A-185", "A185 Cold", "F53", "Dev Int", "Savla", "", null].map(isColdSite),
  [false, false, false, false, false, false, false, false]);
check("kinds", ["W-202", "Savla Bond", "Cold Storage", "Dev Int", "Savla", ""].map(siteKind),
  ["warehouse", "cold", "cold", "unknown", "unknown", "unknown"]);
check("known sites: every table site, Dev Int (kind unknown) too; not bare Savla or empty",
  ["W-202", "Savla Bond", "Cold Storage", "Dev Int", "dev_int", "Savla", "Some Godown", "", null].map(isKnownSite),
  [true, true, true, true, true, false, false, false, false]);
check("cold companies",
  ["Savla D-39", "D-514", "Savla Bond", "Rishi", "Supreme Cold", "ESKIMO", "Cold Storage", "W202", "Savla", ""].map(coldCompany),
  ["cfpl", "cfpl", "cfpl", "cdpl", "cdpl", "cdpl", null, null, null, null]);
check("display names", ["Supreme", "D-39", "W-202", "Savla Bond", "Cold Storage", " Some Godown ", ""].map(displaySite),
  ["Supreme Cold Storage", "Savla D-39 Cold Storage", "Warehouse W202", "Savla Bond", "Cold Storage", "Some Godown", ""]);
check("addresses", [siteAddress("Supreme Cold"), siteAddress("Savla Bond"), siteAddress("Savla"), siteAddress(null)],
  ["MIDC, Turbhe, Navi Mumbai", "", "", ""]);
check("Eskimo prints an address", siteAddress("Eskimo").includes("A-824/1"), true);

// ── aliases ──
check("aliases of the grant code D-39",
  siteAliases("D-39"), ["Savla D-39", "Savla D-39 Cold Storage", "D-39", "Savla D-39 Cold", "Old Savla", "Savla D-34"]);
check("an unknown name is its own only spelling", [siteAliases(" Store "), siteAliases(""), siteAliases(null)], [["Store"], [], []]);
check("Savla Bond's spellings stay out of Savla D-39",
  siteAliases("Savla D-39").map(siteKey).includes("SAVLABOND"), false);

// ── lists ──
check("warehouse sites", WAREHOUSE_SITES, ["W202", "A185", "A101", "A68", "F53"]);
check("cold sites", COLD_SITES, ["Rishi", "Savla D-39", "Savla D-514", "Savla Bond", "Supreme", "Eskimo"]);
check("to sites", TO_SITES, ["W202", "A185", "A101", "A68", "F53", "Rishi", "Savla D-39", "Savla D-514", "Savla Bond", "Supreme", "Eskimo"]);
check("grantable codes", GRANTABLE_SITES, ["W202", "A185", "A101", "A68", "F53", "Rishi", "D-39", "D-514", "Savla Bond", "Supreme", "Eskimo"]);
check("Cold Storage is in no list",
  [TO_SITES, COLD_SITES, WAREHOUSE_SITES, GRANTABLE_SITES].map((list) => list.some((s) => sameSite(s, "Cold Storage"))),
  [false, false, false, false]);
check("the lists cannot be changed", Object.isFrozen(TO_SITES) && Object.isFrozen(GRANTABLE_SITES), true);

// ── warehouseScope, rebuilt on sameSite ──
const HAS: [string[] | null, string, boolean][] = [
  [["D-39"], "Savla D-39", true], [["D-39"], "Savla D39", true], [["A185"], "Warehouse A185", true],
  [["A185"], "A-185", true], [["Supreme"], "Supreme Cold", true], [["W-202"], "W202", true],
  [["Savla Bond"], "Savla Bond", true], [["Eskimo"], "ESKIMO", true], [["Store"], "store", true],
  [["Rishi"], "Cold Storage", false], [["D-39"], "Savla Bond", false], [["Savla Bond"], "D-39", false],
  [["W202"], "A185", false], [["A185"], "", false], [[], "A185", false], [null, "A185", false], [[""], "", false],
];
check("userHasWarehouse",
  HAS.filter(([grants, code, want]) => userHasWarehouse(grants, code) !== want).map(([g, c]) => `${JSON.stringify(g)} / ${c}`), []);
check("userHasAnyWarehouse",
  [userHasAnyWarehouse(["D-39"], ["X", "Savla D-39"]), userHasAnyWarehouse(["A185"], ["W202", "W-202"]), userHasAnyWarehouse(["A185"], [])],
  [true, false, false]);

// ── transferBuildSummary keeps its names and returns the canonical site ──
check("normalizeWarehouseName gives the canonical name",
  ["A-185", "Warehouse A185", "D-39", "Supreme Cold", "Eskimo Cold", "Savla Bond", "dev_int", " Unknown Site ", "", null]
    .map((raw) => normalizeWarehouseName(raw)),
  ["A185", "A185", "Savla D-39", "Supreme", "Eskimo", "Savla Bond", "Dev Int", "Unknown Site", "", ""]);
check("getDisplayWarehouseName is the same function", getDisplayWarehouseName === normalizeWarehouseName, true);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("sites: all checks passed");

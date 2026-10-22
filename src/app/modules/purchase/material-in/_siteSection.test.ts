// node src/app/modules/purchase/material-in/_siteSection.test.ts
import assert from "node:assert/strict";
import { ALL_SITES, initialChoice, seesEverySite, siteChoices, siteSectionLabel, sitesFor } from "./_siteSection.ts";

// Access → choices (warehouses only, every spelling of a grant counts).
assert.deepEqual(siteChoices(false, ["W-202"]), ["W202"]);
assert.deepEqual(siteChoices(false, ["A185", "a-68"]).sort(), ["A185", "A68"]);
assert.deepEqual(siteChoices(false, ["D-39"]), []);                 // a cold store is no consignee plant
const admin = siteChoices(true, []);
for (const w of ["W202", "A185", "A68"]) assert.ok(admin.includes(w), w);
assert.deepEqual(siteChoices(false, []), admin);                     // no lock: every site, as the backend
assert.equal(seesEverySite(false, []), true);
assert.equal(seesEverySite(false, ["W202"]), false);
assert.equal(seesEverySite(true, ["W202"]), true);

// Choice → sites sent as `site`.
assert.deepEqual(sitesFor(ALL_SITES, ["W202", "A185"]), ["W202", "A185"]);
assert.deepEqual(sitesFor("A185", ["W202", "A185"]), ["A185"]);
assert.deepEqual(sitesFor("A68", ["W202"]), ["W202"]);              // pick no longer in access
assert.deepEqual(sitesFor(ALL_SITES, []), []);

// Remembered choice survives only while offered.
assert.equal(initialChoice("A185", ["W202", "A185"]), "A185");
assert.equal(initialChoice("A68", ["W202", "A185"]), ALL_SITES);
assert.equal(initialChoice(null, ["W202"]), ALL_SITES);

// Titles.
assert.equal(siteSectionLabel(ALL_SITES, ["W202"], false), "W202 PO");
assert.equal(siteSectionLabel("A185", ["W202", "A185"], false), "A185 PO");
assert.equal(siteSectionLabel(ALL_SITES, ["W202", "A185"], false), "My sites PO");
assert.equal(siteSectionLabel(ALL_SITES, admin, true), "All sites PO");
assert.equal(siteSectionLabel(ALL_SITES, [], false), "My site PO");

console.log("siteSection: all checks passed");

// node src/lib/job-card-bom-rules.test.ts
import {
  bomUnit, hasBomChanges, isRemovableType, isUsableType, requirementIndents, restoresRemoved, stockOnFloor,
  type BomChanges,
} from "./job-card-bom-rules.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const base = { note: null, changed_by: "Pat", changed_at: "2026-09-21T10:00:00+00:00", made_on_job_card_number: "PLAN-7-L1-S1" };
const changes = (removed: string[], added: Array<[string, "rm" | "pm" | "fg" | "sfg", number | null, boolean?]>): BomChanges => ({
  scope_job_card_id: 1,
  removed: removed.map((n, i) => ({ ...base, change_id: i + 1, material_sku_name: n, item_type: "rm", not_on_bom: false })),
  added: added.map(([n, t, q, sup], i) => ({
    ...base, change_id: 100 + i, material_sku_name: n, item_type: t, sku_id: 5,
    required_qty: q, required_unit: q == null ? null : t === "pm" ? "pcs" : "kg", superseded: !!sup,
  })),
});

check("no block", hasBomChanges(undefined), false);
check("empty block", hasBomChanges(changes([], [])), false);
check("a removal", hasBomChanges(changes(["Seeds"], [])), true);

const indents = [
  { material_sku_name: "Seeds", item_type: "RM", uom: "KGS", gross_qty: 10 },
  { material_sku_name: "Salt", item_type: "RM", uom: "KGS", gross_qty: 1 },
];
check("no changes keeps the indents", requirementIndents(indents, null), indents);
check("added figure replaces the indent figure and adds new ones",
  requirementIndents(indents, changes([], [["salt", "rm", 2.5], ["Tape", "pm", 100], ["Sugar", "rm", null]])),
  [
    { material_sku_name: "Seeds", item_type: "RM", uom: "KGS", gross_qty: 10 },
    { material_sku_name: "salt", item_type: "RM", uom: "KGS", gross_qty: 2.5, reqd_qty: 2.5 },
    { material_sku_name: "Tape", item_type: "PM", uom: "PCS", gross_qty: 100, reqd_qty: 100 },
  ]);
check("superseded adds are ignored",
  requirementIndents(indents, changes([], [["Seeds", "rm", 99, true]])), indents);

check("RM removable", isRemovableType("RM"), true);
check("pm removable", isRemovableType("pm"), true);
check("SFG not removable", isRemovableType("SFG"), false);
check("unit rm", bomUnit("RM"), "kg");
check("unit pm", bomUnit("pm"), "pcs");
check("unit fg", bomUnit("FG"), "kg");
check("unit sfg", bomUnit("sfg"), "kg");

// An added FG / SFG article's required qty is kg, typed by its real type.
check("added fg requirement is kg",
  requirementIndents([], changes([], [["Roasted Mix", "fg", 12]])),
  [{ material_sku_name: "Roasted Mix", item_type: "FG", uom: "KGS", gross_qty: 12, reqd_qty: 12 }]);

// Adding an article removed from this job card restores it (the server keeps no
// required qty or note then); one the BOM module has since dropped is added afresh.
check("restores a removed article, any case and spaces", restoresRemoved(changes(["Salt"], []), "  SALT "), true);
check("nothing removed: no restore", restoresRemoved(changes([], []), "Salt"), false);
check("no block: no restore", restoresRemoved(null, "Salt"), false);
check("another article: no restore", restoresRemoved(changes(["Salt"], []), "Sugar"), false);
check("a blank name: no restore", restoresRemoved(changes([""], []), "  "), false);
check("a removal the BOM no longer has is added afresh",
  restoresRemoved({ ...changes([], []), removed: [{ ...changes(["Salt"], []).removed[0], not_on_bom: true }] }, "Salt"),
  false);

// Types that can be added to a job card (+ Add article, Use on other stock).
check("usable rm", isUsableType("rm"), true);
check("usable PM", isUsableType("PM"), true);
check("usable fg", isUsableType("fg"), true);
check("usable SFG", isUsableType(" SFG "), true);
check("usable '1'", isUsableType("1"), false);
check("usable null", isUsableType(null), false);
check("usable pl/ega", isUsableType("pl/ega"), false);

// An article's stock on this floor, for the Add dialog.
const fresh = { item_name: "Almond Whole", stock_type: "Fresh Stock", available_kg: 836.66, available_quantity: 0 };
const offGrade = { item_name: "ALMOND WHOLE", stock_type: "Off Grade/Rejection", available_kg: 0.5, available_quantity: 0 };
const place = "A185 · Mezzanine";
check("stock not loaded (null)", stockOnFloor(null, "Almond Whole", place), "Floor stock not loaded");
check("stock not loaded (undefined)", stockOnFloor(undefined, "Almond Whole", place), "Floor stock not loaded");
check("none on this floor", stockOnFloor([fresh], "Cashew", place), "None on A185 · Mezzanine");
check("none when the floor is empty", stockOnFloor([], "Cashew", "this floor"), "None on this floor");
check("one fresh row", stockOnFloor([fresh], "Almond Whole", place), "On A185 · Mezzanine: Fresh Stock 836.660 kg");
check("fresh first, then by stock type", stockOnFloor([offGrade, fresh], "Almond Whole", place),
  "On A185 · Mezzanine: Fresh Stock 836.660 kg · Off Grade/Rejection 0.500 kg");
check("stock types after fresh in name order",
  stockOnFloor([
    { item_name: "Salt", stock_type: "Returned", available_kg: 1 },
    { item_name: "Salt", stock_type: "Off Grade/Rejection", available_kg: 2 },
    { item_name: "Salt", stock_type: "Fresh Stock", available_kg: 1234.5 },
  ], "Salt", place),
  "On A185 · Mezzanine: Fresh Stock 1,234.500 kg · Off Grade/Rejection 2.000 kg · Returned 1.000 kg");
check("pieces shown on a PM row when non-zero",
  stockOnFloor([{ item_name: "Pouch 200g", stock_type: "Fresh Stock", available_kg: 12.5, available_quantity: 125000, item_type: "PM" }], "Pouch 200g", place),
  "On A185 · Mezzanine: Fresh Stock 12.500 kg (1,25,000 pcs)");
// Pieces only where the tab shows them (PM rows): stock-take units on an RM line
// are unreliable (some carry the kg figure).
check("an RM row with units shows kg only",
  stockOnFloor([{ item_name: "Mazafati Dates", stock_type: "Fresh Stock", available_kg: 1592.32, available_quantity: 1592.32, item_type: "RM" }], "Mazafati Dates", place),
  "On A185 · Mezzanine: Fresh Stock 1,592.320 kg");
check("a row with no type shows kg only",
  stockOnFloor([{ item_name: "Tape", stock_type: "Fresh Stock", available_kg: 3, available_quantity: 40 }], "Tape", place),
  "On A185 · Mezzanine: Fresh Stock 3.000 kg");
check("a PM residue under half a piece is not '(0 pcs)'",
  stockOnFloor([{ item_name: "Tape", stock_type: "Fresh Stock", available_kg: 3, available_quantity: 0.4, item_type: "pm" }], "Tape", place),
  "On A185 · Mezzanine: Fresh Stock 3.000 kg");
check("nor '(-0 pcs)'",
  stockOnFloor([{ item_name: "Tape", stock_type: "Fresh Stock", available_kg: 3, available_quantity: -0.4, item_type: "PM" }], "Tape", place),
  "On A185 · Mezzanine: Fresh Stock 3.000 kg");
check("a negative PM count shows",
  stockOnFloor([{ item_name: "Tape", stock_type: "Fresh Stock", available_kg: -1, available_quantity: -12, item_type: "PM" }], "Tape", place),
  "On A185 · Mezzanine: Fresh Stock -1.000 kg (-12 pcs)");
check("pieces left out when zero or absent",
  stockOnFloor([{ item_name: "Tape", stock_type: "Fresh Stock", available_kg: 3 }], "Tape", place),
  "On A185 · Mezzanine: Fresh Stock 3.000 kg");
check("match ignores case and surrounding spaces",
  stockOnFloor([fresh], "  almond whole ", place), "On A185 · Mezzanine: Fresh Stock 836.660 kg");
check("other articles are not counted",
  stockOnFloor([fresh, { item_name: "Almond Whole Roasted", stock_type: "Fresh Stock", available_kg: 5 }], "Almond Whole", place),
  "On A185 · Mezzanine: Fresh Stock 836.660 kg");

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-bom-rules: all passed");

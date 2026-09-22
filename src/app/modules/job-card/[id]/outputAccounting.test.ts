// node "src/app/modules/job-card/[id]/outputAccounting.test.ts"
import {
  balanceStateFromDetail, clearedConsumptionKeys, clearedRejections, consumptionStateFromDetail,
  rejectionsFromDetail, resolveRowKey, type RejectionRow,
} from "./outputAccounting.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

const articles = [
  { bom_line_id: 101, material_sku_name: "Seeds" },
  { bom_line_id: null, material_sku_name: "Salt" },
];

check("id wins", resolveRowKey(101, "whatever", articles), "b101");
check("null id resolves to the BOM line of the same article", resolveRowKey(null, " seeds ", articles), "b101");
check("null id resolves to an added article", resolveRowKey(null, "SALT", articles), "nSalt");
check("unknown stays by name", resolveRowKey(null, "Sugar", articles), "nSugar");
check("no articles: old keys", resolveRowKey(null, "Seeds"), "nSeeds");

check("consumption: superseded row lands on the BOM line; zero rows skipped",
  consumptionStateFromDetail([
    { bom_line_id: null, material_sku_name: "seeds", actual_consumed_qty: 3, batch_id: 7 },
    { bom_line_id: null, material_sku_name: "Salt", actual_consumed_qty: "0.000", batch_id: 7 },
  ], 7, articles),
  { b101: "3" });

// A legacy no-batch row shows under every batch; the batch's own row must win over it
// whatever the order, and a batch row cleared to 0 must hide it rather than bring it back.
const legacySeeds = { bom_line_id: 101, material_sku_name: "Seeds", actual_consumed_qty: 2, batch_id: null };
check("consumption: the batch's own row wins over a legacy no-batch twin",
  [consumptionStateFromDetail([{ ...legacySeeds, actual_consumed_qty: 3, batch_id: 7 }, legacySeeds], 7, articles),
   consumptionStateFromDetail([legacySeeds, { bom_line_id: null, material_sku_name: "seeds", actual_consumed_qty: 3, batch_id: 7 }], 7, articles)],
  [{ b101: "3" }, { b101: "3" }]);
check("consumption: a batch row cleared to 0 hides its legacy twin",
  consumptionStateFromDetail([legacySeeds, { ...legacySeeds, actual_consumed_qty: "0.000", batch_id: 7 }], 7, articles),
  {});
check("consumption: a batch with no row of its own still shows the legacy row",
  consumptionStateFromDetail([legacySeeds, { ...legacySeeds, actual_consumed_qty: 0, batch_id: 7 }], 8, articles),
  { b101: "2" });

check("balance: zero rows still seed 0, remapped",
  balanceStateFromDetail([{ bom_line_id: null, material_name: "Seeds", balance_type: "returned", qty_kg: 0, batch_id: 7 }], 7, articles),
  { b101: "0" });

check("rejections: zero rows do not come back",
  rejectionsFromDetail([
    { category: "offgrade", qty_kg: 0, material_name: "Seeds", bom_line_id: 101, batch_id: 7 },
    { category: "offgrade", qty_kg: 1.5, material_name: "Salt", bom_line_id: null, batch_id: 7 },
  ], [], 7).map((r) => r.materialName),
  ["Salt"]);

const legacyTukda = { category: "tukda", qty_kg: 1.5, material_name: "Seeds", bom_line_id: 101, batch_id: null };
check("rejections: a batch row (even at 0) hides its legacy no-batch twin; other articles stay",
  rejectionsFromDetail([
    legacyTukda,
    { category: "tukda", qty_kg: 0, material_name: " seeds ", bom_line_id: 101, batch_id: 7 },
    { category: "tukda", qty_kg: 1, material_name: "Salt", bom_line_id: null, batch_id: null },
  ], [], 7).map((r) => [r.materialName, r.qty]),
  [["Salt", "1"]]);
check("rejections: the batch's own figure wins over the legacy one",
  rejectionsFromDetail([
    { category: "tukda", qty_kg: 4, material_name: "Seeds", bom_line_id: 101, batch_id: 7 }, legacyTukda,
  ], [], 7).map((r) => r.qty),
  ["4"]);
check("rejections: a batch with no row of its own still shows the legacy row",
  rejectionsFromDetail([legacyTukda, { ...legacyTukda, qty_kg: 0, batch_id: 7 }], [], 8).map((r) => r.qty),
  ["1.5"]);

check("cleared consumption: seeded > 0 and now empty or 0",
  clearedConsumptionKeys({ b101: "3", nSalt: "1", b9: "0" }, { b101: "", nSalt: "0.5", b9: "" }),
  ["b101"]);
check("stale baseline: a figure saved elsewhere meanwhile is never zeroed",
  clearedConsumptionKeys({}, {}), []);

const row = (category: string, materialName: string, qty: string, bomLineId: number | null = null): RejectionRow =>
  ({ category, materialName, qty, remarks: "", bomLineId });
check("cleared off-grade: removed, zeroed and re-pointed rows",
  clearedRejections(
    [row("offgrade", "Seeds", "2", 101), row("tukda", "Salt", "1"), row("dust", "Sugar", "4"), row("offgrade", "", "1")],
    [row("tukda", "Salt", "0"), row("dust", "Tape", "4"), row("offgrade", "Pouch", "1")],
  ).map((r) => [r.category, r.materialName, r.qty]),
  [["offgrade", "Seeds", "0"], ["tukda", "Salt", "0"], ["dust", "Sugar", "0"]]);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("outputAccounting: all passed");

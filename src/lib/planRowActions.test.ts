// node src/lib/planRowActions.test.ts
import { buildArticleOptions, getLineId, planRowFlags, round3 } from "./planRowActions.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Which job-card buttons a plan row shows: Create while any line has balance
// left to card (an un-carded line always does), Edit once any line is carded.
check("nothing carded yet → Create only", planRowFlags({ lines_summary: [
  { plan_line_id: 1, planned_qty_kg: 100, job_card_count: 0 },
  { plan_line_id: 2, planned_qty_kg: "50.000", job_card_count: null },
] }), { anyCarded: false, anyRemaining: true });
check("every line fully carded → Edit only", planRowFlags({ lines_summary: [
  { plan_line_id: 1, planned_qty_kg: 100, job_card_count: 1, carded_qty_kg: 100 },
  // Within the 0.001 kg tolerance counts as fully carded.
  { plan_line_id: 2, planned_qty_kg: "50.000", job_card_count: 2, carded_qty_kg: "49.9995" },
] }), { anyCarded: true, anyRemaining: false });
check("a line carded in part → both", planRowFlags({ lines_summary: [
  { plan_line_id: 1, planned_qty_kg: 100, job_card_count: 1, carded_qty_kg: 60 },
] }), { anyCarded: true, anyRemaining: true });
check("one line carded, another not → both", planRowFlags({ lines_summary: [
  { plan_line_id: 1, planned_qty_kg: 100, job_card_count: 1, carded_qty_kg: 100 },
  { plan_line_id: 2, planned_qty_kg: 40, job_card_count: 0 },
] }), { anyCarded: true, anyRemaining: true });
check("no lines → neither", planRowFlags({ lines_summary: [] }), { anyCarded: false, anyRemaining: false });
check("no line list → neither", planRowFlags({ lines_summary: null }), { anyCarded: false, anyRemaining: false });

// The wizard's article options: un-carded lines of the same SKU + BOM (case and
// spacing ignored) fold into one option with the combined qty and every line
// id; a carded line stays on its own with the balance it has left.
check("same SKU + BOM merge; carded and other-BOM lines stay single", buildArticleOptions([
  { plan_line_id: 11, bom_id: 7, fg_sku_name: "Chia Seeds 1kg", planned_qty_kg: "100.5", planned_qty_units: 10, job_card_count: 0 },
  { plan_line_id: 12, bom_id: 7, fg_sku_name: " chia seeds 1KG ", planned_qty_kg: 200.25, planned_qty_units: "20", job_card_count: 0 },
  { plan_line_id: 13, bom_id: 7, fg_sku_name: "Chia Seeds 1kg", planned_qty_kg: 80, planned_qty_units: 8, job_card_count: 1, carded_qty_kg: "30" },
  { plan_line_id: 14, bom_id: 9, fg_sku_name: "Chia Seeds 1kg", planned_qty_kg: 5, job_card_count: 0 },
]), [
  { id: 11, fgSkuName: "Chia Seeds 1kg", kg: 300.75, units: 30, carded: false, remainingKg: 300.75, memberIds: [11, 12], count: 2 },
  { id: 13, fgSkuName: "Chia Seeds 1kg", kg: 80, units: 8, carded: true, remainingKg: 50, memberIds: [13], count: 1 },
  { id: 14, fgSkuName: "Chia Seeds 1kg", kg: 5, units: 0, carded: false, remainingKg: 5, memberIds: [14], count: 1 },
]);
check("a fully carded line has nothing left", buildArticleOptions([
  { plan_line_id: 21, fg_sku_name: "Flax 500g", planned_qty_kg: 40, job_card_count: 2, carded_qty_kg: 45 },
]).map((o) => o.remainingKg), [0]);
check("a line with no plan_line_id stays single, keyed by its position", buildArticleOptions([
  { plan_line_id: 31, fg_sku_name: "Oats", planned_qty_kg: 1, job_card_count: 0 },
  { fg_sku_name: "Oats", planned_qty_kg: 2, job_card_count: 0 },
]).map((o) => [o.id, o.memberIds, o.kg]), [[31, [31], 1], [1, [1], 2]]);
check("no lines, no options", buildArticleOptions([]), []);

check("line id falls back to the position", [getLineId({ plan_line_id: 5 }, 0), getLineId({}, 3)], [5, 3]);
check("summed kg loses its float noise", round3(0.1 + 0.2), 0.3);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("planRowActions: all checks passed");

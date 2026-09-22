// Exercises lib/scanRollup. No test runner is configured in this project, so
// this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/scanRollup.test.ts

import { BLANK_ARTICLE, matchIssues, rollupByArticle, varianceBaseline } from "./scanRollup.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// ── scans rolled up per article ──
check("weights and boxes add up per article",
  rollupByArticle([
    { article: "Raisin", net_weight: 10 },
    { article: " Raisin ", net_weight: 2.5 },
    { article: "Cashew", net_weight: 4 },
  ]),
  [{ article: "Raisin", net_weight: 12.5, boxes: 2 }, { article: "Cashew", net_weight: 4, boxes: 1 }]);
check("heaviest first",
  rollupByArticle([{ article: "A", net_weight: 1 }, { article: "B", net_weight: 9 }]).map((i) => i.article),
  ["B", "A"]);
check("a blank article still carries its weight",
  rollupByArticle([{ article: "  ", net_weight: 3 }, { article: null, net_weight: 1 }]),
  [{ article: BLANK_ARTICLE, net_weight: 4, boxes: 2 }]);
check("a missing weight counts as zero",
  rollupByArticle([{ article: "A", net_weight: null }]), [{ article: "A", net_weight: 0, boxes: 1 }]);

// ── matched against the BOM ──
const issues = rollupByArticle([
  { article: "Raisin", net_weight: 10 },
  { article: "Rasin", net_weight: 4 },
  { article: null, net_weight: 1 },
]);
check("names on the BOM match, the rest are surfaced", {
  matched: [...matchIssues(issues, ["Raisin", "Cashew"]).matched.keys()],
  unmatched: matchIssues(issues, ["Raisin", "Cashew"]).unmatched.map((u) => u.article),
}, { matched: ["Raisin"], unmatched: ["Rasin", BLANK_ARTICLE] });

// ── which quantity the variance is read against ──
check("a scanned kg quantity is the baseline",
  varianceBaseline(12.5, 11, "KG"), { qty: 12.5, source: "scanned" });
check("a blank uom is kilograms",
  varianceBaseline(12.5, 11, ""), { qty: 12.5, source: "scanned" });
check("a missing uom is kilograms",
  varianceBaseline(12.5, 11, null), { qty: 12.5, source: "scanned" });
check("kilogram spellings and spacing are all kilograms", [
  varianceBaseline(1, 2, "kg").source,
  varianceBaseline(1, 2, " Kgs ").source,
  varianceBaseline(1, 2, "KILOGRAM").source,
  varianceBaseline(1, 2, "Kilograms").source,
], ["scanned", "scanned", "scanned", "scanned"]);
check("a piece-count line falls back to the BOM",
  varianceBaseline(12.5, 11, "PCS"), { qty: 11, source: "bom" });
check("litres fall back too — scans only ever carry kg",
  varianceBaseline(12.5, 11, "LTR").source, "bom");
check("nothing scanned falls back to the BOM",
  varianceBaseline(null, 11, "KG"), { qty: 11, source: "bom" });
check("a zero scan falls back to the BOM",
  varianceBaseline(0, 11, "KG"), { qty: 11, source: "bom" });
check("a negative scan falls back to the BOM",
  varianceBaseline(-3, 11, "KG").source, "bom");
check("an infinite scan falls back to the BOM",
  varianceBaseline(Number.POSITIVE_INFINITY, 11, "KG").source, "bom");
check("with neither, there is no baseline",
  varianceBaseline(null, null, "KG"), { qty: null, source: "bom" });
check("a non-finite BOM quantity is no baseline",
  varianceBaseline(null, Number.NaN, "KG"), { qty: null, source: "bom" });
check("a zero BOM quantity is passed through as it stands",
  varianceBaseline(null, 0, "KG"), { qty: 0, source: "bom" });

// ── a job card with more than one live batch ──
check("a multi-batch job card falls back to the BOM",
  varianceBaseline(200, 100, "KG", true), { qty: 100, source: "bom" });
check("a single-batch job card keeps the scanned baseline",
  varianceBaseline(200, 100, "KG", false), { qty: 200, source: "scanned" });
check("one batch is the default",
  varianceBaseline(200, 100, "KG"), { qty: 200, source: "scanned" });
check("a multi-batch job card with no BOM quantity has no baseline",
  varianceBaseline(200, null, "KG", true), { qty: null, source: "bom" });

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("scanRollup: all checks passed");

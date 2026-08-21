// Exercises the real lib/outpass rule. No test runner is configured in this project, so
// this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/outpass.test.ts
//
// What it guards is an inventory invariant, not a UI detail: an outpass authorizes stock
// to leave the building, so it must carry exactly the parts it says it carries, at their
// own recorded quantities and units — never a rounded total, never a part that isn't on
// this card, never two documents covering the same movement.

import { buildOutpass, sumByUom, formatTotals, parseDispatchIds, type OutpassInput } from "./outpass.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`PASS  ${name}`); return; }
  failures++;
  console.log(`FAIL  ${name}\n        got  ${g}\n        want ${w}`);
}

const JC_ID = 25495623;

const ARTICLES = [
  { article_id: 11, name: "Date Powder", output_qty: 0.2, output_uom: "kg" },
  { article_id: 12, name: "Date Syrup", output_qty: 0.4, output_uom: "kg" },
];

// Three parts off Date Powder — the third in a DIFFERENT unit (084) — and one off Syrup.
const DISPATCHES = [
  { dispatch_id: 901, article_id: 11, seq: 1, qty: 0.05, uom: "kg", recipient: "Ramesh", dispatched_at: "2026-08-19T10:00:00Z" },
  { dispatch_id: 902, article_id: 11, seq: 2, qty: 0.08, uom: "kg", recipient: "Wasim", dispatched_at: "2026-08-20T09:00:00Z" },
  { dispatch_id: 903, article_id: 11, seq: 3, qty: 500, uom: "g", recipient: "Ramesh", dispatched_at: "2026-08-21T09:00:00Z" },
  { dispatch_id: 904, article_id: 12, seq: 4, qty: 0.4, uom: "kg", recipient: "Courier", dispatched_at: "2026-08-21T11:00:00Z" },
];

const base: OutpassInput = {
  jcId: JC_ID, selectedIds: [], mergeAll: false,
  articles: ARTICLES, dispatches: DISPATCHES,
  fgSkuName: "Date Powder", title: "Date trials",
  outputQty: 0.6, outputUom: "kg", cardUom: "kg",
  dispatchRecipient: null, closedAt: "2026-08-18T00:00:00Z", dispatchedAt: null,
};

// ── the query string ────────────────────────────────────────────────────────
check("parses a single id", parseDispatchIds("901"), [901]);
check("parses a selection", parseDispatchIds("901,903"), [901, 903]);
check("tolerates spaces", parseDispatchIds(" 901 , 903 "), [901, 903]);
check("drops junk", parseDispatchIds("901,,abc,-4,0"), [901]);
check("empty when absent", parseDispatchIds(null), []);

// ── one part ────────────────────────────────────────────────────────────────
{
  const d = buildOutpass({ ...base, selectedIds: [902] });
  check("single part — one line at its own qty", d.items, [{ desc: "Date Powder", qty: 0.08, uom: "kg" }]);
  check("single part — sub-numbered", d.outpassNo, `${JC_ID}-2`);
  check("single part — its own driver", d.recipient, "Wasim");
  check("single part — its own date", d.date, "2026-08-20");
}

// ── a chosen SET: only those parts, at their own quantities ────────────────
{
  const d = buildOutpass({ ...base, selectedIds: [901, 903] });
  check("selection — only the ticked parts", d.items, [
    { desc: `Date Powder (part ${JC_ID}-1)`, qty: 0.05, uom: "kg" },
    { desc: `Date Powder (part ${JC_ID}-3)`, qty: 500, uom: "g" },   // 084: keeps its own unit
  ]);
  check("selection — excludes the unticked part", d.items.some((i) => i.desc.includes("-2")), false);
  check("selection — numbered by every seq it carries", d.outpassNo, `${JC_ID}-1+3`);
  check("selection — dated by the last part on it", d.date, "2026-08-21");
  check("selection — names every driver once", d.recipient, "Ramesh");
}

// ── a set spanning two articles ────────────────────────────────────────────
{
  const d = buildOutpass({ ...base, selectedIds: [902, 904] });
  check("cross-article selection — each line names its own article", d.items.map((i) => i.desc), [
    `Date Powder (part ${JC_ID}-2)`, `Date Syrup (part ${JC_ID}-4)`,
  ]);
  check("cross-article selection — distinct drivers listed", d.recipient, "Wasim, Courier");
  check("cross-article selection — total is the sum of the parts", d.totalQty, 0.48);
}

// ── selection order must not change the document ───────────────────────────
{
  const a = buildOutpass({ ...base, selectedIds: [901, 903] });
  const b = buildOutpass({ ...base, selectedIds: [903, 901] });
  check("ticking order does not reorder the lines", b.items.map((i) => i.qty).sort(),
    a.items.map((i) => i.qty).sort());
}

// ── an id that is not on this card is dropped, never faked ─────────────────
{
  const d = buildOutpass({ ...base, selectedIds: [901, 99999] });
  check("unknown id dropped", d.selected.map((s) => s.dispatch_id), [901]);
  check("unknown id — falls back to the single-part document", d.outpassNo, `${JC_ID}-1`);
  const none = buildOutpass({ ...base, selectedIds: [99999] });
  check("all ids unknown — full-output document, not an empty one", none.outpassNo, String(JC_ID));
  check("all ids unknown — carries the card's output", none.items, [{ desc: "Date Powder", qty: 0.6, uom: "kg" }]);
}

// ── merge=1 is unchanged: every article's FULL output ──────────────────────
{
  const d = buildOutpass({ ...base, mergeAll: true });
  check("merge=1 — one line per article at full output", d.items, [
    { desc: "Date Powder", qty: 0.2, uom: "kg" },
    { desc: "Date Syrup", qty: 0.4, uom: "kg" },
  ]);
  check("merge=1 — not sub-numbered", d.outpassNo, String(JC_ID));
}

// ── no selection at all → the card's full finalized output ─────────────────
{
  const d = buildOutpass(base);
  check("no selection — full output", d.items, [{ desc: "Date Powder", qty: 0.6, uom: "kg" }]);
  check("no selection — plain outpass no", d.outpassNo, String(JC_ID));
}

// ── units are totalled per LABEL, never summed across them ─────────────────
// A part carries its own uom (084) and the quantity is deliberately not converted, so a
// document can legitimately hold "0.05 kg" and "0.08 g" lines. One summed figure under a
// hardcoded "(kg)" is a number nobody can reconcile against the goods issues behind it.
{
  const mixed = [
    { dispatch_id: 901, article_id: 11, seq: 1, qty: 0.05, uom: "kg", recipient: "A", dispatched_at: "2026-08-19" },
    { dispatch_id: 903, article_id: 11, seq: 3, qty: 0.08, uom: "g", recipient: "A", dispatched_at: "2026-08-21" },
  ];
  const d = buildOutpass({ ...base, dispatches: mixed, selectedIds: [901, 903] });
  check("mixed units — flagged", d.mixedUnits, true);
  check("mixed units — subtotal per label", d.totals, [{ uom: "kg", qty: 0.05 }, { uom: "g", qty: 0.08 }]);
  check("mixed units — printable label", d.totalLabel, "0.05 kg + 0.08 g");
  check("mixed units — each line keeps its own unit", d.items.map((i) => i.uom), ["kg", "g"]);
}
{
  const d = buildOutpass({ ...base, selectedIds: [901, 902] });   // both kg
  check("one unit — not flagged", d.mixedUnits, false);
  check("one unit — single subtotal", d.totals, [{ uom: "kg", qty: 0.13 }]);
  check("one unit — plain label", d.totalLabel, "0.13 kg");
  check("one unit — numeric total still usable", d.totalQty, 0.13);
}
check("sumByUom groups in first-seen order",
  sumByUom([{ qty: 1, uom: "g" }, { qty: 2, uom: "kg" }, { qty: 3, uom: "g" }]),
  [{ uom: "g", qty: 4 }, { uom: "kg", qty: 2 }]);
check("sumByUom falls back for a missing label",
  sumByUom([{ qty: 1, uom: null }], "kg"), [{ uom: "kg", qty: 1 }]);
check("sumByUom rounds each subtotal",
  sumByUom([{ qty: 0.08, uom: "kg" }, { qty: 0.4, uom: "kg" }]), [{ uom: "kg", qty: 0.48 }]);
check("formatTotals on nothing", formatTotals([]), "—");

console.log(failures === 0 ? "\nAll outpass checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

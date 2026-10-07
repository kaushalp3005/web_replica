// Exercises lib/debtors. No test runner is configured in this project, so this
// runs directly on Node's native TypeScript stripping:
//
//     node src/lib/debtors.test.ts
//
// What it guards: the DPD screen is read for money decisions, so totals must
// add up exactly, a filter must never silently drop or keep the wrong party,
// and a rupee figure must never be printed in a misleading unit.

import {
  compactInr, filterParties, formatAsOf, formatInr, formatShare, groupParties, normalizeDpdReport,
  phoneNumbers, sortParties, telHref, totalsOf, NO_FILTER, type DpdParty,
} from "./debtors.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

function party(customer: string, ageing: [number, number, number, number], more: Partial<DpdParty> = {}): DpdParty {
  const [lt30, d30to60, d60to90, gt90] = ageing;
  return {
    customer, pending: lt30 + d30to60 + d60to90 + gt90, ageing: { lt30, d30to60, d60to90, gt90 },
    division: null, salesPerson: null, type: null, broker: null, remarks: null, phone: null, email: null, ...more,
  };
}

// ── rupee formatting ──
check("full rupees use Indian grouping", formatInr(18629126.9), "₹1,86,29,127");
check("full rupees round paise", formatInr(60998.6), "₹60,999");
check("a negative balance keeps its sign outside the symbol", formatInr(-1500), "−₹1,500");
check("crores", compactInr(52182997.33), "₹5.22 Cr");
check("lakhs drop a trailing zero", compactInr(2240088.4), "₹22.4 L");
check("whole lakhs print without decimals", compactInr(500000), "₹5 L");
check("just under a crore rounds up into crores, not ₹100 L", compactInr(9999999), "₹1 Cr");
check("just under a lakh rounds up into lakhs", compactInr(99999), "₹1 L");
check("under a lakh stays in full rupees", compactInr(45600), "₹45,600");
check("zero", compactInr(0), "₹0");
check("not a number", compactInr(Number.NaN), "—");

// ── shares ──
check("share to one decimal", formatShare(27872258.51, 52182997.33), "53.4%");
check("share drops .0", formatShare(1, 4), "25%");
check("whole share", formatShare(5, 5), "100%");
check("tiny but real share", formatShare(1, 5000), "<0.1%");
check("nothing", formatShare(0, 10), "0%");
check("no base", formatShare(3, 0), "—");

// ── report date ──
check("as-of date", formatAsOf("2026-09-26"), "26 Sep 2026");
check("as-of missing", formatAsOf(null), null);
check("as-of garbage", formatAsOf("26/09/2026"), null);

// ── phone → tel: link ──
check("a bare 10-digit number is Indian", telHref("98200 12345"), "tel:+919820012345");
check("an explicit country code is kept", telHref("+91 98200-12345"), "tel:+919820012345");
check("a landline with the 0 trunk prefix", telHref("022 2345 6789"), "tel:+912223456789");
check("91 without the plus", telHref("919820012345"), "tel:+919820012345");
check("the first of several numbers", telHref("98200 12345 / 022 2345 6789"), "tel:+919820012345");
check("text around the number is ignored", telHref("Mob: 98200 12345"), "tel:+919820012345");
check("a short local number is dialled as written", telHref("2345678"), "tel:2345678");
check("too short to be a number", telHref("12345"), null);
check("no phone", telHref(null), null);
check("blank phone", telHref("  "), null);
check("several numbers are split out", phoneNumbers("98200 12345 / 022 2345 6789"), ["98200 12345", "022 2345 6789"]);
check("labels before a number are dropped", phoneNumbers("Mob: 98200 12345 or Off: 022 2345 6789"), ["98200 12345", "022 2345 6789"]);
check("fragments too short to dial are dropped", phoneNumbers("98200 12345, ext 21"), ["98200 12345"]);
check("nothing dialable", phoneNumbers("N/A"), []);
check("no phone, no numbers", phoneNumbers(null), []);

// ── totals ──
const P = [
  party("August Assortments", [0, 183750, 0, 469403], { salesPerson: "Ajay Bajaj" }),
  party("Basil Trading", [2280234, 877742, 0, 0], { salesPerson: "Shailendra P" }),
  party("Bigbasket", [0, 139222, 12527, 244304.95], { salesPerson: "PRASHANT PAL" }),
  party("D'Organics", [0, 0, 0, 1480], { salesPerson: "Ajay Bajaj" }),
  party("Istore Direct", [262500, 1663200, 0, 0.26], { salesPerson: null }),
];
const T = totalsOf(P);
check("party count", T.count, 5);
check("pending is the sum of rows", Math.round(T.pending * 100) / 100, 6134363.21);
check("bucket sums", [T.ageing.lt30, T.ageing.d30to60, T.ageing.d60to90, Math.round(T.ageing.gt90 * 100) / 100],
  [2542734, 2863914, 12527, 715188.21]);
// 26 paise is not "a due" — it prints as ₹0, so it must not be counted as one.
check("bucket party counts ignore sub-rupee dust", T.counts, { lt30: 2, d30to60: 4, d60to90: 1, gt90: 3 });
check("totals of nothing", totalsOf([]).pending, 0);

// ── grouping ──
const G = groupParties(P, "salesPerson", "Unassigned");
check("groups sorted by outstanding, blank gets its label",
  G.map((g) => [g.label, g.count]), [["Shailendra P", 1], ["Unassigned", 1], ["Ajay Bajaj", 2], ["PRASHANT PAL", 1]]);
check("blank group key is empty", G[1].key, "");
check("group totals add up", G.find((g) => g.label === "Ajay Bajaj")?.pending, 654633);

// ── filtering ──
check("no filter keeps everything", filterParties(P, NO_FILTER).length, 5);
check("search matches customer, case-insensitive",
  filterParties(P, { ...NO_FILTER, search: "  basket " }).map((p) => p.customer), ["Bigbasket"]);
check("search matches the sales person too",
  filterParties(P, { ...NO_FILTER, search: "ajay" }).map((p) => p.customer), ["August Assortments", "D'Organics"]);
check("dimension filter",
  filterParties(P, { ...NO_FILTER, dims: { salesPerson: "Ajay Bajaj" } }).map((p) => p.customer), ["August Assortments", "D'Organics"]);
check("dimension filter on the blank group",
  filterParties(P, { ...NO_FILTER, dims: { salesPerson: "" } }).map((p) => p.customer), ["Istore Direct"]);
check("bucket filter keeps only parties with dues in it (not 26 paise)",
  filterParties(P, { ...NO_FILTER, bucket: "gt90" }).map((p) => p.customer), ["August Assortments", "Bigbasket", "D'Organics"]);
check("filters combine",
  filterParties(P, { search: "a", dims: { salesPerson: "Ajay Bajaj" }, bucket: "d30to60" }).map((p) => p.customer), ["August Assortments"]);

// ── sorting ──
check("by outstanding, largest first",
  sortParties(P, "pending", "desc").map((p) => p.customer), ["Basil Trading", "Istore Direct", "August Assortments", "Bigbasket", "D'Organics"]);
check("by a bucket, ties broken by name",
  sortParties(P, "d60to90", "desc").map((p) => p.customer), ["Bigbasket", "August Assortments", "Basil Trading", "D'Organics", "Istore Direct"]);
check("by name, A to Z",
  sortParties(P, "customer", "asc").map((p) => p.customer), ["August Assortments", "Basil Trading", "Bigbasket", "D'Organics", "Istore Direct"]);
check("by a dimension puts blanks last in both directions",
  sortParties(P, "salesPerson", "desc").map((p) => p.salesPerson), ["Shailendra P", "PRASHANT PAL", "Ajay Bajaj", "Ajay Bajaj", null]);
check("sorting does not mutate its input", P[0].customer, "August Assortments");

// ── normalising a report (the JSON is external input — later the API's) ──
const R = normalizeDpdReport("apmc", {
  asOf: "2026-09-26",
  source: "APMC + Non APMC DPD 26 sept.xlsx",
  parties: [
    { customer: " Ekta Trading Co-APMC\r\r\n ", type: " Debtors (APMC) ", broker: "", pending: "1,57,088.50",
      ageing: { gt90: "157088.5" }, phone: " 98200 12345 " },
    { customer: "   ", pending: 100, ageing: { lt30: 100 } },
    { customer: "No pending field", ageing: { lt30: 10, gt90: 5 }, phone: 9820012345 },
    "not a party",
  ],
  excluded: { title: "Before APMC outlet ", note: "Not our party", parties: [{ customer: "Bhagyalaxmi", pending: 629257, ageing: { gt90: 629257 } }] },
});
check("names lose line breaks and padding", R.parties.map((p) => p.customer), ["Ekta Trading Co-APMC", "No pending field"]);
check("numeric strings are parsed", [R.parties[0].pending, R.parties[0].ageing.gt90, R.parties[0].ageing.lt30], [157088.5, 157088.5, 0]);
check("blank text becomes null", [R.parties[0].broker, R.parties[0].type], [null, "Debtors (APMC)"]);
check("a missing pending falls back to the bucket sum", R.parties[1].pending, 15);
check("phones: text is trimmed, a spreadsheet number becomes text", R.parties.map((p) => p.phone), ["98200 12345", "9820012345"]);
check("no phone field is null", normalizeDpdReport("cd-cf", { parties: [{ customer: "X", pending: 1 }] }).parties[0].phone, null);
check("report metadata", [R.section, R.asOf, R.source], ["apmc", "2026-09-26", "APMC + Non APMC DPD 26 sept.xlsx"]);
check("a single set-aside group (older files) becomes a list of one",
  R.excluded.map((g) => [g.title, g.note, g.parties.length]), [["Before APMC outlet", "Not our party", 1]]);
check("no set-aside groups", normalizeDpdReport("cd-cf", { parties: [] }).excluded, []);
const R2 = normalizeDpdReport("cd-cf", {
  parties: [{ customer: "Basil Trading", division: " CF ", email: " accounts@basiltrading.in ", pending: 5,
    remarks: "20-21 FY issue\r\n1.  4 lac of packing material\r\n\r\n2. rest   pending " }],
  excluded: [
    { title: "LEGAL", parties: [{ customer: "Pure Food Origin LLP", pending: 50958, ageing: { gt90: 50958 } }] },
    { title: "write off", parties: [] },
    "junk",
  ],
});
check("division and email are trimmed", [R2.parties[0].division, R2.parties[0].email], ["CF", "accounts@basiltrading.in"]);
check("remarks keep their line breaks, tidied", R2.parties[0].remarks, "20-21 FY issue\n1. 4 lac of packing material\n2. rest pending");
check("several set-aside groups, junk dropped", R2.excluded.map((g) => [g.title, g.parties.length]), [["LEGAL", 1], ["write off", 0]]);
check("search finds the division",
  filterParties(R2.parties, { ...NO_FILTER, search: "cf" }).length, 1);
let threw = false;
try { normalizeDpdReport("cd-cf", { rows: [] }); } catch { threw = true; }
check("a file without a parties list is rejected", threw, true);

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("debtors: all checks passed");

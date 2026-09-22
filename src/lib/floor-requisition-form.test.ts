// Exercises lib/floor-requisition-form. No test runner is configured in this
// project, so this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/floor-requisition-form.test.ts

import {
  storeResponseLine,
  checkQty, defaultRequestQty, formatQty, formatWhen, requestStateByArticle, requisitionUnit, STATUS_LABEL,
  type RequisitionStatus,
} from "./floor-requisition-form.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// ── unit ──
check("unit follows the requirement", requisitionUnit("pcs", "RM"), "pcs");
check("kg requirement stays kg", requisitionUnit("kg", "PM"), "kg");
check("PM without a requirement is pieces", requisitionUnit(undefined, " pm "), "pcs");
check("anything else without a requirement is kg", requisitionUnit(null, "SFG"), "kg");

// ── the quantity a dialog opens with ──
check("short kg opens with the shortage", defaultRequestQty(-88.2, "kg"), "88.2");
check("kg shortage rounds to 3 places", defaultRequestQty(-0.1 - 0.2, "kg"), "0.3");
check("short pieces open whole", defaultRequestQty(-1000, "pcs"), "1000");
check("a fractional piece shortage rounds up", defaultRequestQty(-24.2, "pcs"), "25");
check("covered opens empty", defaultRequestQty(12, "kg"), "");
check("exactly covered opens empty", defaultRequestQty(0, "kg"), "");
check("no requirement opens empty", defaultRequestQty(null, "pcs"), "");

// ── checkQty: the server's messages ──
check("kg 88.2", checkQty(" 88.2 ", "kg"), { ok: true, value: 88.2 });
check("kg 3 places", checkQty("0.001", "kg"), { ok: true, value: 0.001 });
check("trailing zeros are not decimals", checkQty("1.2000", "kg"), { ok: true, value: 1.2 });
check("kg 4 places", checkQty("1.2345", "kg"), { ok: false, message: "Kilograms go to 3 decimals at most." });
check("pcs whole", checkQty("1000", "pcs"), { ok: true, value: 1000 });
check("pcs 10.000", checkQty("10.000", "pcs"), { ok: true, value: 10 });
check("pcs fraction", checkQty("10.5", "pcs"), { ok: false, message: "Pieces are whole numbers." });
check("zero", checkQty("0", "kg"), { ok: false, message: "The quantity must be more than 0." });
check("negative", checkQty("-3", "pcs"), { ok: false, message: "The quantity must be more than 0." });
check("text", checkQty("abc", "kg"), { ok: false, message: "Enter a quantity as a number." });
check("empty", checkQty("", "kg"), { ok: false, message: "Enter a quantity as a number." });
check("no exponents", checkQty("1e3", "kg"), { ok: false, message: "Enter a quantity as a number." });
check("too large", checkQty("100000000000", "kg"), { ok: false, message: "That quantity is too large." });

// ── how things read ──
check("kg to 3 places", formatQty(88.2, "kg"), "88.200 kg");
check("pieces whole, grouped", formatQty(1000, "pcs"), "1,000 pcs");
check("India time", formatWhen("2026-09-15T08:35:00+00:00"), "15 Sep 2026, 14:05");
check("India time past midnight", formatWhen("2026-09-15T20:00:00+00:00"), "16 Sep 2026, 01:30");
check("no time", formatWhen(null), "—");
check("status words", STATUS_LABEL.issued, "Issued");

// ── which request belongs to which article ──
const req = (requisition_id: number, material_sku_name: string, status: RequisitionStatus, raised_at: string) =>
  ({ requisition_id, material_sku_name, status, raised_at });
const state = requestStateByArticle([
  req(1, "Pista", "received", "2026-09-10T08:00:00+00:00"),
  req(2, " PISTA ", "raised", "2026-09-15T08:00:00+00:00"),
  req(3, "Pouch", "cancelled", "2026-09-15T09:00:00+00:00"),
  req(4, "Pouch", "issued", "2026-09-14T09:00:00+00:00"),
  req(5, "Carton", "cancelled", "2026-09-15T09:00:00+00:00"),
]);
check("open request, matched ignoring case and padding", state.get("PISTA")?.open?.requisition_id, 2);
check("latest is the newest not cancelled", state.get("PISTA")?.latest?.requisition_id, 2);
check("no open request", state.get("POUCH")?.open ?? null, null);
check("a newer cancelled request does not hide the issued one", state.get("POUCH")?.latest?.requisition_id, 4);
check("only cancelled requests show nothing",
  [state.get("CARTON")?.open ?? null, state.get("CARTON")?.latest ?? null], [null, null]);

// ── store's WhatsApp reply ──
check("no reply", storeResponseLine(null), null);
check("taken up, with who and when (IST)",
  storeResponseLine({ response: "accepted", by: "Kaushal Patil", at: "2026-09-17T07:35:00+00:00" }),
  "Taken up by Kaushal Patil · 17 Sep 2026, 13:05");
check("on hold without a time", storeResponseLine({ response: "on_hold", by: "K", at: null }), "Put on hold by K");
check("no name falls back to the label", storeResponseLine({ response: "on_hold", by: null, at: null }), "On hold at store");
check("an unknown reply still reads as words",
  storeResponseLine({ response: "partly_sent", by: "K", at: null }), "partly sent (K)");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("floor-requisition-form: all checks passed");

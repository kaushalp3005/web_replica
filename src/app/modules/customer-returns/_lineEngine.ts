// Pure line-derivation for Customer Returns — no React, one runnable demo().
// Mirrors _boxEngine.ts (pure engine beside the UI component _LineEditor.tsx).
// Folds the legacy line rules into a patch:
//   • value      = qty × rate            (0 when either is non-positive)
//   • net_weight = round3(uom × qty)     ("" when either is non-positive)
//   • qty is kept as typed. The backend `qty` column is INTEGER, so a quantity must
//     be a whole number: the form's save refuses 2.5 with a message (as the server
//     does) instead of cutting it to 2, which made the saved qty and Value disagree.
//
// Run:  npx tsx -e "import('./src/app/modules/customer-returns/_lineEngine').then(m=>m.demo())"

import type { CRLineForm } from "./_LineEditor";

const n = (v: string | number | null | undefined): number => {
  const x = typeof v === "number" ? v : parseFloat(v ?? "");
  return isNaN(x) ? 0 : x;
};

export function deriveLine(line: CRLineForm, patch: Partial<CRLineForm>): Partial<CRLineForm> {
  const out: Partial<CRLineForm> = { ...patch };

  const next = { ...line, ...out };

  // value = qty × rate; reset to "0" when either is cleared (no stale product).
  if ("qty" in patch || "rate" in patch) {
    const q = n(next.qty), r = n(next.rate);
    out.value = q > 0 && r > 0 ? String(q * r) : "0";
  }

  // net_weight = uom × qty (3dp); "" when either is non-positive.
  if ("qty" in patch || "uom" in patch) {
    const u = n(next.uom), q = n(next.qty);
    out.net_weight = u > 0 && q > 0 ? String(parseFloat((u * q).toFixed(3))) : "";
  }

  return out;
}

// ── Runnable self-check (ponytail: one assert-based demo for the money path) ──
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error("lineEngine demo failed: " + m); };
  const blank = (): CRLineForm => ({
    material_type: "", item_category: "", sub_category: "", item_description: "",
    sale_group: "", uom: "", qty: "", rate: "", value: "", conversion: "",
    carton_weight: "", net_weight: "", lot_number: "", item_mark: "", spl_remarks: "", vakkal: "",
  });

  // value = qty × rate on the resulting line
  assert(deriveLine({ ...blank(), rate: "10" }, { qty: "3" }).value === "30", "value = qty*rate");
  assert(deriveLine({ ...blank(), qty: "4" }, { rate: "2.5" }).value === "10", "rate change recomputes value");

  // F1: qty is kept as typed — never cut; the save refuses a decimal with a message
  assert(deriveLine(blank(), { qty: "2.5" }).qty === "2.5", "a decimal qty is kept, not cut to 2");
  assert(deriveLine(blank(), { qty: "" }).qty === "", "empty qty stays empty");
  assert(deriveLine({ ...blank(), rate: "10" }, { qty: "2.5" }).value === "25", "value from the qty as typed");

  // F2: clearing qty resets a previously-derived value to "0" (no stale 50)
  assert(deriveLine({ ...blank(), qty: "5", rate: "10", value: "50" }, { qty: "" }).value === "0", "cleared qty resets value");

  // net_weight = round3(uom × qty)
  assert(deriveLine({ ...blank(), uom: "12" }, { qty: "3" }).net_weight === "36", "net = uom*qty");
  assert(deriveLine({ ...blank(), uom: "0" }, { qty: "3" }).net_weight === "", "net empty when uom 0");

  console.log("lineEngine demo: ALL ASSERTIONS PASSED");
}

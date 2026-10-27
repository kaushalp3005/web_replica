// node src/lib/job-card-calculated.test.ts
import { boxedFg, calculatedConsumption, followsCalculation, qtyText } from "./job-card-calculated.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Qty consumed from the scans.
check("one batch: what was scanned", calculatedConsumption({ scannedKg: 24.5, uom: "KGS", isPm: false }), 24.5);
check("blank uom is kg", calculatedConsumption({ scannedKg: 3, uom: "", isPm: false }), 3);
check("other batches' share comes off",
  calculatedConsumption({ scannedKg: 200, uom: "kg", isPm: false, otherBatchesKg: 120.25 }), 79.75);
check("never below zero", calculatedConsumption({ scannedKg: 50, uom: "kg", isPm: false, otherBatchesKg: 60 }), 0);
check("scale precision", calculatedConsumption({ scannedKg: 0.1 + 0.2, uom: "kg", isPm: false }), 0.3);
check("packaging is never scanned", calculatedConsumption({ scannedKg: 5, uom: "kg", isPm: true }), null);
check("pieces aren't kg", calculatedConsumption({ scannedKg: 5, uom: "PCS", isPm: false }), null);
check("nothing scanned", calculatedConsumption({ scannedKg: null, uom: "kg", isPm: false }), null);
check("zero scanned", calculatedConsumption({ scannedKg: 0, uom: "kg", isPm: false }), null);

// When a line shows the calculation instead of an input.
check("nothing saved yet", followsCalculation("", 24.5, false), true);
check("saved the same", followsCalculation("24.5004", 24.5, false), true);
check("saved something else: the operator's own", followsCalculation("23", 24.5, false), false);
check("Edit pressed", followsCalculation("", 24.5, true), false);
check("nothing to calculate", followsCalculation("", null, false), false);

check("qty text", [qtyText(24.5), qtyText(0.1 + 0.2), qtyText(10)], ["24.5", "0.3", "10"]);

// FG kg from the batch's boxes.
const byBatch = [
  { batch_id: 4242, boxes: 3, net_kg: 29.4 },
  { batch_id: 4243, boxes: 0, net_kg: 0 },
  { batch_id: null, boxes: 1, net_kg: 5 },
];
check("boxed batch", boxedFg(byBatch, 4242), { kg: 29.4, boxes: 3 });
check("no boxes: typed as before", boxedFg(byBatch, 4243), null);
check("a batch with no entry", boxedFg(byBatch, 9999), null);
check("no batch picked", boxedFg(byBatch, null), null);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-calculated: all checks passed");

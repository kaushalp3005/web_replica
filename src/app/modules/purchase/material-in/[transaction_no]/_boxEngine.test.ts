// node "src/app/modules/purchase/material-in/[transaction_no]/_boxEngine.test.ts"
import { buildAddBoxesPayload, buildAddSections, initDraft, inwardReducer, postedNewSectionIds } from "./_boxEngine.ts";
import type { PurchaseLine, PurchasePoDetail } from "@/lib/purchase-receive";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// A PO with two lines and no boxes yet. Line 1 has arrived, so it gets a seeded section.
const po = {
  transaction_no: "TR-1",
  lines: [
    { line_number: 1, sku_name: "Cashew W320", sections: [] },
    { line_number: 2, sku_name: "Almonds", sections: [] },
  ],
} as unknown as PurchasePoDetail;

let draft = initDraft(po, {}, [{ line_number: 1, lot_number: "L1", clientKey: "key-seed" }]);
draft = inwardReducer(draft, { type: "addSection", line: 2, id: "new-2", clientKey: "key-new" });
draft = inwardReducer(draft, { type: "setNewSectionField", id: "new-2", field: "box_count", value: "3" });

// Save posts only sections with a box count; the seed has none yet.
check("only sections with a box count are posted", postedNewSectionIds(draft, po), ["new-2"]);
check("the ids match what the POST sends", buildAddSections(draft, po, 0).map((s) => s.line_number), [2]);
check("each posted section carries its own key", buildAddSections(draft, po, 0).map((s) => s.client_key), ["key-new"]);

// The seed keeps its key, so a retry of the same seeded section sends the same one.
const seeded = inwardReducer(draft, { type: "setNewSectionField", id: "seed-1", field: "box_count", value: "2" });
check("a seeded section posts with the seed's key", buildAddSections(seeded, po, 0).map((s) => s.client_key), ["key-seed", "key-new"]);

// The POST landed: what it posted leaves the draft, so a retry can't post it again.
const afterSave = inwardReducer(draft, { type: "dropNewSections", ids: postedNewSectionIds(draft, po) });
check("posted sections leave the draft", afterSave.newSections.map((s) => s.id), ["seed-1"]);
check("a retry posts nothing", buildAddSections(afterSave, po, 0), []);

// A section whose PO line is gone is never posted, so it is never dropped either.
const orphan = inwardReducer(
  inwardReducer(draft, { type: "addSection", line: 9, id: "new-9", clientKey: "key-9" }),
  { type: "setNewSectionField", id: "new-9", field: "box_count", value: "2" },
);
check("a section without its PO line is not posted", postedNewSectionIds(orphan, po), ["new-2"]);

// The per-section Add-Boxes panel keeps one key through edits and a tare change.
const line = { line_number: 1, sku_name: "Cashew W320", sections: [{ section_number: 1, box_count: 2, lot_number: "L1", boxes: [] }] } as unknown as PurchaseLine;
let panel = inwardReducer(draft, { type: "genAddBoxes", key: "1-1", line, sectionNumber: 1, count: 2, clientKey: "key-panel" });
panel = inwardReducer(panel, { type: "setAddBoxField", key: "1-1", boxIndex: 0, field: "gross_weight", value: "10.5", carton: "0.5" });
panel = inwardReducer(panel, { type: "setCarton", line: 1, value: "0.4" });
const payload = buildAddBoxesPayload(panel, line, 1, 0);
check("the panel's POST carries its key", payload.client_key, "key-panel");
check("the tare change still applies to the panel", payload.boxes[0].net_weight, 10.1);
check("an empty panel sends no key", buildAddBoxesPayload(draft, line, 1, 0).client_key, null);

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("box engine: all checks passed");

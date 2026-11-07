// node "src/app/modules/purchase/material-in/[transaction_no]/_boxEngine.test.ts"
import { boxApiFields, buildAddBoxesPayload, buildAddSections, buildSavedDraftUpdates, initDraft, inwardReducer, postedNewSectionIds } from "./_boxEngine.ts";
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

// Section gross weight: every generated box gets it, net = gross − Empty Carton + Laminate.
let gw = inwardReducer(draft, { type: "setCarton", line: 2, value: "0.5" });
gw = inwardReducer(gw, { type: "setNewSectionField", id: "new-2", field: "gross_weight", value: "25.5" });
gw = inwardReducer(gw, { type: "generateBoxes", id: "new-2", line: po.lines[1] });
const gwBoxes = gw.newSections.find((s) => s.id === "new-2")!.boxes!;
check("generated boxes carry the section gross", gwBoxes.map((b) => b.gross_weight), ["25.5", "25.5", "25.5"]);
check("and gross less the carton as net", gwBoxes.map((b) => b.net_weight), ["25", "25", "25"]);
check("posted with those weights", buildAddSections(gw, po, 0)[0].boxes.map((b) => [b.gross_weight, b.net_weight]),
  [[25.5, 25], [25.5, 25], [25.5, 25]]);

// A box weighed on its own keeps its weight when the section gross changes.
let gw2 = inwardReducer(gw, { type: "setNewBoxField", id: "new-2", boxIndex: 1, field: "gross_weight", value: "30", carton: "0.5" });
gw2 = inwardReducer(gw2, { type: "setNewSectionField", id: "new-2", field: "gross_weight", value: "26" });
check("section gross re-fills the boxes still on it", gw2.newSections.find((s) => s.id === "new-2")!.boxes!.map((b) => [b.gross_weight, b.net_weight]),
  [["26", "25.5"], ["30", "29.5"], ["26", "25.5"]]);

// The carton changing later re-nets those boxes too.
const gw3 = inwardReducer(gw, { type: "setCarton", line: 2, value: "1" });
check("a carton change re-nets them", gw3.newSections.find((s) => s.id === "new-2")!.boxes!.map((b) => b.net_weight), ["24.5", "24.5", "24.5"]);

// Saved without pressing Generate: the placeholder boxes take the section weights.
const gwNoGen = inwardReducer(inwardReducer(draft, { type: "setCarton", line: 2, value: "0.5" }),
  { type: "setNewSectionField", id: "new-2", field: "gross_weight", value: "10" });
check("ungenerated boxes post the section weights", buildAddSections(gwNoGen, po, 0)[0].boxes.map((b) => [b.gross_weight, b.net_weight]),
  [[10, 9.5], [10, 9.5], [10, 9.5]]);

// No section gross: boxes stay blank, to be weighed one by one, as before.
const blank = inwardReducer(draft, { type: "generateBoxes", id: "new-2", line: po.lines[1] });
check("no section gross leaves boxes blank", blank.newSections.find((s) => s.id === "new-2")!.boxes!.map((b) => b.gross_weight), ["", "", ""]);
check("and posts them unweighed", buildAddSections(draft, po, 0)[0].boxes.map((b) => b.gross_weight), [null, null, null]);

// Gross not above the carton gives no net (as for a box weighed on its own).
const under = inwardReducer(inwardReducer(draft, { type: "setCarton", line: 2, value: "2" }),
  { type: "setNewSectionField", id: "new-2", field: "gross_weight", value: "1.5" });
check("gross below the carton posts no net", buildAddSections(under, po, 0)[0].boxes[0].net_weight, null);

// ── One box at a time ───────────────────────────────────────────────────────
// A new section's boxes are numbered 1… within the section (as the server stores
// them), each with a key made from the section's key.
let one = inwardReducer(draft, { type: "generateBoxes", id: "new-2", line: po.lines[1] });
const oneBoxes = () => one.newSections.find((s) => s.id === "new-2")!.boxes!;
check("boxes number from 1 within the section", oneBoxes().map((b) => b.box_number), [1, 2, 3]);
check("each box has its key", oneBoxes().map((b) => b.key), ["key-new:1", "key-new:2", "key-new:3"]);

// Box 2 saved on its own (print / Update): it gets its id, the draft its section.
one = inwardReducer(one, { type: "newBoxSaved", id: "new-2", boxIndex: 1, boxId: "B-2", sectionNumber: 4 });
const afterOne = buildAddSections(one, po, 0)[0];
check("Save then appends to the section the box made", afterOne.section_number, 4);
check("and posts only the boxes not saved yet", afterOne.boxes.map((b) => b.box_number), [1, 3]);
check("with their keys", afterOne.boxes.map((b) => b.client_key), ["key-new:1", "key-new:3"]);
check("the saved box goes as an update by id", buildSavedDraftUpdates(one).map((u) => [u.section_number, u.boxes.map((b) => b.box_id)]),
  [[4, ["B-2"]]]);

// Every box saved on its own: Save posts nothing for the section.
let all = one;
for (const i of [0, 2]) all = inwardReducer(all, { type: "newBoxSaved", id: "new-2", boxIndex: i, boxId: `B-${i + 1}`, sectionNumber: 4 });
check("a fully saved draft posts nothing", buildAddSections(all, po, 0), []);

// Deleting one draft box leaves the others' numbers alone; the count follows.
const del = inwardReducer(one, { type: "removeNewBox", id: "new-2", boxIndex: 0 });
check("the rest keep their numbers", del.newSections.find((s) => s.id === "new-2")!.boxes!.map((b) => b.box_number), [2, 3]);
check("the section count follows", del.newSections.find((s) => s.id === "new-2")!.box_count, "2");
check("Save posts what is left and unsaved", buildAddSections(del, po, 0)[0].boxes.map((b) => b.box_number), [3]);

// Add-Boxes panel: a box saved on its own is left out of "Save New Boxes".
let p2 = inwardReducer(draft, { type: "genAddBoxes", key: "1-1", line, sectionNumber: 1, count: 3, clientKey: "pk" });
p2 = inwardReducer(p2, { type: "addBoxSaved", key: "1-1", boxIndex: 0, boxId: "P-1" });
check("panel posts only unsaved boxes", buildAddBoxesPayload(p2, line, 1, 0).boxes.map((b) => b.client_key), ["pk:4", "pk:5"]);
check("panel's saved box is an update", buildSavedDraftUpdates(p2).map((u) => [u.line_number, u.section_number, u.boxes[0].box_id]), [[1, 1, "P-1"]]);
const p3 = inwardReducer(p2, { type: "removeAddBox", key: "1-1", boxIndex: 1 });
check("panel delete removes only that box", p3.addBoxes["1-1"].boxes.map((b) => b.box_number), [3, 5]);

// An existing box deleted: its edit state goes, so Save doesn't send it.
const ex = { ...draft, existing: { "1-1": { lot_number: "", manufacturing_date: "", expiry_date: "", boxes: {
  a: { gross_weight: "1", net_weight: "1", lot_number: "", count: "" },
  b: { gross_weight: "2", net_weight: "2", lot_number: "", count: "" } } } } };
check("forgetExistingBox drops only that box", Object.keys(inwardReducer(ex, { type: "forgetExistingBox", key: "1-1", boxId: "a" }).existing["1-1"].boxes), ["b"]);

// The API fields of one box.
check("box fields for the API", boxApiFields({ gross_weight: "10", net_weight: "9.5", lot_number: "", count: "4" }),
  { net_weight: 9.5, gross_weight: 10, lot_number: null, count: 4 });

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("box engine: all checks passed");

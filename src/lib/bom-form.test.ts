// Exercises lib/bom-form — the BOM form's draft ↔ payload logic — field by
// field. No test runner is configured in this project, so this runs directly on
// Node's native TypeScript stripping:
//
//     node src/lib/bom-form.test.ts
//
// The point of most checks here is the KEY SET: every header / line / process
// field the form shows must reach the wire under the exact column name the
// server whitelists (bom_write_service._HEADER_COLS / _LINE_COLS / _ROUTE_COLS).
// A field that is drawn but never sent is the kind of bug nothing else notices.
import {
  PCT_MAX,
  buildCreatePayload,
  buildUpdatePayload,
  headerDiff,
  headerDraft,
  headerPayload,
  lineDraft,
  linePayload,
  materialPatch,
  moveByKey,
  processPatch,
  stepDraft,
  stepPayload,
  validate,
} from "./bom-form.ts";

let failures = 0;
let passes = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
  else passes++;
}

// Mirrors of the server whitelists. If the server adds a column, add it here AND
// to the form, or this file goes red — on purpose.
const SERVER_HEADER_COLS = [
  "fg_sku_name", "customer_name", "pack_size_kg", "entity",
  "item_group", "sub_group", "process_category", "business_unit", "factory",
  "floors", "machines", "shelf_life_days", "gst_rate", "hsn_sac",
  "inventory_group", "customer_code", "output_uom", "bar_line_process",
  "effective_from", "effective_to", "notes",
  "allowed_balance_tolerance_pct",
].sort();
const SERVER_LINE_COLS = [
  "material_sku_name", "item_type", "quantity_per_unit", "uom", "loss_pct",
  "godown", "can_use_offgrade", "offgrade_max_pct", "unit_rate_inr",
  "process_stage", "staging_method", "consumed_at_stage",
].sort();
const SERVER_ROUTE_COLS = [
  "process_name", "stage", "std_time_min", "loss_pct", "qc_check",
  "machine_type", "practical_operation", "stage_bucket",
  "input_kind", "output_kind", "input_code", "output_code",
].sort();

// ── Header ───────────────────────────────────────────────────────────────────
const createHeader = headerDraft();
check("create header: output_uom defaults to the DB default 'kg', active, everything else blank",
  { uom: createHeader.output_uom, active: createHeader.is_active, fg: createHeader.fg_sku_name, notes: createHeader.notes },
  { uom: "kg", active: true, fg: "", notes: "" });

check("header payload names exactly the server's header whitelist",
  Object.keys(headerPayload(createHeader)).sort(), SERVER_HEADER_COLS);

// What GET /{bom_id} hands back: Decimals as strings, dates as ISO, arrays, NULLs.
const serverHeader: Record<string, unknown> = {
  bom_id: 411, fg_sku_name: "ROASTED CASHEW 100G", customer_name: "BIGBASKET",
  customer_code: "BB-1", pack_size_kg: "0.100", version: 2, is_active: true,
  effective_from: "2026-04-01", effective_to: null, item_group: "NUTS", sub_group: "CASHEW",
  entity: "CFPL", notes: null, created_at: "2026-04-01T06:30:00+00:00",
  process_category: "Roast", business_unit: "Retail", factory: "Bhiwandi",
  floors: ["Floor 1", "Floor 2"], machines: [], shelf_life_days: 180, gst_rate: "5.000",
  hsn_sac: "20081910", inventory_group: "FG", output_uom: "kg",
  allowed_balance_tolerance_pct: "0.0010", bar_line_process: null,
};
const editHeader = headerDraft(serverHeader);
check("edit header draft: every server column lands in its box as text",
  editHeader,
  { fg_sku_name: "ROASTED CASHEW 100G", entity: "cfpl", customer_name: "BIGBASKET", customer_code: "BB-1",
    pack_size_kg: "0.100", output_uom: "kg", item_group: "NUTS", sub_group: "CASHEW",
    process_category: "Roast", business_unit: "Retail", factory: "Bhiwandi",
    floors: "Floor 1, Floor 2", machines: "", bar_line_process: "", shelf_life_days: "180",
    gst_rate: "5.000", hsn_sac: "20081910", inventory_group: "FG",
    allowed_balance_tolerance_pct: "0.0010", effective_from: "2026-04-01", effective_to: "",
    notes: "", is_active: true });
check("edit header draft: an ISO timestamp in a date column is cut to YYYY-MM-DD",
  headerDraft({ effective_from: "2026-04-01T00:00:00+05:30" }).effective_from, "2026-04-01");
check("header payload: blanks become null, lists split on commas, numbers parse",
  headerPayload(editHeader),
  { fg_sku_name: "ROASTED CASHEW 100G", entity: "cfpl", customer_name: "BIGBASKET", customer_code: "BB-1",
    pack_size_kg: 0.1, output_uom: "kg", item_group: "NUTS", sub_group: "CASHEW",
    process_category: "Roast", business_unit: "Retail", factory: "Bhiwandi",
    floors: ["Floor 1", "Floor 2"], machines: null, bar_line_process: null, shelf_life_days: 180,
    gst_rate: 5, hsn_sac: "20081910", inventory_group: "FG", allowed_balance_tolerance_pct: 0.001,
    effective_from: "2026-04-01", effective_to: null, notes: null });
check("header payload: whitespace-only customer is null (a generic BOM), name is trimmed",
  (() => { const p = headerPayload({ ...createHeader, fg_sku_name: "  X 1KG ", customer_name: "   " }); return [p.fg_sku_name, p.customer_name]; })(),
  ["X 1KG", null]);

// ── Lines ────────────────────────────────────────────────────────────────────
const newLine = lineDraft();
check("+ Add line: starts as RM on staging 'pick' (the DB default), nothing else set",
  { t: newLine.item_type, sm: newLine.staging_method, og: newLine.can_use_offgrade, id: newLine.bom_line_id, m: newLine.material_sku_name },
  { t: "rm", sm: "pick", og: false, id: null, m: "" });
check("line payload for a new line names exactly the server's line whitelist (no bom_line_id)",
  Object.keys(linePayload({ ...newLine, material_sku_name: "CASHEW W240", quantity_per_unit: "0.5" })).sort(),
  SERVER_LINE_COLS);
check("line payload for a new line: typed values convert, blanks are null",
  linePayload({ ...newLine, material_sku_name: " CASHEW W240 ", quantity_per_unit: "0.5", loss_pct: "2.5", godown: "Factory" }),
  { material_sku_name: "CASHEW W240", item_type: "rm", quantity_per_unit: 0.5, uom: null, loss_pct: 2.5,
    godown: "Factory", can_use_offgrade: false, offgrade_max_pct: null, unit_rate_inr: null,
    process_stage: null, staging_method: "pick", consumed_at_stage: null });

const serverLine = {
  bom_line_id: 9001, bom_id: 411, line_number: 1, material_sku_name: "CASHEW W240", item_type: "RM",
  quantity_per_unit: "0.105", uom: "kg", loss_pct: "2.000", godown: "RM Store", can_use_offgrade: true,
  offgrade_max_pct: "5.000", unit_rate_inr: "780.000", process_stage: "roasting",
  staging_method: "backflush", consumed_at_stage: "Final FG (opening RM)",
};
const editLine = lineDraft(serverLine);
check("existing line → draft → payload keeps every column and its bom_line_id",
  linePayload(editLine),
  { material_sku_name: "CASHEW W240", item_type: "rm", quantity_per_unit: 0.105, uom: "kg", loss_pct: 2,
    godown: "RM Store", can_use_offgrade: true, offgrade_max_pct: 5, unit_rate_inr: 780,
    process_stage: "roasting", staging_method: "backflush", consumed_at_stage: "Final FG (opening RM)",
    bom_line_id: 9001 });
check("existing line with NULL staging stays null (not silently 'pick')",
  linePayload(lineDraft({ ...serverLine, staging_method: null })).staging_method, null);
check("existing line with an unknown type falls back to rm rather than crashing the select",
  lineDraft({ ...serverLine, item_type: "weird" }).item_type, "rm");

check("picking an RM article sets name + type", materialPatch("SALT", "rm"), { material_sku_name: "SALT", item_type: "rm" });
check("picking an SFG article sets name + type", materialPatch("SFG0042", "SFG"), { material_sku_name: "SFG0042", item_type: "sfg" });
check("picking an FG article (hamper component) sets only the name", materialPatch("Pistachio 200g", "fg"), { material_sku_name: "Pistachio 200g" });
check("picking an untyped article sets only the name", materialPatch("X", null), { material_sku_name: "X" });

// ── Processes ────────────────────────────────────────────────────────────────
const newStep = stepDraft();
check("+ Add process: every box blank", Object.values(newStep).filter((v) => v !== "" && typeof v !== "number"), []);
check("process payload names exactly the server's route whitelist",
  Object.keys(stepPayload({ ...newStep, process_name: "Sorting" })).sort(), SERVER_ROUTE_COLS);
check("process payload for a name-only step: stage null (server slugs it), rest null",
  stepPayload({ ...newStep, process_name: " Metal Detection " }),
  { process_name: "Metal Detection", stage: null, std_time_min: null, loss_pct: null, qc_check: null,
    machine_type: null, practical_operation: null, stage_bucket: null, input_kind: null,
    output_kind: null, input_code: null, output_code: null });

const serverStep = {
  route_id: 7001, bom_id: 411, step_number: 1, process_name: "Sorting", stage: "sorting",
  std_time_min: "12.00", loss_pct: "0.500", qc_check: "visual+FM", machine_type: "sorter",
  practical_operation: "Roast & Flavour/Salt", stage_bucket: "Create WIP", input_kind: "RM",
  output_kind: "SFG", input_code: null, output_code: "SFG0042",
};
check("existing process → draft → payload keeps all twelve columns",
  stepPayload(stepDraft(serverStep)),
  { process_name: "Sorting", stage: "sorting", std_time_min: 12, loss_pct: 0.5, qc_check: "visual+FM",
    machine_type: "sorter", practical_operation: "Roast & Flavour/Salt", stage_bucket: "Create WIP",
    input_kind: "RM", output_kind: "SFG", input_code: null, output_code: "SFG0042" });

check("picking a known process fills name + stage when stage is blank",
  processPatch(newStep, { process_name: "Create WIP: Roasting", stage: "roasting" }),
  { process_name: "Create WIP: Roasting", stage: "roasting" });
check("picking a known process keeps a stage the operator already typed",
  processPatch({ ...newStep, stage: "my_stage" }, { process_name: "Packing", stage: "packing" }),
  { process_name: "Packing" });
check("picking a process with no known stage leaves stage blank",
  processPatch(newStep, { process_name: "New Thing" }), { process_name: "New Thing", stage: "" });

// Order is the step number. Add three processes, move the last to the top.
const p1 = { ...stepDraft(), process_name: "One" };
const p2 = { ...stepDraft(), process_name: "Two" };
const p3 = { ...stepDraft(), process_name: "Three" };
const moved = moveByKey(moveByKey([p1, p2, p3], p3.key, -1), p3.key, -1);
check("adding then moving processes reorders the payload (step_number follows array order)",
  moved.map((st) => stepPayload(st).process_name), ["Three", "One", "Two"]);
check("moving the first process up is a no-op", moveByKey([p1, p2], p1.key, -1).map((x) => x.process_name), ["One", "Two"]);
check("moving the last process down is a no-op", moveByKey([p1, p2], p2.key, 1).map((x) => x.process_name), ["One", "Two"]);
check("removing a process is a plain filter", [p1, p2, p3].filter((x) => x.key !== p2.key).map((x) => x.process_name), ["One", "Three"]);

// ── Create payload ───────────────────────────────────────────────────────────
const created = buildCreatePayload(
  { ...createHeader, fg_sku_name: "MALT BAR 40G", entity: "cfpl" },
  [{ ...lineDraft(), material_sku_name: "A", quantity_per_unit: "1" }, { ...lineDraft(), material_sku_name: "B", item_type: "pm", quantity_per_unit: "2", uom: "pcs" }],
  [p1, p2],
);
check("create: lines in order, no bom_line_id on any", created.lines.map((l) => [l.material_sku_name, "bom_line_id" in l]), [["A", false], ["B", false]]);
check("create: processes in order", created.route?.map((st) => st.process_name), ["One", "Two"]);
check("create: route is sent as [] when there are no processes (not omitted)", buildCreatePayload(createHeader, [lineDraft()], []).route, []);
check("create: header fields ride along", [created.fg_sku_name, created.entity, created.output_uom], ["MALT BAR 40G", "cfpl", "kg"]);

// ── Update payload (diff) ────────────────────────────────────────────────────
const untouched = { linesDirty: false, routeDirty: false };
check("update: nothing changed → null (no request)",
  buildUpdatePayload(serverHeader, editHeader, [editLine], [stepDraft(serverStep)], untouched), null);
check("update: one header field → only that key",
  buildUpdatePayload(serverHeader, { ...editHeader, notes: "re-checked" }, [editLine], [], untouched), { notes: "re-checked" });
check("update: clearing a field sends an explicit null",
  buildUpdatePayload(serverHeader, { ...editHeader, customer_code: "" }, [editLine], [], untouched), { customer_code: null });
check("update: Decimal-as-string vs typed number is not a change ('0.100' → 0.1 both sides)",
  buildUpdatePayload(serverHeader, { ...editHeader, pack_size_kg: "0.1" }, [editLine], [], untouched), null);
check("update: toggling Active sends is_active only",
  buildUpdatePayload(serverHeader, { ...editHeader, is_active: false }, [editLine], [], untouched), { is_active: false });
check("update: reactivating sends is_active true",
  buildUpdatePayload({ ...serverHeader, is_active: false }, { ...editHeader, is_active: true }, [editLine], [], untouched), { is_active: true });
check("update: a touched line set is sent whole — existing id kept, new line without one",
  buildUpdatePayload(serverHeader, editHeader, [editLine, { ...lineDraft(), material_sku_name: "NEW", quantity_per_unit: "0.01" }], [], { linesDirty: true, routeDirty: false })?.lines?.map((l) => [l.material_sku_name, l.bom_line_id ?? null]),
  [["CASHEW W240", 9001], ["NEW", null]]);
check("update: an untouched line set is NOT sent even when lines exist",
  "lines" in (buildUpdatePayload(serverHeader, { ...editHeader, notes: "x" }, [editLine], [], untouched) ?? {}), false);
check("update: adding a process sends the whole route in order",
  buildUpdatePayload(serverHeader, editHeader, [editLine], [stepDraft(serverStep), { ...stepDraft(), process_name: "Packing" }], { linesDirty: false, routeDirty: true })?.route?.map((st) => st.process_name),
  ["Sorting", "Packing"]);
check("update: removing every process sends route: [] (clears it)",
  buildUpdatePayload(serverHeader, editHeader, [editLine], [], { linesDirty: false, routeDirty: true }), { route: [] });
check("headerDiff treats undefined and null as the same absence",
  headerDiff({ notes: null }, { notes: undefined }), {});

// ── Validation ───────────────────────────────────────────────────────────────
const okLine = { ...lineDraft(), material_sku_name: "A", quantity_per_unit: "1" };
const okHeader = { ...createHeader, fg_sku_name: "X" };
check("valid form passes", validate(okHeader, [okLine], [{ ...stepDraft(), process_name: "Pack" }]), null);
check("missing FG name", validate(createHeader, [okLine], []), "FG SKU name is required.");
check("no lines", validate(okHeader, [], []), "A BOM needs at least one line.");
check("line without material", validate(okHeader, [{ ...okLine, material_sku_name: " " }], []), "Line 1: material is required.");
check("zero quantity", validate(okHeader, [{ ...okLine, quantity_per_unit: "0" }], []), "Line 1: quantity per unit must be a number greater than 0.");
check("quantity below NUMERIC(15,3)", validate(okHeader, [{ ...okLine, quantity_per_unit: "0.0004" }], []), "Line 1: quantity 0.0004 rounds to 0.000 — use at least 0.001 or a smaller unit.");
check("loss 100 % overflows NUMERIC(5,3)", validate(okHeader, [{ ...okLine, loss_pct: "100" }], []), `Line 1: loss % must be at most ${PCT_MAX}.`);
check("loss 99.999 is the largest accepted", validate(okHeader, [{ ...okLine, loss_pct: "99.999" }], []), null);
check("negative off-grade max", validate(okHeader, [{ ...okLine, offgrade_max_pct: "-1" }], []), "Line 1: off-grade max % must be at least 0.");
check("second line's error names line 2", validate(okHeader, [okLine, { ...okLine, unit_rate_inr: "abc" }], []), "Line 2: unit rate must be a number.");
check("process without a name", validate(okHeader, [okLine], [stepDraft()]), "Process 1: process name is required.");
check("process loss 100 %", validate(okHeader, [okLine], [{ ...stepDraft(), process_name: "P", loss_pct: "100" }]), `Process 1: loss % must be at most ${PCT_MAX}.`);
check("second process's error names process 2", validate(okHeader, [okLine], [{ ...stepDraft(), process_name: "P" }, { ...stepDraft(), process_name: "Q", std_time_min: "-5" }]), "Process 2: std time must be at least 0.");
check("GST rate 100 % overflows", validate({ ...okHeader, gst_rate: "100" }, [okLine], []), `GST rate must be at most ${PCT_MAX}.`);
check("tolerance is a fraction", validate({ ...okHeader, allowed_balance_tolerance_pct: "2" }, [okLine], []), "Balance tolerance must be at most 1.");
check("shelf life must be whole days", validate({ ...okHeader, shelf_life_days: "90.5" }, [okLine], []), "Shelf life must be a whole number.");
check("effective window order", validate({ ...okHeader, effective_from: "2026-05-01", effective_to: "2026-04-01" }, [okLine], []), "Effective-to cannot be before effective-from.");

if (failures) { console.error(`\n${failures} failed, ${passes} passed`); process.exit(1); }
console.log(`bom-form: ${passes} checks passed`);

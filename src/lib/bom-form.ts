// Pure draft ↔ payload logic for the BOM form (app/modules/bom/_BomForm.tsx),
// kept out of the .tsx so Node can test it without React:
//
//     node src/lib/bom-form.test.ts
//
// THE CONTRACT THIS FILE OWNS
//   * A draft holds every value as a STRING (numbers included) so the operator
//     can type "0." or clear a box without it snapping to 0 or NaN. Conversion
//     to the wire shape happens once, in *Payload().
//   * The wire shapes mirror the server's whitelists exactly:
//       headerPayload → bom_write_service._HEADER_COLS + allowed_balance_tolerance_pct
//       linePayload   → _LINE_COLS (+ bom_line_id on PATCH for an existing line)
//       stepPayload   → _ROUTE_COLS
//     A key missing here is a column that silently never reaches the database;
//     bom-form.test.ts pins the key sets so that cannot happen quietly.
//   * Create sends everything. Update sends a DIFF of the header and only the
//     sections that were touched — see buildUpdatePayload.
//
// Only `import type` from ./bom: Node's type stripping erases those, so this
// module has no runtime imports and runs standalone.

import type {
  BomCreateInput,
  BomEntity,
  BomHeaderInput,
  BomItemType,
  BomLineInput,
  BomLineRow,
  BomRouteStep,
  BomRouteStepInput,
  BomStagingMethod,
  BomUpdateInput,
} from "./bom";

export const ITEM_TYPES: readonly BomItemType[] = ["rm", "pm", "sfg"];
export const STAGING: readonly BomStagingMethod[] = ["pick", "backflush", "floor_stock"];

// Suggestion vocabularies for the free-text cells. Taken from what bom_line
// actually holds in production (kg/pcs/gm; Factory/PM Store/APMC; the
// "… & Packing" family), not invented — a datalist only nudges spelling.
export const UOM_SUGGESTIONS = ["kg", "pcs", "gm", "nos", "ltr", "ml", "box", "pack"];
export const GODOWN_SUGGESTIONS = ["Factory", "PM Store", "RM Store", "APMC"];
export const LINE_STAGE_SUGGESTIONS = [
  "Packing",
  "Processing & Packing",
  "Mixing & Packing",
  "Sorting & Packing",
  "Roasting & Packing",
  "Seasoning & Packing",
  "Coating & Packing",
];

// NUMERIC(5,3) on bom_line.loss_pct / offgrade_max_pct, bom_process_route.loss_pct
// and bom_header.gst_rate: 99.999 is the largest value those columns hold. 100
// is a "numeric field overflow" from Postgres — a 500 that names no field — so
// both this form and the server refuse it with the field named.
export const PCT_MAX = 99.999;

// NUMERIC(15,3) on bom_line.quantity_per_unit: anything below this rounds to
// 0.000 and the planner indents nothing for the line.
export const MIN_QTY_PER_UNIT = 0.001;

export function isLineType(v: unknown): v is BomItemType {
  return typeof v === "string" && (ITEM_TYPES as readonly string[]).includes(v);
}

export function isStaging(v: unknown): v is BomStagingMethod {
  return typeof v === "string" && (STAGING as readonly string[]).includes(v);
}

// ── Drafts ─────────────────────────────────────────────────────────────────

export type HeaderDraft = {
  fg_sku_name: string;
  entity: "" | BomEntity;
  customer_name: string;
  customer_code: string;
  pack_size_kg: string;
  output_uom: string;
  item_group: string;
  sub_group: string;
  process_category: string;
  business_unit: string;
  factory: string;
  floors: string;           // comma-separated
  machines: string;         // comma-separated
  bar_line_process: string;
  shelf_life_days: string;
  gst_rate: string;
  hsn_sac: string;
  inventory_group: string;
  allowed_balance_tolerance_pct: string;
  effective_from: string;   // YYYY-MM-DD
  effective_to: string;
  notes: string;
  is_active: boolean;       // edit only
};

export type LineDraft = {
  key: number;
  bom_line_id: number | null;
  material_sku_name: string;
  item_type: BomItemType;
  quantity_per_unit: string;
  uom: string;
  loss_pct: string;
  godown: string;
  can_use_offgrade: boolean;
  offgrade_max_pct: string;
  unit_rate_inr: string;
  process_stage: string;
  staging_method: "" | BomStagingMethod;
  consumed_at_stage: string;
};

export type StepDraft = {
  key: number;
  process_name: string;
  stage: string;
  std_time_min: string;
  loss_pct: string;
  qc_check: string;
  machine_type: string;
  practical_operation: string;
  stage_bucket: string;
  input_kind: string;
  output_kind: string;
  input_code: string;
  output_code: string;
};

let seq = 1;
export const nextKey = () => seq++;

// Header columns arrive un-narrowed (Record<string, unknown>) and NUMERICs may
// be numbers or strings — hence the coercers rather than casts.
export function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}
export function numText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v.trim();
  return "";
}
export function listText(v: unknown): string {
  return Array.isArray(v) ? v.map((x) => asText(x).trim()).filter(Boolean).join(", ") : "";
}
export function dateText(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : "";
}

/** Draft for the header: from a server row on edit, or the create defaults.
 *  Create defaults mirror the database defaults the INSERT would otherwise
 *  bypass (every header column is named explicitly, so a blank would bind NULL
 *  rather than let the default apply): output_uom 'kg'. */
export function headerDraft(h?: Record<string, unknown>): HeaderDraft {
  if (!h) {
    return {
      fg_sku_name: "", entity: "", customer_name: "", customer_code: "", pack_size_kg: "",
      output_uom: "kg",
      item_group: "", sub_group: "", process_category: "", business_unit: "", factory: "",
      floors: "", machines: "", bar_line_process: "", shelf_life_days: "", gst_rate: "",
      hsn_sac: "", inventory_group: "", allowed_balance_tolerance_pct: "",
      effective_from: "", effective_to: "", notes: "", is_active: true,
    };
  }
  const g = (k: string): unknown => h[k];
  const ent = asText(g("entity")).trim().toLowerCase();
  return {
    fg_sku_name: asText(g("fg_sku_name")),
    entity: ent === "cfpl" || ent === "cdpl" ? ent : "",
    customer_name: asText(g("customer_name")),
    customer_code: asText(g("customer_code")),
    pack_size_kg: numText(g("pack_size_kg")),
    output_uom: asText(g("output_uom")),
    item_group: asText(g("item_group")),
    sub_group: asText(g("sub_group")),
    process_category: asText(g("process_category")),
    business_unit: asText(g("business_unit")),
    factory: asText(g("factory")),
    floors: listText(g("floors")),
    machines: listText(g("machines")),
    bar_line_process: asText(g("bar_line_process")),
    shelf_life_days: numText(g("shelf_life_days")),
    gst_rate: numText(g("gst_rate")),
    hsn_sac: asText(g("hsn_sac")),
    inventory_group: asText(g("inventory_group")),
    allowed_balance_tolerance_pct: numText(g("allowed_balance_tolerance_pct")),
    effective_from: dateText(g("effective_from")),
    effective_to: dateText(g("effective_to")),
    notes: asText(g("notes")),
    is_active: g("is_active") !== false,
  };
}

/** Draft for one line: from a server row on edit, or the "+ Add line" defaults.
 *  A new line starts on staging_method 'pick' — the column's database default,
 *  which an explicit NULL from "—" would otherwise bypass. */
export function lineDraft(r?: BomLineRow): LineDraft {
  if (!r) {
    return {
      key: nextKey(), bom_line_id: null, material_sku_name: "", item_type: "rm",
      quantity_per_unit: "", uom: "", loss_pct: "", godown: "", can_use_offgrade: false,
      offgrade_max_pct: "", unit_rate_inr: "", process_stage: "", staging_method: "pick",
      consumed_at_stage: "",
    };
  }
  const t = asText(r.item_type).trim().toLowerCase();
  const sm = asText(r.staging_method).trim().toLowerCase();
  return {
    key: nextKey(),
    bom_line_id: typeof r.bom_line_id === "number" ? r.bom_line_id : null,
    material_sku_name: asText(r.material_sku_name),
    item_type: isLineType(t) ? t : "rm",
    quantity_per_unit: numText(r.quantity_per_unit),
    uom: asText(r.uom),
    loss_pct: numText(r.loss_pct),
    godown: asText(r.godown),
    can_use_offgrade: r.can_use_offgrade === true,
    offgrade_max_pct: numText(r.offgrade_max_pct),
    unit_rate_inr: numText(r.unit_rate_inr),
    process_stage: asText(r.process_stage),
    staging_method: isStaging(sm) ? sm : "",
    consumed_at_stage: asText(r.consumed_at_stage),
  };
}

/** Draft for one process (route step): from a server row, or "+ Add process". */
export function stepDraft(r?: BomRouteStep): StepDraft {
  return {
    key: nextKey(),
    process_name: asText(r?.process_name),
    stage: asText(r?.stage),
    std_time_min: numText(r?.std_time_min),
    loss_pct: numText(r?.loss_pct),
    qc_check: asText(r?.qc_check),
    machine_type: asText(r?.machine_type),
    practical_operation: asText(r?.practical_operation),
    stage_bucket: asText(r?.stage_bucket),
    input_kind: asText(r?.input_kind),
    output_kind: asText(r?.output_kind),
    input_code: asText(r?.input_code),
    output_code: asText(r?.output_code),
  };
}

// ── Picks ──────────────────────────────────────────────────────────────────

/** What picking an article (search or browse) changes on a line: the name,
 *  plus the type when all_sku knows it as rm/pm/sfg. An fg pick (a hamper
 *  component) keeps the type the operator chose — the server rejects 'fg'. */
export function materialPatch(particulars: string, itemType: unknown): Partial<LineDraft> {
  const t = asText(itemType).trim().toLowerCase();
  return { material_sku_name: particulars, ...(isLineType(t) ? { item_type: t } : {}) };
}

/** What picking a known process changes on a step: the name, plus the stage
 *  slug other BOMs store for it — unless the operator already typed one. */
export function processPatch(
  st: StepDraft,
  o: { process_name: string; stage?: string | null },
): Partial<StepDraft> {
  return { process_name: o.process_name, ...(st.stage.trim() ? {} : { stage: asText(o.stage) }) };
}

/** Reorder by key; a no-op at either end. */
export function moveByKey<T extends { key: number }>(arr: T[], key: number, dir: -1 | 1): T[] {
  const i = arr.findIndex((x) => x.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return arr;
  const next = arr.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// ── Draft → wire ───────────────────────────────────────────────────────────

const str = (v: string): string | null => {
  const t = v.trim();
  return t === "" ? null : t;
};
const num = (v: string): number | null => {
  const t = v.trim();
  return t === "" ? null : Number(t);
};
const list = (v: string): string[] | null => {
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : null;
};

export function headerPayload(d: HeaderDraft): BomHeaderInput {
  return {
    fg_sku_name: d.fg_sku_name.trim(),
    entity: d.entity || null,
    customer_name: str(d.customer_name),
    customer_code: str(d.customer_code),
    pack_size_kg: num(d.pack_size_kg),
    output_uom: str(d.output_uom),
    item_group: str(d.item_group),
    sub_group: str(d.sub_group),
    process_category: str(d.process_category),
    business_unit: str(d.business_unit),
    factory: str(d.factory),
    floors: list(d.floors),
    machines: list(d.machines),
    bar_line_process: str(d.bar_line_process),
    shelf_life_days: num(d.shelf_life_days),
    gst_rate: num(d.gst_rate),
    hsn_sac: str(d.hsn_sac),
    inventory_group: str(d.inventory_group),
    allowed_balance_tolerance_pct: num(d.allowed_balance_tolerance_pct),
    effective_from: str(d.effective_from),
    effective_to: str(d.effective_to),
    notes: str(d.notes),
  };
}

export function linePayload(d: LineDraft): BomLineInput {
  const out: BomLineInput = {
    material_sku_name: d.material_sku_name.trim(),
    item_type: d.item_type,
    quantity_per_unit: Number(d.quantity_per_unit),
    uom: str(d.uom),
    loss_pct: num(d.loss_pct),
    godown: str(d.godown),
    can_use_offgrade: d.can_use_offgrade,
    offgrade_max_pct: num(d.offgrade_max_pct),
    unit_rate_inr: num(d.unit_rate_inr),
    process_stage: str(d.process_stage),
    staging_method: d.staging_method || null,
    consumed_at_stage: str(d.consumed_at_stage),
  };
  // Only ever sent on PATCH, and only for a line that already exists.
  if (d.bom_line_id != null) out.bom_line_id = d.bom_line_id;
  return out;
}

export function stepPayload(d: StepDraft): BomRouteStepInput {
  return {
    process_name: d.process_name.trim(),
    stage: str(d.stage),
    std_time_min: num(d.std_time_min),
    loss_pct: num(d.loss_pct),
    qc_check: str(d.qc_check),
    machine_type: str(d.machine_type),
    practical_operation: str(d.practical_operation),
    stage_bucket: str(d.stage_bucket),
    input_kind: str(d.input_kind),
    output_kind: str(d.output_kind),
    input_code: str(d.input_code),
    output_code: str(d.output_code),
  };
}

/** Create: everything, lines and processes in array order (that order becomes
 *  line_number / step_number on the server). */
export function buildCreatePayload(h: HeaderDraft, lines: LineDraft[], route: StepDraft[]): BomCreateInput {
  return {
    ...headerPayload(h),
    fg_sku_name: h.fg_sku_name.trim(),
    lines: lines.map(linePayload),
    route: route.map(stepPayload),
  };
}

/** Header keys whose wire value differs. Both sides go through the same
 *  draft → payload path, so formatting differences (Decimal-as-string, trailing
 *  spaces, "" vs null) never read as changes. */
export function headerDiff(before: BomHeaderInput, after: BomHeaderInput): Partial<BomHeaderInput> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(after) as (keyof BomHeaderInput)[]) {
    if (JSON.stringify(after[k] ?? null) !== JSON.stringify(before[k] ?? null)) out[k] = after[k];
  }
  return out as Partial<BomHeaderInput>;
}

/** Update: the header diff, is_active if toggled, and each collection only if
 *  it was touched. Returns null when there is nothing to send — the server
 *  would answer 400 empty_update, and "Nothing has changed" is a better message. */
export function buildUpdatePayload(
  originalHeader: Record<string, unknown>,
  h: HeaderDraft,
  lines: LineDraft[],
  route: StepDraft[],
  touched: { linesDirty: boolean; routeDirty: boolean },
): BomUpdateInput | null {
  const patch: BomUpdateInput = headerDiff(headerPayload(headerDraft(originalHeader)), headerPayload(h));
  const wasActive = originalHeader.is_active !== false;
  if (h.is_active !== wasActive) patch.is_active = h.is_active;
  if (touched.linesDirty) patch.lines = lines.map(linePayload);
  if (touched.routeDirty) patch.route = route.map(stepPayload);
  return Object.keys(patch).length === 0 ? null : patch;
}

// ── Client-side validation ─────────────────────────────────────────────────
// Mirrors the server's 400s (bom_write_service._validate_*) so the common
// mistakes are caught before a round trip; the server remains the authority.

export function badNumber(
  label: string,
  v: string,
  opts: { int?: boolean; min?: number; max?: number } = {},
): string | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  if (opts.int && !Number.isInteger(n)) return `${label} must be a whole number.`;
  if (opts.min != null && n < opts.min) return `${label} must be at least ${opts.min}.`;
  if (opts.max != null && n > opts.max) return `${label} must be at most ${opts.max}.`;
  return null;
}

export function validate(h: HeaderDraft, lines: LineDraft[], route: StepDraft[]): string | null {
  if (!h.fg_sku_name.trim()) return "FG SKU name is required.";
  const headerChecks: [string, string, Parameters<typeof badNumber>[2]][] = [
    ["Pack size", h.pack_size_kg, { min: 0 }],
    ["Shelf life", h.shelf_life_days, { int: true, min: 0 }],
    ["GST rate", h.gst_rate, { min: 0, max: PCT_MAX }],
    ["Balance tolerance", h.allowed_balance_tolerance_pct, { min: 0, max: 1 }],
  ];
  for (const [label, v, opts] of headerChecks) {
    const p = badNumber(label, v, opts);
    if (p) return p;
  }
  if (h.effective_from && h.effective_to && h.effective_to < h.effective_from) {
    return "Effective-to cannot be before effective-from.";
  }

  if (lines.length === 0) return "A BOM needs at least one line.";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const at = `Line ${i + 1}`;
    if (!l.material_sku_name.trim()) return `${at}: material is required.`;
    if (!isLineType(l.item_type)) return `${at}: type must be RM, PM or SFG.`;
    const qty = Number(l.quantity_per_unit.trim());
    if (l.quantity_per_unit.trim() === "" || !Number.isFinite(qty) || qty <= 0) {
      return `${at}: quantity per unit must be a number greater than 0.`;
    }
    if (Math.round(qty * 1000) / 1000 < MIN_QTY_PER_UNIT) {
      return `${at}: quantity ${qty} rounds to 0.000 — use at least ${MIN_QTY_PER_UNIT} or a smaller unit.`;
    }
    for (const [label, v, opts] of [
      ["loss %", l.loss_pct, { min: 0, max: PCT_MAX }],
      ["off-grade max %", l.offgrade_max_pct, { min: 0, max: PCT_MAX }],
      ["unit rate", l.unit_rate_inr, { min: 0 }],
    ] as const) {
      const p = badNumber(`${at}: ${label}`, v, opts);
      if (p) return p;
    }
    if (l.staging_method && !isStaging(l.staging_method)) return `${at}: staging method is not valid.`;
  }

  for (let i = 0; i < route.length; i++) {
    const st = route[i];
    const at = `Process ${i + 1}`;
    if (!st.process_name.trim()) return `${at}: process name is required.`;
    for (const [label, v, opts] of [
      ["std time", st.std_time_min, { min: 0 }],
      ["loss %", st.loss_pct, { min: 0, max: PCT_MAX }],
    ] as const) {
      const p = badNumber(`${at}: ${label}`, v, opts);
      if (p) return p;
    }
  }
  return null;
}

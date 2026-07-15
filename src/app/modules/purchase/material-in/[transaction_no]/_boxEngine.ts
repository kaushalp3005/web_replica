// Pure draft-state engine for the box-wise inward entry page.
//
// Ports the imperative globals of frontend_replica's po-receiving.js
// (newSections, generatedBoxes, addBoxesData + the carton/net calc) into a
// single immutable reducer plus payload builders. No React, no DOM, and no
// wall-clock reads (Date.now() / argless new Date()) — the timestamp used to
// mint box_ids is passed in by callers, so the reducer and builders are
// deterministic and testable. (buildReceiveRequest does call `new Date(value)`
// to parse the user-entered GRN datetime string into ISO; that is deterministic
// on its input, not a wall-clock read.) All editable values are kept as strings
// (controlled inputs); builders parse them to numbers for the API.

import type {
  PurchasePoDetail,
  PurchaseLine,
  PurchaseBox,
  ReceiveRequest,
  AddSectionPayload,
  UpdateSectionPayload,
} from "@/lib/purchase-receive";

export const BOXES_PER_PAGE = 100;

// Stores-owned logistics (po_header) fields, in display order.
export const LOGISTICS_FIELDS = [
  "customer_party_name",
  "vehicle_number",
  "transporter_name",
  "lr_number",
  "source_location",
  "challan_number",
  "invoice_number",
  "grn_number",
  "system_grn_date",
  "purchased_by",
  "inward_authority",
  "warehouse",
] as const;
export type LogisticsField = (typeof LOGISTICS_FIELDS)[number];

// ── Draft state ───────────────────────────────────────────────────────────────
export interface DraftBox {
  box_number: number;
  gross_weight: string;
  net_weight: string;
  lot_number: string;
  count: string;
}

// Payload handed to the (pluggable) print handler for one box. box_id/
// section_number are null for not-yet-saved boxes (new sections / add-boxes).
export interface PrintBox {
  box_id: string | null;
  box_number: number;
  net_weight: string;
  gross_weight: string;
  lot_number: string;
  count: string;
  line_number: number;
  section_number: number | null;
  sku_name: string;
}

// Print handlers save first, then resolve the box set — so labels reflect the
// just-persisted boxes (real box_id in the QR). The parent runs the full save
// before calling the resolver.
export type PrintResolver = () => Promise<PrintBox[]>;
export interface NewSection {
  id: string;
  line_number: number;
  box_count: string;
  lot_number: string;
  mfg_date: string;
  exp_date: string;
  page: number;
  boxes: DraftBox[] | null; // null until "Generate Boxes"
}
export interface ExistingBoxEdit {
  gross_weight: string;
  net_weight: string;
  lot_number: string;
  count: string;
}
export interface ExistingSectionEdit {
  lot_number: string;
  manufacturing_date: string;
  expiry_date: string;
  boxes: Record<string, ExistingBoxEdit>; // keyed by box_id
}
export interface AddBoxesDraft {
  boxes: DraftBox[];
}
export interface DraftState {
  header: Record<LogisticsField, string>;
  cartonByLine: Record<number, string>;
  existing: Record<string, ExistingSectionEdit>; // key = existingKey(line, section_number)
  newSections: NewSection[];
  addBoxes: Record<string, AddBoxesDraft>; // key = existingKey(line, section_number)
}

export function existingKey(line: number, section: number): string {
  return `${line}-${section}`;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
export function countExistingBoxes(line: PurchaseLine): number {
  // Use the section counts (total_boxes / box_count) so this is correct even in
  // lazy mode where the box rows aren't loaded into s.boxes.
  return (line.sections ?? []).reduce(
    (sum, s) => sum + (s.total_boxes ?? s.box_count ?? s.boxes?.length ?? 0),
    0,
  );
}

// Cap a numeric string to 3 decimal places (reference lines 1408-1420).
export function clamp3(v: string): string {
  if (!v) return v;
  const dot = v.indexOf(".");
  if (dot === -1) return v;
  if (Number.isNaN(parseFloat(v))) return v; // leave non-numeric input untouched
  return v.length - dot - 1 > 3 ? String(parseFloat(parseFloat(v).toFixed(3))) : v;
}

// net = gross - carton, clamped >= 0 to 3 decimals. Empty gross => empty net.
export function computeNet(gross: string, carton: string): string {
  if (!gross) return "";
  const g = parseFloat(gross);
  if (Number.isNaN(g)) return "";
  const c = carton ? parseFloat(carton) : 0;
  const n = g - (Number.isNaN(c) ? 0 : c);
  return n > 0 ? String(parseFloat(n.toFixed(3))) : "";
}

// One pre-seeded new section per (still-unreceived) arrived article.
export interface SectionSeed {
  line_number: number;
  lot_number: string;
}

// ── Init ──────────────────────────────────────────────────────────────────────
// `prefill` (intimation-derived, e.g. vehicle/invoice/challan) only fills header
// fields the PO header left empty — saved receive data on po_header always wins.
// `seeds` pre-creates a new box section per arrived article that has no existing
// section yet (so the receiver only enters box counts + weights). Ids are
// deterministic (`seed-<line>`) so the reducer stays pure and re-seeding on
// refresh is idempotent.
export function initDraft(
  po: PurchasePoDetail,
  prefill?: Partial<Record<LogisticsField, string>>,
  seeds?: SectionSeed[],
): DraftState {
  const header = {} as Record<LogisticsField, string>;
  for (const f of LOGISTICS_FIELDS) {
    // LOGISTICS_FIELDS are all declared optional string|null on PurchasePoDetail;
    // the cast lets us read them by dynamic key without a 12-branch switch.
    const raw = (po as unknown as Record<string, unknown>)[f];
    // GRN datetime → value for <input type="datetime-local"> (trim to minutes).
    header[f] =
      f === "system_grn_date" && typeof raw === "string"
        ? raw.slice(0, 16)
        : raw == null
          ? ""
          : String(raw);
  }
  if (prefill) {
    for (const f of LOGISTICS_FIELDS) {
      const pv = prefill[f];
      if (!header[f] && pv) header[f] = pv;
    }
  }
  const cartonByLine: Record<number, string> = {};
  const existing: DraftState["existing"] = {};
  for (const line of po.lines ?? []) {
    cartonByLine[line.line_number] = line.carton_weight != null ? String(line.carton_weight) : "";
    for (const sec of line.sections ?? []) {
      const boxes: Record<string, ExistingBoxEdit> = {};
      for (const b of sec.boxes ?? []) {
        boxes[b.box_id] = {
          gross_weight: b.gross_weight != null ? String(b.gross_weight) : "",
          net_weight: b.net_weight != null ? String(b.net_weight) : "",
          lot_number: b.lot_number ?? "",
          count: b.count != null ? String(b.count) : "",
        };
      }
      existing[existingKey(line.line_number, sec.section_number)] = {
        lot_number: sec.lot_number ?? "",
        manufacturing_date: sec.manufacturing_date ?? "",
        expiry_date: sec.expiry_date ?? "",
        boxes,
      };
    }
  }
  const newSections: NewSection[] = [];
  if (seeds) {
    for (const seed of seeds) {
      const line = (po.lines ?? []).find((l) => l.line_number === seed.line_number);
      // Skip lines already received (they carry DB sections) — don't duplicate.
      if (!line || (line.sections ?? []).length > 0) continue;
      newSections.push({
        id: `seed-${seed.line_number}`,
        line_number: seed.line_number,
        box_count: "",
        lot_number: seed.lot_number ?? "",
        mfg_date: "",
        exp_date: "",
        page: 1,
        boxes: null,
      });
    }
  }
  return { header, cartonByLine, existing, newSections, addBoxes: {} };
}

// ── Reducer ───────────────────────────────────────────────────────────────────
export type InwardAction =
  | { type: "setHeader"; field: LogisticsField; value: string }
  | { type: "setCarton"; line: number; value: string }
  | { type: "addSection"; line: number; id: string }
  | { type: "removeSection"; id: string }
  | {
      type: "setNewSectionField";
      id: string;
      field: "box_count" | "lot_number" | "mfg_date" | "exp_date";
      value: string;
    }
  | { type: "generateBoxes"; id: string; line: PurchaseLine }
  | { type: "setNewBoxField"; id: string; boxIndex: number; field: keyof DraftBox; value: string; carton: string }
  | { type: "setNewSectionPage"; id: string; page: number }
  | {
      type: "setExistingSectionField";
      key: string;
      field: "lot_number" | "manufacturing_date" | "expiry_date";
      value: string;
    }
  | { type: "setExistingBoxField"; key: string; boxId: string; field: keyof ExistingBoxEdit; value: string; carton: string }
  | { type: "genAddBoxes"; key: string; line: PurchaseLine; sectionNumber: number; count: number }
  | { type: "setAddBoxField"; key: string; boxIndex: number; field: keyof DraftBox; value: string; carton: string }
  | { type: "hydrateSectionBoxes"; key: string; boxes: PurchaseBox[] }
  | { type: "clearAddBoxes"; key: string }
  | { type: "reset"; po: PurchasePoDetail; prefill?: Partial<Record<LogisticsField, string>>; seeds?: SectionSeed[] };

// Recompute net for one box draft given the (possibly new) carton weight.
function withNet<T extends { gross_weight: string; net_weight: string }>(box: T, carton: string): T {
  return { ...box, net_weight: computeNet(box.gross_weight, carton) };
}

export function inwardReducer(state: DraftState, action: InwardAction): DraftState {
  switch (action.type) {
    case "reset":
      return initDraft(action.po, action.prefill, action.seeds);

    case "setHeader":
      return { ...state, header: { ...state.header, [action.field]: action.value } };

    case "setCarton": {
      const { line, value } = action;
      const prefix = `${line}-`;
      // Recompute nets for every box of this line (new sections, existing, add-boxes).
      const newSections = state.newSections.map((sec) =>
        sec.line_number === line && sec.boxes
          ? { ...sec, boxes: sec.boxes.map((b) => withNet(b, value)) }
          : sec,
      );
      const existing: DraftState["existing"] = {};
      for (const [k, sec] of Object.entries(state.existing)) {
        if (k.startsWith(prefix)) {
          const boxes: Record<string, ExistingBoxEdit> = {};
          for (const [id, b] of Object.entries(sec.boxes)) boxes[id] = withNet(b, value);
          existing[k] = { ...sec, boxes };
        } else {
          existing[k] = sec;
        }
      }
      const addBoxes: DraftState["addBoxes"] = {};
      for (const [k, panel] of Object.entries(state.addBoxes)) {
        addBoxes[k] = k.startsWith(prefix)
          ? { boxes: panel.boxes.map((b) => withNet(b, value)) }
          : panel;
      }
      return { ...state, cartonByLine: { ...state.cartonByLine, [line]: value }, newSections, existing, addBoxes };
    }

    case "addSection":
      return {
        ...state,
        newSections: [
          ...state.newSections,
          { id: action.id, line_number: action.line, box_count: "", lot_number: "", mfg_date: "", exp_date: "", page: 1, boxes: null },
        ],
      };

    case "removeSection":
      return { ...state, newSections: state.newSections.filter((s) => s.id !== action.id) };

    case "setNewSectionField":
      return {
        ...state,
        newSections: state.newSections.map((s) =>
          s.id === action.id ? { ...s, [action.field]: action.value } : s,
        ),
      };

    case "generateBoxes": {
      const sec = state.newSections.find((s) => s.id === action.id);
      if (!sec) return state;
      const boxCount = parseInt(sec.box_count, 10) || 0;
      if (boxCount < 1) return state;
      const existingCount = countExistingBoxes(action.line);
      // Boxes already generated in this line's OTHER new sections (reference 485-490).
      let prevGenerated = 0;
      for (const s of state.newSections) {
        if (s.line_number === action.line.line_number && s.id !== action.id && s.boxes) {
          prevGenerated += s.boxes.length;
        }
      }
      const start = existingCount + prevGenerated + 1;
      const boxes: DraftBox[] = Array.from({ length: boxCount }, (_, i) => ({
        box_number: start + i,
        gross_weight: "",
        net_weight: "",
        lot_number: sec.lot_number || "",
        count: "",
      }));
      return { ...state, newSections: state.newSections.map((s) => (s.id === action.id ? { ...s, boxes, page: 1 } : s)) };
    }

    case "setNewBoxField": {
      const { id, boxIndex, field, value, carton } = action;
      const clamped = field === "gross_weight" || field === "net_weight" ? clamp3(value) : value;
      return {
        ...state,
        newSections: state.newSections.map((s) => {
          if (s.id !== id || !s.boxes) return s;
          const boxes = s.boxes.map((b, i) => {
            if (i !== boxIndex) return b;
            const next = { ...b, [field]: clamped };
            return field === "gross_weight" ? { ...next, net_weight: computeNet(clamped, carton) } : next;
          });
          return { ...s, boxes };
        }),
      };
    }

    case "setNewSectionPage":
      return { ...state, newSections: state.newSections.map((s) => (s.id === action.id ? { ...s, page: action.page } : s)) };

    case "setExistingSectionField": {
      const sec = state.existing[action.key];
      if (!sec) return state;
      return { ...state, existing: { ...state.existing, [action.key]: { ...sec, [action.field]: action.value } } };
    }

    case "setExistingBoxField": {
      const { key, boxId, field, value, carton } = action;
      const sec = state.existing[key];
      if (!sec || !sec.boxes[boxId]) return state;
      const clamped = field === "gross_weight" || field === "net_weight" ? clamp3(value) : value;
      const box = { ...sec.boxes[boxId], [field]: clamped };
      const nextBox = field === "gross_weight" ? { ...box, net_weight: computeNet(clamped, carton) } : box;
      return { ...state, existing: { ...state.existing, [key]: { ...sec, boxes: { ...sec.boxes, [boxId]: nextBox } } } };
    }

    case "genAddBoxes": {
      const { key, line, sectionNumber, count } = action;
      if (count < 1) return state;
      const sec = (line.sections ?? []).find((s) => s.section_number === sectionNumber);
      // Prefer the max of loaded boxes; fall back to the section count (lazy mode,
      // where sec.boxes isn't loaded). The backend also regenerates box_id
      // server-side, so a provisional box_number here is only for the draft preview.
      const lastBoxNum =
        sec && sec.boxes && sec.boxes.length
          ? Math.max(...sec.boxes.map((b) => b.box_number || 0))
          : sec?.total_boxes ?? sec?.box_count ?? 0;
      const lotNumber = sec?.lot_number ?? "";
      const boxes: DraftBox[] = Array.from({ length: count }, (_, i) => ({
        box_number: lastBoxNum + i + 1,
        gross_weight: "",
        net_weight: "",
        lot_number: lotNumber,
        count: "",
      }));
      return { ...state, addBoxes: { ...state.addBoxes, [key]: { boxes } } };
    }

    case "setAddBoxField": {
      const { key, boxIndex, field, value, carton } = action;
      const panel = state.addBoxes[key];
      if (!panel) return state;
      const clamped = field === "gross_weight" || field === "net_weight" ? clamp3(value) : value;
      const boxes = panel.boxes.map((b, i) => {
        if (i !== boxIndex) return b;
        const next = { ...b, [field]: clamped };
        return field === "gross_weight" ? { ...next, net_weight: computeNet(clamped, carton) } : next;
      });
      return { ...state, addBoxes: { ...state.addBoxes, [key]: { boxes } } };
    }

    case "hydrateSectionBoxes": {
      // Seed the box-edit state for a lazily-loaded (expanded/paged) section from
      // the fetched DB boxes. Boxes already in the edit map keep their in-progress
      // edits (so paging away and back doesn't lose typed values).
      const { key, boxes } = action;
      const sec = state.existing[key];
      if (!sec) return state;
      const merged: Record<string, ExistingBoxEdit> = { ...sec.boxes };
      for (const b of boxes) {
        if (merged[b.box_id]) continue;
        merged[b.box_id] = {
          gross_weight: b.gross_weight != null ? String(b.gross_weight) : "",
          net_weight: b.net_weight != null ? String(b.net_weight) : "",
          lot_number: b.lot_number ?? "",
          count: b.count != null ? String(b.count) : "",
        };
      }
      return { ...state, existing: { ...state.existing, [key]: { ...sec, boxes: merged } } };
    }

    case "clearAddBoxes": {
      const next = { ...state.addBoxes };
      delete next[action.key];
      return { ...state, addBoxes: next };
    }

    default:
      return state;
  }
}

// ── Payload builders ──────────────────────────────────────────────────────────
function mintBase(nowMs: number): string {
  return String(nowMs).slice(-8);
}

// PUT /receive body (reference 1189-1234). Only carton-bearing lines included.
export function buildReceiveRequest(state: DraftState, po: PurchasePoDetail): ReceiveRequest {
  const header: Record<string, string | null> = {};
  for (const f of LOGISTICS_FIELDS) {
    const v = (state.header[f] ?? "").trim();
    header[f] = f === "system_grn_date" ? (v ? new Date(v).toISOString() : null) : v || null;
  }
  const lines = (po.lines ?? [])
    .map((l) => ({
      line_number: l.line_number,
      carton_weight: state.cartonByLine[l.line_number] ? parseFloat(state.cartonByLine[l.line_number]) : null,
    }))
    .filter((l) => l.carton_weight != null);
  return { header: header as ReceiveRequest["header"], lines };
}

// POST /boxes body — new sections (reference 1296-1391). box_number continues
// after existing boxes + prior new sections of the same line.
export function buildAddSections(state: DraftState, po: PurchasePoDetail, nowMs: number): AddSectionPayload[] {
  const base = mintBase(nowMs);
  let globalIdx = 0;
  const out: AddSectionPayload[] = [];
  for (const sec of state.newSections) {
    const boxCount = parseInt(sec.box_count, 10) || 0;
    if (boxCount < 1) continue;
    const line = po.lines.find((l) => l.line_number === sec.line_number);
    if (!line) continue;
    const existingCount = countExistingBoxes(line);
    let boxes;
    if (sec.boxes && sec.boxes.length) {
      boxes = sec.boxes.map((b) => {
        globalIdx++;
        return {
          box_id: `${base}-${globalIdx}`,
          box_number: b.box_number,
          net_weight: b.net_weight ? parseFloat(b.net_weight) : null,
          gross_weight: b.gross_weight ? parseFloat(b.gross_weight) : null,
          lot_number: b.lot_number || sec.lot_number || null,
          count: b.count ? parseInt(b.count, 10) : null,
        };
      });
    } else {
      // Not generated — expand into placeholder boxes numbered after existing +
      // prior new sections of this line (reference 1349-1366).
      const prevForLine = out
        .filter((s) => s.line_number === sec.line_number)
        .reduce((n, s) => n + s.boxes.length, 0);
      boxes = Array.from({ length: boxCount }, (_, i) => {
        globalIdx++;
        return {
          box_id: `${base}-${globalIdx}`,
          box_number: existingCount + prevForLine + i + 1,
          net_weight: null,
          gross_weight: null,
          lot_number: sec.lot_number || null,
          count: null,
        };
      });
    }
    out.push({
      line_number: sec.line_number,
      box_count: boxCount,
      lot_number: sec.lot_number || null,
      manufacturing_date: sec.mfg_date || null,
      expiry_date: sec.exp_date || null,
      boxes,
    });
  }
  return out;
}

// PUT /boxes body — edited existing sections (reference 1242-1294).
export function buildUpdateSections(state: DraftState, po: PurchasePoDetail): UpdateSectionPayload[] {
  const out: UpdateSectionPayload[] = [];
  for (const line of po.lines ?? []) {
    for (const sec of line.sections ?? []) {
      const key = existingKey(line.line_number, sec.section_number);
      const edit = state.existing[key];
      if (!edit) continue;
      // In lazy mode sec.boxes isn't loaded — build updates from the box-edit
      // state, which is hydrated per expanded/paged section. Only boxes the user
      // actually loaded are sent; untouched boxes stay unchanged server-side.
      const boxes = Object.entries(edit.boxes).map(([boxId, be]) => ({
        box_id: boxId,
        net_weight: be.net_weight ? parseFloat(be.net_weight) : null,
        gross_weight: be.gross_weight ? parseFloat(be.gross_weight) : null,
        lot_number: be.lot_number || null,
        count: be.count ? parseInt(be.count, 10) : null,
      }));
      out.push({
        line_number: line.line_number,
        section_number: sec.section_number,
        lot_number: edit.lot_number || null,
        manufacturing_date: edit.manufacturing_date || null,
        expiry_date: edit.expiry_date || null,
        boxes,
      });
    }
  }
  return out;
}

// POST /boxes body — append boxes to ONE existing section (reference 1051-1119).
export function buildAddBoxesPayload(
  state: DraftState,
  line: PurchaseLine,
  sectionNumber: number,
  nowMs: number,
): AddSectionPayload {
  const key = existingKey(line.line_number, sectionNumber);
  const boxes = state.addBoxes[key]?.boxes ?? [];
  const base = mintBase(nowMs);
  const sec = (line.sections ?? []).find((s) => s.section_number === sectionNumber);
  return {
    line_number: line.line_number,
    // Target the existing section so the backend appends (not create a new one).
    section_number: sectionNumber,
    box_count: boxes.length,
    lot_number: sec?.lot_number ?? null,
    manufacturing_date: sec?.manufacturing_date ?? null,
    expiry_date: sec?.expiry_date ?? null,
    boxes: boxes.map((b, i) => ({
      box_id: `${base}-${i + 1}`,
      box_number: b.box_number,
      net_weight: b.net_weight ? parseFloat(b.net_weight) : null,
      gross_weight: b.gross_weight ? parseFloat(b.gross_weight) : null,
      lot_number: b.lot_number || null,
      count: b.count ? parseInt(b.count, 10) : null,
    })),
  };
}

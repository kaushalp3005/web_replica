// Job Card Summary — aggregation. Pure functions only, no React, so the
// arithmetic can be reasoned about (and tested) without a DOM.
//
// Two shapes flow through here:
//   * JcRecord   — one per job card: the list row plus whatever the accounting
//                  detail added, with every quantity already converted to net kg.
//   * ConsLine   — one per consumption row, because the Consumption lens groups
//                  materials, not job cards.
//
// Every kg figure is NET (see lib/netKg.ts). Anything that could not be
// converted is counted in `notInKg` and never folded into a kg total, so a
// number on screen is either right or visibly incomplete — not quietly short.

import { toNetKg } from "@/lib/netKg";
import { categoryOf, packKgOf, type SkuCatalogue, UNMAPPED } from "@/lib/skuCatalog";
import { canonProcess } from "@/lib/processCatalog";
import { canonicalize } from "@/lib/dashboardUtils";
import { getDisplayWarehouseName, normalizeWarehouseName } from "@/lib/transferBuildSummary";
import type {
  JobCardRow, AccountingResponse, ConsumptionRow, ByproductRow,
} from "@/lib/jobcard-dashboard";
import { isOffgrade } from "@/lib/jobcard-dashboard";

export const NA = "—";

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isFinite(x) ? x : 0;
};

// ── records ───────────────────────────────────────────────────────────────

export interface ConsLine {
  jobCardId: number;
  material: string;
  kind: string;            // RM | SFG | WIP | PM
  category: string;
  issuedKg: number;
  consumedKg: number;
  returnKg: number;
  convertible: boolean;    // false → excluded from every kg total above
  uom: string;
  rawConsumed: number;
}

export interface ByproductLine {
  jobCardId: number;
  category: string;        // the 16-value CHECK vocabulary
  kg: number;
  convertible: boolean;
  material: string;
}

export interface JcRecord {
  id: number;
  number: string;
  planId: number | null;
  stepNumber: number | null;
  process: string;
  stage: string;
  outKind: string;
  inKind: string;
  status: string;
  locked: boolean;
  article: string;
  category: string;
  customer: string;
  factory: string;
  floor: string;
  entity: string;
  lead: string;
  batch: string;
  soNumbers: string[];
  planDate: string;        // ISO date or ""
  createdAt: string;
  month: string;           // YYYY-MM off the chosen basis
  timeMin: number;

  plannedKg: number;
  carriedInKg: number;
  dispatchedOutKg: number;

  // Present only once accounting has been hydrated for this JC.
  hydrated: boolean;
  inputKg: number;
  outputKg: number;
  consumedKg: number;
  offgradeKg: number;
  rejectionKg: number;
  wastageKg: number;
  controlKg: number;
  balanceMaterialKg: number;
  processLossKg: number;
  totalLossPct: number | null;
  balanceDiffKg: number;
  isBalanced: boolean;
  tolerancePct: number | null;
  notInKg: number;         // rows this JC could not convert

  cons: ConsLine[];
  byproducts: ByproductLine[];
}

const monthOf = (iso: string): string => (iso && iso.length >= 7 ? iso.slice(0, 7) : NA);

/** Fold one job card (+ its accounting, when hydrated) into a flat record.
 *
 *  `dateBasis` decides which date drives the Month dimension. It mirrors the
 *  server-side date_field so the grouping and the window agree. */
export function buildRecord(
  row: JobCardRow,
  acc: AccountingResponse | undefined,
  cat: SkuCatalogue | null,
  dateBasis: "plan_date" | "created_at" | "start_time" | "end_time",
): JcRecord {
  const planDate = String(row.plan_date ?? "").slice(0, 10);
  const created = String(row.created_at ?? "").slice(0, 10);
  const started = String(row.start_time ?? "").slice(0, 10);
  const ended = String(row.end_time ?? "").slice(0, 10);
  const basis =
    dateBasis === "plan_date" ? planDate
      : dateBasis === "start_time" ? started
        : dateBasis === "end_time" ? ended
          : created;

  const article = String(row.fg_sku_name ?? "").trim();
  // output_code is this JC's SFG seam code — the exact key when the article
  // name is a synthesised SFG label rather than a real particulars value.
  const seam = row.output_code || row.input_code || null;

  const rec: JcRecord = {
    id: row.job_card_id,
    number: String(row.job_card_number ?? `#${row.job_card_id}`),
    planId: row.plan_id ?? null,
    stepNumber: row.step_number ?? null,
    process: canonProcess(row.process_name) || String(row.process_name ?? "").trim() || NA,
    stage: String(row.stage ?? "").trim() || NA,
    outKind: String(row.output_kind ?? "").trim().toUpperCase() || NA,
    inKind: String(row.input_kind ?? "").trim().toUpperCase() || NA,
    status: String(row.status ?? "").trim() || NA,
    locked: !!row.is_locked,
    article: article || NA,
    category: article || seam ? categoryOf(cat, article, seam) : UNMAPPED,
    customer: canonicalize(row.customer_name) || NA,
    factory: getDisplayWarehouseName(normalizeWarehouseName(String(row.factory ?? ""))) || NA,
    floor: String(row.floor ?? "").trim() || NA,
    entity: String(row.entity ?? "").trim().toUpperCase() || NA,
    lead: String(row.assigned_to_team_leader ?? "").trim() || NA,
    batch: String(row.batch_number ?? "").trim() || NA,
    soNumbers: (row.so_numbers ?? []).filter(Boolean),
    planDate,
    createdAt: created,
    month: monthOf(basis),
    timeMin: n(row.total_time_min),

    plannedKg: n(row.planned_qty_kg),
    carriedInKg: n(row.carried_qty_kg),
    dispatchedOutKg: n(row.dispatched_to_next_kg),

    hydrated: false,
    inputKg: 0, outputKg: 0, consumedKg: 0,
    offgradeKg: 0, rejectionKg: 0, wastageKg: 0, controlKg: 0,
    balanceMaterialKg: 0, processLossKg: 0,
    totalLossPct: null, balanceDiffKg: 0, isBalanced: true, tolerancePct: null,
    notInKg: 0,
    cons: [], byproducts: [],
  };

  if (!acc) return rec;
  rec.hydrated = true;

  // Consumption lines. The material name is the join key, except for SFG lines
  // whose name is synthesised — those fall back to the JC's own seam code.
  for (const c of acc.consumption as ConsumptionRow[]) {
    const name = String(c.material_sku_name ?? "");
    const kind = String(c.input_kind ?? "").toUpperCase();
    const lineSeam = kind === "SFG" || kind === "WIP" ? seam : null;
    const pack = packKgOf(cat, name, lineSeam);
    const consumed = toNetKg(c.actual_consumed_qty, c.uom, pack);
    const issued = toNetKg(c.issued_qty, c.uom, pack);
    const ret = toNetKg(c.return_qty, c.uom, pack);

    rec.cons.push({
      jobCardId: rec.id,
      material: name || NA,
      kind: kind || NA,
      category: categoryOf(cat, name, lineSeam),
      issuedKg: issued.ok ? issued.kg : 0,
      consumedKg: consumed.ok ? consumed.kg : 0,
      returnKg: ret.ok ? ret.kg : 0,
      convertible: consumed.ok,
      uom: String(c.uom ?? NA),
      rawConsumed: n(c.actual_consumed_qty),
    });

    if (consumed.ok) rec.consumedKg += consumed.kg;
    else rec.notInKg++;
  }

  // Byproducts. Category drives the off-grade split; quantity is `quantity`
  // here, NOT qty_kg (that alias belongs to the JC detail endpoint).
  for (const b of acc.byproducts as ByproductRow[]) {
    const category = String(b.category ?? "").trim().toLowerCase();
    const name = String(b.material_name ?? "");
    const conv = toNetKg(b.quantity, b.uom, packKgOf(cat, name, seam));
    rec.byproducts.push({
      jobCardId: rec.id,
      category: category || NA,
      kg: conv.ok ? conv.kg : 0,
      convertible: conv.ok,
      material: name || NA,
    });
    if (!conv.ok) rec.notInKg++;
  }

  const a = acc.accounting;
  if (a) {
    // The summary row is already stored in kg for the qty columns the schema
    // defines as kg; input/output carry their own uom, so convert those.
    const inp = toNetKg(a.total_input_qty, a.input_uom, 0);
    const out = toNetKg(a.output_qty, a.output_uom ?? a.input_uom, 0);
    rec.inputKg = inp.ok ? inp.kg : 0;
    rec.outputKg = out.ok ? out.kg : 0;
    if (!inp.ok) rec.notInKg++;
    if (!out.ok) rec.notInKg++;

    rec.offgradeKg = n(a.offgrade_total_qty);
    rec.rejectionKg = n(a.rejection_qty);
    rec.wastageKg = n(a.wastage_qty);
    rec.controlKg = n(a.control_sample_qty);
    rec.balanceMaterialKg = n(a.balance_material_qty);
    rec.processLossKg = n(a.process_loss_qty);
    rec.balanceDiffKg = n(a.balance_difference_qty);
    rec.isBalanced = a.is_balanced !== false;
    rec.totalLossPct = a.total_loss_pct == null ? null : n(a.total_loss_pct);
    rec.tolerancePct = a.allowed_balance_tolerance_pct ?? null;
  } else {
    // No summary row saved yet. Fall back to the byproduct rows so the
    // off-grade columns are not blank for a JC that has recorded output.
    for (const b of rec.byproducts) {
      if (!b.convertible) continue;
      if (b.category === "rejection") rec.rejectionKg += b.kg;
      else if (b.category === "wastage") rec.wastageKg += b.kg;
      else if (b.category === "control_sample") rec.controlKg += b.kg;
      else if (b.category === "balance_material") rec.balanceMaterialKg += b.kg;
      if (isOffgrade(b.category)) rec.offgradeKg += b.kg;
    }
  }

  return rec;
}

// ── metrics ───────────────────────────────────────────────────────────────

export interface Metrics {
  jcs: number;
  hydrated: number;
  plannedKg: number;
  inputKg: number;
  outputKg: number;
  consumedKg: number;
  offgradeKg: number;
  rejectionKg: number;
  wastageKg: number;
  controlKg: number;
  balanceMaterialKg: number;
  processLossKg: number;
  balanceDiffKg: number;
  notInKg: number;
  unbalanced: number;
  completed: number;
  inProgress: number;
  locked: number;
  timeMin: number;
}

export const zeroMetrics = (): Metrics => ({
  jcs: 0, hydrated: 0, plannedKg: 0, inputKg: 0, outputKg: 0, consumedKg: 0,
  offgradeKg: 0, rejectionKg: 0, wastageKg: 0, controlKg: 0,
  balanceMaterialKg: 0, processLossKg: 0, balanceDiffKg: 0,
  notInKg: 0, unbalanced: 0, completed: 0, inProgress: 0, locked: 0, timeMin: 0,
});

export function addRecord(m: Metrics, r: JcRecord): void {
  m.jcs++;
  if (r.hydrated) m.hydrated++;
  m.plannedKg += r.plannedKg;
  m.inputKg += r.inputKg;
  m.outputKg += r.outputKg;
  m.consumedKg += r.consumedKg;
  m.offgradeKg += r.offgradeKg;
  m.rejectionKg += r.rejectionKg;
  m.wastageKg += r.wastageKg;
  m.controlKg += r.controlKg;
  m.balanceMaterialKg += r.balanceMaterialKg;
  m.processLossKg += r.processLossKg;
  m.balanceDiffKg += Math.abs(r.balanceDiffKg);
  m.notInKg += r.notInKg;
  if (r.hydrated && !r.isBalanced) m.unbalanced++;
  const s = r.status.toLowerCase();
  if (s === "completed" || s === "closed") m.completed++;
  else if (s === "in_progress") m.inProgress++;
  if (r.locked) m.locked++;
  m.timeMin += r.timeMin;
}

/** Yield = output ÷ input. Null rather than 0 when there is no input to divide
 *  by — a blank reads as "unknown", a 0% reads as "everything was lost". */
export const yieldPct = (m: Metrics): number | null =>
  m.inputKg > 0 ? (m.outputKg / m.inputKg) * 100 : null;

export const lossPct = (m: Metrics): number | null =>
  m.inputKg > 0 ? ((m.inputKg - m.outputKg) / m.inputKg) * 100 : null;

// ── dimensions ────────────────────────────────────────────────────────────

export type Dim =
  | "process" | "stage" | "outKind" | "status" | "category" | "factory" | "floor"
  | "lead" | "customer" | "month" | "entity" | "article" | "so" | "batch";

export const DIM_LABELS: Record<Dim, string> = {
  process: "Process", stage: "Stage", outKind: "Output kind", status: "Status",
  category: "Category", factory: "Factory", floor: "Floor", lead: "Team leader",
  customer: "Customer", month: "Month", entity: "Entity", article: "Article",
  so: "Sales order", batch: "Batch",
};

/** A group-by choice is the first level of a chain, not the only level. */
export const JC_CHAIN: Record<Dim, Dim[]> = {
  process: ["process", "article", "customer"],
  stage: ["stage", "process", "article"],
  outKind: ["outKind", "process", "article"],
  status: ["status", "factory", "article"],
  category: ["category", "article", "customer"],
  factory: ["factory", "floor", "process"],
  floor: ["floor", "process", "article"],
  lead: ["lead", "floor", "article"],
  customer: ["customer", "so", "article"],
  month: ["month", "factory", "article"],
  entity: ["entity", "factory", "article"],
  article: ["article", "process", "customer"],
  so: ["so", "article", "process"],
  batch: ["batch", "process", "article"],
};

/** Values of `dim` for one record. Almost always one — `so` is the exception,
 *  because a plan line can fulfil several sales orders. */
export function dimValues(r: JcRecord, d: Dim): string[] {
  switch (d) {
    case "process": return [r.process];
    case "stage": return [r.stage];
    case "outKind": return [r.outKind];
    case "status": return [r.status];
    case "category": return [r.category];
    case "factory": return [r.factory];
    case "floor": return [r.floor];
    case "lead": return [r.lead];
    case "customer": return [r.customer];
    case "month": return [r.month];
    case "entity": return [r.entity];
    case "article": return [r.article];
    case "batch": return [r.batch];
    case "so": return r.soNumbers.length ? r.soNumbers : [NA];
  }
}

/** True when grouping by `d` can place one job card under several parents, so
 *  the column totals legitimately exceed the overall total. The UI says so
 *  rather than letting the numbers look broken. */
export const dimFansOut = (d: Dim): boolean => d === "so";

// ── drill tree ────────────────────────────────────────────────────────────

export interface Node {
  key: string;          // full path, e.g. "Sorting›Cashew W320›DMart"
  label: string;
  depth: number;
  m: Metrics;
  ids: number[];        // job card ids under this node
  children: Node[];
}

export type SortKey =
  | "outputKg" | "inputKg" | "consumedKg" | "plannedKg" | "jcs"
  | "offgradeKg" | "lossPct" | "yieldPct" | "unbalanced" | "name" | "timeMin";

function metricValue(node: Node, k: SortKey): number {
  switch (k) {
    case "name": return 0;
    case "lossPct": return lossPct(node.m) ?? -1;
    case "yieldPct": return yieldPct(node.m) ?? -1;
    default: return node.m[k as keyof Metrics] as number;
  }
}

export function sortNodes(nodes: Node[], key: SortKey, dir: "asc" | "desc"): Node[] {
  const s = [...nodes].sort((a, b) => {
    if (key === "name") return a.label.localeCompare(b.label);
    return metricValue(b, key) - metricValue(a, key);
  });
  if (dir === "asc") s.reverse();
  for (const nd of s) nd.children = sortNodes(nd.children, key, dir);
  return s;
}

/** Build the drill tree. Each level groups whatever landed in its parent, so a
 *  record that fans out at one level is not re-counted at the next. */
export function buildTree(
  records: JcRecord[],
  chain: Dim[],
  sortKey: SortKey,
  sortDir: "asc" | "desc",
): Node[] {
  const level = (rows: JcRecord[], depth: number, prefix: string): Node[] => {
    if (depth >= chain.length) return [];
    const d = chain[depth];
    const buckets = new Map<string, JcRecord[]>();
    for (const r of rows) {
      for (const v of dimValues(r, d)) {
        const label = v || NA;
        const arr = buckets.get(label);
        if (arr) arr.push(r);
        else buckets.set(label, [r]);
      }
    }
    const out: Node[] = [];
    for (const [label, rs] of buckets) {
      const m = zeroMetrics();
      for (const r of rs) addRecord(m, r);
      const key = prefix ? `${prefix}›${label}` : label;
      out.push({
        key, label, depth, m,
        ids: rs.map((r) => r.id),
        children: level(rs, depth + 1, key),
      });
    }
    return out;
  };
  return sortNodes(level(records, 0, ""), sortKey, sortDir);
}

// ── pivot ─────────────────────────────────────────────────────────────────

export interface Pivot {
  rows: string[];
  cols: string[];
  cells: Map<string, Metrics>;   // key: `${row} ${col}`
  rowTotals: Map<string, Metrics>;
  colTotals: Map<string, Metrics>;
  grand: Metrics;
  droppedCols: number;           // columns beyond the cap — stated, never hidden
}

export const PIVOT_COL_CAP = 14;

export function buildPivot(
  records: JcRecord[],
  rowDim: Dim,
  colDim: Dim,
  measure: SortKey,
): Pivot {
  const cells = new Map<string, Metrics>();
  const rowTotals = new Map<string, Metrics>();
  const colTotals = new Map<string, Metrics>();
  const grand = zeroMetrics();

  const bump = (map: Map<string, Metrics>, k: string, r: JcRecord) => {
    let m = map.get(k);
    if (!m) { m = zeroMetrics(); map.set(k, m); }
    addRecord(m, r);
  };

  for (const r of records) {
    for (const rv of dimValues(r, rowDim)) {
      for (const cv of dimValues(r, colDim)) {
        bump(cells, `${rv} ${cv}`, r);
        bump(colTotals, cv, r);
      }
      bump(rowTotals, rv, r);
    }
    addRecord(grand, r);
  }

  const rank = (m: Metrics) =>
    measure === "name" ? 0
      : measure === "lossPct" ? (lossPct(m) ?? -1)
        : measure === "yieldPct" ? (yieldPct(m) ?? -1)
          : (m[measure as keyof Metrics] as number);

  const rows = [...rowTotals.keys()].sort((a, b) =>
    measure === "name" ? a.localeCompare(b) : rank(rowTotals.get(b)!) - rank(rowTotals.get(a)!));
  const allCols = [...colTotals.keys()].sort((a, b) =>
    measure === "name" ? a.localeCompare(b) : rank(colTotals.get(b)!) - rank(colTotals.get(a)!));

  const cols = allCols.slice(0, PIVOT_COL_CAP);
  return { rows, cols, cells, rowTotals, colTotals, grand, droppedCols: allCols.length - cols.length };
}

// ── consumption + byproduct roll-ups ──────────────────────────────────────

export interface MaterialRoll {
  material: string;
  kind: string;
  category: string;
  issuedKg: number;
  consumedKg: number;
  returnKg: number;
  lines: number;
  jcs: number;
  notInKg: number;
}

export function rollMaterials(records: JcRecord[]): MaterialRoll[] {
  const map = new Map<string, MaterialRoll & { seen: Set<number> }>();
  for (const r of records) {
    for (const c of r.cons) {
      const k = `${c.material} ${c.kind}`;
      let e = map.get(k);
      if (!e) {
        e = {
          material: c.material, kind: c.kind, category: c.category,
          issuedKg: 0, consumedKg: 0, returnKg: 0, lines: 0, jcs: 0, notInKg: 0,
          seen: new Set<number>(),
        };
        map.set(k, e);
      }
      e.issuedKg += c.issuedKg;
      e.consumedKg += c.consumedKg;
      e.returnKg += c.returnKg;
      e.lines++;
      if (!c.convertible) e.notInKg++;
      e.seen.add(c.jobCardId);
    }
  }
  return [...map.values()]
    .map(({ seen, ...rest }) => ({ ...rest, jcs: seen.size }))
    .sort((a, b) => b.consumedKg - a.consumedKg);
}

export interface CategoryRoll {
  category: string;
  kg: number;
  lines: number;
  offgrade: boolean;
  notInKg: number;
}

export function rollByproducts(records: JcRecord[]): CategoryRoll[] {
  const map = new Map<string, CategoryRoll>();
  for (const r of records) {
    for (const b of r.byproducts) {
      let e = map.get(b.category);
      if (!e) {
        e = { category: b.category, kg: 0, lines: 0, offgrade: isOffgrade(b.category), notInKg: 0 };
        map.set(b.category, e);
      }
      e.kg += b.kg;
      e.lines++;
      if (!b.convertible) e.notInKg++;
    }
  }
  return [...map.values()].sort((a, b) => b.kg - a.kg);
}

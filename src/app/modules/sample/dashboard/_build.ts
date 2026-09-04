// Sample Summary — aggregation. Pure functions only, no React.
//
// A requisition's articles only arrive on the detail GET, so the list gives
// pipeline and ageing while hydration adds the quantities. Everything that can
// be answered without articles is answered without them, so the page is useful
// before hydration finishes rather than blank until it does.
//
// Every kg figure is NET (lib/netKg.ts). Article lines carry their own uom and
// a pack_size_kg of their own, which is preferred over the SKU master because
// it is what the requisition was actually raised against.

import { toNetKg } from "@/lib/netKg";
import { categoryOf, packKgOf, type SkuCatalogue, UNMAPPED } from "@/lib/skuCatalog";
import { canonicalize } from "@/lib/dashboardUtils";
import type { Requisition, Article } from "@/lib/sample";

export const NA = "—";

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isFinite(x) ? x : 0;
};

/** Statuses that mean the request is still moving. Anything else is settled,
 *  and ageing stops mattering. */
const OPEN_STATUSES = new Set([
  "DRAFT", "SUBMITTED", "BH_APPROVED", "ON_HOLD",
  "IN_PRODUCTION", "PACKING", "READY_FOR_DISPATCH", "PARTIALLY_CONVERTED",
]);

/** Settled successfully — used to separate "finished" from "killed". */
const DONE_STATUSES = new Set([
  "INTERNALLY_DISPATCHED", "GATE_PASS_ISSUED", "CLOSED",
]);

const DEAD_STATUSES = new Set(["BH_REJECTED", "CANCELLED"]);

export interface ArticleLine {
  reqId: number;
  sku: string;
  role: string;             // RM | FG | NPD_INPUT | NPD_OUTPUT
  category: string;
  requiredKg: number;
  issuedKg: number;
  convertible: boolean;
  uom: string;
}

export interface ReqRecord {
  id: number;
  handle: string;           // request_id when present, else #id
  type: string;             // BASIS_RM | BASIS_FG | NPD | INTERNAL | TRIAL
  status: string;
  open: boolean;
  done: boolean;
  dead: boolean;
  warehouse: string;
  requestor: string;
  salesPoc: string;
  purpose: string;
  customer: string;
  company: string;
  createdAt: string;        // ISO date
  updatedAt: string;
  month: string;            // YYYY-MM
  ageDays: number;          // open → days since created; settled → 0
  holdDays: number;
  expectedDispatch: string;
  confirmedDispatch: string;
  lateDays: number;         // confirmed later than expected, else 0

  // Billing checklist (NPD / TRIAL).
  returnable: boolean;
  nonReturnable: boolean;
  paid: boolean;
  amount: number;
  billingSet: boolean;      // returnable XOR non_returnable actually chosen

  // NPD / conversion chain.
  isNpd: boolean;
  linkedDevJc: number | null;
  linkedJobCard: number | null;
  linkedGatePass: number | null;
  convertedFrom: number | null;
  convertedToExternal: boolean;
  npdTargets: number;
  targetKg: number;

  hydrated: boolean;
  articles: ArticleLine[];
  requiredKg: number;
  issuedKg: number;
  notInKg: number;
  lines: number;
}

const dayMs = 86_400_000;
const daysBetween = (from: string, to: number): number => {
  if (!from) return 0;
  const t = Date.parse(from);
  if (!isFinite(t)) return 0;
  return Math.max(0, Math.floor((to - t) / dayMs));
};

/** `now` is passed in rather than read from the clock so the same input always
 *  produces the same output — ageing stays testable. */
export function buildReq(
  r: Requisition,
  detail: Requisition | undefined,
  cat: SkuCatalogue | null,
  now: number,
): ReqRecord {
  const status = String(r.status ?? "").toUpperCase();
  const created = String(r.created_at ?? "").slice(0, 10);
  const open = OPEN_STATUSES.has(status);
  const expected = String(r.expected_dispatch_date ?? "").slice(0, 10);
  const confirmed = String(r.confirmed_dispatch_date ?? "").slice(0, 10);

  const rec: ReqRecord = {
    id: r.id,
    handle: r.request_id ? String(r.request_id) : `#${r.id}`,
    type: String(r.sample_type ?? "").toUpperCase() || NA,
    status: status || NA,
    open,
    done: DONE_STATUSES.has(status),
    dead: DEAD_STATUSES.has(status),
    warehouse: String(r.warehouse ?? "").trim() || NA,
    requestor: String(r.requestor_team ?? "").trim() || NA,
    salesPoc: String(r.sales_poc_name ?? "").trim() || NA,
    purpose: String(r.purpose_tag ?? "").trim() || NA,
    customer: canonicalize(r.customer_name) || NA,
    company: canonicalize(r.company_name) || NA,
    createdAt: created,
    updatedAt: String(r.updated_at ?? "").slice(0, 10),
    month: created.length >= 7 ? created.slice(0, 7) : NA,
    // Ageing is only meaningful while the request is still moving; a closed
    // request is not "300 days old", it is finished.
    ageDays: open ? daysBetween(created, now) : 0,
    holdDays: status === "ON_HOLD" ? daysBetween(String(r.hold_start_date ?? "").slice(0, 10), now) : 0,
    expectedDispatch: expected,
    confirmedDispatch: confirmed,
    lateDays:
      expected && confirmed && confirmed > expected
        ? Math.max(0, Math.floor((Date.parse(confirmed) - Date.parse(expected)) / dayMs))
        : 0,

    returnable: r.returnable === true,
    nonReturnable: r.non_returnable === true,
    paid: r.paid === true,
    amount: n(r.amount),
    billingSet: r.returnable === true || r.non_returnable === true,

    isNpd: status !== "" && (r.sample_type === "NPD" || r.sample_type === "TRIAL"),
    linkedDevJc: r.linked_dev_jc_id ?? null,
    linkedJobCard: r.linked_job_card_id ?? null,
    linkedGatePass: r.linked_gate_pass_id ?? null,
    convertedFrom: r.converted_from_id ?? null,
    convertedToExternal: r.converted_to_external === true,
    npdTargets: 0,
    targetKg: n(r.quantity),

    hydrated: false,
    articles: [],
    requiredKg: 0,
    issuedKg: 0,
    notInKg: 0,
    lines: 0,
  };

  const d = detail;
  if (!d) return rec;
  rec.hydrated = true;
  rec.npdTargets = (d.npd_targets ?? []).length;
  if (d.npd_targets?.length) {
    rec.targetKg = d.npd_targets.reduce((s, t) => s + n(t.quantity), 0) || rec.targetKg;
  }

  for (const a of (d.articles ?? []) as Article[]) {
    const sku = String(a.sku_name ?? "").trim();
    // The line's own pack_size_kg wins: it is what this requisition was raised
    // against, and the master may have moved since.
    const pack = n(a.pack_size_kg) || packKgOf(cat, sku);
    const req = toNetKg(a.required_qty, a.uom, pack);
    const iss = toNetKg(a.issued_qty ?? 0, a.uom, pack);

    rec.articles.push({
      reqId: rec.id,
      sku: sku || NA,
      role: String(a.article_role ?? "").toUpperCase() || NA,
      category: sku ? categoryOf(cat, sku) : UNMAPPED,
      requiredKg: req.ok ? req.kg : 0,
      issuedKg: iss.ok ? iss.kg : 0,
      convertible: req.ok,
      uom: String(a.uom ?? NA),
    });

    rec.lines++;
    if (req.ok) rec.requiredKg += req.kg; else rec.notInKg++;
    if (iss.ok) rec.issuedKg += iss.kg;
  }

  return rec;
}

// ── metrics ───────────────────────────────────────────────────────────────

export interface Metrics {
  reqs: number;
  hydrated: number;
  open: number;
  done: number;
  dead: number;
  onHold: number;
  requiredKg: number;
  issuedKg: number;
  lines: number;
  notInKg: number;
  ageSum: number;          // over open requests only
  ageCount: number;
  aged7: number;           // open longer than a week
  aged30: number;
  lateCount: number;
  lateDaysSum: number;
  amount: number;
  paidCount: number;
  returnableCount: number;
  nonReturnableCount: number;
  billingMissing: number;
  npd: number;
  withDevJc: number;
  converted: number;
}

export const zeroMetrics = (): Metrics => ({
  reqs: 0, hydrated: 0, open: 0, done: 0, dead: 0, onHold: 0,
  requiredKg: 0, issuedKg: 0, lines: 0, notInKg: 0,
  ageSum: 0, ageCount: 0, aged7: 0, aged30: 0,
  lateCount: 0, lateDaysSum: 0,
  amount: 0, paidCount: 0, returnableCount: 0, nonReturnableCount: 0, billingMissing: 0,
  npd: 0, withDevJc: 0, converted: 0,
});

export function addReq(m: Metrics, r: ReqRecord): void {
  m.reqs++;
  if (r.hydrated) m.hydrated++;
  if (r.open) m.open++;
  if (r.done) m.done++;
  if (r.dead) m.dead++;
  if (r.status === "ON_HOLD") m.onHold++;
  m.requiredKg += r.requiredKg;
  m.issuedKg += r.issuedKg;
  m.lines += r.lines;
  m.notInKg += r.notInKg;
  if (r.open) {
    m.ageSum += r.ageDays;
    m.ageCount++;
    if (r.ageDays > 7) m.aged7++;
    if (r.ageDays > 30) m.aged30++;
  }
  if (r.lateDays > 0) { m.lateCount++; m.lateDaysSum += r.lateDays; }
  m.amount += r.amount;
  if (r.paid) m.paidCount++;
  if (r.returnable) m.returnableCount++;
  if (r.nonReturnable) m.nonReturnableCount++;
  if (r.isNpd && !r.billingSet) m.billingMissing++;
  if (r.isNpd) m.npd++;
  if (r.linkedDevJc) m.withDevJc++;
  if (r.convertedToExternal || r.convertedFrom) m.converted++;
}

/** Issued ÷ required. Null when nothing was requested, so a blank means
 *  "nothing to fulfil" rather than "fulfilled nothing". */
export const fulfilPct = (m: Metrics): number | null =>
  m.requiredKg > 0 ? (m.issuedKg / m.requiredKg) * 100 : null;

export const avgAge = (m: Metrics): number | null =>
  m.ageCount > 0 ? m.ageSum / m.ageCount : null;

// ── dimensions ────────────────────────────────────────────────────────────

export type Dim =
  | "status" | "type" | "warehouse" | "requestor" | "purpose" | "customer"
  | "company" | "month" | "salesPoc" | "ageBand";

export const DIM_LABELS: Record<Dim, string> = {
  status: "Status", type: "Sample type", warehouse: "Warehouse",
  requestor: "Requestor", purpose: "Purpose", customer: "Customer",
  company: "Company", month: "Month", salesPoc: "Sales POC", ageBand: "Age band",
};

export const SAMPLE_CHAIN: Record<Dim, Dim[]> = {
  status: ["status", "type", "requestor"],
  type: ["type", "status", "purpose"],
  warehouse: ["warehouse", "type", "status"],
  requestor: ["requestor", "type", "customer"],
  purpose: ["purpose", "type", "customer"],
  customer: ["customer", "type", "purpose"],
  company: ["company", "customer", "type"],
  month: ["month", "type", "status"],
  salesPoc: ["salesPoc", "customer", "type"],
  ageBand: ["ageBand", "status", "type"],
};

const ageBand = (r: ReqRecord): string => {
  if (!r.open) return "Settled";
  if (r.ageDays > 30) return "Over 30 days";
  if (r.ageDays > 14) return "15–30 days";
  if (r.ageDays > 7) return "8–14 days";
  return "0–7 days";
};

export function dimValue(r: ReqRecord, d: Dim): string {
  switch (d) {
    case "status": return r.status;
    case "type": return r.type;
    case "warehouse": return r.warehouse;
    case "requestor": return r.requestor;
    case "purpose": return r.purpose;
    case "customer": return r.customer;
    case "company": return r.company;
    case "month": return r.month;
    case "salesPoc": return r.salesPoc;
    case "ageBand": return ageBand(r);
  }
}

// ── drill tree ────────────────────────────────────────────────────────────

export interface Node {
  key: string;
  label: string;
  depth: number;
  m: Metrics;
  ids: number[];
  children: Node[];
}

export type SortKey =
  | "reqs" | "open" | "requiredKg" | "issuedKg" | "fulfilPct"
  | "avgAge" | "aged30" | "amount" | "lines" | "name";

function rank(m: Metrics, k: SortKey): number {
  switch (k) {
    case "name": return 0;
    case "fulfilPct": return fulfilPct(m) ?? -1;
    case "avgAge": return avgAge(m) ?? -1;
    default: return m[k as keyof Metrics] as number;
  }
}

export function sortNodes(nodes: Node[], key: SortKey, dir: "asc" | "desc"): Node[] {
  const s = [...nodes].sort((a, b) =>
    key === "name" ? a.label.localeCompare(b.label) : rank(b.m, key) - rank(a.m, key));
  if (dir === "asc") s.reverse();
  for (const nd of s) nd.children = sortNodes(nd.children, key, dir);
  return s;
}

export function buildTree(
  records: ReqRecord[],
  chain: Dim[],
  sortKey: SortKey,
  sortDir: "asc" | "desc",
): Node[] {
  const level = (rows: ReqRecord[], depth: number, prefix: string): Node[] => {
    if (depth >= chain.length) return [];
    const d = chain[depth];
    const buckets = new Map<string, ReqRecord[]>();
    for (const r of rows) {
      const label = dimValue(r, d) || NA;
      const arr = buckets.get(label);
      if (arr) arr.push(r); else buckets.set(label, [r]);
    }
    const out: Node[] = [];
    for (const [label, rs] of buckets) {
      const m = zeroMetrics();
      for (const r of rs) addReq(m, r);
      const key = prefix ? `${prefix}›${label}` : label;
      out.push({ key, label, depth, m, ids: rs.map((r) => r.id), children: level(rs, depth + 1, key) });
    }
    return out;
  };
  return sortNodes(level(records, 0, ""), sortKey, sortDir);
}

// ── pivot ─────────────────────────────────────────────────────────────────

export const PIVOT_COL_CAP = 14;

export interface Pivot {
  rows: string[];
  cols: string[];
  cells: Map<string, Metrics>;
  rowTotals: Map<string, Metrics>;
  colTotals: Map<string, Metrics>;
  grand: Metrics;
  droppedCols: number;
}

export function buildPivot(records: ReqRecord[], rowDim: Dim, colDim: Dim, measure: SortKey): Pivot {
  const cells = new Map<string, Metrics>();
  const rowTotals = new Map<string, Metrics>();
  const colTotals = new Map<string, Metrics>();
  const grand = zeroMetrics();

  const bump = (map: Map<string, Metrics>, k: string, r: ReqRecord) => {
    let m = map.get(k);
    if (!m) { m = zeroMetrics(); map.set(k, m); }
    addReq(m, r);
  };

  for (const r of records) {
    const rv = dimValue(r, rowDim) || NA;
    const cv = dimValue(r, colDim) || NA;
    bump(cells, `${rv} ${cv}`, r);
    bump(rowTotals, rv, r);
    bump(colTotals, cv, r);
    addReq(grand, r);
  }

  const rows = [...rowTotals.keys()].sort((a, b) =>
    measure === "name" ? a.localeCompare(b) : rank(rowTotals.get(b)!, measure) - rank(rowTotals.get(a)!, measure));
  const allCols = [...colTotals.keys()].sort((a, b) =>
    measure === "name" ? a.localeCompare(b) : rank(colTotals.get(b)!, measure) - rank(colTotals.get(a)!, measure));

  const cols = allCols.slice(0, PIVOT_COL_CAP);
  return { rows, cols, cells, rowTotals, colTotals, grand, droppedCols: allCols.length - cols.length };
}

// ── article roll-up ───────────────────────────────────────────────────────

export interface ArticleRoll {
  sku: string;
  role: string;
  category: string;
  requiredKg: number;
  issuedKg: number;
  lines: number;
  reqs: number;
  notInKg: number;
}

export function rollArticles(records: ReqRecord[]): ArticleRoll[] {
  const map = new Map<string, ArticleRoll & { seen: Set<number> }>();
  for (const r of records) {
    for (const a of r.articles) {
      const k = `${a.sku}|${a.role}`;
      let e = map.get(k);
      if (!e) {
        e = {
          sku: a.sku, role: a.role, category: a.category,
          requiredKg: 0, issuedKg: 0, lines: 0, reqs: 0, notInKg: 0,
          seen: new Set<number>(),
        };
        map.set(k, e);
      }
      e.requiredKg += a.requiredKg;
      e.issuedKg += a.issuedKg;
      e.lines++;
      if (!a.convertible) e.notInKg++;
      e.seen.add(a.reqId);
    }
  }
  return [...map.values()]
    .map(({ seen, ...rest }) => ({ ...rest, reqs: seen.size }))
    .sort((a, b) => b.requiredKg - a.requiredKg);
}

// Job Card dashboard client: the list walk plus the per-JC accounting detail.
//
// Types here mirror what the API actually emits, which is not always what the
// neighbouring job-card detail page expects — see the ByproductRow note below.
// Cost-bearing fields are deliberately absent: the server strips them per role
// (strip_cost_fields), and the dashboard reports no currency at all, so there
// is nothing here that could render a blank where a number belongs.

import { apiFetch, readApiErrorMessage } from "./auth";

// ── list ──────────────────────────────────────────────────────────────────

export interface JcListParams {
  entity?: string;
  factory?: string;
  floor?: string;
  status?: string;          // comma-separated
  plan_id?: number;
  so_number?: string;       // ILIKE
  machine_id?: number;
  customer?: string;        // comma-separated
  search?: string;
  /** plan_date resolves through production_plan_v2 and matches the sort_by
   *  default, so a window and the ordering agree on what "plan date" means. */
  date_field?: "created_at" | "start_time" | "end_time" | "plan_date";
  date_from?: string;       // ISO date
  date_to?: string;         // ISO date
  pendency?: "overdue" | "due_today" | "due_this_week" | "future" | "pending_signoff";
  sort_by?: string;
  sort_order?: "ASC" | "DESC";
  page?: number;
  page_size?: number;
}

export interface JobCardRow {
  job_card_id: number;
  job_card_number?: string | null;
  plan_id?: number | null;
  plan_line_id?: number | null;
  plan_step_id?: number | null;
  step_number?: number | null;
  process_name?: string | null;
  stage?: string | null;
  fg_sku_name?: string | null;
  customer_name?: string | null;
  batch_number?: string | null;
  planned_qty_kg?: number | string | null;
  planned_qty_units?: number | string | null;
  uom?: string | null;
  input_kind?: string | null;
  output_kind?: string | null;
  /** SFG#### seam codes — the exact join key back to all_sku.sfg_code. */
  input_code?: string | null;
  output_code?: string | null;
  factory?: string | null;
  floor?: string | null;
  entity?: string | null;
  assigned_to_team_leader?: string | null;
  team_members?: string[] | null;
  is_locked?: boolean | null;
  locked_reason?: string | null;
  status?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  total_time_min?: number | null;
  prev_job_card_id?: number | null;
  next_job_card_id?: number | null;
  carried_qty_kg?: number | string | null;
  dispatched_to_next_kg?: number | string | null;
  created_at?: string | null;
  plan_date?: string | null;      // subquery from production_plan_v2
  so_numbers?: string[] | null;   // a plan line can fulfil several SOs
}

export interface JcCounters {
  total: number;
  locked: number;
  in_progress: number;
  completed: number;
  pending_issuance: number;
  overdue: number;
}

const MAX_PAGE_SIZE = 500;   // server: page_size = Query(100, ge=1, le=500)

/** Walk every page of the window.
 *
 *  `counters` comes from page 1 only — the server computes it over the whole
 *  filtered set, not the page, so re-reading it per page would be waste.
 *  `capped` means the guard rail tripped and the rows are a prefix, not the
 *  whole window; anything totalling over them is understated and must say so. */
export async function listAllJobCards(
  p: JcListParams,
  opts: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<{ rows: JobCardRow[]; counters: JcCounters | null; capped: boolean }> {
  const rows: JobCardRow[] = [];
  let counters: JcCounters | null = null;
  const maxPages = opts.maxPages ?? 20;   // 10,000-row ceiling

  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...p, page, page_size: MAX_PAGE_SIZE })) {
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    }

    const res = await apiFetch(`/api/v1/production/job-cards-v2?${q}`, { signal: opts.signal });
    if (!res.ok) throw new Error(await readApiErrorMessage(res, `Job cards HTTP ${res.status}`));
    const body = (await res.json()) as {
      results?: JobCardRow[];
      counters?: JcCounters;
      pagination?: { total_pages?: number };
      error?: string;
      message?: string;
    };

    // The service validates sort_by / date_field / pendency against allow-lists
    // and reports a rejection in the 200 body rather than as a status code.
    if (body.error) throw new Error(body.message || body.error);

    rows.push(...(body.results ?? []));
    if (page === 1) counters = body.counters ?? null;

    const totalPages = body.pagination?.total_pages ?? 1;
    if (page >= totalPages) return { rows, counters, capped: false };
  }
  return { rows, counters, capped: true };
}

// ── accounting ────────────────────────────────────────────────────────────

export interface ConsumptionRow {
  consumption_id: number;
  job_card_id: number;
  material_sku_name: string;
  input_kind: "RM" | "SFG" | "WIP" | "PM";
  uom: string;
  issued_qty: number | string;
  actual_consumed_qty: number | string;
  return_qty: number | string;
  variance?: number | string | null;
  source_rm_indent_id?: number | null;
  source_dispatch_id?: number | null;
  remarks?: string | null;
  recorded_by?: string | null;
  recorded_at?: string | null;
  bom_line_id?: number | null;
  batch_id?: number | null;
}

export interface VarianceRow {
  material_sku_name: string;
  bom_prescribed_qty: number | string;
  actual_consumed_qty: number | string;
  variance_qty: number | string;
  variance_pct: number | string;
  uom: string;
  bom_version?: string | null;
  last_updated_at?: string | null;
}

/** The quantity key is `quantity`, NOT `qty_kg`.
 *
 *  /accounting does `SELECT * FROM job_card_byproducts_v2`, so the column name
 *  passes straight through. Only GET /job-cards-v2/{id} aliases it to qty_kg —
 *  which is why the ByproductRowLike type in job-card/[id]/outputAccounting.ts
 *  must NOT be reused here. Reading qty_kg off this response yields undefined
 *  and renders every byproduct as 0 kg with no error. */
export interface ByproductRow {
  byproduct_id: number;
  job_card_id: number;
  category: string;
  quantity: number | string;
  uom: string;
  remarks?: string | null;
  recorded_by?: string | null;
  recorded_at?: string | null;
  material_name?: string | null;
  bom_line_id?: number | null;
  batch_id?: number | null;
}

/** Every value the byproduct CHECK constraint permits — 16, not the 10 the
 *  original migration shipped with (034 and 047 extended it). A breakdown that
 *  hard-codes the old list silently drops `wastage` and all five pm_* rows. */
export const BYPRODUCT_CATEGORIES = [
  "tukda", "damaged", "black_stained", "without_shell", "empty_shells", "dust",
  "balance_material", "rejection", "control_sample", "wastage", "other",
  "pm_torn", "pm_damaged", "pm_misprint", "pm_rejection", "pm_wasted",
] as const;

export type ByproductCategory = (typeof BYPRODUCT_CATEGORIES)[number];

/** Categories excluded from the off-grade roll-up: control samples and balance
 *  material are not defects, wastage is counted separately, and pm_* belongs to
 *  packaging rather than product. Mirrors the server's own exclusion. */
const NOT_OFFGRADE = new Set<string>([
  "control_sample", "balance_material", "wastage",
]);

export const isOffgrade = (category: string): boolean => {
  const c = (category ?? "").trim().toLowerCase();
  return !!c && !c.startsWith("pm_") && !NOT_OFFGRADE.has(c);
};

export interface AccountingRow {
  accounting_id?: number;
  job_card_id?: number;
  total_input_qty: number | string;
  input_uom: string;
  output_qty: number | string;
  output_uom?: string | null;
  output_qty_units?: number | string | null;
  output_kind: string;
  carried_in_qty: number | string;
  dispatched_out_qty: number | string;
  process_loss_qty: number | string;
  process_loss_breakdown?: Record<string, number> | null;
  extra_give_away_qty: number | string;
  balance_material_qty: number | string;
  offgrade_total_qty: number | string;
  rejection_qty: number | string;
  wastage_qty: number | string;
  control_sample_qty: number | string;
  total_accounted_qty: number | string;
  balance_difference_qty: number | string;
  is_balanced: boolean;
  process_loss_pct?: number | string | null;
  other_loss_pct?: number | string | null;
  total_loss_pct?: number | string | null;
  invisible_loss_pct?: number | string | null;
  pm_variance_breakdown?: Record<string, unknown> | null;
  // Computed by the service on the way out; null when output_qty is 0.
  rejection_pct?: number | null;
  offgrade_pct?: number | null;
  allowed_balance_tolerance_pct?: number | null;
  saved_by?: string | null;
  saved_at?: string | null;
  updated_at?: string | null;
  batch_id?: number | null;
}

export interface AccountingResponse {
  job_card_id: number;
  stage: {
    step_number: number;
    process_name: string | null;
    input_kind: string | null;
    output_kind: string | null;
    is_first_stage: boolean;
    is_last_stage: boolean;
    total_stages: number;
    prev_job_card_id: number | null;
    next_job_card_id: number | null;
    planned_qty_kg: number | null;
    planned_qty_units: number | null;
    uom: string | null;
    carried_in_qty: number;
    dispatched_out_qty: number;
  };
  consumption: ConsumptionRow[];
  consumption_variance: VarianceRow[];
  byproducts: ByproductRow[];
  accounting: AccountingRow | null;
}

/** Throws Error("forbidden") on 403 so hydrateAll can abort the whole burst.
 *
 *  This endpoint requires production/job_cards/accounting:view, which the list
 *  endpoint does NOT — a user can legitimately see every job card and be
 *  refused every accounting detail. Without the short-circuit the page would
 *  fire one doomed request per job card and then render zeros that read as
 *  real data. */
export async function getAccounting(
  jobCardId: number,
  signal?: AbortSignal,
): Promise<AccountingResponse> {
  const res = await apiFetch(
    `/api/v1/production/job-cards-v2/${jobCardId}/accounting`,
    { signal },
  );
  if (res.status === 403) throw new Error("forbidden");
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Accounting HTTP ${res.status}`));
  return (await res.json()) as AccountingResponse;
}

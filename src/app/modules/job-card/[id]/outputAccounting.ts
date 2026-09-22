// Pure re-hydration helpers for the Output / Accounting form.
//
// Extracted so the save -> reload -> display round-trip is unit-testable
// without React. The web Output tab used to initialise the per-line inputs
// empty and only re-synced the scalar FG fields, so saved Material
// Consumption / Balance / Rejection values blanked on reload even though they
// persisted in the DB. These helpers rebuild the form state from the JC detail
// payload (job_card_v2.get_job_card), mirroring the Electron client's prefill
// (frontend_replica .../job-card-detail.js: actual_consumed_qty round-trip).
//
// Key scheme MUST match the input grid in page.tsx:
//   a.bom_line_id != null ? `b${bom_line_id}` : `n${material name}`

export type RejectionRow = {
  category: string;
  bomLineId: number | null;
  materialName: string;
  qty: string;
  remarks: string;
};

export type ConsumptionLineLike = {
  bom_line_id?: number | null;
  material_sku_name?: string | null;
  actual_consumed_qty?: number | string | null;
  // Slice 4: RM | PM | SFG | WIP. Re-hydration keys by bom_line_id/name so it
  // already round-trips SFG rows; carried on the type so callers can classify
  // input-vs-PM consistently with the grid's mass-balance predicates.
  input_kind?: string | null;
  // Stage 2: migration 038 tags every row with the batch it belongs to.
  // Legacy rows surface NULL until they're re-saved under a batch.
  batch_id?: number | null;
};

export type BalanceRowLike = {
  bom_line_id?: number | null;
  material_name?: string | null;
  balance_type?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
  batch_id?: number | null;
};

export type ByproductRowLike = {
  category?: string | null;
  qty_kg?: number | string | null;
  uom?: string | null;
  remarks?: string | null;
  // Migration 034: per-row article attribution. Both nullable —
  // control_sample / pm_* / dust etc. don't carry an article.
  material_name?: string | null;
  bom_line_id?: number | null;
  batch_id?: number | null;
};

/** Stage 3 batch filter sentinel.
 *  - A number       → include only rows whose batch_id equals it.
 *  - The literal null → include only legacy rows whose batch_id IS NULL.
 *  - undefined      → no filter (show everything; used by the rollup view).
 *
 *  Filtering happens in the FromDetail helpers below so the form state
 *  always reflects the picked batch in the selector dropdown. */
export type BatchFilter = number | null | undefined;

function matchesBatch<T extends { batch_id?: number | null }>(
  row: T,
  filter: BatchFilter,
): boolean {
  if (filter === undefined) return true;
  if (filter === null) return row.batch_id == null;
  // Defense in depth — rows with batch_id=NULL should always surface under
  // the currently selected batch instead of vanishing. Three real sources
  // of null batch_id we want to tolerate gracefully:
  //   1. Legacy rows written before migration 036 added the column (rare
  //      now, but still on prod for old JCs).
  //   2. record_output rows written before the recent service fix that
  //      added batch_id to the INSERT (server_replica 7482956). The
  //      backfill migration 046 catches most of these, but JCs whose
  //      batches were all closed before the output's recorded_at can't
  //      be resolved by the started_at/closed_at heuristic.
  //   3. Any future write path that forgets to thread batch_id through
  //      (caught here instead of silently blanking the operator's form).
  // The save path always tags NEW writes with the selected batch_id, so
  // including null-batch rows here only surfaces legacy data we want
  // surfaced anyway.
  return row.batch_id == null || row.batch_id === filter;
}

function lineKey(bomLineId: number | null | undefined, name: string | null | undefined): string {
  return bomLineId != null ? `b${bomLineId}` : `n${name ?? ""}`;
}

/** The fields of a catalogue article the key resolution reads. */
export type ArticleKeyLike = { bom_line_id: number | null; material_sku_name: string };

const nameKey = (n: string | null | undefined) => (n ?? "").trim().toUpperCase();

/** A saved row's grid key. A row with no bom_line_id resolves to the catalogue
 *  article of the same name (UPPER/TRIM), preferring one with a BOM line — so a
 *  figure saved for an added article still shows after the BOM module gains that
 *  article (the add is then "superseded"), and PM stays PM in the RM/PM maps. */
export function resolveRowKey(
  bomLineId: number | null | undefined,
  name: string | null | undefined,
  articles?: readonly ArticleKeyLike[],
): string {
  if (bomLineId != null) return `b${bomLineId}`;
  if (articles) {
    const k = nameKey(name);
    const matches = articles.filter((a) => nameKey(a.material_sku_name) === k);
    const withLine = matches.find((a) => a.bom_line_id != null);
    if (withLine) return `b${withLine.bom_line_id}`;
    if (matches[0]) return `n${matches[0].material_sku_name}`;
  }
  return lineKey(bomLineId, name);
}

const toNum = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/** Material Consumption inputs, keyed like the grid. Reads the operator's
 *  recorded `actual_consumed_qty` (job_card_material_consumption_v2). Rows at
 *  0 (or below) are skipped, so a cleared figure — saved as 0 — shows empty.
 *  With `articles`, a row with no bom_line_id resolves to its article by name
 *  (resolveRowKey).
 *
 *  Under one batch, the batch's own row wins over a legacy no-batch twin
 *  (matchesBatch shows those under every batch), whatever their order — and a
 *  batch row cleared to 0 hides the twin. Otherwise the twin's figure would
 *  come back after a clear, and the next save would write it into the batch. */
export function consumptionStateFromDetail(
  lines: ConsumptionLineLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
  articles?: readonly ArticleKeyLike[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const ownKeys = new Set<string>();
  const legacy: Record<string, string> = {};
  for (const c of lines ?? []) {
    if (!matchesBatch(c, batchFilter)) continue;
    const q = c.actual_consumed_qty;
    if (q == null || q === "") continue;
    const k = resolveRowKey(c.bom_line_id, c.material_sku_name, articles);
    const twin = typeof batchFilter === "number" && c.batch_id == null;
    if (!twin) ownKeys.add(k);
    if (!(toNum(q) > 0)) continue;
    if (twin) legacy[k] = String(q);
    else out[k] = String(q);
  }
  for (const [k, v] of Object.entries(legacy)) {
    if (!ownKeys.has(k)) out[k] = v;
  }
  return out;
}

/** Balance Material per-article inputs. Only the per-article `returned` rows
 *  feed this grid; control_sample / extra_given are surfaced elsewhere. With
 *  `articles`, a row with no bom_line_id resolves to its article by name
 *  (resolveRowKey). */
export function balanceStateFromDetail(
  rows: BalanceRowLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
  articles?: readonly ArticleKeyLike[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of rows ?? []) {
    if (!matchesBatch(b, batchFilter)) continue;
    if (b.balance_type !== "returned") continue;
    if (b.qty_kg == null || b.qty_kg === "") continue;
    out[resolveRowKey(b.bom_line_id, b.material_name, articles)] = String(b.qty_kg);
  }
  return out;
}

/** Rejection / Off-grade rows = off-grade byproducts only.
 *  R10/C6 — control_sample is filtered out: it now has a dedicated input on
 *  the Output & Accounting tab and is no longer a rejection category.
 *  R11/C7 — pm_* byproducts (pm_torn, pm_damaged, pm_misprint, pm_rejection,
 *  pm_wasted) are also filtered out; they have their own PM Variance block.
 *  `balanceRows` is still accepted for back-compat with older JCs whose
 *  control_sample row was historically saved under balance_materials. */
export function rejectionsFromDetail(
  byproducts: ByproductRowLike[] | undefined | null,
  _balanceRows: BalanceRowLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): RejectionRow[] {
  const rows: RejectionRow[] = [];
  // As for consumption: under one batch, a (category, article) row of the
  // batch hides a legacy no-batch twin, even when it was cleared to 0.
  const bpKey = (bp: ByproductRowLike) => `${bp.category ?? ""}|${nameKey(bp.material_name)}`;
  const ownKeys = new Set<string>();
  if (typeof batchFilter === "number") {
    for (const bp of byproducts ?? []) {
      if (bp.batch_id === batchFilter) ownKeys.add(bpKey(bp));
    }
  }
  for (const bp of byproducts ?? []) {
    if (!matchesBatch(bp, batchFilter)) continue;
    const cat = bp.category ?? "";
    if (cat === "control_sample") continue;
    if (cat.startsWith("pm_")) continue;
    if (typeof batchFilter === "number" && bp.batch_id == null && ownKeys.has(bpKey(bp))) continue;
    // A cleared off-grade row is saved as 0; it must not come back as a "0" row.
    if (!(toNum(bp.qty_kg) > 0)) continue;
    rows.push({
      category: cat,
      // Migration 034 — article attribution persisted server-side.
      // Older rows that pre-date the migration carry NULLs; the
      // dropdown then renders as "— Article —" until the operator
      // picks one and saves again.
      bomLineId: bp.bom_line_id ?? null,
      materialName: bp.material_name ?? "",
      qty: bp.qty_kg != null ? String(bp.qty_kg) : "",
      remarks: bp.remarks ?? "",
    });
  }
  return rows;
}

/** Keys to send as consumed 0: saved (as last seeded) above 0, now empty or 0.
 *  `seeded` must be what the inputs were last seeded with, not the live server
 *  memo — that one moves on every 60 s poll while the form is dirty, and would
 *  zero a figure someone else saved meanwhile. */
export function clearedConsumptionKeys(
  seeded: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return Object.keys(seeded).filter((k) => toNum(seeded[k]) > 0 && !(toNum(current[k]) > 0));
}

const rejKey = (r: RejectionRow) => `${r.category}|${nameKey(r.materialName)}`;

/** Off-grade rows to send as 0: seeded (category + article) rows the operator
 *  removed, zeroed or pointed at another article. No (category, no-article)
 *  zero when the payload has an attributed row in that category —
 *  save_byproducts deletes those itself. */
export function clearedRejections(seeded: readonly RejectionRow[], outgoing: readonly RejectionRow[]): RejectionRow[] {
  const live = outgoing.filter((r) => r.category && toNum(r.qty) > 0);
  const liveKeys = new Set(live.map(rejKey));
  const attributed = new Set(live.filter((r) => r.materialName.trim()).map((r) => r.category));
  const out: RejectionRow[] = [];
  const seen = new Set<string>();
  for (const r of seeded) {
    if (!r.category || !(toNum(r.qty) > 0)) continue;
    const k = rejKey(r);
    if (liveKeys.has(k) || seen.has(k)) continue;
    if (!r.materialName.trim() && attributed.has(r.category)) continue;
    seen.add(k);
    out.push({ ...r, qty: "0" });
  }
  return out;
}

/** R10/C6 — pull the saved control_sample qty (kg) from the JC detail
 *  payload. Reads from byproducts first (canonical post-C6 path), falls
 *  back to balance_materials for older JCs where it was historically stored
 *  there. Returns "" when none recorded.
 *
 *  W3-HIGH-1 — when the value sources from the legacy balance_materials
 *  fallback we emit a one-time console.warn so we can spot un-migrated JCs
 *  in the field (the next save normalises it back into byproducts). The
 *  legacy rejection-row case (category='control_sample' surfaced via the
 *  generic Rejections list) is filtered out by rejectionsFromDetail above
 *  and auto-classified into the QC Sample input here so the operator sees
 *  it in the new home instead of an empty input. */
export function controlSampleFromDetail(
  byproducts: ByproductRowLike[] | undefined | null,
  balanceRows: BalanceRowLike[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): string {
  for (const bp of byproducts ?? []) {
    if (!matchesBatch(bp, batchFilter)) continue;
    if (bp.category === "control_sample" && bp.qty_kg != null && bp.qty_kg !== "") {
      // Canonical path — byproducts row. No warning.
      return String(bp.qty_kg);
    }
  }
  for (const b of balanceRows ?? []) {
    if (!matchesBatch(b, batchFilter)) continue;
    if (b.balance_type === "control_sample" && b.qty_kg != null && b.qty_kg !== "") {
      if (typeof console !== "undefined") {
        console.warn(
          "controlSampleFromDetail: legacy balance_materials row detected " +
            "(balance_type='control_sample'). The next Save Output will " +
            "migrate this into byproducts(category='control_sample').",
        );
      }
      return String(b.qty_kg);
    }
  }
  return "";
}

/** Additive consumption (data-keeping bucket) — pull rows persisted
 *  to job_card_additive_consumption_v2. A row with a non-empty sku_name
 *  was picked from the dropdown; rows with no sku_name + a material_name
 *  came in via the "Others" free-text path. */
export type AdditiveDetailRow = {
  sku_name?: string | null;
  material_name?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
  batch_id?: number | null;
};

export type AdditiveStateRow = {
  sku_name: string;
  custom_name: string;
  qty: string;
  remarks: string;
};

export function additivesFromDetail(
  rows: AdditiveDetailRow[] | undefined | null,
  batchFilter: BatchFilter = undefined,
): AdditiveStateRow[] {
  const out: AdditiveStateRow[] = [];
  for (const r of rows ?? []) {
    if (!matchesBatch(r, batchFilter)) continue;
    const sku = (r.sku_name ?? "").trim();
    const custom = (r.material_name ?? "").trim();
    out.push({
      // When a sku_name is present, use it; otherwise the row originated
      // from "Others" — restore that path so the operator can edit the
      // custom name without re-entering it.
      sku_name: sku ? sku : (custom ? "_other" : ""),
      custom_name: sku ? "" : custom,
      qty: r.qty_kg != null ? String(r.qty_kg) : "",
      remarks: r.remarks ?? "",
    });
  }
  return out;
}

/** R11/C7 — pull each PM variance category's qty + uom from byproducts. */
export type PmVarianceState = Record<string, { qty: string; uom: string }>;

export function pmVarianceFromDetail(
  byproducts: ByproductRowLike[] | undefined | null,
  defaultUom: string,
  batchFilter: BatchFilter = undefined,
): PmVarianceState {
  const out: PmVarianceState = {};
  for (const bp of byproducts ?? []) {
    if (!matchesBatch(bp, batchFilter)) continue;
    const cat = bp.category ?? "";
    if (!cat.startsWith("pm_")) continue;
    out[cat] = {
      qty: bp.qty_kg != null ? String(bp.qty_kg) : "",
      uom: (bp as { uom?: string | null }).uom ?? defaultUom,
    };
  }
  return out;
}

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
};

export type BalanceRowLike = {
  bom_line_id?: number | null;
  material_name?: string | null;
  balance_type?: string | null;
  qty_kg?: number | string | null;
  remarks?: string | null;
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
};

function lineKey(bomLineId: number | null | undefined, name: string | null | undefined): string {
  return bomLineId != null ? `b${bomLineId}` : `n${name ?? ""}`;
}

/** Material Consumption inputs, keyed like the grid. Reads the operator's
 *  recorded `actual_consumed_qty` (job_card_material_consumption_v2). */
export function consumptionStateFromDetail(
  lines: ConsumptionLineLike[] | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of lines ?? []) {
    const q = c.actual_consumed_qty;
    if (q == null || q === "") continue;
    out[lineKey(c.bom_line_id, c.material_sku_name)] = String(q);
  }
  return out;
}

/** Balance Material per-article inputs. Only the per-article `returned` rows
 *  feed this grid; control_sample / extra_given are surfaced elsewhere. */
export function balanceStateFromDetail(
  rows: BalanceRowLike[] | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of rows ?? []) {
    if (b.balance_type !== "returned") continue;
    if (b.qty_kg == null || b.qty_kg === "") continue;
    out[lineKey(b.bom_line_id, b.material_name)] = String(b.qty_kg);
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
): RejectionRow[] {
  const rows: RejectionRow[] = [];
  for (const bp of byproducts ?? []) {
    const cat = bp.category ?? "";
    if (cat === "control_sample") continue;
    if (cat.startsWith("pm_")) continue;
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
): string {
  for (const bp of byproducts ?? []) {
    if (bp.category === "control_sample" && bp.qty_kg != null && bp.qty_kg !== "") {
      // Canonical path — byproducts row. No warning.
      return String(bp.qty_kg);
    }
  }
  for (const b of balanceRows ?? []) {
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

/** R11/C7 — pull each PM variance category's qty + uom from byproducts. */
export type PmVarianceState = Record<string, { qty: string; uom: string }>;

export function pmVarianceFromDetail(
  byproducts: ByproductRowLike[] | undefined | null,
  defaultUom: string,
): PmVarianceState {
  const out: PmVarianceState = {};
  for (const bp of byproducts ?? []) {
    const cat = bp.category ?? "";
    if (!cat.startsWith("pm_")) continue;
    out[cat] = {
      qty: bp.qty_kg != null ? String(bp.qty_kg) : "",
      uom: (bp as { uom?: string | null }).uom ?? defaultUom,
    };
  }
  return out;
}

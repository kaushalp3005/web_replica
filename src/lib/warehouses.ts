// Canonical warehouse / cold-unit lists for the Transfer + Job Work module.
//
// These are hardcoded on purpose. GET /api/v1/transfer/dropdowns/warehouse-sites
// still exists and still reads the `warehouse_sites` table, but the set of sites
// changes maybe once a year, every form already shipped a hardcoded fallback for
// when the call failed, and the request form was the ONLY caller — so the round
// trip bought nothing but a spinner and a divergence risk.
//
// The divergence was already real. Before this file there were five lists in the
// transfer module and no two agreed:
//   page.tsx                     9 entries
//   request/page.tsx             5 (WAREHOUSE_FALLBACK)
//   _formParts.tsx               6 (FROM) + 9 (TO)
//   job-work/material-out        5
// A site added to one was silently missing from the others. Import from here.

/** Factory / plant warehouses. Stock physically moves between these. */
export const PLANT_WAREHOUSES = ["W202", "A185", "A101", "A68", "F53"] as const;

/** Third-party cold stores. Destinations, and sources via "Cold Storage". */
export const COLD_UNITS = ["Savla D-39", "Savla D-514", "Rishi", "Supreme"] as const;

/** Everything selectable as a warehouse filter. */
export const ALL_WAREHOUSES: string[] = [...PLANT_WAREHOUSES, ...COLD_UNITS];

/** Transfer-OUT source. "Cold Storage" is the generic cold source — the specific
 *  unit comes from the scanned box's `cold_unit`, not from this dropdown. */
export const FROM_WAREHOUSES: string[] = [...PLANT_WAREHOUSES, "Cold Storage"];

/** Transfer-OUT destination — a named cold store, never the generic bucket. */
export const TO_WAREHOUSES: string[] = [...PLANT_WAREHOUSES, ...COLD_UNITS];

/** Stored code -> label. Only "Supreme" differs; the DB holds the short form and
 *  operators know it as "Supreme Cold". */
export function displayWarehouse(code: string): string {
  return code === "Supreme" ? "Supreme Cold" : code;
}

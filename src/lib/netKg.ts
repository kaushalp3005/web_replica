// Net-kg normalisation. Every quantity on the dashboards passes through here
// before it is summed.
//
// Quantities arrive tagged with their own uom drawn from
// {KGS, GMS, LTRS, NOS, PCS, ROLL, SETS, BUNDLE} (server: services/uom.py).
// Adding them together as raw numbers is meaningless, so convert first:
//
//   KGS                      → as-is
//   GMS                      → ÷ 1000
//   PCS/NOS/SETS/BUNDLE/ROLL → × all_sku.uom (pack kg), only when > 0
//   LTRS                     → NOT converted: volume needs a density the master
//                              does not carry. Assuming 1 L = 1 kg would corrupt
//                              the mass balance.
//   pack weight 0 or NULL    → NOT converted.
//
// all_sku.uom is kg per TRANSACTED unit of that SKU — not a unit string, and
// not necessarily the weight named in the SKU title. For a "500gm x 16 Nos"
// multipack it is 8.0, which is correct: one unit of that SKU is the 16-pack.
// So qty × uom holds for every row, because qty always counts units of the
// same SKU the pack weight describes.
//
// Anything unconvertible is EXCLUDED from the kg total and reported, never
// silently coerced to 0 — a total that quietly drops rows is worse than one
// that says what it left out.

export interface NetKg {
  kg: number;
  ok: boolean;
  qty?: number;
  uom?: string;
  why?: string;
}

const DIRECT: Record<string, number> = { KGS: 1, GMS: 0.001 };
const COUNTED = new Set(["PCS", "NOS", "SETS", "BUNDLE", "ROLL"]);

export function toNetKg(
  qty: number | string | null | undefined,
  uom: string | null | undefined,
  packKg: number | null | undefined,
): NetKg {
  const q = typeof qty === "number" ? qty : parseFloat(String(qty ?? "0"));
  const n = isFinite(q) ? q : 0;
  const u = String(uom ?? "").trim().toUpperCase();

  if (u in DIRECT) return { kg: n * DIRECT[u], ok: true };

  if (COUNTED.has(u)) {
    const p = packKg ?? 0;   // NULL and 0 both mean "no pack weight"
    return p > 0
      ? { kg: n * p, ok: true }
      : { kg: 0, ok: false, qty: n, uom: u, why: "no pack weight in all_sku" };
  }

  if (u === "LTRS" || u === "LTR") {
    return { kg: 0, ok: false, qty: n, uom: u, why: "volume — master carries no density" };
  }

  return { kg: 0, ok: false, qty: n, uom: u || "—", why: "unrecognised uom" };
}

/** Sum only the convertible rows; hand back what was left out so the caller
 *  can surface it rather than publishing a quietly understated total. */
export function sumNetKg<T>(
  rows: T[],
  pick: (r: T) => {
    qty: unknown;
    uom: string | null | undefined;
    packKg: number | null | undefined;
  },
): { kg: number; excluded: T[] } {
  let kg = 0;
  const excluded: T[] = [];
  for (const r of rows) {
    const { qty, uom, packKg } = pick(r);
    const n = toNetKg(qty as number, uom, packKg);
    if (n.ok) kg += n.kg;
    else excluded.push(r);
  }
  return { kg, excluded };
}

/** Format a kg figure for display. Keeps 3 decimals like the master's
 *  NUMERIC(15,3) rather than rounding away small byproduct quantities. */
export function fmtKg(kg: number, decimals = 3): string {
  if (!isFinite(kg)) return "—";
  return kg.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

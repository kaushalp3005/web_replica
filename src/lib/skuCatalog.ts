// all_sku catalogue: normalised SKU name -> { itemGroup, subGroup, itemType,
// saleGroup, packKg }. Drives BOTH the Category dimension on the dashboards
// and the pack weights net-kg conversion needs (see netKg.ts).
//
// Primary path : GET /so/sku-lookup/bulk — one call, paired rows, pack weights.
// Fallback path: GET /so/sku-lookup once per item_group, used when the bulk
//                route is not deployed yet. It recovers category but NOT pack
//                weight, and the caller is told so via `packWeights: false`.
//
// Why a name key: the production chain joins all_sku by free text — there is
// no sku_id on job_card_v2, production_plan_line_v2 or bom_header — and the
// master holds ~85 duplicate names and ~20 case-variant group spellings. So
// names are normalised on the way in and groups are title-folded, or the same
// category shows up twice in the UI.

import { apiFetch, readApiErrorMessage } from "./auth";
import { readDashboardCache, writeDashboardCache } from "./dashboardUtils";

export interface SkuMeta {
  particulars: string;      // canonical spelling, for display
  itemGroup: string;        // title-folded — collapses CASHEW / cashew
  subGroup: string | null;
  itemType: string | null;  // rm | pm | fg | sfg
  saleGroup: string | null;
  packKg: number;           // all_sku.uom — kg per TRANSACTED unit; 0 when unknown
  ambiguous?: true;         // duplicate rows disagreed on item_group
}

export interface SkuCatalogue {
  byName: Record<string, SkuMeta>;      // key: normaliseSkuName(particulars)
  bySfgCode: Record<string, SkuMeta>;   // key: SFG#### (uppercased)
  packWeights: boolean;                 // false ⇒ fallback path, packKg unavailable
  ambiguousNames: string[];             // surfaced as a data-quality chip
}

const CACHE_KEY = "sku-catalogue:v2";
export const UNMAPPED = "Unmapped";

/** Case- and whitespace-insensitive key. Mirrors the server's own matcher:
 *  LOWER(TRIM(REGEXP_REPLACE(particulars, '\s+', ' ', 'g'))). */
export const normaliseSkuName = (s: string | null | undefined): string =>
  (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** Title-fold a group so CASHEW / cashew land in one bucket. */
export const foldGroup = (s: string | null | undefined): string => {
  const t = (s ?? "").trim();
  return t ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "";
};

interface BulkRow {
  particulars: string;
  item_type: string | null;
  item_group: string | null;
  sub_group: string | null;
  uom: number | string | null;
  sale_group: string | null;
  sfg_code: string | null;
}

interface LookupResponse {
  options: {
    item_types: string[];
    particulars: string[];
    item_groups: string[];
    sub_groups: string[];
    sales_groups: string[];
  };
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isFinite(n) ? n : 0;
};

// ── cache shape ───────────────────────────────────────────────────────────
// bySfgCode holds the SAME SkuMeta objects as byName. Caching the catalogue
// verbatim would send both through JSON.stringify, storing every shared entry
// twice and returning two distinct objects on read. Persist an index of keys
// instead and re-point it at load.
interface CachedCatalogue {
  byName: Record<string, SkuMeta>;
  sfgIndex: Record<string, string>;   // SFG#### -> byName key
  packWeights: boolean;
  ambiguousNames: string[];
}

function toCache(cat: SkuCatalogue): CachedCatalogue {
  const sfgIndex: Record<string, string> = {};
  for (const [code, meta] of Object.entries(cat.bySfgCode)) {
    const key = normaliseSkuName(meta.particulars);
    if (key) sfgIndex[code] = key;
  }
  return {
    byName: cat.byName,
    sfgIndex,
    packWeights: cat.packWeights,
    ambiguousNames: cat.ambiguousNames,
  };
}

function fromCache(c: CachedCatalogue): SkuCatalogue {
  const bySfgCode: Record<string, SkuMeta> = {};
  for (const [code, key] of Object.entries(c.sfgIndex ?? {})) {
    const meta = c.byName[key];
    if (meta) bySfgCode[code] = meta;
  }
  return {
    byName: c.byName,
    bySfgCode,
    packWeights: !!c.packWeights,
    ambiguousNames: c.ambiguousNames ?? [],
  };
}

// ── loaders ───────────────────────────────────────────────────────────────

async function loadBulk(signal?: AbortSignal): Promise<SkuCatalogue | null> {
  const res = await apiFetch("/api/v1/so/sku-lookup/bulk", { signal });
  if (res.status === 404) return null;                  // route not deployed yet
  if (res.status === 403) throw new Error("forbidden");
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `SKU bulk HTTP ${res.status}`));
  const rows = (await res.json()) as BulkRow[];

  const byName: Record<string, SkuMeta> = {};
  const bySfgCode: Record<string, SkuMeta> = {};
  const ambiguous = new Set<string>();

  for (const r of rows) {
    const key = normaliseSkuName(r.particulars);
    if (!key) continue;
    const group = foldGroup(r.item_group);
    const prev = byName[key];

    if (prev) {
      // Duplicate name. Pack weight and item_type never contradict each other
      // in the master, so the first row stands. A genuine group disagreement
      // is flagged, and the alphabetically-first spelling wins so the number
      // is stable across reloads instead of depending on row order.
      if (group && prev.itemGroup && group !== prev.itemGroup) {
        ambiguous.add(prev.particulars);
        prev.ambiguous = true;
        if (group < prev.itemGroup) prev.itemGroup = group;
      }
      if (!prev.packKg && num(r.uom) > 0) prev.packKg = num(r.uom);
      if (!prev.subGroup && r.sub_group) prev.subGroup = r.sub_group;
      if (!prev.saleGroup && r.sale_group) prev.saleGroup = r.sale_group;
      if (!prev.itemType && r.item_type) prev.itemType = r.item_type;
    } else {
      byName[key] = {
        particulars: r.particulars,
        itemGroup: group || UNMAPPED,
        subGroup: r.sub_group ?? null,
        itemType: r.item_type ?? null,
        saleGroup: r.sale_group ?? null,
        packKg: num(r.uom),
      };
    }

    const code = (r.sfg_code ?? "").trim().toUpperCase();
    if (code) bySfgCode[code] = byName[key];
  }

  return { byName, bySfgCode, packWeights: true, ambiguousNames: [...ambiguous].sort() };
}

/** Fallback: one lookup per item_group.
 *
 *  `options` comes back as four INDEPENDENT distinct arrays, so the only way
 *  to pair a name with a group is to make the group the query — then
 *  `options.particulars` IS that group's membership.
 *
 *  Two things this path cannot recover, both by construction:
 *    * pack weights — never exposed by the options payload, so kg conversion
 *      degrades to KGS/GMS only;
 *    * SFG rows — /sku-lookup applies `item_type IS DISTINCT FROM 'sfg'`
 *      whenever no item_type is passed, so no sfg_code index can be built and
 *      SFG consumption lines fall through to Unmapped.
 */
async function loadByGroupArrays(signal?: AbortSignal): Promise<SkuCatalogue | null> {
  let groups: string[];
  try {
    const res = await apiFetch("/api/v1/so/sku-lookup", { signal });
    if (!res.ok) return null;
    groups = ((await res.json()) as LookupResponse).options.item_groups;
  } catch {
    return null;
  }

  // Case variants would otherwise be queried twice; the server matches
  // case-insensitively, so one query per folded group is enough.
  const folded = [...new Map(groups.map((g) => [foldGroup(g), g])).values()];

  const byName: Record<string, SkuMeta> = {};
  let i = 0;
  const worker = async () => {
    while (i < folded.length) {
      const g = folded[i++];
      try {
        const res = await apiFetch(
          `/api/v1/so/sku-lookup?${new URLSearchParams({ item_group: g })}`,
          { signal },
        );
        if (!res.ok) continue;
        const body = (await res.json()) as LookupResponse;
        for (const p of body.options.particulars) {
          const key = normaliseSkuName(p);
          if (key && !byName[key]) {
            byName[key] = {
              particulars: p,
              itemGroup: foldGroup(g),
              subGroup: null,
              itemType: null,
              saleGroup: null,
              packKg: 0,
            };
          }
        }
      } catch {
        // Skip this group; its SKUs fall through to Unmapped rather than
        // failing the whole catalogue.
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));

  return { byName, bySfgCode: {}, packWeights: false, ambiguousNames: [] };
}

/** Returns null only when the caller lacks `so:view`, so the page can hide the
 *  Category dimension entirely instead of rendering everything as Unmapped. */
export async function loadSkuCatalogue(signal?: AbortSignal): Promise<SkuCatalogue | null> {
  const cached = readDashboardCache<CachedCatalogue>(CACHE_KEY);
  if (cached?.payload?.byName) return fromCache(cached.payload);

  let cat: SkuCatalogue | null = null;
  try {
    cat = await loadBulk(signal);
  } catch (e) {
    if (e instanceof Error && e.message === "forbidden") return null;
    // Any other bulk failure falls through to the per-group path below.
  }
  if (!cat) cat = await loadByGroupArrays(signal);
  if (!cat) return null;

  writeDashboardCache(CACHE_KEY, toCache(cat));
  return cat;
}

// ── resolvers ─────────────────────────────────────────────────────────────

/** Resolve a SKU. Tries the seam code FIRST: SFG consumption lines carry a
 *  synthesised material_sku_name ("SFG from JC #… (Roasting)") that will never
 *  match `particulars`, but their job card does carry input_code/output_code,
 *  and all_sku.sfg_code uses the identical SFG#### format. */
export function metaOf(
  cat: SkuCatalogue | null,
  name: string | null | undefined,
  sfgCode?: string | null,
): SkuMeta | null {
  if (!cat) return null;
  const code = (sfgCode ?? "").trim().toUpperCase();
  if (code && cat.bySfgCode[code]) return cat.bySfgCode[code];
  const key = normaliseSkuName(name);
  return key ? (cat.byName[key] ?? null) : null;
}

export const categoryOf = (
  cat: SkuCatalogue | null,
  name: string | null | undefined,
  sfgCode?: string | null,
): string => metaOf(cat, name, sfgCode)?.itemGroup || UNMAPPED;

export const packKgOf = (
  cat: SkuCatalogue | null,
  name: string | null | undefined,
  sfgCode?: string | null,
): number => metaOf(cat, name, sfgCode)?.packKg ?? 0;

export const saleGroupOf = (
  cat: SkuCatalogue | null,
  name: string | null | undefined,
): string => metaOf(cat, name)?.saleGroup || UNMAPPED;

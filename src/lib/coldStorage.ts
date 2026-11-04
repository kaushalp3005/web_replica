// Cold Storage API client (doc 08 cold picker). Targets /api/v1/cold-storage/* —
// lot/group stock search + FIFO per-box pick. Auth via apiFetch (shared bearer).

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/cold-storage";

// Blank values are left out, except the `keep` keys, which go as they are: the pick
// matches a blank inward_no, unit, storage location or item mark as blank.
function qs(params: Record<string, string | number | undefined | null>, keep: readonly string[] = []): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && (v !== "" || keep.includes(k))) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

export interface ColdStockRecord {
  id: number;
  inward_dt?: string | null;
  unit?: string | null;
  inward_no?: string | null;
  item_description?: string | null;
  item_mark?: string | null;
  vakkal?: string | null;
  lot_no?: string | null;
  net_qty_on_cartons?: number | null;
  weight_kg?: number | null;
  total_inventory_kgs?: number | null;
  group_name?: string | null;
  storage_location?: string | null;
  exporter?: string | null;
  last_purchase_rate?: number | null;
  value?: number | null;
  box_id?: string | null;
  transaction_no?: string | null;
  company?: string | null; // real source company (cfpl/cdpl) — drives the pick (stock is never deducted; record only)
  // With from_warehouse: how many of the lot's boxes can go from that site by their latest
  // transfer (never on one, or received and acknowledged there). net_qty_on_cartons stays
  // the cold table's own count.
  available_here?: number | null;
}

export interface ColdSearchResult {
  results: ColdStockRecord[];
  total: number;
}

/** Whether a search group shows a row that is no trackable box (no box_id or
 *  transaction_no, or the quantity-only 'DIRECT'): the group's box_id / transaction_no
 *  are its smallest, so a blank or 'DIRECT' one means such a row. available_here never
 *  counts those rows (a dispatch can't take them box by box), but an inner cold transfer
 *  relabels them too. A group whose smallest ids are real boxes may still hold one. */
export function hasBoxlessRows(r: Pick<ColdStockRecord, "box_id" | "transaction_no">): boolean {
  const bid = (r.box_id || "").trim(), tno = (r.transaction_no || "").trim();
  return !bid || !tno || tno === "DIRECT";
}

// Search rows in the order the server merges both companies' lots (search_service._fifo):
// oldest inward first (none last), then cfpl before cdpl, then the group's first row id.
function fifo(a: ColdStockRecord, b: ColdStockRecord): number {
  const da = a.inward_dt || "", db = b.inward_dt || "";
  if (!da !== !db) return da ? -1 : 1;
  if (da !== db) return da < db ? -1 : 1;
  const ca = a.company === "cfpl" ? 0 : 1, cb = b.company === "cfpl" ? 0 : 1;
  return ca !== cb ? ca - cb : a.id - b.id;
}

type SearchParams = {
  lot_no?: string; item_description?: string; group_name?: string; q?: string; limit?: number;
  unit?: string; storage_location?: string; from_warehouse?: string | null;
};

const searchStocks = (p: SearchParams = {}) =>
  getJson<ColdSearchResult>(`${BASE}/stocks/search${qs({ ...p, limit: p.limit ?? 50 })}`, "Cold-stock search failed.");

export interface PickedBox {
  id: number;
  box_id?: string | null;
  transaction_no?: string | null;
  weight_kg: number;
  item_mark?: string | null;
  inward_dt?: string | null;
  unit?: string | null;
  inward_no?: string | null;
  item_description?: string | null;
  vakkal?: string | null;
  lot_no?: string | null;
  no_of_cartons?: number | null;
  total_inventory_kgs?: number | null;
  group_name?: string | null;
  storage_location?: string | null;
}

export const ColdStorageApi = {
  // Both companies' cold tables, merged. With from_warehouse each lot also says how many of
  // its boxes can go from that site (available_here). unit / storage_location compare sites.
  searchStocks,

  // The search at one cold store (`store`, also the from_warehouse its counts are from):
  // the lots whose unit names it, and those whose storage location does (or whose location
  // names no site and unit does), merged in the server's FIFO order, each lot once. So the
  // store's own lots are not pushed out of the limit by older lots of other stores. A row
  // of the second kind whose unit names another store is kept: the page says where it is.
  searchStoreStocks: async (
    p: Omit<SearchParams, "unit" | "storage_location" | "from_warehouse"> & { store: string },
  ): Promise<ColdSearchResult> => {
    const { store, ...rest } = p;
    const limit = rest.limit ?? 50;
    const [byUnit, byLocation] = await Promise.all([
      searchStocks({ ...rest, limit, unit: store, from_warehouse: store }),
      searchStocks({ ...rest, limit, storage_location: store, from_warehouse: store }),
    ]);
    const seen = new Set<string>();
    const results = [...byUnit.results, ...byLocation.results]
      .filter((r) => { const k = `${r.company}-${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort(fifo).slice(0, limit);
    return { results, total: results.length };
  },

  // FIFO boxes of the picked lot row: its item, lot and inward, at its unit and storage
  // location, of its item mark (the search groups by the mark and counts available_here per
  // mark; left out, any mark). Read only. With from_warehouse a box goes by its latest
  // transfer as a dispatch from that site takes it (never on a transfer, or received and
  // acknowledged there; on an edit, transfer_id's own boxes don't count); without it any box
  // ever on a transfer is skipped. `exclude` ("box_id|transaction_no") are the boxes already
  // on the list.
  pickBoxes: (p: {
    company: string; item_description: string; lot_no: string; inward_no: string; qty: number;
    unit: string; storage_location: string; item_mark?: string | null;
    from_warehouse?: string | null; transfer_id?: number | null; exclude?: readonly string[];
  }) => {
    const { exclude, ...rest } = p;
    const query = qs({ ...rest, exclude: exclude?.length ? exclude.join(",") : undefined },
      ["inward_no", "unit", "storage_location", "item_mark"]);
    return getJson<{ boxes: PickedBox[] }>(`${BASE}/stocks/pick-boxes${query}`, "Could not pick boxes.");
  },
};

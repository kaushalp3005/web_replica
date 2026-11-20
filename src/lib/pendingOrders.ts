// Pending Orders dashboard data: GET /api/v1/so/pending-orders.
//
// Every SO line in the "Pending orders - Floor wise plan" sheet's columns
// (ordered - invoiced = pending; invoices come from SO Creation's Sales
// Register upload). Fully dispatched lines are included so the screen can
// filter them; blank cells are left out of each row. Money columns are not
// sent to roles that may not see cost (`sees_cost` false, `columns` shorter).

import { apiFetch, readApiErrorMessage } from "./auth";

/** One sheet row, keyed by the sheet's column titles ("SO No", "Pending Qty."...). */
export type PendingRow = { so_line_id: number } & Record<string, string | number | undefined>;

export interface PendingOrdersResponse {
  as_of: string;
  columns: string[];
  sees_cost: boolean;
  so_lines: number;
  invoices: {
    tables: boolean;
    invoices: number;
    lines_on_so_line: number;
    first_date: string | null;
    last_date: string | null;
  };
  rows: PendingRow[];
}

export async function fetchPendingOrders(signal?: AbortSignal): Promise<PendingOrdersResponse> {
  const res = await apiFetch(`/api/v1/so/pending-orders`, { signal });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, `Pending orders HTTP ${res.status}`));
  return (await res.json()) as PendingOrdersResponse;
}

/** The sheet's ageing buckets, in their natural order. */
export const AGEING_ORDER = ["0", "1-5", "6-10", "11-15", "16-20", ">20"] as const;

export const DATE_COLUMNS = new Set([
  "Order Date", "PO Date", "Dispatch Date", "Current Date", "PO Closur Date1",
  "Planned Dispatched Date", "Pending Planned Dispatched Date",
]);
export const MONEY_COLUMNS = new Set(["Basic Rate", "Basic Value", "Pending Value", "Dispatch Value"]);
export const QTY_COLUMNS = new Set(["Uom", "Total Kg", "Purchase Order Qty.", "Dispatch Qty.", "Pending Qty."]);
export const INT_COLUMNS = new Set(["Days", "Over Days"]);

export const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** A cell as the sheet shows it. */
export function formatCell(col: string, v: string | number | undefined): string {
  if (v === undefined || v === null || v === "") return "";
  if (DATE_COLUMNS.has(col)) {
    const s = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
  }
  if (col === "Line Fill") return `${(num(v) * 100).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
  if (col === "In CR") return num(v).toLocaleString("en-IN", { maximumFractionDigits: 4 });
  if (MONEY_COLUMNS.has(col)) return num(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (QTY_COLUMNS.has(col)) return num(v).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  if (INT_COLUMNS.has(col)) return num(v).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return String(v);
}

export function isNumericColumn(col: string): boolean {
  return MONEY_COLUMNS.has(col) || QTY_COLUMNS.has(col) || INT_COLUMNS.has(col)
    || col === "Line Fill" || col === "In CR";
}

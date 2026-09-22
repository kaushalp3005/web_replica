// Per-job-card BOM changes API client —
// /api/v1/production/job-cards-v2/{id}/bom-changes (server_replica production router).
// Every refusal surfaces as BomChangeError carrying the server's code and message
// (e.g. article_has_records names the job card and batch holding the figures).

import { apiFetch, readApiErrorMessage } from "./auth";
import type { BomChanges } from "./job-card-bom-rules";

export class BomChangeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "BomChangeError";
    this.code = code;
    this.status = status;
  }
}

export type BomChangeResult = {
  action: "removed" | "add_undone" | "added" | "restored";
  restored: boolean;
  open_requisition_ids: number[];
  bom_changes: BomChanges;
  bom_lines: unknown[];
};

const base = (jobCardId: number) => `/api/v1/production/job-cards-v2/${jobCardId}/bom-changes`;

async function read(res: Response, fallback: string): Promise<BomChangeResult> {
  if (res.ok) return (await res.json()) as BomChangeResult;
  const body = (await res.clone().json().catch(() => null)) as { detail?: { error?: string } } | null;
  throw new BomChangeError(await readApiErrorMessage(res, fallback), body?.detail?.error ?? "error", res.status);
}

export async function removeBomArticle(
  jobCardId: number, body: { material_sku_name: string; note?: string | null },
): Promise<BomChangeResult> {
  const res = await apiFetch(base(jobCardId), {
    method: "POST", body: JSON.stringify({ action: "remove", ...body }),
  });
  return read(res, "Couldn't remove the article.");
}

/** Adds by `sku_id` (+ Add article) or by `material_sku_name` with an optional
 *  `item_type` hint (Use on other floor stock; the server picks the SKU by name). */
export async function addBomArticle(
  jobCardId: number,
  body: {
    sku_id?: number;
    material_sku_name?: string;
    item_type?: string;
    required_qty?: number | null;
    note?: string | null;
  },
): Promise<BomChangeResult> {
  const res = await apiFetch(base(jobCardId), {
    method: "POST", body: JSON.stringify({ action: "add", ...body }),
  });
  return read(res, "Couldn't add the article.");
}

export async function undoBomChange(jobCardId: number, changeId: number): Promise<BomChangeResult> {
  const res = await apiFetch(`${base(jobCardId)}/${changeId}`, { method: "DELETE" });
  return read(res, "Couldn't undo the change.");
}

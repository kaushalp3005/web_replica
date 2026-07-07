// Packing Details API client. Targets the replica backend at
// /api/v1/packing-details/* (proxied same-origin — see next.config.ts). Types
// match server_replica/app/modules/packing/schemas.py 1:1. The list endpoints
// return a BARE ARRAY (not a {records,total} envelope), and DELETE returns 204
// with no body — both handled below.

import { apiFetch, readApiErrorMessage } from "./auth";

const BASE = "/api/v1/packing-details";

// ── Types (mirror PackingDetailOut / *Request) ────────────────────────────
export interface PackingDetail {
  packing_id: number;
  batch_code: string;
  article_name: string;
  details: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PackingDetailCreate {
  batch_code: string;
  article_name: string;
  details?: Record<string, unknown>;
}

export interface PackingDetailUpdate {
  batch_code?: string;
  article_name?: string;
  details?: Record<string, unknown>;
}

export interface ListParams {
  batch_code?: string;
  article_name?: string;
  limit?: number;
  offset?: number;
}

export interface BatchTokenResponse {
  batch_token: string;
}

// ── Fetch helpers (mirror lib/transfer.ts) ────────────────────────────────
function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

async function sendJson<T>(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
  fallback: string,
): Promise<T> {
  const res = await apiFetch(path, { method, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return (await res.json()) as T;
}

// ── CRUD ──────────────────────────────────────────────────────────────────
export function listPackingDetails(params: ListParams = {}): Promise<PackingDetail[]> {
  return getJson<PackingDetail[]>(
    `${BASE}${qs({
      batch_code: params.batch_code,
      article_name: params.article_name,
      limit: params.limit,
      offset: params.offset,
    })}`,
    "Failed to load packing details.",
  );
}

export function getPackingDetail(id: number): Promise<PackingDetail> {
  return getJson<PackingDetail>(`${BASE}/${id}`, "Failed to load packing detail.");
}

export function createPackingDetail(body: PackingDetailCreate): Promise<PackingDetail> {
  return sendJson<PackingDetail>(BASE, "POST", body, "Failed to create packing detail.");
}

export function updatePackingDetail(
  id: number,
  body: PackingDetailUpdate,
): Promise<PackingDetail> {
  return sendJson<PackingDetail>(`${BASE}/${id}`, "PATCH", body, "Failed to update packing detail.");
}

export async function deletePackingDetail(id: number): Promise<void> {
  // Backend returns 204 No Content — do NOT parse a JSON body on success.
  const res = await apiFetch(`${BASE}/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, "Failed to delete packing detail."));
}

// ── Encrypted batch access ────────────────────────────────────────────────
export function mintBatchToken(batchCode: string): Promise<BatchTokenResponse> {
  return sendJson<BatchTokenResponse>(
    `${BASE}/batch-token`,
    "POST",
    { batch_code: batchCode },
    "Failed to mint batch token.",
  );
}

export function fetchByEncryptedBatch(batchToken: string): Promise<PackingDetail[]> {
  return sendJson<PackingDetail[]>(
    `${BASE}/by-encrypted-batch`,
    "POST",
    { batch_token: batchToken },
    "Failed to fetch by encrypted batch.",
  );
}

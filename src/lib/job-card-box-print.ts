// Manual print on the job card's Raw Material tab —
// POST /api/v1/production/job-cards-v2/{id}/box-scans/print (server_replica
// production router). In one transaction the server mints each box in sfg_box
// as an RM box of the job card, as Stores' manual print does, and records it in
// jc_box_scan for this job card, so it lands in the tab's list straight away.
// Every refusal surfaces as BoxPrintError carrying the server's code, message
// and details (box_number_taken names the taken numbers and the next free one).

import { apiFetch, readApiErrorMessage } from "./auth";

export class BoxPrintError extends Error {
  readonly code: string;
  readonly status: number;
  /** Whatever else the server's detail carried, e.g. box_numbers / next_box_number. */
  readonly details: Record<string, unknown>;
  constructor(message: string, code: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BoxPrintError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** One box to print, as checked by lib/box-scan's checkBoxesForPrint. */
export interface JobCardPrintBoxLine {
  box_number: number;
  net_weight: number;
  gross_weight: number | null;
  count: number | null;
  lot_number: string | null;
}

/** A printed box, saved in sfg_box and jc_box_scan. */
export interface JobCardPrintedBox {
  /** The sfg_box carton id: the sticker's box id. */
  box_code: string;
  box_number: number;
  article: string;
  net_weight: number;
  gross_weight: number | null;
  count: number | null;
  lot_number: string | null;
}

/** The boxes come back in the order they were sent. */
export interface JobCardBoxPrintResult {
  job_card_id: number;
  job_card_number: string | null;
  entity: string | null;
  boxes: JobCardPrintedBox[];
}

export async function printJobCardBoxes(
  jobCardId: number,
  body: { article: string; boxes: JobCardPrintBoxLine[] },
): Promise<JobCardBoxPrintResult> {
  const res = await apiFetch(`/api/v1/production/job-cards-v2/${jobCardId}/box-scans/print`, {
    method: "POST", body: JSON.stringify(body),
  });
  if (res.ok) return (await res.json()) as JobCardBoxPrintResult;
  const data = (await res.clone().json().catch(() => null)) as { detail?: unknown } | null;
  const detail = data?.detail && typeof data.detail === "object" && !Array.isArray(data.detail)
    ? { ...(data.detail as Record<string, unknown>) }
    : {};
  const code = typeof detail.error === "string" ? detail.error : "error";
  delete detail.error;
  delete detail.message;
  throw new BoxPrintError(await readApiErrorMessage(res, "Couldn't save the boxes."), code, res.status, detail);
}

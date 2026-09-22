// Box QR scanning, the parts that don't need a camera or a server.
//
// Stores → Production Indents' Scan material dialog uses the job card's scanner
// and a manual sticker print; the server stores the boxes (floor-requisitions
// /boxes) and repeats these checks. The job card's Raw Material tab reads a
// sticker the same way (its handleScan): warehouse labels carry JSON {"tx","bi"},
// everything else is a bare box id. Its Manual print (_RmManualPrint) runs the
// same print checks and saves straight to the job card (jc_box_scan).

export type BoxQr = { code: string; transaction_no: string | null };

/** The box a scanned sticker stands for. An empty `code` means there is none. */
export function parseBoxQr(raw: string): BoxQr {
  const text = raw.trim();
  try {
    const j: unknown = JSON.parse(text);
    if (j && typeof j === "object" && typeof (j as { bi?: unknown }).bi === "string") {
      const { bi, tx } = j as { bi: string; tx?: unknown };
      const txText = typeof tx === "string" ? tx.trim() : "";
      return { code: bi.trim(), transaction_no: txText || null };
    }
  } catch {
    /* not JSON — a bare box id */
  }
  return { code: text, transaction_no: null };
}

/** What the operator typed in the manual print form. Net weight is required. */
export type PrintDetailInput = { netW: string; grossW: string; count: string };
export type PrintDetail = { net_weight: number; gross_weight: number | null; count: number | null };
export type PrintDetailCheck = { ok: true; detail: PrintDetail } | { ok: false; message: string };

// Blank → null (not entered). Anything else must be a finite number ≥ 0 (whole
// for a count), or the entry is refused with a message, never silently dropped.
function readAmount(text: string, whole: boolean): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) return undefined;
  return n;
}

export function checkPrintDetail(input: PrintDetailInput): PrintDetailCheck {
  const net = readAmount(input.netW, false);
  if (net === null) return { ok: false, message: "Enter the net weight." };
  if (net === undefined || net === 0) return { ok: false, message: "Net wt must be more than 0." };
  const gross = readAmount(input.grossW, false);
  if (gross === undefined) return { ok: false, message: "Gross wt must be a number, 0 or more." };
  if (gross !== null && gross < net) return { ok: false, message: "Gross wt can't be less than net wt." };
  const count = readAmount(input.count, true);
  if (count === undefined) return { ok: false, message: "Count must be a whole number, 0 or more." };
  return { ok: true, detail: { net_weight: net, gross_weight: gross, count } };
}

/** The next "Box #" for a request: one past the highest already taken (boxes on
 *  the request and in the drafts). */
export function nextBoxNumber(taken: readonly (number | null | undefined)[]): number {
  let highest = 0;
  for (const n of taken) if (n != null && n > highest) highest = n;
  return highest + 1;
}

/** One row of a generated box table, as typed. */
export type BoxToPrint = { box_number: number; gross_weight: string; net_weight: string; count: string };
export type CheckedBox = PrintDetail & { box_number: number };
export type BoxesCheck = { ok: true; boxes: CheckedBox[] } | { ok: false; message: string };

// A message naming every bad box would bury the dialog; three is enough to act on.
const MAX_NAMED = 3;

/** Every box about to be printed must pass checkPrintDetail; a refusal names the boxes. */
export function checkBoxesForPrint(boxes: readonly BoxToPrint[]): BoxesCheck {
  if (boxes.length === 0) return { ok: false, message: "No boxes to print." };
  const good: CheckedBox[] = [];
  const problems: string[] = [];
  for (const b of boxes) {
    const c = checkPrintDetail({ netW: b.net_weight, grossW: b.gross_weight, count: b.count });
    if (c.ok) good.push({ box_number: b.box_number, ...c.detail });
    else problems.push(`Box ${b.box_number}: ${c.message}`);
  }
  if (problems.length === 0) return { ok: true, boxes: good };
  const more = problems.length - MAX_NAMED;
  const tail = more > 0 ? ` …and ${more} more box${more === 1 ? "" : "es"}.` : "";
  return { ok: false, message: problems.slice(0, MAX_NAMED).join(" ") + tail };
}

// A box Stores sent for this job card (its floor_requisition_box row), as the
// job card's box-scans calls return it; null when Stores has no record of the
// box for this job card. Printed boxes carry their "Box #", scanned ones don't.
export type StoresRef = { requisition_id: number; box_number: number | null; source: string | null };

/** The line under a scanned box that Stores sent; null when Stores didn't send it. */
export function storesRefLabel(ref: StoresRef | null | undefined): string | null {
  if (!ref) return null;
  const box = ref.box_number != null ? ` · Box ${ref.box_number}` : "";
  return `Sent by Stores · Request #${ref.requisition_id}${box}`;
}

/** The toast once a scanned box is stored against the job card. */
export function storedMessage(code: string, ref: StoresRef | null | undefined): string {
  return ref ? `Stored ${code} · from Stores request #${ref.requisition_id}` : `Stored ${code}`;
}

// A box printed on the job card's own Raw Material tab (its sfg_box row is an RM
// box of this job card), as the box-scans list returns it; null for any other box.
export type PrintedRef = { box_number: number | null; lot_number: string | null };

/** The line under a scanned box that was printed on this job card; null otherwise. */
export function printedLabel(ref: PrintedRef | null | undefined): string | null {
  if (!ref) return null;
  return ref.box_number != null ? `Printed on this job card · Box ${ref.box_number}` : "Printed on this job card";
}

// The job card refuses every Box # at or below its last one, and prints (a range
// first, another section first, the WIP boxes) can use the numbers past a draft
// row. Its rows are renumbered instead of being lost: no sticker carries them yet.

/** Every draft row still to print, numbered again from `first` in order across
 *  the sections, each keeping what was typed into it. */
export function renumberDrafts<S extends { boxes: readonly { box_number: number }[] | null }>(
  sections: readonly S[], first: number,
): S[] {
  let n = first;
  return sections.map((s) => (s.boxes ? { ...s, boxes: s.boxes.map((b) => ({ ...b, box_number: n++ })) } : s));
}

/** The message once the draft is renumbered: the taken Box #s and where it now starts. */
export function renumberedMessage(taken: readonly number[], first: number): string {
  const more = taken.length - MAX_NAMED;
  const named = taken.slice(0, MAX_NAMED).join(", ") + (more > 0 ? ` and ${more} more` : "");
  const used = taken.length === 0 ? "Some box numbers are"
    : taken.length === 1 ? `Box number ${named} is` : `Box numbers ${named} are`;
  return `${used} already used on this job card, so the boxes still to print now start at Box ${first}. Print them again.`;
}

/** The job card's RM articles for Manual print's quick picks: BOM order, each
 *  name once (first spelling kept), blanks and non-RM lines left out. */
export function rmArticleOptions(
  lines: readonly { material_sku_name: string | null | undefined; item_type: string | null | undefined }[],
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const l of lines) {
    if ((l.item_type ?? "").trim().toLowerCase() !== "rm") continue;
    const name = (l.material_sku_name ?? "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

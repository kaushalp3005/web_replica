// Which entries of the receive page a pending receipt has acknowledged, by the server's
// rule (backend lookup_service._acknowledges, which close with shortage and the box rule
// read), so the page shows what the server will count:
//
//  • a receipt row that names the entry's box row (transfer_out_box_id) acknowledges it;
//  • else a row with the entry's box_id (or IMS's original_box_id, the id its box swap
//    replaced) and its transaction_no, both trimmed;
//  • a row without a transaction_no (a line entry, or an older client) by box_id alone.
// Entries are keyed by their own key (the box row's id), never by box_id: two boxes of one
// transfer that share a box_id under different transactions are two entries, and one is
// acknowledged without the other.
//
// Pure functions; exercised by _receipt.test.ts
// (`node src/app/modules/transfer/transferIn/_receipt.test.ts`).

/** An entry as the match reads it: its key, its box_id / transaction_no as dispatched, and
 *  its box row (null for an entry expanded from a line). */
export interface ReceiptEntry {
  key: string;
  box_id: string;
  transaction_no: string;
  out_box_id: number | null;
}

/** A receipt box row as the match reads it. */
export interface ReceiptRow {
  box_id?: string | null;
  transaction_no?: string | null;
  transfer_out_box_id?: number | null;
  original_box_id?: string | null;
}

const trim = (s: string | null | undefined) => (s || "").trim();

/** Whether receipt row `row` acknowledges entry `e` (see the header). */
export function acknowledges(row: ReceiptRow, e: ReceiptEntry): boolean {
  if (row.transfer_out_box_id != null && e.out_box_id != null && row.transfer_out_box_id === e.out_box_id) return true;
  const bid = trim(e.box_id);
  if (!bid || (trim(row.box_id) !== bid && trim(row.original_box_id) !== bid)) return false;
  const tno = trim(row.transaction_no);
  return !tno || tno === trim(e.transaction_no);
}

/** Each entry the receipt's `rows` acknowledge, by entry key, with the first row that does
 *  (an issue a box was flagged with is on that row). Rows that acknowledge no entry (a box
 *  that is not on the transfer) are left out. */
export function acknowledgedEntries<R extends ReceiptRow>(entries: readonly ReceiptEntry[], rows: readonly R[]): Map<string, R> {
  const out = new Map<string, R>();
  for (const e of entries) {
    const row = rows.find((r) => acknowledges(r, e));
    if (row) out.set(e.key, row);
  }
  return out;
}

/** The entries an acknowledge-batch `conflicts` names (box_id and transaction_no as sent,
 *  trimmed): the boxes it did not record. */
export function conflictedKeys(
  entries: readonly ReceiptEntry[],
  conflicts: readonly { box_id?: string | null; transaction_no?: string | null }[],
): Set<string> {
  const out = new Set<string>();
  for (const c of conflicts) {
    for (const e of entries) {
      if (trim(e.box_id) === trim(c.box_id) && trim(e.transaction_no) === trim(c.transaction_no)) out.add(e.key);
    }
  }
  return out;
}

/** Whether another entry shares `e`'s box_id: un-acknowledging it must then name its
 *  transaction, or every receipt row of that box_id goes. */
export function sharesBoxId(entries: readonly ReceiptEntry[], e: ReceiptEntry): boolean {
  const bid = trim(e.box_id);
  return !!bid && entries.some((x) => x.key !== e.key && trim(x.box_id) === bid);
}

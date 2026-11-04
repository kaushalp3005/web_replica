// Which boxes a request's dispatch may carry: the server's rule (backend transfer
// create_service, on POST /transfers and PUT /transfers/{id} of a request's transfer), so
// Scan & send and the edit form refuse at scan time what a save would refuse, and the
// "Items from request" tracker counts boxes against the lines as the server does.
//
//  • Article names are compared with whitespace collapsed and upper-cased (articleKey);
//    lots are trimmed and otherwise compared as they are (lotKey).
//  • Lines that name a lot take boxes of the same article AND lot first; then lines with
//    no lot take boxes of the same article with any lot. Each box counts once and a line
//    takes at most its qty boxes (a request line's qty is a number of boxes). Boxes are
//    taken in list order, so of two boxes competing for the last place the one added
//    later is left over.
//  • A box no line takes is refused (boxRefusal says why, in the server's words): its
//    article is not on the request, it is another lot than the request asks for, or the
//    request's qty of it is already on the dispatch. Several refusals read as one message
//    as the server's 409 lists them (refusalText).
// A quantity-only entry ('DIRECT', or no box_id / transaction_no) is not a box (isRealBox),
// and a request's dispatch needs at least one real box (NO_BOX_MESSAGE).
//
// Pure functions; exercised by transferBoxMatch.test.ts (`node src/lib/transferBoxMatch.test.ts`).

/** An article name as a refusal names it: whitespace collapsed. */
export function articleName(s: string | null | undefined): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** An article name as the match compares it: whitespace collapsed, upper-cased. */
export function articleKey(s: string | null | undefined): string {
  return articleName(s).toUpperCase();
}

/** A lot as the match compares it: trimmed. */
export function lotKey(s: string | null | undefined): string {
  return (s || "").trim();
}

/** A request line's qty as a whole number of boxes (the server's int(qty)). */
export function lineQty(q: string | number | null | undefined): number {
  const n = Math.floor(typeof q === "number" ? q : parseFloat(q ?? "") || 0);
  return n > 0 ? n : 0;
}

/** A request line as the match reads it; qty is whole boxes (lineQty). */
export interface MatchLine { article: string; lot: string; qty: number }
/** A box as the match reads it. */
export interface MatchBox { boxId: string; article: string; lot: string }

/** A real box: a box_id and a transaction_no, the transaction not 'DIRECT' (as the server's
 *  re-use guard reads them). */
export function isRealBox(b: { boxId: string; transactionNo: string }): boolean {
  const tno = b.transactionNo.trim();
  return !!b.boxId.trim() && !!tno && tno !== "DIRECT";
}

/** The server's refusal of a request's dispatch with no real box. */
export const NO_BOX_MESSAGE = "Scan at least one box before sending.";

export interface MatchResult {
  /** How many boxes each line takes, by line index. */
  taken: number[];
  /** The indices of the boxes no line takes, in list order. */
  leftover: number[];
}

/** Match `boxes` to `lines` (see the header): what each line takes and what is left over. */
export function matchBoxes(lines: MatchLine[], boxes: Pick<MatchBox, "article" | "lot">[]): MatchResult {
  const keys = boxes.map((b) => ({ art: articleKey(b.article), lot: lotKey(b.lot) }));
  const free = boxes.map(() => true);
  const taken = lines.map(() => 0);
  const fill = (i: number, art: string, lot: string | null) => {
    for (let j = 0; j < keys.length && taken[i] < lines[i].qty; j++) {
      if (free[j] && keys[j].art === art && (lot === null || keys[j].lot === lot)) {
        free[j] = false;
        taken[i] += 1;
      }
    }
  };
  lines.forEach((l, i) => { const lot = lotKey(l.lot); if (lot) fill(i, articleKey(l.article), lot); });
  lines.forEach((l, i) => { if (!lotKey(l.lot)) fill(i, articleKey(l.article), null); });
  return { taken, leftover: free.flatMap((f, j) => (f ? [j] : [])) };
}

/** Why the request (`requestNo`, `lines`) doesn't take `box` once its lines are full:
 *  not on the request, another lot, or over the request's qty — worded as the server's
 *  409 words it, so a box refused here and on save reads the same. */
export function boxRefusal(lines: MatchLine[], box: MatchBox, requestNo: string): string {
  const id = box.boxId.trim() || "(no box id)";
  const art = articleKey(box.article), lot = lotKey(box.lot);
  const mine = lines.filter((l) => articleKey(l.article) === art);
  if (!mine.length) return `Box ${id} is ${articleName(box.article) || "(no article)"}, which is not on request ${requestNo}.`;
  const name = articleName(mine[0].article);
  const takers = mine.filter((l) => !lotKey(l.lot) || lotKey(l.lot) === lot);
  if (!takers.length) {
    const lots = [...new Set(mine.map((l) => lotKey(l.lot)))].join(", ");
    return `Box ${id} is lot ${lot || "(none)"}; request ${requestNo} asks for lot ${lots} of ${name}.`;
  }
  const qty = takers.reduce((s, l) => s + l.qty, 0);
  return `Request ${requestNo} asks for ${qty} box(es) of ${name}; all are already on this dispatch.`;
}

/** Refusals named before the rest are counted (the server's cap). */
const REFUSAL_MAX_LISTED = 10;

/** Several refusals as one message, as the server's 409 lists them: one alone as it is;
 *  more as sentences, the first REFUSAL_MAX_LISTED, then "And <n> more." for the rest.
 *  Every box's refusal counts, repeats too. */
export function refusalText(messages: string[]): string {
  if (messages.length === 1) return messages[0];
  const listed = messages.slice(0, REFUSAL_MAX_LISTED).map((m) => (m.endsWith(".") ? m : `${m}.`));
  if (messages.length > REFUSAL_MAX_LISTED) listed.push(`And ${messages.length - REFUSAL_MAX_LISTED} more.`);
  return listed.join(" ");
}

/** Why `box` can't be added to a dispatch of the request that already holds `boxes`, or null
 *  when the request takes it. Boxes are taken in list order and the new one comes last, so
 *  it is left over exactly when the request has no room for it (boxes already left over
 *  stay so and don't count against it). */
export function refuseNewBox(lines: MatchLine[], boxes: MatchBox[], box: MatchBox, requestNo: string): string | null {
  const { leftover } = matchBoxes(lines, [...boxes, box]);
  return leftover.includes(boxes.length) ? boxRefusal(lines, box, requestNo) : null;
}

/** Every box of the dispatch that the request doesn't take, by index in `boxes`, with its
 *  refusal (empty when the request takes them all). */
export function refusedBoxes(lines: MatchLine[], boxes: MatchBox[], requestNo: string): { index: number; message: string }[] {
  return matchBoxes(lines, boxes).leftover.map((index) => ({ index, message: boxRefusal(lines, boxes[index], requestNo) }));
}

// Which SFG each process of a job-card chain makes, as the Create / Edit Job
// Card pop-up and the Merge process pop-up fill it in. Agreed 2026-10-27:
//   • only the last process before packing gets the article's standard SFG on
//     its own (it is what packing takes in), and only when it has none; earlier
//     processes stay blank unless the planner types one;
//   • the rule follows the rows — add, move, remove, merge, and again at Save —
//     so a standard SFG filled in this way moves with the last process;
//   • a saved or typed SFG is never replaced by the standard one;
//   • a started card keeps the SFG it makes (the server keeps it too);
//   • merged processes make the later one's SFG: "A + B" is an SFG nothing knows.
// The server stays the authority (job_card_v2 create / replace / apply-edits /
// merge). Pure, so it is tested without a browser (job-card-sfg.test.ts).

/** One row of the pop-up's process list, as far as these rules need it. The
 *  last row is the card that makes the finished goods. */
export interface SfgRow {
  process: string;
  floor: string;
  sfgOutput: string;
  /** sfgOutput is the standard SFG filled in by seedStandardSfg (or "Use"),
   *  not one saved or typed — so it follows the last process. */
  sfgAuto?: boolean;
  /** A started card: its SFG stays as saved. */
  started?: boolean;
}

/** Row whose SFG packing takes in: the last process before the finished-goods
 *  row. -1 for a one-row chain, which goes from raw material to finished goods. */
export function sfgFeedIndex(rowCount: number): number {
  return rowCount >= 2 ? rowCount - 2 : -1;
}

/** The rows with the standard SFG where it belongs: on the last process before
 *  packing when that has none (or has the standard from an earlier fill), and
 *  taken off any other row it was filled into. Saved, typed and started rows'
 *  SFGs are left alone. */
export function seedStandardSfg<T extends SfgRow>(rows: readonly T[], standard: string): T[] {
  const std = standard.trim();
  const feed = sfgFeedIndex(rows.length);
  return rows.map((r, i) => {
    if (r.started) return r;
    if (i === feed && (r.sfgAuto || !r.sfgOutput.trim())) {
      if (std) return { ...r, sfgOutput: std, sfgAuto: true };
      return r.sfgAuto ? { ...r, sfgOutput: "", sfgAuto: false } : r;
    }
    if (i !== feed && r.sfgAuto) return { ...r, sfgOutput: "", sfgAuto: false };
    return r;
  });
}

/** Rows `picked` (2 or more indices) merged into one at the first picked slot:
 *  process names joined with " + ", the floor kept only when they agree (else
 *  blank, to pick again), and the SFG of the latest picked process that has
 *  one — the merged step ends where that one ended. The merged row is a new
 *  process (no saved card). */
export function mergeProcessRows<T extends SfgRow>(rows: readonly T[], picked: Iterable<number>): (T | SfgRow)[] {
  const idxs = [...new Set(picked)].filter((i) => i >= 0 && i < rows.length).sort((a, b) => a - b);
  if (idxs.length < 2) return rows.slice();
  const sel = idxs.map((i) => rows[i]);
  const floors = new Set(sel.map((r) => r.floor).filter(Boolean));
  const later = [...sel].reverse().find((r) => r.sfgOutput.trim());
  const merged: SfgRow = {
    process: sel.map((r) => r.process || "—").join(" + "),
    floor: floors.size === 1 ? [...floors][0] : "",
    sfgOutput: later ? later.sfgOutput : "",
    sfgAuto: later?.sfgAuto === true,
  };
  const drop = new Set(idxs.slice(1));
  return rows.flatMap((r, i) => (i === idxs[0] ? [merged] : drop.has(i) ? [] : [r]));
}

/** Pieces to send for one product of a merged run: its planned pieces, scaled
 *  when its kg was changed and rounded to whole pieces. null when the line
 *  plans no pieces, has no planned kg to scale by, or it rounds to none (the
 *  server's job_card_v2._scaled_units). */
export function memberPieces(
  plannedUnits: number | null | undefined,
  plannedKg: number | null | undefined,
  qtyKg: number,
): number | null {
  const pu = Number(plannedUnits), pk = Number(plannedKg);
  if (plannedUnits == null || plannedKg == null || !(pu > 0) || !(pk > 0) || !(qtyKg > 0)) return null;
  if (Math.abs(qtyKg - pk) < 0.0005) return pu;
  const n = Math.round((pu * qtyKg) / pk);
  return n > 0 ? n : null;
}

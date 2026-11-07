// Saving a plan line's process route from the Plan List process picker: which of
// the line's saved steps to delete, patch, add and whether to reorder, so the
// line ends up with exactly the picker's rows in the picker's order. Pure, so it
// is tested without a browser (planStepSync.test.ts).

type SavedStep = {
  step_id?: number | null;
  step_order?: number | null;
  process_name?: string | null;
  stage?: string | null;
  floor?: string | null;
};

/** A picker row. `stepId` ties it to the saved step it was loaded from; rows
 *  added or produced by a merge have none. */
export type StepRow = { process: string; floor: string; stepId?: number };

function savedProcess(s: SavedStep): string {
  return (s.process_name || s.stage || "").trim();
}

/** A line's saved steps as picker rows, in step order. */
export function rowsFromSteps(steps: SavedStep[] | null | undefined): StepRow[] {
  return [...(steps ?? [])]
    .sort((a, b) => (a.step_order ?? Infinity) - (b.step_order ?? Infinity))
    .map((s) => ({
      process: savedProcess(s),
      floor: s.floor ?? "",
      ...(s.step_id != null ? { stepId: s.step_id } : {}),
    }));
}

/** The route as Create Job Card will read it: a one-step route becomes that
 *  process then Packaging on the same floor (job_card_v2.get_line_job_card_config);
 *  two or more steps are read as they are, the last being packaging. */
export function jobCardRoute(rows: StepRow[]): StepRow[] {
  if (rows.length !== 1) return rows;
  return [rows[0], { process: "Packaging", floor: rows[0].floor }];
}

export type StepPatch = { stepId: number; process_name?: string; floor?: string | null };

export type StepChanges = {
  deletes: number[];      // step ids no longer in the picker
  patches: StepPatch[];   // kept steps whose process or floor changed
  adds: number[];         // indexes (into the picker rows) to add, in order
  reorder: boolean;       // true when the server's order after the adds differs
};

/** The calls that turn `saved` (the line's steps, in step order) into `rows`.
 *  The server appends added steps at the end, so `reorder` says whether the
 *  line must be reordered once they exist. */
export function planStepChanges(saved: SavedStep[], rows: StepRow[]): StepChanges {
  const byId = new Map<number, SavedStep>();
  for (const s of saved) if (s.step_id != null) byId.set(s.step_id, s);

  // A row keeps its step when its id is one of the line's and not already taken.
  const kept = new Set<number>();
  const keeps = rows.map((r) => {
    if (r.stepId == null || !byId.has(r.stepId) || kept.has(r.stepId)) return false;
    kept.add(r.stepId);
    return true;
  });

  const deletes = saved
    .map((s) => s.step_id)
    .filter((id): id is number => id != null && !kept.has(id));

  const patches: StepPatch[] = [];
  const adds: number[] = [];
  rows.forEach((r, i) => {
    if (!keeps[i]) { adds.push(i); return; }
    const s = byId.get(r.stepId as number) as SavedStep;
    const patch: StepPatch = { stepId: r.stepId as number };
    const process = r.process.trim();
    if (process !== savedProcess(s)) patch.process_name = process;
    const floor = r.floor.trim() || null;
    if (floor !== (s.floor || null)) patch.floor = floor;
    if (Object.keys(patch).length > 1) patches.push(patch);
  });

  // After deletes and adds the server holds the kept steps in their saved order,
  // then the added ones; reorder when that isn't the picker's order.
  const token = (i: number) => (keeps[i] ? `s${rows[i].stepId}` : `n${i}`);
  const wanted = rows.map((_, i) => token(i));
  const after = [
    ...saved.filter((s) => s.step_id != null && kept.has(s.step_id)).map((s) => `s${s.step_id}`),
    ...adds.map((i) => `n${i}`),
  ];
  const reorder = wanted.some((t, i) => t !== after[i]);

  return { deletes, patches, adds, reorder };
}

// Which floors a person may put on a job-card chain: one source for every floor
// picker (Create / Edit Job Card, Merge process, Plan Detail, the plan builder)
// and for the check before Save.
//
// The rule (user decision, 2026-10-27; the server's half is backend
// app/modules/production/services/chain_floors.py, and it stays the authority —
// the scope here comes from the cached /me and can lag an admin's change):
//   • people who can approve plans (planners) may use any floor of the plan's
//     factory;
//   • everyone else with floor grants (floor managers, team leaders) only their
//     own floors;
//   • admins and people with no floor grants: every floor.
// Grants compare ignoring case and outer spaces, as the server does, so a grant
// typed "roasting area" covers "Roasting Area". Only the floors a change TOUCHES
// are checked — the floors of the cards it adds, moves (old and new) or removes —
// so changing only the quantity checks none.

import { normaliseWarehouseCode } from "./warehouseScope.ts";

/** The floors a job card can go to, per factory: the declared floors (backend
 *  stock_take/floors.py) less the store floors (Store, A185 Stores, A185 Stores
 *  Rack, A185 Cold), which hold stock rather than run a stage. Keyed by
 *  normaliseWarehouseCode. */
export const PRODUCTION_FLOORS: Readonly<Record<string, readonly string[]>> = {
  W202: [
    "Lower Basement", "Upper Basement",
    "First Floor", "First Floor Mezz",
    "Second Floor", "Second Floor Mezz",
    "Terrace",
  ],
  A185: [
    "Roasting Area", "Mezzanine", "Sorting Area", "Printing Area",
    "Dmart Production Area", "Dmart Packing Area",
    "Cheese Floor", "FG store", "FFS Packing Area",
  ],
};

export const NOT_YOUR_FLOOR = "not your floor";

const TERMINAL = new Set(["completed", "closed", "cancelled"]);

/** The factory's production floors, declared spelling and order; [] when it lists none. */
export function productionFloors(warehouse: string | null | undefined): readonly string[] {
  return PRODUCTION_FLOORS[normaliseWarehouseCode(warehouse)] ?? [];
}

/** "  roasting area " → "ROASTING AREA" (the server's normalise_floor). */
export function normaliseFloor(floor: string | null | undefined): string {
  return String(floor ?? "").trim().toUpperCase();
}

export function sameFloor(a: string | null | undefined, b: string | null | undefined): boolean {
  const k = normaliseFloor(a);
  return k !== "" && k === normaliseFloor(b);
}

/** A floor in the factory's declared spelling ("roasting area" → "Roasting Area");
 *  trimmed as given when the factory does not list it. */
export function canonicalFloor(warehouse: string | null | undefined, floor: string | null | undefined): string {
  const name = String(floor ?? "").trim();
  return productionFloors(warehouse).find((f) => sameFloor(f, name)) ?? name;
}

/** A pre-filled floor as a picker can show it: a saved floor's stored spelling,
 *  else the declared one, else blank when the factory's list doesn't hold it (the
 *  operator picks one rather than sending a name the server refuses). */
export function prefillFloor(
  warehouse: string | null | undefined,
  floor: string | null | undefined,
  saved: readonly (string | null | undefined)[] = [],
): string {
  const kept = saved.find((s) => sameFloor(s, floor));
  if (typeof kept === "string") return kept;
  const name = canonicalFloor(warehouse, floor);
  const list = productionFloors(warehouse);
  return !list.length || list.includes(name) ? name : "";
}

/** What the rule needs to know about the signed-in user (lib/user UserScope). */
export interface FloorScope {
  isAdmin: boolean;
  floors: readonly string[];
}

export interface FloorRule {
  /** Holds plans › approve, as the server's _may_approve_plans asks. */
  anyFloorInFactory?: boolean;
}

function grantsOf(scope: FloorScope): string[] {
  return (scope.floors ?? []).filter((f) => normaliseFloor(f) !== "");
}

/** True when this person may only use their own floors. */
export function isFloorLimited(scope: FloorScope, rule: FloorRule = {}): boolean {
  return !scope.isAdmin && !rule.anyFloorInFactory && grantsOf(scope).length > 0;
}

function holds(scope: FloorScope, floor: string): boolean {
  return grantsOf(scope).some((g) => sameFloor(g, floor));
}

/** The factory's floors this person may use, in the declared spelling: every
 *  floor for an admin, a planner (rule.anyFloorInFactory) or someone with no
 *  floor grants, else the floors their grants cover. */
export function allowedFloorsFor(
  scope: FloorScope,
  warehouse: string | null | undefined,
  rule: FloorRule = {},
): string[] {
  const all = productionFloors(warehouse);
  if (!isFloorLimited(scope, rule)) return [...all];
  return all.filter((f) => holds(scope, f));
}

export interface FloorChoice {
  value: string;
  disabled: boolean;
  /** Why it can't be picked ("not your floor"); null when it can. */
  reason: string | null;
  /** One of the saved floors, kept as stored. */
  saved: boolean;
}

/**
 * The options for one floor picker. Every floor of the factory is listed so the
 * whole route stays readable — floors this person may not use greyed out with
 * "not your floor". A saved floor is always its own option, enabled and spelt as
 * stored: a floor a card already has is not touched by keeping it, and a select
 * whose value matches no option shows blank ("roasting area" on 4 cards).
 */
export function floorChoicesFor(
  scope: FloorScope,
  warehouse: string | null | undefined,
  opts: FloorRule & { saved?: string | null | readonly (string | null | undefined)[] } = {},
): FloorChoice[] {
  const limited = isFloorLimited(scope, opts);
  const savedIn = Array.isArray(opts.saved) ? opts.saved : [opts.saved];
  const saved: string[] = [];
  for (const s of savedIn) {
    if (typeof s === "string" && normaliseFloor(s) && !saved.some((x) => sameFloor(x, s))) saved.push(s);
  }
  const out: FloorChoice[] = productionFloors(warehouse).map((f) => {
    const kept = saved.find((s) => sameFloor(s, f));
    const ok = !limited || kept != null || holds(scope, f);
    return { value: kept ?? f, disabled: !ok, reason: ok ? null : NOT_YOUR_FLOOR, saved: kept != null };
  });
  const missing = saved.filter((s) => !out.some((c) => sameFloor(c.value, s)))
    .map((s) => ({ value: s, disabled: false, reason: null, saved: true }));
  return [...missing, ...out];
}

function distinct(floors: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const f of floors) {
    const name = String(f ?? "").trim();
    if (name && !out.some((x) => sameFloor(x, name))) out.push(name);
  }
  return out;
}

/** Floors that gain or lose a card when a chain goes from `before` to `after`,
 *  as multisets ignoring case (the server's replace / merge rule): inserting a
 *  Sorting step anywhere in Roasting → Packing touches Sorting only. */
export function touchedFloors(
  before: readonly (string | null | undefined)[],
  after: readonly (string | null | undefined)[],
): string[] {
  const count = (list: readonly (string | null | undefined)[]) => {
    const m = new Map<string, number>();
    for (const f of list) {
      const k = normaliseFloor(f);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const b = count(before), a = count(after);
  return distinct([...after, ...before].filter((f) => {
    const k = normaliseFloor(f);
    return k !== "" && (a.get(k) ?? 0) !== (b.get(k) ?? 0);
  }));
}

export interface SavedCard {
  jobCardId: number | null;
  floor: string | null;
  status?: string | null;
  process?: string | null;
}

/** Floors a live edit touches, diffed by job card against the saved chain (the
 *  server's live-edit rule): an added row's floor, a moved card's old and new
 *  floor, every removed card's floor. A blank floor or one sent unchanged
 *  (ignoring case) touches nothing. Nor does a finished card: the server
 *  refuses to move one at all (card_finished), which finishedCardMoved says
 *  before Save. */
export function liveEditTouched(
  saved: readonly SavedCard[],
  rows: readonly { jobCardId?: number | null; floor: string | null }[],
): string[] {
  const byId = new Map(saved.filter((c) => c.jobCardId != null).map((c) => [c.jobCardId as number, c]));
  const kept = new Set<number>();
  const out: (string | null)[] = [];
  for (const r of rows) {
    const card = r.jobCardId != null ? byId.get(r.jobCardId) : undefined;
    if (!card) {
      out.push(r.floor);
      continue;
    }
    kept.add(card.jobCardId as number);
    if (!normaliseFloor(r.floor) || TERMINAL.has(card.status ?? "") || sameFloor(r.floor, card.floor)) continue;
    out.push(r.floor, card.floor);
  }
  for (const c of saved) if (c.jobCardId != null && !kept.has(c.jobCardId)) out.push(c.floor);
  return distinct(out);
}

/** The first finished (completed / closed / cancelled) card a live edit would
 *  move to another floor, and the sentence the server refuses the whole save
 *  with (card_finished); null when none would. A blank floor, or the same one
 *  ignoring case, keeps the card where it is. */
export function finishedCardMoved(
  saved: readonly SavedCard[],
  rows: readonly { jobCardId?: number | null; floor: string | null }[],
): { jobCardId: number; message: string } | null {
  const byId = new Map(saved.filter((c) => c.jobCardId != null).map((c) => [c.jobCardId as number, c]));
  for (const r of rows) {
    const card = r.jobCardId != null ? byId.get(r.jobCardId) : undefined;
    if (!card || !TERMINAL.has(card.status ?? "")) continue;
    if (!normaliseFloor(r.floor) || sameFloor(r.floor, card.floor)) continue;
    const name = String(card.process ?? "").trim() || `Job card ${card.jobCardId}`;
    return {
      jobCardId: card.jobCardId as number,
      message: `${name} is ${card.status}, so it stays on ${String(card.floor ?? "").trim() || "its floor"}. `
        + "Put its floor back to save the other changes.",
    };
  }
  return null;
}

/** Whether a plan step's job cards move with its floor in Plan Detail — they do
 *  while still waiting (locked / unlocked), so the floor they leave is touched
 *  too. The server says so per step (`carded`); an older server without it
 *  falls back to whether the line has any job card. Only stepFloorTouched's
 *  fallback for a server that doesn't send `card_floors`. */
export function stepCarded(step: { carded?: unknown } | null | undefined, lineCarded: boolean): boolean {
  return typeof step?.carded === "boolean" ? step.carded : lineCarded;
}

/** The floors setting a Plan Detail step to `floor` touches, as PUT
 *  /plans-v2/steps/{id} checks them (update_step_v2): every floor its waiting
 *  cards leave (`card_floors`, where those cards really are — not always the
 *  step's floor), then the new floor whenever a card moves or it differs from
 *  the step's. A blank floor clears the step and leaves its cards, so it touches
 *  nothing. An older server without card_floors: the new floor and, while the
 *  step is carded (stepCarded), the step's own floor, when the floor changes.
 *  `structuralFirst`: the same save adds, moves or removes a step before this
 *  PUT, and that resync (plan_v2._resync_jcs_after_step_change) puts the waiting
 *  cards on their step's floor first — so the floor they would leave then is
 *  checked as well. */
export function stepFloorTouched(
  step: { floor?: string | null; card_floors?: unknown; carded?: unknown } | null | undefined,
  floor: string | null | undefined,
  lineCarded: boolean,
  opts: { structuralFirst?: boolean } = {},
): string[] {
  const key = normaliseFloor(floor);
  if (!key) return [];
  if (Array.isArray(step?.card_floors)) {
    const cards = (step.card_floors as unknown[]).map((f) => (typeof f === "string" ? f : null));
    const touched = (cardFloors: (string | null)[]) => {
      // A card with no floor moves too (onto the new floor): it leaves none.
      const moved = cardFloors.filter((f) => normaliseFloor(f) !== key);
      return !moved.length && key === normaliseFloor(step.floor) ? [] : [...moved, floor];
    };
    const resynced = opts.structuralFirst && cards.length ? touched([step.floor ?? null]) : [];
    return distinct([...touched(cards), ...resynced]);
  }
  if (sameFloor(floor, step?.floor)) return [];
  return distinct([floor, stepCarded(step, lineCarded) ? step?.floor : null]);
}

function names(floors: string[]): string {
  return floors.length === 1 ? floors[0] : `${floors.slice(0, -1).join(", ")} and ${floors[floors.length - 1]}`;
}

/** The touched floors this person may not use, and the sentence the server would
 *  answer with; null when Save would pass the floor check. */
export function chainFloorProblems(
  scope: FloorScope,
  warehouse: string | null | undefined,
  touched: readonly (string | null | undefined)[],
  rule: FloorRule = {},
): { floors: string[]; message: string } | null {
  if (!isFloorLimited(scope, rule)) return null;
  const bad = distinct(touched).filter((f) => !holds(scope, f));
  if (!bad.length) return null;
  const factory = String(warehouse ?? "").trim() || "this factory";
  const mine = productionFloors(warehouse).length ? allowedFloorsFor(scope, warehouse) : grantsOf(scope);
  const rest = mine.length
    ? `Your floors in ${factory}: ${mine.join(", ")}. Use one of those, or ask a planner to make this change.`
    : `None of your floors are in ${factory}. Ask a planner to make this change, or an admin to add the floor to your profile.`;
  const verb = bad.length === 1 ? "is not one of your floors" : "are not your floors";
  return { floors: bad, message: `${names(bad)} ${verb}, so you can't put work there or take it off. ${rest}` };
}

/** The "your floors" line under a floor picker; null when the factory lists no
 *  floors (the picker is free text then and says so itself). */
export function floorScopeNote(
  scope: FloorScope,
  warehouse: string | null | undefined,
  rule: FloorRule = {},
): string | null {
  const all = productionFloors(warehouse);
  if (!all.length) return null;
  const factory = String(warehouse ?? "").trim();
  const n = `${all.length} floor${all.length === 1 ? "" : "s"}`;
  if (scope.isAdmin || !grantsOf(scope).length) {
    return `No floor restriction on your profile, so all ${n} of ${factory} are listed.`;
  }
  if (rule.anyFloorInFactory) {
    return `You can approve plans, so you can plan any of the ${n} of ${factory}.`;
  }
  const mine = allowedFloorsFor(scope, warehouse);
  return mine.length
    ? `From your profile — ${mine.length} of the ${n} of ${factory} ${mine.length === 1 ? "is" : "are"} yours: ${mine.join(", ")}. The others are greyed out; ask a planner to put work there.`
    : `None of your floors are in ${factory}, so its floors are greyed out. Ask a planner, or an admin to add your floor to your profile.`;
}

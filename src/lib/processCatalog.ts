// Canonical process catalog shared by the Planning page (per-card step
// editor) and the Plan List edit page (per-line step editor). One list,
// one matcher — adding a new process here makes it pickable in both
// places at once. Order matches the shop-floor sequence operators
// usually walk through, so the dropdown reads top-to-bottom like a
// real BOM.

export const PROCESS_OPTIONS: readonly string[] = [
  "Sorting",
  "Flavouring",
  "Packaging",
  "Bulk Packaging",
  "Blending",
  "Bar Forming",
  "Roasting",
  "De-seeding",  // legacy spelling "De-Seeding" maps to this via canonProcess
  "Blanching",
  "Slicing",
  "Dicing",
  "Slivering",
  "Chocolate",
  "Stuffing",
  "Enrobing",
  "Flow Wrap",
  "Master Carton",
  "Weighing",
  "Mixing",
  "Krugger",
  "X-ray",
  "Monocarton",
] as const;

// Normalise legacy spellings (e.g. "De-Seeding" → "De-seeding") so the
// dropdown highlights the right option for BOMs created before we
// standardised the catalog. Key-by-lowercase; preserves the canonical
// capitalisation when there's a match, else passes through unchanged
// so custom names survive intact.
export function canonProcess(name: string | null | undefined): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  if (!lower) return null;
  const match = PROCESS_OPTIONS.find((p) => p.toLowerCase() === lower);
  return match ?? name;
}

// True when `name` exactly matches a canonical option (case-insensitive).
// Used by step-row dropdowns to decide whether to synthesise an extra
// "(custom)" option for legacy values.
export function isCanonicalProcess(name: string | null | undefined): boolean {
  if (!name) return false;
  return PROCESS_OPTIONS.some((p) => p.toLowerCase() === name.toLowerCase());
}

// Derive a stage token from a process_name. Mirrors the server-side
// helper in plan_v2.derive_stage_from_process so both ends agree:
//
//   "Sorting"     → "sorting"
//   "Bar Forming" → "bar_forming"
//   "De-seeding"  → "de-seeding"
//
// Used by the Plan / Plan-list edit dropdowns to populate stage
// alongside process_name when the operator picks from the catalog —
// keeps the row valid for the downstream job_card_v2.stage NOT NULL
// constraint without requiring a server round-trip to "fix" the row.
export function stageFromProcess(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name.trim();
  if (!cleaned) return null;
  return cleaned.toLowerCase().replace(/ /g, "_");
}

// ── Process-category classification (Slice 2) ──────────────────────────────
// Client mirror of master_ingest.classify_route_steps. Each Process-Category
// token maps to a practical operation + a stage bucket. G2 LOCKED: Sorting =
// inline; Packaging family = terminal (Final FG). Matches on the LEADING token
// (text before "(") so "Roasting (Bulk Packaging" classifies like "Roasting".

export const STAGE_CREATE_WIP = "Create WIP";
export const STAGE_FINAL_FG = "Final FG";
export const STAGE_INLINE = "inline";

const _TRANSFORM_OPS: Record<string, string> = {
  "de-seeding": "De-Seeding",
  "deseeding": "De-Seeding",
  "blanching": "Blanch & Slice",
  "slicing/dicing/slivering": "Blanch & Slice",
  "slicing": "Blanch & Slice",
  "dicing": "Blanch & Slice",
  "slivering": "Blanch & Slice",
  "blending": "Blend & Form",
  "bar forming": "Blend & Form",
  "roasting": "Roasting",
  "flavouring": "Roast & Flavour/Salt",
  "salting": "Roast & Flavour/Salt",
  "stuffing": "Stuffing",
  "enrobing": "Enrobe / Choco-Coat",
  "chocolate": "Enrobe / Choco-Coat",
};
const _SEASONING = new Set(["flavouring", "salting"]);
const _TERMINAL = new Set([
  "packaging", "bulk packaging", "master carton", "mono carton", "monocarton",
  "flow wrap", "krugger", "x-ray", "xray", "weighing",
]);
const _INLINE = new Set(["sorting", "receiving"]);

function _canonToken(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().split("(")[0].trim();
}

export type ProcessClass = {
  practicalOperation: string | null;
  stageBucket: string | null;
  producesSfg: boolean;
};

// ── Stage-wise material hierarchy: which stages consume PM ─────────────────
// A BOM's PM articles belong to the packing / cartoning family of stages only.
// Every other stage (Sorting, Roasting, Mixing, …) opens on RM or on the SFG
// carried in from the previous stage, and must NOT render PM inputs — empty PM
// fields on a Sorting card are what let PM consumption get booked against a
// process stage (312 such rows exist in production today).
//
// Deliberately a SEPARATE list from _TERMINAL above, not a reuse: _TERMINAL
// drives classifySteps' stage bucketing, it is missing "packing" (the single
// most common process name in the route master), and widening it there would
// shift Create-WIP/Final-FG classification for every caller. A handful of
// duplicated strings is the smaller blast radius.
// ponytail: plain substring match, same idiom as job_card_v2.is_packing_stage.
// Upgrade path is an explicit stage catalogue keyed on process_name.
// "pack" (not "packing"/"packaging") is deliberate: it also catches the
// archetype-C step "Create WIP: (pack of existing SFG)", which packs an
// existing SFG into FG and therefore does consume PM. No non-packing process
// in PROCESS_OPTIONS or in the live route master contains the substring.
//
// Krugger / X-ray / Weighing are deliberately ABSENT even though _TERMINAL
// above buckets them as "Packaging": operator spec is packing + mono carton +
// master carton only, and on a real 6-step chain (Sorting → Roasting →
// Weighing → Mixing → Krugger → Packaging) those three run as SFG → WIP
// transforms with Packaging as the sole terminal step. Add a token back here
// if a line genuinely issues packaging material at one of them — the
// output_kind='FG' fallback in page.tsx already covers the case where such a
// step is itself the terminal card.
const _PM_BEARING_TOKENS = [
  "pack", "monocarton", "mono carton", "master carton", "flow wrap",
];

// True when a job card's stage consumes packaging material. Takes any number of
// name sources (process_name, stage) because the two disagree in live data —
// e.g. stage='packaging' with process_name='Sorting + Packing'. Matching is
// containment, so COMBINED cards ("Sorting + Packaging", "Flavouring (Bulk
// Packaging") stay PM-bearing: they really do pack. Underscores normalise to
// spaces so the stage token ('master_carton') matches the same list as the
// process name ('Master Carton').
//
// Mirrored server-side by job_card_v2.is_pm_bearing_stage — keep the two token
// lists in step, or the client will offer PM inputs the server rejects.
export function isPmBearingStage(...names: (string | null | undefined)[]): boolean {
  const hay = names.filter(Boolean).join(" ").toLowerCase().replace(/_/g, " ");
  if (!hay.trim()) return false;
  return _PM_BEARING_TOKENS.some((t) => hay.includes(t));
}

// Classify an FG's ORDERED steps (combine-aware: Roasting + a seasoning token
// ⇒ the Roasting step becomes the combined "Roast & Flavour/Salt").
export function classifySteps(stepNames: (string | null | undefined)[]): ProcessClass[] {
  const canon = stepNames.map(_canonToken);
  const hasSeason = canon.some((t) => _SEASONING.has(t));
  return canon.map((t) => {
    // Object.hasOwn (not `t in`) so a token like "constructor"/"__proto__" can't
    // match an inherited prototype key — mirrors the Python dict's behaviour.
    if (Object.hasOwn(_TRANSFORM_OPS, t)) {
      const op = t === "roasting" && hasSeason ? "Roast & Flavour/Salt" : _TRANSFORM_OPS[t];
      return { practicalOperation: op, stageBucket: STAGE_CREATE_WIP, producesSfg: true };
    }
    if (_TERMINAL.has(t)) return { practicalOperation: "Packaging", stageBucket: STAGE_FINAL_FG, producesSfg: false };
    if (_INLINE.has(t)) return { practicalOperation: null, stageBucket: STAGE_INLINE, producesSfg: false };
    return { practicalOperation: null, stageBucket: null, producesSfg: false };
  });
}

// Single-token classification (no combine context). Prefer classifySteps when
// the full step list is available so the Roasting/seasoning combine applies.
export function classifyProcess(name: string | null | undefined): ProcessClass {
  return classifySteps([name])[0];
}

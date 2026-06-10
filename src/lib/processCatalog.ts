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
  "Slicing/Dicing/Slivering",
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

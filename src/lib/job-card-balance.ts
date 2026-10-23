// The job card balance rule, exactly as the server applies it
// (backend jc_accounting_v2.save_accounting): a batch balances when
// |difference| / input <= the BOM's tolerance (a fraction, 0.001 = 0.1 %),
// with the difference rounded to grams; with no input, when |difference| is
// 0.05 kg or less. Closing a batch and completing the job card are both judged
// by the server on this rule, so the screen must not say "balanced" on any
// other. Pure, so it is tested without a browser (job-card-balance.test.ts).

/** The server's allowance when there is no input to take a share of. */
export const NO_INPUT_ALLOWANCE_KG = 0.05;
/** The designed BOM tolerance (0.1 %), used when the server sends none. */
export const DEFAULT_TOLERANCE_FRACTION = 0.001;

/** The BOM's tolerance as a fraction; the designed 0.1 % when missing or invalid. */
export function toleranceFraction(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOLERANCE_FRACTION;
}

function grams(kg: number): number {
  return Math.round(kg * 1000) / 1000;
}

/** How far off (kg) still counts as balanced for this input. */
export function allowedDifferenceKg(totalInput: number | null | undefined, fraction: number): number {
  const input = Number(totalInput) || 0;
  return input > 0 ? grams(input * fraction) : NO_INPUT_ALLOWANCE_KG;
}

/** The server's verdict; null when there is no difference to judge. */
export function isWithinBalance(
  diff: number | null | undefined,
  totalInput: number | null | undefined,
  fraction: number,
): boolean | null {
  if (diff == null || !Number.isFinite(diff)) return null;
  const off = Math.abs(grams(diff));
  const input = Number(totalInput) || 0;
  return input > 0 ? off / input <= fraction : off <= NO_INPUT_ALLOWANCE_KG;
}

/** "Off by 0.313 kg · 0.100 kg allowed". */
export function balanceGapText(diff: number, totalInput: number | null | undefined, fraction: number): string {
  return `Off by ${Math.abs(diff).toFixed(3)} kg · ${allowedDifferenceKg(totalInput, fraction).toFixed(3)} kg allowed`;
}

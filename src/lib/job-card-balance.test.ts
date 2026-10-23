// node src/lib/job-card-balance.test.ts
import {
  allowedDifferenceKg, balanceGapText, isWithinBalance, toleranceFraction,
} from "./job-card-balance.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// The BOM's tolerance is a fraction (0.001 = 0.1 %); missing or nonsense → 0.1 %.
check("server value used", toleranceFraction(0.0005), 0.0005);
check("numeric string", toleranceFraction("0.002"), 0.002);
check("missing → default", toleranceFraction(null), 0.001);
check("nonsense → default", toleranceFraction("abc"), 0.001);
check("negative → default", toleranceFraction(-1), 0.001);

// Allowed difference = tolerance × input; 0.05 kg when there is no input.
check("0.1 % of 100 kg", allowedDifferenceKg(100, 0.001), 0.1);
check("0.1 % of 250 kg", allowedDifferenceKg(250, 0.001), 0.25);
check("no input", allowedDifferenceKg(0, 0.001), 0.05);
check("missing input", allowedDifferenceKg(null, 0.001), 0.05);

// The same verdict the server gives (jc_accounting_v2: |diff| / input <= tolerance,
// diff rounded to 3 dp; |diff| <= 0.05 kg with no input).
check("within 0.1 %", isWithinBalance(0.09, 100, 0.001), true);
check("exactly on the limit", isWithinBalance(-0.1, 100, 0.001), true);
check("just over", isWithinBalance(0.101, 100, 0.001), false);
// The old screen rule passed anything under 50 g: on a 30 kg batch 40 g off
// it said "balanced" while the server (0.1 % = 30 g) refused.
check("30 kg batch, 40 g off → not balanced", isWithinBalance(0.04, 30, 0.001), false);
check("30 kg batch, 30 g off → balanced", isWithinBalance(0.03, 30, 0.001), true);
check("no input, 40 g off → balanced", isWithinBalance(0.04, 0, 0.001), true);
check("no input, 60 g off → not balanced", isWithinBalance(0.06, 0, 0.001), false);
check("rounded to grams like the server", isWithinBalance(0.1004, 100, 0.001), true);
check("nothing to judge", isWithinBalance(null, 100, 0.001), null);

// The gap in plain words.
check("off by / allowed", balanceGapText(-0.3126, 100, 0.001), "Off by 0.313 kg · 0.100 kg allowed");
check("no input", balanceGapText(0.2, 0, 0.001), "Off by 0.200 kg · 0.050 kg allowed");

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("job-card-balance: all checks passed");

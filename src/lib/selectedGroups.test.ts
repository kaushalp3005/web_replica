// node src/lib/selectedGroups.test.ts
import {
  cellText, commonFactory, earliestDate, factorySummary, groupBySo, onlyFactory, parseQtyInput,
} from "./selectedGroups.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Selected articles group under their SO, SOs in the order they were first
// selected, articles in selection order within each SO.
const rows = [
  { id: 1, so_number: "CF-SO/26-27/220", customer_name: "Candor Foods" },
  { id: 2, so_number: "CF-SO/26-27/218", customer_name: "Ajfan International" },
  { id: 3, so_number: "CF-SO/26-27/220", customer_name: "Candor Foods" },
  { id: 4, so_number: null, customer_name: null },
  { id: 5, so_number: "  ", customer_name: "Walk-in" },
];
const groups = groupBySo(rows);
check("one group per SO, first-selected first",
      groups.map((g) => [g.soNumber, g.rows.map((r) => r.id)]),
      [["CF-SO/26-27/220", [1, 3]], ["CF-SO/26-27/218", [2]], [null, [4, 5]]]);
check("the group carries its customer", groups.map((g) => g.customer),
      ["Candor Foods", "Ajfan International", "Walk-in"]);
check("group keys are unique and stable", groups.map((g) => g.key),
      ["so:CF-SO/26-27/220", "so:CF-SO/26-27/218", "so:"]);
check("nothing selected, no groups", groupBySo([]), []);

// The SO row shows the earliest deadline of its articles.
check("earliest of several", earliestDate(["2026-05-19", "2026-05-12T00:00:00", "", null, undefined, "2026-06-01"]), "2026-05-12");
check("no deadlines", earliestDate([null, "", undefined]), "");

// The SO row's factory cell: Factory is required for every article.
check("all on one factory", factorySummary(["A185", "A185"]), { label: "A185", tone: "set" });
check("all set, different factories", factorySummary(["A185", "W202"]), { label: "Mixed", tone: "set" });
check("some not set", factorySummary(["A185", undefined, undefined]), { label: "1/3 set", tone: "partial" });
check("none set", factorySummary([undefined, undefined]), { label: "Not set", tone: "none" });

// The default factory: an account with access to exactly one factory has its
// articles put on it without asking; with several (or none) nobody guesses.
check("one factory is the default", onlyFactory(["A185"]), "A185");
check("several factories, no default", onlyFactory(["A185", "W202"]), undefined);
check("no factory access, no default", onlyFactory([]), undefined);

// The SO row's factory dropdown shows the factory only when every article is on it.
check("all on one factory", commonFactory(["W202", "W202"]), "W202");
check("mixed factories show no single value", commonFactory(["W202", "A185"]), "");
check("an article without a factory shows no single value", commonFactory(["W202", undefined]), "");
check("no articles", commonFactory([]), "");

// Typing a qty into a table cell: blank clears it (back to the pending default),
// junk clears it, and anything above what is still pending is capped there.
check("blank clears", parseQtyInput("", 3000), undefined);
check("junk clears", parseQtyInput("abc", 3000), undefined);
check("a number within the limit", parseQtyInput("1200.5", 3000), 1200.5);
check("above the pending qty is capped", parseQtyInput("4000", 3000), 3000);
check("no limit when nothing is pending", parseQtyInput("4000", 0), 4000);
check("no limit given", parseQtyInput("4000", null), 4000);

// What a qty cell shows: by default the WHOLE pending qty / pcs as a real value;
// an operator's own figure once typed; while the cell is being edited, exactly
// what they typed (even blank — it only falls back to the full qty on leaving).
check("default is the whole pending qty", cellText(null, undefined, 3000), "3000");
check("decimals kept", cellText(null, undefined, 2.5), "2.5");
check("a typed figure wins over the default", cellText(null, 1200, 3000), "1200");
check("a typed zero is shown, not replaced", cellText(null, 0, 3000), "0");
check("nothing pending shows blank", cellText(null, undefined, null), "");
check("while editing, the draft is shown", cellText("15", 1200, 3000), "15");
check("while editing, a cleared cell stays blank", cellText("", undefined, 3000), "");

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("selectedGroups: all checks passed");

// node "src/app/modules/production/so-creation/selectAll.test.ts"
import { firstRowPerLine, selectAllClick, selectAllState, selectableLineIds } from "./selectAll.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// An SO's articles: only lines that carry a so_line_id can be selected.
const lines = [{ so_line_id: 11 }, { so_line_id: null }, { so_line_id: 12 }, {}, { so_line_id: 13 }];
check("selectable ids skip lines without a so_line_id", selectableLineIds(lines), [11, 12, 13]);
check("an SO with no lines has nothing to select", selectableLineIds([]), []);
check("duplicate ids are counted once", selectableLineIds([{ so_line_id: 11 }, { so_line_id: 11 }]), [11]);

// The checkbox state for one SO, against the page-wide selection (which also
// holds other SOs' articles).
const ids = [11, 12, 13];
check("none selected", selectAllState(ids, new Set([99])), "none");
check("some selected", selectAllState(ids, new Set([12, 99])), "some");
check("all selected", selectAllState(ids, new Set([11, 12, 13, 99])), "all");
check("an SO with nothing selectable is none", selectAllState([], new Set([11])), "none");

// What a click does: clear this SO when it is fully selected, otherwise add only
// the articles not yet selected (already-ticked ones are not looked up again).
check("click with none selected adds every article", selectAllClick(ids, new Set()), { action: "add", ids: [11, 12, 13] });
check("click with some selected adds the rest", selectAllClick(ids, new Set([12])), { action: "add", ids: [11, 13] });
check("click with all selected clears this SO only", selectAllClick(ids, new Set([11, 12, 13, 99])), { action: "clear", ids: [11, 12, 13] });

// Batched lookup: one fulfillment row per article — the first, as the single-
// article checkbox takes results[0]; rows without a so_line_id are ignored.
const rows = [
  { so_line_id: 11, fulfillment_id: 1 },
  { so_line_id: 11, fulfillment_id: 2 },
  { so_line_id: null, fulfillment_id: 3 },
  { so_line_id: 13, fulfillment_id: 4 },
];
check("first row per line", Array.from(firstRowPerLine(rows).entries()).map(([k, v]) => [k, v.fulfillment_id]),
      [[11, 1], [13, 4]]);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("selectAll: all checks passed");

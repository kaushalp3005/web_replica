// Exercises lib/article-picker. No test runner is configured in this project,
// so this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/article-picker.test.ts
import { browseTypeOptions, pickLookupFilters, searchResults } from "./article-picker.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Browse filters left over from the other tab: PM, a category and a sub category.
const leftover = { itemType: "pm", itemGroup: "Boxes", subGroup: "Corrugated" };

check("search: the result's own type pins the pick; Browse leftovers are ignored",
  pickLookupFilters({ tab: "search", name: "Almond Kernel", singleType: null,
    resultType: "rm", ...leftover }),
  { particulars: "Almond Kernel", item_type: "rm" });
check("search: a single allowed type pins when the result's type is unknown",
  pickLookupFilters({ tab: "search", name: "Almond Kernel", singleType: "rm", resultType: null, ...leftover }),
  { particulars: "Almond Kernel", item_type: "rm" });
check("search: nothing known resolves the name alone",
  pickLookupFilters({ tab: "search", name: "Almond Kernel", singleType: null, resultType: null,
    itemType: "", itemGroup: "", subGroup: "" }),
  { particulars: "Almond Kernel" });
check("search: a name that is both FG and SFG pins the type of the result picked",
  [pickLookupFilters({ tab: "search", name: "Roasted Mix", singleType: null, resultType: "sfg",
    itemType: "", itemGroup: "", subGroup: "" }),
  pickLookupFilters({ tab: "search", name: "Roasted Mix", singleType: null, resultType: "fg",
    itemType: "", itemGroup: "", subGroup: "" })],
  [{ particulars: "Roasted Mix", item_type: "sfg" }, { particulars: "Roasted Mix", item_type: "fg" }]);
check("browse: the chosen filters pin the pick",
  pickLookupFilters({ tab: "browse", name: "Carton 5 kg", singleType: null,
    resultType: "rm", ...leftover }),
  { particulars: "Carton 5 kg", item_type: "pm", item_group: "Boxes", sub_group: "Corrugated" });
check("browse: a single allowed type pins when no type is picked",
  pickLookupFilters({ tab: "browse", name: "Salt", singleType: "rm", resultType: null,
    itemType: "", itemGroup: "", subGroup: "" }),
  { particulars: "Salt", item_type: "rm" });

// Browse's Material type choices. sku-lookup leaves SFG out unless asked for
// item_type 'sfg', and narrows item_types to the chosen type: every allowed type
// is offered.
check("browse types: unrestricted is what the master offers",
  browseTypeOptions(["fg", "pl/ega", "pm", "rm"], null), ["fg", "pl/ega", "pm", "rm"]);
check("browse types: restricted to the allowed ones, SFG included though the master hid it",
  browseTypeOptions(["fg", "pl/ega", "pm", "rm"], ["rm", "pm", "fg", "sfg"]), ["fg", "pm", "rm", "sfg"]);
check("browse types: after a pick the other allowed types stay on offer",
  browseTypeOptions(["sfg"], ["rm", "pm", "fg", "sfg"]), ["fg", "pm", "rm", "sfg"]);
check("browse types: RM + PM",
  browseTypeOptions(["fg", "pm", "rm"], ["rm", "pm"]), ["pm", "rm"]);
check("browse types: nothing loaded yet still offers the allowed types",
  browseTypeOptions(undefined, ["rm", "pm"]), ["pm", "rm"]);

// Search results: one lookup per allowed type (or one unscoped).
check("search results: unscoped, one entry per name",
  searchResults([undefined], [["Salt", "Salt", "Sugar"]]),
  [{ name: "Salt", type: null, showType: false }, { name: "Sugar", type: null, showType: false }]);
check("search results: a single type pins each entry",
  searchResults(["rm"], [["Salt", "Sugar"]]),
  [{ name: "Salt", type: "rm", showType: false }, { name: "Sugar", type: "rm", showType: false }]);
check("search results: a name under two allowed types is two entries, side by side, typed",
  searchResults(["rm", "pm", "fg", "sfg"], [["Salt"], ["Pouch"], ["Roasted Mix", "Trail Mix"], ["Roasted Mix"]]),
  [
    { name: "Salt", type: "rm", showType: false },
    { name: "Pouch", type: "pm", showType: false },
    { name: "Roasted Mix", type: "fg", showType: true },
    { name: "Roasted Mix", type: "sfg", showType: true },
    { name: "Trail Mix", type: "fg", showType: false },
  ]);
check("search results: a name repeated within one type is one entry",
  searchResults(["rm", "pm"], [["Salt", "Salt"], []]), [{ name: "Salt", type: "rm", showType: false }]);
check("search results: capped",
  searchResults(["rm"], [["A", "B", "C"]], 2).map((r) => r.name), ["A", "B"]);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("article-picker: all passed");

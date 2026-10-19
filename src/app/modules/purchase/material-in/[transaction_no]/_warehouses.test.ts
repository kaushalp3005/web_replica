// node "src/app/modules/purchase/material-in/[transaction_no]/_warehouses.test.ts"
import { INWARD_WAREHOUSES, inwardWarehouseChoices, lockedWarehouse, printsColdLabels } from "./_warehouses.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// The list: canonical names from the site table.
check("every warehouse, then every cold store", INWARD_WAREHOUSES,
  ["W202", "A185", "A101", "A68", "F53", "Rishi", "Savla D-39", "Savla D-514", "Savla Bond", "Supreme", "Eskimo"]);
check("the Savla D-34 typo is gone", INWARD_WAREHOUSES.includes("Savla D-34"), false);
check("Cold Storage is no site to book to", INWARD_WAREHOUSES.includes("Cold Storage"), false);

// The user's lock matches every spelling of its site.
const options = (granted: string[]) => inwardWarehouseChoices("", false, granted).options;
check("an admin sees every site", inwardWarehouseChoices("", true, []).options, [...INWARD_WAREHOUSES]);
check("a D-39 grant offers Savla D-39", options(["D-39"]), ["Savla D-39"]);
check("a D-514 grant offers Savla D-514", options(["D-514"]), ["Savla D-514"]);
check("hyphenated and legacy grants", options(["W-202", "Warehouse A185", "Supreme Cold"]), ["W202", "A185", "Supreme"]);
check("a Savla Bond grant offers Savla Bond only", options(["Savla Bond"]), ["Savla Bond"]);
check("a D-39 grant does not offer Savla Bond", options(["D-39"]).includes("Savla Bond"), false);
check("a Cold Storage grant offers no store", options(["Cold Storage"]), []);
check("no grants and no admin: nothing", options([]), []);

// The saved value.
check("nothing saved selects nothing", inwardWarehouseChoices(null, true, []).value, "");
check("a saved Savla D-34 selects the Savla D-39 option, with no second entry",
  inwardWarehouseChoices("Savla D-34", false, ["D-39"]), { options: ["Savla D-39"], value: "Savla D-39" });
check("a saved D-39 selects Savla D-39", inwardWarehouseChoices("D-39", true, []).value, "Savla D-39");
check("a saved site outside the scope stays selectable, by its canonical name",
  inwardWarehouseChoices("Warehouse A185", false, ["W202"]), { options: ["A185", "W202"], value: "A185" });
check("an unknown saved name stays selectable as saved (trimmed)",
  inwardWarehouseChoices(" Old Godown ", false, ["W202"]), { options: ["Old Godown", "W202"], value: "Old Godown" });

// Label printing: the cold stores, under any spelling.
check("cold stores print labels",
  ["Savla D-39", "Savla D-34", "D-39", "Savla D-514", "Savla Bond", "Rishi", "Supreme Cold", "Eskimo", "Cold Storage"]
    .map(printsColdLabels),
  [true, true, true, true, true, true, true, true, true]);
check("warehouses and unknown names do not",
  ["W202", "A185", "A185 Cold", "F53", "Savla", "Dev Int", "", null, undefined].map(printsColdLabels),
  [false, false, false, false, false, false, false, false, false]);

// Access to one site fixes the Warehouse; several (or admin) get the dropdown.
check("one grant locks to its site", lockedWarehouse(false, ["D-39"]), "Savla D-39");
check("spellings of one site still lock", lockedWarehouse(false, ["W-202", "Warehouse W202"]), "W202");
check("two sites: choose from the dropdown", lockedWarehouse(false, ["W202", "A185"]), null);
check("an admin is never locked", lockedWarehouse(true, ["W202"]), null);
check("no access: nothing to lock to", lockedWarehouse(false, []), null);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("purchase inward warehouses: all passed");

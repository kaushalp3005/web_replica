// node src/app/modules/customer-returns/_factoryUnit.test.ts
import { FACTORY_UNITS, factoryUnitGroup, isColdFactoryUnit } from "./_factoryUnit.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// Cold: every spelling of a cold store, as the CR form and IMS RTV rows store it.
check("cold stores under any spelling",
  ["D-39", "Savla D-39", "savla d39", "Old Savla", "D-514", "Savla D-514", "Rishi", "Rishi Cold",
    "Supreme", "Supreme Cold", "Supreme Cold Storage", "Eskimo", "ESKIMO", "Savla Bond", "Cold Storage"]
    .map(isColdFactoryUnit),
  Array(15).fill(true));
check("warehouses, floors and unknown names are not cold",
  ["W202", "W-202", "A185", "Warehouse A185", "A185 Cold", "A68", "A101", "F53", "Savla", "Dev Int", "", null, undefined]
    .map(isColdFactoryUnit),
  Array(13).fill(false));

// Dashboard groups: one per site, under its canonical name.
check("every spelling of one site is one group",
  ["D-39", "Savla D-39", " savla d-39 ", "Old Savla", "Savla D-34"].map(factoryUnitGroup),
  Array(5).fill("Savla D-39"));
check("Supreme Cold and Supreme are one group", ["Supreme Cold", "SUPREME", "Supreme Cold Storage"].map(factoryUnitGroup),
  ["Supreme", "Supreme", "Supreme"]);
check("warehouses group by their canonical code", ["W-202", "Warehouse A185", "a-68", "A101"].map(factoryUnitGroup),
  ["W202", "A185", "A68", "A101"]);
check("Savla Bond stays its own group", [factoryUnitGroup("savla bond"), factoryUnitGroup("D-39")],
  ["Savla Bond", "Savla D-39"]);
check("Cold Storage stays its own group", factoryUnitGroup("cold storage"), "Cold Storage");
check("a known site of unknown kind keeps its canonical name", factoryUnitGroup("dev_int"), "Dev Int");
check("an unknown name keeps the case fold", ["ABC GODOWN", "abc godown", "Savla"].map(factoryUnitGroup),
  ["Abc Godown", "Abc Godown", "Savla"]);
check("empty gives empty", [factoryUnitGroup(""), factoryUnitGroup(null), factoryUnitGroup(undefined)], ["", "", ""]);

// The form's choices: the old nine codes as they were stored, plus Savla Bond and Eskimo.
check("factory units", FACTORY_UNITS,
  ["W202", "A185", "A101", "A68", "F53", "Rishi", "D-39", "D-514", "Savla Bond", "Supreme", "Eskimo"]);
check("every old choice is still offered, spelled as before",
  ["W202", "A185", "A68", "F53", "A101", "D-39", "D-514", "Rishi", "Supreme"].every((w) => FACTORY_UNITS.includes(w)), true);
check("no legacy Cold Storage choice", FACTORY_UNITS.some((w) => factoryUnitGroup(w) === "Cold Storage"), false);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("customer-returns factory units: all passed");

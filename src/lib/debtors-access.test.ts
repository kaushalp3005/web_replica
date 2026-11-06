// Exercises lib/debtors-access. No test runner is configured in this project,
// so this runs directly on Node's native TypeScript stripping:
//
//     node src/lib/debtors-access.test.ts
//
// What it guards: the same check decides what the Route Handlers forward to the
// collections service and which buttons the screen shows, so a role must get
// exactly the actions it is granted, and nothing that merely looks like a grant
// may count.

import type { MeResponse, MePermission } from "./auth.ts";
import { debtorsAccessOf, mayDebtors, DEBTORS_ACTIONS } from "./debtors-access.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

function user(permissions: MePermission[], extra: Partial<MeResponse> = {}): MeResponse {
  return { status: "active", must_change_password: false, roles: [{ code: "debtors_collection" }], permissions, ...extra };
}
const grant = (action: string, sub_module: string | null = null): MePermission => ({ module: "debtors_collection", sub_module, action });

// A partial grant gets exactly what it names (the role as 136 alone leaves it).
const partial = user(["view", "call", "edit", "export"].map((a) => grant(a)));
check("partial grant: only those four", debtorsAccessOf(partial), {
  view: true, call: true, edit: true, export: true, upload: false, delete: false,
});

const all = Object.fromEntries(DEBTORS_ACTIONS.map((a) => [a, true]));

// The role with 138 applied: the whole module, and no admin flag needed for it.
check("role: all six", debtorsAccessOf(user(DEBTORS_ACTIONS.map((a) => grant(a)))), all);

// Admins pass every action with no grant rows at all, by either admin shape.
check("admin flag", debtorsAccessOf(user([], { is_admin: true })), all);
check("admin role envelope", debtorsAccessOf(user([], { roles: [{ code: "admin" }] })), all);
check("admin bare role string", debtorsAccessOf(user([], { roles: ["admin"] })), all);

// Signed out, or a /me with no permissions list.
check("no user", mayDebtors(null, "view"), false);
check("no permissions list", mayDebtors(user([], { permissions: undefined }), "view"), false);

// Things that are not a debtors_collection grant for the action.
check("other module's view", mayDebtors(user([{ module: "stock_take", action: "view" }]), "view"), false);
check("a sub-module grant is not module-level", mayDebtors(user([grant("view", "parties")]), "view"), false);
check("view does not imply export", mayDebtors(user([grant("view")]), "export"), false);
check("sub_module omitted counts as null", mayDebtors(user([{ module: "debtors_collection", action: "call" }]), "call"), true);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("debtors-access: all checks passed");

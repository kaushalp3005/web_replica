// Who may do what in Debtors Collection. One list of actions, checked in two
// places that must agree: the Route Handlers under /api/collections (through
// lib/server/collections.ts), which are the real gate, and the screen, which
// only hides what those would refuse.
//
// The permissions are module-level rows in the ERP's auth_permission, made by
// backend migration 136 (app/db/136_debtors_collection_role.sql), and /me
// sends every permission the signed-in user's roles grant. Admins pass on
// their flag. The `debtors_collection` role holds view, call, edit and export;
// upload (replacing a tab from Tally) and delete (removing a call summary)
// stay with admins unless the admin screen grants them to a role.
//
// No imports beyond these two, so the test runs on Node directly:
//
//     node src/lib/debtors-access.test.ts

import type { MeResponse } from "./auth.ts";
import { isAdminMe } from "./sample-roles.ts";

export const DEBTORS_MODULE = "debtors_collection";

export const DEBTORS_ACTIONS = ["view", "call", "edit", "export", "upload", "delete"] as const;
export type DebtorsAction = (typeof DEBTORS_ACTIONS)[number];
export type DebtorsAccess = Record<DebtorsAction, boolean>;

/** Whether `me` may take `action` in Debtors Collection: admins always, anyone
 *  else only on a module-level debtors_collection grant for that action. */
export function mayDebtors(me: MeResponse | null, action: DebtorsAction): boolean {
  if (!me) return false;
  if (isAdminMe(me)) return true;
  if (!Array.isArray(me.permissions)) return false;
  return me.permissions.some(
    (p) =>
      p.module === DEBTORS_MODULE &&
      p.action === action &&
      (p.sub_module ?? null) === null &&
      (p.sub_sub_module ?? null) === null,
  );
}

/** Every action at once, for a screen that shows or hides several buttons. */
export function debtorsAccessOf(me: MeResponse | null): DebtorsAccess {
  return Object.fromEntries(DEBTORS_ACTIONS.map((a) => [a, mayDebtors(me, a)])) as DebtorsAccess;
}

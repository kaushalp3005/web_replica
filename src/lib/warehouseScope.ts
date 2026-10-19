// Shared warehouse-code matcher used across the production modules.
//
// Why this exists:
//   - auth_user.allowed_warehouses is a free TEXT[].  Admins fill it
//     by hand and we've seen every variant in the wild — "W-202",
//     "W202", "w-202", " W-202 ".
//   - Different surfaces in the codebase use different canonical
//     forms: the planning page maps factory codes "W202" / "A185" to
//     hyphenated warehouse strings "W-202" / "A-185"; the JC list
//     stores the bare factory code on each row.
//   - A strict-equality check fails on any of the above mismatches
//     and locks legitimately-assigned operators out of their own
//     factory ("No factories assigned to your account").
//
// The fix is to normalise both sides before comparing.  This file
// is the single source of truth so the planner, JC list, plan list,
// admin, and anywhere else that touches scope.warehouses all agree
// on what "the user has W-202" means.  Which spellings name one site
// (the grant "D-39" and "Savla D-39", "Warehouse A185" and "A185")
// is the shared site table in lib/sites, which the matching below
// goes through.

import { sameSite, siteKey } from "./sites.ts";

/** Strip whitespace + non-alphanumerics + uppercase.  "W-202", "W202",
 *  "w-202", and " W-202 " all collapse to "W202". */
export function normaliseWarehouseCode(s: string | null | undefined): string {
  return siteKey(s);
}

/** True when `code` names the same site as any entry in `userWarehouses`
 *  (lib/sites sameSite).  The caller can pass the bare factory code
 *  ("W202"), the hyphenated warehouse string ("W-202"), a lowercased
 *  variant, or an alias such as "Warehouse A185" or "Savla D-39" for
 *  the grant "D-39" — they all resolve the same way. */
export function userHasWarehouse(
  userWarehouses: readonly string[] | null | undefined,
  code: string,
): boolean {
  if (!userWarehouses || userWarehouses.length === 0) return false;
  if (!siteKey(code)) return false;
  return userWarehouses.some((w) => sameSite(w, code));
}

/** Like userHasWarehouse but accepts any of several aliases.  Used by
 *  the planner where "W202" (factory code) and "W-202" (canonical
 *  warehouse string) both represent the same plant. */
export function userHasAnyWarehouse(
  userWarehouses: readonly string[] | null | undefined,
  aliases: readonly string[],
): boolean {
  return aliases.some((alias) => userHasWarehouse(userWarehouses, alias));
}

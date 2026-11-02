"use client";

// What the signed-in user may do on this screen, from the same check the
// /api/collections Route Handlers apply (lib/debtors-access). Hiding a button
// is UX only; those handlers are the gate.

import { useMemo } from "react";
import { useMe } from "@/lib/user";
import { debtorsAccessOf, type DebtorsAccess } from "@/lib/debtors-access";

export function useDebtorsAccess(): DebtorsAccess {
  const me = useMe();
  return useMemo(() => debtorsAccessOf(me), [me]);
}

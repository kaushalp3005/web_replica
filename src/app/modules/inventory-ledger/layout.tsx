"use client";

// Wraps every Inventory Ledger route in the data provider so the chosen source
// (Sample / Live) and any loaded leaf data persist while navigating within the
// module (group → item → ledger), and only reset on a full reload.

import { LedgerDataProvider } from "./_LedgerData";

export default function InventoryLedgerLayout({ children }: { children: React.ReactNode }) {
  return <LedgerDataProvider>{children}</LedgerDataProvider>;
}

"use client";

// Inventory Ledger — Stock Summary landing (Tally "Stock Summary").
// The Summary tab is the detailed granular ledger (_StockSummary); the other
// tabs are company-level roll-ups (_CompanyViews). "Item Ledger" / "Monthly"
// open item search and route into the item hub. Fixtures today; each view swaps
// to LedgerApi.* once /api/v1/ledger lands.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { LedgerChrome } from "./_chrome";
import { ItemSearch, slugifySku } from "./_ItemSearch";
import { StockSummary } from "./_StockSummary";
import { CompanyBatches, CompanyAgeing, CompanyFifo, CompanyReconcile, RegistersView } from "./_CompanyViews";
import { LedgerGate, LedgerSourceToggle } from "./_LedgerData";
import { SectionTabs, type TabDef } from "./_ui";
import type { ItemSearchResult } from "@/lib/ledger";

const TABS: TabDef[] = [
  { key: "summary", label: "Stock Summary" },
  { key: "ledger", label: "Item Ledger" },
  { key: "monthly", label: "Monthly" },
  { key: "batches", label: "Batches & Lots" },
  { key: "ageing", label: "Ageing" },
  { key: "fifo", label: "FIFO" },
  { key: "reconcile", label: "Reconcile" },
  { key: "registers", label: "Registers" },
];

export default function InventoryLedgerPage() {
  const router = useRouter();
  // Call for its redirect side-effect only. Do NOT gate render on its return —
  // it is true on the server but false on the client's first paint, which would
  // cause a hydration mismatch (see transfer/page.tsx). The isAdmin gate below
  // is hydration-stable (false on server + client-first-render) and guards the body.
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState("summary");
  const [entity, setEntity] = useState<"CFPL" | "CDPL" | "Both">("CFPL");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pickTarget, setPickTarget] = useState<"vouchers" | "monthly">("vouchers");

  if (!isAdmin) {
    return (
      <LedgerChrome title="Stock Summary">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Inventory Ledger</h1>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Inventory Ledger module. Ask an administrator to grant you access, or switch to a different account.
        </section>
      </LedgerChrome>
    );
  }

  function selectTab(key: string) {
    if (key === "ledger" || key === "monthly") {
      setPickTarget(key === "monthly" ? "monthly" : "vouchers");
      setSearchOpen(true);
      return; // needs an item — open the picker, keep the current tab underneath
    }
    setTab(key);
  }
  function onPick(item: ItemSearchResult) {
    setSearchOpen(false);
    router.push(`/modules/inventory-ledger/item/${slugifySku(item.particulars)}?tab=${pickTarget}`);
  }

  return (
    <LedgerChrome title="Stock Summary">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-[18px] font-bold text-[var(--text-primary)]">Closing stock by group</h1>
          <p className="font-mono text-[11px] text-[var(--text-muted)]">quantity of record · value ≈ indicative · live 07 Jul 14:20</p>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => { setPickTarget("vouchers"); setSearchOpen(true); }}
          className="font-mono text-[11px] inline-flex items-center gap-[6px] border border-[var(--aws-border)] rounded-[8px] px-[11px] py-[6px] hover:border-[var(--aws-orange)]"
        >
          ⌕ Find item
        </button>
        <LedgerSourceToggle />
        <div className="inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px]">
          {(["CFPL", "CDPL", "Both"] as const).map((e) => (
            <button
              key={e}
              onClick={() => setEntity(e)}
              aria-pressed={entity === e}
              className={`font-mono text-[11px] px-[11px] py-[4px] rounded-[6px] ${
                entity === e ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]"
              }`}
            >{e}</button>
          ))}
        </div>
      </div>

      <SectionTabs tabs={TABS} active={tab} onSelect={selectTab} />
      <div className="mt-4">
        <LedgerGate>
          {tab === "summary" && (
            <StockSummary
              onDrillGroup={(k) => router.push(`/modules/inventory-ledger/${k}`)}
              onOpenItem={(sku) => router.push(`/modules/inventory-ledger/item/${sku}?tab=vouchers`)}
            />
          )}
          {tab === "batches" && <CompanyBatches />}
          {tab === "ageing" && <CompanyAgeing />}
          {tab === "fifo" && <CompanyFifo />}
          {tab === "reconcile" && <CompanyReconcile />}
          {tab === "registers" && <RegistersView />}
        </LedgerGate>
      </div>

      <ItemSearch open={searchOpen} onClose={() => setSearchOpen(false)} onPick={onPick} />
    </LedgerChrome>
  );
}

"use client";

// Purchase module landing. Mirrors production/page.tsx card pattern.
// Only PO Upload + Manual Entry are implemented on the web today.

import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "./_chrome";

type SubModule = { title: string; description: string; route: string; implemented: boolean };

const SUB_MODULES: SubModule[] = [
  { title: "PO Upload", description: "Upload a PO workbook (.xlsx), preview SKU matches and duplicates, then commit. Browse, filter, and export existing purchase orders.", route: "/modules/purchase/po-creation", implemented: true },
  { title: "Manual Entry", description: "Create a purchase order by hand — header, line items with SKU lookup, lots, and box weights.", route: "/modules/purchase/po-creation/manual", implemented: true },
];

export default function PurchaseLandingPage() {
  const router = useRouter();
  useRequireAuth(router.replace);

  return (
    <PurchaseChrome title="Purchase">
      <div className="mb-3">
        <BackLink parentHref="/modules" label="modules" />
      </div>
      <div className="mb-6">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Purchase</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Upload and review purchase orders, or create one manually.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {SUB_MODULES.map((m) => (
          <button
            key={m.route}
            onClick={() => router.push(m.route)}
            className="text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]"
          >
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-1">{m.title}</h3>
            <p className="text-[12px] text-[var(--text-secondary)]">{m.description}</p>
          </button>
        ))}
      </div>
    </PurchaseChrome>
  );
}

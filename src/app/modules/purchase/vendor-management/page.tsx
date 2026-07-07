"use client";

// Vendor Management landing. Mirrors purchase/page.tsx card pattern. The
// onboarding wizard is the entry point ported to the web so far; existing-
// vendors / detail / evaluation still live only in the desktop app.

import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../_chrome";

type SubModule = { title: string; description: string; route?: string; soon?: boolean };

const SUB_MODULES: SubModule[] = [
  {
    title: "Onboard new vendor",
    description:
      "Drop every compliance document (PAN, GST, FSSAI, cancelled cheque, MSA) — we extract and auto-fill vendor, banking, documents and contracts, then commit in one transaction.",
    route: "/modules/purchase/vendor-management/new",
  },
  {
    title: "Existing vendors",
    description: "Browse and search onboarded vendors, review compliance records, approve for purchase, or delete.",
    route: "/modules/purchase/vendor-management/existing",
  },
];

export default function VendorManagementLandingPage(): React.JSX.Element {
  const router = useRouter();
  // Fire the redirect effect but render through (no `authed` gate) — mirrors
  // the sibling purchase/page.tsx so the SSR HTML and first client paint match
  // and there's no hydration mismatch. There's no on-mount fetch to guard here.
  useRequireAuth(router.replace);

  return (
    <PurchaseChrome title="Vendor Management">
      <div className="mb-3">
        <BackLink parentHref="/modules/purchase" label="Purchase" />
      </div>
      <div className="mb-6">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Vendor Management</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Onboard suppliers with document extraction, then manage their compliance records.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {SUB_MODULES.map((m) => (
          <button
            key={m.title}
            type="button"
            disabled={m.soon}
            onClick={() => m.route && router.push(m.route)}
            className={[
              "text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition",
              m.soon
                ? "opacity-60 cursor-not-allowed"
                : "hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]",
            ].join(" ")}
          >
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{m.title}</h2>
              {m.soon && (
                <span className="inline-flex items-center h-4 px-1.5 text-[9px] font-bold uppercase tracking-wide rounded-full bg-[var(--surface-disabled)] text-[var(--text-muted)]">
                  desktop only
                </span>
              )}
            </div>
            <p className="text-[12px] text-[var(--text-secondary)]">{m.description}</p>
          </button>
        ))}
      </div>
    </PurchaseChrome>
  );
}

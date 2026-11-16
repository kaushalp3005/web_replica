"use client";

// Vendor Management landing. Mirrors purchase/page.tsx card pattern. The
// onboarding wizard and the existing-vendors list are navigation cards; the
// third card downloads the whole vendor master as .xlsx
// (GET /api/v1/vendors/export) instead of navigating, and its result message
// is shown under the grid. Evaluation still lives only in the desktop app.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth, useRequireModuleAccess } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../_chrome";
import { useSupplierMasterDownload, type SupplierMasterDownloadResult } from "./_useSupplierMasterDownload";

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
  // Stores (store_head) is scoped to Material In only — deep links bounce.
  useRequireModuleAccess("purchase/vendor-management", router.replace);

  // Download card — fires only on click (still no on-mount fetch), so the
  // render-through above stays safe. download() never throws.
  const { downloading, download } = useSupplierMasterDownload();
  const [downloadResult, setDownloadResult] = useState<SupplierMasterDownloadResult | null>(null);
  const onDownload = useCallback(async () => {
    setDownloadResult(null);
    setDownloadResult(await download());
  }, [download]);

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
        {/* Download card — same shell as the cards above, but it downloads
            instead of navigating. */}
        <button
          type="button"
          disabled={downloading}
          onClick={onDownload}
          className={[
            "text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition",
            downloading
              ? "opacity-60 cursor-not-allowed"
              : "hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]",
          ].join(" ")}
        >
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
              {downloading ? "Preparing…" : "Download vendor master"}
            </h2>
          </div>
          <p className="text-[12px] text-[var(--text-secondary)]">
            Excel file of every vendor, in the MIS Master – Suppliers data format.
          </p>
        </button>
      </div>

      {downloadResult && (downloadResult.ok ? (
        <p role="status" aria-live="polite" className="mt-3 text-[12px] text-[var(--text-success)] bg-[#eaf6ed] border border-[#b6dbb1] rounded px-3 py-2">
          {downloadResult.message}
        </p>
      ) : (
        <p role="alert" aria-live="assertive" className="mt-3 text-[12px] text-[var(--aws-error)] bg-[#fdf3f1] border border-[#f5c6bc] rounded px-3 py-2">
          {downloadResult.message}
        </p>
      ))}
    </PurchaseChrome>
  );
}

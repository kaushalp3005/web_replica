"use client";

// Box-wise inward (PO Receiving) entry page. Reached from the Material In list
// via the per-row → arrow. Replicates frontend_replica's po-receiving screen
// (summary, logistics form, per-line box sections) minus thermal printing.

import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { PurchaseChrome } from "../../_chrome";
import { InwardEntry } from "./_InwardEntry";

export default function InwardPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const params = useParams<{ transaction_no: string }>();
  const txn = params.transaction_no ? decodeURIComponent(params.transaction_no) : "";

  if (!authed) return <></>;

  return (
    <PurchaseChrome title="Material In · Inward">
      <InwardEntry transactionNo={txn} />
    </PurchaseChrome>
  );
}

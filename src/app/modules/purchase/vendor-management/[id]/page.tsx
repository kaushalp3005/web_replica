"use client";

// Vendor Detail route entry. Auth gate + dynamic [id] segment, then hands off to
// the client detail component wrapped in the Purchase chrome. Mirrors the
// material-in/[transaction_no] page shape.

import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { PurchaseChrome } from "../../_chrome";
import { VendorDetail } from "./_VendorDetail";

export default function VendorDetailPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const params = useParams<{ id: string }>();
  const vendorId = params.id ? decodeURIComponent(params.id) : "";

  if (!authed) return <></>;

  return (
    <PurchaseChrome title="Vendor">
      <VendorDetail vendorId={vendorId} />
    </PurchaseChrome>
  );
}

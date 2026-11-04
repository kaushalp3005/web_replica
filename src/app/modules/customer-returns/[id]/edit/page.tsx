"use client";

// Edit a Customer Return: the shared form (../../_ReturnForm.tsx) loaded with an
// undecided return (Pending / On Hold), so its header, business head, factory unit,
// lines and boxes can all be corrected. A decided return isn't edited here; the
// page says so and links back to it. Opened from the detail page's Edit.

import { useParams } from "next/navigation";
import { useCompanyParam } from "../../_shared";
import { CustomerReturnForm } from "../../_ReturnForm";

export default function EditCustomerReturnPage() {
  const params = useParams<{ id: string }>();
  const company = useCompanyParam();
  return <CustomerReturnForm edit={{ id: decodeURIComponent(params.id), company }} />;
}

// Customer-Returns reference data + approval-flow fixtures.
//
// The approve/reject/hold + send-for-approval + email endpoints are NOT live yet
// (backend Phase 3 unbuilt). The approval screen is wired to these fixtures now
// and swaps to the real client when the endpoints land — same fixtures-now /
// API-later seam the inventory-ledger module uses.
//
// The dropdown option lists mirror the backend's BUSINESS_HEAD_EMAILS /
// SALES_POC_EMAILS (backend/shared/email_notifier.py) and are also used by the
// live create form.

import type { CRStatus, CRWithDetails } from "@/lib/customer-returns";

export const BUSINESS_HEAD_OPTIONS = [
  "Prashant Pal",
  "Ajay Bajaj",
  "Rakesh Ratra",
  "Yash Gawdi",
  "Satyendra Garg",
  "R M Patil",
] as const;

export const SALES_POC_OTHER = "Other" as const;

export const SALES_POC_OPTIONS = [
  "Ashwin Baghul",
  "B Hrithik",
  "Dashrath Birajdar",
  "Mayuresh Mahadik",
  "Sachin More",
  "Shubham Seth",
  "Shubham Shivekar",
  "Suraj Salunkhe",
  "Suresh Luthra",
  "Swadhin Joshi",
  "Ajay Bajaj",
  "Prashant Pal",
  "R M Patil",
  "Rakesh Ratra",
  "Satyendra Garg",
  "Yash Gawdi",
] as const;

export const SALES_POC_DROPDOWN_OPTIONS: string[] = [
  ...[...SALES_POC_OPTIONS].sort((a, b) => a.localeCompare(b)),
  SALES_POC_OTHER,
];

export type ApprovalAction = "approve" | "reject" | "hold";

export const ACTION_TO_STATUS: Record<ApprovalAction, CRStatus> = {
  approve: "Approved",
  reject: "Rejected",
  hold: "On Hold",
};

// Placeholder for the Phase-3 approval endpoint. Resolves with the status the
// backend WOULD set, so the UI can update optimistically. Swap the body for
// `updateCustomerReturn(company, crId, { status })` (or a dedicated /approve
// call) once the backend lands.
export async function mockApplyApproval(action: ApprovalAction): Promise<{ status: CRStatus }> {
  await new Promise((r) => setTimeout(r, 400));
  return { status: ACTION_TO_STATUS[action] };
}

// A demo record so the approval screen renders even with no live CR selected.
export const SAMPLE_CR: CRWithDetails = {
  rtv_id: "CR-20260701120000",
  rtv_date: "2026-07-01T12:00:00+05:30",
  factory_unit: "D-39",
  customer: "Sample Foods Pvt Ltd",
  invoice_number: "INV-2044",
  challan_no: "CH-118",
  dn_no: "DN-77",
  conversion: "12",
  sales_poc: "Shubham Seth",
  sales_poc_email: null,
  business_head: "Prashant Pal",
  remark: "Returned due to cold-chain deviation on 2 pallets.",
  vehicle_number: "MH-12-AB-1234",
  transporter_name: "Safe Logistics",
  driver_name: "Suresh Kumar",
  inward_manager: "Priya Nair",
  status: "Pending" as CRStatus,
  created_by: "warehouse@candorfoods.in",
  created_ts: "2026-07-01T12:00:00+05:30",
  updated_at: null,
  lines: [
    {
      rtv_id: "CR-20260701120000",
      item_description: "Frozen Green Peas 1kg",
      material_type: "FG",
      item_category: "Frozen Veg",
      sub_category: "Peas",
      uom: "12",
      qty: "40",
      rate: "95",
      value: "3800",
      net_weight: "480",
      carton_weight: "0.4",
      lot_number: "L-2261",
      item_mark: "GP-1KG",
      spl_remarks: null,
      vakkal: null,
      created_at: null,
      updated_at: null,
    },
  ],
  boxes: [],
};

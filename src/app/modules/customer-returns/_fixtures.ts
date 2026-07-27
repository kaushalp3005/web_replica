// Customer-Returns reference data for the approval screen.
//
// Approve/Reject/Hold + send-for-approval + the magic-link email are now LIVE
// (lib/customer-returns decideCustomerReturn / sendCustomerReturnForApproval +
// the backend customer_returns router). This file keeps only the small static
// bits the UI still needs: the "Other" POC sentinel, the action→status map, and a
// SAMPLE_CR the approve screen falls back to when a live record can't be loaded.
// Business-Head / Sales-POC NAMES come from the DB routing (getCrEmailRouting).

import type { CRStatus, CRWithDetails } from "@/lib/customer-returns";

export const SALES_POC_OTHER = "Other" as const;

export type ApprovalAction = "approve" | "reject" | "hold";

export const ACTION_TO_STATUS: Record<ApprovalAction, CRStatus> = {
  approve: "Approved",
  reject: "Rejected",
  hold: "On Hold",
};

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

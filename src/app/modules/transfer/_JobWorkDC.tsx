"use client";

// Job-Work Delivery Challan — the printable document that travels with material sent
// out for processing. Ported from legacy_frontend/components/transfer/JobWorkDC.tsx.
//
// Print geometry is A4 portrait with a print-only stylesheet: on screen it renders as a
// bordered sheet inside the app chrome; on print everything but the sheet is hidden and
// the sheet fills the page. The two signature blocks and the declaration line are part of
// the physical document, not decoration — keep them.

import type { JobWorkLine, JobWorkParty } from "@/lib/jobWork";

export interface JobWorkDCProps {
  challanNo: string;
  dated: string;
  fromWarehouse: string;
  eWayBillNo?: string | null;
  dispatchedThrough?: string | null;
  motorVehicleNo?: string | null;
  driverName?: string | null;
  authorizedPerson?: string | null;
  purposeOfWork?: string | null;
  remarks?: string | null;
  expectedReturnDate?: string | null;
  company: {
    name: string; address: string; gstin: string;
    fssai_no: string; state: string; state_code: string; email: string;
  };
  dispatchTo: JobWorkParty;
  lineItems: JobWorkLine[];
}

function n(v: unknown): number {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
}
const dash = (v: unknown): string => {
  const s = v == null ? "" : String(v).trim();
  return s === "" || s.toUpperCase() === "N/A" ? "—" : s;
};

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  try {
    const parsed = new Date(d);
    if (Number.isNaN(parsed.getTime())) return String(d);
    return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return String(d); }
}

const TH = "border border-black px-1.5 py-1 text-[9px] font-bold uppercase tracking-wide text-left align-middle";
const TD = "border border-black px-1.5 py-1 text-[9.5px] align-top";

export function JobWorkDC(props: JobWorkDCProps) {
  const { company, dispatchTo, lineItems } = props;
  const totalBoxes = lineItems.reduce((s, l) => s + n(l.quantity_boxes), 0);
  const totalKgs = lineItems.reduce((s, l) => s + n(l.quantity_kgs), 0);
  const totalAmount = lineItems.reduce((s, l) => s + n(l.amount), 0);
  const hasAmounts = totalAmount > 0;

  return (
    <>
      {/* Print rules live with the document so any page that renders it prints correctly. */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 8mm; }
          body * { visibility: hidden !important; }
          #jobwork-dc, #jobwork-dc * { visibility: visible !important; }
          #jobwork-dc { position: absolute; inset: 0; margin: 0; width: 100%; border: 0 !important; box-shadow: none !important; }
          .dc-no-print { display: none !important; }
        }
      `}</style>

      <div id="jobwork-dc" className="bg-white text-black mx-auto w-full max-w-[210mm] border border-black p-4 text-[10px] leading-snug">
        {/* Title */}
        <div className="text-center border-b border-black pb-1.5 mb-2">
          <div className="text-[15px] font-bold tracking-wide">DELIVERY CHALLAN</div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.12em]">Job Work — Material Out</div>
          <div className="text-[8.5px] italic">(Not a sale — goods sent for job work and returnable)</div>
        </div>

        {/* Issuer + challan meta */}
        <div className="grid grid-cols-2 border border-black">
          <div className="border-r border-black p-2">
            <div className="text-[11px] font-bold">{company.name}</div>
            <div className="text-[9px] mt-0.5 whitespace-pre-line">{company.address}</div>
            <div className="text-[9px] mt-1">GSTIN: <b>{company.gstin}</b></div>
            <div className="text-[9px]">FSSAI: <b>{company.fssai_no}</b></div>
            <div className="text-[9px]">State: {company.state} ({company.state_code}) · {company.email}</div>
          </div>
          <div className="p-2 grid grid-cols-2 gap-x-2 gap-y-1 content-start">
            <Field label="Challan No" value={props.challanNo} strong />
            <Field label="Dated" value={fmtDate(props.dated)} strong />
            <Field label="From Warehouse" value={dash(props.fromWarehouse)} />
            <Field label="Expected Return" value={fmtDate(props.expectedReturnDate)} />
            <Field label="E-Way Bill No" value={dash(props.eWayBillNo)} />
            <Field label="Dispatched Through" value={dash(props.dispatchedThrough)} />
            <Field label="Motor Vehicle No" value={dash(props.motorVehicleNo)} />
            <Field label="Driver" value={dash(props.driverName)} />
          </div>
        </div>

        {/* Consignee */}
        <div className="border-x border-b border-black p-2">
          <div className="text-[8.5px] font-bold uppercase tracking-wide">Dispatched to (Job Worker)</div>
          <div className="text-[11px] font-bold mt-0.5">{dash(dispatchTo.name)}</div>
          <div className="text-[9px] whitespace-pre-line">{dash(dispatchTo.address)}</div>
          <div className="text-[9px] mt-0.5">
            {[dispatchTo.city, dispatchTo.state, dispatchTo.pin_code].filter(Boolean).join(", ") || "—"}
          </div>
          <div className="text-[9px] mt-0.5 flex flex-wrap gap-x-4">
            <span>Contact: {dash(dispatchTo.contact_mobile || dispatchTo.contact_company)}</span>
            {dispatchTo.email ? <span>Email: {dispatchTo.email}</span> : null}
            {dispatchTo.sub_category ? <span>Process: <b>{dispatchTo.sub_category}</b></span> : null}
          </div>
        </div>

        {/* Purpose */}
        <div className="border-x border-b border-black p-2">
          <span className="text-[8.5px] font-bold uppercase tracking-wide">Purpose of Job Work: </span>
          <span className="text-[9.5px]">{dash(props.purposeOfWork)}</span>
        </div>

        {/* Lines */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse mt-2">
            <thead>
              <tr>
                <th className={`${TH} w-[26px] text-center`}>Sl</th>
                <th className={TH}>Description of Goods</th>
                <th className={`${TH} w-[62px]`}>HSN/SAC</th>
                <th className={`${TH} w-[58px]`}>Lot</th>
                <th className={`${TH} w-[46px] text-right`}>Boxes</th>
                <th className={`${TH} w-[62px] text-right`}>Qty (kg)</th>
                {hasAmounts && <th className={`${TH} w-[58px] text-right`}>Rate/kg</th>}
                {hasAmounts && <th className={`${TH} w-[66px] text-right`}>Amount</th>}
              </tr>
            </thead>
            <tbody>
              {lineItems.map((l, i) => (
                <tr key={`${l.sl_no}-${i}`}>
                  <td className={`${TD} text-center tabular-nums`}>{l.sl_no}</td>
                  <td className={TD}>
                    <div className="font-semibold">{dash(l.item_description)}</div>
                    <div className="text-[8.5px]">
                      {[l.material_type, l.item_category, l.sub_category].filter(Boolean).join(" · ") || null}
                    </div>
                    {l.line_remarks ? <div className="text-[8.5px] italic">{l.line_remarks}</div> : null}
                  </td>
                  <td className={`${TD} font-mono`}>{dash(l.hsn_sac)}</td>
                  <td className={`${TD} font-mono`}>{dash(l.lot_number)}</td>
                  <td className={`${TD} text-right tabular-nums`}>{n(l.quantity_boxes) || "—"}</td>
                  <td className={`${TD} text-right tabular-nums`}>{n(l.quantity_kgs).toFixed(3)}</td>
                  {hasAmounts && <td className={`${TD} text-right tabular-nums`}>{n(l.rate_per_kg) ? n(l.rate_per_kg).toFixed(2) : "—"}</td>}
                  {hasAmounts && <td className={`${TD} text-right tabular-nums`}>{n(l.amount) ? n(l.amount).toFixed(2) : "—"}</td>}
                </tr>
              ))}
              {lineItems.length === 0 && (
                <tr><td className={`${TD} text-center italic`} colSpan={hasAmounts ? 8 : 6}>No articles on this challan.</td></tr>
              )}
              <tr>
                <td className={`${TD} font-bold text-right`} colSpan={4}>TOTAL</td>
                <td className={`${TD} text-right font-bold tabular-nums`}>{totalBoxes || "—"}</td>
                <td className={`${TD} text-right font-bold tabular-nums`}>{totalKgs.toFixed(3)}</td>
                {hasAmounts && <td className={TD} />}
                {hasAmounts && <td className={`${TD} text-right font-bold tabular-nums`}>{totalAmount.toFixed(2)}</td>}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Remarks + declaration */}
        <div className="border border-black border-t-0 p-2">
          <div className="text-[8.5px] font-bold uppercase tracking-wide">Remarks</div>
          <div className="text-[9.5px] min-h-[18px]">{dash(props.remarks)}</div>
        </div>
        <div className="border border-black border-t-0 p-2 text-[8.5px] italic">
          Certified that the goods described above are sent for job work only and are returnable.
          This delivery challan is not a sale invoice and no title in the goods passes to the job worker.
        </div>

        {/* Signatures */}
        <div className="grid grid-cols-3 border border-black border-t-0">
          <SignBlock label="Prepared by" value={dash(props.authorizedPerson)} />
          <SignBlock label="Authorised Signatory" value={company.name} border />
          <SignBlock label="Receiver's Signature & Stamp" value={dash(dispatchTo.name)} />
        </div>
      </div>
    </>
  );
}

function Field({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[7.5px] uppercase tracking-wide">{label}</div>
      <div className={`text-[9.5px] truncate ${strong ? "font-bold" : ""}`} title={value}>{value}</div>
    </div>
  );
}

function SignBlock({ label, value, border }: { label: string; value: string; border?: boolean }) {
  return (
    <div className={`p-2 pt-1 ${border ? "border-x border-black" : ""}`}>
      <div className="text-[8px] uppercase tracking-wide">{label}</div>
      <div className="h-[38px]" />
      <div className="border-t border-black pt-0.5 text-[8.5px] truncate" title={value}>{value}</div>
    </div>
  );
}

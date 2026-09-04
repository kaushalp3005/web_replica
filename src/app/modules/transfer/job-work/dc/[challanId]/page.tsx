"use client";

// Job Work — Delivery Challan by challan no. Loads the saved record and renders the
// printable document. Ported from legacy_frontend/app/[company]/transfer/job-work/dc/[challanId].
//
// FRONTEND-FIRST: GET /api/v1/job-work/out/{challan_no} does not exist yet, so this shows
// an explicit "not built" state. The document itself (../../_JobWorkDC) is complete and is
// already reachable from the Material Out form's live preview.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { TransferChrome } from "../../../_chrome";
import { JobWorkDC } from "../../../_JobWorkDC";
import { JobWorkApi, isNotBuiltYet, JOB_WORK_COMPANY, type JobWorkRecord } from "@/lib/jobWork";

const BTN =
  "inline-flex items-center justify-center gap-1 rounded font-medium whitespace-nowrap leading-none h-8 px-3 text-[12px] " +
  "transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--aws-orange)] focus-visible:ring-offset-1";
const BTN_NEUTRAL = `${BTN} border border-[var(--aws-border)] bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:border-[var(--aws-border-strong)]`;
const BTN_BRAND = `${BTN} border border-violet-300 bg-white text-violet-700 hover:bg-violet-50 hover:border-violet-400`;

export default function JobWorkDCPage() {
  const router = useRouter();
  const allowed = useRequireAuth(router.replace);
  const params = useParams<{ challanId: string }>();
  const challanNo = decodeURIComponent(String(params?.challanId ?? ""));

  const [record, setRecord] = useState<JobWorkRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notBuilt, setNotBuilt] = useState(false);

  const load = useCallback(async () => {
    if (!challanNo) return;
    setLoading(true); setError(null); setNotBuilt(false);
    try {
      setRecord(await JobWorkApi.getByChallan(challanNo));
    } catch (err) {
      if (isNotBuiltYet(err)) setNotBuilt(true);
      else setError(err instanceof Error ? err.message : "Failed to load the challan.");
      setRecord(null);
    } finally { setLoading(false); }
  }, [challanNo]);

  // Deferred to a microtask so the synchronous setLoading inside load() doesn't run in the
  // effect body — same pattern as transferIn's resume effect and useRequireAuth itself.
  useEffect(() => {
    if (!allowed) return;
    queueMicrotask(() => { void load(); });
  }, [allowed, load]);

  // No `if (!allowed) return null` gate — that hydration-mismatches (useRequireAuth is
  // true on the server, false on the client's first render). Only the load effect is gated.

  return (
    <TransferChrome title={`Job Work DC — ${challanNo}`}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 dc-no-print">
          <div>
            <h1 className="text-[15px] font-semibold">Delivery Challan</h1>
            <p className="text-[12px] text-[var(--text-secondary)] font-mono">{challanNo}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => router.push("/modules/transfer/job-work")} className={BTN_NEUTRAL}>← All job work</button>
            <button onClick={() => window.print()} disabled={!record} className={BTN_BRAND}>🖨 Print challan</button>
          </div>
        </div>

        {loading && <div className="text-[12px] text-[var(--text-secondary)]">Loading…</div>}
        {error && <div className="border border-rose-200 bg-rose-50 text-rose-800 rounded-md px-3 py-2 text-[12px] dc-no-print">{error}</div>}

        {notBuilt && (
          <div className="border border-amber-200 bg-amber-50 rounded-md px-4 py-3 text-[12px] text-amber-900 space-y-1 dc-no-print">
            <div className="font-semibold">Job-work backend not built yet</div>
            <p>
              <code className="font-mono">GET /api/v1/job-work/out/{"{challan_no}"}</code> does not exist in
              server_replica, so a saved challan can&apos;t be re-opened yet.
            </p>
            <p>
              The document renders from the Material Out form&apos;s{" "}
              <button className="underline" onClick={() => router.push("/modules/transfer/job-work/material-out")}>
                live preview
              </button>{" "}
              in the meantime.
            </p>
          </div>
        )}

        {record && (
          <JobWorkDC
            challanNo={record.challan_no}
            dated={record.job_work_date ?? ""}
            fromWarehouse={record.from_warehouse ?? ""}
            eWayBillNo={record.e_way_bill_no}
            dispatchedThrough={record.dispatched_through}
            motorVehicleNo={record.vehicle_no}
            driverName={record.driver_name}
            authorizedPerson={record.authorized_person}
            purposeOfWork={record.purpose_of_work}
            remarks={record.remarks}
            expectedReturnDate={record.expected_return_date}
            company={JOB_WORK_COMPANY}
            dispatchTo={record.dispatch_to ?? {
              name: record.to_party ?? "", address: record.party_address ?? "",
              state: record.party_state ?? "", city: record.party_city ?? "",
              pin_code: record.party_pin_code ?? "",
              contact_company: record.party_contact_company ?? "",
              contact_mobile: record.party_contact_mobile ?? "",
              email: record.party_email ?? "", sub_category: record.sub_category ?? "",
            }}
            lineItems={record.lines ?? []}
          />
        )}
      </div>
    </TransferChrome>
  );
}

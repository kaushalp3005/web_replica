"use client";

// Header-only correction — PATCH /api/v1/transfer/transfers/{id}.
//
// The full edit form (PUT) deletes and re-inserts every box, so the backend refuses it
// once a GRN exists. That left no way to fix a mistyped vehicle number on a transfer the
// receiver had already started — the only route was deleting their GRN. This panel writes
// header columns only and is therefore available at ANY status.
//
// From/To are deliberately absent: the parked in-transit rows carry the route the boxes
// shipped on, and re-pointing the header would desynchronise them.

import { useState } from "react";
import { TransferApi, type TransferDetail, type TransferHeaderPatchBody } from "@/lib/transfer";
import { friendlyApiError } from "@/lib/apiErrors";
import { Field } from "./_formParts";

const INPUT =
  "w-full px-2.5 py-1.5 text-[13px] border border-[var(--aws-border)] rounded-md";

export function EditHeaderPanel({
  transfer, onSaved, onCancel,
}: {
  transfer: TransferDetail;
  onSaved: (updated: TransferDetail) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    stock_trf_date: transfer.stock_trf_date || "",
    vehicle_no: transfer.vehicle_no || "",
    driver_name: transfer.driver_name || "",
    approved_by: transfer.approved_by || "",
    reason_code: transfer.reason_code || "",
    remark: transfer.remark || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Send only what actually changed. The endpoint uses exclude_unset, so an omitted
      // key is left alone — sending the whole form would rewrite untouched columns and
      // stamp edited_at for a no-op.
      const body: TransferHeaderPatchBody = {};
      if (f.stock_trf_date !== (transfer.stock_trf_date || "")) body.stock_trf_date = f.stock_trf_date;
      if (f.vehicle_no !== (transfer.vehicle_no || "")) body.vehicle_no = f.vehicle_no;
      if (f.driver_name !== (transfer.driver_name || "")) body.driver_name = f.driver_name;
      if (f.approved_by !== (transfer.approved_by || "")) body.approved_by = f.approved_by;
      if (f.reason_code !== (transfer.reason_code || "")) body.reason_code = f.reason_code;
      if (f.remark !== (transfer.remark || "")) body.remark = f.remark;
      if (Object.keys(body).length === 0) { onCancel(); return; }
      onSaved(await TransferApi.patchTransferHeader(transfer.id, body));
    } catch (e) {
      setError(friendlyApiError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tv-noprint bg-white border border-[var(--aws-navy)] rounded-md p-4 space-y-3">
      <div className="text-[13px] font-semibold text-[var(--text-primary)]">Edit transfer details</div>
      <p className="text-[11px] text-[var(--text-secondary)]">
        Paperwork only — items, boxes and stock are untouched, so this stays available after
        a GRN has been raised. To change the route or the items, use the full edit form.
      </p>
      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{error}</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Transfer Date (DD-MM-YYYY)">
          <input value={f.stock_trf_date} onChange={set("stock_trf_date")} className={INPUT} />
        </Field>
        <Field label="Vehicle No"><input value={f.vehicle_no} onChange={set("vehicle_no")} className={INPUT} /></Field>
        <Field label="Driver Name"><input value={f.driver_name} onChange={set("driver_name")} className={INPUT} /></Field>
        <Field label="Approval Authority"><input value={f.approved_by} onChange={set("approved_by")} className={INPUT} /></Field>
        <Field label="Reason"><input value={f.reason_code} onChange={set("reason_code")} className={INPUT} /></Field>
        <Field label="Remark"><input value={f.remark} onChange={set("remark")} className={INPUT} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving}
          className="border border-[var(--aws-border)] bg-white text-[12px] px-3 py-1.5 rounded hover:border-[var(--aws-navy)] disabled:opacity-50">
          Cancel
        </button>
        <button type="button" onClick={save} disabled={saving}
          className="border border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white text-[12px] px-3 py-1.5 rounded disabled:opacity-50">
          {saving ? "Saving…" : "Save details"}
        </button>
      </div>
    </div>
  );
}

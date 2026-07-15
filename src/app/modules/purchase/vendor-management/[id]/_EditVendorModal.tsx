"use client";

// Edit-vendor modal — the 39-field editor (spec §3B). Renders a 2-col grid of
// text / enum / lookup / check / date inputs plus an optional "reason for
// change" note, and builds a PATCH body with the null-vs-unchanged diff
// semantics the backend expects (absent = leave alone, explicit null = clear).

import { useMemo, useState } from "react";
import {
  patchVendor,
  normaliseISODate,
  VENDOR_STATUS,
  type LookupRow,
  type VendorPatchBody,
  type VendorResponse,
  type VendorBody,
} from "@/lib/vendor";
import {
  CodeSelect,
  errMsg,
  INPUT_CLS,
  LABEL_CLS,
  LookupSelect,
  Modal,
  PRIMARY_BTN,
  SECONDARY_BTN,
  type ShowToast,
} from "./_shared";

type FieldKind = "text" | "enum" | "lookup" | "check" | "date";

interface EditField {
  id: keyof VendorBody;
  label: string;
  kind: FieldKind;
  lookup?: string; // lookup TYPE for kind==="lookup"
  full?: boolean;
  mono?: boolean;
  required?: boolean;
}

// Order + kinds ported verbatim from EDIT_FIELDS (vd:283-324).
const EDIT_FIELDS: EditField[] = [
  { id: "name", label: "Name *", kind: "text", required: true },
  { id: "status", label: "Status", kind: "enum" },
  { id: "supplier_reg_year", label: "Reg year", kind: "text" },
  { id: "supplier_type_id", label: "Supplier type", kind: "lookup", lookup: "SUPPLIER_TYPE" },
  { id: "firm_status_id", label: "Firm status", kind: "lookup", lookup: "FIRM_STATUS" },
  { id: "business_type_id", label: "Business type", kind: "lookup", lookup: "BUSINESS_TYPE" },
  { id: "category_code_id", label: "Category", kind: "lookup", lookup: "CATEGORY_CODE" },
  { id: "sub_category", label: "Sub-category", kind: "text" },
  { id: "local_os_id", label: "Local / OS", kind: "lookup", lookup: "LOCAL_OS" },
  { id: "contact_person", label: "Contact person", kind: "text" },
  { id: "designation", label: "Designation", kind: "text" },
  { id: "mobile", label: "Mobile", kind: "text" },
  { id: "phone_company", label: "Phone", kind: "text" },
  { id: "email", label: "Email", kind: "text" },
  { id: "website", label: "Website", kind: "text" },
  { id: "address_line", label: "Address", kind: "text", full: true },
  { id: "city", label: "City", kind: "text" },
  { id: "state", label: "State", kind: "text" },
  { id: "pin_code", label: "PIN", kind: "text" },
  { id: "fssai_no", label: "FSSAI", kind: "text", mono: true },
  { id: "gstn", label: "GSTIN", kind: "text", mono: true },
  { id: "pan_no", label: "PAN", kind: "text", mono: true },
  { id: "cin_no", label: "CIN", kind: "text", mono: true },
  { id: "iec_no", label: "IEC", kind: "text", mono: true },
  { id: "tin_tan", label: "TIN/TAN", kind: "text" },
  { id: "pollution_epr", label: "Pollution", kind: "text" },
  { id: "brc_other", label: "BRC", kind: "text" },
  { id: "is_msme", label: "Is MSME?", kind: "check" },
  { id: "msme_type_id", label: "MSME type", kind: "lookup", lookup: "MSME_TYPE" },
  { id: "msme_registration_date", label: "MSME reg date", kind: "date" },
  { id: "uam_udyam_no", label: "UAM / Udyam", kind: "text", mono: true },
  { id: "scoc_status_id", label: "SCOC status", kind: "lookup", lookup: "KYC_STATUS" },
  { id: "kyc_status_id", label: "KYC status", kind: "lookup", lookup: "KYC_STATUS" },
  { id: "doc_status_id", label: "Doc status", kind: "lookup", lookup: "DOC_STATUS" },
  { id: "core_business", label: "Core business", kind: "text", full: true },
  { id: "capabilities", label: "Capabilities", kind: "text", full: true },
  { id: "business_turnover_3y", label: "3-yr turnover", kind: "text", full: true },
  { id: "reference", label: "Reference", kind: "text", full: true },
  { id: "remarks", label: "Remarks", kind: "text", full: true },
];

type FormState = Record<string, string | boolean>;

function initialForm(vendor: VendorResponse): FormState {
  const f: FormState = {};
  for (const fld of EDIT_FIELDS) {
    const raw = vendor[fld.id as string];
    if (fld.kind === "check") f[fld.id] = !!raw;
    else if (fld.kind === "date") f[fld.id] = normaliseISODate(raw);
    else f[fld.id] = raw == null ? "" : String(raw);
  }
  return f;
}

export function EditVendorModal({
  vendorId,
  vendor,
  lookups,
  onClose,
  onSaved,
  showToast,
}: {
  vendorId: string;
  vendor: VendorResponse;
  lookups: Record<string, LookupRow[]>;
  onClose: () => void;
  onSaved: (updated: VendorResponse) => void;
  showToast: ShowToast;
}): React.JSX.Element {
  const [form, setForm] = useState<FormState>(() => initialForm(vendor));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const setField = (id: string, v: string | boolean) => setForm((prev) => ({ ...prev, [id]: v }));

  async function handleSave() {
    if (saving) return;

    // Build the diff body (spec §3B "Save diff semantics").
    const body: Partial<Record<keyof VendorBody, string | boolean | null>> = {};
    for (const fld of EDIT_FIELDS) {
      if (fld.kind === "check") {
        body[fld.id] = !!form[fld.id];
        continue;
      }
      const raw = String(form[fld.id] ?? "").trim();
      const orig = vendor[fld.id as string];
      const origEmpty = orig == null || orig === "";
      // Absent from body === "leave alone". Only skip when the field was empty
      // and stayed empty; a cleared-but-previously-populated field POSTs null.
      if (raw === "" && origEmpty) continue;
      body[fld.id] = raw === "" ? null : raw;
    }

    // Required guard: never blank an existing name.
    if (!body.name && vendor.name) {
      showToast("Name is required.", "error");
      return;
    }

    setSaving(true);
    try {
      const updated = await patchVendor(vendorId, body as VendorPatchBody, reason.trim() || null);
      onSaved(updated);
      showToast("Vendor updated", "ok");
      onClose();
    } catch (e) {
      showToast(`Couldn't update — ${errMsg(e, "unknown error")}`, "error");
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <button type="button" className={SECONDARY_BTN} onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button type="button" className={PRIMARY_BTN} onClick={() => void handleSave()} disabled={saving}>
        {saving ? "Saving…" : "Save changes"}
      </button>
    </>
  );

  return (
    <Modal title="Edit vendor" onClose={onClose} size="lg" titleId="vd-edit-title" footer={footer}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        {EDIT_FIELDS.map((fld) => (
          <FieldInput
            key={fld.id}
            field={fld}
            value={form[fld.id]}
            lookupRows={fld.lookup ? lookups[fld.lookup] ?? [] : []}
            onChange={(v) => setField(fld.id, v)}
          />
        ))}

        {/* Reason for change */}
        <div className="sm:col-span-2">
          <label htmlFor="ev-_reason" className={LABEL_CLS}>
            Reason for change (optional, shows in history)
          </label>
          <input
            id="ev-_reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. GST cert renewed FY26-27"
            className={`${INPUT_CLS} w-full`}
          />
        </div>
      </div>
    </Modal>
  );
}

function FieldInput({
  field,
  value,
  lookupRows,
  onChange,
}: {
  field: EditField;
  value: string | boolean;
  lookupRows: LookupRow[];
  onChange: (v: string | boolean) => void;
}): React.JSX.Element {
  const wrapCls = useMemo(() => (field.full ? "sm:col-span-2" : ""), [field.full]);

  if (field.kind === "check") {
    return (
      <div className={`${wrapCls} flex items-center gap-2 pt-5`}>
        <input
          id={`ev-${field.id}`}
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label htmlFor={`ev-${field.id}`} className="text-[12px] font-semibold text-[var(--text-primary)]">
          {field.label}
        </label>
      </div>
    );
  }

  return (
    <div className={wrapCls}>
      <label htmlFor={`ev-${field.id}`} className={LABEL_CLS}>
        {field.label}
      </label>
      {field.kind === "enum" ? (
        <CodeSelect id={`ev-${field.id}`} value={String(value)} onChange={onChange} options={VENDOR_STATUS} />
      ) : field.kind === "lookup" ? (
        <LookupSelect id={`ev-${field.id}`} value={String(value)} onChange={onChange} rows={lookupRows} />
      ) : (
        <input
          id={`ev-${field.id}`}
          type={field.kind === "date" ? "date" : "text"}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT_CLS} w-full ${field.mono ? "font-mono" : ""}`}
        />
      )}
    </div>
  );
}

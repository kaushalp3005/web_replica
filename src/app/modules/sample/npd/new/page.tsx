"use client";

// New NPD sample requisition — the NPD-first pure request. Fields (in order):
// type, target NPD article, quantity (kg), description, purpose, requestor,
// warehouse. No article lines, no recipe — those are authored later on the
// requisition's /develop page. Saves a DRAFT via POST /api/v1/sample/npd-requisitions
// (request_id is the surfaced identifier). Validation is enforced inline here
// AND by the backend NpdRequisitionCreate schema.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import {
  createNpdRequisition, NPD_SAMPLE_TYPES, NPD_WAREHOUSES,
  type NpdSampleType, type PurposeTag,
} from "@/lib/sample";
import { FormSection, ReviewRow } from "../../_form";

const PURPOSE_OPTIONS: { value: PurposeTag; label: string }[] = [
  { value: "CUSTOMER_DISPLAY", label: "Customer display" },
  { value: "CUSTOMER_ISSUE", label: "Customer issue" },
  { value: "TASTING_SENSORY", label: "Tasting / sensory" },
  { value: "PHYSICAL_PARAMETERS", label: "Physical parameters" },
  { value: "INTERNAL_OTHER", label: "Internal / other" },
];

export default function NewNpdRequisitionPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();

  const [sampleType, setSampleType] = useState<NpdSampleType | "">("");
  const [targetArticle, setTargetArticle] = useState("");
  const [pcs, setPcs] = useState("");
  const [weightPerPiece, setWeightPerPiece] = useState("");
  const [description, setDescription] = useState("");
  const [purposeTag, setPurposeTag] = useState<PurposeTag | "">("");
  const [requestorTeam, setRequestorTeam] = useState("");
  const [warehouse, setWarehouse] = useState<(typeof NPD_WAREHOUSES)[number] | "">("");
  // Customer + dispatch planning (Company / Customer mandatory).
  const [companyName, setCompanyName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerContact, setCustomerContact] = useState("");
  const [shipTo, setShipTo] = useState("");
  const [modeOfTransport, setModeOfTransport] = useState("");
  const [expectedDispatch, setExpectedDispatch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mandatory: type, target article, pcs (>0), weight per piece (>0), warehouse,
  // company, customer. Quantity is derived = pcs × weight per piece (kg).
  const pcsNum = Number(pcs);
  const wppNum = Number(weightPerPiece);
  const qtyNum = (pcs.trim() !== "" && weightPerPiece.trim() !== ""
    && Number.isFinite(pcsNum) && Number.isFinite(wppNum))
    ? Number((pcsNum * wppNum).toFixed(3)) : 0;
  const canSubmit =
    !!sampleType && targetArticle.trim() !== "" && pcsNum > 0 && wppNum > 0 && !!warehouse &&
    companyName.trim() !== "" && customerName.trim() !== "";

  async function save() {
    if (!canSubmit || !sampleType || !warehouse) return;
    setSaving(true); setError(null);
    try {
      await createNpdRequisition({
        sample_type: sampleType,
        npd_target_name: targetArticle.trim(),
        pcs: pcsNum,
        weight_per_piece: wppNum,
        quantity: qtyNum,
        warehouse,
        company_name: companyName.trim(),
        customer_name: customerName.trim(),
        customer_contact: customerContact.trim() || undefined,
        customer_ship_to_address: shipTo.trim() || undefined,
        mode_of_transport: modeOfTransport.trim() || undefined,
        expected_dispatch_date: expectedDispatch || undefined,
        description: description.trim() || undefined,
        purpose_tag: purposeTag || undefined,
        requestor_team: requestorTeam.trim() || undefined,
      });
      router.push("/modules/sample");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create NPD request");
      setSaving(false);
    }
  }

  if (!authed) return null;

  const typeLabel = NPD_SAMPLE_TYPES.find((t) => t.value === sampleType)?.label ?? "—";

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span><span className="text-white">New NPD request</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...SAMPLE_ROOT, { label: "New NPD request" }]} className="mb-3" />
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-1">New NPD sample request</h1>
        <p className="text-[12px] text-[var(--text-secondary)] mb-4">A pure request — the recipe is developed later on the request’s Develop page.</p>

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {/* 1 · Request details */}
        <FormSection n={1} title="Request details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* type */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Type <span className="text-[var(--aws-error)]">*</span></label>
              <select className="form-input" value={sampleType} onChange={(e) => setSampleType(e.target.value as NpdSampleType)}>
                <option value="">Select…</option>
                {NPD_SAMPLE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            {/* target NPD article */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Target NPD article <span className="text-[var(--aws-error)]">*</span></label>
              <input className="form-input" value={targetArticle} onChange={(e) => setTargetArticle(e.target.value)}
                placeholder="e.g. Premia Trail Mix 200g" />
            </div>
            {/* pcs */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Pcs <span className="text-[var(--aws-error)]">*</span></label>
              <input className="form-input" type="number" min="0" step="1" value={pcs}
                onChange={(e) => setPcs(e.target.value)} placeholder="e.g. 25" />
            </div>
            {/* weight per piece */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Weight per piece (kg) <span className="text-[var(--aws-error)]">*</span></label>
              <input className="form-input" type="number" min="0" step="0.001" value={weightPerPiece}
                onChange={(e) => setWeightPerPiece(e.target.value)} placeholder="e.g. 0.5" />
            </div>
            {/* quantity (computed = pcs × weight per piece) */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Quantity (kg)</label>
              <input className="form-input bg-[var(--surface-subtle)] cursor-not-allowed" value={qtyNum > 0 ? qtyNum.toLocaleString("en-IN") : "—"} readOnly tabIndex={-1} />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">= Pcs × Weight per piece</p>
            </div>
            {/* warehouse */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Warehouse <span className="text-[var(--aws-error)]">*</span></label>
              <select className="form-input" value={warehouse} onChange={(e) => setWarehouse(e.target.value as (typeof NPD_WAREHOUSES)[number])}>
                <option value="">Select…</option>
                {NPD_WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            {/* description */}
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Description</label>
              <textarea className="form-input min-h-[64px] resize-y" value={description}
                onChange={(e) => setDescription(e.target.value)} placeholder="What’s being requested and why (optional)…" />
            </div>
            {/* purpose */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose</label>
              <select className="form-input" value={purposeTag} onChange={(e) => setPurposeTag(e.target.value as PurposeTag)}>
                <option value="">Select…</option>
                {PURPOSE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {/* requestor */}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Requestor / team</label>
              <input className="form-input" value={requestorTeam} onChange={(e) => setRequestorTeam(e.target.value)}
                placeholder="e.g. NPD" />
              <p className="text-[11px] text-[var(--text-muted)] mt-1">Captured as your account automatically; add a team label if relevant.</p>
            </div>
          </div>
        </FormSection>

        {/* 2 · Customer & dispatch */}
        <FormSection n={2} title="Customer & dispatch">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Company name <span className="text-[var(--aws-error)]">*</span></label>
              <input className="form-input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Candor Foods Pvt Ltd" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer name <span className="text-[var(--aws-error)]">*</span></label>
              <input className="form-input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="e.g. BigBasket" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer contact</label>
              <input className="form-input" value={customerContact} onChange={(e) => setCustomerContact(e.target.value)} placeholder="name / phone / email" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Mode of transport</label>
              <input className="form-input" value={modeOfTransport} onChange={(e) => setModeOfTransport(e.target.value)} placeholder="e.g. Road / Air / Courier" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Expected dispatch date <span className="text-[11px] font-normal text-[var(--text-muted)]">(by BD team)</span></label>
              <input className="form-input" type="date" value={expectedDispatch} onChange={(e) => setExpectedDispatch(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer ship-to address</label>
              <textarea className="form-input min-h-[56px] resize-y" value={shipTo} onChange={(e) => setShipTo(e.target.value)} placeholder="Delivery address (optional)…" />
            </div>
          </div>
        </FormSection>

        {/* 3 · Review */}
        <FormSection n={3} title="Review">
          <dl className="space-y-1.5 text-[13px]">
            <ReviewRow label="Type" value={typeLabel} />
            <ReviewRow label="Target article" value={targetArticle || "—"} />
            <ReviewRow label="Pcs" value={pcs || "—"} />
            <ReviewRow label="Weight per piece" value={weightPerPiece ? `${weightPerPiece} kg` : "—"} />
            <ReviewRow label="Quantity" value={qtyNum > 0 ? `${qtyNum} kg` : "—"} />
            <ReviewRow label="Warehouse" value={warehouse || "—"} />
            <ReviewRow label="Company" value={companyName || "—"} />
            <ReviewRow label="Customer" value={customerName || "—"} />
            {customerContact && <ReviewRow label="Customer contact" value={customerContact} />}
            {shipTo && <ReviewRow label="Ship-to" value={shipTo} />}
            {modeOfTransport && <ReviewRow label="Mode of transport" value={modeOfTransport} />}
            {expectedDispatch && <ReviewRow label="Expected dispatch" value={expectedDispatch} />}
            <ReviewRow label="Purpose" value={purposeTag || "—"} />
            {requestorTeam && <ReviewRow label="Requestor team" value={requestorTeam} />}
            {description && <ReviewRow label="Description" value={description} />}
          </dl>
        </FormSection>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => router.push("/modules/sample")}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={saving || !canSubmit} onClick={save}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">
            {saving ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </main>
    </div>
  );
}

"use client";

// New NPD sample requisition — the NPD-first pure request. Fields (in order):
// type, target NPD article, quantity (kg), description, purpose, requestor,
// warehouse. No article lines, no recipe — those are authored later on the
// requisition's /develop page. Saves a DRAFT via POST /api/v1/sample/npd-requisitions
// (request_id is the surfaced identifier). Validation is enforced inline here
// AND by the backend NpdRequisitionCreate schema.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import {
  createNpdRequisition, NPD_SAMPLE_TYPES, NPD_WAREHOUSES,
  type NpdSampleType, type PurposeTag,
} from "@/lib/sample";
import {
  FormSection, ReviewRow, BillingFields, billingError, billingPayload, EMPTY_BILLING, type BillingValue,
  TargetArticlesEditor, targetsValid, targetsPayload, targetsTotalQty, EMPTY_TARGET, type TargetRow,
} from "../../_form";

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
  const [targets, setTargets] = useState<TargetRow[]>([{ ...EMPTY_TARGET }]);
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
  const [billing, setBilling] = useState<BillingValue>(EMPTY_BILLING);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mandatory: type, ≥1 target (name + pcs>0 + weight>0), warehouse, company,
  // customer. Each target's quantity is derived = pcs × weight per piece (kg).
  const totalQty = targetsTotalQty(targets);
  const canSubmit =
    !!sampleType && targetsValid(targets) && !!warehouse &&
    companyName.trim() !== "" && customerName.trim() !== "" && !billingError(billing);

  async function save() {
    if (!canSubmit || !sampleType || !warehouse) return;
    setSaving(true); setError(null);
    try {
      await createNpdRequisition({
        sample_type: sampleType,
        targets: targetsPayload(targets),
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
        ...billingPayload(billing),
      });
      router.push("/modules/sample");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create NPD request");
      setSaving(false);
    }
  }

  // Hydration gate: on SSR useRequireAuth returns true (no token store), but the
  // first client render starts authed=false — a bare early-return made the server
  // HTML and the first client paint diverge (the duplicated/ghost screen). Hold the
  // redirect until after mount so SSR and the first client paint are identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  if (mounted && !authed) return null;

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
            {/* target articles — one or more products, each pcs × weight → qty */}
            <div className="sm:col-span-2">
              <TargetArticlesEditor rows={targets} onChange={setTargets} />
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
            <div className="sm:col-span-2">
              <BillingFields value={billing} onChange={setBilling} />
            </div>
          </div>
        </FormSection>

        {/* 3 · Review */}
        <FormSection n={3} title="Review">
          <dl className="space-y-1.5 text-[13px]">
            <ReviewRow label="Type" value={typeLabel} />
            <ReviewRow label={`Target articles (${targets.length})`} value={targets.map((t) => t.name.trim()).filter(Boolean).join(", ") || "—"} />
            <ReviewRow label="Total quantity" value={totalQty > 0 ? `${totalQty.toLocaleString("en-IN")} kg` : "—"} />
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
            <ReviewRow label="Return type" value={billing.returnable ? "Returnable" : billing.non_returnable ? "Non-returnable" : "—"} />
            <ReviewRow label="Paid" value={billing.paid ? `Yes · ${billing.amount || "0"}` : "No"} />
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

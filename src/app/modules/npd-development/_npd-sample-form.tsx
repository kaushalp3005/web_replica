"use client";

// NPD sample REQUEST form. A business/NPD requester raises a requisition naming
// the new product (Target NPD article name); the recipe (base BOM, ingredients,
// promotion to a live BOM) is authored entirely by the NPD team later on the
// requisition detail page. Fields, in order:
//   type → warehouse → target NPD article → quantity (kg) → purpose → requestor → description
// Mandatory: target article, quantity (> 0). Warehouse is also required by the
// backend (NpdRequisitionCreate). Posts to the dedicated NPD endpoint, which
// re-validates the NPD-mandatory fields server-side.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useIsAdmin } from "@/lib/user";
import {
  createNpdRequisition, submitRequisition, listBusinessHeads, NPD_SAMPLE_TYPES, NPD_WAREHOUSES,
  type NpdSampleType, type PurposeTag,
} from "@/lib/sample";
import { roleNamesOf } from "@/lib/sample-roles";
import {
  FormSection, BillingFields, billingError, billingPayload, EMPTY_BILLING, type BillingValue,
  TargetArticlesEditor, targetsValid, targetsPayload, EMPTY_TARGET, type TargetRow,
} from "../sample/_form";

const PURPOSE_OPTIONS: { value: PurposeTag; label: string }[] = [
  { value: "CUSTOMER_DISPLAY", label: "Customer display" },
  { value: "CUSTOMER_ISSUE", label: "Customer issue" },
  { value: "TASTING_SENSORY", label: "Tasting / sensory" },
  { value: "PHYSICAL_PARAMETERS", label: "Physical parameters" },
  { value: "INTERNAL_OTHER", label: "Internal / other" },
];

export function NpdSampleForm({ defaultType, heading }: {
  defaultType: NpdSampleType;
  heading: string;
}) {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const isAdmin = useIsAdmin();
  const profileName = (me?.full_name ?? "").trim();
  // sales (like admin) raises on behalf of a business head → pick the requestor from a
  // dropdown of BHs, rather than defaulting to the signed-in user's own name.
  const needsBhDropdown = isAdmin || roleNamesOf(me).includes("sales");

  const [type, setType] = useState<NpdSampleType>(defaultType);
  const [warehouse, setWarehouse] = useState<(typeof NPD_WAREHOUSES)[number] | "">("");
  // Multiple target articles — each a product with its own pcs × weight → qty.
  const [targets, setTargets] = useState<TargetRow[]>([{ ...EMPTY_TARGET }]);
  const [purposeTag, setPurposeTag] = useState<PurposeTag | "">("");
  const [requestorTeam, setRequestorTeam] = useState("");
  const [requestorTouched, setRequestorTouched] = useState(false);
  const [reqOptions, setReqOptions] = useState<string[]>([]);   // business-head names (no admins)
  const [description, setDescription] = useState("");
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
  const [savedId, setSavedId] = useState<number | null>(null);

  // Requestor is a business head chosen from the dropdown. An admin must pick one
  // (no self-default); a non-admin's free-text field still defaults to their own name.
  const effectiveRequestor = requestorTouched ? requestorTeam : (needsBhDropdown ? "" : profileName);

  // Admin + sales pick the requestor from a dropdown of business heads. Fetched via the
  // sample business-heads endpoint (not admin-gated, so a sales user can populate it too).
  useEffect(() => {
    if (!needsBhDropdown) return;
    let cancelled = false;
    listBusinessHeads().then((names) => {
      if (cancelled) return;
      setReqOptions(Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))));
    }).catch(() => { /* leave empty — the placeholder prompts a selection */ });
    return () => { cancelled = true; };
  }, [needsBhDropdown]);

  // Business heads only — never the signed-in admin's own name.
  const requestorChoices = reqOptions;

  // Mandatory: ≥1 target (name + pcs>0 + weight>0), warehouse, company, customer.
  const canSave =
    !!warehouse && targetsValid(targets) &&
    companyName.trim() !== "" && customerName.trim() !== "" && !billingError(billing) &&
    (!needsBhDropdown || effectiveRequestor.trim() !== "");   // sales/admin must pick a BH

  async function save(submit: boolean) {
    if (!canSave || !warehouse) return;
    setSaving(true); setError(null);
    try {
      let reqId = savedId;
      if (reqId == null) {
        const req = await createNpdRequisition({
          sample_type: type,
          warehouse,
          targets: targetsPayload(targets),
          company_name: companyName.trim(),
          customer_name: customerName.trim(),
          customer_contact: customerContact.trim() || undefined,
          customer_ship_to_address: shipTo.trim() || undefined,
          mode_of_transport: modeOfTransport.trim() || undefined,
          expected_dispatch_date: expectedDispatch || undefined,
          purpose_tag: purposeTag || undefined,
          requestor_team: effectiveRequestor.trim() || undefined,
          description: description.trim() || undefined,
          ...billingPayload(billing),
        });
        reqId = req.id;
        setSavedId(reqId);
      }
      if (submit) await submitRequisition(reqId);
      router.push(`/modules/sample/${reqId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
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

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/npd-development")} className="hover:underline">NPD Development</button>
          <span>/</span><span className="text-white">New</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...NPD_DEV_ROOT, { label: heading }]} className="mb-3" />
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-4">{heading}</h1>

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {/* 1 · Details — order: type → warehouse → target → quantity → purpose → requestor → description */}
        <FormSection n={1} title="Details">
          <div className="space-y-3">
            {/* type */}
            <div>
              <span className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">Type</span>
              <Segmented value={type} onChange={(v) => setType(v as NpdSampleType)}
                options={NPD_SAMPLE_TYPES.map((t) => ({ v: t.value, label: t.label }))} />
            </div>

            {/* warehouse */}
            <div className="sm:max-w-[50%]">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Warehouse <span className="text-[var(--aws-error)]">*</span></label>
              <select className="form-input" value={warehouse} onChange={(e) => setWarehouse(e.target.value as (typeof NPD_WAREHOUSES)[number])}>
                <option value="">Select…</option>
                {NPD_WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>

            {/* target articles — one or more products, each pcs × weight → qty */}
            <TargetArticlesEditor rows={targets} onChange={setTargets} />

            {/* purpose / requestor / description (optional) */}
            <div className="rounded-md border border-[var(--aws-border)] p-3">
              <span className="block text-[12px] font-medium text-[var(--text-secondary)] mb-3">Purpose, requestor &amp; description (optional)</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Requestor {needsBhDropdown && <span className="text-[var(--aws-error)]">*</span>}</label>
                  {needsBhDropdown ? (
                    <select className="form-input" value={effectiveRequestor}
                      onChange={(e) => { setRequestorTouched(true); setRequestorTeam(e.target.value); }}>
                      <option value="">Select a business head…</option>
                      {requestorChoices.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : (
                    <input className="form-input" value={effectiveRequestor}
                      onChange={(e) => { setRequestorTouched(true); setRequestorTeam(e.target.value); }} />
                  )}
                </div>
                {/* description */}
                <div className="sm:col-span-2">
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Description</label>
                  <textarea className="form-input min-h-[64px] resize-y" value={description}
                    onChange={(e) => setDescription(e.target.value)} placeholder="What&apos;s being requested and why (optional)…" />
                </div>
              </div>
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

        {/* Actions */}
        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => router.push("/modules/npd-development")}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={saving || !canSave} onClick={() => save(false)}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)] disabled:opacity-50">Save draft</button>
          <button disabled={saving || !canSave} onClick={() => save(true)}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{saving ? "Saving…" : "Save & submit"}</button>
        </div>
      </main>
    </div>
  );
}

// Small two-option segmented control.
function Segmented({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { v: string; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-[2px] border border-[var(--aws-border-strong)] overflow-hidden">
      {options.map((o, i) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)}
          className={`px-3 h-8 text-[12px] ${i > 0 ? "border-l border-[var(--aws-border-strong)]" : ""} ${value === o.v ? "bg-[var(--aws-orange)] text-white font-medium" : "bg-white text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)]"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

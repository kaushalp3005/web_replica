"use client";

// NPD sample REQUEST form. A business/NPD requester raises a requisition naming
// the new product (Target NPD article name); the recipe (base BOM, ingredients,
// promotion to a live BOM) is authored entirely by the NPD team later on the
// requisition detail page. Fields, in order:
//   type → warehouse → target NPD article → quantity (kg) → purpose → business head → description
// Mandatory: target article, quantity (> 0). Warehouse is also required by the
// backend (NpdRequisitionCreate). Posts to the dedicated NPD endpoint, which
// re-validates the NPD-mandatory fields server-side.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useHasPermission } from "@/lib/user";
import {
  createNpdRequisition, submitRequisition, listBusinessHeads, listSalesPocs,
  NPD_SAMPLE_TYPES, NPD_WAREHOUSES, DEFAULT_NPD_WAREHOUSE,
  type NpdSampleType, type PurposeTag, type BusinessHead, type SalesPoc,
} from "@/lib/sample";
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
  const canCreateReq = useHasPermission("sample", "requisition", null, "create");
  const profileName = (me?.full_name ?? "").trim();
  // "me" is always selectable as the sales POC, matching the server's default.
  // MeResponse.user_id is a STRING on the wire; SalesPoc.user_id is numeric.
  const meId = Number(me?.user_id ?? 0) || 0;
  // The business head is ALWAYS chosen from the list — for every role, not just
  // admin/sales. It used to fall back to a free-text box that pre-filled the signed-in
  // user's own name, which left requestor_user_id pointing at the creator: the promote
  // approval (WhatsApp and mail) then went back to whoever raised the request instead of
  // to the business head who has to approve it.

  const [type, setType] = useState<NpdSampleType>(defaultType);
  // W202 is where NPD samples are raised from in practice — pre-selected so the common
  // case is one fewer click. Still a full dropdown; any other warehouse is one change away.
  const [warehouse, setWarehouse] = useState<(typeof NPD_WAREHOUSES)[number] | "">(DEFAULT_NPD_WAREHOUSE);
  // Multiple target articles — each a product with its own pcs × weight → qty.
  const [targets, setTargets] = useState<TargetRow[]>([{ ...EMPTY_TARGET }]);
  const [purposeTag, setPurposeTag] = useState<PurposeTag | "">("");
  const [requestorTeam, setRequestorTeam] = useState("");
  // Business heads (no admins). The dropdown carries user_id, not just the name: the
  // server binds requestor_user_id + business_head_user_id from it, which is what routes
  // the approval gate and the request's mail trail to that specific person.
  const [reqUserId, setReqUserId] = useState<number | "">("");
  const [reqOptions, setReqOptions] = useState<BusinessHead[]>([]);
  // Sales POC — defaults to the signed-in user and stays editable. "" means "unchanged",
  // which the server reads as "default to me".
  const [salesPocId, setSalesPocId] = useState<number | "">("");
  const [pocOptions, setPocOptions] = useState<SalesPoc[]>([]);
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

  // Business heads for the picker, via the sample business-heads endpoint (not
  // admin-gated, so every requesting role can populate it).
  useEffect(() => {
    let cancelled = false;
    listBusinessHeads().then((bhs) => {
      if (cancelled) return;
      setReqOptions(bhs);
    }).catch(() => { /* leave empty — the placeholder prompts a selection */ });
    return () => { cancelled = true; };
  }, []);

  // A business head raising their own request: pre-select THEMSELVES as both the
  // business head and the sales POC. That pairing is what tells the server no approval
  // is needed (086) — a BH has already said yes by raising it — so defaulting the two
  // fields together is what makes "no approval message" the outcome for this case.
  //
  // Membership of the business-heads list is the test, not a role string: it is the same
  // set the server validates requestor_user_id against, so a value defaulted from it is
  // always selectable and always accepted.
  const selfDefaulted = useRef(false);
  useEffect(() => {
    if (selfDefaulted.current || !meId || reqOptions.length === 0) return;
    const self = reqOptions.find((b) => b.user_id === meId);
    if (!self) { selfDefaulted.current = true; return; }   // not a BH — leave the prompt
    selfDefaulted.current = true;
    // Deferred past the effect body (the house pattern here — see the mounted/load
    // effects) so the defaults land as one follow-up render, not a cascade.
    queueMicrotask(() => {
      setReqUserId((cur) => (cur === "" ? self.user_id : cur));
      setRequestorTeam((cur) => (cur === "" ? self.full_name : cur));
      setSalesPocId((cur) => (cur === "" ? self.user_id : cur));
    });
  }, [reqOptions, meId]);

  // Sales POC options.
  useEffect(() => {
    let cancelled = false;
    listSalesPocs().then((ps) => { if (!cancelled) setPocOptions(ps); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Business heads only — never the signed-in user's own name unless they are one.
  const requestorChoices = reqOptions;
  const pocChoices: SalesPoc[] =
    meId && !pocOptions.some((p) => p.user_id === meId)
      ? [{ user_id: meId, full_name: `${profileName || "Me"} (me)`, email: me?.email ?? "" },
         ...pocOptions]
      : pocOptions;

  // Mirrors the server's approval_service.bh_signoff_decision: the sales POC defaults to
  // the signed-in user, so an empty POC selection still means "me".
  const effectivePocId = typeof salesPocId === "number" && salesPocId > 0 ? salesPocId : meId;
  const bhIsPoc = typeof reqUserId === "number" && reqUserId > 0 && reqUserId === effectivePocId;

  // Mandatory: ≥1 target (name + pcs>0 + weight>0), warehouse, company, customer.
  const canSave =
    !!warehouse && targetsValid(targets) &&
    companyName.trim() !== "" && customerName.trim() !== "" && !billingError(billing) &&
    requestorTeam.trim() !== "";   // a business head must always be chosen

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
          requestor_team: requestorTeam.trim() || undefined,
          requestor_user_id: typeof reqUserId === "number" && reqUserId > 0 ? reqUserId : undefined,
          sales_poc_user_id: typeof salesPocId === "number" && salesPocId > 0 ? salesPocId : undefined,
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
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Business head <span className="text-[var(--aws-error)]">*</span></label>
                  {(
                    <select className="form-input" value={reqUserId === "" ? "" : String(reqUserId)}
                      onChange={(e) => {
                        const id = e.target.value === "" ? "" : Number(e.target.value);
                        setReqUserId(id);
                        setRequestorTeam(reqOptions.find((b) => b.user_id === id)?.full_name ?? "");
                      }}>
                      <option value="">Select a business head…</option>
                      {requestorChoices.map((b) => (
                        <option key={b.user_id} value={String(b.user_id)}>{b.full_name}</option>
                      ))}
                    </select>
                  )}
                </div>
                {/* Sales POC — defaults to the signed-in user, editable; Cc'd on the mail trail */}
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Sales POC</label>
                  <select className="form-input" value={salesPocId === "" ? "" : String(salesPocId)}
                    onChange={(e) => setSalesPocId(e.target.value === "" ? "" : Number(e.target.value))}
                    title="Sales point of contact — receives the request's mail trail">
                    <option value="">{profileName ? `${profileName} (me)` : "Me"}</option>
                    {pocChoices.filter((pc) => pc.user_id !== meId).map((pc) => (
                      <option key={pc.user_id} value={String(pc.user_id)}>{pc.full_name}</option>
                    ))}
                  </select>
                </div>
                {/* What submitting will actually do — the BH approval gate is invisible
                    otherwise, and "why did/didn't my BH get a message?" is the question
                    it exists to answer. */}
                <div className="sm:col-span-2 -mt-1">
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                    {requestorTeam.trim() === "" ? (
                      "Choose a business head — they approve the request before it reaches the NPD team."
                    ) : bhIsPoc ? (
                      <>No approval message will be sent — the sales POC on this request <em>is</em> its business head, so it goes straight to the NPD team.</>
                    ) : (
                      <>On submit, <span className="font-medium text-[var(--text-secondary)]">{requestorTeam.trim()}</span> is asked to approve this request. It reaches the NPD team once they do.</>
                    )}
                  </p>
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
          <button disabled={saving || !canSave || !canCreateReq} onClick={() => save(false)}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)] disabled:opacity-50">Save draft</button>
          <button disabled={saving || !canSave || !canCreateReq} onClick={() => save(true)}
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

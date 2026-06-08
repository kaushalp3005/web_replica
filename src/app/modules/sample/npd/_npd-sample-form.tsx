"use client";

// NPD sample REQUEST form. A business/NPD requester raises a requisition naming
// the new product (Target NPD article name) — the recipe (base BOM, ingredients,
// promotion to a live BOM) is authored entirely by the NPD team later on the
// requisition detail page. So this form is deliberately minimal: type, warehouse,
// the target article name, and optional purpose/notes.
//   • type = NPD (internal) | TRIAL (customer) → sample_requisitions.sample_type

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useIsAdmin } from "@/lib/user";
import {
  createRequisition, submitRequisition, WAREHOUSES,
  type PurposeTag, type SampleType, type Warehouse,
} from "@/lib/sample";
import { listUsers } from "@/lib/admin-api";
import { FormSection } from "../_form";

const PURPOSE_OPTIONS: { value: PurposeTag; label: string }[] = [
  { value: "CUSTOMER_DISPLAY", label: "Customer display" },
  { value: "CUSTOMER_ISSUE", label: "Customer issue" },
  { value: "TASTING_SENSORY", label: "Tasting / sensory" },
  { value: "PHYSICAL_PARAMETERS", label: "Physical parameters" },
  { value: "INTERNAL_OTHER", label: "Internal / other" },
];

export function NpdSampleForm({ defaultType, heading }: {
  defaultType: "NPD" | "TRIAL";
  heading: string;
}) {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const isAdmin = useIsAdmin();
  const profileName = (me?.full_name ?? "").trim();

  const [type, setType] = useState<"NPD" | "TRIAL">(defaultType);
  const [warehouse, setWarehouse] = useState<Warehouse | "">("");
  const [customerName, setCustomerName] = useState("");
  const [fgSkuName, setFgSkuName] = useState("");          // new article name
  const [quantity, setQuantity] = useState("");            // requested quantity (free float)
  const [purposeTag, setPurposeTag] = useState<PurposeTag | "">("");
  const [purposeNote, setPurposeNote] = useState("");
  const [requestorTeam, setRequestorTeam] = useState("");
  const [requestorTouched, setRequestorTouched] = useState(false);
  const [reqOptions, setReqOptions] = useState<string[]>([]);   // admin / business-head names (admins only)
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);

  // Requestor defaults to the signed-in user's profile name until they change it.
  const effectiveRequestor = requestorTouched ? requestorTeam : profileName;

  // Admins pick the requestor from a dropdown of all admins + business heads.
  // (The /users endpoint is admin-gated, so non-admins never call it.)
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    listUsers().then((users) => {
      if (cancelled) return;
      const names = users
        .filter((u) => u.is_admin === true || u.role_name === "business_head")
        .map((u) => (u.full_name ?? "").trim())
        .filter(Boolean);
      setReqOptions(Array.from(new Set(names)));
    }).catch(() => { /* leave empty — falls back to the profile name */ });
    return () => { cancelled = true; };
  }, [isAdmin]);

  // The dropdown always includes the signed-in admin's own name as the default.
  const requestorChoices = (profileName && !reqOptions.includes(profileName))
    ? [profileName, ...reqOptions] : reqOptions;

  // Only the request essentials are required: a warehouse and the target name.
  const canSave = !!warehouse && !!fgSkuName.trim();

  async function save(submit: boolean) {
    setSaving(true); setError(null);
    try {
      let reqId = savedId;
      if (reqId == null) {
        const req = await createRequisition({
          sample_type: type as SampleType,
          warehouse: warehouse as Warehouse,
          requestor_team: type === "TRIAL" && customerName.trim()
            ? `Customer: ${customerName.trim()}` : (effectiveRequestor || undefined),
          purpose_tag: purposeTag || undefined,
          purpose_note: purposeNote || undefined,
          npd_target_name: fgSkuName.trim() || undefined,
          quantity: quantity.trim() ? Number(quantity) : undefined,
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

  if (!authed) return null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/sample/npd")} className="hover:underline">NPD</button>
          <span>/</span><span className="text-white">New</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...SAMPLE_ROOT, { label: "NPD", href: "/modules/sample/npd" }, { label: heading }]} className="mb-3" />
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-4">{heading}</h1>

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {/* 1 · Details */}
        <FormSection n={1} title="Details">
          <div className="space-y-3">
            <div>
              <span className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">Type</span>
              <Segmented value={type} onChange={(v) => setType(v as "NPD" | "TRIAL")}
                options={[{ v: "NPD", label: "NPD (internal)" }, { v: "TRIAL", label: "Customer trial" }]} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Warehouse <span className="text-[var(--aws-error)]">*</span></label>
                <select className="form-input" value={warehouse} onChange={(e) => setWarehouse(e.target.value as Warehouse)}>
                  <option value="">Select…</option>
                  {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              </div>
              {type === "TRIAL" && (
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer name</label>
                  <input className="form-input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Target NPD article name <span className="text-[var(--aws-error)]">*</span></label>
                <input className="form-input" value={fgSkuName} onChange={(e) => setFgSkuName(e.target.value)} placeholder="name of the new product being requested / developed" />
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">Carried on the requisition; the NPD team uses it as the new BOM&apos;s FG name when they open it into development.</p>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Quantity</label>
                {/* blur on wheel so scrolling over the field doesn't nudge the number */}
                <input className="form-input" type="number" min="0" step="0.001" value={quantity}
                  onChange={(e) => setQuantity(e.target.value)} onWheel={(e) => e.currentTarget.blur()} placeholder="e.g. 5" />
              </div>
            </div>

            {/* Purpose & notes (optional) — always visible */}
            <div className="rounded-md border border-[var(--aws-border)] p-3">
              <span className="block text-[12px] font-medium text-[var(--text-secondary)] mb-3">Purpose &amp; notes (optional)</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose</label>
                  <select className="form-input" value={purposeTag} onChange={(e) => setPurposeTag(e.target.value as PurposeTag)}>
                    <option value="">Select…</option>
                    {PURPOSE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                {type === "NPD" && (
                  <div>
                    <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Requestor team</label>
                    {isAdmin ? (
                      <select className="form-input" value={effectiveRequestor}
                        onChange={(e) => { setRequestorTouched(true); setRequestorTeam(e.target.value); }}>
                        {requestorChoices.length === 0 && <option value="">Select…</option>}
                        {requestorChoices.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    ) : (
                      <input className="form-input" value={effectiveRequestor}
                        onChange={(e) => { setRequestorTouched(true); setRequestorTeam(e.target.value); }} />
                    )}
                  </div>
                )}
                <div className="sm:col-span-2">
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose note</label>
                  <input className="form-input" value={purposeNote} onChange={(e) => setPurposeNote(e.target.value)} />
                </div>
              </div>
            </div>
          </div>
        </FormSection>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => router.push("/modules/sample/npd")}
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

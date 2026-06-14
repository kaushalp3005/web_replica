"use client";

// Raise an RM Issue / Collection Form (Document 015). The NPD author lists the
// RM to draw (per-line OWN vs CUSTOMER-supplied); submitting notifies the Store.
// The Store later records issued_qty + lot_no, which fires Step A (265).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import { raiseRmForm, type RmLine } from "@/lib/rm-issue-form";
import { getDevJobCard } from "@/lib/npd-dev";
import { FormSection, ArticlePicker } from "../../_form";

interface DraftLine {
  sku_id: number | null;
  sku_name: string;
  reqd_qty: string;
  uom: string;
  ownership: "OWN" | "CUSTOMER";
  location?: string;
}

const PURPOSE_OPTIONS = ["LAB_TRIAL", "TASTING_SENSORY", "PHYSICAL_PARAMETERS", "CUSTOMER_DISPLAY", "INTERNAL_OTHER"];

export default function RaiseRmFormPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();

  const [trialName, setTrialName] = useState("");
  const [productName, setProductName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [purposeTag, setPurposeTag] = useState("LAB_TRIAL");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);
  // Source linkage — set when launched from a dev job card / requisition.
  const [sourceType, setSourceType] = useState("STANDALONE");
  const [sourceId, setSourceId] = useState<number | null>(null);

  // When opened from a dev job card (?source_type=NPD_DEV_JC&source_id=...), seed
  // the header and the RM lines from that trial recipe so the floor just confirms.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const sp = new URLSearchParams(window.location.search);
      const st = sp.get("source_type"); const si = sp.get("source_id");
      if (st) setSourceType(st);
      if (si) setSourceId(Number(si));
      const qt = sp.get("trial"); if (qt) setTrialName(qt);
      const qp = sp.get("product"); if (qp) setProductName(qp);
      const qc = sp.get("customer"); if (qc) setCustomerName(qc);
      if (st === "NPD_DEV_JC" && si) {
        getDevJobCard(Number(si)).then((jc) => {
          if (cancelled) return;
          if (!qt && jc.title) setTrialName(jc.title);
          if (!qp && jc.fg_sku_name) setProductName(jc.fg_sku_name);
          // Seed RM (raw-material) recipe lines; PM/output excluded.
          const rm = (jc.lines ?? []).filter((l) => (l.item_type ?? "rm") === "rm");
          if (rm.length) {
            setLines(rm.map((l) => ({
              sku_id: l.sku_id, sku_name: l.sku_name, reqd_qty: String(l.qty ?? "1"),
              uom: l.uom || "kg", ownership: l.is_off_master ? "CUSTOMER" : "OWN",
            })));
          }
        }).catch(() => { /* leave the form blank on lookup failure */ });
      }
    });
    return () => { cancelled = true; };
  }, []);

  const canRaise = lines.length > 0 && lines.every((l) => Number(l.reqd_qty) > 0);

  function addLine(s: { sku_id: number; sku_name: string }) {
    if (lines.some((l) => l.sku_id === s.sku_id)) return;
    setLines((prev) => [...prev, { sku_id: s.sku_id, sku_name: s.sku_name, reqd_qty: "1", uom: "kg", ownership: "OWN" }]);
  }
  function patchLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function raise(submit: boolean) {
    setSaving(true); setError(null);
    try {
      let id = savedId;
      if (id == null) {
        const wire: RmLine[] = lines.map((l, idx) => ({
          sku_id: l.sku_id, sku_name: l.sku_name, reqd_qty: Number(l.reqd_qty) || 0,
          uom: l.uom, ownership: l.ownership, is_off_master: l.ownership === "CUSTOMER",
          location: l.location || null, line_order: idx,
        }));
        const form = await raiseRmForm({
          trial_name: trialName || undefined, product_name: productName || undefined,
          customer_name: customerName || undefined, purpose_tag: purposeTag || undefined,
          source_type: sourceType, source_id: sourceId ?? undefined, submit, lines: wire,
        });
        id = form.id;
        setSavedId(id);
      }
      router.push(`/modules/sample/rm-issue-forms/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to raise indent");
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
          <button onClick={() => router.push("/modules/sample/rm-issue-forms")} className="hover:underline">RM Issue Forms</button>
          <span>/</span><span className="text-white">Raise</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...SAMPLE_ROOT, { label: "RM forms", href: "/modules/sample/rm-issue-forms" }, { label: "Raise" }]} className="mb-3" />
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-1">Raise RM indent (Document 015)</h1>
        {sourceType === "NPD_DEV_JC" && sourceId != null && (
          <p className="mb-4 text-[12px] text-[var(--text-secondary)]">Linked to development job card <button className="text-[var(--aws-orange)] hover:underline" onClick={() => router.push(`/modules/npd-development/job-cards/${sourceId}`)}>#{sourceId}</button> — RM lines seeded from its trial recipe.</p>
        )}
        {sourceType !== "NPD_DEV_JC" && <div className="mb-4" />}

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        <FormSection n={1} title="Trial details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Trial / Project name</label>
              <input className="form-input" value={trialName} onChange={(e) => setTrialName(e.target.value)} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Product name</label>
              <input className="form-input" value={productName} onChange={(e) => setProductName(e.target.value)} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer (blank = Internal)</label>
              <input className="form-input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose of issue</label>
              <select className="form-input" value={purposeTag} onChange={(e) => setPurposeTag(e.target.value)}>
                {PURPOSE_OPTIONS.map((p) => <option key={p} value={p}>{p.replace(/_/g, " ")}</option>)}
              </select>
            </div>
          </div>
        </FormSection>

        <FormSection n={2} title="Raw materials">
          <div className="space-y-4">
            <ArticlePicker onAdd={addLine} />
            {lines.length === 0 ? (
              <p className="text-[13px] text-[var(--text-muted)]">No RM lines yet. Use the dropdowns above; mark each as OWN or CUSTOMER-supplied.</p>
            ) : (
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={l.sku_id ?? `n-${i}`} className="border border-[var(--aws-border)] rounded-md p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[13px] font-medium text-[var(--text-primary)]">{l.sku_name}</span>
                      <button onClick={() => removeLine(i)} className="text-[12px] text-[var(--aws-error)] hover:underline">Remove</button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <label className="text-[11px] text-[var(--text-secondary)]">Reqd qty
                        <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={l.reqd_qty}
                          onChange={(e) => patchLine(i, { reqd_qty: e.target.value })} />
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">UOM
                        <input className="form-input mt-0.5" value={l.uom} onChange={(e) => patchLine(i, { uom: e.target.value })} />
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">Ownership
                        <select className="form-input mt-0.5" value={l.ownership} onChange={(e) => patchLine(i, { ownership: e.target.value as "OWN" | "CUSTOMER" })}>
                          <option value="OWN">Own stock</option>
                          <option value="CUSTOMER">Customer-supplied</option>
                        </select>
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">Location
                        <input className="form-input mt-0.5" value={l.location ?? ""} onChange={(e) => patchLine(i, { location: e.target.value })} />
                      </label>
                    </div>
                    {l.ownership === "CUSTOMER" && (
                      <p className="mt-1 text-[11px] text-[var(--text-muted)]">Customer-supplied — recorded for traceability, no stock issue.</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </FormSection>

        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => router.push("/modules/sample/rm-issue-forms")}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={saving || !canRaise} onClick={() => raise(false)}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)] disabled:opacity-50">Save draft</button>
          <button disabled={saving || !canRaise} onClick={() => raise(true)}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{saving ? "Raising…" : "Raise indent"}</button>
        </div>
      </main>
    </div>
  );
}

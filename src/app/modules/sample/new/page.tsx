"use client";

// New sample requisition — RM / FG / Internal sample types on ONE form (no
// wizard steps). NPD has its own dedicated section (modules/sample/npd), so it
// is intentionally NOT offered here. The stages are kept as numbered sections:
// 1 Type & purpose · 2 Articles · 3 Details · 4 Review. Articles come ONLY from
// the SKU lookup (free-text is rejected by the API, 422). Saves a DRAFT,
// optionally submits for BH approval.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import {
  createRequisition, submitRequisition, WAREHOUSES,
  type SampleType, type ArticleRole, type PurposeTag, type Warehouse,
} from "@/lib/sample";
import { TYPE_LABEL } from "../_shared";
import { FormSection, ReviewRow, ArticlePicker } from "../_form";

interface DraftArticle {
  sku_id: number;
  sku_name: string;
  required_qty: string;
  uom: string;
  article_role: ArticleRole;
  pack_size_kg?: string;
  notes?: string;
}

// NPD and TRIAL have their own sections (Convert / Trials), so the generic form
// only offers the straight RM / FG / Internal sample types.
const TYPE_OPTIONS = (Object.keys(TYPE_LABEL) as SampleType[]).filter((t) => t !== "NPD" && t !== "TRIAL");

const PURPOSE_OPTIONS: { value: PurposeTag; label: string }[] = [
  { value: "CUSTOMER_DISPLAY", label: "Customer display" },
  { value: "CUSTOMER_ISSUE", label: "Customer issue" },
  { value: "TASTING_SENSORY", label: "Tasting / sensory" },
  { value: "PHYSICAL_PARAMETERS", label: "Physical parameters" },
  { value: "INTERNAL_OTHER", label: "Internal / other" },
];

// NPD_INPUT / NPD_OUTPUT roles belong to the NPD section; the generic form
// only deals with raw-material and finished-good lines.
const ROLE_OPTIONS: ArticleRole[] = ["RM", "FG"];

function defaultRole(t: SampleType): ArticleRole {
  if (t === "BASIS_RM") return "RM";
  if (t === "BASIS_FG") return "FG";
  return "RM";
}

export default function SampleFormPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();

  const [sampleType, setSampleType] = useState<SampleType | "">("");
  const [warehouse, setWarehouse] = useState<Warehouse | "">("");
  const [purposeTag, setPurposeTag] = useState<PurposeTag | "">("");
  const [purposeNote, setPurposeNote] = useState("");
  const [requestorTeam, setRequestorTeam] = useState("");
  const [baseBomId, setBaseBomId] = useState("");
  const [internalOverride, setInternalOverride] = useState(false);
  const [transporterName, setTransporterName] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [articles, setArticles] = useState<DraftArticle[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stash the created DRAFT id so a failed submit retries submit-only (no dup).
  const [savedId, setSavedId] = useState<number | null>(null);

  const needsBom = sampleType === "BASIS_FG";
  const canCreate = !!sampleType && !!warehouse;
  const articlesValid = articles.length > 0 && articles.every((a) => Number(a.required_qty) > 0 && a.uom.trim());
  const canSubmit = canCreate && articlesValid;

  function addArticle(s: { sku_id: number; sku_name: string }) {
    if (articles.some((a) => a.sku_id === s.sku_id)) return;
    setArticles((prev) => [...prev, {
      sku_id: s.sku_id, sku_name: s.sku_name, required_qty: "1", uom: "kg",
      article_role: defaultRole(sampleType || "BASIS_RM"),
    }]);
  }
  function patchArticle(i: number, patch: Partial<DraftArticle>) {
    setArticles((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function removeArticle(i: number) {
    setArticles((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function save(submit: boolean) {
    if (!sampleType) return;
    setSaving(true); setError(null);
    try {
      let reqId = savedId;
      if (reqId == null) {
        const req = await createRequisition({
          sample_type: sampleType,
          warehouse: warehouse as Warehouse,
          requestor_team: requestorTeam || undefined,
          purpose_tag: purposeTag || undefined,
          purpose_note: purposeNote || undefined,
          base_bom_id: baseBomId ? Number(baseBomId) : undefined,
          internal_override: internalOverride,
          transporter_name: transporterName || undefined,
          vehicle_number: vehicleNumber || undefined,
          articles: articles.map((a) => ({
            sku_id: a.sku_id, sku_name: a.sku_name, required_qty: Number(a.required_qty),
            uom: a.uom, article_role: a.article_role,
            pack_size_kg: a.pack_size_kg ? Number(a.pack_size_kg) : null,
            notes: a.notes || null,
          })),
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
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span><span className="text-white">New</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...SAMPLE_ROOT, { label: "New requisition" }]} className="mb-3" />
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-4">New sample requisition</h1>

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {/* 1 · Type & purpose */}
        <FormSection n={1} title="Type & purpose">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Sample type</label>
              <select className="form-input" value={sampleType} onChange={(e) => setSampleType(e.target.value as SampleType)}>
                <option value="">Select…</option>
                {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Warehouse</label>
              <select className="form-input" value={warehouse} onChange={(e) => setWarehouse(e.target.value as Warehouse)}>
                <option value="">Select…</option>
                {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose</label>
              <select className="form-input" value={purposeTag} onChange={(e) => setPurposeTag(e.target.value as PurposeTag)}>
                <option value="">Select…</option>
                {PURPOSE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Requestor team (optional)</label>
              <input className="form-input" value={requestorTeam} onChange={(e) => setRequestorTeam(e.target.value)} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Transporter name (optional)</label>
              <input className="form-input" value={transporterName} onChange={(e) => setTransporterName(e.target.value)} />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Vehicle number (optional)</label>
              <input className="form-input" value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose note (optional)</label>
              <input className="form-input" value={purposeNote} onChange={(e) => setPurposeNote(e.target.value)} />
            </div>
          </div>
        </FormSection>

        {/* 2 · Articles */}
        <FormSection n={2} title="Articles">
          <div className="space-y-4">
            <ArticlePicker onAdd={addArticle} />
            {articles.length === 0 ? (
              <p className="text-[13px] text-[var(--text-muted)]">No articles yet. Use the dropdowns above to add lines.</p>
            ) : (
              <div className="space-y-2">
                {articles.map((a, i) => (
                  <div key={a.sku_id} className="border border-[var(--aws-border)] rounded-md p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[13px] font-medium text-[var(--text-primary)]">{a.sku_name}</span>
                      <button onClick={() => removeArticle(i)} className="text-[12px] text-[var(--aws-error)] hover:underline">Remove</button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <label className="text-[11px] text-[var(--text-secondary)]">Qty
                        <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={a.required_qty}
                          onChange={(e) => patchArticle(i, { required_qty: e.target.value })} />
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">UOM
                        <input className="form-input mt-0.5" value={a.uom} onChange={(e) => patchArticle(i, { uom: e.target.value })} />
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">Role
                        <select className="form-input mt-0.5" value={a.article_role} onChange={(e) => patchArticle(i, { article_role: e.target.value as ArticleRole })}>
                          {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </label>
                      <label className="text-[11px] text-[var(--text-secondary)]">Pack kg
                        <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={a.pack_size_kg ?? ""}
                          onChange={(e) => patchArticle(i, { pack_size_kg: e.target.value })} />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </FormSection>

        {/* 3 · Details */}
        <FormSection n={3} title="Details">
          {!sampleType ? (
            <p className="text-[13px] text-[var(--text-muted)]">Select a sample type to see type-specific details.</p>
          ) : (
            <div className="space-y-3">
              {needsBom && (
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">
                    Base BOM id <span className="text-[var(--aws-error)]">(required to start production)</span>
                  </label>
                  <input className="form-input sm:max-w-xs" type="number" value={baseBomId} onChange={(e) => setBaseBomId(e.target.value)} placeholder="e.g. 42" />
                </div>
              )}
              {sampleType === "INTERNAL" && (
                <label className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                  <input type="checkbox" checked={internalOverride} onChange={(e) => setInternalOverride(e.target.checked)} />
                  Internal override (allow later conversion to external)
                </label>
              )}
              {sampleType === "BASIS_RM" && (
                <p className="text-[13px] text-[var(--text-muted)]">No extra details for Basis RM — it goes straight to outward after approval.</p>
              )}
            </div>
          )}
        </FormSection>

        {/* 4 · Review */}
        <FormSection n={4} title="Review">
          <dl className="space-y-1.5 text-[13px]">
            <ReviewRow label="Type" value={sampleType ? TYPE_LABEL[sampleType] : "—"} />
            <ReviewRow label="Warehouse" value={warehouse || "—"} />
            <ReviewRow label="Purpose" value={purposeTag || "—"} />
            {needsBom && <ReviewRow label="Base BOM" value={baseBomId || "— (set before production)"} />}
            {transporterName && <ReviewRow label="Transporter" value={transporterName} />}
            {vehicleNumber && <ReviewRow label="Vehicle no." value={vehicleNumber} />}
            <ReviewRow label="Articles" value={`${articles.length} line(s)`} />
          </dl>
          {articles.length > 0 && (
            <ul className="mt-2 border-t border-[var(--surface-divider)] pt-2 text-[13px]">
              {articles.map((a) => (
                <li key={a.sku_id} className="flex justify-between py-0.5">
                  <span>{a.sku_name}</span>
                  <span className="text-[var(--text-secondary)]">{a.required_qty} {a.uom} · {a.article_role}</span>
                </li>
              ))}
            </ul>
          )}
        </FormSection>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => router.push("/modules/sample")}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={saving || !canCreate} onClick={() => save(false)}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)] disabled:opacity-50">Save draft</button>
          <button disabled={saving || !canSubmit} onClick={() => save(true)}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{saving ? "Saving…" : "Save & submit"}</button>
        </div>
      </main>
    </div>
  );
}

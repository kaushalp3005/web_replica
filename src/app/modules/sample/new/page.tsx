"use client";

// Sample requisition wizard (checklist B3) — 4 steps covering all sample types.
// Articles are sourced ONLY from the SKU lookup (free-text is rejected by the
// API, 422). Saves a DRAFT, optionally submits for BH approval.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { useRequireAuth, useUserInitial } from "@/lib/user";
import {
  createRequisition, submitRequisition, skuSearch, skuDetail,
  type SampleType, type ArticleRole, type PurposeTag,
} from "@/lib/sample";
import { TYPE_LABEL } from "../_shared";

interface DraftArticle {
  sku_id: number;
  sku_name: string;
  required_qty: string;
  uom: string;
  article_role: ArticleRole;
  pack_size_kg?: string;
  notes?: string;
}

const PURPOSE_OPTIONS: { value: PurposeTag; label: string }[] = [
  { value: "CUSTOMER_DISPLAY", label: "Customer display" },
  { value: "CUSTOMER_ISSUE", label: "Customer issue" },
  { value: "TASTING_SENSORY", label: "Tasting / sensory" },
  { value: "PHYSICAL_PARAMETERS", label: "Physical parameters" },
  { value: "INTERNAL_OTHER", label: "Internal / other" },
];

const ROLE_OPTIONS: ArticleRole[] = ["RM", "FG", "NPD_INPUT", "NPD_OUTPUT"];

function defaultRole(t: SampleType): ArticleRole {
  if (t === "BASIS_RM") return "RM";
  if (t === "BASIS_FG") return "FG";
  if (t === "NPD") return "NPD_OUTPUT";
  return "RM";
}

// ── SKU picker ──────────────────────────────────────────────────────────────
function SkuPicker({ onPick }: { onPick: (s: { sku_id: number; sku_name: string }) => void }) {
  const [text, setText] = useState("");
  const [opts, setOpts] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // All setState lives inside the debounced timeout so none of it runs
    // synchronously in the effect body (react-hooks/set-state-in-effect).
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!text.trim()) { setOpts([]); setOpen(false); return; }
      const list = await skuSearch(text);
      if (!cancelled) { setOpts(list); setOpen(true); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [text]);

  async function pick(name: string) {
    setBusy(true);
    try {
      const detail = await skuDetail(name);
      if (detail) onPick(detail);
    } finally {
      setBusy(false);
      setText(""); setOpts([]); setOpen(false);
    }
  }

  return (
    <div className="relative">
      <input
        className="form-input" placeholder="Search article (SKU master)…" value={text}
        onChange={(e) => setText(e.target.value)} onFocus={() => opts.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        disabled={busy}
      />
      {open && opts.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-60 overflow-auto bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-md">
          {opts.map((o) => (
            <li key={o}>
              {/* onMouseDown + preventDefault: fires before the input's blur and
                  keeps focus, so the selection always registers (an onClick here
                  races the onBlur close timer and can be dropped). */}
              <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                className="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-[var(--surface-subtle)]">{o}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function SampleWizardPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();

  const [step, setStep] = useState(1);
  const [sampleType, setSampleType] = useState<SampleType | "">("");
  const [entity, setEntity] = useState("");
  const [purposeTag, setPurposeTag] = useState<PurposeTag | "">("");
  const [purposeNote, setPurposeNote] = useState("");
  const [requestorTeam, setRequestorTeam] = useState("");
  const [baseBomId, setBaseBomId] = useState("");
  const [internalOverride, setInternalOverride] = useState(false);
  const [articles, setArticles] = useState<DraftArticle[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the DRAFT is created we stash its id so a failed submit can be retried
  // (Save & submit) WITHOUT creating a second duplicate requisition.
  const [savedId, setSavedId] = useState<number | null>(null);

  const needsBom = sampleType === "BASIS_FG" || sampleType === "NPD";

  const stepOk = useMemo(() => {
    if (step === 1) return !!sampleType && (entity === "cfpl" || entity === "cdpl");
    if (step === 2) return articles.length > 0 && articles.every((a) => Number(a.required_qty) > 0 && a.uom.trim());
    return true;
  }, [step, sampleType, entity, articles]);

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
          entity,
          requestor_team: requestorTeam || undefined,
          purpose_tag: purposeTag || undefined,
          purpose_note: purposeNote || undefined,
          base_bom_id: baseBomId ? Number(baseBomId) : undefined,
          internal_override: internalOverride,
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

  if (!authed) return null;

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
        {/* Stepper */}
        <ol className="flex items-center gap-2 mb-6 text-[12px]">
          {["Type & purpose", "Articles", "Details", "Review"].map((label, i) => {
            const n = i + 1;
            const done = n < step, active = n === step;
            return (
              <li key={label} className="flex items-center gap-2">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center font-semibold ${active ? "bg-[var(--aws-orange)] text-white" : done ? "bg-[#a7f3d0] text-[#047857]" : "bg-[var(--surface-divider)] text-[var(--text-muted)]"}`}>{n}</span>
                <span className={`hidden sm:inline ${active ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]"}`}>{label}</span>
                {n < 4 && <span className="w-5 h-px bg-[var(--aws-border)]" />}
              </li>
            );
          })}
        </ol>

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        <div className="bg-white border border-[var(--aws-border)] rounded-md p-5">
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Sample type</label>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(TYPE_LABEL) as SampleType[]).map((t) => (
                    <button key={t} type="button" onClick={() => setSampleType(t)}
                      className={`text-left px-3 py-2 rounded-md border text-[13px] ${sampleType === t ? "border-[var(--aws-orange)] bg-[#fbeced]" : "border-[var(--aws-border)] hover:border-[var(--aws-border-strong)]"}`}>
                      <span className="font-medium">{TYPE_LABEL[t]}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Entity</label>
                  <select className="form-input" value={entity} onChange={(e) => setEntity(e.target.value)}>
                    <option value="">Select…</option><option value="cfpl">CFPL</option><option value="cdpl">CDPL</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose</label>
                  <select className="form-input" value={purposeTag} onChange={(e) => setPurposeTag(e.target.value as PurposeTag)}>
                    <option value="">Select…</option>
                    {PURPOSE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Purpose note (optional)</label>
                <input className="form-input" value={purposeNote} onChange={(e) => setPurposeNote(e.target.value)} />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Requestor team (optional)</label>
                <input className="form-input" value={requestorTeam} onChange={(e) => setRequestorTeam(e.target.value)} />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <SkuPicker onPick={addArticle} />
              {articles.length === 0 ? (
                <p className="text-[13px] text-[var(--text-muted)]">No articles yet. Search the SKU master above to add lines.</p>
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
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">
                  Base BOM id {needsBom && <span className="text-[var(--aws-error)]">(required to start production)</span>}
                </label>
                <input className="form-input" type="number" value={baseBomId} onChange={(e) => setBaseBomId(e.target.value)}
                  placeholder={needsBom ? "e.g. 42" : "Not applicable for RM/Internal"} />
                {sampleType === "NPD" && <p className="mt-1 text-[12px] text-[var(--text-muted)]">For NPD you can clone this BOM into a draft on the detail page after saving.</p>}
              </div>
              {sampleType === "INTERNAL" && (
                <label className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                  <input type="checkbox" checked={internalOverride} onChange={(e) => setInternalOverride(e.target.checked)} />
                  Internal override (allow later conversion to external)
                </label>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3 text-[13px]">
              <Row label="Type" value={sampleType ? TYPE_LABEL[sampleType] : "—"} />
              <Row label="Entity" value={entity.toUpperCase() || "—"} />
              <Row label="Purpose" value={purposeTag || "—"} />
              <Row label="Articles" value={`${articles.length} line(s)`} />
              {needsBom && <Row label="Base BOM" value={baseBomId || "— (set before production)"} />}
              <ul className="mt-2 border-t border-[var(--surface-divider)] pt-2">
                {articles.map((a) => (
                  <li key={a.sku_id} className="flex justify-between py-0.5">
                    <span>{a.sku_name}</span>
                    <span className="text-[var(--text-secondary)]">{a.required_qty} {a.uom} · {a.article_role}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Nav */}
        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => (step === 1 ? router.push("/modules/sample") : setStep(step - 1))}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)]">
            {step === 1 ? "Cancel" : "Back"}
          </button>
          <div className="flex-1" />
          {step < 4 ? (
            <button disabled={!stepOk} onClick={() => setStep(step + 1)}
              className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Next</button>
          ) : (
            <>
              <button disabled={saving} onClick={() => save(false)}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)] disabled:opacity-50">Save draft</button>
              <button disabled={saving} onClick={() => save(true)}
                className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{saving ? "Saving…" : "Save & submit"}</button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="font-medium text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

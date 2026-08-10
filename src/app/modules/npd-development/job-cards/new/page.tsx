"use client";

// New standalone NPD development job card. It develops one or more TARGET ARTICLES
// (082) — each its own product with its own base BOM + trial recipe (see _article-editor).
// When opened from an approved requisition's "Develop" (?req=<id>), the articles are
// prefilled from that requisition's target articles. Saving creates a DRAFT; the
// card-level fg_sku_name/pcs/weight/base_bom_id mirror article #1.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useHasPermission } from "@/lib/user";
import { WAREHOUSES, getRequisition, type Warehouse } from "@/lib/sample";
import { createDevJobCard } from "@/lib/npd-dev";
import {
  FormSection, ReviewRow, UomSelect,
  BillingFields, billingError, billingPayload, billingFrom, EMPTY_BILLING, type BillingValue,
} from "../../../sample/_form";
import {
  ArticleEditor, emptyArticle, articleQty, articlesValid, articlesTotalQty, draftToInput,
  type ArticleDraft, type DraftLine,
} from "../../_article-editor";

// Local YYYY-MM-DD for the date input — NOT toISOString() (that is UTC and can be a day off).
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function NewDevJobCardPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const canCreateJc = useHasPermission("sample", "npd", null, "create");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [warehouse, setWarehouse] = useState<Warehouse | "">("");
  const [uom, setUom] = useState("kg");
  const [articles, setArticles] = useState<ArticleDraft[]>([emptyArticle()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [linkedReq, setLinkedReq] = useState<string | null>(null);   // request label this card was started from
  const [linkedReqId, setLinkedReqId] = useState<number | null>(null);   // request id (back-links the card)
  // Customer & dispatch (optional; mirrors the requisition form). Prefilled from the
  // requisition on Develop, else entered directly for a standalone card.
  const [companyName, setCompanyName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerContact, setCustomerContact] = useState("");
  const [shipTo, setShipTo] = useState("");
  const [modeOfTransport, setModeOfTransport] = useState("");
  const [expectedDispatch, setExpectedDispatch] = useState("");
  const [billing, setBilling] = useState<BillingValue>(EMPTY_BILLING);

  // When opened from an approved request's "Develop" button (?req=<id>), prefill the
  // articles from that requisition's target articles (name / pcs / weight each), plus
  // the card title / warehouse / description. Base BOM + recipe are authored per article.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const reqId = new URLSearchParams(window.location.search).get("req");
      if (!reqId) return;
      setLinkedReqId(Number(reqId));
      getRequisition(Number(reqId)).then((req) => {
        if (cancelled) return;
        if (req.warehouse) setWarehouse(req.warehouse as Warehouse);
        const desc = req.description ?? req.purpose_note;
        if (desc) setDescription(desc);
        // Prefill customer & dispatch from the requisition so what shows == what's saved.
        if (req.company_name) setCompanyName(req.company_name);
        if (req.customer_name) setCustomerName(req.customer_name);
        if (req.customer_contact) setCustomerContact(req.customer_contact);
        if (req.customer_ship_to_address) setShipTo(req.customer_ship_to_address);
        if (req.mode_of_transport) setModeOfTransport(req.mode_of_transport);
        if (req.expected_dispatch_date) setExpectedDispatch(String(req.expected_dispatch_date).slice(0, 10));
        setBilling(billingFrom(req));
        const tgts = req.npd_targets ?? [];
        if (tgts.length > 0) {
          setTitle(tgts[0].name ?? "");
          setArticles(tgts.map((t) => ({
            ...emptyArticle(),
            name: t.name ?? "",
            pcs: t.pcs != null ? String(t.pcs) : "",
            weightPerPiece: t.weight_per_piece != null ? String(t.weight_per_piece) : "",
          })));
        } else if (req.npd_target_name) {   // legacy single-target requisition
          setTitle(req.npd_target_name);
          setArticles([{ ...emptyArticle(), name: req.npd_target_name,
            pcs: req.pcs != null ? String(req.pcs) : "",
            weightPerPiece: req.weight_per_piece != null ? String(req.weight_per_piece) : "" }]);
        }
        setLinkedReq(String(req.request_id ?? req.id));
      }).catch(() => { /* leave the form blank on lookup failure */ });
    });
    return () => { cancelled = true; };
  }, []);

  // Default Expected dispatch date to today (client-only → no SSR hydration mismatch). Only
  // fills an EMPTY field, so a ?req prefill with its own date (set above) still wins.
  useEffect(() => {
    queueMicrotask(() => setExpectedDispatch((cur) => cur || todayISO()));
  }, []);

  // Keyed by the stable uid, not the array index: a base-BOM fetch inside ArticleEditor
  // awaits, and if an earlier article is removed meanwhile the captured index goes stale.
  function patchArticle(uid: string, patch: Partial<ArticleDraft>) {
    setArticles((prev) => prev.map((a) => (a.uid === uid ? { ...a, ...patch } : a)));
  }
  function addArticle() { setArticles((prev) => [...prev, emptyArticle()]); }
  function removeArticle(uid: string) { setArticles((prev) => (prev.length > 1 ? prev.filter((a) => a.uid !== uid) : prev)); }
  function updateArticleLines(uid: string, fn: (lines: DraftLine[]) => DraftLine[]) {
    setArticles((prev) => prev.map((a) => (a.uid === uid ? { ...a, lines: fn(a.lines) } : a)));
  }

  const canCreate = !!title.trim() && articlesValid(articles) && !billingError(billing);
  const totalQty = articlesTotalQty(articles);

  async function save() {
    if (!canCreate) return;
    setSaving(true); setError(null);
    try {
      let id = savedId;
      if (id == null) {
        const jc = await createDevJobCard({
          title: title.trim(),
          description: description || undefined,
          warehouse: warehouse || undefined,
          uom: uom || undefined,
          source_requisition_id: linkedReqId ?? undefined,
          // Send text as trim() (not `|| undefined`): a field the user CLEARED on a Develop
          // card must persist blank, not silently re-inherit the requisition value.
          company_name: companyName.trim(),
          customer_name: customerName.trim(),
          customer_contact: customerContact.trim(),
          customer_ship_to_address: shipTo.trim(),
          mode_of_transport: modeOfTransport.trim(),
          expected_dispatch_date: expectedDispatch || undefined,
          ...billingPayload(billing),
          articles: articles.map(draftToInput),
        });
        id = jc.id;
        setSavedId(id);
      }
      router.push(`/modules/npd-development/job-cards/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create job card");
      setSaving(false);
    }
  }

  // Hydration gate: SSR useRequireAuth returns true (no token store) but the first client
  // render starts authed=false — hold the redirect until after mount so they agree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);
  if (mounted && !authed) return null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/npd-development")} className="hover:underline">NPD Development</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/npd-development/job-cards")} className="hover:underline">Job cards</button>
          <span>/</span><span className="text-white">New</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...NPD_DEV_ROOT, { label: "Job cards", href: "/modules/npd-development/job-cards" }, { label: "New" }]} className="mb-3" />
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-1">New development job card</h1>
        {linkedReq
          ? <p className="mb-4 text-[12px] text-[var(--text-secondary)]">Prefilled from approved request <span className="font-medium text-[var(--text-primary)]">{linkedReq}</span> — for each article, pick a base BOM and build its trial recipe.</p>
          : <div className="mb-4" />}

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {/* 1 · Card details (shared) */}
        <FormSection n={1} title="Card details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Title <span className="text-[var(--aws-error)]">*</span></label>
              <input className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. BigBasket NPD batch — Feb" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Warehouse (optional)</label>
              <select className="form-input" value={warehouse} onChange={(e) => setWarehouse(e.target.value as Warehouse)}>
                <option value="">—</option>
                {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">UOM</label>
              <UomSelect value={uom} onChange={setUom} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Description (optional)</label>
              <textarea className="form-input min-h-[64px] resize-y" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
        </FormSection>

        {/* 2 · Articles — each its own details + base BOM + trial recipe */}
        <FormSection n={2} title="Articles">
          <p className="text-[12px] text-[var(--text-muted)] mb-3">Each article is a product to develop on this card — its own target details, base BOM, and trial recipe.</p>
          <div className="space-y-4">
            {articles.map((a, i) => (
              <ArticleEditor key={a.uid} index={i} article={a} uom={uom}
                onChange={(patch) => patchArticle(a.uid, patch)}
                onLines={(fn) => updateArticleLines(a.uid, fn)}
                onRemove={() => removeArticle(a.uid)} canRemove={articles.length > 1} />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <button type="button" onClick={addArticle}
              className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] hover:bg-[var(--surface-subtle)]">+ Add article</button>
            {articles.length > 1 && (
              <span className="text-[12px] text-[var(--text-secondary)]">Total: <span className="font-medium text-[var(--text-primary)]">{totalQty.toLocaleString("en-IN")} {uom}</span></span>
            )}
          </div>
        </FormSection>

        {/* 3 · Customer & dispatch (optional — mirrors the requisition; prefilled on Develop) */}
        <FormSection n={3} title="Customer & dispatch">
          <p className="text-[12px] text-[var(--text-muted)] mb-3">Optional — who this sample is for and how it ships. Prefilled from the requisition when developed from one; editable here and saved on the card.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Company name</label>
              <input className="form-input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Candor Foods Pvt Ltd" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer name</label>
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
              <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Expected dispatch date</label>
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

        {/* 4 · Review */}
        <FormSection n={4} title="Review">
          <dl className="space-y-1.5 text-[13px]">
            <ReviewRow label="Title" value={title || "—"} />
            <ReviewRow label="Warehouse" value={warehouse || "—"} />
            <ReviewRow label={`Articles (${articles.length})`} value={articles.map((a) => a.name.trim()).filter(Boolean).join(", ") || "—"} />
            <ReviewRow label="Total qty" value={totalQty > 0 ? `${totalQty.toLocaleString("en-IN")} ${uom}` : "—"} />
          </dl>
          <ul className="mt-2 border-t border-[var(--surface-divider)] pt-2 space-y-1 text-[13px]">
            {articles.map((a, i) => (
              <li key={a.uid} className="flex justify-between gap-2">
                <span>{i + 1}. {a.name.trim() || "—"}</span>
                <span className="text-[var(--text-secondary)] text-right">
                  {a.baseBomId != null ? (a.baseBomLabel || `BOM #${a.baseBomId}`) : "no base BOM"} · {a.lines.length} line(s){articleQty(a) > 0 ? ` · ${articleQty(a)} ${uom}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </FormSection>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-5">
          <button onClick={() => router.push("/modules/npd-development/job-cards")}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] text-[13px] bg-white hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={saving || !canCreate || !canCreateJc} onClick={save}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{saving ? "Creating…" : "Create draft"}</button>
        </div>
      </main>
    </div>
  );
}

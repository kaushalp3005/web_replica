"use client";

// NPD development job card detail. Standalone R&D: author the trial recipe while
// DRAFT, start development (locks the recipe), then record the output and close —
// which promotes the recipe into a live BOM. Decoupled from sample requisitions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useHasPermission } from "@/lib/user";
import { sampleCaps, roleNamesOf, isAdminMe } from "@/lib/sample-roles";
import { sumByUom, formatTotals } from "@/lib/outpass";
import type { MeResponse } from "@/lib/auth";
import {
  getDevJobCard, replaceDevLines, startDevJobCard, closeDevJobCard, cancelDevJobCard,
  addDevPhase, replacePhaseLines, startDevPhase, completeDevPhase, deleteDevPhase, promoteApproval,
  promoteRejectByEmail, dispatchDevJobCard, replaceDevArticles, updateDevJobCardDetails,
  type DevJobCard, type DevLine, type DevPhase, type DevPhaseCompleteBody, type PromoteGate,
  type DevArticle, type DevJobCardCloseBody, type DevJobCardDetailsInput, type DevDispatch,
} from "@/lib/npd-dev";
import {
  ArticleEditor, articleToDraft, draftToInput, emptyArticle, articlesValid,
  type ArticleDraft, type DraftLine,
} from "../../_article-editor";
import { DevJcStatusPill } from "../../../sample/_shared";
import {
  ArticlePicker, UomSelect,
  BillingFields, billingError, billingPayload, billingFrom, EMPTY_BILLING, type BillingValue,
} from "../../../sample/_form";

interface EditLine {
  id?: number;
  sku_id: number | null;
  sku_name: string;
  qty: string;
  uom: string;
  item_type: "rm" | "pm";
  is_off_master?: boolean;   // free-typed external/test ingredient (not in master)
  notes?: string | null;
}

const ITEM_TYPES: ("rm" | "pm")[] = ["rm", "pm"];

function num(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n.toLocaleString("en-IN") : String(v);
}

export default function DevJobCardDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);
  const canNpdEdit = useHasPermission("sample", "npd", null, "edit");
  const canNpdDelete = useHasPermission("sample", "npd", null, "delete");
  const canNpdPromote = useHasPermission("sample", "npd", "promote", "create");
  const canGatePass = useHasPermission("sample", "gate_pass", null, "create");

  const [jc, setJc] = useState<DevJobCard | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [extName, setExtName] = useState("");   // free-typed external test ingredient
  const [phaseName, setPhaseName] = useState("");   // new trial phase name
  const [recipePhaseId, setRecipePhaseId] = useState<number | null>(null);   // phase whose recipe is being edited
  const [completingPhaseId, setCompletingPhaseId] = useState<number | null>(null); // phase whose complete form is open
  const [promotePhaseId, setPromotePhaseId] = useState<string>("");   // phase to promote on close
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});   // collapsible phases
  const [phaseToDelete, setPhaseToDelete] = useState<DevPhase | null>(null);   // delete-confirm dialog
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set to true after a successful "Record output & request promote" to show the
  // pending-gate message until the next full reload clears it.
  const [promoteRequested, setPromoteRequested] = useState(false);

  // Per-article articles (082) editing on the detail page.
  const [editingArticles, setEditingArticles] = useState(false);
  const [articleDrafts, setArticleDrafts] = useState<ArticleDraft[]>([]);

  // Promote-gate REJECT reason dialog. `email` is set when opened from the email
  // Reject link (?promote_reject=<gate>&email=<addr>) — the submit then goes through the
  // email-authenticated endpoint; otherwise it's a logged-in portal reject (session).
  const [rejectGate, setRejectGate] = useState<
    { kind: "INV_MGR" | "REQUESTOR_BH"; email?: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Close form (accounting). Yield % is derived, not entered.
  const [outQty, setOutQty] = useState("");
  const [outUom, setOutUom] = useState("");
  const [outRm, setOutRm] = useState("");        // total RM consumed
  const [outWastage, setOutWastage] = useState("");
  const [outEga, setOutEga] = useState("");      // extra give away
  const [outNotes, setOutNotes] = useState("");

  // Partial-out (dispatch) form on the CLOSED card. Qty defaults to the remaining
  // balance when left blank; recipient is the driver/receiver on the outpass.
  const [dispQty, setDispQty] = useState("");
  const [dispRecipient, setDispRecipient] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await getDevJobCard(id);
      setJc(data);
      const ls = data.lines ?? [];
      setLines(ls.map((l) => ({
        id: l.id, sku_id: l.sku_id, sku_name: l.sku_name, qty: String(l.qty ?? ""),
        uom: l.uom, item_type: (l.item_type ?? "rm") as "rm" | "pm",
        is_off_master: l.is_off_master ?? false, notes: l.notes,
      })));
      if (!outUom && data.uom) setOutUom(data.uom);
      // Seed RM consumed once from the recipe total so yield computes immediately.
      if (!outRm && data.status === "IN_DEVELOPMENT") {
        const recipeTotal = ls.reduce((s, l) => s + (Number(l.qty) || 0), 0);
        if (recipeTotal > 0) setOutRm(String(Number(recipeTotal.toFixed(3))));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load job card");
    } finally {
      setLoading(false);
    }
    // outUom intentionally excluded — seeded once, not a reload trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!authed || !Number.isFinite(id)) return;
    queueMicrotask(() => { void load(); });
  }, [authed, id, load]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }, [load]);

  // Arriving from the email Reject button (?promote_reject=<gate>&email=<addr>) → pop the
  // reason dialog bound to that gate + email. Strip the params so a manual refresh doesn't
  // re-open it. Runs once on mount (client-only — no SSR query access needed).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const k = sp.get("promote_reject");
    const em = sp.get("email");
    if ((k === "INV_MGR" || k === "REQUESTOR_BH") && em) {
      window.history.replaceState(null, "", window.location.pathname);
      // Defer the state flips past the effect body (matches the load()/mounted pattern;
      // keeps react-hooks/set-state-in-effect quiet).
      queueMicrotask(() => { setRejectReason(""); setRejectGate({ kind: k, email: em }); });
    }
  }, []);

  // Submit a promote-gate reject with the captured reason. Email-link rejects go through
  // the email-authenticated endpoint (mandatory email check); portal rejects use the
  // session endpoint. Keeps the dialog open on error so the reason isn't lost.
  const submitReject = useCallback(async () => {
    if (!rejectGate || !rejectReason.trim()) return;
    const g = rejectGate, reason = rejectReason.trim();
    setBusy(true); setError(null);
    try {
      if (g.email) await promoteRejectByEmail(id, { approver_kind: g.kind, email: g.email, remarks: reason });
      else await promoteApproval(id, "REJECT", { approver_kind: g.kind, remarks: reason });
      setRejectGate(null); setRejectReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }, [rejectGate, rejectReason, id, load]);

  const isDraft = jc?.status === "DRAFT";
  // Base recipe is editable while DRAFT or IN_DEVELOPMENT (same as phase recipes).
  const editable = (isDraft || jc?.status === "IN_DEVELOPMENT") && caps.canNpd && canNpdEdit;
  // Per-article cards (082) carry the recipe on each article, not the card base recipe.
  // article_id != null distinguishes a real article row from the legacy header synthesis.
  const hasArticles = (jc?.articles ?? []).some((a) => a.article_id != null);

  // Live accounting math for the close form (material balance + auto yield).
  const qOut = Number(outQty) || 0;
  const qRm = Number(outRm) || 0;
  const qWaste = Number(outWastage) || 0;
  const qEga = Number(outEga) || 0;
  const yieldPct = qRm > 0 ? (qOut / qRm) * 100 : null;
  const acctUom = outUom || jc?.uom || "kg";

  // Dispatch (close): pick a COMPLETED final-trial phase. Its recipe is promoted
  // and its recorded output/accounting is inherited — no second entry here.
  const hasPhases = (jc?.phases?.length ?? 0) > 0;
  const completedPhases = (jc?.phases ?? []).filter((p) => p.status === "COMPLETED");
  const selectedPhase = jc?.phases?.find((p) => String(p.phase_id) === promotePhaseId) ?? null;
  // Close/Dispatch opens only once EVERY trial phase is completed.
  const allPhasesClosed = hasPhases && (jc?.phases ?? []).every((p) => p.status === "COMPLETED");

  function addLine(s: { sku_id: number; sku_name: string }) {
    if (lines.some((l) => l.sku_id === s.sku_id)) return;
    setLines((prev) => [...prev, { sku_id: s.sku_id, sku_name: s.sku_name, qty: "1", uom: "kg", item_type: "rm" }]);
  }
  // Free-typed external/test ingredient not in the SKU master (off-master).
  function addExternal() {
    const name = extName.trim();
    if (!name) return;
    setLines((prev) => [...prev, { sku_id: null, sku_name: name, qty: "1", uom: "kg", item_type: "rm", is_off_master: true }]);
    setExtName("");
  }
  function patchLine(i: number, patch: Partial<EditLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }
  function saveLines() {
    const wire: DevLine[] = lines.map((l, idx) => ({
      sku_id: l.sku_id, sku_name: l.sku_name, qty: Number(l.qty) || 0,
      uom: l.uom, item_type: l.item_type, is_off_master: l.is_off_master ?? false,
      line_order: idx, notes: l.notes || null,
    }));
    run(() => replaceDevLines(id, wire));
  }
  // Per-article article editing (082): seed drafts from the loaded articles, then
  // replace the whole set on save (backend deletes + re-inserts + re-mirrors the header).
  function startEditArticles() {
    setArticleDrafts((jc?.articles ?? []).map(articleToDraft));
    setEditingArticles(true);
  }
  // Keyed by the stable uid, not the array index: a base-BOM fetch inside ArticleEditor
  // awaits, and if an earlier article is removed meanwhile the captured index goes stale
  // (writes land on the wrong article or nowhere). uid is stable across splices.
  function patchArticleDraft(uid: string, patch: Partial<ArticleDraft>) {
    setArticleDrafts((prev) => prev.map((a) => (a.uid === uid ? { ...a, ...patch } : a)));
  }
  function addArticleDraft() { setArticleDrafts((prev) => [...prev, emptyArticle()]); }
  function removeArticleDraft(uid: string) { setArticleDrafts((prev) => (prev.length > 1 ? prev.filter((a) => a.uid !== uid) : prev)); }
  function updateArticleDraftLines(uid: string, fn: (lines: DraftLine[]) => DraftLine[]) {
    setArticleDrafts((prev) => prev.map((a) => (a.uid === uid ? { ...a, lines: fn(a.lines) } : a)));
  }
  function saveArticles() {
    run(async () => { await replaceDevArticles(id, articleDrafts.map(draftToInput)); setEditingArticles(false); });
  }
  function closeCard() {
    run(async () => {
      await closeDevJobCard(id, {
        promote_phase_id: promotePhaseId ? Number(promotePhaseId) : undefined,
        output_qty: outQty ? Number(outQty) : undefined,
        output_uom: outUom || undefined,
        rm_consumed_qty: outRm ? Number(outRm) : undefined,
        wastage_qty: outWastage ? Number(outWastage) : undefined,
        extra_give_away_qty: outEga ? Number(outEga) : undefined,
        yield_pct: yieldPct != null ? Number(yieldPct.toFixed(2)) : undefined,
        output_notes: outNotes || undefined,
      });
      setPromoteRequested(true);
    });
  }
  // Per-article promote (082/083): the output entered per article opens the same
  // dual-approval gate; on clear each article fans out to its own BOM + FG batch.
  function submitArticlePromote(body: DevJobCardCloseBody) {
    run(async () => { await closeDevJobCard(id, body); setPromoteRequested(true); });
  }
  // Per-article dispatch (083/084): issue one article's finalized output in parts, in a
  // custom unit + quantity.
  function doDispatchArticle(articleId: number, qty: string, uom: string, recipient: string, reset: () => void) {
    const q = qty ? Number(qty) : undefined;
    run(async () => {
      await dispatchDevJobCard(id, { article_id: articleId, recipient: recipient || undefined, qty: q, uom: uom || undefined });
      reset();
    });
  }
  function cancelCard() {
    const reason = window.prompt("Reason for cancelling this development job card?");
    if (reason == null) return; // user dismissed
    run(() => cancelDevJobCard(id, reason || "cancelled"));
  }
  function openGatePass(dispatchId?: number) {
    // A4 Delivery Challan + Gate Pass print page (reproduces the IMS direct-out DC).
    // A dispatchId prints that single partial out; omitted → the full finalized output.
    const q = dispatchId != null ? `?dispatch=${dispatchId}` : "";
    window.open(`/modules/npd-development/job-cards/${id}/gate-pass${q}`, "_blank", "noopener");
  }
  // One combined outpass for a CHOSEN SET of dispatched parts — each on its own line at
  // its own quantity. Same route as a single part; ?dispatch just takes a list.
  function openSelectedOutpass(dispatchIds: number[]) {
    if (dispatchIds.length === 0) return;
    window.open(`/modules/npd-development/job-cards/${id}/gate-pass?dispatch=${dispatchIds.join(",")}`,
      "_blank", "noopener");
  }
  // One combined outpass listing EVERY article (each its own line) — merge=1.
  function openMergedOutpass() {
    window.open(`/modules/npd-development/job-cards/${id}/gate-pass?merge=1`, "_blank", "noopener");
  }
  // Edit the card's customer & dispatch header (DRAFT/IN_DEVELOPMENT) → PATCH + reload.
  // Returns success so the editor stays open (typed input intact) on a failed save.
  async function saveDetails(body: DevJobCardDetailsInput): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      await updateDevJobCardDetails(id, body);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save details");
      return false;
    } finally {
      setBusy(false);
    }
  }
  // Partial out: issue part (or all) of the finalized FG sample. Blank qty → the
  // whole remaining balance. Reload refreshes dispatches[] + remaining_qty.
  function doDispatch() {
    const q = dispQty ? Number(dispQty) : undefined;
    run(async () => {
      await dispatchDevJobCard(id, { recipient: dispRecipient || undefined, qty: q });
      setDispQty(""); setDispRecipient("");
    });
  }
  // Trial phases (multi-day). Each phase clones the previous phase's recipe, then
  // is edited / started / completed (with output + accounting) independently.
  function addPhase() {
    const name = phaseName.trim();
    if (!name) return;
    run(async () => { await addDevPhase(id, name); setPhaseName(""); });
  }
  function savePhaseRecipe(phaseId: number, wire: DevLine[]) {
    run(async () => { await replacePhaseLines(id, phaseId, wire); setRecipePhaseId(null); });
  }
  function completePhase(phaseId: number, body: DevPhaseCompleteBody) {
    run(async () => { await completeDevPhase(id, phaseId, body); setCompletingPhaseId(null); });
  }
  function togglePhase(phaseId: number, currentlyExpanded: boolean) {
    setExpanded((m) => ({ ...m, [phaseId]: !currentlyExpanded }));
  }
  function confirmDeletePhase() {
    const p = phaseToDelete;
    if (!p) return;
    run(async () => { await deleteDevPhase(id, p.phase_id); setPhaseToDelete(null); });
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
          <span>/</span>
          <button onClick={() => router.push("/modules/npd-development/job-cards")} className="hover:underline">Job cards</button>
          <span>/</span><span className="text-white">{id}</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...NPD_DEV_ROOT, { label: "Job cards", href: "/modules/npd-development/job-cards" }, { label: String(id) }]} className="mb-3" />

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {loading || !jc ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
            {loading ? "Loading…" : "Not found."}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Header */}
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-[20px] font-semibold text-[var(--text-primary)] font-mono tabular-nums">{jc.id}</h1>
                <DevJcStatusPill status={jc.status} />
                {jc.promoted_bom_id != null && (
                  <span className="text-[12px] text-[var(--text-success)]">→ live BOM #{jc.promoted_bom_id}</span>
                )}
              </div>
              <p className="mt-1 text-[15px] font-medium text-[var(--text-primary)]">{jc.title}</p>
              {jc.description && <p className="text-[13px] text-[var(--text-secondary)]">{jc.description}</p>}
              <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4 text-[13px]">
                <Field label="Target product" value={jc.fg_sku_name ?? "—"} />
                <Field label="Warehouse" value={jc.warehouse ?? "—"} />
                <Field label="Pcs" value={jc.pcs != null ? num(jc.pcs) : "—"} />
                <Field label="Weight per piece (kg)" value={jc.weight_per_piece != null ? num(jc.weight_per_piece) : "—"} />
                <Field label="Target qty" value={jc.target_qty != null ? `${num(jc.target_qty)} ${jc.uom ?? ""}`.trim() : "—"} />
                <Field label="Base BOM" value={jc.base_bom_id != null ? `${jc.base_bom_name ? `${jc.base_bom_name} ` : ""}#${jc.base_bom_id}` : "—"} />
                {jc.source_requisition_id != null && (
                  <>
                    <Field label="Business head" value={jc.source_requestor_name ?? "—"} />
                    <Field label="Sales POC" value={jc.source_sales_poc_name ?? jc.source_sales_poc_email ?? "—"} />
                  </>
                )}
                <Field label="Created" value={(jc.created_at ?? "").slice(0, 10)} />
                {jc.started_at && <Field label="Started" value={(jc.started_at ?? "").slice(0, 10)} />}
                {jc.closed_at && <Field label="Closed" value={(jc.closed_at ?? "").slice(0, 10)} />}
              </dl>
              {jc.status === "CANCELLED" && jc.cancellation_reason && (
                <p className="mt-2 text-[12px] text-[var(--aws-error)]">Cancelled — {jc.cancellation_reason}</p>
              )}
            </section>

            {/* Customer & dispatch — editable while DRAFT/IN_DEVELOPMENT (enter/adjust here),
                else read-only. Set on the requisition by BD and inherited on Develop. */}
            <DispatchPlanCard jc={jc} editable={editable} busy={busy} onSave={saveDetails} />

            {/* Action bar */}
            {caps.canNpd && (jc.status === "DRAFT" || jc.status === "IN_DEVELOPMENT") && (
              <div className="flex flex-wrap gap-2">
                {jc.status === "DRAFT" && canNpdEdit && (
                  <button disabled={busy} onClick={() => run(() => startDevJobCard(id))}
                    className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Start development</button>
                )}
                {canNpdDelete && (
                  <button disabled={busy} onClick={cancelCard}
                    className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel job card</button>
                )}
              </div>
            )}

            {/* Trial phases — opens once development has started (IN_DEVELOPMENT) */}
            {!hasArticles && (jc.status === "IN_DEVELOPMENT" || (jc.phases?.length ?? 0) > 0) && (
              <Card title="Trial phases">
                <p className="text-[12px] text-[var(--text-muted)] mb-3">Each phase is a trial iteration — its own recipe (cloned from the previous phase), run over days, with its own output &amp; accounting.</p>
                {(jc.phases?.length ?? 0) === 0 ? (
                  <Empty>No phases yet.</Empty>
                ) : (
                  <ul className="space-y-3">
                    {jc.phases!.map((p) => {
                      const canEditPhase = caps.canNpd && canNpdEdit && (jc.status === "DRAFT" || jc.status === "IN_DEVELOPMENT") && p.status !== "COMPLETED";
                      // Collapsible, but expanded by default so each phase's output +
                      // accounting stays visible (collapse on click to declutter).
                      const isExpanded = expanded[p.phase_id] ?? true;
                      return (
                        <li key={p.phase_id} className="border border-[var(--aws-border)] rounded-md p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <button type="button" onClick={() => togglePhase(p.phase_id, isExpanded)}
                              aria-label={isExpanded ? "Collapse phase" : "Expand phase"} aria-expanded={isExpanded}
                              className="w-5 h-5 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0">
                              <span className={`inline-block text-[9px] transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                            </button>
                            <span className="text-[11px] w-6 h-6 rounded-full bg-[var(--surface-divider)] text-[var(--text-secondary)] flex items-center justify-center shrink-0">{p.phase_number}</span>
                            <button type="button" onClick={() => togglePhase(p.phase_id, isExpanded)}
                              className="text-[13px] font-medium text-[var(--text-primary)] text-left hover:underline">{p.name}</button>
                            <PhasePill status={p.status} />
                            {!isExpanded && p.status === "COMPLETED" && p.output_qty != null && (
                              <span className="text-[12px] text-[var(--text-muted)]">FG {num(p.output_qty)} {p.output_uom || jc.uom || "kg"}{p.yield_pct != null ? ` · ${num(p.yield_pct)}% yield` : ""}</span>
                            )}
                            <div className="flex-1" />
                            {canEditPhase && recipePhaseId !== p.phase_id && (
                              <button disabled={busy} onClick={() => { setRecipePhaseId(p.phase_id); setExpanded((m) => ({ ...m, [p.phase_id]: true })); }}
                                className="h-7 px-2.5 rounded-[2px] text-[12px] font-medium border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Edit recipe</button>
                            )}
                            {jc.status === "IN_DEVELOPMENT" && caps.canNpd && canNpdEdit && p.status === "PENDING" && (
                              <button disabled={busy} onClick={() => run(() => startDevPhase(id, p.phase_id))}
                                className="h-7 px-2.5 rounded-[2px] text-[12px] font-medium bg-[var(--aws-orange)] text-white disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Start</button>
                            )}
                            {jc.status === "IN_DEVELOPMENT" && caps.canNpd && canNpdEdit && p.status === "IN_PROGRESS" && completingPhaseId !== p.phase_id && (
                              <button disabled={busy} onClick={() => { setCompletingPhaseId(p.phase_id); setExpanded((m) => ({ ...m, [p.phase_id]: true })); }}
                                className="h-7 px-2.5 rounded-[2px] text-[12px] font-medium border border-[var(--aws-border-strong)] bg-white disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Complete</button>
                            )}
                            {caps.canNpd && canNpdEdit && (jc.status === "DRAFT" || jc.status === "IN_DEVELOPMENT") && (
                              <button disabled={busy} onClick={() => setPhaseToDelete(p)} aria-label="Delete phase" title="Delete phase"
                                className="w-7 h-7 flex items-center justify-center rounded-[2px] text-[var(--aws-error)] hover:bg-[#fdf3f1] disabled:opacity-50">✕</button>
                            )}
                          </div>
                          {isExpanded && (
                            <>
                              {(p.started_at || p.completed_at) && (
                                <div className="mt-1.5 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-4 gap-y-0.5">
                                  {p.started_at && <span>Started {(p.started_at ?? "").slice(0, 10)}</span>}
                                  {p.completed_at && <span>Completed {(p.completed_at ?? "").slice(0, 10)}</span>}
                                </div>
                              )}

                              {/* Phase recipe — editor while editing, else a read-only list */}
                              {recipePhaseId === p.phase_id ? (
                                <PhaseRecipeEditor phase={p} busy={busy}
                                  onSave={(wire) => savePhaseRecipe(p.phase_id, wire)}
                                  onCancel={() => setRecipePhaseId(null)} />
                              ) : (
                                <PhaseRecipeView lines={p.lines ?? []} />
                              )}

                              {/* Complete form — output + per-phase accounting */}
                              {completingPhaseId === p.phase_id && (
                                <PhaseCompleteForm defaultUom={jc.uom || "kg"} busy={busy}
                                  onComplete={(body) => completePhase(p.phase_id, body)}
                                  onCancel={() => setCompletingPhaseId(null)} />
                              )}

                              {/* Per-phase accounting (recorded at completion) */}
                              {p.status === "COMPLETED" && (p.output_qty != null || p.rm_consumed_qty != null) && (
                                <AcctSummary rm={Number(p.rm_consumed_qty) || 0} out={Number(p.output_qty) || 0}
                                  waste={Number(p.wastage_qty) || 0} ega={Number(p.extra_give_away_qty) || 0}
                                  uom={p.output_uom || jc.uom || "kg"} className="mt-2" />
                              )}
                              {p.notes && <p className="mt-1 text-[12px] text-[var(--text-muted)]">{p.notes}</p>}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {caps.canNpd && canNpdEdit && jc.status === "IN_DEVELOPMENT" && (
                  <div className="mt-3 flex items-end gap-2">
                    <input className="form-input flex-1" value={phaseName}
                      placeholder="Phase name — e.g. Trial batch 1, Sensory evaluation…"
                      onChange={(e) => setPhaseName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhase(); } }} />
                    <button type="button" disabled={busy || !phaseName.trim()} onClick={addPhase}
                      className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Add phase</button>
                  </div>
                )}
                {jc.status === "IN_DEVELOPMENT" && (
                  <p className="mt-2 text-[11px] text-[var(--text-muted)]">A new phase clones the previous phase&apos;s recipe. Close opens only once every phase is completed.</p>
                )}
              </Card>
            )}

            {/* Articles (082) — per-article recipe. Read-only here in Phase A. */}
            {hasArticles && (
              <Card title="Articles">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <p className="text-[12px] text-[var(--text-muted)]">Each article is developed with its own base BOM &amp; trial recipe, and on promote each is minted into its own live BOM.</p>
                  {editable && !editingArticles && (
                    <button onClick={startEditArticles}
                      className="shrink-0 h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] hover:bg-[var(--surface-subtle)]">Edit articles</button>
                  )}
                </div>
                {editingArticles ? (
                  <>
                    <div className="space-y-4">
                      {articleDrafts.map((a, i) => (
                        <ArticleEditor key={a.uid} index={i} article={a} uom={jc.uom || "kg"}
                          onChange={(patch) => patchArticleDraft(a.uid, patch)}
                          onLines={(fn) => updateArticleDraftLines(a.uid, fn)}
                          onRemove={() => removeArticleDraft(a.uid)} canRemove={articleDrafts.length > 1} />
                      ))}
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <button type="button" onClick={addArticleDraft}
                        className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] hover:bg-[var(--surface-subtle)]">+ Add article</button>
                      <div className="flex-1" />
                      <button disabled={busy} onClick={() => setEditingArticles(false)}
                        className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel</button>
                      <button disabled={busy || !articlesValid(articleDrafts)} onClick={saveArticles}
                        className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Save articles</button>
                    </div>
                  </>
                ) : (
                  <ul className="space-y-3">
                    {jc.articles!.map((a, i) => (
                      <li key={a.article_id ?? i} className="border border-[var(--aws-border)] rounded-md p-3">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <span className="text-[11px] w-6 h-6 rounded-full bg-[var(--surface-divider)] text-[var(--text-secondary)] flex items-center justify-center shrink-0">{i + 1}</span>
                          <span className="text-[13px] font-medium text-[var(--text-primary)]">{a.name}</span>
                          {a.quantity != null && <span className="text-[12px] text-[var(--text-muted)]">{num(a.quantity)} {a.uom || jc.uom || "kg"}</span>}
                          {a.base_bom_id != null && <span className="text-[12px] text-[var(--text-muted)]">Base BOM {a.base_bom_name ? `${a.base_bom_name} ` : ""}#{a.base_bom_id}</span>}
                          {a.promoted_bom_id != null && <span className="text-[12px] text-[var(--text-success)]">→ live BOM #{a.promoted_bom_id}</span>}
                          {/* Output summary once promoted — visible to all viewers (BH/IM see
                              it here since the per-article dispatch panels are npd/outpass-only). */}
                          {a.output_qty != null && <span className="text-[12px] text-[var(--text-secondary)]">FG {num(a.output_qty)} {a.output_uom || jc.uom || "kg"}{a.yield_pct != null ? ` · ${num(a.yield_pct)}% yield` : ""}</span>}
                        </div>
                        {(a.lines?.length ?? 0) === 0
                          ? <Empty>No recipe lines.</Empty>
                          : <RecipeLines lines={a.lines!} />}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {/* Base recipe — the starting point each first phase clones (single-product cards only) */}
            {!hasArticles && (
            <Card title="Base recipe">
              <p className="text-[12px] text-[var(--text-muted)] mb-3">The starting recipe — the first trial phase clones it. Each phase&apos;s own recipe is edited under Trial phases above.</p>
              {editable && (
                <div className="mb-3 space-y-3">
                  <ArticlePicker onAdd={addLine} restrictItemType="rm" />
                  <div className="border border-dashed border-[var(--aws-border-strong)] rounded-md p-3 bg-[var(--surface-subtle)]">
                    <label className="block text-[11px] font-medium text-[var(--text-secondary)] mb-1">External test ingredient (not in the master)</label>
                    <div className="flex items-end gap-2">
                      <input className="form-input flex-1" value={extName} placeholder="Type a new ingredient name…"
                        onChange={(e) => setExtName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExternal(); } }} />
                      <button type="button" onClick={addExternal} disabled={!extName.trim()}
                        className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50">Add</button>
                    </div>
                    <p className="mt-1 text-[10px] text-[var(--text-muted)]">External ingredient used (not in above master).</p>
                  </div>
                </div>
              )}
              {lines.length === 0 ? (
                <Empty>No recipe lines.</Empty>
              ) : (
                <RecipeLines lines={lines} editable={editable} onPatch={patchLine} onRemove={removeLine} />
              )}
              {editable && (
                <div className="mt-3">
                  <button disabled={busy} onClick={saveLines}
                    className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Save recipe</button>
                </div>
              )}
            </Card>
            )}

            {/* Request promote (IN_DEVELOPMENT) — only once EVERY trial phase is completed.
                Pick the final trial; its recipe is promoted and its recorded output
                is inherited (no second accounting entry). */}
            {!hasArticles && caps.canNpd && canNpdPromote && jc.status === "IN_DEVELOPMENT" && allPhasesClosed && !jc.promote_gate && (
              <Card title="Request promote">
                <p className="text-[12px] text-[var(--text-muted)] mb-3">Pick the final trial. Its recipe will be promoted into a live BOM once the inventory manager and original requestor both accept the promote request.</p>
                {completedPhases.length === 0 ? (
                  <Empty>Complete a trial phase first — its recorded output becomes the final output on close.</Empty>
                ) : (
                  <>
                    <div className="mb-3">
                      <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Final trial phase <span className="text-[var(--aws-error)]">*</span></label>
                      <select className="form-input sm:max-w-[60%]" value={promotePhaseId} onChange={(e) => setPromotePhaseId(e.target.value)}>
                        <option value="">Select the final trial…</option>
                        {completedPhases.map((p) => (
                          <option key={p.phase_id} value={p.phase_id}>#{p.phase_number} {p.name}</option>
                        ))}
                      </select>
                    </div>
                    {selectedPhase && (
                      <AcctSummary rm={Number(selectedPhase.rm_consumed_qty) || 0} out={Number(selectedPhase.output_qty) || 0}
                        waste={Number(selectedPhase.wastage_qty) || 0} ega={Number(selectedPhase.extra_give_away_qty) || 0}
                        uom={selectedPhase.output_uom || jc.uom || "kg"} className="mb-3" />
                    )}
                    <label className="block text-[11px] text-[var(--text-secondary)] mb-3">Notes (optional)
                      <input className="form-input mt-0.5" value={outNotes} onChange={(e) => setOutNotes(e.target.value)} />
                    </label>
                    {promoteRequested ? (
                      <div className="rounded-md border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[13px] text-[#1d8102]">
                        Promote requested — awaiting inventory-manager + requestor acceptance.
                      </div>
                    ) : (
                      <button disabled={busy || !promotePhaseId} onClick={closeCard}
                        className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Record output & request promote</button>
                    )}
                  </>
                )}
              </Card>
            )}

            {/* Per-article card (082): each article records its OWN output → its own FG
                batch → its own dispatchable balance. One request-promote for the whole card
                fans out to N BOMs once both gates accept. */}
            {hasArticles && caps.canNpd && canNpdPromote && jc.status === "IN_DEVELOPMENT" && !jc.promote_gate && (
              // key on the article-id set so editing articles (which re-mints ids) re-seeds
              // the output rows — else entered outputs would map to stale ids and be dropped.
              <PerArticlePromoteCard key={(jc.articles ?? []).map((a) => a.article_id).join(",")}
                jc={jc} busy={busy} requested={promoteRequested} onSubmit={submitArticlePromote} />
            )}

            {/* Record output & request promote — legacy no-phase single-product card. */}
            {!hasArticles && caps.canNpd && canNpdPromote && jc.status === "IN_DEVELOPMENT" && !hasPhases && !jc.promote_gate && (
              <Card title="Record output & request promote">
                <p className="text-[12px] text-[var(--text-muted)] mb-3">Requesting promote locks the output and opens a dual-approval gate — both inventory manager and the original requestor must accept before the recipe is promoted to a live BOM.</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <label className="text-[11px] text-[var(--text-secondary)]">FG output ({acctUom})
                    <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={outQty} onChange={(e) => setOutQty(e.target.value)} />
                  </label>
                  <label className="text-[11px] text-[var(--text-secondary)]">Output UOM
                    <UomSelect className="mt-0.5" value={outUom} onChange={setOutUom} />
                  </label>
                  <label className="text-[11px] text-[var(--text-secondary)]">RM consumed ({acctUom})
                    <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={outRm} onChange={(e) => setOutRm(e.target.value)} />
                  </label>
                  <label className="text-[11px] text-[var(--text-secondary)]">Yield % (auto)
                    <input className="form-input mt-0.5 bg-[var(--surface-subtle)] cursor-not-allowed" value={yieldPct != null ? yieldPct.toFixed(2) : "—"} readOnly tabIndex={-1} />
                  </label>
                  <label className="text-[11px] text-[var(--text-secondary)]">Wastage ({acctUom})
                    <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={outWastage} onChange={(e) => setOutWastage(e.target.value)} />
                  </label>
                  <label className="text-[11px] text-[var(--text-secondary)]">Extra give away ({acctUom})
                    <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={outEga} onChange={(e) => setOutEga(e.target.value)} />
                  </label>
                  <label className="text-[11px] text-[var(--text-secondary)] sm:col-span-2 col-span-2">Notes
                    <input className="form-input mt-0.5" value={outNotes} onChange={(e) => setOutNotes(e.target.value)} />
                  </label>
                </div>

                <AcctSummary rm={qRm} out={qOut} waste={qWaste} ega={qEga} uom={acctUom} className="mt-3" />

                {promoteRequested && (
                  <div className="mt-3 rounded-md border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[13px] text-[#1d8102]">
                    Promote requested — awaiting inventory-manager + requestor acceptance.
                  </div>
                )}

                {!promoteRequested && (
                  <div className="mt-3">
                    <button disabled={busy} onClick={closeCard}
                      className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Record output & request promote</button>
                  </div>
                )}
              </Card>
            )}

            {/* Promote-approval gate — present whenever a PENDING promote request
                exists (i.e. the operator hit "request promote" but both gates
                haven't cleared yet). Shown to all viewers; ACCEPT/REJECT buttons
                are gated per-role: INV_MGR gate → inventory_manager role;
                REQUESTOR_BH gate → the specific approver_user_id. */}
            {jc.promote_gate && (
              <PromoteGatePanel
                gate={jc.promote_gate}
                devJcId={id}
                me={me}
                busy={busy}
                onAction={(action, approverKind) => {
                  if (action === "REJECT") {
                    // Capture a reason first (a reject must record why).
                    setRejectReason("");
                    setRejectGate({ kind: approverKind });
                  } else {
                    run(() => promoteApproval(id, "ACCEPT", { approver_kind: approverKind }));
                  }
                }}
              />
            )}

            {/* Output (CLOSED) — card-level (single-product). A per-article card shows its
                output + dispatch per article below instead (the card total would hide which
                article produced/dispatched what). */}
            {jc.status === "CLOSED" && !hasArticles && (
              <Card title="Output">
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4 text-[13px]">
                  <Field label="Output qty" value={jc.output_qty != null ? `${num(jc.output_qty)} ${jc.output_uom ?? ""}`.trim() : "—"} />
                  <Field label="Yield" value={jc.yield_pct != null ? `${num(jc.yield_pct)}%` : "—"} />
                  <Field label="Promoted BOM" value={jc.promoted_bom_id != null ? `#${jc.promoted_bom_id}` : "—"} />
                  <Field label="FG sample batch" value={jc.fg_sample_batch_id ?? "—"} />
                  <Field label="Closed" value={(jc.closed_at ?? "").slice(0, 10)} />
                </dl>
                {jc.rm_consumed_qty != null && (
                  <AcctSummary
                    rm={Number(jc.rm_consumed_qty) || 0} out={Number(jc.output_qty) || 0}
                    waste={Number(jc.wastage_qty) || 0} ega={Number(jc.extra_give_away_qty) || 0}
                    uom={jc.output_uom || jc.uom || "kg"} className="mt-3" />
                )}
                {jc.output_notes && <p className="mt-2 text-[13px] text-[var(--text-secondary)]">{jc.output_notes}</p>}
                {/* Historical dispatch info (if the sample was ever issued out). */}
                {jc.dispatched_at && (
                  <p className="mt-3 text-[12px] text-[var(--text-secondary)]">
                    Dispatched {(jc.dispatched_at ?? "").slice(0, 10)} to <strong>{jc.dispatch_recipient || "—"}</strong>
                    {jc.dispatch_mat_doc_id ? ` · GI ${jc.dispatch_mat_doc_id}` : ""}
                  </p>
                )}
                {/* Permanent outpass — A4 Delivery Challan + Gate Pass for the FG sample.
                    npd_team + admin only; BH/IM may view the card but not download.
                    Hidden once any partial out exists — the per-part outpasses below
                    then authorize movement, so a full-qty doc can't double-count. */}
                {caps.canOutpass && canGatePass && (jc.dispatches?.length ?? 0) === 0 && (
                <div className="mt-3">
                  <button onClick={() => openGatePass()}
                    className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] inline-flex items-center gap-1.5">
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
                    Download full outpass
                  </button>
                </div>
                )}
              </Card>
            )}

            {/* Partial out — issue the finalized FG sample in parts, each part its
                own 265 goods issue + its own outpass. npd_team + admin only. */}
            {jc.status === "CLOSED" && caps.canOutpass && canGatePass && !hasArticles && (
              <DispatchPanel jc={jc} busy={busy}
                qty={dispQty} setQty={setDispQty}
                recipient={dispRecipient} setRecipient={setDispRecipient}
                onDispatch={doDispatch} onOutpass={openGatePass} onOutpassMany={openSelectedOutpass} />
            )}

            {/* Per-article output & dispatch (083) — each article dispatches its OWN
                finalized output from its own FG batch, each part its own outpass. */}
            {jc.status === "CLOSED" && caps.canOutpass && canGatePass && hasArticles && (
              <>
                {/* One combined outpass for the whole card — every article on its own line. */}
                {(jc.articles ?? []).some((a) => a.article_id != null && Number(a.output_qty) > 0) && (
                  <div className="flex justify-end">
                    <button onClick={openMergedOutpass}
                      className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)] inline-flex items-center gap-1.5">
                      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
                      Combined outpass — all articles
                    </button>
                  </div>
                )}
                {(jc.articles ?? []).filter((a) => a.article_id != null).map((a) => (
                  <PerArticleDispatchPanel key={a.article_id} jc={jc} article={a} busy={busy}
                    onDispatch={doDispatchArticle} onOutpass={openGatePass}
                    onOutpassMany={openSelectedOutpass} />
                ))}
              </>
            )}
          </div>
        )}
      </main>

      {/* Promote-gate reject — reason dialog (email-link or portal). Reject needs a
          reason; email-link rejects authenticate via the carried email on submit. */}
      {rejectGate && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3"
          onClick={() => { if (!busy) setRejectGate(null); }}>
          <div className="bg-white rounded-md w-full max-w-md p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)] mb-1">
              Reject promote — {rejectGate.kind === "INV_MGR" ? "Inventory manager" : "Requestor (business head)"}
            </h3>
            <p className="text-[13px] text-[var(--text-secondary)] mb-3">
              The recipe will not be promoted. A reason is required.
            </p>
            <textarea autoFocus value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejecting…"
              className="form-input w-full min-h-[80px] resize-y" />
            <div className="flex gap-2 mt-4">
              <button onClick={() => { if (!busy) { setRejectGate(null); setRejectReason(""); } }}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Cancel</button>
              <div className="flex-1" />
              <button disabled={busy || !rejectReason.trim()} onClick={submitReject}
                className="h-9 px-5 rounded-[2px] bg-[var(--aws-error)] text-white text-[13px] font-medium disabled:opacity-50 hover:opacity-90">
                {busy ? "Rejecting…" : "Submit reject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete-phase confirmation dialog */}
      {phaseToDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3"
          onClick={() => setPhaseToDelete(null)}>
          <div className="bg-white rounded-md w-full max-w-sm p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)] mb-1">Delete phase?</h3>
            <p className="text-[13px] text-[var(--text-secondary)] mb-4">
              Phase #{phaseToDelete.phase_number} “{phaseToDelete.name}” and its recipe
              {phaseToDelete.status === "COMPLETED" ? " and recorded output" : ""} will be permanently removed. This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPhaseToDelete(null)}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Cancel</button>
              <div className="flex-1" />
              <button disabled={busy} onClick={confirmDeletePhase}
                className="h-9 px-5 rounded-[2px] bg-[var(--aws-error)] text-white text-[13px] font-medium disabled:opacity-50 hover:opacity-90">Delete phase</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
      <h2 className="text-[13px] font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-3">{title}</h2>
      {children}
    </section>
  );
}
function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[11px] text-[var(--text-muted)]">{label}</dt><dd className="text-[var(--text-primary)]">{value}</dd></div>;
}

// Customer + dispatch planning card — READ-ONLY on the job card. These are set on
// the requisition by the BD team and inherited here; the confirmed dispatch date
// is the job card's own closing date (set automatically on close).
function DispatchPlanCard({ jc, editable, busy, onSave }: {
  jc: DevJobCard; editable?: boolean; busy?: boolean;
  onSave?: (body: DevJobCardDetailsInput) => Promise<boolean>;
}) {
  const d = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "—");
  const [editing, setEditing] = useState(false);
  const [company, setCompany] = useState("");
  const [customer, setCustomer] = useState("");
  const [contact, setContact] = useState("");
  const [ship, setShip] = useState("");
  const [transport, setTransport] = useState("");
  const [expDispatch, setExpDispatch] = useState("");
  const [billing, setBilling] = useState<BillingValue>(EMPTY_BILLING);
  function startEdit() {
    setCompany(jc.company_name ?? "");
    setCustomer(jc.customer_name ?? "");
    setContact(jc.customer_contact ?? "");
    setShip(jc.customer_ship_to_address ?? "");
    setTransport(jc.mode_of_transport ?? "");
    setExpDispatch(jc.expected_dispatch_date ? String(jc.expected_dispatch_date).slice(0, 10) : "");
    setBilling(billingFrom({
      returnable: jc.returnable, non_returnable: jc.non_returnable, paid: jc.paid,
      amount: jc.amount != null ? Number(jc.amount) : null,
    }));
    setEditing(true);
  }
  const err = billingError(billing);
  async function save() {
    if (err) return;
    // Send cleared fields as null (→ column NULL → renders "—"); a cleared date must be null,
    // not "" (backend Optional[date] rejects ""). Await the save and close ONLY on success so a
    // failed PATCH keeps the editor open with the typed input intact.
    const ok = await onSave?.({
      company_name: company.trim() || null,
      customer_name: customer.trim() || null,
      customer_contact: contact.trim() || null,
      customer_ship_to_address: ship.trim() || null,
      mode_of_transport: transport.trim() || null,
      expected_dispatch_date: expDispatch || null,
      ...billingPayload(billing),
    });
    if (ok) setEditing(false);
  }
  if (editing) {
    return (
      <Card title="Customer & dispatch">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Company name</label>
            <input className="form-input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Candor Foods Pvt Ltd" />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer name</label>
            <input className="form-input" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="e.g. BigBasket" />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer contact</label>
            <input className="form-input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="name / phone / email" />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Mode of transport</label>
            <input className="form-input" value={transport} onChange={(e) => setTransport(e.target.value)} placeholder="e.g. Road / Air / Courier" />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Expected dispatch date</label>
            <input className="form-input" type="date" value={expDispatch} onChange={(e) => setExpDispatch(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1.5">Customer ship-to address</label>
            <textarea className="form-input min-h-[56px] resize-y" value={ship} onChange={(e) => setShip(e.target.value)} placeholder="Delivery address…" />
          </div>
          <div className="sm:col-span-2">
            <BillingFields value={billing} onChange={setBilling} />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1" />
          <button disabled={busy} onClick={() => setEditing(false)}
            className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel</button>
          <button disabled={busy || !!err} onClick={save}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Save details</button>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Customer & dispatch">
      <div className="flex items-start justify-between gap-2">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 gap-x-4 text-[13px] flex-1">
          <Field label="Company" value={jc.company_name || "—"} />
          <Field label="Customer" value={jc.customer_name || "—"} />
          <Field label="Customer contact" value={jc.customer_contact || "—"} />
          <Field label="Mode of transport" value={jc.mode_of_transport || "—"} />
          <Field label="Expected dispatch (BD)" value={d(jc.expected_dispatch_date)} />
          <Field label="Confirmed dispatch (NPD)" value={jc.confirmed_dispatch_date ? d(jc.confirmed_dispatch_date) : "On close"} />
          <Field label="Return type" value={jc.returnable ? "Returnable" : jc.non_returnable ? "Non-returnable" : "—"} />
          <Field label="Paid" value={jc.paid ? "Yes" : "No"} />
          <Field label="Amount" value={jc.paid && jc.amount != null ? Number(jc.amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"} />
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-[11px] text-[var(--text-muted)]">Ship-to address</dt>
            <dd className="text-[var(--text-primary)]">{jc.customer_ship_to_address || "—"}</dd>
          </div>
        </dl>
        {editable && (
          <button onClick={startEdit}
            className="shrink-0 h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] hover:bg-[var(--surface-subtle)]">Edit</button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-[var(--text-muted)]">Prefilled from the requisition (set by BD) when developed from one; editable here while the card is a draft. Confirmed dispatch date = the job card&apos;s closing date.</p>
    </Card>
  );
}

// Trial-phase status pill (PENDING -> IN_PROGRESS -> COMPLETED).
const PHASE_STYLES: Record<string, { bg: string; fg: string; ring: string; label: string }> = {
  PENDING:     { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb", label: "Pending" },
  IN_PROGRESS: { bg: "#fef3c7", fg: "#92400e", ring: "#fde68a", label: "In progress" },
  COMPLETED:   { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1", label: "Completed" },
};
function PhasePill({ status }: { status: string }) {
  const s = PHASE_STYLES[status] ?? PHASE_STYLES.PENDING;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}>{s.label}</span>
  );
}

// Recipe-line provenance: external (free-typed test ingredient), base (cloned
// name-only from a BOM/previous phase), or added (picked from the SKU master).
function ProvenanceTag({ isOffMaster, skuId }: { isOffMaster?: boolean; skuId: number | null }) {
  const cls = isOffMaster
    ? "bg-[#fff7ed] text-[#c2410c]"
    : skuId == null
      ? "bg-[var(--surface-subtle)] text-[var(--text-secondary)]"
      : "bg-[#eef2ff] text-[#4338ca]";
  const label = isOffMaster ? "external" : skuId == null ? "base" : "added";
  return <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

// Recipe lines, responsive: a table on sm+ screens, stacked cards on mobile so the
// Material/Qty/UOM/Type columns don't cram on a phone. Editable (qty/uom/type inputs
// + remove) when onPatch/onRemove are given; read-only otherwise.
interface RecipeRow {
  id?: number;
  sku_id: number | null;
  sku_name: string;
  qty: number | string;
  uom: string;
  item_type?: "rm" | "pm" | null;
  is_off_master?: boolean;
}
function RecipeLines({ lines, editable, onPatch, onRemove }: {
  lines: RecipeRow[];
  editable?: boolean;
  onPatch?: (i: number, patch: { qty?: string; uom?: string; item_type?: "rm" | "pm" }) => void;
  onRemove?: (i: number) => void;
}) {
  return (
    <>
      {/* Desktop / tablet: table */}
      <table className="hidden sm:table w-full text-[13px]">
        <thead><tr className="text-left text-[12px] text-[var(--text-secondary)]">
          <th className="py-1.5 font-semibold">Material</th>
          <th className="py-1.5 font-semibold text-right">Qty</th>
          <th className="py-1.5 font-semibold">UOM</th>
          <th className="py-1.5 font-semibold">Type</th>
          {editable && <th />}
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id ?? `d-${i}`} className="border-t border-[var(--surface-divider)]">
              <td className="py-1.5"><span className="flex items-center gap-2">{l.sku_name}<ProvenanceTag isOffMaster={l.is_off_master} skuId={l.sku_id} /></span></td>
              <td className="py-1.5 text-right">{editable
                ? <input className="form-input !h-7 !w-24 text-right" type="number" step="0.001" value={l.qty} onChange={(e) => onPatch?.(i, { qty: e.target.value })} />
                : num(l.qty)}</td>
              <td className="py-1.5">{editable
                ? <input className="form-input !h-7 !w-20" value={l.uom} onChange={(e) => onPatch?.(i, { uom: e.target.value })} />
                : l.uom}</td>
              <td className="py-1.5">{editable
                ? <select className="form-input !h-7 !w-20" value={l.item_type ?? "rm"} onChange={(e) => onPatch?.(i, { item_type: e.target.value as "rm" | "pm" })}>{ITEM_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}</select>
                : (l.item_type ?? "—").toUpperCase()}</td>
              {editable && <td className="py-1.5 text-right"><button onClick={() => onRemove?.(i)} className="text-[12px] text-[var(--aws-error)] hover:underline" aria-label="Remove">×</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Mobile: stacked cards (no cramped columns) */}
      <ul className="sm:hidden space-y-2">
        {lines.map((l, i) => (
          <li key={l.id ?? `m-${i}`} className="border border-[var(--aws-border)] rounded-md p-2.5">
            <div className="flex items-start justify-between gap-2">
              <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-[var(--text-primary)]">{l.sku_name}<ProvenanceTag isOffMaster={l.is_off_master} skuId={l.sku_id} /></span>
              {editable && <button onClick={() => onRemove?.(i)} className="text-[16px] leading-none text-[var(--aws-error)] shrink-0 px-1" aria-label="Remove">×</button>}
            </div>
            {editable ? (
              <div className="grid grid-cols-3 gap-2 mt-2">
                <label className="text-[11px] text-[var(--text-secondary)]">Qty
                  <input className="form-input !h-8 mt-0.5 text-right" type="number" step="0.001" value={l.qty} onChange={(e) => onPatch?.(i, { qty: e.target.value })} />
                </label>
                <label className="text-[11px] text-[var(--text-secondary)]">UOM
                  <input className="form-input !h-8 mt-0.5" value={l.uom} onChange={(e) => onPatch?.(i, { uom: e.target.value })} />
                </label>
                <label className="text-[11px] text-[var(--text-secondary)]">Type
                  <select className="form-input !h-8 mt-0.5" value={l.item_type ?? "rm"} onChange={(e) => onPatch?.(i, { item_type: e.target.value as "rm" | "pm" })}>{ITEM_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}</select>
                </label>
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-[var(--text-secondary)]">
                <span>Qty <span className="text-[var(--text-primary)]">{num(l.qty)} {l.uom}</span></span>
                <span>Type <span className="text-[var(--text-primary)]">{(l.item_type ?? "—").toUpperCase()}</span></span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// Read-only view of a phase's recipe.
function PhaseRecipeView({ lines }: { lines: DevLine[] }) {
  if (lines.length === 0) return <p className="mt-2 text-[12px] text-[var(--text-muted)]">No recipe lines yet.</p>;
  return <div className="mt-2"><RecipeLines lines={lines} /></div>;
}

// Editable recipe for one phase — seeded from the phase's current lines.
function PhaseRecipeEditor({ phase, busy, onSave, onCancel }: {
  phase: DevPhase; busy: boolean;
  onSave: (lines: DevLine[]) => void; onCancel: () => void;
}) {
  const [lines, setLines] = useState<EditLine[]>(() =>
    (phase.lines ?? []).map((l) => ({
      id: l.id, sku_id: l.sku_id, sku_name: l.sku_name, qty: String(l.qty ?? ""),
      uom: l.uom, item_type: (l.item_type ?? "rm") as "rm" | "pm",
      is_off_master: l.is_off_master ?? false, notes: l.notes,
    })));
  const [extName, setExtName] = useState("");
  function addLine(s: { sku_id: number; sku_name: string }) {
    if (lines.some((l) => l.sku_id === s.sku_id)) return;
    setLines((p) => [...p, { sku_id: s.sku_id, sku_name: s.sku_name, qty: "1", uom: "kg", item_type: "rm" }]);
  }
  function addExternal() {
    const name = extName.trim();
    if (!name) return;
    setLines((p) => [...p, { sku_id: null, sku_name: name, qty: "1", uom: "kg", item_type: "rm", is_off_master: true }]);
    setExtName("");
  }
  function patch(i: number, p: Partial<EditLine>) { setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...p } : l))); }
  function remove(i: number) { setLines((prev) => prev.filter((_, idx) => idx !== i)); }
  function save() {
    onSave(lines.map((l, idx) => ({
      sku_id: l.sku_id, sku_name: l.sku_name, qty: Number(l.qty) || 0, uom: l.uom,
      item_type: l.item_type, is_off_master: l.is_off_master ?? false, line_order: idx, notes: l.notes || null,
    })));
  }
  return (
    <div className="mt-2 rounded-md border border-[var(--aws-border)] p-3 space-y-3 bg-[var(--surface-subtle)]">
      <ArticlePicker onAdd={addLine} restrictItemType="rm" />
      <div className="flex items-end gap-2">
        <input className="form-input flex-1" value={extName} placeholder="External test ingredient (not in master)…"
          onChange={(e) => setExtName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addExternal(); } }} />
        <button type="button" onClick={addExternal} disabled={!extName.trim()}
          className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50">Add</button>
      </div>
      {lines.length === 0 ? (
        <p className="text-[12px] text-[var(--text-muted)]">No lines — add ingredients above.</p>
      ) : (
        <RecipeLines lines={lines} editable onPatch={patch} onRemove={remove} />
      )}
      <div className="flex items-center gap-2">
        <button disabled={busy} onClick={save} className="h-8 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[12px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Save recipe</button>
        <button disabled={busy} onClick={onCancel} className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel</button>
      </div>
    </div>
  );
}

// Output + per-phase accounting form, shown when completing a phase.
function PhaseCompleteForm({ defaultUom, busy, onComplete, onCancel }: {
  defaultUom: string; busy: boolean;
  onComplete: (body: DevPhaseCompleteBody) => void; onCancel: () => void;
}) {
  const [out, setOut] = useState("");
  const [uom, setUom] = useState(defaultUom);
  const [rm, setRm] = useState("");
  const [waste, setWaste] = useState("");
  const [ega, setEga] = useState("");
  const [notes, setNotes] = useState("");
  const qOut = Number(out) || 0, qRm = Number(rm) || 0, qWaste = Number(waste) || 0, qEga = Number(ega) || 0;
  const acctUom = uom || defaultUom || "kg";
  function confirm() {
    onComplete({
      output_qty: out ? Number(out) : undefined, output_uom: uom || undefined,
      rm_consumed_qty: rm ? Number(rm) : undefined, wastage_qty: waste ? Number(waste) : undefined,
      extra_give_away_qty: ega ? Number(ega) : undefined, notes: notes || undefined,
    });
  }
  return (
    <div className="mt-2 rounded-md border border-[var(--aws-border)] p-3 bg-[var(--surface-subtle)]">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">Phase output &amp; accounting</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <label className="text-[11px] text-[var(--text-secondary)]">FG output ({acctUom})
          <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={out} onChange={(e) => setOut(e.target.value)} />
        </label>
        <label className="text-[11px] text-[var(--text-secondary)]">Output UOM
          <UomSelect className="mt-0.5" value={uom} onChange={setUom} />
        </label>
        <label className="text-[11px] text-[var(--text-secondary)]">RM consumed ({acctUom})
          <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={rm} onChange={(e) => setRm(e.target.value)} />
        </label>
        <label className="text-[11px] text-[var(--text-secondary)]">Wastage ({acctUom})
          <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={waste} onChange={(e) => setWaste(e.target.value)} />
        </label>
        <label className="text-[11px] text-[var(--text-secondary)]">Extra give away ({acctUom})
          <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={ega} onChange={(e) => setEga(e.target.value)} />
        </label>
        <label className="text-[11px] text-[var(--text-secondary)] col-span-2 sm:col-span-1">Notes
          <input className="form-input mt-0.5" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <AcctSummary rm={qRm} out={qOut} waste={qWaste} ega={qEga} uom={acctUom} className="mt-3" />
      <div className="flex items-center gap-2 mt-3">
        <button disabled={busy} onClick={confirm} className="h-8 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[12px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Confirm complete</button>
        <button disabled={busy} onClick={onCancel} className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel</button>
      </div>
    </div>
  );
}

// Material Accounting Summary (mirrors the production job card): RM consumed in,
// reconciled against FG output + wastage + extra give-away. Yield = out / RM.
function AcctSummary({ rm, out, waste, ega, uom, className }: {
  rm: number; out: number; waste: number; ega: number; uom: string; className?: string;
}) {
  const accounted = out + waste + ega;
  const diff = rm - accounted;
  const yld = rm > 0 ? (out / rm) * 100 : null;
  const f = (n: number) => Number(n.toFixed(3)).toLocaleString("en-IN");
  const balanced = Math.abs(diff) <= 0.0005;
  return (
    <div className={`rounded-md border border-[var(--aws-border)] bg-[var(--surface-subtle)] p-3 ${className ?? ""}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-2">Accounting summary</div>
      <dl className="space-y-1 text-[12px]">
        <AcctRow label={`Total RM consumed (${uom})`} value={f(rm)} strong />
        <div className="border-t border-[var(--surface-divider)] !my-1.5" />
        <AcctRow label={`FG output (${uom})`} value={f(out)} />
        <AcctRow label={`(+) Wastage (${uom})`} value={f(waste)} />
        <AcctRow label={`(+) Extra give away (${uom})`} value={f(ega)} />
        <div className="border-t border-[var(--surface-divider)] !my-1.5" />
        <AcctRow label={`Total accounted (${uom})`} value={f(accounted)} strong />
        <AcctRow label={`Difference (${uom})`} value={f(diff)} valueClass={balanced ? "text-[var(--text-success)]" : "text-[var(--aws-error)]"} />
        <AcctRow label="Yield %" value={yld != null ? `${yld.toFixed(2)}%` : "—"} strong />
      </dl>
    </div>
  );
}
function AcctRow({ label, value, strong, valueClass }: { label: string; value: string; strong?: boolean; valueClass?: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-[var(--text-secondary)]">{label}</dt>
      <dd className={`font-mono ${strong ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"} ${valueClass ?? ""}`}>{value}</dd>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-[var(--text-muted)]">{children}</p>;
}

// ── Per-article promote (083): each article records its own output. On submit the
// whole card opens ONE dual-approval gate; on clear each article fans out to its own
// live BOM + its own FG batch (its dispatchable balance). ──────────────────────────
interface ArtOutRow { article_id: number; name: string; output_qty: string; rm: string; wastage: string; ega: string; }
function PerArticlePromoteCard({ jc, busy, requested, onSubmit }: {
  jc: DevJobCard; busy: boolean; requested: boolean; onSubmit: (body: DevJobCardCloseBody) => void;
}) {
  const uom = jc.uom || "kg";
  const arts = (jc.articles ?? []).filter((a) => a.article_id != null);
  const [rows, setRows] = useState<ArtOutRow[]>(() =>
    arts.map((a) => ({ article_id: a.article_id as number, name: a.name, output_qty: "", rm: "", wastage: "", ega: "" })));
  const [notes, setNotes] = useState("");
  const patch = (i: number, p: Partial<ArtOutRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const submit = () => onSubmit({
    output_notes: notes || undefined,
    articles: rows.map((r) => ({
      article_id: r.article_id,
      output_qty: r.output_qty ? Number(r.output_qty) : undefined,
      output_uom: uom,
      rm_consumed_qty: r.rm ? Number(r.rm) : undefined,
      wastage_qty: r.wastage ? Number(r.wastage) : undefined,
      extra_give_away_qty: r.ega ? Number(r.ega) : undefined,
    })),
  });
  return (
    <Card title="Record output & request promote">
      <p className="text-[12px] text-[var(--text-muted)] mb-3">Enter each article&apos;s finished output. Requesting promote opens one dual-approval gate — once the inventory manager and the original requestor both accept, each article is promoted into its own live BOM and its output is received as its own dispatchable FG sample.</p>
      <div className="space-y-3">
        {rows.map((r, i) => {
          const out = Number(r.output_qty) || 0, rm = Number(r.rm) || 0;
          const yld = rm > 0 ? (out / rm) * 100 : null;
          return (
            <div key={r.article_id} className="border border-[var(--aws-border)] rounded-md p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] w-6 h-6 rounded-full bg-[var(--aws-orange)] text-white font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                <span className="text-[13px] font-medium text-[var(--text-primary)]">{r.name}</span>
                {yld != null && <span className="text-[12px] text-[var(--text-muted)]">yield {yld.toFixed(2)}%</span>}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <label className="text-[11px] text-[var(--text-secondary)]">FG output ({uom})
                  <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={r.output_qty}
                    onChange={(e) => patch(i, { output_qty: e.target.value })} onWheel={(e) => e.currentTarget.blur()} />
                </label>
                <label className="text-[11px] text-[var(--text-secondary)]">RM consumed ({uom})
                  <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={r.rm}
                    onChange={(e) => patch(i, { rm: e.target.value })} onWheel={(e) => e.currentTarget.blur()} />
                </label>
                <label className="text-[11px] text-[var(--text-secondary)]">Wastage ({uom})
                  <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={r.wastage}
                    onChange={(e) => patch(i, { wastage: e.target.value })} onWheel={(e) => e.currentTarget.blur()} />
                </label>
                <label className="text-[11px] text-[var(--text-secondary)]">Extra give away ({uom})
                  <input className="form-input mt-0.5" type="number" min="0" step="0.001" value={r.ega}
                    onChange={(e) => patch(i, { ega: e.target.value })} onWheel={(e) => e.currentTarget.blur()} />
                </label>
              </div>
            </div>
          );
        })}
      </div>
      <label className="block text-[11px] text-[var(--text-secondary)] mt-3">Notes (optional)
        <input className="form-input mt-0.5" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {requested ? (
        <div className="mt-3 rounded-md border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[13px] text-[#1d8102]">
          Promote requested — awaiting inventory-manager + requestor acceptance.
        </div>
      ) : (
        <div className="mt-3">
          {/* Require at least one article's output — promote fans out to N irreversible BOMs,
              so guard against a stray empty submit (an all-blank promote is undispatchable). */}
          <button disabled={busy || !rows.some((r) => Number(r.output_qty) > 0)} onClick={submit}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Record output & request promote</button>
        </div>
      )}
    </Card>
  );
}

const PRINTER_ICON = (
  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 9V2h12v7" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <path d="M6 14h12v8H6z" />
  </svg>
);

// One definition of a cell's gridline + gutter across both tables in this panel, so the
// balances strip and the tracking ledger read as one grid rather than two styles.
const DCELL = "border border-[var(--surface-divider)] px-3";
const DHEAD = `${DCELL} py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]`;

// ── Dispatch balances ────────────────────────────────────────────────────────
// Output / dispatched / remaining as a table rather than a definition list, so it lines
// up with the ledger under it. Units sit ON the figures, not in the column headings —
// a part can be labelled in its own unit (084), so "Dispatched (kg)" over a mixed
// balance would be a heading that lies.
function DispatchBalances({ uom, out, total, remaining, fmt }: {
  uom: string; out: number; total: number; remaining: number; fmt: (v: number) => string;
}) {
  const pct = out > 1e-6 ? Math.min(100, Math.round((total / out) * 100)) : 0;
  const done = remaining <= 1e-6 && out > 1e-6;
  return (
    <table className="w-full table-fixed border-collapse text-[13px] text-center mb-3">
      <thead>
        <tr className="bg-[var(--surface-subtle)]">
          <th className={DHEAD}>Output</th>
          <th className={DHEAD}>Dispatched</th>
          <th className={DHEAD}>Remaining</th>
          <th className={DHEAD}>Progress</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className={`${DCELL} py-2 tabular-nums font-medium`}>{fmt(out)} <span className="text-[11px] text-[var(--text-muted)]">{uom}</span></td>
          <td className={`${DCELL} py-2 tabular-nums font-medium`}>{fmt(total)} <span className="text-[11px] text-[var(--text-muted)]">{uom}</span></td>
          <td className={`${DCELL} py-2 tabular-nums font-medium ${done ? "text-[#1d8102]" : ""}`}>
            {fmt(remaining)} <span className="text-[11px] text-[var(--text-muted)]">{uom}</span>
          </td>
          <td className={`${DCELL} py-2`}>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-divider)] overflow-hidden">
                <div className={`h-full rounded-full ${done ? "bg-[#1d8102]" : "bg-[var(--aws-orange)]"}`}
                  style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[11px] tabular-nums text-[var(--text-secondary)] w-9 text-right">{pct}%</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** The "add a part" inputs, rendered as the NEXT ROW of the tracking table.
 *
 *  There is no unit picker: a part goes out in the BALANCE's unit, full stop. 084 allowed
 *  a part to carry its own label, but the quantity behind it is never converted — so
 *  labelling 0.5 off a kg balance as "gm" decremented the balance by 0.5 kg while every
 *  document said grams. The unit is shown, not chosen. */
interface DispatchForm {
  qty: string; setQty: (v: string) => void;
  recipient: string; setRecipient: (v: string) => void;
  max: number; placeholder: string;
  canSubmit: boolean; onSubmit: () => void;
}

// ── Dispatch tracking ledger ─────────────────────────────────────────────────
// Every part issued out of this balance, in order, with its own PRINT action — and the
// form for the next part as the last row, so each input sits under the column it becomes.
//
// The print is deliberately PER PART, never per balance: each part fired its own 265
// goods issue, and its outpass (No <job card>-<seq>) is the document that authorizes
// that movement. A single full-quantity doc alongside them would authorize the same
// stock twice — which is why the "Download full outpass" button disappears as soon as
// the first part is dispatched. Ticking several parts prints ONE document covering
// exactly those (see lib/outpass).
function DispatchLedger({ dispatches, uom, total, remaining, fmt, onPrint, onPrintSelected, form, note }: {
  dispatches: DevDispatch[]; uom: string; total: number; remaining: number;
  fmt: (v: number) => string; onPrint: (dispatchId: number) => void;
  onPrintSelected: (dispatchIds: number[]) => void;
  form: DispatchForm | null;
  /** Shown in place of the form row when there is nothing to dispatch. */
  note: React.ReactNode;
}) {
  // Tick parts to print ONE outpass covering just those. Held as ids, not indices, and
  // intersected with the live ledger on every render — dispatching a new part reloads
  // the card, and a stale id would otherwise print a document for something not on it.
  const [ticked, setTicked] = useState<number[]>([]);
  const ids = dispatches.map((d) => d.dispatch_id);
  const selected = ticked.filter((t) => ids.includes(t));
  const allOn = selected.length > 0 && selected.length === ids.length;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Indeterminate is a DOM property, not an attribute — React cannot set it in JSX.
    if (headRef.current) headRef.current.indeterminate = selected.length > 0 && !allOn;
  }, [selected.length, allOn]);
  const toggle = (did: number) =>
    setTicked((prev) => (prev.includes(did) ? prev.filter((x) => x !== did) : [...prev, did]));
  // Print in ledger order, not click order, so the document reads like the list above it.
  const selectedInOrder = ids.filter((i) => selected.includes(i));
  // Per unit, for the same reason the printed total is (see lib/outpass sumByUom): a part
  // carries its own unit label and the quantity is not converted, so one summed figure
  // under one unit would misstate what was ticked.
  const selectedLabel = formatTotals(
    sumByUom(dispatches.filter((d) => selected.includes(d.dispatch_id)), uom), fmt);

  const COLS = 6;
  return (
    <div className="rounded-md border border-[var(--aws-border)] overflow-hidden">
      <div className="bg-[var(--surface-subtle)] border-b border-[var(--surface-divider)] px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[12px] font-semibold text-[var(--text-secondary)]">
          Dispatch tracking · {dispatches.length} part{dispatches.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        {selected.length > 0 && (
          <>
            <span className="text-[12px] text-[var(--text-secondary)] tabular-nums">
              {selected.length} selected · {selectedLabel}
            </span>
            <button onClick={() => setTicked([])}
              className="text-[12px] text-[var(--text-muted)] hover:underline">Clear</button>
            <button onClick={() => onPrintSelected(selectedInOrder)}
              title="One outpass covering only the ticked parts, each at its own quantity"
              className="h-7 px-2.5 rounded-[2px] text-[12px] font-medium bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)] inline-flex items-center gap-1.5 whitespace-nowrap">
              {PRINTER_ICON}
              Print selected ({selected.length})
            </button>
          </>
        )}
      </div>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-[var(--surface-subtle)]">
            <th className={`${DHEAD} w-9 !px-2`}>
              <input ref={headRef} type="checkbox" aria-label="Select all parts"
                className="align-middle" checked={allOn} disabled={ids.length === 0}
                onChange={() => setTicked(allOn ? [] : ids)} />
            </th>
            <th className={`${DHEAD} w-10 !px-2`}>#</th>
            <th className={`${DHEAD} text-right w-36`}>Qty</th>
            {/* The flexible column — everything else is bounded so the driver's name gets
                the slack. It used to wrap to three lines at this panel's real width. */}
            <th className={`${DHEAD} text-left`}>Recipient / driver</th>
            {/* Date + its goods issue share a column: they are one fact (when it left and
                under which 265), and two columns starved the name beside them. */}
            <th className={`${DHEAD} text-left w-28`}>Dispatched</th>
            <th className={`${DHEAD} text-right w-36`}>Outpass</th>
          </tr>
        </thead>
        <tbody>
          {dispatches.length === 0 && (
            <tr>
              <td colSpan={COLS} className={`${DCELL} py-4 text-center`}>
                <p className="text-[13px] text-[var(--text-muted)]">No parts dispatched yet.</p>
                <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                  Each part you dispatch is tracked here with its own printable outpass.
                </p>
              </td>
            </tr>
          )}
          {dispatches.map((d) => (
            <tr key={d.dispatch_id}
              className={selected.includes(d.dispatch_id) ? "bg-[#fff8f0]" : "hover:bg-[var(--surface-subtle)]"}>
              <td className={`${DCELL} py-2 text-center !px-2`}>
                <input type="checkbox" className="align-middle"
                  aria-label={`Select part ${d.dev_jc_id}-${d.seq}`}
                  checked={selected.includes(d.dispatch_id)}
                  onChange={() => toggle(d.dispatch_id)} />
              </td>
              <td className={`${DCELL} py-2 text-center !px-2`}>
                <span className="text-[11px] w-6 h-6 rounded-full bg-[var(--surface-divider)] text-[var(--text-secondary)] inline-flex items-center justify-center">{d.seq}</span>
              </td>
              <td className={`${DCELL} py-2 text-right font-medium tabular-nums whitespace-nowrap`}>
                {fmt(Number(d.qty) || 0)} <span className="text-[11px] text-[var(--text-muted)]">{d.uom || uom}</span>
              </td>
              <td className={`${DCELL} py-2 text-[var(--text-secondary)]`}>{d.recipient || "—"}</td>
              <td className={`${DCELL} py-2 text-[var(--text-secondary)] tabular-nums whitespace-nowrap`}>
                <div>{(d.dispatched_at ?? "").slice(0, 10) || "—"}</div>
                <div className="text-[11px] text-[var(--text-muted)]" title={d.mat_doc_id ? `Goods issue ${d.mat_doc_id}` : ""}>
                  {d.mat_doc_id ? `GI ${d.mat_doc_id}` : "—"}
                </div>
              </td>
              <td className={`${DCELL} py-2 text-right`}>
                {/* Prints ONLY this part: ?dispatch=<id> resolves to this ledger row, so
                    the challan carries its qty, its unit and outpass No <jc>-<seq>. */}
                <button onClick={() => onPrint(d.dispatch_id)}
                  title={`Print outpass ${d.dev_jc_id}-${d.seq} — this part only`}
                  className="h-7 px-2.5 rounded-[2px] text-[12px] font-medium border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)] inline-flex items-center gap-1.5 whitespace-nowrap">
                  {PRINTER_ICON}
                  Print #{d.dev_jc_id}-{d.seq}
                </button>
              </td>
            </tr>
          ))}
          {/* The next part, as a row of this same table — each input under the column it
              becomes once dispatched. */}
          {form ? (
            <tr className="bg-[var(--surface-subtle)]">
              <td className={`${DCELL} py-2 !px-2`} />
              <td className={`${DCELL} py-2 text-center !px-2 text-[var(--text-muted)]`}>+</td>
              <td className={`${DCELL} py-2`}>
                <div className="flex items-center gap-1 justify-end">
                  <input className="form-input !w-24 text-right !px-2" type="number" min="0" step="0.001" max={form.max}
                    aria-label="Quantity to dispatch"
                    placeholder={form.placeholder} value={form.qty}
                    onChange={(e) => form.setQty(e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()} />
                  <span className="text-[12px] text-[var(--text-secondary)] w-10">{uom}</span>
                </div>
              </td>
              <td className={`${DCELL} py-2`}>
                <input className="form-input" value={form.recipient} placeholder="Name…"
                  aria-label="Recipient / driver"
                  onChange={(e) => form.setRecipient(e.target.value)} />
              </td>
              <td className={`${DCELL} py-2 text-[12px] text-[var(--text-muted)]`}>on dispatch</td>
              <td className={`${DCELL} py-2 text-right`}>
                <button disabled={!form.canSubmit} onClick={form.onSubmit}
                  className="h-7 px-3 rounded-[2px] bg-[var(--aws-orange)] text-white text-[12px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)] whitespace-nowrap">
                  Dispatch part
                </button>
              </td>
            </tr>
          ) : (
            <tr>
              <td colSpan={COLS} className={`${DCELL} py-2`}>{note}</td>
            </tr>
          )}
        </tbody>
        {dispatches.length > 0 && (
          <tfoot>
            <tr className="bg-[var(--surface-subtle)] text-[12px]">
              <td className={`${DCELL} py-2 text-right text-[var(--text-muted)]`} colSpan={2}>Total</td>
              <td className={`${DCELL} py-2 text-right tabular-nums font-semibold`}>
                {fmt(total)} <span className="text-[11px] font-normal text-[var(--text-muted)]">{uom}</span>
              </td>
              <td className={`${DCELL} py-2 text-[var(--text-muted)]`} colSpan={3}>
                {remaining > 1e-6
                  ? <>{fmt(remaining)} {uom} still to send</>
                  : <span className="text-[#1d8102]">Fully dispatched</span>}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ── Per-article dispatch (083): one article's finalized output issued out in parts,
// each bounded by ITS own output balance, each part printing its own outpass. ───────
function PerArticleDispatchPanel({ jc, article, busy, onDispatch, onOutpass, onOutpassMany }: {
  jc: DevJobCard; article: DevArticle; busy: boolean;
  onDispatch: (articleId: number, qty: string, uom: string, recipient: string, reset: () => void) => void;
  onOutpass: (dispatchId?: number) => void;
  onOutpassMany: (dispatchIds: number[]) => void;
}) {
  const uom = article.output_uom || jc.uom || "kg";   // the balance unit (Output/Remaining)
  const out = Number(article.output_qty) || 0;
  const dispatches = article.dispatches ?? [];
  const total = article.dispatched_total != null ? Number(article.dispatched_total)
    : dispatches.reduce((s, d) => s + (Number(d.qty) || 0), 0);
  const remaining = article.remaining_qty != null ? Number(article.remaining_qty) : out - total;
  const [qty, setQty] = useState("");
  const [recipient, setRecipient] = useState("");
  const qn = qty === "" ? NaN : Number(qty);
  const invalid = qty !== "" && (!Number.isFinite(qn) || qn <= 0 || qn > remaining + 1e-6);
  const canDispatch = !busy && remaining > 1e-6 && !invalid;
  const f = (v: number) => Number(v.toFixed(3)).toLocaleString("en-IN");
  return (
    <Card title={`Dispatch / outpass — ${article.name}`}>
      <DispatchBalances uom={uom} out={out} total={total} remaining={remaining} fmt={f} />
      <DispatchLedger dispatches={dispatches} uom={uom} total={total} remaining={remaining}
        fmt={f} onPrint={onOutpass} onPrintSelected={onOutpassMany}
        note={out <= 1e-6
          ? <span className="text-[13px] text-[var(--text-secondary)]">No finalized output to dispatch for this article.</span>
          : <span className="text-[13px] text-[#1d8102]">Fully dispatched — this article&apos;s entire finalized output has been issued out.</span>}
        form={out > 1e-6 && remaining > 1e-6 ? {
          qty, setQty, recipient, setRecipient, max: remaining,
          placeholder: f(remaining),
          canSubmit: canDispatch,
          // The part goes out in the balance's own unit — see DispatchForm.
          onSubmit: () => onDispatch(article.article_id as number, qty, uom, recipient,
            () => { setQty(""); setRecipient(""); }),
        } : null} />
      {invalid ? (
        <p className="text-[12px] text-[var(--aws-error)] mt-2">Enter a quantity between 0 and the remaining {f(remaining)} {uom}, or leave blank to send the rest.</p>
      ) : remaining > 1e-6 && out > 1e-6 ? (
        <p className="text-[11px] text-[var(--text-muted)] mt-2">Leave the quantity blank to send the whole remaining {f(remaining)} {uom}.</p>
      ) : null}
    </Card>
  );
}

// Partial-out panel (CLOSED card): issue the finalized FG sample in parts. Shows
// output / dispatched / remaining, a qty+recipient row bounded by the remaining
// balance, and the ledger of parts already sent — each with its own outpass.
function DispatchPanel({ jc, busy, qty, setQty, recipient, setRecipient, onDispatch, onOutpass, onOutpassMany }: {
  jc: DevJobCard; busy: boolean;
  qty: string; setQty: (v: string) => void;
  recipient: string; setRecipient: (v: string) => void;
  onDispatch: () => void; onOutpass: (dispatchId?: number) => void;
  onOutpassMany: (dispatchIds: number[]) => void;
}) {
  const uom = jc.output_uom || jc.uom || "kg";
  const out = Number(jc.output_qty) || 0;
  const dispatches = jc.dispatches ?? [];
  const total = jc.dispatched_total != null ? Number(jc.dispatched_total)
    : dispatches.reduce((s, d) => s + (Number(d.qty) || 0), 0);
  const remaining = jc.remaining_qty != null ? Number(jc.remaining_qty) : out - total;
  const qn = qty === "" ? NaN : Number(qty);
  const invalid = qty !== "" && (!Number.isFinite(qn) || qn <= 0 || qn > remaining + 1e-6);
  const canDispatch = !busy && remaining > 1e-6 && !invalid;
  const f = (v: number) => Number(v.toFixed(3)).toLocaleString("en-IN");
  return (
    <Card title="Dispatch / outpass">
      <p className="text-[12px] text-[var(--text-muted)] mb-3">
        Issue the finalized FG sample out in parts — each part fires a goods issue and prints its own outpass. Dispatch again until the whole output is sent.
      </p>
      <DispatchBalances uom={uom} out={out} total={total} remaining={remaining} fmt={f} />
      <DispatchLedger dispatches={dispatches} uom={uom} total={total} remaining={remaining}
        fmt={f} onPrint={onOutpass} onPrintSelected={onOutpassMany}
        note={out <= 1e-6
          ? <span className="text-[13px] text-[var(--text-secondary)]">No finalized output to dispatch.</span>
          : <span className="text-[13px] text-[#1d8102]">Fully dispatched — the entire finalized output has been issued out.</span>}
        form={out > 1e-6 && remaining > 1e-6 ? {
          qty, setQty, recipient, setRecipient, max: remaining,
          placeholder: f(remaining),
          canSubmit: canDispatch, onSubmit: onDispatch,
        } : null} />
      {invalid ? (
        <p className="text-[12px] text-[var(--aws-error)] mt-2">Enter a quantity between 0 and the remaining {f(remaining)} {uom}, or leave blank to send the rest.</p>
      ) : remaining > 1e-6 && out > 1e-6 ? (
        <p className="text-[11px] text-[var(--text-muted)] mt-2">Leave the quantity blank to send the whole remaining {f(remaining)} {uom}.</p>
      ) : null}
    </Card>
  );
}

// ── Promote-approval gate panel ───────────────────────────────────────────────
// Shown whenever jc.promote_gate is non-null (a PENDING promote request exists).
// Each approval row shows the gate kind + status. The viewer sees ACCEPT/REJECT
// buttons only for gates they can act on:
//   INV_MGR gate   → viewer role_name === "inventory_manager"
//   REQUESTOR_BH gate → viewer user_id === that gate's approver_user_id
// approver_kind is always sent explicitly (safe when one user holds both gates).

const GATE_KIND_LABELS: Record<string, string> = {
  INV_MGR:      "Inventory manager",
  REQUESTOR_BH: "Requestor (business head)",
};
const APPROVAL_STATUS_STYLES: Record<string, { bg: string; fg: string; ring: string; label: string }> = {
  PENDING:  { bg: "#f4f4f4", fg: "#687078", ring: "#d5dbdb", label: "Pending" },
  ACCEPTED: { bg: "#eaf6ed", fg: "#1d8102", ring: "#b6dbb1", label: "Accepted" },
  REJECTED: { bg: "#fdf3f1", fg: "#b1361e", ring: "#f0c7be", label: "Rejected" },
};

function ApprovalStatusPill({ status }: { status: string }) {
  const s = APPROVAL_STATUS_STYLES[status] ?? APPROVAL_STATUS_STYLES.PENDING;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.fg, boxShadow: `inset 0 0 0 1px ${s.ring}` }}>
      {s.label}
    </span>
  );
}

function PromoteGatePanel({ gate, devJcId, me, busy, onAction }: {
  gate: PromoteGate;
  devJcId: number;
  me: MeResponse | null;
  busy: boolean;
  onAction: (action: "ACCEPT" | "REJECT", approverKind: "INV_MGR" | "REQUESTOR_BH") => void;
}) {
  // Suppress unused var warning — devJcId is available for future use if needed.
  void devJcId;

  const allSettled = gate.approvals.every((a) => a.status !== "PENDING");
  const overallRejected = gate.approvals.some((a) => a.status === "REJECTED");

  // `me.role_name` is always undefined in this app (the /me payload only carries
  // roles[]), so resolve the role via the fallback-aware helper the rest of the UI
  // uses. An admin can act on either gate (mirrors the backend admin bypass).
  const isInvMgr = roleNamesOf(me).includes("inventory_manager");
  const isAdmin = isAdminMe(me);
  // Fine-grained gate: INV_MGR row → inventory sign-off; REQUESTOR_BH row → BH approve.
  const canInvSignoff = useHasPermission("sample", "inv_signoff", null, "create");
  const canBhApprove = useHasPermission("sample", "approve", null, "create");

  return (
    <Card title="Promote approval gate">
      <p className="text-[12px] text-[var(--text-muted)] mb-3">
        Both gates must accept before the recipe is promoted into a live BOM.
        Requested {(gate.created_at ?? "").slice(0, 10)}.
      </p>

      {overallRejected && (
        <div className="mb-3 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">
          Promote request rejected — the recipe was not promoted.
        </div>
      )}
      {allSettled && !overallRejected && (
        <div className="mb-3 rounded-md border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[13px] text-[#1d8102]">
          Both gates accepted — recipe is being promoted.
        </div>
      )}

      <ul className="space-y-3">
        {gate.approvals.map((appr) => {
          const canAct =
            appr.status === "PENDING" &&
            ((appr.approver_kind === "INV_MGR" && (isInvMgr || isAdmin) && canInvSignoff) ||
             (appr.approver_kind === "REQUESTOR_BH" && canBhApprove && (isAdmin ||
              (me?.user_id != null && appr.approver_user_id != null
               && String(me.user_id) === String(appr.approver_user_id)))));

          return (
            <li key={appr.approver_kind}
              className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
              <span className="text-[13px] font-medium text-[var(--text-primary)] flex-1">
                {GATE_KIND_LABELS[appr.approver_kind] ?? appr.approver_kind}
              </span>
              <ApprovalStatusPill status={appr.status} />
              {canAct && (
                <div className="flex items-center gap-2 ml-auto">
                  <button
                    disabled={busy}
                    onClick={() => onAction("ACCEPT", appr.approver_kind)}
                    className="h-7 px-3 rounded-[2px] bg-[var(--aws-orange)] text-white text-[12px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">
                    Accept
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => onAction("REJECT", appr.approver_kind)}
                    className="h-7 px-3 rounded-[2px] border border-[var(--aws-error)] text-[var(--aws-error)] text-[12px] font-medium bg-white disabled:opacity-50 hover:bg-[#fdf3f1]">
                    Reject
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

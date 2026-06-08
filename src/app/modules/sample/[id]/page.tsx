"use client";

// Sample requisition detail (checklist B5–B9): header + articles, approval
// chain, audit timeline, role-gated action bar, NPD draft-BOM editor, gate-pass
// print, and internal→external conversion. Actions mirror the server state
// machine; the UI only offers what the current status + role allow.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, SAMPLE_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import {
  getRequisition, submitRequisition, cancelRequisition, closeRequisition,
  approveRequisition, issueOutward, dispatchInternal, startProduction,
  markPacking, markReady, invVerify, issueGatePass, convertFull, convertPartial,
  printGatePassBlob, getNpdDraft, createNpdDraft, replaceNpdLines, promoteNpdDraft,
  type Requisition, type NpdDraft, type NpdLine, type RecipientBody,
} from "@/lib/sample";
import { StatusPill, TYPE_LABEL } from "../_shared";
import { ArticlePicker } from "../_form";

type ModalMode =
  | null | "reject" | "cancel" | "gatePass" | "convertFull" | "convertPartial";

export default function SampleDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);

  const [req, setReq] = useState<Requisition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalMode>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await getRequisition(id);
      setReq(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!authed || !Number.isFinite(id)) return;
    // Deferred so the fetch's setState isn't synchronous in the effect body
    // (react-hooks/set-state-in-effect) — same pattern as the JC pages.
    queueMicrotask(() => { void refresh(); });
  }, [authed, id, refresh]);

  // Run a mutating action, then refresh. Centralised busy + error handling.
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {
      await fn();
      await refresh();
      setModal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  async function printGatePass() {
    if (!req?.linked_gate_pass_id) return;
    setBusy(true); setError(null);
    try {
      const blob = await printGatePassBlob(req.linked_gate_pass_id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      await refresh(); // print_count bumped server-side
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    } finally {
      setBusy(false);
    }
  }

  if (!authed) return null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/sample")} className="hover:underline">Sample</button>
          <span>/</span><span className="text-white">{req?.requisition_number ?? id}</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[980px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[
          ...SAMPLE_ROOT,
          ...(req && (req.sample_type === "NPD" || req.sample_type === "TRIAL") ? [{ label: "NPD", href: "/modules/sample/npd" }] : []),
          { label: req?.requisition_number ?? String(id) },
        ]} className="mb-3" />

        {error && <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>}

        {loading || !req ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
            {loading ? "Loading…" : "Not found."}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Header card */}
            <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">{req.requisition_number}</h1>
                <StatusPill status={req.status} />
                <span className="text-[12px] px-2 py-0.5 rounded bg-[var(--surface-divider)] text-[var(--text-secondary)]">{TYPE_LABEL[req.sample_type] ?? req.sample_type}</span>
                <span className="text-[12px] text-[var(--text-muted)]">{req.warehouse}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-y-2 gap-x-4 text-[13px]">
                <Field label="Request ID" value={req.request_id != null ? String(req.request_id) : "—"} />
                <Field label="Warehouse" value={req.warehouse ?? "—"} />
                <Field label="Purpose" value={req.purpose_tag ?? "—"} />
                <Field label="Team" value={req.requestor_team ?? "—"} />
                {req.npd_target_name && <Field label="Target NPD article" value={req.npd_target_name} />}
                <Field label="Quantity" value={req.quantity != null ? String(req.quantity) : "—"} />
                <Field label="Base BOM" value={req.base_bom_id != null ? String(req.base_bom_id) : "—"} />
                <Field label="Transporter" value={req.transporter_name ?? "—"} />
                <Field label="Vehicle no." value={req.vehicle_number ?? "—"} />
                <Field label="Created" value={(req.created_at ?? "").slice(0, 10)} />
              </dl>
              {req.purpose_note && <p className="mt-2 text-[13px] text-[var(--text-secondary)]">{req.purpose_note}</p>}
            </section>

            {/* Action bar */}
            <ActionBar req={req} caps={caps} busy={busy} run={run} setModal={setModal} printGatePass={printGatePass} />

            {/* Articles */}
            <Card title="Articles">
              {(req.articles?.length ?? 0) === 0 ? <Empty>No article lines.</Empty> : (
                <table className="w-full text-[13px]">
                  <thead><tr className="text-left text-[12px] text-[var(--text-secondary)]">
                    <th className="py-1.5 font-semibold">Article</th><th className="py-1.5 font-semibold">Role</th>
                    <th className="py-1.5 font-semibold text-right">Required</th><th className="py-1.5 font-semibold text-right">Issued</th><th className="py-1.5 font-semibold">UOM</th>
                  </tr></thead>
                  <tbody>
                    {req.articles!.map((a) => (
                      <tr key={a.id ?? a.sku_id} className="border-t border-[var(--surface-divider)]">
                        <td className="py-1.5">{a.sku_name}</td><td className="py-1.5">{a.article_role}</td>
                        <td className="py-1.5 text-right">{a.required_qty}</td>
                        <td className="py-1.5 text-right">{a.issued_qty ?? "—"}</td><td className="py-1.5">{a.uom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {/* NPD / TRIAL draft editor (recipe override + ownership) */}
            {(req.sample_type === "NPD" || req.sample_type === "TRIAL") && (
              <NpdSection req={req} caps={caps} onChange={refresh} />
            )}

            {/* Approval chain */}
            <Card title="Approval chain">
              {(req.approvals?.length ?? 0) === 0 ? <Empty>No approvals yet.</Empty> : (
                <ul className="space-y-2">
                  {req.approvals!.map((ap) => (
                    <li key={ap.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="text-[11px] w-6 h-6 rounded-full bg-[var(--surface-divider)] flex items-center justify-center">{ap.sequence_no}</span>
                      <span className="font-medium">{ap.approval_stage.replace(/_/g, " ")}</span>
                      <span className={ap.action === "APPROVED" ? "text-[var(--text-success)]" : ap.action === "REJECTED" ? "text-[var(--aws-error)]" : "text-[var(--text-muted)]"}>{ap.action}</span>
                      <span className="text-[var(--text-muted)]">{ap.role_at_action}</span>
                      {ap.remarks && <span className="text-[var(--text-secondary)]">— {ap.remarks}</span>}
                      <span className="text-[var(--text-muted)] ml-auto">{(ap.actioned_at ?? "").slice(0, 16).replace("T", " ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Audit timeline */}
            <Card title="Audit timeline">
              {(req.audit?.length ?? 0) === 0 ? <Empty>No history.</Empty> : (
                <ul className="space-y-2.5">
                  {req.audit!.map((ev) => (
                    <li key={ev.id} className="flex gap-3 text-[13px]">
                      <span className="mt-1 w-2 h-2 rounded-full bg-[var(--aws-orange)] shrink-0" />
                      <div>
                        <div className="font-medium text-[var(--text-primary)]">{ev.event_type.replace(/_/g, " ")}</div>
                        {ev.remarks && <div className="text-[var(--text-secondary)]">{ev.remarks}</div>}
                        <div className="text-[11px] text-[var(--text-muted)]">{ev.actor_role ?? ""} · {(ev.created_at ?? "").slice(0, 16).replace("T", " ")}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </main>

      {modal && req && (
        <ActionModal mode={modal} busy={busy} onClose={() => setModal(null)}
          onSubmit={(data) => {
            if (modal === "reject") return run(() => approveRequisition(req.id, "REJECTED", data.remarks));
            if (modal === "cancel") return run(() => cancelRequisition(req.id, data.reason ?? ""));
            if (modal === "gatePass") return run(() => issueGatePass(req.id, data as RecipientBody));
            if (modal === "convertFull") return run(() => convertFull(req.id, data));
            if (modal === "convertPartial") return run(() => convertPartial(req.id, { ...(data as RecipientBody), qty: Number(data.qty) }));
          }} />
      )}
    </div>
  );
}

// ── Action bar ──────────────────────────────────────────────────────────────
function ActionBar({ req, caps, busy, run, setModal, printGatePass }: {
  req: Requisition; caps: ReturnType<typeof sampleCaps>; busy: boolean;
  run: (fn: () => Promise<unknown>) => void; setModal: (m: ModalMode) => void; printGatePass: () => void;
}) {
  const s = req.status, t = req.sample_type;
  const btns: React.ReactNode[] = [];
  const P = (key: string, label: string, onClick: () => void, primary = false) => btns.push(
    <button key={key} disabled={busy} onClick={onClick}
      className={`h-9 px-4 rounded-[2px] text-[13px] font-medium disabled:opacity-50 ${primary ? "bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)]" : "border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)]"}`}>{label}</button>
  );

  if (s === "DRAFT" && caps.canRequest) P("submit", "Submit", () => run(() => submitRequisition(req.id)), true);
  if (s === "BH_REJECTED" && caps.canRequest) P("resubmit", "Re-submit", () => run(() => submitRequisition(req.id)), true);
  if (s === "SUBMITTED" && caps.canApprove) {
    P("approve", "Approve", () => run(() => approveRequisition(req.id, "APPROVED")), true);
    P("reject", "Reject", () => setModal("reject"));
  }
  if (s === "BH_APPROVED") {
    if ((t === "BASIS_RM" || t === "INTERNAL") && caps.canInventory) P("outward", "Issue outward", () => run(() => issueOutward(req.id)), true);
    if ((t === "BASIS_FG" || t === "NPD" || t === "TRIAL") && caps.canProduction) P("startprod", "Start production", () => run(() => startProduction(req.id)), true);
  }
  if (s === "IN_PRODUCTION" && caps.canProduction) P("packing", "Mark packing", () => run(() => markPacking(req.id)), true);
  if (s === "PACKING" && caps.canInventory) P("ready", "Mark ready", () => run(() => markReady(req.id)), true);
  if (s === "READY_FOR_DISPATCH" && caps.canInventory) {
    P("verify", "Inv verify", () => run(() => invVerify(req.id)));
    P("gp", "Issue gate pass", () => setModal("gatePass"), true);
    if (t === "INTERNAL") P("dispatch", "Dispatch internal", () => run(() => dispatchInternal(req.id)));
  }
  if (s === "INTERNALLY_DISPATCHED") {
    if (caps.canConvert) { P("cfull", "Convert (full)", () => setModal("convertFull"), true); P("cpart", "Convert (partial)", () => setModal("convertPartial")); }
    if (caps.canInventory) P("close1", "Close", () => run(() => closeRequisition(req.id)));
  }
  if (s === "PARTIALLY_CONVERTED" && caps.canInventory) P("close2", "Close", () => run(() => closeRequisition(req.id)));
  if (s === "GATE_PASS_ISSUED" && caps.canInventory) P("close3", "Close", () => run(() => closeRequisition(req.id)));

  // Gate-pass print is gated to inventory (+admin), matching the server's
  // `sample/gate_pass` permission — otherwise non-inventory roles would 403.
  if (req.linked_gate_pass_id && caps.canInventory) P("print", "Print gate pass", printGatePass);
  // Cancel only on the statuses the server state machine actually allows
  // → CANCELLED (INTERNALLY_DISPATCHED / PARTIALLY_CONVERTED do NOT, so we
  // must not offer it there — it would 409 illegal_transition).
  const CANCELLABLE = ["DRAFT", "SUBMITTED", "BH_REJECTED", "BH_APPROVED", "IN_PRODUCTION", "PACKING", "READY_FOR_DISPATCH"];
  if (CANCELLABLE.includes(s) && caps.canRequest) P("cancel", "Cancel", () => setModal("cancel"));

  if (btns.length === 0) return null;
  return <div className="flex flex-wrap gap-2">{btns}</div>;
}

// ── NPD draft section ────────────────────────────────────────────────────────
function NpdSection({ req, caps, onChange }: { req: Requisition; caps: ReturnType<typeof sampleCaps>; onChange: () => Promise<void> }) {
  const [draft, setDraft] = useState<NpdDraft | null>(null);
  const [lines, setLines] = useState<NpdLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (req.npd_draft_bom_id == null) { setDraft(null); return; }
    try {
      const d = await getNpdDraft(req.npd_draft_bom_id);
      setDraft(d); setLines(d.lines ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to load draft"); }
  }, [req.npd_draft_bom_id]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function wrap(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); await load(); await onChange(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }

  const editable = draft?.status === "DRAFT" && caps.canNpd;

  return (
    <Card title="NPD draft BOM">
      {err && <div className="mb-2 text-[12px] text-[var(--aws-error)]">{err}</div>}
      {req.npd_draft_bom_id == null ? (
        caps.canNpd ? (
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => wrap(() => createNpdDraft(req.id, { base_bom_id: req.base_bom_id ?? undefined, fg_sku_name: req.npd_target_name ?? undefined, clone_from_base: !!req.base_bom_id }))}
              className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">
              {req.base_bom_id ? "Create draft (clone base BOM)" : "Create empty draft"}
            </button>
          </div>
        ) : <Empty>No draft BOM yet.</Empty>
      ) : !draft ? <Empty>Loading draft…</Empty> : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-medium">Draft #{draft.id}</span>
            <StatusPillSmall status={draft.status} />
            {draft.promoted_bom_id && <span className="text-[12px] text-[var(--text-success)]">→ BOM #{draft.promoted_bom_id}</span>}
          </div>
          {/* Add materials — from the SKU master, or free-text off-master below. */}
          {editable && (
            <ArticlePicker restrictItemType="rm" onAdd={(s) => setLines((p) =>
              p.some((x) => x.sku_id === s.sku_id) ? p
                : [...p, { sku_id: s.sku_id, sku_name: s.sku_name, qty: "1", uom: "kg", item_type: "rm", ownership: "OWN", delta_type: "ADDED" }])} />
          )}
          {lines.length === 0 ? <Empty>No lines.</Empty> : (
            <table className="w-full text-[13px]">
              <thead><tr className="text-left text-[12px] text-[var(--text-secondary)]">
                <th className="py-1 font-semibold">Material</th>
                <th className="py-1 font-semibold text-right">Qty</th>
                <th className="py-1 font-semibold">UOM</th>
                <th className="py-1 font-semibold">Type</th>
                <th className="py-1 font-semibold">Ownership</th>
                {editable && <th />}
              </tr></thead>
              <tbody>
                {lines.map((ln, i) => (
                  <tr key={ln.id ?? `new-${i}`} className="border-t border-[var(--surface-divider)]">
                    <td className="py-1">{ln.sku_name}{ln.is_off_master ? <span className="text-[var(--text-muted)]"> · off-master</span> : null}</td>
                    <td className="py-1 text-right">{editable ? (
                      <input className="form-input !h-7 !w-20 text-right" type="number" step="0.001" value={String(ln.qty)}
                        onChange={(e) => setLines((p) => p.map((x, idx) => idx === i ? { ...x, qty: e.target.value } : x))} />
                    ) : ln.qty}</td>
                    <td className="py-1">{ln.uom}</td>
                    <td className="py-1">{ln.item_type ?? "—"}</td>
                    <td className="py-1">{editable ? (
                      <select className="form-input !h-7 !w-28" value={ln.ownership ?? "OWN"}
                        onChange={(e) => setLines((p) => p.map((x, idx) => idx === i ? { ...x, ownership: e.target.value as "OWN" | "CUSTOMER", is_off_master: e.target.value === "CUSTOMER" ? true : x.is_off_master } : x))}>
                        <option value="OWN">Own</option>
                        <option value="CUSTOMER">Customer</option>
                      </select>
                    ) : (ln.ownership === "CUSTOMER" ? <span className="text-[var(--aws-error)]">Customer</span> : "Own")}</td>
                    {editable && <td className="py-1 text-right"><button onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))} className="text-[12px] text-[var(--aws-error)] hover:underline">×</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editable && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button disabled={busy} onClick={() => wrap(() => replaceNpdLines(draft.id, lines.map((l) => ({
                ...l, qty: Number(l.qty) || 0, ownership: l.ownership ?? "OWN", is_off_master: !!l.is_off_master,
              }))))}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Save lines</button>
              <button disabled={busy || lines.length === 0} onClick={() => wrap(() => promoteNpdDraft(draft.id))}
                className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Promote to live BOM</button>
            </div>
          )}
          <p className="text-[11px] text-[var(--text-muted)]">Customer-supplied lines are recorded for traceability — no stock is issued for them.</p>
        </div>
      )}
    </Card>
  );
}

// ── Action modal ─────────────────────────────────────────────────────────────
type ModalData = { remarks?: string; reason?: string; qty?: string } & RecipientBody;

function ActionModal({ mode, busy, onClose, onSubmit }: {
  mode: ModalMode; busy: boolean; onClose: () => void; onSubmit: (d: ModalData) => void;
}) {
  const [d, setD] = useState<ModalData>({});
  const set = (k: keyof ModalData, v: string) => setD((p) => ({ ...p, [k]: v }));
  const recipient = mode === "gatePass" || mode === "convertFull" || mode === "convertPartial";
  const title = mode === "reject" ? "Reject requisition" : mode === "cancel" ? "Cancel requisition"
    : mode === "gatePass" ? "Issue gate pass" : mode === "convertFull" ? "Convert to gate pass (full)" : "Convert to gate pass (partial)";

  const valid = mode === "reject" ? !!d.remarks?.trim()
    : mode === "cancel" ? !!d.reason?.trim()
    : mode === "convertPartial" ? Number(d.qty) > 0
    : true;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-md w-full max-w-md p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[15px] font-semibold mb-3">{title}</h3>
        <div className="space-y-2">
          {mode === "reject" && <Textarea label="Remarks (required)" value={d.remarks ?? ""} onChange={(v) => set("remarks", v)} />}
          {mode === "cancel" && <Textarea label="Reason (required)" value={d.reason ?? ""} onChange={(v) => set("reason", v)} />}
          {mode === "convertPartial" && (
            <Input label="Quantity (≤ issued)" type="number" value={d.qty ?? ""} onChange={(v) => set("qty", v)} />
          )}
          {recipient && (
            <>
              <Input label="Recipient name" value={d.recipient_name ?? ""} onChange={(v) => set("recipient_name", v)} />
              <Input label="Recipient contact" value={d.recipient_contact ?? ""} onChange={(v) => set("recipient_contact", v)} />
              <div className="grid grid-cols-2 gap-2">
                <Input label="Vehicle / carrier" value={d.vehicle_carrier ?? ""} onChange={(v) => set("vehicle_carrier", v)} />
                <Input label="Driver" value={d.driver_name ?? ""} onChange={(v) => set("driver_name", v)} />
              </div>
              <Input label="From location" value={d.from_location ?? ""} onChange={(v) => set("from_location", v)} />
            </>
          )}
          {(mode === "convertFull" || mode === "convertPartial") && <Textarea label="Remarks (optional)" value={d.remarks ?? ""} onChange={(v) => set("remarks", v)} />}
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Cancel</button>
          <div className="flex-1" />
          <button disabled={busy || !valid} onClick={() => onSubmit(d)}
            className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{busy ? "Working…" : "Confirm"}</button>
        </div>
      </div>
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
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-[var(--text-muted)]">{children}</p>;
}
function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return <label className="block text-[11px] text-[var(--text-secondary)]">{label}<input className="form-input mt-0.5" type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Textarea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="block text-[11px] text-[var(--text-secondary)]">{label}<textarea className="form-input mt-0.5 !h-20 py-1.5" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function StatusPillSmall({ status }: { status: string }) {
  return <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--surface-divider)] text-[var(--text-secondary)]">{status}</span>;
}

"use client";

// NPD development job card detail. Standalone R&D: author the trial recipe while
// DRAFT, start development (locks the recipe), then record the output and close —
// which promotes the recipe into a live BOM. Decoupled from sample requisitions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import {
  getDevJobCard, replaceDevLines, startDevJobCard, closeDevJobCard, cancelDevJobCard, dispatchDevJobCard,
  type DevJobCard, type DevLine,
} from "@/lib/npd-dev";
import { DevJcStatusPill } from "../../../sample/_shared";
import { ArticlePicker, UomSelect } from "../../../sample/_form";

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

  const [jc, setJc] = useState<DevJobCard | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [extName, setExtName] = useState("");   // free-typed external test ingredient
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close form (accounting). Yield % is derived, not entered.
  const [outQty, setOutQty] = useState("");
  const [outUom, setOutUom] = useState("");
  const [outRm, setOutRm] = useState("");        // total RM consumed
  const [outWastage, setOutWastage] = useState("");
  const [outEga, setOutEga] = useState("");      // extra give away
  const [outNotes, setOutNotes] = useState("");

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

  const isDraft = jc?.status === "DRAFT";
  const editable = isDraft && caps.canNpd;

  // Live accounting math for the close form (material balance + auto yield).
  const qOut = Number(outQty) || 0;
  const qRm = Number(outRm) || 0;
  const qWaste = Number(outWastage) || 0;
  const qEga = Number(outEga) || 0;
  const yieldPct = qRm > 0 ? (qOut / qRm) * 100 : null;
  const totalAccounted = qOut + qWaste + qEga;
  const balanceDiff = qRm - totalAccounted;
  const acctUom = outUom || jc?.uom || "kg";

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
  function closeCard() {
    run(() => closeDevJobCard(id, {
      output_qty: outQty ? Number(outQty) : undefined,
      output_uom: outUom || undefined,
      rm_consumed_qty: outRm ? Number(outRm) : undefined,
      wastage_qty: outWastage ? Number(outWastage) : undefined,
      extra_give_away_qty: outEga ? Number(outEga) : undefined,
      yield_pct: yieldPct != null ? Number(yieldPct.toFixed(2)) : undefined,
      output_notes: outNotes || undefined,
    }));
  }
  function cancelCard() {
    const reason = window.prompt("Reason for cancelling this development job card?");
    if (reason == null) return; // user dismissed
    run(() => cancelDevJobCard(id, reason || "cancelled"));
  }
  function dispatch() {
    const recipient = window.prompt("Recipient for this sample dispatch?");
    if (recipient == null) return;
    run(() => dispatchDevJobCard(id, { recipient: recipient || undefined }));
  }
  // Raise an RM Issue/Collection form (Doc 015) for this trial — Store issues it.
  function requestRm() {
    if (!jc) return;
    const q = new URLSearchParams({ source_type: "NPD_DEV_JC", source_id: String(id), trial: jc.title || "" });
    if (jc.fg_sku_name) q.set("product", jc.fg_sku_name);
    router.push(`/modules/sample/rm-issue-forms/new?${q}`);
  }

  if (!authed) return null;

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <nav className="text-[12px] text-[#d5dbdb] hidden sm:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules/npd-development")} className="hover:underline">NPD Development</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/npd-development/job-cards")} className="hover:underline">Job cards</button>
          <span>/</span><span className="text-white">{jc?.dev_jc_number ?? id}</span>
        </nav>
        <div className="flex-1" />
        <button onClick={() => router.push("/modules/profile")} aria-label="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]">{initial}</button>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumbs items={[...NPD_DEV_ROOT, { label: "Job cards", href: "/modules/npd-development/job-cards" }, { label: jc?.dev_jc_number ?? String(id) }]} className="mb-3" />

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
                <h1 className="text-[20px] font-semibold text-[var(--text-primary)] font-mono">{jc.dev_jc_number}</h1>
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
                <Field label="Target qty" value={jc.target_qty != null ? `${num(jc.target_qty)} ${jc.uom ?? ""}`.trim() : "—"} />
                <Field label="Base BOM" value={jc.base_bom_id != null ? `${jc.base_bom_name ? `${jc.base_bom_name} ` : ""}#${jc.base_bom_id}` : "—"} />
                <Field label="Created" value={(jc.created_at ?? "").slice(0, 10)} />
                {jc.started_at && <Field label="Started" value={(jc.started_at ?? "").slice(0, 10)} />}
                {jc.closed_at && <Field label="Closed" value={(jc.closed_at ?? "").slice(0, 10)} />}
              </dl>
              {jc.status === "CANCELLED" && jc.cancellation_reason && (
                <p className="mt-2 text-[12px] text-[var(--aws-error)]">Cancelled — {jc.cancellation_reason}</p>
              )}
            </section>

            {/* Action bar */}
            {caps.canNpd && (jc.status === "DRAFT" || jc.status === "IN_DEVELOPMENT") && (
              <div className="flex flex-wrap gap-2">
                {jc.status === "DRAFT" && (
                  <button disabled={busy} onClick={() => run(() => startDevJobCard(id))}
                    className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Start development</button>
                )}
                <button disabled={busy} onClick={requestRm}
                  className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Request RM (Doc 015)</button>
                <button disabled={busy} onClick={cancelCard}
                  className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Cancel job card</button>
              </div>
            )}

            {/* Recipe */}
            <Card title="Trial recipe">
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
                <table className="w-full text-[13px]">
                  <thead><tr className="text-left text-[12px] text-[var(--text-secondary)]">
                    <th className="py-1.5 font-semibold">Material</th>
                    <th className="py-1.5 font-semibold text-right">Qty</th>
                    <th className="py-1.5 font-semibold">UOM</th>
                    <th className="py-1.5 font-semibold">Type</th>
                    {editable && <th />}
                  </tr></thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.id ?? `n-${i}`} className="border-t border-[var(--surface-divider)]">
                        <td className="py-1.5">
                          <span className="flex items-center gap-2">
                            {l.sku_name}
                            <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${l.is_off_master ? "bg-[#fff7ed] text-[#c2410c]" : l.sku_id == null ? "bg-[var(--surface-subtle)] text-[var(--text-secondary)]" : "bg-[#eef2ff] text-[#4338ca]"}`}>{l.is_off_master ? "external" : l.sku_id == null ? "base" : "added"}</span>
                          </span>
                        </td>
                        <td className="py-1.5 text-right">
                          {editable ? (
                            <input className="form-input !h-7 !w-24 text-right" type="number" step="0.001" value={l.qty}
                              onChange={(e) => patchLine(i, { qty: e.target.value })} />
                          ) : num(l.qty)}
                        </td>
                        <td className="py-1.5">
                          {editable ? (
                            <input className="form-input !h-7 !w-20" value={l.uom} onChange={(e) => patchLine(i, { uom: e.target.value })} />
                          ) : l.uom}
                        </td>
                        <td className="py-1.5">
                          {editable ? (
                            <select className="form-input !h-7 !w-20" value={l.item_type} onChange={(e) => patchLine(i, { item_type: e.target.value as "rm" | "pm" })}>
                              {ITEM_TYPES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                            </select>
                          ) : (l.item_type ?? "—").toUpperCase()}
                        </td>
                        {editable && <td className="py-1.5 text-right"><button onClick={() => removeLine(i)} className="text-[12px] text-[var(--aws-error)] hover:underline">×</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {editable && (
                <div className="mt-3">
                  <button disabled={busy} onClick={saveLines}
                    className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Save recipe</button>
                </div>
              )}
            </Card>

            {/* Record output & close (IN_DEVELOPMENT) */}
            {caps.canNpd && jc.status === "IN_DEVELOPMENT" && (
              <Card title="Record output & close">
                <p className="text-[12px] text-[var(--text-muted)] mb-3">Closing records the material accounting + trial output and promotes this recipe into a live BOM.</p>
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

                <div className="mt-3">
                  <button disabled={busy} onClick={closeCard}
                    className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Record output & promote → close</button>
                </div>
              </Card>
            )}

            {/* Output (CLOSED) */}
            {jc.status === "CLOSED" && (
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
                {/* Step C — issue the developed FG sample out of R&D. */}
                {jc.dispatched_at ? (
                  <p className="mt-3 text-[12px] text-[var(--text-secondary)]">
                    Dispatched {(jc.dispatched_at ?? "").slice(0, 10)} to <strong>{jc.dispatch_recipient || "—"}</strong>
                    {jc.dispatch_mat_doc_id ? ` · GI ${jc.dispatch_mat_doc_id}` : ""}
                  </p>
                ) : caps.canNpd && jc.fg_sample_batch_id ? (
                  <div className="mt-3">
                    <button disabled={busy} onClick={dispatch}
                      className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">Issue / dispatch sample</button>
                  </div>
                ) : null}
              </Card>
            )}
          </div>
        )}
      </main>
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

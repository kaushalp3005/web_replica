"use client";

// Walk-in Purchase Intimation modal — opened from the Material In page header.
// Records a NO-PO arrival: articles are browsed/searched from the GLOBAL SKU
// master via the shared ArticlePicker, priced with a rate + qty per line.
// POSTs to /api/v1/po/walk-in-intimation, which records the arrival under a
// generated WI-* transaction id and WhatsApps the purchase team the
// `purchase_without_po_intimation` template so they raise the PO.
//
// Every field here is a template variable — the message carries invoice /
// vendor / vehicle / warehouse / indentor plus the priced article table, so
// they're collected up-front rather than derived.

import { useEffect, useMemo, useState } from "react";
import { sendWalkInIntimation, type WalkInIntimationResult } from "@/lib/po";
import { ArticlePicker } from "@/app/modules/sample/_form";
import { WAREHOUSE_OPTIONS } from "@/lib/admin-api";
import { useMe, useUserScope } from "@/lib/user";
import { normaliseWarehouseCode } from "@/lib/warehouseScope";

type PickedItem = { sku_id: number; sku_name: string; rate: string; qty: string };

// No width here on purpose — each use site sets its own. A `w-full` baked in
// would win over an appended `w-20` (Tailwind resolves by stylesheet order, not
// class-attribute order) and blow out the article row.
const FIELD_CLS =
  "h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white focus:outline-none focus:border-[var(--aws-navy)] disabled:bg-[var(--surface-disabled)]";
const LABEL_CLS = "block text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] mb-1";

function n(v: string): number {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : 0;
}
function fmt(v: number): string {
  return v === Math.trunc(v) ? String(v) : v.toFixed(2);
}

export function WalkInIntimationModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const titleId = "walkin-intimation-title";
  const me = useMe();
  const { warehouses } = useUserScope();

  const [items, setItems] = useState<PickedItem[]>([]);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vehicleNo, setVehicleNo] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [indentor, setIndentor] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WalkInIntimationResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Seed indentor + warehouse from the signed-in user once the cached /me
  // snapshot lands (a microtask after mount). Only fills a still-empty field,
  // so anything already typed survives.
  useEffect(() => {
    if (me?.full_name) setIndentor((v) => v || me.full_name!);
  }, [me]);
  useEffect(() => {
    const mine = warehouses
      .map((w) => WAREHOUSE_OPTIONS.find((o) => normaliseWarehouseCode(o.value) === normaliseWarehouseCode(w))?.value)
      .find(Boolean);
    if (mine) setWarehouse((v) => v || mine);
  }, [warehouses]);

  // Add an article from the picker, de-duped on sku_id.
  function addItem(s: { sku_id: number; sku_name: string }) {
    setItems((prev) =>
      prev.some((p) => p.sku_id === s.sku_id)
        ? prev
        : [...prev, { sku_id: s.sku_id, sku_name: s.sku_name, rate: "", qty: "" }],
    );
  }
  function removeItem(skuId: number) {
    setItems((prev) => prev.filter((p) => p.sku_id !== skuId));
  }
  function patchItem(skuId: number, patch: Partial<PickedItem>) {
    setItems((prev) => prev.map((p) => (p.sku_id === skuId ? { ...p, ...patch } : p)));
  }

  const totals = useMemo(
    () => items.reduce(
      (a, i) => ({ qty: a.qty + n(i.qty), base: a.base + n(i.rate) * n(i.qty) }),
      { qty: 0, base: 0 },
    ),
    [items],
  );
  // Every article must be priced — an unpriced line makes the message's Base
  // Value / GST Value meaningless to whoever has to raise the PO.
  const allPriced = items.every((i) => n(i.rate) > 0 && n(i.qty) > 0);
  const canSend = !sending && items.length > 0 && allPriced;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    setResult(null);
    try {
      const res = await sendWalkInIntimation({
        invoice_no: invoiceNo.trim() || undefined,
        vendor_name: vendorName.trim() || undefined,
        vehicle_number: vehicleNo.trim() || undefined,
        warehouse: warehouse || undefined,
        indentor: indentor.trim() || undefined,
        items: items.map((i) => ({ sku_id: i.sku_id, sku_name: i.sku_name, rate: n(i.rate), qty: n(i.qty) })),
      });
      setResult(res);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Failed to send intimation");
    } finally {
      setSending(false);
    }
  }

  // ── Result summary (mirrors SendIntimationModal) ──────────────────────────────
  function renderResult(r: WalkInIntimationResult) {
    const sentCount = r.recipients.filter((rec) => rec.status === "sent").length;
    const failedRecipients = r.recipients.filter((rec) => rec.status !== "sent");
    return (
      <div className="mt-4 space-y-2 text-[13px]">
        <div className="flex items-start gap-2 rounded-[2px] border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[var(--text-success)]">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} className="mt-0.5 shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>
            Arrival recorded as <span className="font-mono font-semibold">{r.transaction_no}</span>.{" "}
            {sentCount > 0
              ? `Purchase intimation sent to ${sentCount} recipient${sentCount === 1 ? "" : "s"}.`
              : "No purchase intimation went out — see below."}
          </span>
        </div>
        {failedRecipients.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] mb-1">Delivery issues</p>
            {failedRecipients.map((rec, i) => (
              <p key={i} className="text-[var(--aws-error)] text-[12px]">{rec.role} ({rec.phone}): {rec.error ?? rec.status}</p>
            ))}
          </div>
        ) : null}
        {r.skipped.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-border)] bg-[var(--surface-subtle)] px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-muted)] mb-1">Skipped</p>
            {r.skipped.map((s, i) => (
              <p key={i} className="text-[var(--text-secondary)] text-[12px]">
                {s.reason === "whatsapp_disabled"
                  ? "WhatsApp is disabled on the server."
                  : s.reason === "no_purchase_recipients"
                  ? "No active user holds the purchase role (with a phone number) — nobody to notify."
                  : s.reason === "no_qc_recipients"
                  ? "No QC recipients found."
                  : `${s.role}: ${s.reason}`}
              </p>
            ))}
          </div>
        ) : null}
        {r.errors.length > 0 ? (
          <div className="rounded-[2px] border border-[var(--aws-error)] bg-[#fdf0f0] px-3 py-2">
            {r.errors.map((err, i) => (
              <p key={i} className="text-[var(--aws-error)] text-[12px]">{err}</p>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const locked = sending || !!result;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-md shadow-[0_8px_32px_rgba(0,28,36,0.28)] w-full max-w-3xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-[var(--aws-border)]">
          <h2 id={titleId} className="text-[15px] font-semibold text-[var(--text-primary)]">Send Purchase Intimation</h2>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Walk-in arrival (no PO) — WhatsApps the purchase team to create &amp; upload the PO.
          </p>
        </div>

        {/* Scrollable body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {/* Consignment details — every one of these is a variable in the
              purchase_without_po_intimation WhatsApp template. */}
          {!result ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <div>
                <label className={LABEL_CLS} htmlFor="wi-invoice">Invoice No.</label>
                <input id="wi-invoice" className={`${FIELD_CLS} w-full`} value={invoiceNo} disabled={locked}
                  onChange={(e) => setInvoiceNo(e.target.value)} placeholder="GAPL/26-27/331" />
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="wi-vendor">Vendor Name</label>
                <input id="wi-vendor" className={`${FIELD_CLS} w-full`} value={vendorName} disabled={locked}
                  onChange={(e) => setVendorName(e.target.value)} placeholder="Walk-in" />
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="wi-vehicle">Vehicle No.</label>
                <input id="wi-vehicle" className={`${FIELD_CLS} w-full`} value={vehicleNo} disabled={locked}
                  onChange={(e) => setVehicleNo(e.target.value)} placeholder="MH43BP3720" />
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="wi-warehouse">Warehouse</label>
                <select id="wi-warehouse" className={`${FIELD_CLS} w-full`} value={warehouse} disabled={locked}
                  onChange={(e) => setWarehouse(e.target.value)}>
                  <option value="">—</option>
                  {WAREHOUSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL_CLS} htmlFor="wi-indentor">Indentor</label>
                <input id="wi-indentor" className={`${FIELD_CLS} w-full`} value={indentor} disabled={locked}
                  onChange={(e) => setIndentor(e.target.value)} placeholder="Signed-in user" />
              </div>
            </div>
          ) : null}

          {/* Article picker (global SKU master — search + browse) */}
          {!result ? (
            <div className="mb-3">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5">
                Add Articles
              </label>
              <ArticlePicker onAdd={addItem} />
            </div>
          ) : null}

          {/* Selected articles */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                Selected Articles ({items.length})
              </label>
            </div>
            {/* Priced lines — rate × qty is the Base Value column in the
                intimation; GST% is applied server-side from the SKU master. */}
            <div className="max-h-[280px] overflow-y-auto rounded-[2px] border border-[var(--aws-border)] divide-y divide-[var(--aws-border)]">
              {items.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-[var(--text-muted)] italic">No articles yet — search or browse above to add.</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--surface-subtle)] text-[10px] font-bold uppercase tracking-wide text-[var(--text-muted)]">
                    <span className="flex-1">Article</span>
                    <span className="w-20 shrink-0 text-right">Rate</span>
                    <span className="w-20 shrink-0 text-right">Qty (Kgs)</span>
                    <span className="w-24 shrink-0 text-right">Base Value</span>
                    <span className="w-4 shrink-0" />
                  </div>
                  {items.map((it) => (
                    <div key={it.sku_id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                      <span className="flex-1 min-w-0 truncate" title={it.sku_name}>{it.sku_name}</span>
                      <input
                        type="number" min="0" step="any" inputMode="decimal"
                        aria-label={`Rate for ${it.sku_name}`}
                        className={`${FIELD_CLS} w-20 shrink-0 text-right`}
                        value={it.rate} disabled={locked}
                        onChange={(e) => patchItem(it.sku_id, { rate: e.target.value })}
                      />
                      <input
                        type="number" min="0" step="any" inputMode="decimal"
                        aria-label={`Quantity in kgs for ${it.sku_name}`}
                        className={`${FIELD_CLS} w-20 shrink-0 text-right`}
                        value={it.qty} disabled={locked}
                        onChange={(e) => patchItem(it.sku_id, { qty: e.target.value })}
                      />
                      <span className="w-24 shrink-0 text-right tabular-nums">{fmt(n(it.rate) * n(it.qty))}</span>
                      <span className="w-4 shrink-0 text-right">
                        {!locked ? (
                          <button
                            type="button"
                            onClick={() => removeItem(it.sku_id)}
                            aria-label={`Remove ${it.sku_name}`}
                            className="text-[16px] leading-none text-[var(--text-muted)] hover:text-[var(--aws-error)]"
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 px-3 py-2 text-[13px] font-semibold bg-[var(--surface-subtle)]">
                    <span className="flex-1">Total</span>
                    <span className="w-20 shrink-0" />
                    <span className="w-20 shrink-0 text-right tabular-nums">{fmt(totals.qty)}</span>
                    <span className="w-24 shrink-0 text-right tabular-nums">{fmt(totals.base)}</span>
                    <span className="w-4 shrink-0" />
                  </div>
                </>
              )}
            </div>
            {items.length > 0 && !allPriced && !result ? (
              <p className="mt-1.5 text-[12px] text-[var(--aws-error)]">Enter a rate and quantity for every article.</p>
            ) : null}
          </div>

          {sendError ? (
            <div className="mt-3 rounded-[2px] border border-[var(--aws-error)] bg-[#fdf0f0] px-3 py-2 text-[13px] text-[var(--aws-error)]">
              {sendError}
            </div>
          ) : null}

          {result ? renderResult(result) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--aws-border)] flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50"
          >
            {result ? "Close" : "Cancel"}
          </button>
          {!result ? (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              className="h-8 px-4 text-[13px] rounded-[2px] border border-[var(--aws-navy)] bg-[var(--aws-navy)] text-white hover:bg-[#0e2847] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {sending ? <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : null}
              {sending ? "Sending…" : "Send Intimation"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

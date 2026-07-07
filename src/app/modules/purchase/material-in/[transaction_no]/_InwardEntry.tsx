"use client";

// Inward entry orchestrator: fetch the PO, hold the editable draft in a reducer,
// and render the summary (Task 3). Logistics form, line accordion, box sections,
// and the save flow are layered on in later tasks at the marked slots.

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BackLink } from "@/components/BackLink";
import { fmtNum, fmtDate } from "@/lib/po";
import { getPurchasePo, addBoxes, updateBoxes, saveReceive, type PurchasePoDetail, type PurchaseLine } from "@/lib/purchase-receive";
import { listArrivals, type ArrivalItem } from "@/lib/qc";
import { inwardReducer, buildReceiveRequest, buildUpdateSections, buildAddSections, buildAddBoxesPayload, type DraftState, type LogisticsField, type InwardAction, type SectionSeed, type PrintBox } from "./_boxEngine";
import { LineCard } from "./_LineCard";
import { SendIntimationModal } from "../_SendIntimationModal";

function matchKey(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

// Derive logistics prefill from the latest arrival intimation. Arrivals from one
// intimation share vehicle/invoice; prefer the most recent non-empty value. The
// intimation's single "Invoice No. / Challan No." fills both invoice + challan.
function intimationPrefill(arrivals: ArrivalItem[]): Partial<Record<LogisticsField, string>> {
  const byRecent = [...arrivals].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const vehicle = byRecent.find((a) => a.vehicle_no)?.vehicle_no ?? "";
  const invoice = byRecent.find((a) => a.invoice_no)?.invoice_no ?? "";
  const out: Partial<Record<LogisticsField, string>> = {};
  if (vehicle) out.vehicle_number = vehicle;
  if (invoice) {
    out.invoice_number = invoice;
    out.challan_number = invoice;
  }
  return out;
}

// One pre-seeded section per arrived article: a PO line that matches an arrival
// (by sku name) and has no existing section yet. Lot comes from the most recent
// matching arrival that carries one (often blank — qc_intimation may not have it).
function sectionSeeds(po: PurchasePoDetail, arrivals: ArrivalItem[]): SectionSeed[] {
  if (arrivals.length === 0) return [];
  const seeds: SectionSeed[] = [];
  for (const line of po.lines ?? []) {
    if ((line.sections ?? []).length > 0) continue; // already received
    const lineName = matchKey(line.sku_name) || matchKey(line.particulars);
    if (!lineName) continue;
    const matches = arrivals.filter((a) => matchKey(a.sku_name) === lineName);
    if (matches.length === 0) continue; // not intimated/arrived
    const lot = [...matches]
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .find((a) => a.lot_number)?.lot_number ?? "";
    seeds.push({ line_number: line.line_number, lot_number: lot });
  }
  return seeds;
}

export function InwardEntry({ transactionNo }: { transactionNo: string }): React.JSX.Element {
  const router = useRouter();
  const [po, setPo] = useState<PurchasePoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Draft is null until the PO loads; the reducer's `reset` action seeds it.
  // `draft != null` therefore doubles as the "ready" flag (no ref needed).
  const [draft, dispatch] = useReducer(inwardReducer, null as unknown as DraftState);
  // Key of the per-section action currently running (e.g. "u:1:2"/"a:1:2"); disables that button.
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [intimateOpen, setIntimateOpen] = useState(false);
  // Intimation-derived prefill (vehicle/invoice/challan), re-applied on every
  // reset so a per-section refresh doesn't drop it before the full save persists.
  const prefillRef = useRef<Partial<Record<LogisticsField, string>>>({});
  // Pre-seeded sections (per arrived article), re-applied on reset like prefill.
  const seedsRef = useRef<SectionSeed[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      if (!transactionNo) {
        setError("No transaction selected.");
        setLoading(false);
        return;
      }
      try {
        const [data, arrivals] = await Promise.all([
          getPurchasePo(transactionNo, controller.signal),
          // Best-effort: QC may be unavailable or the txn may have no arrivals.
          listArrivals(transactionNo, controller.signal).catch(() => [] as ArrivalItem[]),
        ]);
        if (controller.signal.aborted) return;
        const prefill = intimationPrefill(arrivals);
        const seeds = sectionSeeds(data, arrivals);
        prefillRef.current = prefill;
        seedsRef.current = seeds;
        setPo(data);
        dispatch({ type: "reset", po: data, prefill, seeds });
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load Purchase Order");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [transactionNo]);

  // Re-fetch the PO and reseed the draft (used after a per-section save).
  // Mirrors po-receiving.js refreshPO — unsaved new sections are discarded.
  async function refresh() {
    const data = await getPurchasePo(transactionNo);
    setPo(data);
    dispatch({ type: "reset", po: data, prefill: prefillRef.current, seeds: seedsRef.current });
  }

  async function handleUpdateSection(line: PurchaseLine, sectionNumber: number) {
    if (!po) return;
    const sections = buildUpdateSections(draft, po).filter(
      (s) => s.line_number === line.line_number && s.section_number === sectionNumber,
    );
    if (sections.length === 0) return;
    setBusy(`u:${line.line_number}:${sectionNumber}`);
    setToast(null);
    try {
      await updateBoxes(transactionNo, { sections });
      await refresh();
      setToast({ kind: "ok", text: `Section ${sectionNumber} updated` });
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Update failed" });
    } finally {
      setBusy(null);
    }
  }

  async function handleAddBoxesToSection(line: PurchaseLine, sectionNumber: number) {
    const payload = buildAddBoxesPayload(draft, line, sectionNumber, Date.now());
    if (payload.boxes.length === 0) return;
    setBusy(`a:${line.line_number}:${sectionNumber}`);
    setToast(null);
    try {
      await addBoxes(transactionNo, { sections: [payload] });
      await refresh();
      setToast({ kind: "ok", text: `Boxes added to Section ${sectionNumber}` });
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Failed to add boxes" });
    } finally {
      setBusy(null);
    }
  }

  // Full save (reference save handler 1180-1406): receive → update existing
  // sections → create new sections, in order. Any step error aborts the rest.
  async function handleSave() {
    if (!po) return;
    setBusy("save");
    setToast(null);
    try {
      await saveReceive(transactionNo, buildReceiveRequest(draft, po));
      const updates = buildUpdateSections(draft, po);
      if (updates.length > 0) await updateBoxes(transactionNo, { sections: updates });
      const news = buildAddSections(draft, po, Date.now());
      if (news.length > 0) await addBoxes(transactionNo, { sections: news });
      await refresh();
      setToast({ kind: "ok", text: "Receiving data saved successfully" });
    } catch (e) {
      setToast({ kind: "err", text: e instanceof Error ? e.message : "Failed to save receiving data" });
    } finally {
      setBusy(null);
    }
  }

  // Print hook — wiring point for label printing (functionality provided later).
  function handlePrint(boxes: PrintBox[]) {
    if (boxes.length === 0) return;
    // TODO: integrate actual label printing here.
    setToast({
      kind: "ok",
      text: `Print requested for ${boxes.length} box${boxes.length === 1 ? "" : "es"} — printing will be enabled once configured.`,
    });
  }

  if (loading) return <Shell><Centered>Loading Purchase Order…</Centered></Shell>;
  if (error) return <Shell><Centered tone="err">{error}</Centered></Shell>;
  if (!po || !draft) return <Shell><Centered>Preparing…</Centered></Shell>;

  return (
    <Shell>
      {toast ? (
        <div
          className={[
            "mb-3 px-3 py-2 text-[13px] rounded-[2px] border flex items-center justify-between gap-2",
            toast.kind === "ok"
              ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]"
              : "bg-[#fbeced] border-[#f0c0c4] text-[var(--aws-error)]",
          ].join(" ")}
        >
          <span>{toast.text}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className="text-[16px] leading-none opacity-60 hover:opacity-100">×</button>
        </div>
      ) : null}

      <SummaryGrid po={po} />

      <LogisticsForm header={draft.header} dispatch={dispatch} />

      <div className="mb-4">
        <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">Line Items — Stores Data</div>
        {po.lines.length === 0 ? (
          <div className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-center text-[12px] text-[var(--text-muted)] italic">No articles on this PO.</div>
        ) : (
          po.lines.map((l) => (
            <LineCard
              key={l.line_number}
              line={l}
              draft={draft}
              dispatch={dispatch}
              onUpdateSection={handleUpdateSection}
              onAddBoxesToSection={handleAddBoxesToSection}
              busy={busy}
              onPrint={handlePrint}
            />
          ))
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--aws-border)] pt-4">
        {/* Notify QC — independent of receiving; pre-filled with the inward's data */}
        <button
          type="button"
          onClick={() => setIntimateOpen(true)}
          className="h-9 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[#2c5fa8] hover:text-[#2c5fa8] inline-flex items-center gap-2"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          Intimate QC
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.push("/modules/purchase/material-in")}
            className="h-9 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleSave}
            className="h-9 px-4 text-[13px] rounded-[2px] bg-[var(--aws-orange)] text-white font-semibold hover:bg-[var(--aws-orange-hover)] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {busy === "save" ? (
              <span className="inline-block w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : null}
            {busy === "save" ? "Saving…" : "Save Receiving Data"}
          </button>
        </div>
      </div>

      {intimateOpen ? (
        <SendIntimationModal
          transactionNo={po.transaction_no}
          poNumber={po.po_number ?? ""}
          vendor={po.vendor_supplier_name ?? ""}
          articles={po.lines.map((l) => ({ line_number: l.line_number, name: l.sku_name || l.particulars || "—" }))}
          initialVehicle={draft.header.vehicle_number ?? ""}
          initialInvoice={draft.header.challan_number || draft.header.invoice_number || ""}
          transportReadOnly
          onBeforeSend={async () => {
            // Save the inward logistics (vehicle/challan/etc.) before intimating.
            await saveReceive(transactionNo, buildReceiveRequest(draft, po));
          }}
          onClose={() => setIntimateOpen(false)}
        />
      ) : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3">
        <BackLink parentHref="/modules/purchase/material-in" label="Material In" />
      </div>
      <div className="mb-4">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">PO Receiving</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">Box-wise inward entry — record logistics and weigh boxes per article.</p>
      </div>
      {children}
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "err" }) {
  return (
    <div
      className={[
        "bg-white border rounded-md p-10 text-center text-[13px]",
        tone === "err" ? "border-[#f0c0c4] text-[var(--aws-error)]" : "border-[var(--aws-border)] text-[var(--text-secondary)]",
      ].join(" ")}
    >
      <span className="inline-flex items-center gap-2">
        {tone === "err" ? null : (
          <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
        )}
        {children}
      </span>
    </div>
  );
}

// Logistics & Receiving form — 12 Stores-owned fields (reference index.html 146-202).
const LOGISTICS_DEFS: { field: LogisticsField; label: string; placeholder: string; type?: string; mono?: boolean }[] = [
  { field: "customer_party_name", label: "Customer / Party", placeholder: "Buyer party name" },
  { field: "vehicle_number", label: "Vehicle Number", placeholder: "MH12AB1234", mono: true },
  { field: "transporter_name", label: "Transporter", placeholder: "Transporter name" },
  { field: "lr_number", label: "LR Number", placeholder: "Lorry receipt number", mono: true },
  { field: "source_location", label: "Source Location", placeholder: "Origin" },
  { field: "challan_number", label: "Challan Number", placeholder: "Challan no", mono: true },
  { field: "invoice_number", label: "Invoice Number", placeholder: "Invoice no", mono: true },
  { field: "grn_number", label: "GRN Number", placeholder: "GRN no", mono: true },
  { field: "system_grn_date", label: "GRN Date", placeholder: "", type: "datetime-local" },
  { field: "purchased_by", label: "Purchased By", placeholder: "Name" },
  { field: "inward_authority", label: "Inward Authority", placeholder: "Who authorized" },
  { field: "warehouse", label: "Warehouse", placeholder: "e.g. W202", mono: true },
];

function LogisticsForm({
  header,
  dispatch,
}: {
  header: DraftState["header"];
  dispatch: React.Dispatch<InwardAction>;
}) {
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 mb-4">
      <div className="mb-3">
        <div className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">Logistics &amp; Receiving</div>
        <p className="text-[11px] text-[var(--text-muted)] mt-0.5">Pre-filled from the PO and the latest arrival intimation (vehicle no., invoice / challan) where available.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {LOGISTICS_DEFS.map((d) => {
          const id = `mi-recv-${d.field}`;
          return (
            <div key={d.field} className="flex flex-col gap-1">
              <label htmlFor={id} className="text-[11px] font-semibold text-[var(--text-primary)]">{d.label}</label>
              <input
                id={id}
                type={d.type ?? "text"}
                value={header[d.field] ?? ""}
                placeholder={d.placeholder}
                onChange={(e) => dispatch({ type: "setHeader", field: d.field, value: e.target.value })}
                className={[
                  "h-8 px-2 text-[13px] rounded-[2px] bg-white border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e]",
                  d.mono ? "font-mono" : "",
                ].join(" ")}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryGrid({ po }: { po: PurchasePoDetail }) {
  const cell = (label: string, value: React.ReactNode, mono = false) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">{label}</span>
      <span className={["text-[13px] text-[var(--text-primary)] break-words", mono ? "font-mono" : ""].join(" ")}>{value}</span>
    </div>
  );
  return (
    <div className="bg-white border border-[var(--aws-border)] rounded-md p-4 mb-4 grid grid-cols-2 md:grid-cols-5 gap-4">
      {cell("Transaction No", po.transaction_no || "—", true)}
      {cell("Entity", (po.entity || "").toUpperCase() || "—", true)}
      {cell("PO Date", fmtDate(po.po_date), true)}
      {cell("PO Number", po.po_number || "—", true)}
      {cell("Vendor", po.vendor_supplier_name || "—")}
      {cell("Voucher Type", po.voucher_type || "—")}
      {cell("Lines", fmtNum(po.total_lines), true)}
      {cell("Status", po.status || "pending")}
    </div>
  );
}

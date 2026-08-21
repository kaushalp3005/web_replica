"use client";

// NPD dev-JC gate pass — an A4 Delivery Challan + Gate Pass, reproduced from the IMS
// interunit-transfer direct-out delivery challan (components/transfer/DeliveryChallan.tsx).
// A dedicated print route: the whole page IS the document, and it auto-opens the browser
// print dialog (Save as PDF) once the data loads — same mechanism as the IMS DC.
// Read-only; no inventory side effects. Reached from the "Download outpass" button.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useMe } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { buildOutpass, formatTotals, parseDispatchIds } from "@/lib/outpass";
import { getDevJobCard, type DevJobCard } from "@/lib/npd-dev";

const BURGUNDY = "#8B4049";

// Candor warehouse addresses (single source: IMS lib/constants/warehouses.ts) so the
// gate pass shows the FROM address, not just the code.
const WAREHOUSE_ADDR: Record<string, string> = {
  W202: "W-202, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400710",
  A185: "A-185, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  A101: "A-101, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  A68: "A-68, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  F53: "F53, APMC Masala Market, Sector 19, Vashi, Navi Mumbai, Maharashtra 400703",
  "D-39": "Savla D-39, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  "D-514": "Savla D-514, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  Rishi: "Rishi Cold Storage, MIDC TTC Industrial Area, Khairane, Navi Mumbai, Maharashtra 400709",
  Supreme: "Supreme Cold Storage, MIDC, Turbhe, Navi Mumbai, Maharashtra",
};

function n(v: number | string | null | undefined, dp = 3): string {
  const x = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(x)
    ? x.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : "—";
}
function qtyStr(v: number | string | null | undefined): string {
  const x = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(x) ? x.toLocaleString("en-IN") : "—";
}

export default function DevJcGatePassPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const authed = useRequireAuth(router.replace);
  const me = useMe();
  // VIEW gate, deliberately wider than canOutpass: the dispatch mail threads this DC link
  // to everyone on the request's trail (requestor / BH, npd_team, inventory_manager), so it
  // must open for them. Read-only document, no inventory side effects; ISSUING an outpass
  // from the job card is still gated on canOutpass.
  const canViewOutpass = sampleCaps(me).canViewOutpass;

  const [jc, setJc] = useState<DevJobCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Optional ?dispatch=<id> — this outpass is for that single partial out (its qty +
  // sub-number), not the full finalized output. It also accepts a COMMA-SEPARATED
  // selection (?dispatch=12,13,14): one combined challan carrying only those parts,
  // each on its own line with its own quantity. One id is just a selection of one, so
  // the existing single-part links keep working untouched.
  const [dispatchIds, setDispatchIds] = useState<number[]>([]);
  // ?merge=1 → one combined outpass listing EVERY article (each its own line), instead of
  // a single-item full/partial outpass.
  const [mergeAll, setMergeAll] = useState(false);

  // Hydration gate (SSR true vs first client false) — mirror the other pages.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const ids = parseDispatchIds(sp.get("dispatch"));
    const merge = sp.get("merge") === "1";
    if (!ids.length && !merge) return;
    // Deferred past the effect body (the house pattern here — see the `mounted` gate)
    // so the params land as one follow-up render rather than a cascade.
    queueMicrotask(() => { setDispatchIds(ids); setMergeAll(merge); });
  }, []);

  // NPD module members (npd_team, BH, inventory_manager, sales) + admin. Anyone outside
  // the module still bounces back to the job card.
  useEffect(() => {
    if (authed && me !== null && !canViewOutpass) {
      router.replace(`/modules/npd-development/job-cards/${id}`);
    }
  }, [authed, me, canViewOutpass, router, id]);

  useEffect(() => {
    if (!authed || !Number.isFinite(id)) return;
    queueMicrotask(() => {
      void getDevJobCard(id).then(setJc).catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load job card"));
    });
  }, [authed, id]);

  // Auto-open the print dialog once the document has rendered (matches IMS: 500ms).
  useEffect(() => {
    if (!jc) return;
    const t = setTimeout(() => { try { window.print(); } catch { /* ignore */ } }, 500);
    return () => clearTimeout(t);
  }, [jc]);

  if (mounted && !authed) return null;
  if (mounted && me !== null && !canViewOutpass) return null;

  if (error) {
    return <div style={{ padding: 24, fontFamily: "Arial, sans-serif", color: "#b1361e" }}>{error}</div>;
  }
  if (!jc) {
    return <div style={{ padding: 24, fontFamily: "Arial, sans-serif", color: "#666" }}>Loading outpass…</div>;
  }

  // The document itself — which lines, at which quantities, under which outpass number.
  // See lib/outpass.ts: one part, a chosen SET of parts (?dispatch=a,b,c), every article
  // (merge=1), or the card's full finalized output.
  const doc = buildOutpass({
    jcId: id,
    selectedIds: dispatchIds,
    mergeAll,
    articles: jc.articles ?? [],
    dispatches: jc.dispatches ?? [],
    fgSkuName: jc.fg_sku_name,
    title: jc.title,
    outputQty: jc.output_qty,
    outputUom: jc.output_uom,
    cardUom: jc.uom,
    dispatchRecipient: jc.dispatch_recipient,
    closedAt: jc.closed_at,
    dispatchedAt: jc.dispatched_at,
  });
  const { items, totalQty, outpassNo, date, recipient } = doc;
  // With one unit on the document the total prints as a plain figure under its own unit
  // label; with several it prints the per-unit breakdown instead, because there is no
  // single number that means anything across them (see lib/outpass sumByUom).
  const totalUnit = doc.mixedUnits ? "" : ` (${doc.totals[0]?.uom ?? "kg"})`;
  const totalCell = doc.mixedUnits ? formatTotals(doc.totals, (v) => n(v)) : qtyStr(totalQty);
  const totalAmt = (dp = 3) => doc.mixedUnits
    ? formatTotals(doc.totals, (v) => n(v, dp))
    : n(totalQty, dp);
  const toName = jc.customer_name || jc.company_name || "—";
  const toAddr = jc.customer_ship_to_address || "";
  const fromAddr = (jc.warehouse && WAREHOUSE_ADDR[jc.warehouse]) || jc.warehouse || "—";
  const expDate = jc.expected_dispatch_date ? String(jc.expected_dispatch_date).slice(0, 10) : "—";
  const reason = jc.output_notes || `NPD stock dispatch — ${outpassNo}`;
  // Promote-gate digital signatures (name + decided date) — BH = REQUESTOR_BH, Inventory
  // manager = INV_MGR. Absent for a sourceless / pre-gate card → blank signature line.
  const bh = jc.gate_signatures?.REQUESTOR_BH;
  const im = jc.gate_signatures?.INV_MGR;
  // Billing type carried (read-only) from the source requisition. Show the flags
  // that are set — Returnable / Non-returnable / Paid — but never the amount.
  const sampleType = [
    jc.returnable ? "Returnable" : null,
    jc.non_returnable ? "Non-returnable" : null,
    jc.paid ? "Paid" : null,
  ].filter(Boolean).join(" · ") || "—";

  const td: React.CSSProperties = { padding: "8px", border: "1px solid #000" };
  const cell = (extra: React.CSSProperties = {}): React.CSSProperties =>
    ({ padding: "5px 8px", border: "1px solid #000", fontSize: "10.5px", whiteSpace: "nowrap", ...extra });
  // A signature cell: a digital signature (approver name + "approved" date) when present,
  // else a blank ruled line with white space for a physical signature (e.g. Security).
  const sigCell = (label: string, p?: { name?: string | null; decided_at?: string | null }, span = 2) => (
    <td colSpan={span} style={{ padding: "8px", border: "1px solid #000", verticalAlign: "top", fontSize: "11px", height: "72px" }}>
      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>{label}</div>
      {p?.name ? (
        <>
          <div style={{ fontStyle: "italic", color: BURGUNDY, fontSize: "14px" }}>{p.name}</div>
          <div style={{ color: "#16a34a", fontSize: "10px", marginTop: "2px" }}>
            ✓ Digitally approved{p.decided_at ? ` · ${String(p.decided_at).slice(0, 10)}` : ""}
          </div>
        </>
      ) : (
        <div style={{ borderTop: "1px solid #000", marginTop: "42px" }} />
      )}
    </td>
  );
  const COLS = 5; // S.No | Item Description | Qty | UOM | Net Wt (kg)

  const printCss = `
    @media print { @page { size: A4; margin: 0; } body { margin: 0; padding: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; } * { print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; } .no-print { display: none !important; }
      /* When the item list runs past a page, move whole rows to the next page — never
         split a row across the page break. thead (logo + FROM/TO) reprints per page. */
      tr { break-inside: avoid; page-break-inside: avoid; }
    }
    @media screen { body { background: #f5f5f5; } }
  `;

  return (
    <div className="w-full bg-white dc-print-content" style={{ padding: "0.5cm 1.25cm", fontFamily: "Arial, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: printCss }} />

      {/* On-screen print bar (hidden when printing) */}
      <div className="no-print" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => window.print()}
          style={{ height: 34, padding: "0 16px", background: BURGUNDY, color: "#fff", border: 0, borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
          Print / Save as PDF
        </button>
        <button onClick={() => router.back()}
          style={{ height: 34, padding: "0 16px", background: "#fff", color: "#333", border: "1px solid #ccc", borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
          Back
        </button>
      </div>

      {/* ── DELIVERY CHALLAN ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", tableLayout: "auto", marginBottom: "20px" }}>
        <colgroup><col /><col style={{ width: "auto" }} /><col /><col /><col /></colgroup>
        <thead>
          <tr>
            <td colSpan={COLS} style={{ textAlign: "center", padding: "15px", borderBottom: "2px solid #000" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "20px" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "60px", width: "auto" }} />
                <div>
                  <div style={{ fontSize: "20px", fontWeight: "bold", color: BURGUNDY }}>CANDOR FOODS</div>
                  <div style={{ fontSize: "24px", marginTop: "6px", color: BURGUNDY, fontWeight: "bold", letterSpacing: "1px" }}>STOCK OUTPASS</div>
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td colSpan={3} style={td}><strong>Outpass No:</strong> {outpassNo}</td>
            <td colSpan={2} style={td}><strong>Date:</strong> {date}</td>
          </tr>
          <tr>
            <td colSpan={COLS} style={td}><strong>Expected dispatch date:</strong> {expDate}</td>
          </tr>
          <tr>
            <td colSpan={3} style={{ ...td, verticalAlign: "top" }}>
              <strong>FROM: Candor Foods</strong>
              {jc.warehouse && <div style={{ marginTop: "5px", fontSize: "11px", fontWeight: "bold" }}>Warehouse {jc.warehouse}</div>}
              <div style={{ color: "#666", marginTop: "3px", fontSize: "11px" }}>{fromAddr}</div>
            </td>
            <td colSpan={2} style={{ ...td, verticalAlign: "top" }}>
              <strong>TO:</strong>
              <div style={{ marginTop: "5px", fontSize: "11px", fontWeight: "bold" }}>{toName}</div>
              {toAddr && <div style={{ color: "#666", marginTop: "3px", fontSize: "11px" }}>{toAddr}</div>}
            </td>
          </tr>
          <tr>
            <td colSpan={3} style={td}><strong>Vehicle No:</strong> —</td>
            <td colSpan={2} style={td}><strong>Recipient / Driver:</strong> {recipient}</td>
          </tr>
          <tr>
            <td colSpan={COLS} style={td}><strong>Sample type:</strong> {sampleType}</td>
          </tr>
          <tr style={{ backgroundColor: "#e0e0e0" }}>
            <td style={cell({ fontWeight: "bold", textAlign: "center" })}>S.No</td>
            <td style={cell({ fontWeight: "bold", whiteSpace: "normal" })}>Item Description</td>
            <td style={cell({ fontWeight: "bold", textAlign: "center" })}>Qty</td>
            <td style={cell({ fontWeight: "bold", textAlign: "center" })}>UOM</td>
            <td style={cell({ fontWeight: "bold", textAlign: "right" })}>Net Wt (kg)</td>
          </tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={idx}>
              <td style={cell({ textAlign: "center" })}>{idx + 1}</td>
              <td style={cell({ whiteSpace: "normal", wordBreak: "break-word" })}>{it.desc}</td>
              <td style={cell({ textAlign: "center", fontWeight: "bold" })}>{qtyStr(it.qty)}</td>
              <td style={cell({ textAlign: "center" })}>{it.uom}</td>
              <td style={cell({ textAlign: "right" })}>{n(it.qty)}</td>
            </tr>
          ))}
          <tr style={{ backgroundColor: "#f0ebe3" }}>
            <td colSpan={2} style={cell({ fontWeight: "bold", textAlign: "right" })}>TOTAL ({items.length} item{items.length > 1 ? "s" : ""}):</td>
            <td style={cell({ textAlign: "center", fontWeight: "bold" })}>{totalCell}</td>
            <td style={cell()}>&nbsp;</td>
            <td style={cell({ textAlign: "right", fontWeight: "bold" })}>{totalAmt()}</td>
          </tr>
          <tr style={{ backgroundColor: "#fdf8f4" }}>
            <td colSpan={3} style={cell({ fontWeight: "bold", textAlign: "right", whiteSpace: "normal" })}>TOTAL FG{totalUnit}:</td>
            <td colSpan={2} style={cell({ textAlign: "right", fontWeight: "bold", color: BURGUNDY, fontSize: "12px" })}>{totalAmt()}</td>
          </tr>
          <tr><td colSpan={COLS} style={{ padding: "10px", border: "1px solid #000" }}><strong>Reason:</strong> {reason}</td></tr>
          <tr>
            {sigCell("Business Head (digital)", bh, 2)}
            {sigCell("Inventory Manager (digital)", im, 2)}
            {sigCell("Security Sign", undefined, 1)}
          </tr>
          <tr>
            <td colSpan={COLS} style={{ padding: "15px 10px", borderTop: "2px solid #000", textAlign: "center", fontSize: "10px", fontStyle: "italic", backgroundColor: "#f8f9fa" }}>
              This is a computer-generated stock outpass. Business head &amp; inventory manager signatures are captured digitally; the security signature is taken at the gate.
            </td>
          </tr>
        </tbody>
      </table>

      {/* ── CUT LINE ── */}
      <div style={{ margin: "20px 0", borderTop: "2px dashed #999", position: "relative" }}>
        <span style={{ position: "absolute", top: "-12px", left: "50%", transform: "translateX(-50%)", backgroundColor: "white", padding: "0 15px", fontSize: "12px", color: "#666", fontWeight: "bold" }}>✂ CUT HERE</span>
      </div>

      {/* ── OUTPASS (gate stub) ── */}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", pageBreakInside: "avoid", tableLayout: "fixed" }}>
        <colgroup><col style={{ width: "8%" }} /><col style={{ width: "40%" }} /><col style={{ width: "12%" }} /><col style={{ width: "16%" }} /><col style={{ width: "24%" }} /></colgroup>
        <thead>
          <tr>
            <td colSpan={5} style={{ textAlign: "center", padding: "10px", borderBottom: "2px solid #000", backgroundColor: "#f0f0f0" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "15px" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "50px", width: "auto" }} />
                <div style={{ fontSize: "18px", fontWeight: "bold", color: BURGUNDY }}>CANDOR FOODS - STOCK OUTPASS</div>
              </div>
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={2} style={td}><strong>Outpass No:</strong> {outpassNo}</td>
            <td colSpan={3} style={td}><strong>Date:</strong> {date}</td>
          </tr>
          <tr>
            <td colSpan={5} style={td}><strong>Expected dispatch date:</strong> {expDate}</td>
          </tr>
          <tr>
            <td colSpan={2} style={td}><strong>From:</strong> Candor Foods, {fromAddr}</td>
            <td colSpan={3} style={td}><strong>To:</strong> {toName}{toAddr ? `, ${toAddr}` : ""}</td>
          </tr>
          <tr>
            <td colSpan={5} style={td}><strong>Sample type:</strong> {sampleType}</td>
          </tr>
          <tr style={{ backgroundColor: "#f8f9fa" }}>
            <td colSpan={5} style={{ padding: "6px", border: "1px solid #000", fontWeight: "bold", textAlign: "center" }}>ITEMS SUMMARY</td>
          </tr>
          <tr style={{ backgroundColor: "#f8f9fa" }}>
            <td style={{ ...td, fontWeight: "bold", textAlign: "center" }}>S.No</td>
            <td style={{ ...td, fontWeight: "bold" }}>Item Description</td>
            <td style={{ ...td, fontWeight: "bold", textAlign: "center" }}>Qty</td>
            <td style={{ ...td, fontWeight: "bold", textAlign: "center" }}>UOM</td>
            <td style={{ ...td, fontWeight: "bold", textAlign: "right" }}>Net Wt (Kg)</td>
          </tr>
          {items.map((it, idx) => (
            <tr key={idx}>
              <td style={{ ...td, textAlign: "center" }}>{idx + 1}</td>
              <td style={td}>{it.desc}</td>
              <td style={{ ...td, textAlign: "center", fontWeight: "bold" }}>{qtyStr(it.qty)}</td>
              <td style={{ ...td, textAlign: "center" }}>{it.uom}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: "bold" }}>{n(it.qty, 2)}</td>
            </tr>
          ))}
          <tr style={{ backgroundColor: "#fdf8f4" }}>
            <td colSpan={4} style={{ ...td, fontWeight: "bold", textAlign: "right" }}>Total FG{totalUnit}:</td>
            <td style={{ ...td, textAlign: "right", fontWeight: "bold", color: BURGUNDY }}>{totalAmt(2)}</td>
          </tr>
          {/* Digital approvals captured on the promote gate */}
          <tr style={{ backgroundColor: "#f8f9fa" }}>
            <td colSpan={5} style={{ padding: "6px 8px", border: "1px solid #000", fontSize: "10px" }}>
              <strong>Digitally approved</strong> — Business Head: <span style={{ color: BURGUNDY }}>{bh?.name || "—"}</span> · Inventory Manager: <span style={{ color: BURGUNDY }}>{im?.name || "—"}</span>
            </td>
          </tr>
          <tr>
            <td colSpan={2} style={{ padding: "25px 8px 8px 8px", border: "1px solid #000", textAlign: "center" }}>
              <div style={{ borderTop: "1px solid #000", paddingTop: "5px", marginTop: "30px" }}><strong>Security Sign</strong></div>
            </td>
            <td colSpan={3} style={{ padding: "25px 8px 8px 8px", border: "1px solid #000", textAlign: "center" }}>
              <div style={{ borderTop: "1px solid #000", paddingTop: "5px", marginTop: "30px" }}><strong>Driver / Recipient Sign</strong></div>
            </td>
          </tr>
          <tr>
            <td colSpan={5} style={{ padding: "6px", border: "1px solid #000", textAlign: "center", fontSize: "10px", fontStyle: "italic", backgroundColor: "#f8f9fa" }}>
              Present this outpass at the security gate.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

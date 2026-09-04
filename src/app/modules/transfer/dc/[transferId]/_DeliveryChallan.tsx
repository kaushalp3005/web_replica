"use client";

// Printable Delivery Challan + tear-off Gate Pass (doc 10). Pure document component:
// consolidates the transfer lines and auto-fires window.print() once the letterhead has
// actually loaded. Inline styles (not Tailwind) so print fidelity + color-adjust are
// explicit. Rendered by dc/[transferId]/page.tsx.
//
// Pagination is the BROWSER's, not ours. A fixed items-per-page slice cannot know how
// tall a row is, and item descriptions wrap — ten long ones overflowed A4 with the
// overflow landing on an un-letterheaded page. One table + a <thead> that print engines
// repeat on every page break gives a correct letterhead per page at any row height.

import { useCallback, useEffect, useMemo, useRef } from "react";

interface DCItem {
  id?: number;
  item_description?: string | null;
  item_category?: string | null;
  pack_size?: string | null;
  quantity?: string | null;
  uom?: string | null;
  net_weight?: string | null;
  material_type?: string | null;
  unit_pack_size?: string | null;
  vakkal?: string | null;
}
// Only what attribution needs: which line this physical box belongs to.
interface DCBox {
  transfer_line_id?: number | null;
}
// Same, for a unit that shipped WITHOUT a scanned carton.
interface DCParkedUnit {
  transfer_line_id?: number | null;
}
type ConsolidatedItem = DCItem & { box_count: number; parked_count: number };

export interface DeliveryChallanProps {
  dcNumber: string;
  requestDate: string;
  fromWarehouse: string;
  toWarehouse: string;
  vehicleNumber: string;
  driverName: string;
  approvalAuthority: string;
  reasonDescription: string;
  items: DCItem[];
  /** The dispatch's real box rows. "No. of Boxes" counts THESE, not lines — a line is
   *  an article at a quantity, so an accepted request ships one line per article
   *  covering many boxes, and a manually-keyed line ships none at all. Counting lines
   *  put a number on the challan that contradicted "Boxes provided" on the same sheet. */
  boxes: DCBox[];
  /** Units of BOX-LESS lines, parked "In Transit" by the backend. A manually-keyed
   *  line ships without a scanned carton, so it contributes no `boxes` row and the
   *  column printed an em-dash for a vehicle carrying ten units. These are counted
   *  into "No. of Boxes" but MARKED with an asterisk: the sheet must not assert that
   *  something was scanned when nothing was. Empty on a scanned dispatch. */
  parkedUnits: DCParkedUnit[];
  totalQtyRequired: number;
  isPartial: boolean;
}

const WAREHOUSE_ADDRESSES: Record<string, { name: string; address: string }> = {
  W202: { name: "Warehouse W202", address: "W-202, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400710" },
  A185: { name: "Warehouse A185", address: "A-185, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  A101: { name: "Warehouse A101", address: "A-101, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  A68: { name: "Warehouse A68", address: "A-68, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  F53: { name: "Warehouse F53", address: "F53, APMC Masala Market, Sector 19, Vashi, Navi Mumbai, Maharashtra 400703" },
  "Savla D-39": { name: "Savla D-39 Cold Storage", address: "Savla D-39, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  "Savla D-514": { name: "Savla D-514 Cold Storage", address: "Savla D-514, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  Rishi: { name: "Rishi Cold Storage", address: "Rishi, MIDC TTC Industrial area, Khairane, Navi Mumbai, Maharashtra 400709" },
  Supreme: { name: "Supreme Cold Storage", address: "MIDC, Turbhe, Navi Mumbai" },
  "Cold Storage": { name: "Cold Storage", address: "MIDC TTC Industrial area, Khairane, Navi Mumbai" },
};

const MAROON = "#8B4049";
// Longest we will wait for the letterhead before printing anyway — a dead image URL
// must not leave the operator staring at a page that never opened the print dialog.
const PRINT_IMAGE_WAIT_MS = 3000;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
/** The "No. of Boxes" cell. A parked unit is a unit on the vehicle, not a scanned
 *  carton, so it is counted but MARKED — an unmarked number in this column reads as
 *  "we scanned this", and the gate would be verifying a claim nobody made. */
function boxCell(scanned: number, parked: number): string {
  const n = scanned + parked;
  if (n <= 0) return "—";
  return `${n.toLocaleString("en-IN")}${parked > 0 ? " *" : ""}`;
}
function isCountable(it: DCItem): boolean {
  return (it.material_type || "").toUpperCase() === "PM" || (it.item_category || "").toUpperCase() === "PACKAGING";
}
/** A UOM must NAME a unit. The backend enriches a blank line uom from all_sku.uom, which is
 *  a NUMERIC pack-weight column (0.000 / 0.250 / 1.000), so "0.000" arrives here as if it
 *  were a unit and `uom || fallback` printed the number. Test for VALID, not for empty.
 *  Returns "" when the value names no unit, which lets the render fallback do its job. */
function validUom(it: DCItem): string {
  const u = (it.uom || "").trim();
  return /[A-Za-z]/.test(u) ? u : "";
}
/** Pieces in this line. A piece count may only come from a piece count: unit_pack_size.
 *  The old `|| num(it.pack_size)` fallback multiplied KILOGRAMS by boxes when a PM line had
 *  no unit_pack_size and printed the product as pieces (transfer 1831: pack_size 15.760 kg
 *  x 15 cartons printed "Total Count (PM): 4,251.4"). null = unknown, and an unknown count
 *  is left out of the total instead of being invented. */
function itemCount(it: DCItem): number | null {
  if (!isCountable(it)) return null;
  const ups = num(it.unit_pack_size);
  // Whole numbers only: 60 PM lines carry a WEIGHT in unit_pack_size (33.580 for one carton),
  // and a fractional count of pouches is not a count.
  if (!Number.isInteger(ups) || ups <= 0) return null;
  const c = ups * num(it.quantity);
  return Number.isInteger(c) && c > 0 ? c : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
function warehouseBlock(code: string): { name: string; address: string } {
  return WAREHOUSE_ADDRESSES[code] || { name: code, address: "" };
}

export function DeliveryChallan(props: DeliveryChallanProps) {
  const { dcNumber, requestDate, fromWarehouse, toWarehouse, vehicleNumber, driverName,
    approvalAuthority, reasonDescription, items, boxes, parkedUnits, totalQtyRequired,
    isPartial } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const printedRef = useRef(false);

  const print = useCallback(() => { window.print(); }, []);

  // Auto-print once the letterhead has actually decoded. The old fixed 500ms timer fired
  // before the logo painted on a slow connection, and with no chrome on this page there
  // was no way to re-print — the operator had to reload the URL.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let cancelled = false;
    const imgs = Array.from(el.querySelectorAll("img"));
    const loaded = imgs.map((img) => img.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        img.addEventListener("load", () => resolve(), { once: true });
        img.addEventListener("error", () => resolve(), { once: true });
      }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<void>((resolve) => { timer = setTimeout(resolve, PRINT_IMAGE_WAIT_MS); });
    void Promise.race([Promise.all(loaded), fallback]).then(() => {
      if (cancelled || printedRef.current) return;
      printedRef.current = true;
      window.print();
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  // Boxes per LINE id — the authoritative link (interunit_transfer_boxes.transfer_line_id).
  const boxesByLine = useMemo(() => {
    const m = new Map<number, number>();
    for (const b of boxes) {
      if (b.transfer_line_id == null) continue;
      m.set(b.transfer_line_id, (m.get(b.transfer_line_id) || 0) + 1);
    }
    return m;
  }, [boxes]);

  // Units per LINE id for the lines that shipped without a scanned carton. The backend
  // decodes this from park_lines' synthetic "LINE-<line_id>-<n>" box_id, so it is a real
  // per-line count — NOT the line quantity, which skews when a box attributes to a
  // sibling line (the reason totalLoose below stays dispatch-level).
  const parkedByLine = useMemo(() => {
    const m = new Map<number, number>();
    for (const u of parkedUnits) {
      if (u.transfer_line_id == null) continue;
      m.set(u.transfer_line_id, (m.get(u.transfer_line_id) || 0) + 1);
    }
    return m;
  }, [parkedUnits]);

  const consolidated = useMemo<ConsolidatedItem[]>(() => {
    const map = new Map<string, ConsolidatedItem>();
    for (const it of items) {
      // Drop phantom rows before anything counts them — a blank/"N/A" description would
      // otherwise print an empty row AND inflate "TOTAL (n item(s))".
      const desc = (it.item_description || "").trim();
      if (!desc || desc.toUpperCase() === "N/A") continue;
      // pack_size and unit_pack_size both go through num() so "25" and "25.000" — the same
      // size written by two different writers — land in one row. unit_pack_size is part of
      // the key so two PM lines with different per-box counts never merge: the merge keeps
      // the first row's field, and the Count column would then stop summing to its total.
      const key = `${desc.toUpperCase()}__${(it.item_category || "").trim().toUpperCase()}__${num(it.pack_size)}__${num(it.unit_pack_size)}`;
      // Boxes are counted from box rows and NOTHING else. The old `attributedBoxes ||
      // num(it.quantity)` substituted a line quantity whenever a line had no box row, so one
      // column headed "No. of Boxes" carried scanned boxes for some rows and quantities for
      // others: transfer 1891 printed 231 for a dispatch of 78 boxes. The backend keeps the
      // two apart too — pending_items = SUM(qty) - boxes_count, so their difference is a
      // SHORTFALL, not an identity. That remainder is totalLoose below; the Qty column, which
      // is unchanged, still carries every line's own quantity.
      const attributedBoxes = it.id != null ? (boxesByLine.get(it.id) || 0) : 0;
      const attributedParked = it.id != null ? (parkedByLine.get(it.id) || 0) : 0;
      const uom = validUom(it);
      const ex = map.get(key);
      if (ex) {
        ex.quantity = String(num(ex.quantity) + num(it.quantity));
        ex.net_weight = (num(ex.net_weight) + num(it.net_weight)).toFixed(3);
        ex.box_count += attributedBoxes;
        ex.parked_count += attributedParked;
        // uom is NOT in the key (a blank one must still merge with its siblings), so the merge
        // would otherwise print the FIRST member's unit for all of them — transfer 881
        // collapses 590 lines carrying both 'BOX' and 'CARTON' into one row. Same treatment
        // unit_pack_size got: two different units never print as one.
        if (uom && ex.uom !== uom) ex.uom = ex.uom ? "MIXED" : uom;
      } else {
        map.set(key, { ...it, uom, box_count: attributedBoxes, parked_count: attributedParked });
      }
    }
    return Array.from(map.values());
  }, [items, boxesByLine, parkedByLine]);

  // Gated on the DATA alone. The old `|| /a-?68/i.test(fromWarehouse)` put a PM column and a
  // "Total Count (PM): 0" banner on transfer 1530 — 1,141 cartons out of A68 with zero PM
  // lines — while the total cell for that same figure printed "—": two cells on one sheet
  // disagreeing about one number.
  const showCount = consolidated.some(isCountable);
  const showVakkal = consolidated.some((it) => !!(it.vakkal || "").trim());
  const totalNet = consolidated.reduce((s, it) => s + num(it.net_weight), 0);
  // Round ONCE, at the row, then total the rounded rows. The gate pass prints 2 decimals, so
  // totalling the unrounded weights made its printed rows disagree with its printed total
  // (transfer 1385: 530.00 + 1,533.98 = 2,063.98 under a total cell reading 2,063.99).
  const totalNetGP = consolidated.reduce((s, it) => s + round2(num(it.net_weight)), 0);
  const totalCount = consolidated.reduce((s, it) => s + (itemCount(it) || 0), 0);
  const attributed = consolidated.reduce((s, it) => s + it.box_count, 0);
  const attributedParked = consolidated.reduce((s, it) => s + it.parked_count, 0);
  // A box carrying no transfer_line_id, or one pointing at a line that is not on this
  // transfer / was filtered out above (these tables are also written by the IMS). Given
  // its own row so the Boxes column always sums to the total instead of under-adding.
  const unattributed = useMemo(() => {
    const printedLineIds = new Set(items
      .filter((it) => { const d = (it.item_description || "").trim(); return d && d.toUpperCase() !== "N/A"; })
      .map((it) => it.id)
      .filter((v): v is number => v != null));
    return boxes.filter((b) => b.transfer_line_id == null || !printedLineIds.has(b.transfer_line_id)).length;
  }, [items, boxes]);
  // Same for parked units: one whose line was dropped as a phantom row still travelled,
  // so it keeps its own row instead of vanishing from the column's total.
  const unattributedParked = useMemo(() => {
    const printedLineIds = new Set(items
      .filter((it) => { const d = (it.item_description || "").trim(); return d && d.toUpperCase() !== "N/A"; })
      .map((it) => it.id)
      .filter((v): v is number => v != null));
    return parkedUnits.filter((u) => u.transfer_line_id == null || !printedLineIds.has(u.transfer_line_id)).length;
  }, [items, parkedUnits]);
  // Real box rows only — attributed + unattributed is every row in `boxes`, which is exactly
  // what the backend reports as boxes_count and what the GRN receives against.
  const totalBoxes = attributed + unattributed;
  // Parked units are NOT folded into totalBoxes: "Boxes provided" on the gate pass means
  // scanned cartons, and the two figures must stay separable. This is what the column adds
  // up to on the sheet — scanned plus marked-unscanned.
  const totalParked = attributedParked + unattributedParked;
  // The rest of the dispatch: units that no box covers. Derived from the two figures this
  // sheet already prints (Qty total - Boxes total), which is the backend's own pending_items.
  // Deliberately NOT a per-row column: a box row is attributed to whichever sibling line the
  // dispatch screen was on, and that line can land in a different consolidated row, so 7
  // dispatches have a row holding more boxes than its own quantity. Dispatch-level, boxes
  // never exceed quantity (0 of 1,061), so this figure is always exact.
  const totalLoose = Math.max(0, totalQtyRequired - totalBoxes);
  const cols = (showCount ? 9 : 8) + (showVakkal ? 1 : 0);
  // Gate pass: S.No / Description / [Vakkal] / Boxes / Qty / Net Wt / [Count].
  const gpCols = (showCount ? 6 : 5) + (showVakkal ? 1 : 0);

  const from = warehouseBlock(fromWarehouse);
  const to = warehouseBlock(toWarehouse);

  const td: React.CSSProperties = { border: "1px solid #000", padding: "3px 5px", fontSize: "11px" };
  const th: React.CSSProperties = { ...td, background: "#e0e0e0", fontWeight: 700, textAlign: "center" };

  const renderHeader = () => (
    <thead>
      <tr><td colSpan={cols} style={{ borderBottom: "2px solid #000", padding: "6px 0", textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "56px", margin: "0 auto", display: "block" }} />
        <div style={{ fontSize: "20px", fontWeight: 700, color: MAROON }}>CANDOR FOODS</div>
        <div style={{ fontSize: "14px", letterSpacing: "2px" }}>DELIVERY CHALLAN</div>
      </td></tr>
      <tr>
        <td colSpan={Math.ceil(cols / 2)} style={{ ...td, fontWeight: 600 }}>Transfer No: {dcNumber}</td>
        <td colSpan={Math.floor(cols / 2)} style={{ ...td, fontWeight: 600 }}>Date: {requestDate}</td>
      </tr>
      <tr>
        <td colSpan={Math.ceil(cols / 2)} style={td}>
          <div style={{ fontSize: "10px", color: "#666" }}>FROM: Candor Foods</div>
          <div style={{ fontWeight: 700 }}>{from.name}</div>
          <div style={{ fontSize: "10px", color: "#666" }}>{from.address}</div>
        </td>
        <td colSpan={Math.floor(cols / 2)} style={td}>
          <div style={{ fontSize: "10px", color: "#666" }}>TO: Candor Foods</div>
          <div style={{ fontWeight: 700 }}>{to.name}</div>
          <div style={{ fontSize: "10px", color: "#666" }}>{to.address}</div>
        </td>
      </tr>
      <tr>
        <td colSpan={Math.ceil(cols / 2)} style={td}>Vehicle No: {vehicleNumber}</td>
        <td colSpan={Math.floor(cols / 2)} style={td}>Driver Name: {driverName}</td>
      </tr>
      {showCount && (
        <tr><td colSpan={cols} style={{ ...td, background: "#fdf8f4", color: MAROON, fontWeight: 700, textAlign: "center" }}>
          Total Count (PM): {totalCount > 0 ? totalCount.toLocaleString("en-IN") : "—"}
        </td></tr>
      )}
      <tr>
        <th style={th}>S.No</th>
        <th style={{ ...th, textAlign: "left" }}>Item Description</th>
        <th style={th}>Category</th>
        {showVakkal && <th style={th}>Vakkal</th>}
        <th style={th}>No. of Boxes</th>
        <th style={th}>Qty</th>
        <th style={th}>UOM</th>
        <th style={th}>Pack Size (kg)</th>
        <th style={th}>Net Wt (kg)</th>
        {showCount && <th style={th}>Count</th>}
      </tr>
    </thead>
  );

  return (
    <>
      {/* Screen-only re-print. Sits OUTSIDE .dc-print-content, so the print stylesheet's
          `body * { visibility: hidden }` already removes it from the page. */}
      <div style={{ textAlign: "center", padding: "10px" }}>
        <button type="button" onClick={print}
          style={{ border: "1px solid #999", background: "#fff", borderRadius: 4, padding: "6px 14px", fontSize: 13, cursor: "pointer" }}>
          Print delivery challan
        </button>
      </div>

      <div ref={rootRef} className="dc-print-content" style={{ width: "100%", background: "#fff", padding: "0.5cm 1.25cm" }}>
      {/* A. Delivery Challan — ONE table; the print engine repeats <thead> (the letterhead
          and the column row) on every page it breaks onto. */}
      <div className="dc-page">
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
          {renderHeader()}
          <tbody>
            {consolidated.map((it, i) => {
              const cnt = itemCount(it);
              return (
                <tr key={i} style={{ pageBreakInside: "avoid" }}>
                  <td style={{ ...td, textAlign: "center" }}>{i + 1}</td>
                  <td style={{ ...td, wordBreak: "break-word" }}>{it.item_description}</td>
                  <td style={{ ...td, textAlign: "center" }}>{it.item_category}</td>
                  {showVakkal && <td style={{ ...td, textAlign: "center" }}>{it.vakkal || "—"}</td>}
                  <td style={{ ...td, textAlign: "center", fontWeight: 700 }}>{boxCell(it.box_count, it.parked_count)}</td>
                  <td style={{ ...td, textAlign: "center", fontWeight: 700 }}>{num(it.quantity).toLocaleString("en-IN")}</td>
                  {/* uom was validated and divergence-marked during consolidation, so this
                      `||` now falls back on an INVALID unit, not merely a blank one. */}
                  <td style={{ ...td, textAlign: "center" }}>{it.uom || (isCountable(it) ? "BOX" : "N/A")}</td>
                  {/* The header says kg, so the cell prints the kg operand: pack_size.
                      unit_pack_size is a per-box PIECE COUNT — printing it here put "1.000"
                      under a kg header for an 11.340 kg carton (transfer 1852), and pack size
                      x Qty then no longer reproduced Net Wt. The count has its own column. */}
                  <td style={{ ...td, textAlign: "center" }}>{num(it.pack_size) > 0
                    ? num(it.pack_size).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })
                    : "N/A"}</td>
                  <td style={{ ...td, textAlign: "right" }}>{num(it.net_weight).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
                  {showCount && <td style={{ ...td, textAlign: "right" }}>{cnt != null ? cnt.toLocaleString("en-IN") : "—"}</td>}
                </tr>
              );
            })}

            {unattributed + unattributedParked > 0 && (
              <tr style={{ pageBreakInside: "avoid" }}>
                <td style={{ ...td, textAlign: "center" }}>—</td>
                <td colSpan={showVakkal ? 3 : 2} style={{ ...td, fontStyle: "italic" }}>Not matched to an item line</td>
                <td style={{ ...td, textAlign: "center", fontWeight: 700 }}>{boxCell(unattributed, unattributedParked)}</td>
                <td colSpan={cols - (showVakkal ? 5 : 4)} style={td}></td>
              </tr>
            )}

            <tr style={{ background: "#f0ebe3", fontWeight: 700, pageBreakInside: "avoid" }}>
              <td colSpan={showVakkal ? 4 : 3} style={td}>TOTAL ({consolidated.length} item(s)):</td>
              <td style={{ ...td, textAlign: "center" }}>{boxCell(totalBoxes, totalParked)}</td>
              <td style={{ ...td, textAlign: "center" }}>{totalQtyRequired.toLocaleString("en-IN")}</td>
              <td style={td}></td>
              <td style={td}></td>
              <td style={{ ...td, textAlign: "right" }}>{totalNet.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
              {showCount && <td style={{ ...td, textAlign: "right" }}>{totalCount > 0 ? totalCount.toLocaleString("en-IN") : "—"}</td>}
            </tr>
            {totalParked > 0 && (
              <tr style={{ pageBreakInside: "avoid" }}><td colSpan={cols} style={{ ...td, fontSize: "10px", color: "#666" }}>
                * not scanned — counted from {totalParked.toLocaleString("en-IN")} unit(s) parked in transit for lines that shipped without a box.
              </td></tr>
            )}
            <tr style={{ pageBreakInside: "avoid" }}><td colSpan={cols} style={td}>Reason: {reasonDescription}</td></tr>
            <tr style={{ pageBreakInside: "avoid" }}><td colSpan={cols} style={{ ...td, padding: "14px 5px" }}>Auth Sign : _________________________</td></tr>
            <tr style={{ pageBreakInside: "avoid" }}><td colSpan={cols} style={{ ...td, fontStyle: "italic", textAlign: "center", color: "#666" }}>
              This is a computer-generated delivery challan. No signature required.
            </td></tr>
          </tbody>
        </table>
      </div>

      {/* B. CUT HERE */}
      <div style={{ position: "relative", borderTop: "2px dashed #999", margin: "16px 0", pageBreakBefore: "avoid" }}>
        <span style={{ position: "absolute", left: "50%", top: "-10px", transform: "translateX(-50%)", background: "#fff", padding: "0 8px", fontSize: "11px", color: "#999" }}>✂ CUT HERE</span>
      </div>

      {/* C. Gate Pass */}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", pageBreakInside: "avoid" }}>
        <tbody>
          <tr><td colSpan={gpCols} style={{ border: "1px solid #000", background: "#f0f0f0", padding: "6px", textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/candor_logo.jpg" alt="Candor Foods" style={{ height: "44px", verticalAlign: "middle", marginRight: "8px" }} />
            <span style={{ fontSize: "18px", fontWeight: 700, color: MAROON, verticalAlign: "middle" }}>CANDOR FOODS - GATE PASS</span>
          </td></tr>
          <tr>
            <td colSpan={2} style={td}>Transfer No: {dcNumber}</td>
            <td colSpan={2} style={td}>Date: {requestDate}</td>
            <td colSpan={gpCols - 4} style={td}>Vehicle: {vehicleNumber} / {driverName}</td>
          </tr>
          <tr>
            <td colSpan={gpCols - 3} style={td}>From: {from.name}</td>
            <td colSpan={3} style={td}>To: {to.name}</td>
          </tr>
          <tr><td colSpan={gpCols} style={{ ...td, background: "#fdf8f4", color: MAROON, fontWeight: 700, textAlign: "center" }}>ITEMS SUMMARY</td></tr>
          <tr>
            <th style={th}>S.No</th>
            <th style={{ ...th, textAlign: "left" }}>Item Description</th>
            {showVakkal && <th style={th}>Vakkal</th>}
            <th style={th}>Boxes</th>
            <th style={th}>Qty</th>
            <th style={th}>Net Wt (Kg)</th>
            {showCount && <th style={th}>Count</th>}
          </tr>
          {consolidated.map((it, i) => {
            const cnt = itemCount(it);
            return (
              <tr key={i}>
                <td style={{ ...td, textAlign: "center" }}>{i + 1}</td>
                <td style={{ ...td, wordBreak: "break-word" }}>{it.item_description}</td>
                {showVakkal && <td style={{ ...td, textAlign: "center" }}>{it.vakkal || "—"}</td>}
                <td style={{ ...td, textAlign: "center" }}>{boxCell(it.box_count, it.parked_count)}</td>
                <td style={{ ...td, textAlign: "center" }}>{num(it.quantity).toLocaleString("en-IN")}</td>
                <td style={{ ...td, textAlign: "right" }}>{round2(num(it.net_weight)).toFixed(2)}</td>
                {showCount && <td style={{ ...td, textAlign: "right" }}>{cnt != null ? cnt.toLocaleString("en-IN") : "—"}</td>}
              </tr>
            );
          })}
          {unattributed + unattributedParked > 0 && (
            <tr>
              <td style={{ ...td, textAlign: "center" }}>—</td>
              <td colSpan={showVakkal ? 2 : 1} style={{ ...td, fontStyle: "italic" }}>Not matched to an item line</td>
              <td style={{ ...td, textAlign: "center" }}>{boxCell(unattributed, unattributedParked)}</td>
              <td colSpan={gpCols - (showVakkal ? 4 : 3)} style={td}></td>
            </tr>
          )}
          <tr style={{ background: "#f0ebe3", fontWeight: 700 }}>
            <td colSpan={showVakkal ? 3 : 2} style={td}>Total Items: {consolidated.length}</td>
            <td style={{ ...td, textAlign: "center" }}>{boxCell(totalBoxes, totalParked)}</td>
            <td style={{ ...td, textAlign: "center" }}>{totalQtyRequired.toLocaleString("en-IN")}</td>
            <td style={{ ...td, textAlign: "right" }}>
              {totalNetGP.toFixed(2)}{" "}
              <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 3, fontSize: "10px", color: "#fff", background: isPartial ? "#c0392b" : "#27ae60" }}>
                {isPartial ? "PARTIAL" : "COMPLETE"}
              </span>
            </td>
            {showCount && <td style={{ ...td, textAlign: "right" }}>{totalCount > 0 ? totalCount.toLocaleString("en-IN") : "—"}</td>}
          </tr>
          {totalParked > 0 && (
            <tr><td colSpan={gpCols} style={{ ...td, fontSize: "10px", color: "#666" }}>
              * not scanned — counted from units parked in transit.
            </td></tr>
          )}
          <tr>
            <td colSpan={gpCols - 3} style={{ ...td, padding: "16px 5px" }}>Security Sign: ______________</td>
            <td colSpan={3} style={{ ...td, padding: "16px 5px" }}>Driver Sign: ______________</td>
          </tr>
          <tr><td colSpan={gpCols} style={{ ...td, fontSize: "10px", color: "#666", textAlign: "center" }}>
            {/* Two figures because they are two different things: boxes actually scanned, and
                the units of the lines that ship without one. Merging them had the gate
                verifying a number no part of the dispatch carried — 231 for 78 boxes. */}
            Present this gate pass at security gate • Authorized by: {approvalAuthority} • Boxes provided: {totalBoxes}{totalLoose > 0 ? ` • Loose units (no box scanned): ${totalLoose.toLocaleString("en-IN")}` : ""}
          </td></tr>
        </tbody>
      </table>

      {/* D. Print stylesheet — plain global <style> (this codebase doesn't use styled-jsx) */}
      <style dangerouslySetInnerHTML={{ __html: `
        @page { size: A4; margin: 0; }
        @media print {
          body * { visibility: hidden; }
          .dc-print-content, .dc-print-content * { visibility: visible; }
          .dc-print-content { position: absolute; top: 0; left: 0; width: 100%; }
          body, * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
        @media screen { body { background: #f5f5f5; } }
      ` }} />
      </div>
    </>
  );
}

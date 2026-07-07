# Box-wise Inward Entry — Design Spec

**Date:** 2026-06-27
**Module:** Purchase → Material In
**Status:** Approved (design), pending implementation plan

## 1. Overview

Add a **box-wise inward (PO Receiving) entry page** to the Next.js `web_replica`, replicating the Electron reference `D:\Candor_Replicas\frontend_replica\src\modules\purchase\po-receiving` (`po-receiving.js`, ~1470 lines). From the **Material In** list, each row gets a **right-arrow action** beside the view (eye) button that opens this page for that transaction.

The page lets the Stores team record receiving data for a Purchase Order: edit logistics/GRN fields, and for each PO line add **box sections** (lot groupings with mfg/exp dates), **generate boxes**, and enter **gross/net weights per box** (net auto-calculated as gross − empty-carton weight), then save.

## 2. Scope

- **Frontend-only.** The FastAPI backend (`server_replica`) already exposes all required endpoints and the DB already has all required tables/columns. **No new backend code and no new DDL are required.** (Existing DDL reproduced in §10 for confirmation; the live DB will be verified read-only before/within implementation.)
- **Printing is omitted.** The reference prints thermal barcode labels via Electron IPC + raw TSPL2 to a label printer — impossible in a browser. We omit: printer selector, per-box / per-range / per-section print buttons, TSPL generation, and the Ctrl+P / Ctrl+Shift+P print shortcuts. **Everything else is replicated.** The layout leaves room to add a print service later.

## 3. Background (verified facts)

### 3.1 Backend endpoints (mounted at `/api/v1/purchase`, [main.py:129](../../../server_replica/app/modules/purchase/router.py))
- `GET /api/v1/purchase/{transaction_no}` → `POHeaderOut`: full PO with `lines[] → sections[] → boxes[]`, plus `carton_weight` per line and all logistics/header columns. Built by `fetch_po_details` / `build_po_detail` ([queries.py](../../../server_replica/app/modules/purchase/services/queries.py)).
- `PUT /api/v1/purchase/{transaction_no}/receive` — body `StoresReceiveRequest { header: StoresHeaderUpdate?, lines: StoresLineUpdate[] }`. Updates only Stores-owned header fields (COALESCE) + each line's `carton_weight`.
- `POST /api/v1/purchase/{transaction_no}/boxes` (201) — body `AddSectionsRequest { sections: SectionInput[] }`. **Append-only**; `section_number` auto-assigned as `MAX(section_number)+1` per line. Inserts `po_section` + `po_box` rows.
- `PUT /api/v1/purchase/{transaction_no}/boxes` — body `UpdateSectionsRequest { sections: SectionUpdate[] }`. Updates existing section fields + boxes by `box_id`.
- Exact request models live in [router.py](../../../server_replica/app/modules/purchase/router.py) (`StoresHeaderUpdate`, `StoresLineUpdate`, `SectionInput`, `BoxInput`, `SectionUpdate`, `BoxUpdate`). The implementation must mirror these field names exactly.

### 3.2 Tables ([po_schema.sql](../../../server_replica/app/db/po_schema.sql))
- `po_header` — includes Stores columns: `customer_party_name, vehicle_number, transporter_name, lr_number, source_location, destination_location, challan_number, invoice_number, grn_number, system_grn_date, purchased_by, inward_authority, warehouse`.
- `po_line` — Stores column `carton_weight NUMERIC(15,3)`.
- `po_section` — `(transaction_no, line_number, section_number)` PK; `lot_number, box_count, manufacturing_date TEXT, expiry_date TEXT`.
- `po_box` — `box_id TEXT PK`; `transaction_no, line_number, section_number, box_number, net_weight, gross_weight, lot_number, count`.

### 3.3 Existing web_replica conventions
- Pages under `src/app/modules/purchase/...` as `page.tsx` + `_Component.tsx` client components.
- API clients in `src/lib/*` using `apiFetch` from `src/lib/auth.ts` (sends auth headers).
- Material In list: [material-in/page.tsx](../../src/app/modules/purchase/material-in/page.tsx) + [_MaterialInList.tsx](../../src/app/modules/purchase/material-in/_MaterialInList.tsx). Row actions live in the `ActionBtns` component (shared by desktop rows + mobile cards).

## 4. Functional requirements

1. **Arrow navigation** — A right-arrow icon button beside the view button on every Material In row (desktop + mobile) navigates to `/modules/purchase/material-in/<transaction_no>`. Existing expand/send actions unchanged.
2. **Load PO** — On page load, fetch `GET /api/v1/purchase/<txn>`; show loading, error (with retry), and not-found states.
3. **PO summary** — Read-only grid: transaction_no, entity (upper), po_date, po_number, vendor, voucher_type, gross_total, total_amount, total_lines, status.
4. **Logistics form** — Editable, pre-filled from the PO: customer/party, vehicle, transporter, LR, source, challan, invoice, GRN, GRN datetime (`datetime-local`, persisted as ISO), purchased-by, inward authority, warehouse.
5. **Line accordion** — Each PO line is a collapsible card showing read-only purchase data (SKU, matched particulars, category, type, UOM, pack_count, po_weight, rate, amount, gst_rate) and an editable **Empty Carton + Laminate (kg)** input.
6. **Existing sections** — For each existing `po_section`: editable lot_number / manufacturing_date / expiry_date; a collapsible per-box table (gross, net, lot, count) editable by `box_id`; an **Update** action (`PUT /boxes`); an **Add Boxes** panel that generates N new boxes (numbered after the section's current max) and appends them via `POST /boxes`.
7. **New sections** — **Add Section** creates a new-section card (box_count, lot, mfg, exp); **Generate Boxes** builds `box_count` in-memory box rows numbered after all existing+generated boxes for that line; rows are paginated **100 per page**; weights are editable; **Remove Section** discards it.
8. **Auto net weight** — On gross-weight input, `net = gross − line carton_weight` (clamped ≥ 0, 3 decimals). Editing carton_weight recomputes all of that line's boxes.
9. **Save** — In order: `PUT /receive` (header + lines carton_weight) → `PUT /boxes` (edited existing sections) → `POST /boxes` (new sections). Success → toast + navigate back to the list. Any step failure surfaces inline and aborts.
10. **Numeric guard** — All numeric inputs limited to 3 decimal places.

## 5. Architecture & files

```
src/lib/purchase-receive.ts                         # types + typed client (getPo, saveReceive, addBoxes, updateBoxes)
src/app/modules/purchase/material-in/[transaction_no]/
    page.tsx           # route shell — reads route param, renders <InwardEntry transactionNo=…/>
    _InwardEntry.tsx   # orchestrator — fetch, summary, logistics form, lines list, action bar, save flow, draft reducer
    _LineCard.tsx      # one line — read-only purchase grid, carton input, sections
    _SectionEditor.tsx # existing-section card + new-section card + box table + pagination
```
Modified: [_MaterialInList.tsx](../../src/app/modules/purchase/material-in/_MaterialInList.tsx) — add the arrow button to `ActionBtns` and thread an `onInward(txn)` handler (or use `useRouter` directly in the row).

## 6. API client (`src/lib/purchase-receive.ts`)

Types mirror the backend response/requests:
- `PurchaseBox { box_id, box_number, net_weight?, gross_weight?, lot_number?, count? }`
- `PurchaseSection { line_number, section_number, lot_number?, box_count?, manufacturing_date?, expiry_date?, boxes: PurchaseBox[] }`
- `PurchaseLine { line_number, sku_name?, particulars?, item_category?, item_type?, uom?, pack_count?, po_weight?, rate?, amount?, gst_rate?, carton_weight?, sections: PurchaseSection[] }`
- `PurchasePoDetail { transaction_no, entity, po_date?, po_number?, vendor_supplier_name?, voucher_type?, gross_total?, total_amount?, total_lines?, status?, <logistics fields…>, lines: PurchaseLine[] }`

Functions (all via `apiFetch`):
- `getPurchasePo(txn): Promise<PurchasePoDetail>` → `GET /api/v1/purchase/{txn}`
- `saveReceive(txn, { header, lines }): Promise<PurchasePoDetail>` → `PUT …/receive`
- `addBoxes(txn, { sections }): Promise<PurchasePoDetail>` → `POST …/boxes`
- `updateBoxes(txn, { sections }): Promise<PurchasePoDetail>` → `PUT …/boxes`

`box_id` is minted client-side like the reference: `<last-8-digits-of-Date.now()>-<index>`.

## 7. State model — single `useReducer` draft (chosen)

A top-level reducer in `_InwardEntry.tsx` holds the editable draft; sub-components are presentational and dispatch actions:
```
DraftState {
  header: Record<logisticsField, string>      // controlled logistics inputs
  cartonByLine: Record<lineNumber, string>     // editable carton weight
  existingEdits: Record<`${line}-${sectionNumber}`, { lot, mfg, exp, boxes: Record<box_id, {gross, net, lot, count}> }>
  newSections: Array<{ id, lineNumber, boxCount, lot, mfg, exp, page, boxes: Box[] | null }>
  addBoxes:    Record<`${line}-${sectionNumber}`, Box[]>   // Add-Boxes panels
}
```
Actions: setHeaderField, setCarton (recomputes line nets), addSection, removeSection, setSectionField, generateBoxes, setBoxField (recomputes net), pageBoxes, editExistingBox, generateAddBoxes, reset(after save). The reducer is pure and unit-testable. Net-weight recompute is centralized so carton/gross changes stay consistent.

Rejected alternatives: (B) many `useState` maps mirroring the reference globals — stale-closure prone; (C) per-component local state lifted at save — awkward cross-cutting auto-calc and save-time collection.

## 8. Save flow

```
onSave():
  1. PUT /receive  { header: nonEmpty(header), lines: linesWithCarton }
  2. if editedExistingSections: PUT /boxes { sections: existingUpdates }
  3. if newSections:            POST /boxes { sections: newSectionsPayload }
  4. toast success → router back to /modules/purchase/material-in
  on any error: inline error message, stop (do not advance steps)
```
Payload construction mirrors `po-receiving.js` save handler (lines 1181–1406): only carton-bearing lines included; new sections expand generated boxes (or box_count) into `po_box` records with client `box_id`s.

## 9. Cross-cutting concerns

- **Formatting helpers** reused/mirrored from `lib/po.ts` (`fmtCur`, `fmtNum`, `fmtDate`).
- **Loading / error / empty**: spinner while fetching; error card with retry; "PO not found" for 404.
- **Toasts/status**: use the per-page inline toast-banner pattern already used across web_replica (`useState<{kind:'ok'|'err'; text}>` + a rendered banner, e.g. [qc/inward-inspection/_list.tsx](../../src/app/modules/qc/inward-inspection/_list.tsx)). There is no shared toast module.
- **Accessibility**: arrow button has `aria-label="Open inward entry"`; inputs have labels.

## 10. DDL (existing — no changes needed)

The following already exist in `po_schema.sql` and are applied to the live DB via `scripts/migrate.py`. Reproduced for confirmation; **no new DDL is part of this work** (a read-only check will confirm the live DB matches before implementation):

```sql
-- po_line stores column
-- carton_weight NUMERIC(15,3)

CREATE TABLE IF NOT EXISTS po_section (
    transaction_no   TEXT NOT NULL REFERENCES po_header(transaction_no),
    line_number      INT  NOT NULL,
    section_number   INT  NOT NULL,
    lot_number       TEXT,
    box_count        INT,
    manufacturing_date TEXT,
    expiry_date      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (transaction_no, line_number, section_number),
    FOREIGN KEY (transaction_no, line_number) REFERENCES po_line(transaction_no, line_number)
);
CREATE INDEX IF NOT EXISTS idx_po_section_txn ON po_section(transaction_no);

CREATE TABLE IF NOT EXISTS po_box (
    box_id          TEXT PRIMARY KEY,
    transaction_no  TEXT NOT NULL REFERENCES po_header(transaction_no),
    line_number     INT  NOT NULL,
    section_number  INT  NOT NULL,
    box_number      INT  NOT NULL,
    net_weight      NUMERIC(15,3),
    gross_weight    NUMERIC(15,3),
    lot_number      TEXT,
    count           INT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (transaction_no, line_number, section_number)
        REFERENCES po_section(transaction_no, line_number, section_number)
);
CREATE INDEX IF NOT EXISTS idx_po_box_txn ON po_box(transaction_no);
```

## 11. Out of scope

Thermal/label printing, printer enumeration, TSPL2, print keyboard shortcuts. Any backend changes. Changes to the `/api/v1/po` (new) router.

## 12. Testing

- Unit-test the draft reducer: generateBoxes numbering (after existing + prior new sections), net = gross − carton, carton change recompute, payload builders for `/receive`, `POST /boxes`, `PUT /boxes`.
- Unit-test the API client payload shapes against the backend request models.
- Manual smoke: open a seeded PO via the arrow, add a section, generate boxes, enter weights, save, reload, confirm persistence.

## 13. Assumptions

- The legacy `/api/v1/purchase` endpoints accept the web app's `apiFetch` auth (same as `/api/v1/po`). Confirmed mounted; auth behavior to be verified in implementation.
- Navigating back to the list after save is acceptable UX (matches reference, which returns to the receipt list).

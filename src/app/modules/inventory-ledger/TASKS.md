# Inventory Ledger — Module Tasks & Sub-tasks

Tally-aligned, quantity-first stock ledger. This module is the frontend
replica of the build-preview artifact. Backend endpoints (`/api/v1/ledger/*`)
are **not built yet** — every screen renders from `_fixtures.ts` and swaps to
`LedgerApi.*` (`src/lib/ledger.ts`) when the routes land.

Status: `[x]` done in this scaffold · `[ ]` pending (mostly backend / wiring).

## 1. Module scaffold & navigation
- [x] 1.1 Register tile in `src/lib/modules.tsx` (route `inventory-ledger`, adminOnly)
- [x] 1.2 Chrome shell `_chrome.tsx` (maroon bar, breadcrumb, avatar, footer)
- [x] 1.3 Auth guard on every page (`useRequireAuth`)
- [ ] 1.4 Entity-scoped route guard (permitted CFPL/CDPL only) once roles land

## 2. Data layer
- [x] 2.1 Types + `LedgerApi` wire client + `ListEnvelope<T>` (`src/lib/ledger.ts`)
- [x] 2.2 Preview fixtures (`_fixtures.ts`) matching the Tally screens
- [x] 2.3 **Single swap seam** (`_LedgerData.tsx` provider + `layout.tsx`): the whole
      module derives from one leaf feed, sourced from FIXTURES or the LIVE backend
      (`GET /api/v1/ledger/leaves`) via a feature flag (`NEXT_PUBLIC_LEDGER_LIVE=1`) +
      a runtime Sample/Live toggle in the header. Source persists across module routes.
- [x] 2.4 Loading / error / empty states via `<LedgerGate>` (skeleton · retry banner · empty)
- [ ] 2.5 Per-view live endpoints (searchItems / stockSummary / lotsAvailable / …) — the
      typed `LedgerApi.*` methods exist; wire per-view fetches when finer-grained/paginated
      backend endpoints replace the single leaf feed

## 3. Shared UI atoms (`_ui.tsx`)
- [x] 3.1 `StatCard`, `Pill`, `UomBadge`, `SectionTabs`, `FilterChip`, `TableShell`
- [x] 3.2 Quantity-first cells (`QtyCell` bold, `ValCell` "≈ indicative")
- [x] 3.3 Export bar — Copy / Excel (`xlsx-js-style`) / CSV / Print
- [ ] 3.4 PNG snapshot (needs `html2canvas` — port from legacy) 
- [ ] 3.5 Wire real filter controls (currently display-only `FilterChip`)

## 4. Stock Summary (landing, `page.tsx` + `_StockSummary.tsx` + `_tree.ts`)
- [x] 4.1 Company KPI cards + entity toggle + `Find item`
- [x] 4.2 **Granular ledger table** — full equation columns (Opening · Inward · Consumed ·
      Produced · Returns · Outward · Transfer · Closing), DERIVED by `_tree.ts` (closings and
      every roll-up are internally consistent by construction)
- [x] 4.3 In-place drill group → sub-group → item (expand/collapse, Expand all / Collapse)
- [x] 4.4 Working filters — search, godown, UOM; sortable columns; toggleable movement columns
- [x] 4.5 Per-UOM sub-totals for mixed nodes + grand totals per UOM (never cross-summed)
- [x] 4.6 "By Group" ↔ "By Warehouse" perspective toggle
- [x] 4.7 Export (Copy/Excel/CSV) of exactly what's shown (filter + columns + expansion)
- [x] 4.8 Section tab bar (Summary · Ledger · Monthly · Batches · Ageing · FIFO · Reconcile · Registers)
- [x] 4.9 **Company-level tabs** (`_CompanyViews.tsx` + `_company.ts`) — Batches & Lots,
      Ageing, FIFO and Reconcile all DERIVED across the whole item set (not one sample
      item), each filterable / sortable / exportable:
      - Batches & Lots: union of all lots · search / godown / status filters · qty+age sort · KPIs
      - Ageing: per sub-group × UOM buckets with stacked bar · UOM + search filters
      - FIFO: all flags across items · type + search filters · KPI counts
      - Reconcile: batch vs floor per item · variance / store-gap / matched · computed KPIs

## 5. Item search (`_ItemSearch.tsx`)
- [x] 5.1 Command palette (debounced) with highlight + keyboard nav
- [x] 5.2 Pick → route into item hub with target tab
- [ ] 5.3 Global `⌘K` shortcut + top-bar mount

## 6. Group drill (`[group]/page.tsx`)
- [x] 6.1 Sub-group rollup cards
- [x] 6.2 Item table (mixed UOM, negatives shown) + per-UOM sub-totals
- [x] 6.3 "View as voucher ledger" link · Unmapped/Other bucket
- [ ] 6.4 Real `[group]/[subgroup]` nested route (currently one level + expand)

## 7. Item hub (`item/[sku]/page.tsx` + `_item.ts`)
- [x] 7.0 **Per-item resolution** — item resolved from slug; all tabs DERIVED from its
      leaf record (`_item.ts`), so numbers tie back to the Stock Summary. Graceful
      "not in sample" state for unknown slugs. (Replaces the old always-Cashew-320.)
- [x] 7.1 Header band — item_type/UOM/godown/group badges, opening/closing (negative in red)
- [x] 7.2 Vouchers tab — **granular**: direction / movement-type / counterpart filters,
      sortable columns, running balance (full-ledger position), FIFO/bridge flags, totals, export
- [x] 7.3 Monthly tab — opening + month In/Out/Closing, aggregated FROM the vouchers (always ties), export
- [x] 7.4 Batches & Lots tab — lots derived to sum to closing (or over-issue notice), godown split
- [x] 7.5 Ageing tab — buckets computed from the lots' inward dates
- [x] 7.6 FIFO tab — violations/blocks/near-expiry derived from lots+consumption (or a clean "no exceptions")
- [x] 7.7 Traceability tab — RM vs FG genealogy + box→PO chain

## 8. Grain ledger (`ledger/[grain]/[key]/page.tsx`)
- [x] 8.1 Sub-group / group voucher ledger with grain toggle
- [x] 8.2 Per-UOM running balance + totals + export

## 9. Backend (separate service — `server_replica`)
- [ ] 9.1 `/api/v1/ledger/*` endpoints (see artifact §11 / `INVENTORY_LEDGER_V2_TALLY_VIEW_PLAN.md` §9)
- [ ] 9.2 New tables (artifact §12): `warehouse_master`, `uom_master`, `opening_stock_upload`, `inventory_ledger_entry`, `closing_stock_snapshot`, `fifo_compliance_flag`
- [ ] 9.3 `v_ledger_movement` union view + co-location gate
- [ ] 9.4 Excel/CSV export routes (no pagination, filtering)

## 10. Reviews
- [x] 10.1 Manual code review pass
- [x] 10.2 Technical code review (`/code-review`)

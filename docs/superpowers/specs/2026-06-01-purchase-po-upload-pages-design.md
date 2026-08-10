# Design: Replicate Purchase / PO Upload pages into `web_replica`

**Date:** 2026-06-01
**Status:** Approved (design) — pending spec review → implementation plan

## Goal

Port the Purchase module's **PO upload** experience from the Electron app
(`frontend_replica/src/modules/purchase/po-creation/`) into the Next.js
`web_replica`, faithfully mirroring the existing `production/so-creation`
port (same chrome, caching, and API-client conventions).

Scope (confirmed with user):

1. **Purchase module landing** (`/modules/purchase`) — sub-page picker.
2. **PO Upload page** (`/modules/purchase/po-creation`) — the core: Excel
   upload → preview/commit + the "Recent purchase orders" listing.
3. **Manual PO entry page** (`/modules/purchase/po-creation/manual`).

Out of scope: vendor management, PO receiving (Stores team), material
receipt — these are separate pages not requested here.

## Constraints & key facts

- `web_replica` is Next.js with **breaking changes vs. stock Next.js**
  (`web_replica/AGENTS.md`): read `node_modules/next/dist/docs/` before
  writing Next.js code; heed deprecation notices.
- The `purchase` module is already registered in `src/lib/modules.tsx`
  (`route: "purchase"`), but `src/app/modules/purchase/` does **not exist**
  yet, and there is no purchase API client in `src/lib/`.
- API access goes through `apiFetch` (`src/lib/auth.ts`), which targets a
  **same-origin `/api/*` proxy** (declared in `next.config.ts`) — never a
  bare backend origin (per the mixed-content fix).
- The closest existing analog is `src/app/modules/production/so-creation/`
  (`page.tsx` + `_chrome.tsx` + `lib/so.ts` + `lib/so-list-cache.ts`).
- The web chrome is a horizontal **AWS-navy header + breadcrumb** (see
  `so-creation/_chrome.tsx`), NOT the Electron sidebar/titlebar — the
  Electron sidebar nav collapses into the breadcrumb + landing picker.

### Live backend contract (authoritative — the `FRONTEND_API_DOC.md` is stale)

PO upload page uses `po_router.py` (`prefix=/api/v1/po`):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/po/preview?entity=cfpl\|cdpl` | multipart Excel → parsed preview (no DB write) |
| POST | `/api/v1/po/commit` | commit selected transactions with a mode |
| GET  | `/api/v1/po` | paginated listing (search/filter/sort) |
| GET  | `/api/v1/po/{transaction_no}` | single PO detail |
| GET  | `/api/v1/po/{transaction_no}/lines` | PO lines (expandable detail) |
| DELETE | `/api/v1/po/{transaction_no}` | delete a PO |

Manual entry uses:

- `GET /api/v1/so/sku-lookup` (cascading SKU dropdowns) — **exists**
  (`so/router.py`).
- `POST /api/v1/purchase/create` — **NOT implemented** in the backend
  (the API doc marks manual creation "Future"). Decision: build the UI and
  wire to this path faithfully; the client surfaces a clear "manual create
  endpoint pending" message on 404/405 so the page is frontend-complete and
  lights up when the backend ships the route.

Commit modes (from the source page): `create_only` (skip duplicates),
`update_only` (skip new), `upsert` (create + update).

## Architecture

### File layout (mirrors `so-creation`)

```
web_replica/src/
  lib/
    po.ts            # typed PO API client (apiFetch wrapper)
    po-list-cache.ts # sessionStorage cache for the recent-PO listing
  app/modules/purchase/
    _chrome.tsx      # PurchaseChrome: navy header + breadcrumb + back-to-purchase
    page.tsx         # Landing — sub-page picker (Upload PO, Manual Entry)
    po-creation/
      page.tsx       # PO Upload page (core)
      _PreviewCard.tsx   # per-PO preview card (Step 2)
      manual/
        page.tsx     # Manual PO entry
        _LineForm.tsx    # dynamic line-item rows + cascading SKU lookup
        _LabelDialog.tsx # browser-print label rendering
```

Each unit has one clear purpose, communicates through typed props/functions,
and is testable/understandable in isolation.

### `lib/po.ts` — API client

Thin typed wrappers over `apiFetch`, one per endpoint above, plus
`createPo(payload)` for manual entry. Types mirror the backend Pydantic
response models — `PreviewResponse`, `CommitResponse`, `PoListResponse`,
`PoDetailResponse`, `PoLinesResponse`, `PoDeleteResponse` (exact field
shapes read from `server_replica/app/modules/purchase/schemas/` and
`po_router.py` during implementation). Includes shared helpers used by the
listing (date/number formatting, CSV export, `downloadBlob`), matching
`so-creation/page.tsx`.

### `lib/po-list-cache.ts`

sessionStorage snapshot of the recent-PO listing state (search, status,
advanced filters as arrays, date range, sort, page, expanded rows). Same
lazy-init / dehydrate-Sets-to-arrays pattern as `so-list-cache.ts` to avoid
request storms on rehydration.

### Pages / components

**PurchaseChrome (`_chrome.tsx`)** — copy of `SoChrome` retargeted to the
purchase breadcrumb (`Modules / Purchase / <title>`) with back-to-purchase
affordance.

**Landing (`purchase/page.tsx`)** — card-grid sub-page picker (Upload PO,
Manual Entry) styled like the production landing, inside `PurchaseChrome`.

**PO Upload (`po-creation/page.tsx`)**:

- *Entity selector* — CFPL / CDPL toggle.
- *Upload zone* — drag/drop + click, `.xlsx` only, ≤ 50 MB; calls
  `previewPo(file, entity)`.
- *Step 2 — preview/commit*: parsed summary; filter pills (All / New /
  Duplicate / With-warnings / Unmatched-lines); Select-all / Deselect-all;
  per-PO `PreviewCard` list; sticky **CommitBar** with mode radio group
  (create_only / update_only / upsert) + Commit / Cancel; in-page result
  banner (created / updated / skipped counts).
- *Recent purchase orders* listing (sibling, always visible on the landing
  state): toolbar (search, status chips, advanced multi-select filter
  panel, date-range, CSV export with column picker), sortable table,
  expandable per-line detail (via `getPoLines`), pagination, row delete.
  Reuses the `so-creation` listing mechanics: debounced search,
  AbortController-guarded fetch, cache hydration, mobile card fallback.

**Manual entry (`manual/page.tsx`)**: header fields; dynamic line items
(`_LineForm`) with cascading SKU lookup (`skuLookup`); sections/lots; box
generation. **Label printing → browser print dialog** (`_LabelDialog`
renders an HTML label and calls `window.print()`); the Electron
printer-select dropdown is replaced by a per-box / per-range Print button.
Submit → `createPo()` (graceful "backend pending" error until implemented).

## Data flow

1. Operator picks entity, drops `.xlsx` → `previewPo` → Step 2 preview state.
2. Operator filters/selects POs, picks a commit mode → `commitPo` → result
   banner → listing refresh (`listPos`).
3. Listing: state changes (search/filter/sort/page) → debounced,
   abortable `listPos`; expand a row → `getPoLines`; delete → `deletePo`.
4. Manual: cascading `skuLookup` populates dropdowns; Submit → `createPo`.

## Error handling

- Upload: reject non-`.xlsx` / > 50 MB client-side; surface 400 (bad file)
  and 409 (duplicate) inline.
- Commit: show created/updated/skipped from `CommitResponse`; surface
  failures in the result banner.
- Listing: AbortController cancels stale requests; error + empty states.
- Numeric nulls: never coerce `null` → `0` (per API doc null-handling).
- Manual create: 404/405 → explicit "manual create endpoint not yet
  available on the backend" message; form state preserved.

## Sequencing (4 phases, each independently verifiable)

- **Phase 0 — Foundation:** `lib/po.ts`, `lib/po-list-cache.ts`,
  `_chrome.tsx`.
- **Phase 1 — Landing:** `purchase/page.tsx`.
- **Phase 2 — PO Upload page (core):** `po-creation/page.tsx` +
  `_PreviewCard.tsx`.
- **Phase 3 — Manual entry:** `manual/page.tsx` + `_LineForm.tsx` +
  `_LabelDialog.tsx`.

## Verification

- `next build` and ESLint pass (confirm scripts in `package.json` during
  planning).
- Manual smoke via the `/run` flow against the local backend: upload a PO
  workbook, preview, commit, browse/filter/sort/export the listing, expand a
  row, run the manual form (expecting the documented "create pending" error).
- Read `node_modules/next/dist/docs/` before writing Next.js code.

## Open items deferred to planning/implementation

- Exact backend response field shapes for `po.ts` types (read from
  `po_router.py` + `schemas/`).
- Confirm `package.json` scripts / any test harness.
- Confirm the manual-entry `create` payload shape from
  `manual-entry.js` so the wired client matches the source.

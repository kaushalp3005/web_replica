# Purchase / PO Upload Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replicate the Electron Purchase "PO Upload" experience (landing → Excel upload/preview/commit + recent-PO listing → manual PO entry) into the Next.js `web_replica`, mirroring the existing `production/so-creation` port.

**Architecture:** A typed PO API client (`lib/po.ts`) over the same-origin `apiFetch` proxy, a sessionStorage listing cache (`lib/po-list-cache.ts`), and shared `PurchaseChrome`. Three route pages under `app/modules/purchase/`: landing, `po-creation` (upload/preview/commit + listing), and `po-creation/manual`. Built bottom-up in 4 phases.

**Tech Stack:** Next.js 16.2.6 (App Router, RSC — but these are `"use client"` pages), React 19, TypeScript 5, Tailwind CSS v4. No test harness exists in this repo.

---

## Testing reality & verification gate (read first)

This repo has **no unit-test framework** (`package.json` scripts are only `dev`, `build`, `start`, `lint`; the analogous `so-creation` page ships with no tests). Adding a test harness would be unilateral restructuring outside this task's scope. Therefore each task's verification gate is:

```bash
cd web_replica
npx tsc --noEmit        # typecheck — must report no errors in touched files
npm run lint            # eslint (eslint-config-next) — must pass
```

and, for the page-level tasks, a **manual smoke check** via the `/run` flow against the local backend (`server_replica` on `127.0.0.1:8000`, proxied through Next's `/api/*`). Commit after each task.

**Before writing any Next.js code**, per `web_replica/AGENTS.md`: skim the relevant guide under `web_replica/node_modules/next/dist/docs/` (this Next version has breaking changes vs. stock). In particular confirm the current `"use client"`, `useRouter` (from `next/navigation`), and metadata conventions match what the existing `so-creation/page.tsx` uses — follow the existing file as the source of truth.

## Conventions to mirror (source-of-truth files)

- API client shape → `web_replica/src/lib/so.ts`
- Listing cache → `web_replica/src/lib/so-list-cache.ts`
- Page chrome → `web_replica/src/app/modules/production/so-creation/_chrome.tsx`
- Landing grid → `web_replica/src/app/modules/production/page.tsx`
- Listing page mechanics (debounced search, AbortController fetch, cache hydrate, Toolbar/Pagination/mobile-card) → `web_replica/src/app/modules/production/so-creation/page.tsx`
- PO preview/commit behavior → `frontend_replica/src/modules/purchase/po-creation/po-creation.js`
- PO listing behavior → `frontend_replica/src/shared/js/po-view.js`
- Manual entry behavior → `frontend_replica/src/modules/purchase/po-creation/manual-entry.js`

## Backend contract (authoritative — from `server_replica/app/modules/purchase/po_router.py` + `schemas/po_api.py`)

Base prefix `/api/v1/po`:

- `POST /preview?entity=cfpl|cdpl` — multipart `file`; returns `PreviewResponse { summary: { total_pos, new, duplicates, matched_lines, unmatched_lines }, pos: PreviewPo[] }`. `PreviewPo { is_duplicate, duplicate_key, transaction_no, header: PreviewHeader, incoming, existing?, diff?, lines: PreviewLine[], warnings: string[] }`. Round-trip preserves extra fields (`extra="allow"`).
- `POST /commit` — body `{ entity, mode: "create_only"|"update_only"|"upsert", pos: CommitPo[] }`; `CommitPo { duplicate_key?, transaction_no?, header: object, lines: object[], incoming? }`. Returns `CommitResponse { created: string[], updated: string[], skipped_duplicates: string[], skipped_missing: string[], errors: { po_number?, transaction_no?, duplicate_key?, reason }[] }`.
- `GET ""` (i.e. `/api/v1/po`) — query params below; returns `PoListResponse { total, page, page_size, total_pages, has_next, has_prev, items: PoListItem[] }`.
- `GET /{transaction_no}` — `PoDetailResponse { header: PoListItem }`.
- `GET /{transaction_no}/lines` — `PoLinesResponse { header: PoListItem, total_lines, lines: PoLineOut[] }`.
- `DELETE /{transaction_no}?reason=...` (reason required, min_length 1) — `PoDeleteResponse { transaction_no, entity, po_number, deleted_at, deleted_by, delete_reason, dependent_records: { dock_arrivals, grns, po_boxes } }`.

`GET /api/v1/po` query params: `page` (≥1), `page_size` (1–200, default 20), `sort` (`"<col>:<dir>"`, default `po_date:desc`; whitelisted cols incl. `po_date, po_number, transaction_no, voucher_type, order_reference_no, vendor_supplier_name, supplier_id, entity, gross_total, total_amount, sgst_amount, cgst_amount, igst_amount, round_off, ...`), `entity` (`cfpl|cdpl`), equality (`transaction_no, po_number, voucher_type, order_reference_no, supplier_id, vendor_supplier_name`), contains (`po_number_contains, order_reference_no_contains, vendor_supplier_name_contains, narration_contains`), date range (`po_date_from, po_date_to` as `YYYY-MM-DD`), numeric ranges (`*_min`/`*_max`), `include_deleted` (bool).

`PoListItem` / `PoLineOut` field shapes: see `schemas/po_api.py` lines 137–204 — all header money/charge fields are `float | null`; lines carry `line_number, sku_name, uom, pack_count, po_weight, rate, amount, particulars, item_category, sub_category, item_type, sales_group, gst_rate, match_score, match_source`.

**Manual create:** `POST /api/v1/purchase/create` is **NOT implemented** in the backend (no route in `router.py`). The client wires to it faithfully (matching `manual-entry.js`) and surfaces a clear "pending" message on 404/405.

**Export:** `web_replica` has **no xlsx dependency**. Export is implemented as **CSV** (mirroring `so-creation`'s `buildExportCsv`), not the Electron page's `.xlsx`. Columns mirror `po-view.js EXPORT_COLUMNS` (21 columns).

---

## File structure

| File | Responsibility |
|------|----------------|
| `web_replica/src/lib/po.ts` | Typed PO API client + shared formatters/CSV helpers. |
| `web_replica/src/lib/po-list-cache.ts` | sessionStorage snapshot of the recent-PO listing state. |
| `web_replica/src/app/modules/purchase/_chrome.tsx` | `PurchaseChrome`: navy header + breadcrumb + back. |
| `web_replica/src/app/modules/purchase/page.tsx` | Landing (sub-page picker). |
| `web_replica/src/app/modules/purchase/po-creation/page.tsx` | PO Upload page (entity, upload, preview/commit, listing). |
| `web_replica/src/app/modules/purchase/po-creation/_preview.tsx` | Preview/commit UI (summary, filter pills, PO cards, commit bar, result). |
| `web_replica/src/app/modules/purchase/po-creation/_listing.tsx` | Recent-PO toolbar + table + expand detail + delete modal + pagination + CSV export. |
| `web_replica/src/app/modules/purchase/po-creation/manual/page.tsx` | Manual PO entry form. |
| `web_replica/src/app/modules/purchase/po-creation/manual/_LineForm.tsx` | One line item row with cascading SKU lookup. |
| `web_replica/src/app/modules/purchase/po-creation/manual/_LabelDialog.tsx` | Browser-print label rendering. |

---

# PHASE 0 — Foundation

## Task 0.1: PO API client `lib/po.ts`

**Files:**
- Create: `web_replica/src/lib/po.ts`

- [ ] **Step 1: Write `lib/po.ts`** — types mirror the backend schemas; functions wrap `apiFetch` exactly like `lib/so.ts`.

```ts
// PO (Purchase Order) client. Mirrors the Electron renderer's
// frontend_replica/src/shared/js/po-view.js + po-creation.js. All endpoints
// under /api/v1/po except manual create (/api/v1/purchase/create, pending).

import { apiFetch } from "./auth";

// ── Listing / detail types (schemas/po_api.py: PoListItem, PoLineOut) ──
export interface PoListItem {
  transaction_no: string;
  entity: string;
  po_number?: string | null;
  po_date?: string | null;
  voucher_type?: string | null;
  order_reference_no?: string | null;
  narration?: string | null;
  vendor_supplier_name?: string | null;
  supplier_id?: string | null;
  gross_total?: number | null;
  total_amount?: number | null;
  sgst_amount?: number | null;
  cgst_amount?: number | null;
  igst_amount?: number | null;
  round_off?: number | null;
  freight_transport_local?: number | null;
  apmc_tax?: number | null;
  packing_charges?: number | null;
  freight_transport_charges?: number | null;
  loading_unloading_charges?: number | null;
  other_charges_non_gst?: number | null;
  deleted_at?: string | null;
}

export interface PoLineOut {
  transaction_no: string;
  line_number: number;
  sku_name?: string | null;
  uom?: string | null;
  pack_count?: number | null;
  po_weight?: number | null;
  rate?: number | null;
  amount?: number | null;
  particulars?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  item_type?: string | null;
  sales_group?: string | null;
  gst_rate?: number | null;
  match_score?: number | null;
  match_source?: string | null;
  matched_item?: { sku_code?: string | null } & Record<string, unknown>;
}

export interface PoListResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  has_next: boolean;
  has_prev: boolean;
  items: PoListItem[];
}
export interface PoLinesResponse {
  header: PoListItem;
  total_lines: number;
  lines: PoLineOut[];
}
export interface PoDeleteResponse {
  transaction_no: string;
  entity: string;
  po_number?: string | null;
  deleted_at: string;
  deleted_by: string;
  delete_reason: string;
  dependent_records: { dock_arrivals: number; grns: number; po_boxes: number };
}

// ── Preview / commit types (schemas/po_api.py) ──
export interface PreviewHeader {
  po_number?: string | null;
  po_date?: string | null;
  voucher_type?: string | null;
  order_reference_no?: string | null;
  narration?: string | null;
  vendor_supplier_name?: string | null;
  supplier_id?: string | null;
  gross_total?: number | null;
  total_amount?: number | null;
  sgst_amount?: number | null;
  cgst_amount?: number | null;
  igst_amount?: number | null;
  round_off?: number | null;
  [k: string]: unknown; // extra='allow' round-trip
}
export interface PreviewLine {
  line_number: number;
  sku_name?: string | null;
  uom?: string | null;
  pack_count?: number | null;
  po_weight?: number | null;
  rate?: number | null;
  amount?: number | null;
  gst_rate?: number | null;
  match_score?: number | null;
  match_source?: string | null;
  matched_item?: ({ sku_code?: string | null } & Record<string, unknown>) | null;
  [k: string]: unknown;
}
export interface PreviewPo {
  is_duplicate: boolean;
  duplicate_key: string;
  transaction_no: string;
  header: PreviewHeader;
  incoming: Record<string, unknown>;
  existing?: PreviewHeader | null;
  diff?: Record<string, unknown> | null;
  lines: PreviewLine[];
  warnings: string[];
  [k: string]: unknown;
}
export interface PreviewSummary {
  total_pos: number;
  new: number;
  duplicates: number;
  matched_lines: number;
  unmatched_lines: number;
}
export interface PreviewResponse { summary: PreviewSummary; pos: PreviewPo[] }

export type CommitMode = "create_only" | "update_only" | "upsert";
export interface CommitPo {
  duplicate_key?: string | null;
  transaction_no?: string | null;
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
  incoming?: Record<string, unknown> | null;
}
export interface CommitResponse {
  created: string[];
  updated: string[];
  skipped_duplicates: string[];
  skipped_missing: string[];
  errors: { po_number?: string | null; transaction_no?: string | null; duplicate_key?: string | null; reason: string }[];
}

// ── Listing query ──
export interface PoListQuery {
  page?: number;
  page_size?: number;
  sort?: string; // "<col>:<dir>"
  entity?: string;
  po_number_contains?: string;
  vendor_supplier_name_contains?: string;
  order_reference_no_contains?: string;
  narration_contains?: string;
  supplier_id?: string;
  voucher_type?: string;
  po_date_from?: string;
  po_date_to?: string;
}

function toQuery(q: PoListQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === "" || v == null) continue;
    p.set(k, String(v));
  }
  return p.toString();
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const d = body?.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof d.message === "string") return d.message;
  } catch { /* ignore */ }
  return `${fallback} (HTTP ${res.status})`;
}

// ── Endpoints ──
export async function previewPo(file: File, entity: string): Promise<PreviewResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(`/api/v1/po/preview?entity=${encodeURIComponent(entity)}`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(await readError(res, "Preview failed"));
  return res.json();
}

export async function commitPo(body: { entity: string; mode: CommitMode; pos: CommitPo[] }): Promise<CommitResponse> {
  const res = await apiFetch(`/api/v1/po/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Commit failed"));
  return res.json();
}

export async function listPos(q: PoListQuery, signal?: AbortSignal): Promise<PoListResponse> {
  const res = await apiFetch(`/api/v1/po?${toQuery(q)}`, { signal });
  if (!res.ok) throw new Error(await readError(res, "Failed to load POs"));
  return res.json();
}

export async function getPoLines(transactionNo: string): Promise<PoLinesResponse> {
  const res = await apiFetch(`/api/v1/po/${encodeURIComponent(transactionNo)}/lines`);
  if (!res.ok) throw new Error(await readError(res, "Failed to load articles"));
  return res.json();
}

export async function deletePo(transactionNo: string, reason: string): Promise<PoDeleteResponse> {
  const res = await apiFetch(`/api/v1/po/${encodeURIComponent(transactionNo)}?reason=${encodeURIComponent(reason)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res, "Delete failed"));
  return res.json();
}

// Manual create — backend route pending. Mirrors manual-entry.js payload.
export async function createPo(payload: Record<string, unknown>): Promise<unknown> {
  const res = await apiFetch(`/api/v1/purchase/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 404 || res.status === 405) {
    throw new Error("Manual PO creation isn't available yet — the backend create endpoint is not implemented.");
  }
  if (!res.ok) throw new Error(await readError(res, "Failed to create PO"));
  return res.json();
}

// ── SKU lookup (so/router.py: GET /api/v1/so/sku-lookup) ──
export interface SkuLookupResponse {
  options: {
    item_types: string[];
    particulars: string[];
    item_groups: string[];
    sub_groups: string[];
    sales_groups: string[];
  };
  selected_item: {
    sku_id: number; particulars: string; item_type: string; item_group: string;
    sub_group: string; uom: number; sale_group: string; gst: number;
  } | null;
}
export async function skuLookup(params: Record<string, string>): Promise<SkuLookupResponse> {
  const qs = new URLSearchParams(params).toString();
  const res = await apiFetch(`/api/v1/so/sku-lookup${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(await readError(res, "SKU lookup failed"));
  return res.json();
}

// ── Shared formatters (mirror po-view.js) ──
export function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const p = String(d).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0].slice(2)}` : String(d);
}
export function fmtCur(n?: number | string | null): string {
  if (n == null || n === "") return "—";
  const v = typeof n === "number" ? n : parseFloat(n);
  if (Number.isNaN(v)) return "—";
  return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtNum(n?: number | string | null): string {
  if (n == null || n === "") return "—";
  const v = typeof n === "number" ? n : parseFloat(n);
  if (Number.isNaN(v)) return "—";
  return v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

// ── CSV export (mirror po-view.js EXPORT_COLUMNS, 21 cols; CSV not xlsx) ──
export const PO_EXPORT_COLUMNS: { key: keyof PoListItem; label: string }[] = [
  { key: "transaction_no", label: "Transaction No" },
  { key: "po_number", label: "PO Number" },
  { key: "po_date", label: "PO Date" },
  { key: "voucher_type", label: "Voucher Type" },
  { key: "order_reference_no", label: "Order Ref" },
  { key: "narration", label: "Narration" },
  { key: "vendor_supplier_name", label: "Vendor" },
  { key: "supplier_id", label: "Supplier ID" },
  { key: "entity", label: "Entity" },
  { key: "gross_total", label: "Gross Total" },
  { key: "total_amount", label: "Total Amount" },
  { key: "sgst_amount", label: "SGST" },
  { key: "cgst_amount", label: "CGST" },
  { key: "igst_amount", label: "IGST" },
  { key: "round_off", label: "Round Off" },
  { key: "freight_transport_local", label: "Freight (Local)" },
  { key: "freight_transport_charges", label: "Freight Charges" },
  { key: "apmc_tax", label: "APMC Tax" },
  { key: "packing_charges", label: "Packing" },
  { key: "loading_unloading_charges", label: "Loading/Unloading" },
  { key: "other_charges_non_gst", label: "Other Non-GST" },
];

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}
export function buildPoCsv(items: PoListItem[], cols: { key: keyof PoListItem; label: string }[]): string {
  const rows = [cols.map((c) => csvCell(c.label)).join(",")];
  for (const it of items) rows.push(cols.map((c) => csvCell(it[c.key])).join(","));
  return "﻿" + rows.join("\r\n");
}
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Page through /api/v1/po collecting all matching items for export (cap 5000).
export async function fetchAllPosForExport(q: PoListQuery): Promise<PoListItem[]> {
  const all: PoListItem[] = [];
  let page = 1;
  const HARD = 5000;
  while (all.length < HARD) {
    const data = await listPos({ ...q, page, page_size: 200 });
    all.push(...data.items);
    if (!data.has_next || data.items.length === 0) break;
    page++;
  }
  return all;
}
```

- [ ] **Step 2: Verify**

```bash
cd web_replica && npx tsc --noEmit && npm run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web_replica/src/lib/po.ts
git commit -m "feat(purchase): add PO API client (lib/po.ts)"
```

## Task 0.2: Listing cache `lib/po-list-cache.ts`

**Files:**
- Create: `web_replica/src/lib/po-list-cache.ts`

- [ ] **Step 1: Write the cache** (mirror `so-list-cache.ts`, PO-specific shape):

```ts
// Listing state cache for /modules/purchase/po-creation. Mirrors
// lib/so-list-cache.ts: tab-scoped sessionStorage entry preserving filters,
// sort, pagination, and expanded rows. Drains on sign-out.

import { registerOnSignOut } from "./auth";
import { sessionLoad, sessionSave, sessionClear } from "./session-state";

const KEY = "po-creation.list-state";

export interface PoListCache {
  search: string;                 // → po_number_contains
  entity: "" | "cfpl" | "cdpl";
  dateFrom: string;
  dateTo: string;
  adv: {                          // the five advanced fields from po-view.js
    vendor_supplier_name_contains: string;
    order_reference_no_contains: string;
    narration_contains: string;
    supplier_id: string;
    voucher_type: string;
  };
  sort: string;                   // "<col>:<dir>"
  page: number;
  expanded: string[];             // transaction_no list
}

export function loadPoListCache(): PoListCache | null { return sessionLoad<PoListCache>(KEY); }
export function savePoListCache(v: PoListCache): void { sessionSave<PoListCache>(KEY, v); }
export function clearPoListCache(): void { sessionClear(KEY); }

if (typeof window !== "undefined") {
  registerOnSignOut(clearPoListCache);
}
```

- [ ] **Step 2: Verify** — confirm `sessionLoad/Save/Clear` and `registerOnSignOut` signatures match by opening `web_replica/src/lib/session-state.ts` and `web_replica/src/lib/auth.ts`. Then:

```bash
cd web_replica && npx tsc --noEmit && npm run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web_replica/src/lib/po-list-cache.ts
git commit -m "feat(purchase): add PO listing sessionStorage cache"
```

## Task 0.3: `PurchaseChrome`

**Files:**
- Create: `web_replica/src/app/modules/purchase/_chrome.tsx`

- [ ] **Step 1: Write the chrome** (copy of `so-creation/_chrome.tsx`, retargeted breadcrumb):

```tsx
"use client";

// Shared header/footer chrome for Purchase sub-pages. Navy bar, breadcrumb
// (Modules / Purchase / <title>), avatar, and footer — mirrors SoChrome.

import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { useUserInitial } from "@/lib/user";

export interface PurchaseChromeProps {
  title: string;
  children: React.ReactNode;
}

export function PurchaseChrome({ title, children }: PurchaseChromeProps) {
  const router = useRouter();
  const initial = useUserInitial();

  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          {title === "Purchase" ? (
            <span className="text-white">Purchase</span>
          ) : (
            <>
              <button onClick={() => router.push("/modules/purchase")} className="hover:underline">Purchase</button>
              <span>/</span>
              <span className="text-white">{title}</span>
            </>
          )}
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile" title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">{children}</main>

      <footer className="border-t border-[var(--aws-border)] bg-white py-3 px-6 text-[11px] text-[var(--text-secondary)] flex flex-wrap justify-center gap-x-4 gap-y-1">
        <a href="#" className="hover:underline">Privacy</a>
        <span>© {new Date().getFullYear()}</span>
      </footer>
    </div>
  );
}
```

- [ ] **Step 2: Verify** — confirm `BrandMark` and `useUserInitial` export names against `so-creation/_chrome.tsx` (it imports the same). Then `npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web_replica/src/app/modules/purchase/_chrome.tsx
git commit -m "feat(purchase): add PurchaseChrome"
```

---

# PHASE 1 — Landing

## Task 1.1: Purchase landing page

**Files:**
- Create: `web_replica/src/app/modules/purchase/page.tsx`

- [ ] **Step 1: Write the landing** — card grid via `PurchaseChrome`, mirroring `production/page.tsx`'s card pattern. Only the two in-scope sub-pages are `implemented: true`.

```tsx
"use client";

// Purchase module landing. Mirrors production/page.tsx card pattern.
// Only PO Upload + Manual Entry are implemented on the web today.

import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "./_chrome";

type SubModule = { title: string; description: string; route: string; implemented: boolean };

const SUB_MODULES: SubModule[] = [
  { title: "PO Upload", description: "Upload a PO workbook (.xlsx), preview SKU matches and duplicates, then commit. Browse, filter, and export existing purchase orders.", route: "/modules/purchase/po-creation", implemented: true },
  { title: "Manual Entry", description: "Create a purchase order by hand — header, line items with SKU lookup, lots, and box weights.", route: "/modules/purchase/po-creation/manual", implemented: true },
];

export default function PurchaseLandingPage() {
  const router = useRouter();
  useRequireAuth(router.replace);

  return (
    <PurchaseChrome title="Purchase">
      <div className="mb-3">
        <BackLink parentHref="/modules" label="modules" />
      </div>
      <div className="mb-6">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Purchase</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Upload and review purchase orders, or create one manually.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {SUB_MODULES.map((m) => (
          <button
            key={m.route}
            onClick={() => router.push(m.route)}
            className="text-left bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-4 transition hover:border-[var(--aws-navy)] hover:shadow-[0_2px_6px_rgba(0,28,36,0.18)]"
          >
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-1">{m.title}</h3>
            <p className="text-[12px] text-[var(--text-secondary)]">{m.description}</p>
          </button>
        ))}
      </div>
    </PurchaseChrome>
  );
}
```

- [ ] **Step 2: Verify** — confirm the `modules.tsx` Purchase entry routes to `/modules/purchase` (open `web_replica/src/lib/modules.tsx`; the entry has `route: "purchase"` which the modules grid turns into `/modules/purchase` — confirm the grid's link construction so this page is reachable). Then:

```bash
cd web_replica && npx tsc --noEmit && npm run lint && npm run build
```
Expected: build succeeds; `/modules/purchase` compiles.

- [ ] **Step 3: Manual smoke** — via `/run`: sign in, open Modules → Purchase, confirm the landing renders two cards and back-link works.

- [ ] **Step 4: Commit**

```bash
git add web_replica/src/app/modules/purchase/page.tsx
git commit -m "feat(purchase): add module landing page"
```

---

# PHASE 2 — PO Upload page

This page has three regions that mirror `po-creation.js` + `po-view.js`: (A) entity selector + upload zone, (B) preview/commit (`_preview.tsx`), (C) recent-PO listing (`_listing.tsx`). The page component owns mode state (`landing` vs `preview`) and renders the listing under the upload zone on the landing, hiding it during preview (exactly as `setBrowseVisible` does in `po-creation.js`).

## Task 2.1: Recent-PO listing component `_listing.tsx`

**Files:**
- Create: `web_replica/src/app/modules/purchase/po-creation/_listing.tsx`

Mirror `so-creation/page.tsx`'s Toolbar + table + Pagination + mobile-card structure, with these PO-specific deltas (do NOT copy SO filter semantics):

- **Search** → `po_number_contains` (debounced 300 ms, resets page to 1, clears expanded). Reuse the so-creation search-debounce `useEffect` pattern.
- **Entity chips**: `All entities` (`entity=""`), `CFPL` (`entity="cfpl"`), `CDPL` (`entity="cdpl"`). Same chip styling as so-creation status chips.
- **Advanced filter panel**: five plain text inputs keyed exactly as `po-view.js ADV_FIELDS` — `vendor_supplier_name_contains`, `order_reference_no_contains`, `narration_contains`, `supplier_id`, `voucher_type`. Apply-on-Enter / Apply button; Clear button. Active count badge.
- **Date range**: `po_date_from` / `po_date_to`, client guard `from <= to`, same popover as so-creation.
- **Export**: dropdown with "Direct — all columns" and "Selective — choose columns" (checkbox list of `PO_EXPORT_COLUMNS`); both call `fetchAllPosForExport(query)` → `buildPoCsv` → `downloadBlob(..., \`po-export-<ISO date>.csv\`)`.
- **Sort**: clicking a `data-sort` header toggles `"<col>:<dir>"` (`asc`↔`desc`, default new col `asc`); use the whitelist from `po.ts`. Columns: PO Number (`po_number`), Date (`po_date`), Vendor (`vendor_supplier_name`), Voucher (`voucher_type`), Order Ref (`order_reference_no`), Entity (`entity`), Amount (`gross_total`).
- **Rows**: chevron + the 7 columns above + a View (toggle expand) and Delete action. Row click toggles expand. Mirror `po-view.js renderTable`.
- **Expand detail**: on expand, call `getPoLines(transaction_no)` (cache per txn in a `Map` held in a `useRef`), render the header-detail grid (8 info fields + 12 money fields via `fmtCur`) + an article table (line_number, SKU, UOM, pack_count, po_weight, rate, amount, gst_rate) with an in-panel SKU filter. Mirror `po-view.js renderExpandPanel`/`renderHeaderDetails`/`renderArticleTable`.
- **Delete**: open a modal collecting a required `reason`, then `deletePo(txn, reason)`; on success toast `Deleted <po_number> (<po_boxes> boxes retained)` and refetch. Mirror `po-view.js handleDelete` + `_openDeleteModal` (React state modal, not `window.prompt`).
- **Pagination**: 7-button window, "Showing s–e of total POs". Mirror `po-view.js renderPagination`.

**Props/interface** (the page owns the query state + cache; the listing is controlled):

```tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type PoListItem, type PoListQuery, type PoLineOut,
  listPos, getPoLines, deletePo, fetchAllPosForExport,
  buildPoCsv, downloadBlob, fmtDate, fmtCur, fmtNum, PO_EXPORT_COLUMNS,
} from "@/lib/po";

export interface PoListingHandle { refresh: () => void }

export interface PoListingProps {
  query: PoListQuery;                       // controlled query (entity, contains, dates, sort, page)
  onQueryChange: (patch: Partial<PoListQuery>) => void;
  search: string;                           // raw search box value (debounced into query by parent)
  onSearch: (v: string) => void;
  expanded: Set<string>;
  onToggleExpand: (txn: string) => void;
  reloadKey: number;                        // bump to force a refetch (after commit)
}
```

- [ ] **Step 1: Implement `_listing.tsx`** following the deltas above. Use a single fetch `useEffect` keyed on a stable fingerprint of `query` + `reloadKey` (string-join the query like so-creation's `advKey`), guarded by `AbortController`. Hold `articleCache` and `_fetchController` in `useRef`. Render loading/empty/error states identical in spirit to so-creation's `SoTable`.

  > Reproduce the so-creation Toolbar/Pagination/mobile-card JSX verbatim where structurally identical, swapping only labels, query keys, and columns per the deltas above. The full reference markup is `so-creation/page.tsx` lines 689–878 (Toolbar), 880–982 (Advanced panel), 1038–1091 (table). Keep the same Tailwind class strings so the visual language matches.

- [ ] **Step 2: Verify**

```bash
cd web_replica && npx tsc --noEmit && npm run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web_replica/src/app/modules/purchase/po-creation/_listing.tsx
git commit -m "feat(purchase): recent-PO listing (toolbar, table, expand, delete, export)"
```

## Task 2.2: Preview/commit component `_preview.tsx`

**Files:**
- Create: `web_replica/src/app/modules/purchase/po-creation/_preview.tsx`

Mirror `po-creation.js` lines 134–727. The component receives a `PreviewResponse` and a per-PO editable working copy, manages selection/expansion/edits in local state, and calls back on commit.

```tsx
"use client";
import { useMemo, useState } from "react";
import {
  type PreviewResponse, type PreviewPo, type PreviewLine,
  type CommitMode, type CommitResponse, type CommitPo,
  commitPo, fmtNum,
} from "@/lib/po";

export interface PreviewProps {
  fileName: string;
  entity: string;
  preview: PreviewResponse;
  onCancel: () => void;       // re-upload / cancel → back to upload zone
  onCommitted: (r: CommitResponse) => void;  // parent shows result + refreshes listing
}
```

Behavior to replicate:

- **Working state**: copy `preview.pos` into local state, each augmented with `_selected:true`, `_expanded:false`, `_diffOpen:false`. Header/line cell edits mutate the working copy (numeric fields parsed via a `toNum` helper: `rate, amount, po_weight, pack_count, gst_rate, line_number`).
- **Summary strip**: five cards (Total POs / New / Duplicates / Matched lines / Unmatched lines) from `preview.summary` via `fmtNum`.
- **Filter pills**: `all | new | duplicate | warning | unmatched`. Predicate exactly per `po-creation.js poMatchesFilter` (unmatched = any line with no `matched_item` or `match_score < 0.6`).
- **Bulk select/none** over the *visible* (filtered) POs.
- **PO card**: badges (New/Duplicate · update, N warnings, N unmatched), meta (PO number, supplier, date, lines, txn), expand toggle, editable header grid (po_number, po_date[type=date], delivery_date[type=date], supplier_name, remarks) and editable lines table (#, SKU, UOM, Pack, Weight, Rate, Amount, GST%, Match badge with `>=0.85 good / >=0.6 fair / else poor`), warnings list, and (duplicates only) a diff panel rendered from `po.diff` per `diffPanelHTML` (`{before/after}` or `{old/new}` shapes, header + lines).
- **Commit bar**: mode radio group (`create_only`/`update_only`/`upsert`), live stats (`N selected (x new, y duplicate)` + skip hint), Commit button disabled when 0 selected.
- **Commit**: build `{ entity, mode, pos: selected.map(stripMeta) }` where `stripMeta` drops the `_selected/_expanded/_diffOpen` keys (keep all backend fields incl. `header`, `lines`, `duplicate_key`, `transaction_no`, `incoming`), call `commitPo`, then `onCommitted(result)`.

- [ ] **Step 1: Implement `_preview.tsx`** per the above, as React components (PreviewCard, LinesTable, DiffPanel, CommitBar) with state lifted to the `_preview` root. Use the same Tailwind visual language as so-creation's cards/buttons (white card, `--aws-border`, navy/orange accents).

- [ ] **Step 2: Verify** `npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web_replica/src/app/modules/purchase/po-creation/_preview.tsx
git commit -m "feat(purchase): PO preview/commit UI"
```

## Task 2.3: PO Upload page `po-creation/page.tsx`

**Files:**
- Create: `web_replica/src/app/modules/purchase/po-creation/page.tsx`

Owns: auth gate, entity state, upload state, preview state, listing query/search/expanded state (hydrated from `po-list-cache`), and a `reloadKey` bumped after commit. Renders within `PurchaseChrome title="Purchase Order Upload"`.

```tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../_chrome";
import { previewPo, type PreviewResponse, type CommitResponse, type PoListQuery } from "@/lib/po";
import { loadPoListCache, savePoListCache } from "@/lib/po-list-cache";
import { PoPreview } from "./_preview";
import { PoListing } from "./_listing";
```

Behavior:

- **Entity selector** CFPL/CDPL (default `cfpl`).
- **Upload zone**: drag/drop + click, `.xlsx` only (reject others + >50 MB with an inline message), on file → `previewPo(file, entity)` → set preview state → switch to `mode="preview"` (hide listing). Mirror so-creation's `UploadZone` JSX for the dropzone visuals.
- **Preview mode**: render `<PoPreview>`; `onCancel` returns to landing; `onCommitted(result)` shows an in-page result banner (created/updated/skipped/errors KPIs per `po-creation.js showCommitResult`), returns to landing, and bumps `reloadKey` so the listing refetches.
- **Listing**: render `<PoListing>` on the landing; debounce `search` → `query.po_number_contains` (300 ms); persist the full listing state to `po-list-cache` on change and hydrate from it on mount (lazy `useState` init, Sets→arrays, same anti-loop pattern as so-creation lines 220–307).
- **Header**: `BackLink parentHref="/modules/purchase" label="Purchase"`, title + subtitle ("Drop a PO workbook (.xlsx) — preview SKU matches and diffs, edit, then commit").

- [ ] **Step 1: Implement `po-creation/page.tsx`** wiring the three regions. Default `query`: `{ sort: "po_date:desc", page: 1, entity: "" }` merged with cache.

- [ ] **Step 2: Verify**

```bash
cd web_replica && npx tsc --noEmit && npm run lint && npm run build
```
Expected: build succeeds.

- [ ] **Step 3: Manual smoke** via `/run` against the local backend:
  1. Open `/modules/purchase/po-creation` — listing loads.
  2. Pick CFPL, drop a `.xlsx` PO workbook — preview appears with summary + cards.
  3. Toggle filter pills, deselect one PO, pick a mode, Commit — result banner shows counts; listing refreshes.
  4. Search a PO number, toggle entity chips, sort a column, open advanced filters, set a date range, export CSV (file downloads).
  5. Expand a row — articles load; Delete a PO with a reason — row clears.

- [ ] **Step 4: Commit**

```bash
git add web_replica/src/app/modules/purchase/po-creation/page.tsx
git commit -m "feat(purchase): PO upload page (entity, upload, preview/commit, listing)"
```

---

# PHASE 3 — Manual PO entry

Mirrors `manual-entry.js`. Submit posts the payload from `manual-entry.js` lines 968–1023 to `createPo` (errors gracefully until the backend ships the route). Label printing uses a browser print dialog.

## Task 3.1: Line-item form `_LineForm.tsx`

**Files:**
- Create: `web_replica/src/app/modules/purchase/po-creation/manual/_LineForm.tsx`

A single line row with cascading SKU lookup. Internal line model (mirrors `manual-entry.js` `lines[]`):

```tsx
export interface ManualLine {
  skuId: number | null;     // set when a master particular is chosen
  skuName: string;
  itemType: string; itemGroup: string; subGroup: string; salesGroup: string;
  uom: string;
  packCount: string; poWeight: string; rate: string; amount: string; gstRate: string;
  sgst: string; cgst: string; igst: string;
}
export const EMPTY_LINE: ManualLine = {
  skuId: null, skuName: "", itemType: "", itemGroup: "", subGroup: "",
  salesGroup: "", uom: "", packCount: "", poWeight: "", rate: "", amount: "",
  gstRate: "", sgst: "", cgst: "", igst: "",
};
```

Cascading behavior (mirror `manual-entry.js` sku-lookup usage): four dropdowns (`item_type` → `item_group` → `sub_group` → `particulars`) each call `skuLookup({...selected})` and repopulate options; choosing a `particulars` calls `skuLookup({ particulars })` and fills `skuId, uom, gstRate, itemGroup, subGroup, itemType, salesGroup` from `selected_item`; recompute `poWeight = packCount × uom` when packCount or uom changes.

- [ ] **Step 1: Implement `_LineForm.tsx`** as a controlled component: `{ line: ManualLine; onChange: (l: ManualLine) => void; onRemove: () => void }`. Lazy-load top-level `item_types` on mount via `skuLookup({})`.

- [ ] **Step 2: Verify** `npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web_replica/src/app/modules/purchase/po-creation/manual/_LineForm.tsx
git commit -m "feat(purchase): manual-entry line form with cascading SKU lookup"
```

## Task 3.2: Browser-print label dialog `_LabelDialog.tsx`

**Files:**
- Create: `web_replica/src/app/modules/purchase/po-creation/manual/_LabelDialog.tsx`

Replaces the Electron TSPL/printer IPC with a browser print. Renders one label per box into a hidden, print-only container and calls `window.print()`. Label fields mirror `manual-entry.js generateTSPL` inputs: `transaction_no, entity, sku_name, box_id, box_number, net_weight, gross_weight`.

```tsx
"use client";
export interface LabelData {
  transaction_no: string; entity: string; sku_name: string;
  box_id: string; box_number: number;
  net_weight: number | null; gross_weight: number | null;
}
export function printLabels(labels: LabelData[]): void {
  const w = window.open("", "_blank", "width=480,height=640");
  if (!w) return;
  const rows = labels.map((l) => `
    <div class="lbl">
      <div class="lbl-h">${l.entity.toUpperCase()} · ${l.transaction_no}</div>
      <div class="lbl-sku">${l.sku_name}</div>
      <div class="lbl-meta">Box ${l.box_number} · ${l.box_id}</div>
      <div class="lbl-w">Net ${l.net_weight ?? "—"} kg · Gross ${l.gross_weight ?? "—"} kg</div>
    </div>`).join("");
  w.document.write(`<!doctype html><html><head><title>Labels</title><style>
    .lbl{width:50mm;padding:4mm;border:1px solid #000;margin:2mm;page-break-inside:avoid;font-family:monospace}
    .lbl-sku{font-weight:bold;font-size:12pt;margin:2mm 0}
    @media print{.lbl{border:none}}
  </style></head><body>${rows}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}
```

- [ ] **Step 1: Implement `_LabelDialog.tsx`** exporting `printLabels`. (No raw-printer selection — browser print dialog only, per design decision.)

- [ ] **Step 2: Verify** `npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web_replica/src/app/modules/purchase/po-creation/manual/_LabelDialog.tsx
git commit -m "feat(purchase): browser-print label dialog for manual entry"
```

## Task 3.3: Manual entry page `manual/page.tsx`

**Files:**
- Create: `web_replica/src/app/modules/purchase/po-creation/manual/page.tsx`

Owns: header fields (`entity, po_date[default today], po_number, voucher_type, order_reference_no, vendor_supplier_name`), an array of `ManualLine`, and per-line sections (`{ box_count, lot_number, mfg_date, exp_date }`) with generated boxes (`{ box_number, net_weight, gross_weight, lot_number, count }`). Renders within `PurchaseChrome title="Manual Entry"`.

ID generation (mirror `FRONTEND_API_DOC.md` + `manual-entry.js`):

```tsx
function generateTransactionNo(entity: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${entity.toUpperCase()}-TR-${ts}`; // matches manual-entry.js generateTransactionNo(entity)
}
```

Submit (mirror `manual-entry.js` 968–1030): build the payload (transaction_no, entity, header fields, `lines[]` each with `line_number=i+1`, the SKU fields, numeric parses, `match_score=skuId?1.0:null`, `match_source=skuId?"all_sku":null`, and `sections[]` with `boxes[]` using `box_id = \`${last8epoch}-${n}\``), compute header totals (`total_amount`, `sgst/cgst/igst_amount`, `gross_total`), then `await createPo(payload)`. On success toast + return to `/modules/purchase/po-creation`; on the pending-endpoint error, surface the message inline and keep form state.

- [ ] **Step 1: Implement `manual/page.tsx`** with: validate (entity, po_number, ≥1 line with a SKU), add/remove line (`_LineForm`), per-line section editor + "Generate boxes" (creates `box_count` rows) + per-box weight inputs + Print (calls `printLabels` with generated `box_id`s), and Submit. Use `useRequireAuth`.

- [ ] **Step 2: Verify**

```bash
cd web_replica && npx tsc --noEmit && npm run lint && npm run build
```
Expected: build succeeds.

- [ ] **Step 3: Manual smoke** via `/run`:
  1. Open `/modules/purchase/po-creation/manual`.
  2. Fill header; add a line; cascade-pick a SKU (dropdowns filter; uom/gst auto-fill; po_weight computes).
  3. Add a section, generate boxes, enter weights, click Print → browser print dialog shows labels.
  4. Submit → expect the "manual PO creation isn't available yet" message (backend route pending), with form state preserved.

- [ ] **Step 4: Commit**

```bash
git add web_replica/src/app/modules/purchase/po-creation/manual/page.tsx
git commit -m "feat(purchase): manual PO entry page (header, lines, sections, print, submit)"
```

---

## Final verification

- [ ] `cd web_replica && npx tsc --noEmit && npm run lint && npm run build` — all green.
- [ ] Full manual walkthrough of all three pages via `/run` against the live backend.
- [ ] Confirm cost-metric gate is N/A here (PO amounts are Purchase-team data, not shop-floor cost metrics) — no extra suppression needed.

## Self-review notes (spec coverage)

- Landing → Task 1.1. PO upload (entity/upload/preview/commit) → Tasks 2.2–2.3. Recent-PO listing (search/filter/sort/export/paginate/expand/delete) → Task 2.1. Manual entry (form/SKU lookup/sections/boxes/print/submit) → Tasks 3.1–3.3. API client + cache + chrome → Phase 0.
- Browser-print decision → Task 3.2. `/create` pending decision → `createPo` (Task 0.1) + Task 3.3 smoke step 4.
- Export adapted to CSV (no xlsx dep) → Task 0.1 + Task 2.1; noted explicitly.
- Type consistency: `PoListQuery`, `PreviewPo`, `CommitPo`, `ManualLine`, `LabelData`, `PoListingProps`, `PreviewProps` are defined once and referenced consistently.
- Known deviation from TDD: no test harness exists in the repo; verification is typecheck + lint + build + manual smoke (stated up front).

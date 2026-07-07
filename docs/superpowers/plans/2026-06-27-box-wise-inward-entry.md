# Box-wise Inward Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a box-wise inward (PO Receiving) entry page to `web_replica`, reached by a new right-arrow action on each Material In row, replicating the Electron reference `po-receiving` minus printing.

**Architecture:** Frontend-only. A typed client (`purchase-receive.ts`) wraps the existing `/api/v1/purchase/{txn}`, `/receive`, `/boxes` endpoints. A pure logic module (`_boxEngine.ts`) holds the editable-draft reducer + box-generation/net-calc/payload builders. Client React components under `material-in/[transaction_no]/` render the page (summary, logistics form, per-line accordion with box sections). Backend and DB are unchanged.

**Tech Stack:** Next.js 16 (modified — see `web_replica/AGENTS.md`), React 19, TypeScript 5, Tailwind 4, `apiFetch` from `@/lib/auth`.

## Global Constraints

- **Modified Next.js:** Before writing routing/server code, consult `node_modules/next/dist/docs/` per `web_replica/AGENTS.md`. Dynamic routes in this project are **client components** that read params via `useParams<{...}>()` from `next/navigation` (see `production/plan-list/[planId]/page.tsx`). Do **not** use async `params`.
- **No test runner exists** (`package.json` scripts: `dev`, `build`, `start`, `lint`; Node v20.17 cannot run TS directly). Per-task verification is: `npx tsc --noEmit` (typecheck) + `npm run lint` + the functional/manual checks stated in each task. Do **not** add a test framework.
- **Auth/data:** all backend calls go through `apiFetch(path, init?)` from `@/lib/auth` (relative paths like `/api/v1/purchase/...`). Mirror error handling from `@/lib/po.ts` (`readError`).
- **Toast pattern:** per-page inline banner via `useState<{kind:'ok'|'err'; text:string}|null>` (see `qc/inward-inspection/_list.tsx`). No shared toast module.
- **Reference source of truth:** `D:\Candor_Replicas\frontend_replica\src\modules\purchase\po-receiving\po-receiving.js` (+ `index.html`). Replicate behavior faithfully; **omit** all printing (printer `<select>`, print buttons, `generateTSPL`, `ipcRenderer`, Ctrl+P/Ctrl+Shift+P).
- **Backend request models are authoritative:** field names must match `server_replica/app/modules/purchase/router.py` (`StoresHeaderUpdate`, `StoresLineUpdate`, `StoresReceiveRequest`, `SectionInput`, `BoxInput`, `AddSectionsRequest`, `SectionUpdate`, `BoxUpdate`, `UpdateSectionsRequest`). Verify these names in Task 1.
- **Numeric inputs:** cap at 3 decimal places (reference lines 1408–1420).
- **Per-task review gate (your explicit requirement):** every task ends with (a) a **functional code review** — a reviewer subagent confirms the change faithfully replicates the cited reference behavior and meets the spec, exercising the flow / reasoning through the logic; and (b) a **manual code review** — a reviewer subagent checks bugs, edge cases, types, and quality. Findings are addressed before commit.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/lib/purchase-receive.ts` (create) | Types for PO detail + box payloads; client fns `getPurchasePo`, `saveReceive`, `addBoxes`, `updateBoxes`. |
| `src/app/modules/purchase/material-in/[transaction_no]/_boxEngine.ts` (create) | Pure: `DraftState`, `initDraft`, `inwardReducer`, box-number/net helpers, payload builders. No React/JSX imports. |
| `src/app/modules/purchase/material-in/[transaction_no]/page.tsx` (create) | Client route shell: read `transaction_no` param, auth guard, render `<InwardEntry>`. |
| `src/app/modules/purchase/material-in/[transaction_no]/_InwardEntry.tsx` (create) | Orchestrator: fetch PO, `useReducer(inwardReducer)`, summary grid, logistics form, lines list, action bar, save flow, toast. |
| `src/app/modules/purchase/material-in/[transaction_no]/_LineCard.tsx` (create) | One PO line: accordion, read-only purchase grid, carton input, hosts `<SectionEditor>`. |
| `src/app/modules/purchase/material-in/[transaction_no]/_SectionEditor.tsx` (create) | Existing-section cards (edit + Update + Add Boxes) and new-section cards (Generate Boxes, paginated table, Remove). |
| `src/app/modules/purchase/material-in/_MaterialInList.tsx` (modify) | Add right-arrow inward action to `ActionBtns` (desktop + mobile). |

---

## Task 1: Purchase-receive API client + types

**Files:**
- Create: `src/lib/purchase-receive.ts`
- Reference for field names: `server_replica/app/modules/purchase/router.py`, `services/queries.py` (`build_po_detail`)

**Interfaces:**
- Produces (consumed by Tasks 2,3,4,7,8,9,10):
  - Types: `PurchaseBox`, `PurchaseSection`, `PurchaseLine`, `PurchasePoDetail`, `ReceiveHeader`, `ReceiveLine`, `ReceiveRequest`, `BoxInputPayload`, `AddSectionPayload`, `AddBoxesRequest`, `UpdateBoxPayload`, `UpdateSectionPayload`, `UpdateBoxesRequest`.
  - Fns: `getPurchasePo(txn: string, signal?: AbortSignal): Promise<PurchasePoDetail>`, `saveReceive(txn: string, body: ReceiveRequest): Promise<PurchasePoDetail>`, `addBoxes(txn: string, body: AddBoxesRequest): Promise<PurchasePoDetail>`, `updateBoxes(txn: string, body: UpdateBoxesRequest): Promise<PurchasePoDetail>`.

- [ ] **Step 1: Verify backend field names.** Read `router.py` classes `StoresHeaderUpdate`, `StoresLineUpdate`, `SectionInput`, `BoxInput`, `SectionUpdate`, `BoxUpdate`, and confirm the GET response shape from `build_po_detail` (`queries.py`). Confirm the type fields below match exactly; fix any mismatch.

- [ ] **Step 2: Write the client file.**

```ts
// Typed client for the legacy Stores receiving endpoints (/api/v1/purchase/*).
// Mirrors po-receiving.js network calls. See router.py for request models.
import { apiFetch } from "./auth";

export interface PurchaseBox {
  box_id: string;
  box_number: number;
  net_weight?: number | null;
  gross_weight?: number | null;
  lot_number?: string | null;
  count?: number | null;
}
export interface PurchaseSection {
  line_number: number;
  section_number: number;
  lot_number?: string | null;
  box_count?: number | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  boxes: PurchaseBox[];
}
export interface PurchaseLine {
  transaction_no: string;
  line_number: number;
  sku_name?: string | null;
  particulars?: string | null;
  item_category?: string | null;
  sub_category?: string | null;
  item_type?: string | null;
  uom?: string | null;
  pack_count?: number | null;
  po_weight?: number | null;
  rate?: number | null;
  amount?: number | null;
  gst_rate?: number | null;
  carton_weight?: number | null;
  status?: string | null;
  sections: PurchaseSection[];
}
export interface PurchasePoDetail {
  transaction_no: string;
  entity: string;
  po_date?: string | null;
  po_number?: string | null;
  voucher_type?: string | null;
  vendor_supplier_name?: string | null;
  gross_total?: number | null;
  total_amount?: number | null;
  status?: string | null;
  total_lines?: number | null;
  total_boxes?: number | null;
  customer_party_name?: string | null;
  vehicle_number?: string | null;
  transporter_name?: string | null;
  lr_number?: string | null;
  source_location?: string | null;
  challan_number?: string | null;
  invoice_number?: string | null;
  grn_number?: string | null;
  system_grn_date?: string | null;
  purchased_by?: string | null;
  inward_authority?: string | null;
  warehouse?: string | null;
  lines: PurchaseLine[];
}

export interface ReceiveHeader {
  customer_party_name?: string | null;
  vehicle_number?: string | null;
  transporter_name?: string | null;
  lr_number?: string | null;
  source_location?: string | null;
  challan_number?: string | null;
  invoice_number?: string | null;
  grn_number?: string | null;
  system_grn_date?: string | null;
  purchased_by?: string | null;
  inward_authority?: string | null;
  warehouse?: string | null;
}
export interface ReceiveLine { line_number: number; carton_weight?: number | null; }
export interface ReceiveRequest { header?: ReceiveHeader | null; lines: ReceiveLine[]; }

export interface BoxInputPayload {
  box_id: string;
  box_number: number;
  net_weight?: number | null;
  gross_weight?: number | null;
  lot_number?: string | null;
  count?: number | null;
}
export interface AddSectionPayload {
  line_number: number;
  box_count?: number | null;
  lot_number?: string | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  boxes: BoxInputPayload[];
}
export interface AddBoxesRequest { sections: AddSectionPayload[]; }

export interface UpdateBoxPayload {
  box_id: string;
  box_number?: number | null;
  net_weight?: number | null;
  gross_weight?: number | null;
  lot_number?: string | null;
  count?: number | null;
}
export interface UpdateSectionPayload {
  line_number: number;
  section_number: number;
  lot_number?: string | null;
  box_count?: number | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  boxes: UpdateBoxPayload[];
}
export interface UpdateBoxesRequest { sections: UpdateSectionPayload[]; }

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const d = body?.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof d.message === "string") return d.message;
  } catch { /* ignore */ }
  return `${fallback} (HTTP ${res.status})`;
}

export async function getPurchasePo(txn: string, signal?: AbortSignal): Promise<PurchasePoDetail> {
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}`, { signal });
  if (!res.ok) throw new Error(await readError(res, "Failed to load Purchase Order"));
  return res.json();
}
export async function saveReceive(txn: string, body: ReceiveRequest): Promise<PurchasePoDetail> {
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/receive`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to save receiving data"));
  return res.json();
}
export async function addBoxes(txn: string, body: AddBoxesRequest): Promise<PurchasePoDetail> {
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/boxes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to add boxes"));
  return res.json();
}
export async function updateBoxes(txn: string, body: UpdateBoxesRequest): Promise<PurchasePoDetail> {
  const res = await apiFetch(`/api/v1/purchase/${encodeURIComponent(txn)}/boxes`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to update boxes"));
  return res.json();
}
```

- [ ] **Step 3: Typecheck + lint.** Run `npx tsc --noEmit` (Expected: no errors) and `npx eslint src/lib/purchase-receive.ts` (Expected: clean).
- [ ] **Step 4: Functional code review.** Reviewer subagent confirms: every type field maps to a real backend response/request field (cross-check `router.py` + `queries.py`); endpoint paths/methods match `po-receiving.js` (GET `/{txn}`, PUT `/receive`, POST/PUT `/boxes`).
- [ ] **Step 5: Manual code review.** Reviewer subagent checks error handling, nullability, and DRY vs `lib/po.ts`. Address findings.
- [ ] **Step 6: Commit.** `git add src/lib/purchase-receive.ts && git commit -m "feat(purchase): typed client for stores receiving + box endpoints"`

---

## Task 2: Pure box engine + reducer

**Files:**
- Create: `src/app/modules/purchase/material-in/[transaction_no]/_boxEngine.ts`
- Reference behavior: `po-receiving.js` lines 305–517 (sections/generate), 1128–1173 (net calc), 1242–1391 (save payload building), 460–505 (box numbering).

**Interfaces:**
- Consumes: types from `@/lib/purchase-receive`.
- Produces (consumed by Tasks 3,5,6,7,8,9,10):
  - Types: `DraftBox`, `NewSection`, `ExistingBoxEdit`, `ExistingSectionEdit`, `AddBoxesDraft`, `DraftState`, `InwardAction`.
  - Consts: `LOGISTICS_FIELDS: readonly string[]`, `BOXES_PER_PAGE = 100`.
  - Fns: `initDraft(po: PurchasePoDetail): DraftState`; `inwardReducer(state: DraftState, action: InwardAction): DraftState`; `existingKey(line: number, section: number): string`; `countExistingBoxes(line: PurchaseLine): number`; `clamp3(v: string): string`; `buildReceiveRequest(state, po): ReceiveRequest`; `buildAddSections(state, po, nowMs): AddSectionPayload[]`; `buildUpdateSections(state, po): UpdateSectionPayload[]`; `buildAddBoxesPayload(state, po, line, sectionNumber, nowMs): AddSectionPayload`.

- [ ] **Step 1: Define state types + constants.**

```ts
import type {
  PurchasePoDetail, PurchaseLine, ReceiveRequest, AddSectionPayload, UpdateSectionPayload,
} from "@/lib/purchase-receive";

export const BOXES_PER_PAGE = 100;

// Stores-owned logistics fields (header). datetime stored as the raw <input> value.
export const LOGISTICS_FIELDS = [
  "customer_party_name", "vehicle_number", "transporter_name", "lr_number",
  "source_location", "challan_number", "invoice_number", "grn_number",
  "system_grn_date", "purchased_by", "inward_authority", "warehouse",
] as const;
export type LogisticsField = (typeof LOGISTICS_FIELDS)[number];

// Inputs are kept as strings (controlled inputs); parsed to numbers in builders.
export interface DraftBox { box_number: number; gross_weight: string; net_weight: string; lot_number: string; count: string; }
export interface NewSection {
  id: string; line_number: number; box_count: string; lot_number: string;
  mfg_date: string; exp_date: string; page: number; boxes: DraftBox[] | null;
}
export interface ExistingBoxEdit { gross_weight: string; net_weight: string; lot_number: string; count: string; }
export interface ExistingSectionEdit {
  lot_number: string; manufacturing_date: string; expiry_date: string;
  boxes: Record<string, ExistingBoxEdit>; // keyed by box_id
}
export interface AddBoxesDraft { boxes: DraftBox[]; }

export interface DraftState {
  header: Record<LogisticsField, string>;
  cartonByLine: Record<number, string>;
  existing: Record<string, ExistingSectionEdit>;  // key = existingKey(line, section_number)
  newSections: NewSection[];
  addBoxes: Record<string, AddBoxesDraft>;        // key = existingKey(line, section_number)
}

export function existingKey(line: number, section: number): string { return `${line}-${section}`; }
```

- [ ] **Step 2: Helpers — counts, clamp, net calc.**

```ts
export function countExistingBoxes(line: PurchaseLine): number {
  return (line.sections ?? []).reduce((sum, s) => sum + (s.boxes?.length ?? 0), 0);
}
// Cap a numeric string to 3 decimals (reference 1408–1420). Empty stays empty.
export function clamp3(v: string): string {
  if (!v) return v;
  const dot = v.indexOf(".");
  if (dot === -1) return v;
  return v.length - dot - 1 > 3 ? String(parseFloat(parseFloat(v).toFixed(3))) : v;
}
// net = gross - carton, >= 0, 3 decimals. Empty gross => empty net.
export function computeNet(gross: string, carton: string): string {
  if (!gross) return "";
  const g = parseFloat(gross); const c = carton ? parseFloat(carton) : 0;
  if (Number.isNaN(g)) return "";
  const n = g - c;
  return n > 0 ? String(parseFloat(n.toFixed(3))) : "";
}
```

- [ ] **Step 3: `initDraft` — seed header + existing-section edits from the PO.**

```ts
export function initDraft(po: PurchasePoDetail): DraftState {
  const header = {} as Record<LogisticsField, string>;
  for (const f of LOGISTICS_FIELDS) {
    const raw = (po as Record<string, unknown>)[f];
    // GRN datetime → value for <input type=datetime-local> (slice to minutes)
    header[f] = f === "system_grn_date" && typeof raw === "string" ? raw.slice(0, 16) : (raw == null ? "" : String(raw));
  }
  const cartonByLine: Record<number, string> = {};
  const existing: DraftState["existing"] = {};
  for (const line of po.lines ?? []) {
    cartonByLine[line.line_number] = line.carton_weight != null ? String(line.carton_weight) : "";
    for (const sec of line.sections ?? []) {
      const boxes: Record<string, ExistingBoxEdit> = {};
      for (const b of sec.boxes ?? []) {
        boxes[b.box_id] = {
          gross_weight: b.gross_weight != null ? String(b.gross_weight) : "",
          net_weight: b.net_weight != null ? String(b.net_weight) : "",
          lot_number: b.lot_number ?? "",
          count: b.count != null ? String(b.count) : "",
        };
      }
      existing[existingKey(line.line_number, sec.section_number)] = {
        lot_number: sec.lot_number ?? "",
        manufacturing_date: sec.manufacturing_date ?? "",
        expiry_date: sec.expiry_date ?? "",
        boxes,
      };
    }
  }
  return { header, cartonByLine, existing, newSections: [], addBoxes: {} };
}
```

- [ ] **Step 4: Reducer + actions.** Implement `InwardAction` and `inwardReducer` covering: `setHeader`, `setCarton` (recompute that line's new-section + existing nets), `addSection`, `removeSection`, `setNewSectionField`, `generateBoxes`, `setNewBoxField` (recompute net), `setNewSectionPage`, `setExistingSectionField`, `setExistingBoxField` (recompute net), `genAddBoxes`, `setAddBoxField`, `clearAddBoxes`, `reset`. Box numbering for new sections (reference 480–505): `start = countExistingBoxes(line) + (boxes already generated in this line's other new sections) + 1`. Add-boxes numbering (reference 1028–1045): after the section's current max box_number. Provide the full implementation; keep it pure (no `Date`, no React). Where a `box_number` base or timestamp is needed, it is passed in by the caller (builders take `nowMs`).

```ts
export type InwardAction =
  | { type: "setHeader"; field: LogisticsField; value: string }
  | { type: "setCarton"; line: number; value: string }
  | { type: "addSection"; line: number; id: string }
  | { type: "removeSection"; id: string }
  | { type: "setNewSectionField"; id: string; field: "box_count" | "lot_number" | "mfg_date" | "exp_date"; value: string }
  | { type: "generateBoxes"; id: string; line: PurchaseLine }
  | { type: "setNewBoxField"; id: string; boxIndex: number; field: keyof DraftBox; value: string; carton: string }
  | { type: "setNewSectionPage"; id: string; page: number }
  | { type: "setExistingSectionField"; key: string; field: "lot_number" | "manufacturing_date" | "expiry_date"; value: string }
  | { type: "setExistingBoxField"; key: string; boxId: string; field: keyof ExistingBoxEdit; value: string; carton: string }
  | { type: "genAddBoxes"; key: string; line: PurchaseLine; sectionNumber: number; count: number }
  | { type: "setAddBoxField"; key: string; boxIndex: number; field: keyof DraftBox; value: string; carton: string }
  | { type: "clearAddBoxes"; key: string }
  | { type: "reset"; po: PurchasePoDetail };
```

Implement `inwardReducer(state, action)` per the behaviors above. (Executor: write each case explicitly; for `setCarton`, map over `newSections` of that line and `existing` sections of that line recomputing `net_weight = computeNet(gross, value)` for every box, mirroring reference 1153–1173. For `generateBoxes`, read `box_count`/`lot_number` from the matching `NewSection`, compute `start` as above, and fill `boxes` with `{box_number: start+i, gross_weight:"", net_weight:"", lot_number: section.lot_number, count:""}`, reset `page` to 1.)

- [ ] **Step 5: Payload builders.**

```ts
function mintBase(nowMs: number): string { return String(nowMs).slice(-8); }

export function buildReceiveRequest(state: DraftState, po: PurchasePoDetail): ReceiveRequest {
  const header: Record<string, string | null> = {};
  for (const f of LOGISTICS_FIELDS) {
    const v = state.header[f]?.trim() ?? "";
    header[f] = f === "system_grn_date"
      ? (v ? new Date(v).toISOString() : null)
      : (v || null);
  }
  const lines = (po.lines ?? [])
    .map((l) => ({ line_number: l.line_number, carton_weight: state.cartonByLine[l.line_number] ? parseFloat(state.cartonByLine[l.line_number]) : null }))
    .filter((l) => l.carton_weight != null);
  return { header: header as ReceiveRequest["header"], lines };
}

// New sections → POST /boxes (reference 1296–1391). box_number continues after existing.
export function buildAddSections(state: DraftState, po: PurchasePoDetail, nowMs: number): AddSectionPayload[] {
  const base = mintBase(nowMs);
  let globalIdx = 0;
  const out: AddSectionPayload[] = [];
  for (const sec of state.newSections) {
    const boxCount = parseInt(sec.box_count) || 0;
    if (boxCount < 1) continue;
    const line = po.lines.find((l) => l.line_number === sec.line_number);
    if (!line) continue;
    const existingCount = countExistingBoxes(line);
    const boxes = (sec.boxes && sec.boxes.length)
      ? sec.boxes.map((b) => { globalIdx++; return {
          box_id: `${base}-${globalIdx}`, box_number: b.box_number,
          net_weight: b.net_weight ? parseFloat(b.net_weight) : null,
          gross_weight: b.gross_weight ? parseFloat(b.gross_weight) : null,
          lot_number: b.lot_number || sec.lot_number || null,
          count: b.count ? parseInt(b.count) : null,
        }; })
      : Array.from({ length: boxCount }, (_, i) => {
          globalIdx++;
          const prevForLine = out.filter((s) => s.line_number === sec.line_number).reduce((n, s) => n + s.boxes.length, 0);
          return { box_id: `${base}-${globalIdx}`, box_number: existingCount + prevForLine + i + 1,
            net_weight: null, gross_weight: null, lot_number: sec.lot_number || null, count: null };
        });
    out.push({ line_number: sec.line_number, box_count: boxCount,
      lot_number: sec.lot_number || null, manufacturing_date: sec.mfg_date || null,
      expiry_date: sec.exp_date || null, boxes });
  }
  return out;
}

// Edited existing sections → PUT /boxes (reference 1242–1294).
export function buildUpdateSections(state: DraftState, po: PurchasePoDetail): UpdateSectionPayload[] {
  const out: UpdateSectionPayload[] = [];
  for (const line of po.lines ?? []) {
    for (const sec of line.sections ?? []) {
      const key = existingKey(line.line_number, sec.section_number);
      const edit = state.existing[key];
      if (!edit) continue;
      const boxes = (sec.boxes ?? []).map((b) => {
        const be = edit.boxes[b.box_id];
        return { box_id: b.box_id,
          net_weight: be?.net_weight ? parseFloat(be.net_weight) : null,
          gross_weight: be?.gross_weight ? parseFloat(be.gross_weight) : null,
          lot_number: be?.lot_number || null,
          count: be?.count ? parseInt(be.count) : null };
      });
      out.push({ line_number: line.line_number, section_number: sec.section_number,
        lot_number: edit.lot_number || null, manufacturing_date: edit.manufacturing_date || null,
        expiry_date: edit.expiry_date || null, boxes });
    }
  }
  return out;
}

// Add-boxes panel → POST /boxes for an existing section (reference 1051–1119).
export function buildAddBoxesPayload(state: DraftState, po: PurchasePoDetail, line: PurchaseLine, sectionNumber: number, nowMs: number): AddSectionPayload {
  const key = existingKey(line.line_number, sectionNumber);
  const boxes = state.addBoxes[key]?.boxes ?? [];
  const base = mintBase(nowMs);
  const sec = (line.sections ?? []).find((s) => s.section_number === sectionNumber);
  return {
    line_number: line.line_number, box_count: boxes.length,
    lot_number: sec?.lot_number ?? null, manufacturing_date: sec?.manufacturing_date ?? null,
    expiry_date: sec?.expiry_date ?? null,
    boxes: boxes.map((b, i) => ({ box_id: `${base}-${i + 1}`, box_number: b.box_number,
      net_weight: b.net_weight ? parseFloat(b.net_weight) : null,
      gross_weight: b.gross_weight ? parseFloat(b.gross_weight) : null,
      lot_number: b.lot_number || null, count: b.count ? parseInt(b.count) : null })),
  };
}
```

- [ ] **Step 6: Typecheck + lint.** `npx tsc --noEmit` (Expected: clean) and `npx eslint src/app/modules/purchase/material-in/[transaction_no]/_boxEngine.ts` (Expected: clean).
- [ ] **Step 7: Functional verification (no runner — reason through these explicit cases and confirm in code).**
  - Line with 3 existing boxes, new section box_count=5, no prior new sections → generated box_numbers = `4,5,6,7,8`.
  - Two new sections on same line, counts 2 then 3 → `buildAddSections` numbers them `4,5` and `6,7,8` (existingCount 3).
  - carton=2.0, gross="20" → `computeNet`="18"; gross<carton → "".
  - `buildReceiveRequest`: only lines with a carton value are included; `system_grn_date` "2025-04-02T10:00" → ISO string.
- [ ] **Step 8: Functional code review.** Reviewer subagent diff-checks the four builders + numbering against reference lines (480–505, 1028–1045, 1242–1391) and the four cases above.
- [ ] **Step 9: Manual code review.** Reviewer subagent checks purity (no `Date`/React), reducer immutability (new objects, no mutation), and net-recompute completeness on `setCarton`.
- [ ] **Step 10: Commit.** `git add … _boxEngine.ts && git commit -m "feat(purchase): pure draft reducer + box payload builders for inward entry"`

---

## Task 3: Route shell + InwardEntry skeleton (fetch + summary)

**Files:**
- Create: `src/app/modules/purchase/material-in/[transaction_no]/page.tsx`
- Create: `src/app/modules/purchase/material-in/[transaction_no]/_InwardEntry.tsx`
- Pattern refs: `material-in/page.tsx`, `production/plan-list/[planId]/page.tsx`, reference `renderPO` lines 117–155.

**Interfaces:**
- Produces: default-export `InwardPage`; `InwardEntry({ transactionNo }: { transactionNo: string })` (consumed by page). `_InwardEntry` owns `const [draft, dispatch] = useReducer(inwardReducer, …)` and `po` state (consumed conceptually by Tasks 5–10 which add to this file/components).

- [ ] **Step 1: `page.tsx` route shell.**

```tsx
"use client";

import { useParams, useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { PurchaseChrome } from "../../_chrome";
import { InwardEntry } from "./_InwardEntry";

export default function InwardPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const params = useParams<{ transaction_no: string }>();
  const txn = decodeURIComponent(params.transaction_no);
  if (!authed) return <></>;
  return (
    <PurchaseChrome title="Material In · Inward">
      <InwardEntry transactionNo={txn} />
    </PurchaseChrome>
  );
}
```

- [ ] **Step 2: `_InwardEntry.tsx` skeleton — fetch + loading/error + summary grid.** (Logistics form, lines, action bar are added in later tasks; leave clearly-marked sections.)

```tsx
"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BackLink } from "@/components/BackLink";
import { fmtCur, fmtNum, fmtDate } from "@/lib/po";
import { getPurchasePo, type PurchasePoDetail } from "@/lib/purchase-receive";
import { initDraft, inwardReducer } from "./_boxEngine";

export function InwardEntry({ transactionNo }: { transactionNo: string }): React.JSX.Element {
  const router = useRouter();
  const [po, setPo] = useState<PurchasePoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [draft, dispatch] = useReducer(inwardReducer, null as unknown as ReturnType<typeof initDraft>);
  const initedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true); setError(null);
      try {
        const data = await getPurchasePo(transactionNo, controller.signal);
        if (controller.signal.aborted) return;
        setPo(data);
        dispatch({ type: "reset", po: data });
        initedRef.current = true;
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

  if (loading) return <Centered>Loading Purchase Order…</Centered>;
  if (error) return <Centered tone="err">{error}</Centered>;
  if (!po || !initedRef.current) return <Centered>Preparing…</Centered>;

  return (
    <div>
      <div className="mb-3"><BackLink parentHref="/modules/purchase/material-in" label="Material In" /></div>
      <div className="mb-4">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">PO Receiving</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">Receiving data for {po.transaction_no}</p>
      </div>
      {toast ? (
        <div className={["mb-3 px-3 py-2 text-[13px] rounded-[2px] border",
          toast.kind === "ok" ? "bg-[#eaf6ed] border-[#b6dbb1] text-[var(--text-success)]" : "bg-[#fbeced] border-[#f0c0c4] text-[var(--aws-error)]"].join(" ")}>
          {toast.text}
        </div>
      ) : null}

      {/* PO summary (read-only) */}
      <SummaryGrid po={po} />

      {/* TODO Task 5: logistics form */}
      {/* TODO Task 6–9: lines + sections (uses draft/dispatch) */}
      {/* TODO Task 10: action bar */}
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "err" }) {
  return (
    <div className={["bg-white border rounded-md p-10 text-center text-[13px]",
      tone === "err" ? "border-[#f0c0c4] text-[var(--aws-error)]" : "border-[var(--aws-border)] text-[var(--text-secondary)]"].join(" ")}>
      {children}
    </div>
  );
}

function SummaryGrid({ po }: { po: PurchasePoDetail }) {
  const cell = (label: string, value: React.ReactNode, mono = false) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide font-bold text-[var(--text-muted)]">{label}</span>
      <span className={["text-[13px] text-[var(--text-primary)]", mono ? "font-mono" : ""].join(" ")}>{value}</span>
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
      {cell("Gross Total", fmtCur(po.gross_total), true)}
      {cell("Total Amount", fmtCur(po.total_amount), true)}
      {cell("Lines", fmtNum(po.total_lines), true)}
      {cell("Status", po.status || "pending")}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + lint.** `npx tsc --noEmit`; `npx eslint` on both new files. Expected: clean.
- [ ] **Step 4: Functional verification.** `npm run dev`, navigate to `/modules/purchase/material-in/TR-20250428143000`. Expected: summary grid shows PO/CFPL/25-26/020, Shree Packaging, etc. (loading → content). Bad txn → error card.
- [ ] **Step 5: Functional code review.** Reviewer confirms summary fields/labels match reference `renderPO` (lines 124–135) and the route param pattern matches `plan-list/[planId]`.
- [ ] **Step 6: Manual code review.** Reviewer checks abort handling, the `initedRef` guard (reducer starts null until reset), and chrome/back-link usage.
- [ ] **Step 7: Commit.** `git add … && git commit -m "feat(purchase): inward entry route + PO summary skeleton"`

---

## Task 4: Right-arrow inward action in Material In list

**Files:**
- Modify: `src/app/modules/purchase/material-in/_MaterialInList.tsx` (`ActionBtns` ~1141–1180; `MaterialInTableRow` ~1184–1233; `MaterialInMobileCard` ~1237–1299)

**Interfaces:**
- Consumes: route from Task 3 (`/modules/purchase/material-in/<txn>`).
- Produces: `ActionBtns` gains `onInward: () => void`; rows pass it through.

- [ ] **Step 1: Add `useRouter` import + thread `onInward`.** At top of `_MaterialInList.tsx`, add `import { useRouter } from "next/navigation";`. In `MaterialInList`, create `const router = useRouter();`. In both `MaterialInTableRow` and `MaterialInMobileCard` usages, pass `onInward={() => router.push(\`/modules/purchase/material-in/${encodeURIComponent(txn)}\`)}`. Add `onInward: () => void;` to both row components' prop types and forward to `ActionBtns`.

- [ ] **Step 2: Add the arrow button to `ActionBtns` (beside the view/eye button).**

```tsx
function ActionBtns({
  onToggle, onSend, onInward, isOpen,
}: {
  onToggle: () => void;
  onSend: () => void;
  onInward: () => void;
  isOpen: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {/* Eye / view */}
      <button type="button" onClick={onToggle} title={isOpen ? "Collapse" : "Expand"} aria-label={isOpen ? "Collapse" : "Expand"}
        className="p-1 rounded hover:bg-[var(--surface-divider)] text-[var(--text-secondary)]">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          {isOpen
            ? <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>
            : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
        </svg>
      </button>
      {/* Inward (right arrow) — opens box-wise receiving */}
      <button type="button" onClick={onInward} title="Open inward entry" aria-label="Open inward entry"
        className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8]">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
      {/* Send intimation */}
      <button type="button" onClick={onSend} title="Send intimation" aria-label="Send intimation"
        className="p-1 rounded hover:bg-[#eaf0fb] text-[var(--text-secondary)] hover:text-[#2c5fa8]">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Pass `onInward` from both row renderers.** In `MaterialInTableRow` and `MaterialInMobileCard`, add `onInward` to props and pass `<ActionBtns onToggle={…} onSend={…} onInward={onInward} isOpen={…} />`. In the parent `MaterialInList` map (desktop + mobile), pass `onInward={() => router.push(...)}` as in Step 1.
- [ ] **Step 4: Typecheck + lint.** `npx tsc --noEmit`; `npx eslint src/app/modules/purchase/material-in/_MaterialInList.tsx`. Expected: clean.
- [ ] **Step 5: Functional verification.** `npm run dev`; on Material In, each row shows three actions (eye, →, send). Clicking → navigates to the inward page for that txn (desktop and mobile card).
- [ ] **Step 6: Functional code review.** Reviewer confirms the arrow sits beside the view button, navigates to the correct route with `encodeURIComponent`, and the row click-to-expand still works (button `stopPropagation` is already handled by the cell wrapper at row ~1220).
- [ ] **Step 7: Manual code review.** Reviewer checks aria-labels, no prop drilling regressions, and that mobile + desktop both wired.
- [ ] **Step 8: Commit.** `git add … && git commit -m "feat(purchase): add inward (→) action to Material In rows"`

---

## Task 5: Logistics & Receiving form

**Files:**
- Modify: `_InwardEntry.tsx` (replace the `{/* TODO Task 5 */}` marker)
- Reference: `index.html` lines 146–202, `renderPO` setVal lines 137–151.

**Interfaces:**
- Consumes: `draft.header`, `dispatch({type:"setHeader"})`, `LOGISTICS_FIELDS`.

- [ ] **Step 1: Add a `LogisticsForm` component** rendering the 12 fields (labels/placeholders from `index.html`), each a controlled input bound to `draft.header[field]` dispatching `setHeader`. `system_grn_date` uses `type="datetime-local"`; others `type="text"` (vehicle/LR/challan/invoice/GRN/warehouse get `font-mono`). Render inside the form section card. (Executor: write the field list as a typed array `{field, label, placeholder, mono?, type?}` and map it.)
- [ ] **Step 2: Typecheck + lint.** Expected clean.
- [ ] **Step 3: Functional verification.** Fields pre-fill from the PO; typing updates state (verify via React devtools or a temporary log). All 12 fields present with correct labels.
- [ ] **Step 4: Functional code review.** Reviewer cross-checks the 12 fields + labels + datetime handling against `index.html` 146–202 and `LOGISTICS_FIELDS`.
- [ ] **Step 5: Manual code review.** Reviewer checks controlled-input correctness (no uncontrolled→controlled warning), label `htmlFor`/ids.
- [ ] **Step 6: Commit.** `git commit -m "feat(purchase): logistics & receiving form on inward page"`

---

## Task 6: Line accordion + read-only purchase data + carton input

**Files:**
- Create: `_LineCard.tsx`
- Modify: `_InwardEntry.tsx` (render `<LineCard>` per line in place of the Task 6–9 marker)
- Reference: `renderLines` lines 247–302 (header, read-only grid, carton field).

**Interfaces:**
- Produces: `LineCard({ line, draft, dispatch }: { line: PurchaseLine; draft: DraftState; dispatch: React.Dispatch<InwardAction> })`. Consumes `draft.cartonByLine`, `setCarton`.

- [ ] **Step 1: `LineCard` — collapsible header (line number, sku, pcs · amount), read-only purchase grid (SKU, matched/particulars, category, type, UOM, pack_count, po_weight (3dp + " kg"), rate, amount, gst_rate as `%`), and the editable "Empty Carton + Laminate (kg)" number input** bound to `draft.cartonByLine[line.line_number]` dispatching `setCarton` (value passed through `clamp3`). Leave a `{/* Task 7–9: <SectionEditor/> */}` marker inside the body.
- [ ] **Step 2: Render lines** in `_InwardEntry.tsx`: `po.lines.map((l) => <LineCard key={l.line_number} line={l} draft={draft} dispatch={dispatch} />)` inside a "Line Items — Stores Data" section.
- [ ] **Step 3: Typecheck + lint.** Expected clean.
- [ ] **Step 4: Functional verification.** Each line is a collapsible card; expanding shows read-only purchase data + carton input; editing carton updates state (later tasks consume it).
- [ ] **Step 5: Functional code review.** Reviewer diff-checks the read-only grid fields + formats vs reference 263–285 (gst as `(gst_rate*100).toFixed(1)%`, po_weight `.toFixed(3) kg`).
- [ ] **Step 6: Manual code review.** Reviewer checks accordion a11y (button toggling), key usage, and that `setCarton` recompute (Task 2) is wired.
- [ ] **Step 7: Commit.** `git commit -m "feat(purchase): per-line accordion with carton weight on inward page"`

---

## Task 7: Existing sections — render + edit fields + box table

**Files:**
- Create: `_SectionEditor.tsx`
- Modify: `_LineCard.tsx` (render `<SectionEditor>` in the marker)
- Reference: `renderLines` existingSectionsHtml lines 188–245 (section header, lot/mfg/exp edit grid, collapsible box table with gross/net/lot/count inputs).

**Interfaces:**
- Produces: `SectionEditor({ line, draft, dispatch, onUpdateSection, onAddBoxes, busyKey }: …)`. This task renders existing sections only (Update/Add Boxes buttons wired in Task 8 — render them disabled/no-op for now or accept the handlers as props and wire in Task 8). Consumes `draft.existing`, `setExistingSectionField`, `setExistingBoxField`.

- [ ] **Step 1: Render each existing section** (`line.sections`): section label (`Section {section_number}`), box count; an edit grid for LOT/MFG/EXP bound to `draft.existing[key]` via `setExistingSectionField`; a collapsible per-box `<table>` (columns Box #, Gross Wt, Net Wt, LOT, Count) where gross/net/lot/count are inputs bound to `draft.existing[key].boxes[box_id]` via `setExistingBoxField` (gross dispatches with `carton = draft.cartonByLine[line]` so net recomputes). Omit the print column. Numeric inputs use `clamp3` on change.
- [ ] **Step 2: Render in `_LineCard`** passing `line`, `draft`, `dispatch` (+ Task 8 handler props as optional).
- [ ] **Step 3: Typecheck + lint.** Expected clean.
- [ ] **Step 4: Functional verification.** Open a seeded PO that has existing boxes (e.g. `TR-20250402100000`), expand its line — existing section(s) show editable lot/mfg/exp and a box table; editing gross recomputes net using the carton value.
- [ ] **Step 5: Functional code review.** Reviewer diff-checks columns/fields vs reference 211–242 and net-recompute behavior (reference 1130–1150).
- [ ] **Step 6: Manual code review.** Reviewer checks keys (box_id), controlled inputs, and that section keys match `existingKey`.
- [ ] **Step 7: Commit.** `git commit -m "feat(purchase): render + edit existing box sections"`

---

## Task 8: Existing section — Update (PUT) + Add Boxes (POST)

**Files:**
- Modify: `_SectionEditor.tsx` (wire buttons), `_InwardEntry.tsx` (provide handlers + re-fetch on success)
- Reference: Update lines 876–944; Add Boxes lines 946–1126.

**Interfaces:**
- Consumes: `updateBoxes`, `addBoxes` from `@/lib/purchase-receive`; `buildUpdateSections`, `buildAddBoxesPayload`, `genAddBoxes`/`setAddBoxField`/`clearAddBoxes` actions.
- Produces: handlers `onUpdateSection(line, sectionNumber)` and `onAddBoxes(line, sectionNumber)` in `_InwardEntry` passed to `SectionEditor`; both call the API then re-fetch the PO (`getPurchasePo`) and `dispatch({type:"reset"})`, setting a toast.

- [ ] **Step 1: Add a per-section "Update" button** → `onUpdateSection`: build a single-section `UpdateSectionPayload` from `buildUpdateSections` filtered to that `(line, section_number)` (or a focused builder), call `updateBoxes(txn, {sections:[…]})`, on success re-fetch + reset + toast "Section N updated", on error toast.
- [ ] **Step 2: Add the "Add Boxes" panel** (toggle) with a count input + Generate (dispatch `genAddBoxes`) rendering a box table bound to `draft.addBoxes[key]` (gross recomputes net via `setAddBoxField` with carton), and a "Save New Boxes" button → `onAddBoxes`: `addBoxes(txn, {sections:[buildAddBoxesPayload(...)]})`, on success re-fetch + reset + `clearAddBoxes` + toast.
- [ ] **Step 3: Typecheck + lint.** Expected clean.
- [ ] **Step 4: Functional verification.** On a PO with an existing section: edit a box gross weight → Update → reload shows persisted value. Add Boxes: generate 2, enter weights, Save → reload shows 2 new boxes numbered after the section's max.
- [ ] **Step 5: Functional code review.** Reviewer confirms payloads match `SectionUpdate`/`SectionInput` and numbering continues after section max (reference 1028–1045).
- [ ] **Step 6: Manual code review.** Reviewer checks busy/disabled states, error paths, and re-fetch/reset (no stale draft).
- [ ] **Step 7: Commit.** `git commit -m "feat(purchase): update existing sections + append boxes"`

---

## Task 9: New sections — add/remove, generate boxes, paginated table, auto net

**Files:**
- Modify: `_SectionEditor.tsx` (new-section UI), `_LineCard.tsx`/`_InwardEntry.tsx` as needed
- Reference: Add Section 305–365; Remove 367–376; Generate 460–517; renderBoxPage + pagination 399–458; net calc 1128–1173.

**Interfaces:**
- Consumes: `addSection`, `removeSection`, `setNewSectionField`, `generateBoxes`, `setNewBoxField`, `setNewSectionPage`, `BOXES_PER_PAGE`.

- [ ] **Step 1: "Add Section" button** → `dispatch({type:"addSection", line, id})` (id from a monotonic counter or `crypto.randomUUID()`); renders a new-section card with fields box_count/lot/mfg/exp (bound via `setNewSectionField`).
- [ ] **Step 2: "Generate Boxes"** → `dispatch({type:"generateBoxes", id, line})`; render the generated boxes as a paginated table (100/page) with Box #, Gross, Net, LOT, Count inputs bound via `setNewBoxField` (gross passes carton → net recomputes). Disable Generate after generation (until count change) per reference 514–516.
- [ ] **Step 3: Pagination controls** (prev / "Page X of Y" / next) dispatching `setNewSectionPage`; show range `(Box a–b of total)`. "Remove Section" → `removeSection`.
- [ ] **Step 4: Typecheck + lint.** Expected clean.
- [ ] **Step 5: Functional verification.** Add a section (count 250), Generate → 3 pages of 100/100/50; box numbers continue after existing; enter a gross → net auto-fills; changing carton recomputes visible nets; Remove discards the card.
- [ ] **Step 6: Functional code review.** Reviewer diff-checks generate numbering (480–505), pagination math (409–442), and disable-after-generate.
- [ ] **Step 7: Manual code review.** Reviewer checks page-switch state retention (inputs persist across pages — reducer holds all boxes), keys, and large-count performance (only current page rendered).
- [ ] **Step 8: Commit.** `git commit -m "feat(purchase): new box sections with generate + pagination + auto net"`

---

## Task 10: Save flow + action bar

**Files:**
- Modify: `_InwardEntry.tsx` (action bar + `onSave`)
- Reference: save handler lines 1180–1406.

**Interfaces:**
- Consumes: `buildReceiveRequest`, `buildUpdateSections`, `buildAddSections`, `saveReceive`, `updateBoxes`, `addBoxes`.

- [ ] **Step 1: Action bar** (Cancel + Save Receiving Data) at the page bottom. Cancel → `router.push("/modules/purchase/material-in")`.
- [ ] **Step 2: `onSave`** (disable button + spinner): (1) `await saveReceive(txn, buildReceiveRequest(draft, po))`; (2) `const ups = buildUpdateSections(draft, po); if (ups.length) await updateBoxes(txn, {sections: ups});` (3) `const news = buildAddSections(draft, po, Date.now()); if (news.length) await addBoxes(txn, {sections: news});` (4) toast "Receiving data saved successfully"; re-fetch + `reset`; optionally navigate back after ~1.2s (reference 1394–1397). On any error: toast error, stop, re-enable.
- [ ] **Step 3: Typecheck + lint + build.** `npx tsc --noEmit`; `npm run lint`; `npm run build` (Expected: build succeeds).
- [ ] **Step 4: Functional verification (end-to-end).** Open `TR-20250428143000`: fill some logistics fields, set a carton weight, add a new section (count 3) + weights, Save → success toast; reload page → logistics + carton + new boxes persisted.
- [ ] **Step 5: Functional code review.** Reviewer confirms the 3-call order + payloads match reference save handler (1188–1391) and only carton-bearing lines go to `/receive`.
- [ ] **Step 6: Manual code review.** Reviewer checks error short-circuit (don't POST if PUT failed), button busy state, and re-fetch/reset after save.
- [ ] **Step 7: Commit.** `git commit -m "feat(purchase): save receiving data (receive + boxes) with action bar"`

---

## Task 11: Final integration — build, DB confirmation, end-to-end

**Files:** none new.

- [ ] **Step 1: Full typecheck + lint + build.** `npx tsc --noEmit && npm run lint && npm run build`. Expected: all pass.
- [ ] **Step 2: DDL confirmation (read-only).** Connect to the dev DB (reuse `server_replica/.env` `DATABASE_URL` via a read-only script) and confirm `po_section` + `po_box` tables and `po_line.carton_weight` exist (information_schema). Paste the confirmation + the existing DDL (from the spec §10) into chat. If any object is missing, surface the exact `CREATE TABLE`/`ALTER` needed (from `po_schema.sql`). No writes.
- [ ] **Step 3: End-to-end manual pass.** From Material In, click the → arrow on a row → page loads → add section, generate boxes, weights, edit existing section, Save → reload confirms persistence. Verify mobile card arrow too.
- [ ] **Step 4: Functional + manual review (whole feature).** A reviewer subagent does a holistic pass: spec coverage (every spec §4 requirement), faithful replication vs `po-receiving.js` (minus printing), and no regressions to Material In.
- [ ] **Step 5: Commit + branch summary.** `git commit` any final tweaks; summarize the branch `feature/box-wise-inward-entry`.

---

## Self-Review (author)

- **Spec coverage:** §4.1 arrow → Task 4; §4.2 load/states → Task 3; §4.3 summary → Task 3; §4.4 logistics → Task 5; §4.5 line accordion + carton → Task 6; §4.6 existing sections → Tasks 7–8; §4.7 new sections → Task 9; §4.8 auto net → Tasks 2,6,7,9; §4.9 save → Task 10; §4.10 numeric guard → Task 2 (`clamp3`) applied in 6/7/9. DDL → Task 11. All covered.
- **Placeholders:** Pure logic (client, engine, reducer, builders, page, arrow) is given in full code. UI components (Tasks 5–10) specify exact fields/handlers/reference line ranges + the non-obvious code; "port reference lines X–Y preserving classes" is a concrete instruction, not a vague placeholder.
- **Type consistency:** `existingKey`, `DraftState`, action names, and builder signatures are defined once in Task 2 and referenced consistently in Tasks 3–10. Client types defined once in Task 1.

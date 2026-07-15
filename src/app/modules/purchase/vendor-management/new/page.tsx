"use client";

// Vendor Management · Onboarding wizard (extract-first flow) — web port.
//
// TypeScript/React port of the Electron renderer
// frontend_replica/src/modules/purchase/vendor-management/vendor-new/vendor-new.js.
//
// Phase 1 (Step 1):  POST /vendors/extract-bulk
//   Operator drops every compliance doc. We upload + run Claude extraction
//   WITHOUT creating a vendor row. Returns a `staging_id` plus suggested
//   vendor / banking / documents / contracts fields we pre-fill into steps 2-5.
//
// Phase 2 (Step 6):  POST /vendors/submit-staged
//   Operator reviews + edits the pre-filled form. On submit we send the whole
//   payload back; backend commits everything in one transaction and promotes
//   the staged S3 objects under the vendor's supplier_code.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import { PurchaseChrome } from "../../_chrome";
import {
  VENDOR_STATUS,
  DOC_TYPE,
  CONTRACT_TYPE,
  UPLOAD_ACCEPT,
  MAX_FILES,
  getLookupBundle,
  extractBulk,
  submitStagedVendor,
  createVendorWithDocuments,
  addBanking,
  addContract,
  validateUploadFile,
  isValidIfsc,
  normaliseISODate,
  resolveLookupLabel,
  VendorApiError,
  type LookupRow,
  type VendorBody,
  type ExtractBulkResult,
  type ExtractedDocRow,
  type SubmitStagedResult,
  type StagedDocumentItem,
  type BankingResponse,
  type ContractResponse,
} from "@/lib/vendor";

// ── Config ─────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 6;
const STEP_LABELS = ["Upload documents", "Basics", "Compliance", "Banking", "Contracts", "Review"];

// Sentinels + caps as named constants so a typo can't silently break auto-detect
// and the file cap tracks the backend limit from one place.
const AUTO_DOC_TYPE = "__auto__";
const FALLBACK_DOC_TYPE = "OTHER";

// Vendor field key type — ties the form state, accessors and field configs to
// the API body so a mistyped key (sv("emial")) is a compile error, not a silent
// no-op.
type FormKey = keyof VendorBody;

interface FieldDef { key: FormKey; label: string; mono?: boolean; wide?: boolean; type?: string }
interface SelectDef { key: FormKey; label: string; type: string } // type = lookup_type

const BASICS_SELECTS: SelectDef[] = [
  { key: "supplier_type_id", label: "Supplier type", type: "SUPPLIER_TYPE" },
  { key: "firm_status_id", label: "Firm status", type: "FIRM_STATUS" },
  { key: "business_type_id", label: "Business type", type: "BUSINESS_TYPE" },
  { key: "category_code_id", label: "Category", type: "CATEGORY_CODE" },
  { key: "local_os_id", label: "Local / OS", type: "LOCAL_OS" },
];
const STATUS_SELECTS: SelectDef[] = [
  { key: "scoc_status_id", label: "SCOC status", type: "KYC_STATUS" },
  { key: "kyc_status_id", label: "KYC status", type: "KYC_STATUS" },
  { key: "doc_status_id", label: "Document status", type: "DOC_STATUS" },
];
const MSME_SELECT: SelectDef = { key: "msme_type_id", label: "MSME type", type: "MSME_TYPE" };
const ACCOUNT_TYPE_LOOKUP = "ACCOUNT_TYPE"; // banking account-type dropdown

// Single source of truth for the field→lookup_type wiring. SELECT_LOOKUP (used
// by hydration to resolve extracted labels→ids) and LOOKUP_TYPES (the preload
// list) are both derived from the render configs so they can't drift.
const ALL_SELECTS: SelectDef[] = [...BASICS_SELECTS, ...STATUS_SELECTS, MSME_SELECT];
const SELECT_LOOKUP: Partial<Record<FormKey, string>> = Object.fromEntries(
  ALL_SELECTS.map((s) => [s.key, s.type]),
) as Partial<Record<FormKey, string>>;
const LOOKUP_TYPES: string[] = [...new Set([...ALL_SELECTS.map((s) => s.type), ACCOUNT_TYPE_LOOKUP])];

// Selects that carry an "Others" free-text companion. When the chosen lookup is
// the "Others" option, the form reveals a text input bound to the *_other key,
// whose value is sent to the backend and stored in vendor_master.*_other.
const OTHER_OF: Partial<Record<FormKey, FormKey>> = {
  supplier_type_id: "supplier_type_other",
  firm_status_id: "firm_status_other",
  business_type_id: "business_type_other",
};

const DATE_FIELDS = new Set<FormKey>(["msme_registration_date"]);
const DOC_TYPE_CODES = new Set(DOC_TYPE.map((d) => d.code as string));

const BASICS_TEXT: FieldDef[] = [
  { key: "supplier_code", label: "Supplier code", mono: true },
  { key: "supplier_reg_year", label: "Reg year" },
  { key: "sub_category", label: "Sub-category" },
];
const CONTACT_FIELDS: FieldDef[] = [
  { key: "contact_person", label: "Contact person" },
  { key: "designation", label: "Designation" },
  { key: "mobile", label: "Mobile" },
  { key: "phone_company", label: "Company phone" },
  { key: "email", label: "Email", type: "email" },
  { key: "website", label: "Website", type: "url" },
  { key: "address_line", label: "Address", wide: true },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "pin_code", label: "PIN code" },
];
const NOTES_FIELDS: FieldDef[] = [
  { key: "core_business", label: "Core business", wide: true },
  { key: "capabilities", label: "Capabilities", wide: true },
  { key: "business_turnover_3y", label: "3-year turnover", wide: true },
  { key: "reference", label: "Reference", wide: true },
  { key: "remarks", label: "Remarks", wide: true },
];
const COMPLIANCE_FIELDS: FieldDef[] = [
  { key: "fssai_no", label: "FSSAI No (14 digits)", mono: true },
  { key: "brc_other", label: "BRC / other" },
  { key: "cin_no", label: "CIN (21 chars)", mono: true },
  { key: "pan_no", label: "PAN (10 chars)", mono: true },
  { key: "gstn", label: "GSTIN (15 chars)", mono: true },
  { key: "iec_no", label: "IEC (10 digits)", mono: true },
  { key: "pollution_epr", label: "Pollution / EPR" },
  { key: "tin_tan", label: "TIN / TAN" },
];

// ── Local working types ──
// Stable per-row ids so React keys survive remove/reorder (no positional key
// churn) and so the extraction result-merge stays aligned to the right row.
let _rowSeq = 0;
const newRowId = () => `r${++_rowSeq}`;

interface QueuedFile {
  id: string;
  file: File;
  doc_type: string; // AUTO_DOC_TYPE or a DOC_TYPE code
  // Mirrors the backend ExtractionStatus. "failed" also covers an S3-upload
  // failure (no s3_url) surfaced by the UI.
  status?: "ok" | "failed" | "skipped";
  error?: string | null;
  s3_url?: string | null;
  extracted?: ExtractedDocRow;
}
interface BankRow {
  id: string;
  bank_name: string; account_no: string; account_name: string;
  branch: string; ifsc: string; swift: string;
  account_type_id: string; account_type_label?: string;
  is_primary: boolean; is_active: boolean;
  valid_from: string; valid_to: string;
  _source?: "extraction";
}
interface ContractRow {
  id: string;
  contract_type: string; signed_date: string;
  effective_from: string; effective_to: string;
  value_inr: string; scoc_signed: boolean; auto_renew: boolean;
  s3_url: string; _source?: "extraction";
}

type FormValue = string | boolean;
type FormState = Partial<Record<FormKey, FormValue>>;
function blankForm(): FormState {
  return { name: "", status: "active", is_msme: false };
}
function blankBank(isPrimary: boolean): BankRow {
  return {
    id: newRowId(),
    bank_name: "", account_no: "", account_name: "", branch: "", ifsc: "", swift: "",
    account_type_id: "", is_primary: isPrimary, is_active: true, valid_from: "", valid_to: "",
  };
}
function blankContract(): ContractRow {
  return {
    id: newRowId(),
    contract_type: "", signed_date: "", effective_from: "", effective_to: "",
    value_inr: "", scoc_signed: false, auto_renew: false, s3_url: "",
  };
}

interface StepError { message: string; focusKey?: FormKey }

// ── Page ─────────────────────────────────────────────────────────────────────

export default function VendorNewPage(): React.JSX.Element {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);

  // Hydration gate. This page is server-rendered, where useRequireAuth returns
  // true (no token store) but the first browser render starts authed=false — so
  // a bare `if (!authed) return <></>` makes the SSR HTML and the first client
  // render diverge. Mirroring po-creation / sample, we hold the auth branch
  // until after mount so SSR and the first client paint are byte-identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  const [step, setStep] = useState(1);
  const [lookups, setLookups] = useState<Record<string, LookupRow[]>>({});

  const [filesQueue, setFilesQueue] = useState<QueuedFile[]>([]);
  const [extraction, setExtraction] = useState<ExtractBulkResult | null>(null);
  const [stagingId, setStagingId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);

  const [form, setForm] = useState<FormState>(blankForm);
  const [autoFilled, setAutoFilled] = useState<Set<string>>(new Set());
  const [bankingRows, setBankingRows] = useState<BankRow[]>([]);
  const [contractRows, setContractRows] = useState<ContractRow[]>([]);

  const [extracting, setExtracting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [createResult, setCreateResult] = useState<SubmitStagedResult | null>(null);
  // `error` = blocking / hard failures (red, role=alert). `warning` = non-blocking
  // informational caveats, incl. "vendor created, but…" (amber). Kept apart so a
  // successful create with a minor caveat never renders as a red failure.
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [drag, setDrag] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preload the dropdown sources once auth is confirmed (gating on `authed`
  // keeps the fetch from firing before the token check, matching the repo's
  // list pages). Retry a few times if any type comes back empty — that usually
  // means a transient load-time failure (getLookups no longer caches failures,
  // so a retry re-hits the API). A genuinely-empty DB settles after 3 cheap
  // cache hits.
  useEffect(() => {
    if (!authed) return;
    let live = true;
    (async () => {
      for (let attempt = 0; attempt < 3 && live; attempt++) {
        const b = await getLookupBundle(LOOKUP_TYPES);
        if (!live) return;
        setLookups(b);
        if (LOOKUP_TYPES.every((t) => (b[t]?.length ?? 0) > 0)) return;
      }
    })();
    return () => { live = false; };
  }, [authed]);

  // Abort any in-flight extraction if the wizard unmounts (e.g. a useRequireAuth
  // redirect or the operator navigating away mid-extraction).
  useEffect(() => () => abortRef.current?.abort(), []);

  // Re-resolve extracted banking account types once ACCOUNT_TYPE loads. If the
  // lookup was empty at extraction time (transient), hydration left
  // account_type_id blank while preserving account_type_label — recover it here
  // so the extracted account type isn't silently lost.
  useEffect(() => {
    const atRows = lookups[ACCOUNT_TYPE_LOOKUP];
    if (!atRows?.length) return;
    // Defer the update past the effect body (matches the repo's queueMicrotask
    // convention) so it isn't a synchronous setState-in-effect. The updater
    // returns the same ref when nothing resolved, so it's a no-op re-render then.
    queueMicrotask(() => {
      setBankingRows((rows) => {
        let changed = false;
        const next = rows.map((r) => {
          if (!r.account_type_id && r.account_type_label) {
            const id = resolveLookupLabel(atRows, r.account_type_label);
            if (id) { changed = true; return { ...r, account_type_id: id }; }
          }
          return r;
        });
        return changed ? next : rows;
      });
    });
  }, [lookups]);

  // Field accessors ──────────────────────────────────────────────────────────
  const sv = (k: FormKey): string => { const v = form[k]; return typeof v === "string" ? v : ""; };
  const bv = (k: FormKey): boolean => form[k] === true;
  function setField(k: FormKey, v: FormValue) {
    setForm((f) => ({ ...f, [k]: v }));
    setAutoFilled((a) => { if (!a.has(k)) return a; const n = new Set(a); n.delete(k); return n; });
  }

  // Surface a blocking error and move focus to the offending control (or the
  // alert when the field isn't directly focusable, e.g. a banking row).
  function showError(message: string, focusKey?: FormKey) {
    setError(message);
    queueMicrotask(() => {
      const el = focusKey ? document.getElementById(`f-${focusKey}`) : errorRef.current;
      el?.focus();
    });
  }

  // ── Step navigation ────────────────────────────────────────────────────────
  const canAdvanceStep1 = extraction != null || skipped;

  function validateStep(n: number): StepError | null {
    if (n === 2) {
      const name = sv("name").trim();
      if (!name || name.length < 2) return { message: "Vendor name is required (≥2 characters).", focusKey: "name" };
      if (name.length > 512) return { message: "Name is too long (max 512 chars).", focusKey: "name" };
    }
    if (n === 3) {
      // Match the backend compliance validators (schemas.py) exactly — a
      // right-length-but-wrong-format value is 422'd server-side, so catch it
      // here with a helpful message. The backend upper-cases before matching.
      const up = (k: FormKey) => sv(k).trim().toUpperCase();
      const fssai = sv("fssai_no").trim();
      if (fssai && !/^\d{14}$/.test(fssai)) return { message: "FSSAI must be 14 digits.", focusKey: "fssai_no" };
      const pan = up("pan_no");
      if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { message: "PAN format looks invalid (e.g. ABCDE1234F).", focusKey: "pan_no" };
      const gst = up("gstn");
      if (gst && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gst))
        return { message: "GSTIN format looks invalid (15 chars, e.g. 27ABCDE1234F1Z5).", focusKey: "gstn" };
      const cin = up("cin_no");
      if (cin && !/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(cin))
        return { message: "CIN format looks invalid (21 chars).", focusKey: "cin_no" };
      const iec = sv("iec_no").trim();
      if (iec && !/^\d{10}$/.test(iec)) return { message: "IEC must be 10 digits.", focusKey: "iec_no" };
      const udyam = up("uam_udyam_no");
      if (udyam && !/^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/.test(udyam))
        return { message: "UDYAM format looks invalid (UDYAM-XX-00-0000000).", focusKey: "uam_udyam_no" };
    }
    if (n === 4) {
      for (let i = 0; i < bankingRows.length; i++) {
        const r = bankingRows[i];
        if (!r.bank_name || !r.account_no || !r.account_name)
          return { message: `Banking row ${i + 1}: name / account no / account name are required.` };
        if (r.account_no.length < 4) return { message: `Banking row ${i + 1}: account number must be ≥4 chars.` };
        if (r.ifsc && !isValidIfsc(r.ifsc)) return { message: `Banking row ${i + 1}: invalid IFSC.` };
      }
    }
    return null;
  }

  function goNext() {
    setError(null);
    if (step < TOTAL_STEPS) {
      const err = validateStep(step);
      if (err) { showError(err.message, err.focusKey); return; }
      setStep(step + 1);
    } else {
      void submit();
    }
  }
  function goPrev() { if (submitting) return; setError(null); if (step > 1) setStep(step - 1); }

  function onCancel() {
    if (submitting) return;
    // Any form field diverging from its blankForm() default counts as unsaved
    // work — not just `name`. blankForm() seeds name:"", status:"active",
    // is_msme:false; every other key is empty until the operator types into it.
    const formDirty = (Object.keys(form) as FormKey[]).some((k) => {
      const v = form[k];
      if (k === "status") return v !== "active";
      if (k === "is_msme") return v === true;
      return typeof v === "string" ? v.trim() !== "" : v != null && v !== false;
    });
    const dirty =
      filesQueue.length > 0 || extraction != null || bankingRows.length > 0 ||
      contractRows.length > 0 || formDirty || autoFilled.size > 0;
    if (dirty && !window.confirm("Discard this vendor draft? Nothing has been saved yet.")) return;
    router.push("/modules/purchase/vendor-management");
  }

  // ── Files queue (Step 1) ────────────────────────────────────────────────────
  function addFiles(files: FileList | File[]) {
    if (extraction || extracting) {
      setError("Extraction already ran — start a new vendor to upload a different set of files.");
      return;
    }
    // Compute additions + any error OUTSIDE the state updater so the updater
    // stays pure (React may run updaters twice in StrictMode). Reading the
    // current queue length from state is correct inside this event handler.
    const incoming = Array.from(files);
    const accepted: QueuedFile[] = [];
    let errMsg: string | null = null;
    let count = filesQueue.length;
    for (const file of incoming) {
      if (count >= MAX_FILES) { errMsg = `Up to ${MAX_FILES} files per batch — submit this batch first.`; break; }
      const err = validateUploadFile(file);
      if (err) { errMsg = err; continue; }
      accepted.push({ id: newRowId(), file, doc_type: AUTO_DOC_TYPE });
      count++;
    }
    if (accepted.length) setFilesQueue((prev) => [...prev, ...accepted]);
    setError(errMsg);
  }
  // The queue is locked (no remove / doc-type edit) while extraction is in flight,
  // so these are only reachable pre-extraction — but guard defensively so a
  // mid-flight change can never desync the positional result-merge in runExtract.
  function removeFile(id: string) { if (extracting || extraction) return; setFilesQueue((q) => q.filter((f) => f.id !== id)); }
  function setFileDocType(id: string, dt: string) {
    if (extracting || extraction) return;
    setFilesQueue((q) => q.map((f) => (f.id === id ? { ...f, doc_type: dt } : f)));
  }

  // ── Phase 1: extract ────────────────────────────────────────────────────────
  async function runExtract() {
    if (!filesQueue.length) { setError("Drop at least one file first."); return; }
    setError(null);
    setWarning(null);
    setExtracting(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const docsMeta = filesQueue.map((f) => (f.doc_type === AUTO_DOC_TYPE ? {} : { doc_type: f.doc_type }));
      const files = filesQueue.map((f) => f.file);
      const result = await extractBulk(files, docsMeta, { signal: controller.signal });

      // Ensure the dropdown sources actually have DATA before we label-match
      // (key presence isn't enough — a transient failure yields an all-keys,
      // empty-values bundle). Refetch when any type is still empty; getLookups
      // doesn't cache failures, so this recovers a transient blip.
      const ready = LOOKUP_TYPES.every((t) => (lookups[t]?.length ?? 0) > 0);
      const lk = ready ? lookups : await getLookupBundle(LOOKUP_TYPES);
      if (!ready) setLookups(lk);

      // Wire per-file extraction status back into the queue. A doc whose S3
      // upload failed comes back in result.failures[] (by index) and/or with an
      // empty-string s3_url — treat both as "failed" (empty string is NOT caught
      // by `?? null`) so it shows a failed badge and is excluded from submit,
      // rather than looking "extracted" while silently not being attached.
      // The queue is locked during extraction, so `prev` still aligns with the
      // positional result arrays.
      const failedIdx = new Set((result.failures ?? []).map((x) => x.index));
      setFilesQueue((prev) =>
        prev.map((f, idx) => {
          const d = result.documents?.[idx];
          if (!d) return f;
          const url = d.s3_url ? String(d.s3_url) : null; // "" -> null
          const uploadFailed = failedIdx.has(idx) || !url;
          // Narrow rather than assert the backend enum / doc_type.
          const st = d.extraction_status;
          const status: QueuedFile["status"] = uploadFailed
            ? "failed"
            : st === "failed" || st === "skipped" ? st : "ok";
          const dt = typeof d.doc_type === "string" && d.doc_type ? d.doc_type : f.doc_type;
          return {
            ...f,
            status,
            error: uploadFailed ? (d.extraction_error ?? "Upload failed — document was not stored") : (d.extraction_error ?? null),
            s3_url: url,
            doc_type: dt,
            extracted: d,
          };
        }),
      );

      const { nextForm, auto, banks, contracts } = hydrateFromExtraction(result, lk);
      setForm(nextForm);
      setAutoFilled(auto);
      setBankingRows(banks);
      setContractRows(contracts);
      setExtraction(result);
      setStagingId(result.staging_id);
      // Upload failures are non-blocking — surface as a warning (not a red error).
      const failCount = (result.failures?.length ?? 0);
      setWarning(failCount ? `${failCount} document(s) couldn't be stored and won't be attached — attach them later from the desktop app.` : null);
      setStep(2);
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError" || /aborted/i.test((err as Error)?.message || "");
      if (aborted) { setError("Extraction cancelled."); return; }
      if (err instanceof VendorApiError) {
        const byCode: Record<string, string> = {
          too_many_files: `Too many files — max ${MAX_FILES} per batch.`,
          file_too_large: "A file exceeded 25 MB.",
          mime_mismatch: "A file was rejected by MIME sniff.",
          unsupported_media_type: "Only PDF / JPEG / PNG are accepted.",
          storage_unavailable: "Server storage is offline — try again later.",
        };
        setError(byCode[err.code ?? ""] || `Extraction failed — ${err.message}`);
      } else {
        setError(`Extraction failed — ${(err as Error).message}`);
      }
    } finally {
      abortRef.current = null;
      setExtracting(false);
    }
  }
  function cancelExtract() { abortRef.current?.abort(); }

  // Build the pre-filled form + banking/contract rows from an extraction.
  function hydrateFromExtraction(r: ExtractBulkResult, lk: Record<string, LookupRow[]>) {
    const nextForm: FormState = { ...blankForm() };
    const auto = new Set<string>();
    const vf = r.vendor_fields || {};

    // First pass: typed fields (text / checkbox / date / lookup by id-or-label).
    for (const [k, v] of Object.entries(vf)) {
      if (v == null || v === "") continue;
      if (k.endsWith("_label")) continue;
      const fk = k as FormKey;
      const lookType = SELECT_LOOKUP[fk];
      if (lookType) {
        const rows = lk[lookType] || [];
        const direct = rows.find((x) => x.lookup_id === String(v)) ? String(v) : "";
        const resolved = direct || resolveLookupLabel(rows, String(v));
        if (resolved) { nextForm[fk] = resolved; auto.add(k); }
        continue;
      }
      if (k === "is_msme") { nextForm.is_msme = Boolean(v); auto.add(k); continue; }
      if (DATE_FIELDS.has(fk)) { const iso = normaliseISODate(v); if (iso) { nextForm[fk] = iso; auto.add(k); } continue; }
      nextForm[fk] = String(v);
      auto.add(k);
    }
    // Second pass: `<field>_label` hints for lookup-backed selects.
    for (const [k, v] of Object.entries(vf)) {
      if (!k.endsWith("_label") || !v) continue;
      const target = k.slice(0, -"_label".length) as FormKey;
      const lookType = SELECT_LOOKUP[target];
      if (!lookType) continue;
      const id = resolveLookupLabel(lk[lookType] || [], String(v));
      if (id) { nextForm[target] = id; auto.add(target); }
    }

    const atRows = lk[ACCOUNT_TYPE_LOOKUP] || [];
    const banks: BankRow[] = (r.banking_fields || []).map((b) => {
      const rec = b as Record<string, unknown>;
      let atId = String(rec.account_type_id || "");
      const atLabel = rec.account_type_label ? String(rec.account_type_label) : "";
      if (!atId && atLabel) atId = resolveLookupLabel(atRows, atLabel);
      return {
        id: newRowId(),
        bank_name: String(rec.bank_name || ""), account_no: String(rec.account_no || ""),
        account_name: String(rec.account_name || ""), branch: String(rec.branch || ""),
        ifsc: String(rec.ifsc || ""), swift: String(rec.swift || ""),
        account_type_id: atId, account_type_label: atLabel,
        is_primary: Boolean(rec.is_primary), is_active: true, valid_from: "", valid_to: "",
        _source: "extraction",
      };
    });
    if (banks.length && !banks.some((b) => b.is_primary)) banks[0].is_primary = true;

    const contracts: ContractRow[] = (r.contracts || []).map((c) => {
      const rec = c as Record<string, unknown>;
      return {
        id: newRowId(),
        contract_type: String(rec.contract_type || ""),
        // Extraction returns dates as free-form strings (the Anthropic grammar
        // can't enforce a format). Normalise to YYYY-MM-DD so the <input
        // type="date"> fields actually display the value, and so submit sends an
        // ISO date the backend's `date` type accepts.
        signed_date: normaliseISODate(rec.signed_date),
        effective_from: normaliseISODate(rec.effective_from),
        effective_to: normaliseISODate(rec.effective_to),
        value_inr: rec.value_inr != null ? String(rec.value_inr) : "",
        scoc_signed: false, auto_renew: false, s3_url: String(rec.s3_url || ""), _source: "extraction",
      };
    });

    return { nextForm, auto, banks, contracts };
  }

  // ── Banking / contract row mutators (by stable id) ──────────────────────────
  function patchBank(id: string, patch: Partial<BankRow>, clearAuto = false) {
    setBankingRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch, ...(clearAuto ? { _source: undefined } : {}) } : r)));
  }
  function setPrimaryBank(id: string) {
    setBankingRows((rows) => rows.map((r) => ({ ...r, is_primary: r.id === id })));
  }
  function removeBank(id: string) {
    setBankingRows((rows) => {
      const next = rows.filter((r) => r.id !== id);
      if (next.length && !next.some((r) => r.is_primary)) next[0] = { ...next[0], is_primary: true };
      return next;
    });
  }
  function patchContract(id: string, patch: Partial<ContractRow>, clearAuto = false) {
    setContractRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch, ...(clearAuto ? { _source: undefined } : {}) } : r)));
  }
  function removeContract(id: string) { setContractRows((rows) => rows.filter((r) => r.id !== id)); }

  // ── Submit ──────────────────────────────────────────────────────────────────
  function collectVendorBody(): VendorBody {
    const s = (k: FormKey): string | null => { const t = sv(k).trim(); return t === "" ? null : t; };
    return {
      supplier_code: s("supplier_code"), supplier_reg_year: s("supplier_reg_year"),
      name: sv("name").trim(), status: sv("status") || "active",
      supplier_type_id: s("supplier_type_id"), firm_status_id: s("firm_status_id"),
      business_type_id: s("business_type_id"), category_code_id: s("category_code_id"),
      sub_category: s("sub_category"), local_os_id: s("local_os_id"), msme_type_id: s("msme_type_id"),
      scoc_status_id: s("scoc_status_id"), kyc_status_id: s("kyc_status_id"), doc_status_id: s("doc_status_id"),
      supplier_type_other: s("supplier_type_other"), firm_status_other: s("firm_status_other"),
      business_type_other: s("business_type_other"),
      core_business: s("core_business"), contact_person: s("contact_person"), designation: s("designation"),
      phone_company: s("phone_company"), mobile: s("mobile"), email: s("email"), website: s("website"),
      address_line: s("address_line"), state: s("state"), city: s("city"), pin_code: s("pin_code"),
      fssai_no: s("fssai_no"), brc_other: s("brc_other"), cin_no: s("cin_no"), pan_no: s("pan_no"),
      gstn: s("gstn"), iec_no: s("iec_no"), pollution_epr: s("pollution_epr"), tin_tan: s("tin_tan"),
      is_msme: bv("is_msme"), msme_registration_date: s("msme_registration_date"),
      uam_udyam_no: s("uam_udyam_no"), business_turnover_3y: s("business_turnover_3y"),
      capabilities: s("capabilities"), remarks: s("remarks"), reference: s("reference"),
    };
  }

  async function submit() {
    const err = validateStep(step);
    if (err) { showError(err.message, err.focusKey); return; }
    if (createResult) { openVendor(createResult.vendor.vendor_id); return; }
    setError(null);
    setWarning(null);
    setSubmitting(true);

    const vendor = collectVendorBody();
    // Attach every successfully-uploaded document (has an s3_url), regardless of
    // whether Claude extraction succeeded — the backend links on s3_url, not on
    // extraction status. Coerce an unresolved auto type to OTHER so the doc is
    // still linked with a valid DocType. Dates run through normaliseISODate (||
    // null) so a non-ISO/empty extracted date can't 422 the whole transaction.
    const documents: StagedDocumentItem[] = filesQueue
      .filter((f) => !!f.s3_url)
      .map((f) => ({
        s3_url: f.s3_url ?? null,
        doc_type: DOC_TYPE_CODES.has(f.doc_type) ? f.doc_type : FALLBACK_DOC_TYPE,
        doc_number: f.extracted?.doc_number || null,
        issued_on: normaliseISODate(f.extracted?.issued_on) || null,
        valid_from: normaliseISODate(f.extracted?.valid_from) || null,
        valid_to: normaliseISODate(f.extracted?.valid_to) || null,
      }));
    const contracts = contractRows.map((c) => ({
      s3_url: c.s3_url || null, contract_type: c.contract_type || null,
      signed_date: normaliseISODate(c.signed_date) || null,
      effective_from: normaliseISODate(c.effective_from) || null,
      effective_to: normaliseISODate(c.effective_to) || null,
      value_inr: c.value_inr === "" ? null : Number(c.value_inr),
      scoc_signed: !!c.scoc_signed, auto_renew: !!c.auto_renew,
    }));
    const banking = bankingRows.map((b) => ({
      bank_name: b.bank_name, account_no: b.account_no, account_name: b.account_name,
      branch: b.branch || null, ifsc: b.ifsc || null, swift: b.swift || null,
      account_type_id: b.account_type_id || null, is_primary: !!b.is_primary,
      is_active: b.is_active !== false, valid_from: b.valid_from || null, valid_to: b.valid_to || null,
    }));

    try {
      let result: SubmitStagedResult;
      if (stagingId) {
        // Staged path — one atomic transaction, all children committed server-side.
        result = await submitStagedVendor({ staging_id: stagingId, vendor, banking, documents, contracts });
      } else {
        // Skip-manual path — never staged. The vendor + documents go via
        // /with-documents; banking and contracts are posted per-row afterward.
        // Collect non-blocking warnings so the success screen never overstates
        // what was actually saved.
        const skipFiles = filesQueue.map((f) => f.file);
        const skipMeta = filesQueue.map((f) => ({ doc_type: f.doc_type === AUTO_DOC_TYPE ? FALLBACK_DOC_TYPE : f.doc_type }));
        const warnings: string[] = [];

        // /with-documents checks vendor.document.create BEFORE creating the
        // vendor when files are attached. A master.create-only operator would
        // otherwise be unable to create the vendor at all — on a 403 fall back to
        // creating it document-free and warn, rather than aborting onboarding.
        const created = await createVendorWithDocuments(vendor, skipFiles, skipMeta).catch(
          async (e: unknown) => {
            if (skipFiles.length && e instanceof VendorApiError && e.status === 403) {
              warnings.push(`${skipFiles.length} document(s) weren't attached — you don't have permission to upload vendor documents.`);
              return createVendorWithDocuments(vendor, [], []);
            }
            throw e;
          },
        );
        const vendorId = created.vendor.vendor_id;

        // Per-file upload failures come back in `failures` (HTTP 201) — surface them.
        const docFails = Array.isArray(created.failures) ? created.failures.length : 0;
        if (docFails) warnings.push(`${docFails} document(s) couldn't be stored and weren't attached.`);

        // Banking + contracts are posted per row; surface any that fail rather
        // than silently dropping them.
        let savedBanking: BankingResponse[] = [];
        if (banking.length) {
          const settled = await Promise.allSettled(banking.map((b) => addBanking(vendorId, b)));
          savedBanking = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
          const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
          if (failed.length) {
            const first = failed[0].reason as Error | undefined;
            warnings.push(`${failed.length} of ${banking.length} banking row(s) couldn't be saved${first?.message ? ` (${first.message})` : ""}.`);
          }
        }
        let savedContracts: ContractResponse[] = [];
        if (contracts.length) {
          const settled = await Promise.allSettled(
            contracts.map((c) => addContract(vendorId, {
              contract_type: c.contract_type, signed_date: c.signed_date,
              effective_from: c.effective_from, effective_to: c.effective_to,
              s3_urls: c.s3_url || "", value_inr: c.value_inr,
              scoc_signed: c.scoc_signed, auto_renew: c.auto_renew,
            })),
          );
          savedContracts = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
          const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
          if (failed.length) {
            const first = failed[0].reason as Error | undefined;
            warnings.push(`${failed.length} of ${contracts.length} contract(s) couldn't be saved${first?.message ? ` (${first.message})` : ""}.`);
          }
        }

        if (warnings.length) setWarning(`Vendor created, but: ${warnings.join(" ")}`);
        result = {
          vendor: created.vendor,
          banking: savedBanking,
          // /with-documents returns DocumentUploadResponse[] ({document, extracted});
          // unwrap to the committed DocumentResponse rows.
          documents: (created.documents || []).map((d) => d.document),
          contracts: savedContracts,
        };
      }
      setCreateResult(result);
      setStep(TOTAL_STEPS); // pin to the review/success pane regardless of where the operator was
    } catch (e) {
      // A staging session that expired / was consumed is recoverable — reset it
      // and send the operator back to Step 1 to re-extract, rather than stranding
      // them on Step 6 with a generic error.
      const staleStaging = new Set(["staging_not_found", "staging_already_consumed", "staging_expired"]);
      if (e instanceof VendorApiError && staleStaging.has(e.code ?? "")) {
        setStagingId(null);
        setExtraction(null);
        setError(`This extraction session is no longer valid — please re-run extraction. (${e.message})`);
        setStep(1);
      } else {
        setError(`Couldn't create vendor — ${(e as Error).message}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function openVendor(vendorId: string) {
    // Vendor detail isn't ported yet — return to the module landing.
    router.push(`/modules/purchase/vendor-management?created=${encodeURIComponent(vendorId)}`);
  }

  // Hold auth/data branches until after mount so SSR and the first client
  // paint are byte-identical (see the hydration-gate note above).
  if (!mounted) {
    return (
      <PurchaseChrome title="New Vendor">
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading…
          </span>
        </div>
      </PurchaseChrome>
    );
  }
  if (!authed) return <></>;

  const okDocs = filesQueue.filter((f) => f.status === "ok").length;
  const nextLabel = step === TOTAL_STEPS ? (submitting ? "Submitting…" : "Submit vendor") : "Next";

  return (
    <PurchaseChrome title="New Vendor">
      <div className="mb-3">
        <BackLink parentHref="/modules/purchase/vendor-management" label="Vendor Management" />
      </div>
      <div className="mb-5">
        <h1 className="text-[22px] leading-[28px] font-semibold text-[var(--text-primary)]">Onboard new vendor</h1>
        <p className="text-[13px] text-[var(--text-secondary)] mt-1">
          Upload all compliance documents first — we&rsquo;ll auto-fill every tab. Review, edit, then submit.
        </p>
      </div>

      {/* Step bar */}
      <StepBar current={step} />

      <div className="bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-5 mt-4">
        {step === 1 && (
          <Step1
            filesQueue={filesQueue} extraction={extraction} extracting={extracting} drag={drag}
            fileInputRef={fileInputRef}
            onDrag={setDrag} onAddFiles={addFiles} onRemoveFile={removeFile} onSetDocType={setFileDocType}
            onRun={runExtract} onCancel={cancelExtract}
            onSkip={() => { setSkipped(true); setError(null); setStep(2); }}
            onPickConflict={(field, value) => {
              // Write the picked value, then re-add the key to autoFilled so the
              // Step 2/3 field shows it with the "auto" badge (setField clears it).
              setField(field as FormKey, value);
              setAutoFilled((a) => { const n = new Set(a); n.add(field); return n; });
            }}
          />
        )}
        {step === 2 && (
          <Step2 sv={sv} setField={setField} auto={autoFilled} lookups={lookups} />
        )}
        {step === 3 && (
          <Step3 sv={sv} bv={bv} setField={setField} auto={autoFilled} lookups={lookups} />
        )}
        {step === 4 && (
          <Step4
            rows={bankingRows} lookups={lookups}
            onPatch={patchBank} onPrimary={setPrimaryBank} onRemove={removeBank}
            onAdd={() => setBankingRows((r) => [...r, blankBank(r.length === 0)])}
          />
        )}
        {step === 5 && (
          <Step5
            rows={contractRows} onPatch={patchContract} onRemove={removeContract}
            onAdd={() => setContractRows((r) => [...r, blankContract()])}
          />
        )}
        {step === 6 && (
          <Step6
            body={collectVendorBody()} bankingRows={bankingRows} contractRows={contractRows}
            filesQueue={filesQueue} okDocs={okDocs} createResult={createResult}
            onOpen={openVendor} onList={() => router.push("/modules/purchase/vendor-management")}
          />
        )}
      </div>

      {/* Error strip (blocking) — announced + focusable for AT */}
      {error && (
        <p ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive"
          className="mt-3 text-[12px] text-[var(--aws-error)] bg-[#fdf3f1] border border-[#f5c6bc] rounded px-3 py-2 outline-none">
          {error}
        </p>
      )}
      {/* Warning strip (non-blocking, incl. "vendor created, but…") — amber, not red */}
      {warning && (
        <p role="status" aria-live="polite"
          className="mt-3 text-[12px] text-[#7a5b00] bg-[#fdf6e3] border border-[#f0d98a] rounded px-3 py-2">
          {warning}
        </p>
      )}

      {/* Actions */}
      {!createResult && (
        <div className="flex items-center justify-between mt-4">
          <button
            type="button" onClick={onCancel} disabled={submitting}
            className="h-9 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button" onClick={goPrev} disabled={step === 1 || submitting}
              className="h-9 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              type="button" onClick={goNext}
              disabled={submitting || (step === 1 && !canAdvanceStep1)}
              className="h-9 px-5 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[#002244] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {submitting && <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {nextLabel}
            </button>
          </div>
        </div>
      )}
    </PurchaseChrome>
  );
}

// ── Step bar ─────────────────────────────────────────────────────────────────
function StepBar({ current }: { current: number }): React.JSX.Element {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const state = n === current ? "active" : n < current ? "done" : "todo";
        return (
          <li key={label} aria-current={state === "active" ? "step" : undefined} className="flex items-center gap-1.5">
            <span
              className={[
                "inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-bold",
                state === "active" ? "bg-[var(--aws-navy)] text-white"
                  : state === "done" ? "bg-[#eaf6ed] text-[#1d8102] border border-[#b6dbb1]"
                    : "bg-[var(--surface-disabled)] text-[var(--text-muted)]",
              ].join(" ")}
            >
              {n}
            </span>
            <span className={["text-[12px]", state === "active" ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"].join(" ")}>
              {label}
            </span>
            {n < STEP_LABELS.length && <span className="text-[var(--text-muted)] mx-1" aria-hidden>›</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ── Shared field primitives ────────────────────────────────────────────────
const INPUT_CLS =
  "w-full h-8 px-2 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] outline-none focus:border-[#9a393e] focus:shadow-[0_0_0_1px_#9a393e] bg-white disabled:opacity-50";

function Field({ label, htmlFor, required, auto, wide, children }: {
  label: string; htmlFor?: string; required?: boolean; auto?: boolean; wide?: boolean; children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={wide ? "sm:col-span-2 lg:col-span-3" : ""}>
      <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)] mb-1">
        {label}
        {required && <span className="text-[var(--aws-error)]">*</span>}
        {auto && (
          <span className="inline-flex items-center h-4 px-1.5 text-[9px] font-bold uppercase tracking-wide rounded-full bg-[#eef3ff] text-[#0972d3] border border-[#b8d4f5]">
            auto
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function TextField({ def, value, auto, onChange }: {
  def: FieldDef; value: string; auto: boolean; onChange: (v: string) => void;
}): React.JSX.Element {
  const id = `f-${def.key}`;
  return (
    <Field label={def.label} htmlFor={id} auto={auto} wide={def.wide}>
      <input
        id={id} type={def.type ?? "text"} value={value} spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={[INPUT_CLS, def.mono ? "font-mono" : ""].join(" ")}
      />
    </Field>
  );
}

function LookupSelect({ id, label, value, auto, rows, onChange, otherValue, onOtherChange }: {
  id: string; label: string; value: string; auto: boolean; rows: LookupRow[]; onChange: (v: string) => void;
  otherValue?: string; onOtherChange?: (v: string) => void;
}): React.JSX.Element {
  // When this select supports an "Others" companion, resolve the id of the
  // "Others" option so we can reveal the free-text input only for that choice.
  const othersId = onOtherChange
    ? ((rows || []).find((r) => (r.label || r.code || "").trim().toLowerCase() === "others")?.lookup_id ?? null)
    : null;
  const showOther = othersId != null && value === othersId;
  return (
    <Field label={label} htmlFor={id} auto={auto}>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v);
          // Clear the companion text when the operator switches away from "Others".
          if (onOtherChange && v !== othersId) onOtherChange("");
        }}
        className={INPUT_CLS}
      >
        <option value="">—</option>
        {(rows || []).map((r) => (
          <option key={r.lookup_id} value={r.lookup_id}>{r.label || r.code}</option>
        ))}
      </select>
      {showOther && (
        <input
          id={`${id}-other`}
          value={otherValue ?? ""}
          maxLength={200}
          spellCheck={false}
          placeholder={`Specify ${label.toLowerCase()}`}
          aria-label={`${label} — please specify`}
          onChange={(e) => onOtherChange?.(e.target.value)}
          className={`${INPUT_CLS} mt-1.5`}
        />
      )}
    </Field>
  );
}

const GRID = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3";
const SECTION_TITLE = "text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2 mt-5";

// ── Step 1: Upload + Extract ───────────────────────────────────────────────
function Step1({
  filesQueue, extraction, extracting, drag, fileInputRef,
  onDrag, onAddFiles, onRemoveFile, onSetDocType, onRun, onCancel, onSkip, onPickConflict,
}: {
  filesQueue: QueuedFile[]; extraction: ExtractBulkResult | null; extracting: boolean; drag: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDrag: (v: boolean) => void; onAddFiles: (f: FileList | File[]) => void;
  onRemoveFile: (id: string) => void; onSetDocType: (id: string, dt: string) => void;
  onRun: () => void; onCancel: () => void; onSkip: () => void;
  onPickConflict: (field: string, value: string) => void;
}): React.JSX.Element {
  const conflicts = extraction?.conflicts ?? [];
  // Which candidate the user picked per conflicting field — drives the selected/
  // sibling-disabled styling (mirrors the Electron picker's btn.disabled lock-in).
  const [picked, setPicked] = useState<Record<string, string>>({});
  const locked = extraction != null || extracting; // queue is read-only while/after extraction
  const okCount = filesQueue.filter((f) => f.status === "ok").length;
  const failCount = filesQueue.filter((f) => f.status === "failed").length;
  const openPicker = () => { if (!locked) fileInputRef.current?.click(); };
  return (
    <div>
      <h2 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Drop the vendor&rsquo;s documents</h2>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">
        PAN, GST, FSSAI, cancelled cheque, MSA / contract — drop them all in. We&rsquo;ll extract every field across
        every tab in one pass, and you can correct anything before submitting.
      </p>

      <div
        role="button" tabIndex={locked ? -1 : 0} aria-label="Upload compliance documents" aria-disabled={locked}
        onClick={openPicker}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!locked) onDrag(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onDrag(false); }}
        onDrop={(e) => { e.preventDefault(); onDrag(false); if (!locked && e.dataTransfer.files?.length) onAddFiles(e.dataTransfer.files); }}
        className={[
          "relative border-2 border-dashed rounded-md p-6 text-center transition outline-none focus-visible:border-[var(--aws-navy)] focus-visible:shadow-[0_0_0_2px_rgba(0,34,68,0.2)]",
          drag ? "border-[var(--aws-orange)] bg-[#fbeced]" : "border-[var(--aws-border-strong)] hover:border-[var(--aws-navy)]",
          locked ? "pointer-events-none opacity-60 cursor-default" : "cursor-pointer",
        ].join(" ")}
      >
        <input
          ref={fileInputRef} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden" tabIndex={-1}
          onChange={(e) => { if (e.target.files?.length) onAddFiles(e.target.files); e.target.value = ""; }}
        />
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth={1.4}
          strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-[var(--text-muted)] mb-2" aria-hidden>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p className="text-[13px] font-semibold text-[var(--text-primary)]">Drop PDFs / JPEGs / PNGs here or click to browse</p>
        <p className="text-[12px] text-[var(--text-secondary)] mt-1">Up to {MAX_FILES} files · 25 MB each · doc type auto-detected</p>
      </div>

      {filesQueue.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {filesQueue.map((f) => (
            <div key={f.id} className="flex items-center gap-2 border border-[var(--aws-border)] rounded-[2px] px-3 py-2 bg-[var(--surface-subtle)]">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-[var(--text-primary)] truncate" title={f.file.name}>{f.file.name}</div>
                <div className="text-[10px] text-[var(--text-muted)]">{(f.file.size / 1024).toFixed(0)} KB</div>
              </div>
              {locked ? (
                <span className="text-[11px] text-[var(--text-secondary)]">{f.doc_type === AUTO_DOC_TYPE ? "auto" : f.doc_type}</span>
              ) : (
                <select value={f.doc_type} onChange={(e) => onSetDocType(f.id, e.target.value)} aria-label={`Document type for ${f.file.name}`}
                  className="h-7 px-2 text-[11px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white">
                  <option value={AUTO_DOC_TYPE}>Auto-detect</option>
                  {DOC_TYPE.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
              )}
              {f.status === "ok" && (
                <span className="inline-flex items-center h-5 px-1.5 text-[10px] font-bold rounded-[2px] bg-[#eaf6ed] text-[#1d8102] border border-[#b6dbb1]">extracted</span>
              )}
              {f.status === "failed" && (
                <span title={f.error ?? ""} className="inline-flex items-center h-5 px-1.5 text-[10px] font-bold rounded-[2px] bg-[#fbeced] text-[#9a393e] border border-[#e6bcbe]">failed</span>
              )}
              {!locked && (
                <button type="button" onClick={() => onRemoveFile(f.id)} aria-label={`Remove ${f.file.name}`}
                  className="text-[var(--text-muted)] hover:text-[var(--aws-error)] p-1">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {filesQueue.length > 0 && !extraction && (
        <div className="flex items-center justify-end gap-2 mt-4">
          <button type="button" onClick={onSkip} disabled={extracting}
            className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] disabled:opacity-50">
            Skip — fill manually
          </button>
          {extracting ? (
            <button type="button" onClick={onCancel}
              className="h-8 px-4 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
              Cancel
            </button>
          ) : (
            <button type="button" onClick={onRun}
              className="h-8 px-4 text-[12px] font-semibold rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[#002244] flex items-center gap-2">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
              Extract &amp; fill form
            </button>
          )}
        </div>
      )}

      {extracting && (
        <p className="mt-3 text-[12px] text-[var(--text-secondary)]">Uploading files and running extraction… this may take 20–30s.</p>
      )}

      {filesQueue.length === 0 && (
        <div className="flex items-center justify-end mt-4">
          <button type="button" onClick={onSkip}
            className="h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">
            Skip — fill the form manually
          </button>
        </div>
      )}

      {extraction && (
        <div className={[
          "mt-4 rounded-md px-4 py-3 border",
          failCount ? "border-[#f0d98a] bg-[#fdf6e3]" : "border-[#b6dbb1] bg-[#eaf6ed]",
        ].join(" ")}>
          <div className={["text-[13px] font-semibold flex items-center gap-2", failCount ? "text-[#7a5b00]" : "text-[#1d5a1d]"].join(" ")}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={failCount ? "#c58a00" : "#1d8102"} strokeWidth={2}><path d="M20 6L9 17l-5-5" /></svg>
            Extracted {okCount} of {filesQueue.length} document(s){failCount ? ` · ${failCount} failed` : ""} — review the auto-filled form.
          </div>
          {/* Per-document detail (doc_type · doc_number · status) — matches the Electron summary. */}
          <ul className="mt-2 space-y-0.5">
            {filesQueue.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <span className="font-semibold text-[var(--text-primary)]">{f.doc_type === AUTO_DOC_TYPE ? "—" : f.doc_type}</span>
                {f.extracted?.doc_number ? <span className="font-mono">{String(f.extracted.doc_number)}</span> : null}
                <span className="text-[var(--text-muted)] truncate">{f.file.name}</span>
                {f.status === "failed" && <span className="text-[#9a393e]" title={f.error ?? ""}>· failed</span>}
              </li>
            ))}
          </ul>
          {conflicts.length > 0 && (
            <div className="mt-3 border-t border-[var(--aws-border)] pt-3">
              <p className="text-[12px] font-semibold text-[var(--text-primary)]">
                {conflicts.length} field{conflicts.length === 1 ? "" : "s"} need your choice
              </p>
              <p className="text-[11px] text-[var(--text-secondary)] mb-2">
                Documents disagreed — pick the value to keep. Your choice is written to the form and badged{" "}
                <span className="text-[var(--aws-link)] font-semibold">auto</span>.
              </p>
              <ul className="space-y-2">
                {conflicts.map((c) => (
                  <li key={c.field} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-[var(--text-primary)] mr-1">{c.field}</span>
                    {(c.values_seen ?? []).map((v, vi) => {
                      const isPicked = picked[c.field] === v;
                      const hasPick = picked[c.field] !== undefined;
                      return (
                        <button
                          key={`${c.field}:${vi}`}
                          type="button"
                          disabled={hasPick && !isPicked}
                          onClick={() => {
                            setPicked((p) => ({ ...p, [c.field]: v }));
                            onPickConflict(c.field, v);
                          }}
                          className={[
                            "h-6 px-2 text-[11px] rounded-[2px] border transition-colors",
                            isPicked
                              ? "border-[var(--aws-link)] bg-[#eef3ff] text-[var(--aws-link)] font-semibold"
                              : "border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]",
                            hasPick && !isPicked ? "opacity-40 cursor-not-allowed" : "",
                          ].join(" ")}
                        >
                          {v}
                          {c.sources?.[vi] ? (
                            <span className="ml-1 text-[9px] text-[var(--text-muted)]">({c.sources[vi]})</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step 2: Basics ─────────────────────────────────────────────────────────
function Step2({ sv, setField, auto, lookups }: {
  sv: (k: FormKey) => string; setField: (k: FormKey, v: FormValue) => void;
  auto: Set<string>; lookups: Record<string, LookupRow[]>;
}): React.JSX.Element {
  return (
    <div>
      <h2 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Vendor basics</h2>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">Fields pre-filled from extraction are badged <span className="text-[#0972d3] font-semibold">auto</span>. Edit anything that&rsquo;s wrong.</p>

      <div className={GRID}>
        <Field label="Vendor name" htmlFor="f-name" required auto={auto.has("name")} wide>
          <input id="f-name" value={sv("name")} maxLength={512} placeholder="Legal name (e.g. Acme Foods Pvt Ltd)"
            onChange={(e) => setField("name", e.target.value)} className={INPUT_CLS} />
        </Field>
        <Field label="Status" htmlFor="f-status" auto={auto.has("status")}>
          <select id="f-status" value={sv("status") || "active"} onChange={(e) => setField("status", e.target.value)} className={INPUT_CLS}>
            {VENDOR_STATUS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </Field>
        {BASICS_TEXT.map((d) => (
          <TextField key={d.key} def={d} value={sv(d.key)} auto={auto.has(d.key)} onChange={(v) => setField(d.key, v)} />
        ))}
        {BASICS_SELECTS.map((s) => {
          const otherKey = OTHER_OF[s.key];
          return (
            <LookupSelect key={s.key} id={`f-${s.key}`} label={s.label} value={sv(s.key)} auto={auto.has(s.key)}
              rows={lookups[s.type] || []} onChange={(v) => setField(s.key, v)}
              otherValue={otherKey ? sv(otherKey) : undefined}
              onOtherChange={otherKey ? (v) => setField(otherKey, v) : undefined} />
          );
        })}
      </div>

      <div className={SECTION_TITLE}>Contact &amp; address</div>
      <div className={GRID}>
        {CONTACT_FIELDS.map((d) => (
          <TextField key={d.key} def={d} value={sv(d.key)} auto={auto.has(d.key)} onChange={(v) => setField(d.key, v)} />
        ))}
      </div>

      <div className={SECTION_TITLE}>Notes &amp; references</div>
      <div className={GRID}>
        {NOTES_FIELDS.map((d) => (
          <TextField key={d.key} def={d} value={sv(d.key)} auto={auto.has(d.key)} onChange={(v) => setField(d.key, v)} />
        ))}
      </div>
    </div>
  );
}

// ── Step 3: Compliance ─────────────────────────────────────────────────────
function Step3({ sv, bv, setField, auto, lookups }: {
  sv: (k: FormKey) => string; bv: (k: FormKey) => boolean; setField: (k: FormKey, v: FormValue) => void;
  auto: Set<string>; lookups: Record<string, LookupRow[]>;
}): React.JSX.Element {
  return (
    <div>
      <h2 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Compliance &amp; KYC identifiers</h2>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">Identifiers picked up from the uploaded docs are pre-filled. Empty fields can be added later.</p>

      <div className={GRID}>
        {COMPLIANCE_FIELDS.map((d) => (
          <TextField key={d.key} def={d} value={sv(d.key)} auto={auto.has(d.key)} onChange={(v) => setField(d.key, v)} />
        ))}
      </div>

      <div className={SECTION_TITLE}>MSME</div>
      <div className={GRID}>
        <Field label="Is MSME?" htmlFor="f-is_msme" auto={auto.has("is_msme")}>
          <label className="inline-flex items-center gap-2 h-8 cursor-pointer">
            <input id="f-is_msme" type="checkbox" checked={bv("is_msme")} onChange={(e) => setField("is_msme", e.target.checked)}
              className="w-4 h-4 accent-[var(--aws-navy)]" />
            <span className="text-[12px] text-[var(--text-secondary)]">Registered under MSME</span>
          </label>
        </Field>
        <LookupSelect id={`f-${MSME_SELECT.key}`} label={MSME_SELECT.label} value={sv("msme_type_id")} auto={auto.has("msme_type_id")}
          rows={lookups[MSME_SELECT.type] || []} onChange={(v) => setField("msme_type_id", v)} />
        <Field label="MSME registration date" htmlFor="f-msme_registration_date" auto={auto.has("msme_registration_date")}>
          <input id="f-msme_registration_date" type="date" value={sv("msme_registration_date")} onChange={(e) => setField("msme_registration_date", e.target.value)} className={INPUT_CLS} />
        </Field>
        <TextField def={{ key: "uam_udyam_no", label: "UAM / Udyam No", mono: true }} value={sv("uam_udyam_no")}
          auto={auto.has("uam_udyam_no")} onChange={(v) => setField("uam_udyam_no", v)} />
      </div>

      <div className={SECTION_TITLE}>Status flags</div>
      <div className={GRID}>
        {STATUS_SELECTS.map((s) => (
          <LookupSelect key={s.key} id={`f-${s.key}`} label={s.label} value={sv(s.key)} auto={auto.has(s.key)}
            rows={lookups[s.type] || []} onChange={(v) => setField(s.key, v)} />
        ))}
      </div>
    </div>
  );
}

// ── Step 4: Banking ────────────────────────────────────────────────────────
function Step4({ rows, lookups, onPatch, onPrimary, onRemove, onAdd }: {
  rows: BankRow[]; lookups: Record<string, LookupRow[]>;
  onPatch: (id: string, patch: Partial<BankRow>, clearAuto?: boolean) => void;
  onPrimary: (id: string) => void; onRemove: (id: string) => void; onAdd: () => void;
}): React.JSX.Element {
  const atRows = lookups[ACCOUNT_TYPE_LOOKUP] || [];
  return (
    <div>
      <h2 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Banking</h2>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">Rows badged <span className="text-[#0972d3] font-semibold">auto</span> came from a cancelled-cheque / passbook upload. Edit, mark the primary row, or add more.</p>

      {rows.length === 0 ? (
        <div className="border border-dashed border-[var(--aws-border-strong)] rounded-md p-6 text-center text-[13px] text-[var(--text-secondary)]">
          No banking rows yet — optional, but required before SCM-Head approval.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="relative border border-[var(--aws-border)] rounded-md p-3 bg-[var(--surface-subtle)]">
              {r._source === "extraction" && (
                <span className="absolute -top-2 left-3 inline-flex items-center h-4 px-1.5 text-[9px] font-bold uppercase rounded-full bg-[#eef3ff] text-[#0972d3] border border-[#b8d4f5]">auto</span>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <Field label="Bank name" htmlFor={`b-${r.id}-bank_name`} required>
                  <input id={`b-${r.id}-bank_name`} value={r.bank_name} onChange={(e) => onPatch(r.id, { bank_name: e.target.value }, true)} className={INPUT_CLS} />
                </Field>
                <Field label="Account no" htmlFor={`b-${r.id}-account_no`} required>
                  <input id={`b-${r.id}-account_no`} value={r.account_no} onChange={(e) => onPatch(r.id, { account_no: e.target.value }, true)} className={[INPUT_CLS, "font-mono"].join(" ")} />
                </Field>
                <Field label="Account holder" htmlFor={`b-${r.id}-account_name`} required>
                  <input id={`b-${r.id}-account_name`} value={r.account_name} onChange={(e) => onPatch(r.id, { account_name: e.target.value }, true)} className={INPUT_CLS} />
                </Field>
                <Field label="IFSC" htmlFor={`b-${r.id}-ifsc`}>
                  <input id={`b-${r.id}-ifsc`} value={r.ifsc} maxLength={11} onChange={(e) => onPatch(r.id, { ifsc: e.target.value.toUpperCase() }, true)} className={[INPUT_CLS, "font-mono"].join(" ")} />
                </Field>
                <Field label="Branch" htmlFor={`b-${r.id}-branch`}>
                  <input id={`b-${r.id}-branch`} value={r.branch} onChange={(e) => onPatch(r.id, { branch: e.target.value }, true)} className={INPUT_CLS} />
                </Field>
                <Field label="SWIFT" htmlFor={`b-${r.id}-swift`}>
                  <input id={`b-${r.id}-swift`} value={r.swift} onChange={(e) => onPatch(r.id, { swift: e.target.value }, true)} className={[INPUT_CLS, "font-mono"].join(" ")} />
                </Field>
                <Field label="Account type" htmlFor={`b-${r.id}-account_type`}>
                  <select id={`b-${r.id}-account_type`} value={r.account_type_id} onChange={(e) => onPatch(r.id, { account_type_id: e.target.value }, true)} className={INPUT_CLS}>
                    <option value="">—</option>
                    {atRows.map((a) => <option key={a.lookup_id} value={a.lookup_id}>{a.label || a.code}</option>)}
                  </select>
                </Field>
              </div>
              <div className="flex items-center gap-4 mt-3">
                <label className="inline-flex items-center gap-1.5 text-[12px] cursor-pointer">
                  <input type="radio" name="primaryBank" checked={r.is_primary} onChange={() => onPrimary(r.id)} className="accent-[var(--aws-navy)]" />
                  Primary
                </label>
                <button type="button" onClick={() => onRemove(r.id)} className="text-[12px] text-[var(--aws-error)] hover:underline ml-auto">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button type="button" onClick={onAdd} className="mt-3 h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        Add banking row
      </button>
    </div>
  );
}

// ── Step 5: Contracts ──────────────────────────────────────────────────────
function Step5({ rows, onPatch, onRemove, onAdd }: {
  rows: ContractRow[];
  onPatch: (id: string, patch: Partial<ContractRow>, clearAuto?: boolean) => void;
  onRemove: (id: string) => void; onAdd: () => void;
}): React.JSX.Element {
  return (
    <div>
      <h2 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Contracts</h2>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">Contract PDFs uploaded earlier appear here with extracted dates / value pre-filled. Add rows for additional agreements.</p>

      {rows.length === 0 ? (
        <div className="border border-dashed border-[var(--aws-border-strong)] rounded-md p-6 text-center text-[13px] text-[var(--text-secondary)]">
          No contracts attached — add rows if you have signed agreements, MSAs or NDAs to record.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => (
            <div key={c.id} className="relative border border-[var(--aws-border)] rounded-md p-3 bg-[var(--surface-subtle)]">
              {c._source === "extraction" && (
                <span className="absolute -top-2 left-3 inline-flex items-center h-4 px-1.5 text-[9px] font-bold uppercase rounded-full bg-[#eef3ff] text-[#0972d3] border border-[#b8d4f5]">auto</span>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <Field label="Type" htmlFor={`c-${c.id}-type`}>
                  <select id={`c-${c.id}-type`} value={c.contract_type} onChange={(e) => onPatch(c.id, { contract_type: e.target.value }, true)} className={INPUT_CLS}>
                    <option value="">—</option>
                    {CONTRACT_TYPE.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Signed date" htmlFor={`c-${c.id}-signed`}>
                  <input id={`c-${c.id}-signed`} type="date" value={c.signed_date} onChange={(e) => onPatch(c.id, { signed_date: e.target.value }, true)} className={INPUT_CLS} />
                </Field>
                <Field label="Value (₹)" htmlFor={`c-${c.id}-value`}>
                  <input id={`c-${c.id}-value`} type="number" step="any" value={c.value_inr} onChange={(e) => onPatch(c.id, { value_inr: e.target.value }, true)} className={[INPUT_CLS, "font-mono"].join(" ")} />
                </Field>
                <Field label="Effective from" htmlFor={`c-${c.id}-from`}>
                  <input id={`c-${c.id}-from`} type="date" value={c.effective_from} onChange={(e) => onPatch(c.id, { effective_from: e.target.value }, true)} className={INPUT_CLS} />
                </Field>
                <Field label="Effective to" htmlFor={`c-${c.id}-to`}>
                  <input id={`c-${c.id}-to`} type="date" value={c.effective_to} onChange={(e) => onPatch(c.id, { effective_to: e.target.value }, true)} className={INPUT_CLS} />
                </Field>
              </div>
              <div className="flex items-center gap-4 mt-3">
                <label className="inline-flex items-center gap-1.5 text-[12px] cursor-pointer">
                  <input type="checkbox" checked={c.scoc_signed} onChange={(e) => onPatch(c.id, { scoc_signed: e.target.checked }, true)} className="accent-[var(--aws-navy)]" /> SCOC signed
                </label>
                <label className="inline-flex items-center gap-1.5 text-[12px] cursor-pointer">
                  <input type="checkbox" checked={c.auto_renew} onChange={(e) => onPatch(c.id, { auto_renew: e.target.checked }, true)} className="accent-[var(--aws-navy)]" /> Auto-renew
                </label>
                <button type="button" onClick={() => onRemove(c.id)} className="text-[12px] text-[var(--aws-error)] hover:underline ml-auto">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button type="button" onClick={onAdd} className="mt-3 h-8 px-3 text-[12px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)] inline-flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        Add contract row
      </button>
    </div>
  );
}

// ── Step 6: Review & result ────────────────────────────────────────────────
function Step6({ body, bankingRows, contractRows, filesQueue, okDocs, createResult, onOpen, onList }: {
  body: VendorBody; bankingRows: BankRow[]; contractRows: ContractRow[];
  filesQueue: QueuedFile[]; okDocs: number; createResult: SubmitStagedResult | null;
  onOpen: (id: string) => void; onList: () => void;
}): React.JSX.Element {
  const addr = [body.address_line, body.city, body.state, body.pin_code].filter(Boolean).join(", ");
  const compliance = (["fssai_no", "pan_no", "gstn", "cin_no", "iec_no", "tin_tan", "pollution_epr", "brc_other"] as const)
    .filter((k) => body[k]).map((k) => ({ k, v: String(body[k]) }));
  const contact = (
    [["Person", body.contact_person], ["Designation", body.designation], ["Mobile", body.mobile],
     ["Company phone", body.phone_company], ["Email", body.email], ["Website", body.website]] as const
  ).filter(([, v]) => v);
  const docTypes = [...new Set(filesQueue.filter((f) => f.status === "ok").map((f) => f.doc_type))].join(", ");
  const primary = bankingRows.filter((b) => b.is_primary).length;

  if (createResult) {
    const v = createResult.vendor;
    return (
      <div>
        <div className="border border-[#b6dbb1] bg-[#eaf6ed] rounded-md px-4 py-3 mb-4 flex items-center gap-2">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1d8102" strokeWidth={2}><polyline points="20 6 9 17 4 12" /></svg>
          <span className="text-[14px] font-semibold text-[#1d5a1d]">Vendor created</span>
        </div>
        <Card title="Created">
          <Row label="Vendor ID" mono value={v.vendor_id} />
          <Row label="Supplier code" mono value={v.supplier_code || "—"} />
          <Row label="Documents committed" value={String((createResult.documents || []).length)} />
          <Row label="Contracts committed" value={String((createResult.contracts || []).length)} />
          <Row label="Banking rows" value={String((createResult.banking || []).length)} />
        </Card>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button type="button" onClick={onList} className="h-9 px-4 text-[13px] rounded-[2px] border border-[var(--aws-border-strong)] bg-white hover:border-[var(--aws-navy)]">Back to list</button>
          <button type="button" onClick={() => onOpen(v.vendor_id)} className="h-9 px-5 text-[13px] font-semibold rounded-[2px] bg-[var(--aws-navy)] text-white hover:bg-[#002244]">Open vendor</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Review &amp; submit</h2>
      <p className="text-[12px] text-[var(--text-secondary)] mb-4">Final check. On submit the vendor, banking, documents and contracts commit in one transaction — staged files promote to the vendor&rsquo;s permanent path.</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card title="Basics">
          <Row label="Name" value={body.name || "—"} />
          <Row label="Status" value={body.status || "active"} />
          <Row label="Reg year" value={body.supplier_reg_year || "—"} />
          <Row label="Address" value={addr || "—"} />
        </Card>
        <Card title="Contact">
          {contact.length ? contact.map(([label, v]) => <Row key={label} label={label} value={String(v)} />)
            : <Row label="—" value="No contact info" />}
        </Card>
        <Card title="Compliance">
          {compliance.length ? compliance.map((c) => <Row key={c.k} label={c.k.toUpperCase()} mono value={c.v} />)
            : <Row label="—" value="No identifiers" />}
          <Row label="MSME" value={body.is_msme ? "Yes" : "No"} />
        </Card>
        <Card title="Banking">
          <Row label="Rows" value={`${bankingRows.length} (${primary} primary)`} />
        </Card>
        <Card title="Documents">
          <Row label="Extracted" value={`${okDocs} / ${filesQueue.length}`} />
          {docTypes && <Row label="Types" value={docTypes} />}
        </Card>
        <Card title="Contracts">
          <Row label="Rows" value={String(contractRows.length)} />
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border border-[var(--aws-border)] rounded-md p-4">
      <h4 className="text-[10px] uppercase tracking-wide font-bold text-[var(--text-muted)] mb-2">{title}</h4>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className={["text-[var(--text-primary)] text-right", mono ? "font-mono" : ""].join(" ")}>{value}</span>
    </div>
  );
}

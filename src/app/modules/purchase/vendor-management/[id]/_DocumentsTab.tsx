"use client";

// Documents pane (spec §3D) — table + type filter + upload-and-extract (with the
// 400ms file-picker-cancel guard) + manual/append/edit/delete + doc modal with
// expiry badges and file chips.

import { useEffect, useRef, useState } from "react";
import {
  addDocument,
  appendDocumentFile,
  deleteDocument,
  DOC_TYPE,
  listDocuments,
  patchDocument,
  s3UrlsToArray,
  s3UrlsToCsv,
  uploadAndSaveDocument,
  UPLOAD_ACCEPT,
  validateUploadFile,
  VendorApiError,
  type DocumentCreateBody,
  type DocumentResponse,
  type ExtractedDocRow,
  type LookupRow,
} from "@/lib/vendor";
import {
  Badge,
  CARD_CLS,
  CodeSelect,
  DANGER_BTN,
  errMsg,
  ExpiryCell,
  FileChips,
  fmtDate,
  GHOST_BTN,
  INPUT_CLS,
  LABEL_CLS,
  LookupSelect,
  Modal,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SELECT_CLS,
  slice10,
  type Confirm,
  type ShowToast,
} from "./_shared";

const COLSPAN = 7;

// One-shot pending upload intent, consumed on the file <input> change event.
type PendingAction = { mode: "upload-and-save"; docType: string } | { mode: "append"; docId: string };
interface DocModalState {
  doc: DocumentResponse | null; // null = manual add
  extracted: ExtractedDocRow | null;
}

export function DocumentsTab({
  vendorId,
  initial,
  lookups,
  showToast,
  confirm,
}: {
  vendorId: string;
  initial: DocumentResponse[];
  lookups: Record<string, LookupRow[]>;
  showToast: ShowToast;
  confirm: Confirm;
}): React.JSX.Element {
  const [rows, setRows] = useState<DocumentResponse[]>(initial);
  const [typeFilter, setTypeFilter] = useState("");
  const [uploadType, setUploadType] = useState("");
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [modal, setModal] = useState<DocModalState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const docStatusRows = lookups.DOC_STATUS ?? [];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);

  // Seed from the initial payload; re-fetch on filter change / mutation.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    let live = true;
    (async () => {
      setLoading(true);
      try {
        const list = await listDocuments(vendorId, typeFilter || undefined);
        if (live) setRows(list);
      } catch (e) {
        if (live) showToast(errMsg(e, "Failed to load documents"), "error");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [vendorId, typeFilter, reloadTick, showToast]);

  const reload = () => setReloadTick((t) => t + 1);

  // Arm an upload intent, then open the OS file picker. HTML file-cancel fires no
  // `change` event, so a one-shot focus listener clears the pending action after
  // a 400ms grace (long enough for a real `change` to consume it first).
  function armDocAction(action: PendingAction) {
    pendingRef.current = action;
    const onFocus = () => {
      window.removeEventListener("focus", onFocus);
      setTimeout(() => {
        if (pendingRef.current === action) pendingRef.current = null;
      }, 400);
    };
    window.addEventListener("focus", onFocus);
    fileInputRef.current?.click();
  }

  function onUploadClick() {
    if (!uploadType) {
      showToast("Pick a document type first", "error");
      return;
    }
    armDocAction({ mode: "upload-and-save", docType: uploadType });
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0] ?? null;
    input.value = ""; // reset so the same file can be re-picked
    const action = pendingRef.current;
    if (!file || !action) return;

    const verr = validateUploadFile(file);
    if (verr) {
      pendingRef.current = null;
      showToast(verr, "error");
      return;
    }
    pendingRef.current = null; // consume

    setUploading(true);
    try {
      if (action.mode === "upload-and-save") {
        showToast("Uploading & extracting…", "info");
        const result = await uploadAndSaveDocument(vendorId, file, action.docType);
        reload();
        setModal({ doc: result.document, extracted: result.extracted });
        showToast("Document saved · review extracted fields", "ok");
      } else {
        const updated = await appendDocumentFile(vendorId, action.docId, file);
        setRows((rs) => rs.map((r) => (r.doc_id === updated.doc_id ? updated : r)));
        showToast("File appended", "ok");
      }
    } catch (err) {
      const code = err instanceof VendorApiError ? err.code : null;
      if (code === "mime_mismatch") showToast("File type rejected by server.", "error");
      else if (code === "file_too_large") showToast("File too large (server limit 25 MB).", "error");
      else showToast(`Upload failed — ${errMsg(err, "unknown error")}`, "error");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc: DocumentResponse) {
    const ok = await confirm({ title: "Delete document", message: "Delete this document row?", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    setBusyId(doc.doc_id);
    try {
      await deleteDocument(vendorId, doc.doc_id);
      showToast("Document deleted", "ok");
      reload();
    } catch (e) {
      showToast(errMsg(e, "Couldn't delete document"), "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Documents</h3>
        <Badge tone="neutral">{rows.length}</Badge>
        <div className="flex-1" />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type" className={SELECT_CLS}>
          <option value="">All types</option>
          {DOC_TYPE.map((d) => (
            <option key={d.code} value={d.code}>
              {d.label}
            </option>
          ))}
        </select>
        <select value={uploadType} onChange={(e) => setUploadType(e.target.value)} aria-label="Upload document type" className={SELECT_CLS}>
          <option value="">Type to upload…</option>
          {DOC_TYPE.map((d) => (
            <option key={d.code} value={d.code}>
              {d.label}
            </option>
          ))}
        </select>
        <button type="button" className={SECONDARY_BTN} disabled={uploading} onClick={onUploadClick}>
          {uploading ? "Uploading…" : "Upload & extract"}
        </button>
        <button type="button" className={GHOST_BTN} onClick={() => setModal({ doc: null, extracted: null })}>
          Manual entry
        </button>
        <input ref={fileInputRef} type="file" accept={UPLOAD_ACCEPT} className="hidden" onChange={(e) => void onFileChange(e)} />
      </div>

      {/* Table */}
      <div className={`${CARD_CLS} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-[var(--surface-subtle)] text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                <Th>Type</Th>
                <Th>Doc number</Th>
                <Th>Issued</Th>
                <Th>Valid from</Th>
                <Th>Valid to</Th>
                <Th>Files</Th>
                <Th className="w-[210px]">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <EmptyRow>
                  <span className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                    <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
                    Loading…
                  </span>
                </EmptyRow>
              ) : rows.length === 0 ? (
                <EmptyRow>
                  <div className="py-6">
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">No documents yet</div>
                    <div className="text-[12px] text-[var(--text-secondary)] mt-1">Upload a file or add one manually.</div>
                  </div>
                </EmptyRow>
              ) : (
                rows.map((d) => {
                  const busy = busyId === d.doc_id;
                  return (
                    <tr key={d.doc_id} className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
                      <Td className="font-semibold text-[var(--text-primary)]">{d.doc_type}</Td>
                      <Td className="font-mono text-[12px]">{typeof d.doc_number === "string" && d.doc_number ? d.doc_number : "—"}</Td>
                      <Td>{fmtDate(d.issued_on)}</Td>
                      <Td>{fmtDate(d.valid_from)}</Td>
                      <Td><ExpiryCell value={d.valid_to} /></Td>
                      <Td><FileChips csv={d.s3_urls} /></Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <button type="button" className={GHOST_BTN} disabled={busy || uploading} onClick={() => armDocAction({ mode: "append", docId: d.doc_id })}>
                            Append file
                          </button>
                          <button type="button" className={GHOST_BTN} disabled={busy} onClick={() => setModal({ doc: d, extracted: null })}>
                            Edit
                          </button>
                          <button type="button" className={DANGER_BTN} disabled={busy} onClick={() => void handleDelete(d)}>
                            Delete
                          </button>
                        </div>
                      </Td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <DocModal
          vendorId={vendorId}
          doc={modal.doc}
          extracted={modal.extracted}
          docStatusRows={docStatusRows}
          showToast={showToast}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

// ── Add / Edit document modal ────────────────────────────────────────────────

interface DocFormState {
  doc_type: string;
  status_id: string;
  doc_number: string;
  issued_on: string;
  valid_from: string;
  valid_to: string;
  s3_urls: string;
}

function initialDocForm(doc: DocumentResponse | null, extracted: ExtractedDocRow | null): DocFormState {
  // Extracted wins over the saved row, then falls back to "".
  const v = (k: string): string => {
    const ex = extracted ? (extracted as Record<string, unknown>)[k] : undefined;
    if (ex != null && ex !== "") return String(ex);
    const dv = doc ? (doc as Record<string, unknown>)[k] : undefined;
    return dv == null ? "" : String(dv);
  };
  return {
    doc_type: v("doc_type") || DOC_TYPE[0].code,
    status_id: doc && doc.status_id != null ? String(doc.status_id) : "",
    doc_number: v("doc_number"),
    issued_on: slice10(v("issued_on")),
    valid_from: slice10(v("valid_from")),
    valid_to: slice10(v("valid_to")),
    s3_urls: doc && doc.s3_urls != null ? String(doc.s3_urls) : "",
  };
}

function DocModal({
  vendorId,
  doc,
  extracted,
  docStatusRows,
  showToast,
  onClose,
  onSaved,
}: {
  vendorId: string;
  doc: DocumentResponse | null;
  extracted: ExtractedDocRow | null;
  docStatusRows: LookupRow[];
  showToast: ShowToast;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [f, setF] = useState<DocFormState>(() => initialDocForm(doc, extracted));
  const [saving, setSaving] = useState(false);
  const isEdit = !!doc;
  const set = <K extends keyof DocFormState>(k: K, val: DocFormState[K]) => setF((prev) => ({ ...prev, [k]: val }));

  async function handleSave() {
    if (saving) return;
    if (!f.doc_type) return showToast("Doc type is required", "error");

    const body: DocumentCreateBody = {
      doc_type: f.doc_type,
      doc_number: f.doc_number.trim() || null,
      s3_urls: s3UrlsToCsv(s3UrlsToArray(f.s3_urls)),
      issued_on: f.issued_on || null,
      valid_from: f.valid_from || null,
      valid_to: f.valid_to || null,
      status_id: f.status_id || null,
    };

    setSaving(true);
    try {
      if (doc) await patchDocument(vendorId, doc.doc_id, body);
      else await addDocument(vendorId, body);
      showToast(isEdit ? "Document updated" : "Document added", "ok");
      onSaved();
    } catch (e) {
      showToast(errMsg(e, "Couldn't save document"), "error");
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <>
      <button type="button" className={SECONDARY_BTN} onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button type="button" className={PRIMARY_BTN} onClick={() => void handleSave()} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </>
  );

  return (
    <Modal title={isEdit ? "Edit document" : "Add document"} onClose={onClose} size="md" titleId="vd-doc-title" footer={footer}>
      {extracted && (
        <div className="mb-3 flex items-start gap-2 rounded-[2px] border border-[#b6dbb1] bg-[#eaf6ed] px-3 py-2 text-[12px] text-[var(--text-success)]">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} className="mt-0.5 shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>Auto-filled from upload — please verify before saving.</span>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <label htmlFor="dm-doc_type" className={LABEL_CLS}>Type *</label>
          <CodeSelect id="dm-doc_type" value={f.doc_type} onChange={(v) => set("doc_type", v)} options={DOC_TYPE} />
        </div>
        <div>
          <label htmlFor="dm-status_id" className={LABEL_CLS}>Status</label>
          <LookupSelect id="dm-status_id" value={f.status_id} onChange={(v) => set("status_id", v)} rows={docStatusRows} />
        </div>
        <div>
          <label htmlFor="dm-doc_number" className={LABEL_CLS}>Doc number</label>
          <input id="dm-doc_number" type="text" value={f.doc_number} onChange={(e) => set("doc_number", e.target.value)} className={`${INPUT_CLS} w-full font-mono`} />
        </div>
        <div>
          <label htmlFor="dm-issued_on" className={LABEL_CLS}>Issued on</label>
          <input id="dm-issued_on" type="date" value={f.issued_on} onChange={(e) => set("issued_on", e.target.value)} className={`${INPUT_CLS} w-full`} />
        </div>
        <div>
          <label htmlFor="dm-valid_from" className={LABEL_CLS}>Valid from</label>
          <input id="dm-valid_from" type="date" value={f.valid_from} onChange={(e) => set("valid_from", e.target.value)} className={`${INPUT_CLS} w-full`} />
        </div>
        <div>
          <label htmlFor="dm-valid_to" className={LABEL_CLS}>Valid to</label>
          <input id="dm-valid_to" type="date" value={f.valid_to} onChange={(e) => set("valid_to", e.target.value)} className={`${INPUT_CLS} w-full`} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="dm-s3_urls" className={LABEL_CLS}>S3 URLs (comma-separated)</label>
          <input id="dm-s3_urls" type="text" value={f.s3_urls} onChange={(e) => set("s3_urls", e.target.value)} className={`${INPUT_CLS} w-full font-mono`} />
        </div>
      </div>
    </Modal>
  );
}

// ── Table primitives ─────────────────────────────────────────────────────────

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }): React.JSX.Element {
  return <th className={`px-3 py-2 font-semibold whitespace-nowrap ${className}`}>{children}</th>;
}
function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }): React.JSX.Element {
  return <td className={`px-3 py-2 align-middle text-[var(--text-primary)] ${className}`}>{children}</td>;
}
function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <tr>
      <td colSpan={COLSPAN} className="px-3 py-6 text-center">
        {children}
      </td>
    </tr>
  );
}

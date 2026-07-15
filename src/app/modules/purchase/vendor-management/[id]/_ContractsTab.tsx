"use client";

// Contracts pane (spec §3E) — mirror of Documents. Upload-and-extract needs no
// type pre-selection (the type is extracted from the file); same 400ms file-
// picker-cancel guard, same manual/append/edit/delete flow.

import { useEffect, useRef, useState } from "react";
import {
  addContract,
  appendContractFile,
  CONTRACT_TYPE,
  deleteContract,
  listContracts,
  patchContract,
  s3UrlsToArray,
  s3UrlsToCsv,
  uploadAndSaveContract,
  UPLOAD_ACCEPT,
  validateUploadFile,
  VendorApiError,
  type ContractCreateBody,
  type ContractResponse,
  type ExtractedContractRow,
} from "@/lib/vendor";
import {
  Badge,
  CARD_CLS,
  CodeSelect,
  DANGER_BTN,
  errMsg,
  FileChips,
  fmtDate,
  GHOST_BTN,
  INPUT_CLS,
  LABEL_CLS,
  Modal,
  PRIMARY_BTN,
  SECONDARY_BTN,
  SELECT_CLS,
  slice10,
  type Confirm,
  type ShowToast,
} from "./_shared";

const COLSPAN = 8;

type PendingAction = { mode: "upload-and-save" } | { mode: "append"; contractId: string };
interface ContractModalState {
  contract: ContractResponse | null; // null = manual add
  extracted: ExtractedContractRow | null;
}

export function ContractsTab({
  vendorId,
  initial,
  showToast,
  confirm,
}: {
  vendorId: string;
  initial: ContractResponse[];
  showToast: ShowToast;
  confirm: Confirm;
}): React.JSX.Element {
  const [rows, setRows] = useState<ContractResponse[]>(initial);
  const [typeFilter, setTypeFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [modal, setModal] = useState<ContractModalState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);

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
        const list = await listContracts(vendorId, typeFilter || undefined);
        if (live) setRows(list);
      } catch (e) {
        if (live) showToast(errMsg(e, "Failed to load contracts"), "error");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [vendorId, typeFilter, reloadTick, showToast]);

  const reload = () => setReloadTick((t) => t + 1);

  function armContractAction(action: PendingAction) {
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

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0] ?? null;
    input.value = "";
    const action = pendingRef.current;
    if (!file || !action) return;

    const verr = validateUploadFile(file);
    if (verr) {
      pendingRef.current = null;
      showToast(verr, "error");
      return;
    }
    pendingRef.current = null;

    setUploading(true);
    try {
      if (action.mode === "upload-and-save") {
        showToast("Uploading & extracting…", "info");
        const result = await uploadAndSaveContract(vendorId, file);
        reload();
        setModal({ contract: result.contract, extracted: result.extracted });
        showToast("Contract saved · review extracted fields", "ok");
      } else {
        const updated = await appendContractFile(vendorId, action.contractId, file);
        setRows((rs) => rs.map((r) => (r.contract_id === updated.contract_id ? updated : r)));
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

  async function handleDelete(c: ContractResponse) {
    const ok = await confirm({ title: "Delete contract", message: "Delete this contract?", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    setBusyId(c.contract_id);
    try {
      await deleteContract(vendorId, c.contract_id);
      showToast("Contract deleted", "ok");
      reload();
    } catch (e) {
      showToast(errMsg(e, "Couldn't delete contract"), "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Contracts</h3>
        <Badge tone="neutral">{rows.length}</Badge>
        <div className="flex-1" />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type" className={SELECT_CLS}>
          <option value="">All types</option>
          {CONTRACT_TYPE.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
        <button type="button" className={SECONDARY_BTN} disabled={uploading} onClick={() => armContractAction({ mode: "upload-and-save" })}>
          {uploading ? "Uploading…" : "Upload & extract"}
        </button>
        <button type="button" className={GHOST_BTN} onClick={() => setModal({ contract: null, extracted: null })}>
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
                <Th>Signed</Th>
                <Th>Effective</Th>
                <Th>Value (₹)</Th>
                <Th>SCOC</Th>
                <Th>Auto-renew</Th>
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
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">No contracts yet</div>
                    <div className="text-[12px] text-[var(--text-secondary)] mt-1">Upload a contract PDF or add one manually.</div>
                  </div>
                </EmptyRow>
              ) : (
                rows.map((c) => {
                  const busy = busyId === c.contract_id;
                  const eff =
                    c.effective_from || c.effective_to ? `${fmtDate(c.effective_from)} → ${fmtDate(c.effective_to)}` : "—";
                  return (
                    <tr key={c.contract_id} className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
                      <Td className="font-semibold text-[var(--text-primary)]">{typeof c.contract_type === "string" && c.contract_type ? c.contract_type : "—"}</Td>
                      <Td>{fmtDate(c.signed_date)}</Td>
                      <Td>{eff}</Td>
                      <Td className="font-mono text-[12px]">{c.value_inr != null ? Number(c.value_inr).toLocaleString("en-IN") : "—"}</Td>
                      <Td>{c.scoc_signed ? <Badge tone="success">Yes</Badge> : <Badge tone="neutral">No</Badge>}</Td>
                      <Td>{c.auto_renew ? <Badge tone="info">Auto</Badge> : <Badge tone="neutral">No</Badge>}</Td>
                      <Td><FileChips csv={c.s3_urls} /></Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <button type="button" className={GHOST_BTN} disabled={busy || uploading} onClick={() => armContractAction({ mode: "append", contractId: c.contract_id })}>
                            Append file
                          </button>
                          <button type="button" className={GHOST_BTN} disabled={busy} onClick={() => setModal({ contract: c, extracted: null })}>
                            Edit
                          </button>
                          <button type="button" className={DANGER_BTN} disabled={busy} onClick={() => void handleDelete(c)}>
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
        <ContractModal
          vendorId={vendorId}
          contract={modal.contract}
          extracted={modal.extracted}
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

// ── Add / Edit contract modal ────────────────────────────────────────────────

interface ContractFormState {
  contract_type: string;
  value_inr: string;
  signed_date: string;
  effective_from: string;
  effective_to: string;
  scoc_signed: boolean;
  auto_renew: boolean;
  s3_urls: string;
}

function initialContractForm(c: ContractResponse | null, extracted: ExtractedContractRow | null): ContractFormState {
  const v = (k: string): string => {
    const ex = extracted ? (extracted as Record<string, unknown>)[k] : undefined;
    if (ex != null && ex !== "") return String(ex);
    const cv = c ? (c as Record<string, unknown>)[k] : undefined;
    return cv == null ? "" : String(cv);
  };
  return {
    contract_type: v("contract_type"),
    value_inr: v("value_inr"),
    signed_date: slice10(v("signed_date")),
    effective_from: slice10(v("effective_from")),
    effective_to: slice10(v("effective_to")),
    scoc_signed: !!c?.scoc_signed,
    auto_renew: !!c?.auto_renew,
    s3_urls: c && c.s3_urls != null ? String(c.s3_urls) : "",
  };
}

function ContractModal({
  vendorId,
  contract,
  extracted,
  showToast,
  onClose,
  onSaved,
}: {
  vendorId: string;
  contract: ContractResponse | null;
  extracted: ExtractedContractRow | null;
  showToast: ShowToast;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [f, setF] = useState<ContractFormState>(() => initialContractForm(contract, extracted));
  const [saving, setSaving] = useState(false);
  const isEdit = !!contract;
  const set = <K extends keyof ContractFormState>(k: K, val: ContractFormState[K]) => setF((prev) => ({ ...prev, [k]: val }));

  async function handleSave() {
    if (saving) return;
    const valStr = f.value_inr.trim();
    const body: ContractCreateBody = {
      contract_type: f.contract_type || null,
      signed_date: f.signed_date || null,
      effective_from: f.effective_from || null,
      effective_to: f.effective_to || null,
      value_inr: valStr === "" ? null : Number(valStr),
      scoc_signed: f.scoc_signed,
      auto_renew: f.auto_renew,
      s3_urls: s3UrlsToCsv(s3UrlsToArray(f.s3_urls)),
    };

    setSaving(true);
    try {
      if (contract) await patchContract(vendorId, contract.contract_id, body);
      else await addContract(vendorId, body);
      showToast(isEdit ? "Contract updated" : "Contract added", "ok");
      onSaved();
    } catch (e) {
      showToast(errMsg(e, "Couldn't save contract"), "error");
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
    <Modal title={isEdit ? "Edit contract" : "Add contract"} onClose={onClose} size="md" titleId="vd-contract-title" footer={footer}>
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
          <label htmlFor="cm-contract_type" className={LABEL_CLS}>Contract type</label>
          <CodeSelect id="cm-contract_type" value={f.contract_type} onChange={(v) => set("contract_type", v)} options={CONTRACT_TYPE} leadingDash />
        </div>
        <div>
          <label htmlFor="cm-value_inr" className={LABEL_CLS}>Value (₹)</label>
          <input id="cm-value_inr" type="number" step="any" value={f.value_inr} onChange={(e) => set("value_inr", e.target.value)} className={`${INPUT_CLS} w-full font-mono`} />
        </div>
        <div>
          <label htmlFor="cm-signed_date" className={LABEL_CLS}>Signed date</label>
          <input id="cm-signed_date" type="date" value={f.signed_date} onChange={(e) => set("signed_date", e.target.value)} className={`${INPUT_CLS} w-full`} />
        </div>
        <div>
          <label htmlFor="cm-effective_from" className={LABEL_CLS}>Effective from</label>
          <input id="cm-effective_from" type="date" value={f.effective_from} onChange={(e) => set("effective_from", e.target.value)} className={`${INPUT_CLS} w-full`} />
        </div>
        <div>
          <label htmlFor="cm-effective_to" className={LABEL_CLS}>Effective to</label>
          <input id="cm-effective_to" type="date" value={f.effective_to} onChange={(e) => set("effective_to", e.target.value)} className={`${INPUT_CLS} w-full`} />
        </div>
        <div className="flex items-center gap-4 pt-5">
          <label className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text-primary)]">
            <input type="checkbox" checked={f.scoc_signed} onChange={(e) => set("scoc_signed", e.target.checked)} /> SCOC signed
          </label>
          <label className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text-primary)]">
            <input type="checkbox" checked={f.auto_renew} onChange={(e) => set("auto_renew", e.target.checked)} /> Auto-renew
          </label>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="cm-s3_urls" className={LABEL_CLS}>S3 URLs (comma-separated)</label>
          <input id="cm-s3_urls" type="text" value={f.s3_urls} onChange={(e) => set("s3_urls", e.target.value)} className={`${INPUT_CLS} w-full font-mono`} />
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

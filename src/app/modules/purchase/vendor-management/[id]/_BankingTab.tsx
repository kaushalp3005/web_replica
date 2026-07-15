"use client";

// Banking pane (spec §3C) — table + Add/Edit modal + set-primary / delete +
// the "Active only" filter with post-save auto-clear so a saved-inactive row
// never silently vanishes.

import { useEffect, useRef, useState } from "react";
import {
  addBanking,
  deleteBanking,
  getLookupLabel,
  isValidIfsc,
  listBanking,
  patchBanking,
  setPrimaryBanking,
  type BankingResponse,
  type LookupRow,
  type StagedBankingItem,
} from "@/lib/vendor";
import {
  asId,
  Badge,
  CARD_CLS,
  DANGER_BTN,
  errMsg,
  GHOST_BTN,
  INPUT_CLS,
  LABEL_CLS,
  LookupSelect,
  Modal,
  PRIMARY_BTN,
  SECONDARY_BTN,
  type Confirm,
  type ShowToast,
} from "./_shared";

const COLSPAN = 9;

interface BankModalState {
  row: BankingResponse | null; // null = add
}

export function BankingTab({
  vendorId,
  initial,
  lookups,
  showToast,
  confirm,
}: {
  vendorId: string;
  initial: BankingResponse[];
  lookups: Record<string, LookupRow[]>;
  showToast: ShowToast;
  confirm: Confirm;
}): React.JSX.Element {
  const [rows, setRows] = useState<BankingResponse[]>(initial);
  const [activeOnly, setActiveOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [modal, setModal] = useState<BankModalState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const accountTypeRows = lookups.ACCOUNT_TYPE ?? [];

  // Seed from the initial (unfiltered) payload; only re-fetch when the filter
  // toggles or a mutation bumps reloadTick.
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
        const list = await listBanking(vendorId, activeOnly);
        if (live) setRows(list);
      } catch (e) {
        if (live) showToast(errMsg(e, "Failed to load banking"), "error");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [vendorId, activeOnly, reloadTick, showToast]);

  const reload = () => setReloadTick((t) => t + 1);

  async function handleSetPrimary(row: BankingResponse) {
    setBusyId(row.bank_id);
    try {
      await setPrimaryBanking(vendorId, row.bank_id);
      showToast("Primary updated", "ok");
      reload();
    } catch (e) {
      showToast(errMsg(e, "Couldn't set primary"), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(row: BankingResponse) {
    const ok = await confirm({ title: "Delete banking account", message: "Delete this banking account?", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    setBusyId(row.bank_id);
    try {
      await deleteBanking(vendorId, row.bank_id);
      showToast("Account deleted", "ok");
      reload();
    } catch (e) {
      showToast(errMsg(e, "Couldn't delete account"), "error");
    } finally {
      setBusyId(null);
    }
  }

  // Called by the modal after a successful add / patch. Handles the active-only
  // auto-clear so a saved-inactive row doesn't disappear behind the filter.
  function handleSaved(savedActive: boolean, isEdit: boolean) {
    setModal(null);
    if (!savedActive && activeOnly) {
      setActiveOnly(false); // effect re-fetches with the filter off
      showToast(isEdit ? "Banking updated · cleared Active-only filter" : "Account added · cleared Active-only filter", "info");
    } else {
      showToast(isEdit ? "Banking updated" : "Account added", "ok");
      reload();
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">Banking accounts</h3>
        <Badge tone="neutral">{rows.length}</Badge>
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] cursor-pointer select-none">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          Active only
        </label>
        <div className="flex-1" />
        <button type="button" className={PRIMARY_BTN} onClick={() => setModal({ row: null })}>
          + Add account
        </button>
      </div>

      {/* Table */}
      <div className={`${CARD_CLS} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-[var(--surface-subtle)] text-left text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                <Th>Bank</Th>
                <Th>Account</Th>
                <Th>Holder</Th>
                <Th>IFSC</Th>
                <Th>Branch</Th>
                <Th>Type</Th>
                <Th>Primary</Th>
                <Th>Active</Th>
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
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">No banking accounts yet</div>
                    <div className="text-[12px] text-[var(--text-secondary)] mt-1">Add at least one account to enable approval.</div>
                  </div>
                </EmptyRow>
              ) : (
                rows.map((b) => {
                  const busy = busyId === b.bank_id;
                  return (
                    <tr key={b.bank_id} className="border-t border-[var(--aws-border)] hover:bg-[var(--surface-subtle)]">
                      <Td className="font-semibold text-[var(--text-primary)]">{b.bank_name}</Td>
                      <Td className="font-mono text-[12px]">{b.account_no}</Td>
                      <Td>{b.account_name}</Td>
                      <Td className="font-mono text-[12px]">{typeof b.ifsc === "string" && b.ifsc ? b.ifsc : "—"}</Td>
                      <Td>{typeof b.branch === "string" && b.branch ? b.branch : "—"}</Td>
                      <Td>{getLookupLabel(accountTypeRows, asId(b.account_type_id)) || "—"}</Td>
                      <Td>{b.is_primary ? <Badge tone="success">Primary</Badge> : null}</Td>
                      <Td>{b.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {!b.is_primary && (
                            <button type="button" className={GHOST_BTN} disabled={busy} onClick={() => void handleSetPrimary(b)}>
                              Set primary
                            </button>
                          )}
                          <button type="button" className={GHOST_BTN} disabled={busy} onClick={() => setModal({ row: b })}>
                            Edit
                          </button>
                          <button type="button" className={DANGER_BTN} disabled={busy} onClick={() => void handleDelete(b)}>
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
        <BankModal
          vendorId={vendorId}
          row={modal.row}
          accountTypeRows={accountTypeRows}
          showToast={showToast}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

// ── Add / Edit bank modal ────────────────────────────────────────────────────

interface BankFormState {
  bank_name: string;
  account_no: string;
  account_name: string;
  ifsc: string;
  branch: string;
  swift: string;
  account_type_id: string;
  is_primary: boolean;
  is_active: boolean;
  valid_from: string;
  valid_to: string;
}

function initialBankForm(row: BankingResponse | null): BankFormState {
  const s = (v: unknown) => (v == null ? "" : String(v));
  return {
    bank_name: s(row?.bank_name),
    account_no: s(row?.account_no),
    account_name: s(row?.account_name),
    ifsc: s(row?.ifsc),
    branch: s(row?.branch),
    swift: s(row?.swift),
    account_type_id: s(row?.account_type_id),
    is_primary: !!row?.is_primary,
    is_active: row ? !!row.is_active : true, // default ON for new rows
    valid_from: s(row?.valid_from).slice(0, 10),
    valid_to: s(row?.valid_to).slice(0, 10),
  };
}

function BankModal({
  vendorId,
  row,
  accountTypeRows,
  showToast,
  onClose,
  onSaved,
}: {
  vendorId: string;
  row: BankingResponse | null;
  accountTypeRows: LookupRow[];
  showToast: ShowToast;
  onClose: () => void;
  onSaved: (savedActive: boolean, isEdit: boolean) => void;
}): React.JSX.Element {
  const [f, setF] = useState<BankFormState>(() => initialBankForm(row));
  const [saving, setSaving] = useState(false);
  const isEdit = !!row;
  const set = <K extends keyof BankFormState>(k: K, v: BankFormState[K]) => setF((prev) => ({ ...prev, [k]: v }));

  async function handleSave() {
    if (saving) return;
    const bank_name = f.bank_name.trim();
    const account_no = f.account_no.trim();
    const account_name = f.account_name.trim();
    const ifsc = f.ifsc.trim();

    if (!bank_name) return showToast("Bank name is required", "error");
    if (!account_no || account_no.length < 4) return showToast("Account no ≥4 chars required", "error");
    if (!account_name) return showToast("Account holder is required", "error");
    if (ifsc && !isValidIfsc(ifsc)) return showToast("Invalid IFSC format", "error");

    const body: StagedBankingItem = {
      bank_name,
      account_no,
      account_name,
      branch: f.branch.trim() || null,
      ifsc: ifsc || null,
      swift: f.swift.trim() || null,
      account_type_id: f.account_type_id || null,
      is_primary: f.is_primary,
      is_active: f.is_active,
      valid_from: f.valid_from || null,
      valid_to: f.valid_to || null,
    };

    setSaving(true);
    try {
      if (row) await patchBanking(vendorId, row.bank_id, body);
      else await addBanking(vendorId, body);
      onSaved(f.is_active, isEdit);
    } catch (e) {
      showToast(errMsg(e, "Couldn't save banking row"), "error");
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
    <Modal title={isEdit ? "Edit banking account" : "Add banking account"} onClose={onClose} size="md" titleId="vd-bank-title" footer={footer}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        <TextInput label="Bank name *" value={f.bank_name} onChange={(v) => set("bank_name", v)} full />
        <TextInput label="Account no *" value={f.account_no} onChange={(v) => set("account_no", v)} mono />
        <TextInput label="Account holder *" value={f.account_name} onChange={(v) => set("account_name", v)} />
        <TextInput label="IFSC" value={f.ifsc} onChange={(v) => set("ifsc", v)} mono maxLength={11} placeholder="ABCD0123456" />
        <TextInput label="Branch" value={f.branch} onChange={(v) => set("branch", v)} />
        <TextInput label="SWIFT" value={f.swift} onChange={(v) => set("swift", v)} mono maxLength={11} />
        <div>
          <label htmlFor="bm-account_type_id" className={LABEL_CLS}>Account type</label>
          <LookupSelect id="bm-account_type_id" value={f.account_type_id} onChange={(v) => set("account_type_id", v)} rows={accountTypeRows} />
        </div>
        <div className="flex items-center gap-4 pt-5">
          <label className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text-primary)]">
            <input type="checkbox" checked={f.is_primary} onChange={(e) => set("is_primary", e.target.checked)} /> Primary
          </label>
          <label className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text-primary)]">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set("is_active", e.target.checked)} /> Active
          </label>
        </div>
        <DateInput label="Valid from" value={f.valid_from} onChange={(v) => set("valid_from", v)} />
        <DateInput label="Valid to" value={f.valid_to} onChange={(v) => set("valid_to", v)} />
      </div>
    </Modal>
  );
}

// ── Small input helpers (local to this file) ─────────────────────────────────

function TextInput({
  label,
  value,
  onChange,
  mono,
  full,
  maxLength,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  full?: boolean;
  maxLength?: number;
  placeholder?: string;
}): React.JSX.Element {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <label className={LABEL_CLS}>{label}</label>
      <input
        type="text"
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT_CLS} w-full ${mono ? "font-mono" : ""}`}
      />
    </div>
  );
}

function DateInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <div>
      <label className={LABEL_CLS}>{label}</label>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={`${INPUT_CLS} w-full`} />
    </div>
  );
}

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

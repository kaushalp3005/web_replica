"use client";

// NPD samples queue — the standalone NPD Development module. Lists the NPD
// requisitions (sample_type ∈ NPD, TRIAL); creation goes through the purpose-built
// NPD form at /modules/npd-development/new. Columns: Request ID (hover → warehouse
// + type), Date, Target article, Quantity, Description, Requestor, Status, Actions.
// Filters: universal search, date range, requestor, status, type, warehouse.
// Paginated 50/page. Actions: View (all), Accept/Hold (NPD reviewer),
// Cancel/Edit (Sales = business requesting side), plus Develop/Open workflow steps.
// Hydration-safe via a `mounted` gate; no sessionStorage seed.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useHasPermission } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import {
  listRequisitions, listRequestors, npdReview, cancelRequisition, updateRequisition, listBusinessHeads,
  WAREHOUSES, NPD_WAREHOUSES, NPD_SAMPLE_TYPES,
  type Requisition, type PurposeTag, type Warehouse, type BusinessHead,
} from "@/lib/sample";
import { NpdStatusPill, NPD_STATUS_FILTERS, billingSummary } from "../sample/_shared";
import { CELL, Sub, Hover, Field, Pair, day, joinLines, shouldFlip } from "./_queue-ui";
import {
  BillingFields, billingError, billingPayload, billingFrom, EMPTY_BILLING, type BillingValue,
} from "../sample/_form";

const PAGE_SIZE = 50;
const NPD_TYPES_CSV = "NPD,TRIAL";

const TYPE_LABELS: Record<string, string> = { NPD: "NPD Internal", TRIAL: "Pilot Customer trial" };
function typeLabel(t?: string | null): string {
  return (t && TYPE_LABELS[t]) || t || "—";
}

const PURPOSE_OPTIONS: { value: PurposeTag; label: string }[] = [
  { value: "CUSTOMER_DISPLAY", label: "Customer display" },
  { value: "CUSTOMER_ISSUE", label: "Customer issue" },
  { value: "TASTING_SENSORY", label: "Tasting / sensory" },
  { value: "PHYSICAL_PARAMETERS", label: "Physical parameters" },
  { value: "INTERNAL_OTHER", label: "Internal / other" },
];

const PURPOSE_LABELS: Record<string, string> =
  Object.fromEntries(PURPOSE_OPTIONS.map((p) => [p.value, p.label]));

function purposeLabel(r: Requisition): string {
  const tag = r.purpose_tag ?? "";
  return PURPOSE_LABELS[tag] ?? (r.purpose_note ?? tag ?? "");
}

function desc(r: Requisition): string {
  return (r.description ?? "").trim();
}

/** Every target article on the request with its own pcs × weight → quantity.
 *  The row can only show target #1 (the header mirror), so a multi-article request
 *  looks like a single-article one until you hover it. */
function TargetsPanel({ r }: { r: Requisition }) {
  const targets = r.npd_targets?.length
    ? r.npd_targets
    : [{ name: r.npd_target_name ?? "—", pcs: r.pcs, weight_per_piece: r.weight_per_piece, quantity: r.quantity }];
  const total = targets.reduce((n, t) => n + (Number(t.quantity) || 0), 0);
  return (
    <>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {targets.length} target article{targets.length === 1 ? "" : "s"}
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {targets.map((t, i) => (
            <tr key={t.id ?? i} className="align-top">
              <td className="py-[3px] pr-2 text-[var(--text-primary)] break-words">{t.name || "—"}</td>
              <td className="py-[3px] whitespace-nowrap text-right tabular-nums text-[var(--text-secondary)]">
                {t.pcs != null && t.weight_per_piece != null
                  ? `${t.pcs} pcs × ${t.weight_per_piece} kg`
                  : "—"}
              </td>
              <td className="py-[3px] pl-2 whitespace-nowrap text-right tabular-nums font-medium">
                {t.quantity != null ? `${t.quantity} kg` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        {targets.length > 1 && (
          <tfoot>
            <tr className="border-t border-[var(--surface-divider)]">
              <td className="pt-1.5 text-[11px] text-[var(--text-muted)]" colSpan={2}>Total</td>
              <td className="pt-1.5 pl-2 whitespace-nowrap text-right tabular-nums font-semibold">
                {Math.round(total * 1000) / 1000} kg
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </>
  );
}

/** The whole request, as it was raised — every field the form collects, so the queue
 *  answers "what is this?" without a round trip to the detail page. */
function EntryPanel({ r }: { r: Requisition }) {
  const poc = r.sales_poc_name ?? r.sales_poc_email ?? "";
  const purpose = purposeLabel(r);
  const ship = r.customer_ship_to_address ?? "";
  const targets = r.npd_targets?.length
    ? r.npd_targets
    : [{ name: r.npd_target_name, quantity: r.quantity }];
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold tabular-nums">{r.request_id ?? "—"}</span>
        <NpdStatusPill status={r.status} holdReason={r.hold_reason} bhSignoffState={r.bh_signoff_state} />
      </div>
      <div className="divide-y divide-[var(--surface-divider)]">
        {/* Scalars two-up; only the free-text fields get a full line. */}
        <div className="pb-1">
          <Pair a={["Type", typeLabel(r.sample_type)]} b={["Warehouse", r.warehouse ?? "—"]} />
          <Pair a={["Raised", day(r.created_at) || "—"]}
                b={["Dispatch", day(r.confirmed_dispatch_date)
                    ? `✓ ${day(r.confirmed_dispatch_date)}`
                    : day(r.expected_dispatch_date) || "TBC"]} />
          <Pair a={["Business head", r.requestor_team || "—"]} b={poc ? ["Sales POC", poc] : undefined} />
          {(purpose || r.mode_of_transport) && (
            <Pair a={["Purpose", purpose || "—"]}
                  b={r.mode_of_transport ? ["Transport", r.mode_of_transport] : undefined} />
          )}
          {/* Full width, not paired: "Non-returnable · Paid 12,500.00" is the one scalar
              here that a half-width cell truncates. */}
          <Field label="Billing">{billingSummary(r)}</Field>
        </div>
        <div className="py-1">
          <Field label={targets.length > 1 ? `Articles (${targets.length})` : "Article"}>
            {targets.map((t, i) => (
              <span key={i} className="block">
                {t.name || "—"}{t.quantity != null ? ` — ${t.quantity} kg` : ""}
              </span>
            ))}
          </Field>
        </div>
        <div className="py-1">
          <Field label="Customer">
            {r.customer_name || "—"}{r.company_name ? ` · ${r.company_name}` : ""}
          </Field>
          {r.customer_contact && <Field label="Contact">{r.customer_contact}</Field>}
          {ship && <Field label="Ship to">{ship}</Field>}
        </div>
        {desc(r) && <div className="py-1"><Field label="Description">{desc(r)}</Field></div>}
        {r.hold_reason && <div className="pt-1"><Field label="Hold reason">{r.hold_reason}</Field></div>}
      </div>
    </>
  );
}

// Which row actions are available given status + caps. The NPD reviewer's verbs
// are Accept + Hold; Cancel/Edit are the Sales (business requestor) actions.
// Develop/Open live on the request's detail page (reached via View).
function rowActionFlags(
  r: Requisition, canNpd: boolean, canEdit: boolean,
  canReview: boolean, canEditReq: boolean, canDeleteReq: boolean,
) {
  const s = r.status;
  const terminal = s === "CLOSED" || s === "CANCELLED";
  // 086: a request still waiting on its business head was never handed to NPD — the
  // server refuses the review (awaiting_bh_signoff), so don't offer the verbs.
  const heldForBh = r.bh_signoff_state === "PENDING";
  return {
    accept: canNpd && canReview && !heldForBh && (s === "SUBMITTED" || s === "ON_HOLD"),
    hold: canNpd && canReview && !heldForBh && s === "SUBMITTED",
    cancel: canEdit && canDeleteReq && !terminal,
    edit: canEdit && canEditReq && (s === "DRAFT" || s === "SUBMITTED" || s === "BH_REJECTED"),
  };
}

function Shell({ initial, router, children }: {
  initial: string;
  router: ReturnType<typeof useRouter>;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <span className="text-white">NPD Development</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile" title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >{initial}</button>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}

function MenuItem({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="block w-full text-left px-3 py-2 hover:bg-[var(--surface-subtle)]">
      <span className="block text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
      <span className="block text-[11px] text-[var(--text-muted)]">{desc}</span>
    </button>
  );
}

function RowActions({ flags, busy, onView, onAccept, onHold, onCancel, onEdit }: {
  flags: ReturnType<typeof rowActionFlags>; busy: boolean;
  onView: () => void; onAccept: () => void; onHold: () => void; onCancel: () => void;
  onEdit: () => void;
}) {
  // Sized to fit the Actions column at its share of a no-scroll table: two buttons
  // ("View" + "Cancel") sit side by side, more than two wrap onto a second line.
  const btn = "h-7 px-2 rounded-[2px] text-[11px] font-medium disabled:opacity-50";
  const neutral = `${btn} border border-[var(--aws-border-strong)] bg-white hover:bg-[var(--surface-subtle)]`;
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      <button onClick={(e) => { e.stopPropagation(); onView(); }} className={neutral}>View</button>
      {flags.accept && (
        <button disabled={busy} onClick={(e) => { e.stopPropagation(); onAccept(); }}
          className={`${btn} bg-[var(--aws-orange)] text-white hover:bg-[var(--aws-orange-hover)]`}>Accept</button>
      )}
      {flags.hold && (
        <button disabled={busy} onClick={(e) => { e.stopPropagation(); onHold(); }}
          className={`${btn} border border-[#fde68a] bg-[#fef9c3] text-[#854d0e] hover:bg-[#fdf08a]`}>Hold</button>
      )}
      {flags.edit && (
        <button disabled={busy} onClick={(e) => { e.stopPropagation(); onEdit(); }} className={neutral}>Edit</button>
      )}
      {flags.cancel && (
        <button disabled={busy} onClick={(e) => { e.stopPropagation(); onCancel(); }}
          className={`${btn} border border-[#f0c7be] bg-[#fdf3f1] text-[#b1361e] hover:bg-[#fbe9e4]`}>Cancel</button>
      )}
    </div>
  );
}

type EditForm = {
  npd_target_name: string; pcs: string; weight_per_piece: string; warehouse: string;
  purpose_tag: string; requestor_team: string; requestor_user_id: number; description: string;
  company_name: string; customer_name: string; customer_contact: string;
  customer_ship_to_address: string; mode_of_transport: string; expected_dispatch_date: string;
  billing: BillingValue;
};
type Modal =
  | { kind: "HOLD" | "CANCEL"; row: Requisition }
  | { kind: "EDIT"; row: Requisition };

export default function NpdQueuePage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);
  const canCreateReq = useHasPermission("sample", "requisition", null, "create");
  const canNpdCreate = useHasPermission("sample", "npd", null, "create");
  const canEditReq = useHasPermission("sample", "requisition", null, "edit");
  const canDeleteReq = useHasPermission("sample", "requisition", null, "delete");

  // filters
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [requestor, setRequestor] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [offset, setOffset] = useState(0);

  const [requestorOptions, setRequestorOptions] = useState<string[]>([]);
  const [rows, setRows] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);

  // action modals
  const [modal, setModal] = useState<Modal | null>(null);
  const [reason, setReason] = useState("");
  const [holdStart, setHoldStart] = useState("");
  const [editForm, setEditForm] = useState<EditForm>({
    npd_target_name: "", pcs: "", weight_per_piece: "", warehouse: "",
    purpose_tag: "", requestor_team: "", requestor_user_id: 0, description: "",
    company_name: "", customer_name: "", customer_contact: "",
    customer_ship_to_address: "", mode_of_transport: "", expected_dispatch_date: "",
    billing: EMPTY_BILLING,
  });
  // Business-head picker (mirrors the create form) — every role picks from the list, so
  // requestor_user_id always binds to a real BH. Plus derived qty + billing guard.
  // Carries user_id, not just the name: an edit that moved requestor_team without
  // requestor_user_id would leave the approval gate and mail trail pointing at the OLD
  // business head while the UI showed the new one.
  const [bhOptions, setBhOptions] = useState<BusinessHead[]>([]);
  useEffect(() => {
    let cancelled = false;
    listBusinessHeads().then((bhs) => {
      if (cancelled) return;
      setBhOptions(bhs);
    }).catch(() => { /* leave empty — the placeholder prompts a selection */ });
    return () => { cancelled = true; };
  }, []);
  const editPcsN = Number(editForm.pcs), editWppN = Number(editForm.weight_per_piece);
  const editQty = (editForm.pcs.trim() && editForm.weight_per_piece.trim()
    && Number.isFinite(editPcsN) && Number.isFinite(editWppN))
    ? Number((editPcsN * editWppN).toFixed(3)) : 0;
  // Keep the saved requestor selectable even if it isn't a business head (no silent blank).
  // The synthetic entry carries user_id 0 — selecting it sends no requestor_user_id, so an
  // unrelated edit can't rebind the approval gate to a bogus id.
  const savedReq = editForm.requestor_team.trim();
  const reqChoices: BusinessHead[] =
    savedReq && !bhOptions.some((b) => b.full_name === savedReq)
      ? [{ user_id: 0, full_name: savedReq }, ...bhOptions] : bhOptions;
  const editBillErr = billingError(editForm.billing);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  // debounce the universal search (reset to first page on change)
  useEffect(() => {
    const t = setTimeout(() => { setQ(searchInput.trim()); setOffset(0); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // requestor dropdown options (NPD + TRIAL across the whole queue)
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    listRequestors(NPD_TYPES_CSV).then((opts) => { if (!cancelled) setRequestorOptions(opts); });
    return () => { cancelled = true; };
  }, [authed, reloadKey]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const statusesCsv = status
          ? NPD_STATUS_FILTERS.find((f) => f.value === status)?.statuses.join(",")
          : undefined;
        const data = await listRequisitions({
          sample_types: type || NPD_TYPES_CSV,
          statuses: statusesCsv, warehouse, requestor, q,
          date_from: dateFrom || undefined, date_to: dateTo || undefined,
          limit: PAGE_SIZE, offset,
        });
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load NPD samples");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, q, dateFrom, dateTo, requestor, status, type, warehouse, offset, reloadKey]);

  function openRow(id: number) { router.push(`/modules/sample/${id}`); }

  function openHold(row: Requisition) {
    setReason(""); setHoldStart(new Date().toISOString().slice(0, 10)); setModal({ kind: "HOLD", row });
  }
  function openCancel(row: Requisition) { setReason(""); setModal({ kind: "CANCEL", row }); }
  function openEdit(row: Requisition) {
    setEditForm({
      npd_target_name: row.npd_target_name ?? "",
      pcs: row.pcs != null ? String(row.pcs) : "",
      weight_per_piece: row.weight_per_piece != null ? String(row.weight_per_piece) : "",
      warehouse: row.warehouse ?? "",
      purpose_tag: row.purpose_tag ?? "",
      requestor_team: row.requestor_team ?? "",
      requestor_user_id: row.requestor_user_id ?? 0,
      description: row.description ?? "",
      company_name: row.company_name ?? "",
      customer_name: row.customer_name ?? "",
      customer_contact: row.customer_contact ?? "",
      customer_ship_to_address: row.customer_ship_to_address ?? "",
      mode_of_transport: row.mode_of_transport ?? "",
      expected_dispatch_date: (row.expected_dispatch_date ?? "").slice(0, 10),
      billing: billingFrom(row),
    });
    setModal({ kind: "EDIT", row });
  }

  async function run(id: number, fn: () => Promise<unknown>) {
    setBusyId(id); setError(null);
    try {
      await fn();
      setModal(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  function saveEdit(row: Requisition) {
    if (editBillErr) return;
    return run(row.id, () => updateRequisition(row.id, {
      npd_target_name: editForm.npd_target_name.trim() || undefined,
      pcs: editForm.pcs.trim() ? editPcsN : undefined,
      weight_per_piece: editForm.weight_per_piece.trim() ? editWppN : undefined,
      quantity: editQty > 0 ? editQty : undefined,
      warehouse: (editForm.warehouse || undefined) as Warehouse | undefined,
      purpose_tag: (editForm.purpose_tag || undefined) as PurposeTag | undefined,
      requestor_team: editForm.requestor_team.trim() || undefined,
      requestor_user_id: editForm.requestor_user_id > 0 ? editForm.requestor_user_id : undefined,
      description: editForm.description.trim() || undefined,
      company_name: editForm.company_name.trim() || undefined,
      customer_name: editForm.customer_name.trim() || undefined,
      customer_contact: editForm.customer_contact.trim() || undefined,
      customer_ship_to_address: editForm.customer_ship_to_address.trim() || undefined,
      mode_of_transport: editForm.mode_of_transport.trim() || undefined,
      expected_dispatch_date: editForm.expected_dispatch_date || undefined,
      ...billingPayload(editForm.billing),
    }));
  }

  const anyFilter = !!(q || dateFrom || dateTo || requestor || status || type || warehouse);

  if (!mounted) {
    return (
      <Shell initial={initial} router={router}>
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading NPD samples…
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell initial={initial} router={router}>
      <Breadcrumbs items={[{ label: "Modules", href: "/modules" }, { label: "NPD Development" }]} className="mb-3" />
      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="min-w-0">
          <h1 className="text-[20px] sm:text-[22px] leading-7 font-semibold text-[var(--text-primary)]">NPD samples</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{rows.length} shown · new product development</p>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <button
            onClick={() => router.push("/modules/sample/rm-issue-forms")}
            title="Raw material issue / collection forms (Document 015)"
            className="h-9 px-3 sm:px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] font-medium hover:bg-[var(--surface-subtle)] whitespace-nowrap"
          >RM forms</button>
          {caps.canRequest && (
            <div className="relative flex-1 sm:flex-none">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="w-full sm:w-auto h-9 px-3 sm:px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)] inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                + New NPD sample
                <svg viewBox="0 0 20 20" className={`w-3.5 h-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 7l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {menuOpen && (
                <>
                  <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-64 max-w-[calc(100vw_-_2rem)] bg-white border border-[var(--aws-border-strong)] rounded-[2px] shadow-md py-1">
                    {canCreateReq && <MenuItem title="Sample requisition" desc="NPD · Customer trial · Convert" onClick={() => { setMenuOpen(false); router.push("/modules/npd-development/new"); }} />}
                    {caps.canNpd && canNpdCreate && <MenuItem title="Development job card" desc="R&amp;D — build & promote a BOM" onClick={() => { setMenuOpen(false); router.push("/modules/npd-development/job-cards/new"); }} />}
                    <div className="my-1 border-t border-[var(--surface-divider)]" />
                    <MenuItem title="Browse job cards" desc="Open existing development job cards" onClick={() => { setMenuOpen(false); router.push("/modules/npd-development/job-cards"); }} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div className="flex flex-col w-full sm:w-auto">
          <label className="text-[11px] text-[var(--text-muted)] mb-0.5">Search</label>
          <input
            className="form-input w-full sm:w-56!" placeholder="ID, article, customer, requestor…"
            value={searchInput} onChange={(e) => setSearchInput(e.target.value)} aria-label="Search"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] text-[var(--text-muted)] mb-0.5">From</label>
          <input type="date" className="form-input !w-auto" value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setOffset(0); }} aria-label="Date from" />
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] text-[var(--text-muted)] mb-0.5">To</label>
          <input type="date" className="form-input !w-auto" value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setOffset(0); }} aria-label="Date to" />
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] text-[var(--text-muted)] mb-0.5">Business head</label>
          <select className="form-input !w-auto" value={requestor}
            onChange={(e) => { setRequestor(e.target.value); setOffset(0); }} aria-label="Business head">
            <option value="">All requestors</option>
            {requestorOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] text-[var(--text-muted)] mb-0.5">Status</label>
          <select className="form-input !w-auto" value={status}
            onChange={(e) => { setStatus(e.target.value); setOffset(0); }} aria-label="Status">
            <option value="">All statuses</option>
            {NPD_STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] text-[var(--text-muted)] mb-0.5">Type</label>
          <select className="form-input !w-auto" value={type}
            onChange={(e) => { setType(e.target.value); setOffset(0); }} aria-label="Type">
            <option value="">All types</option>
            {NPD_SAMPLE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-[11px] text-[var(--text-muted)] mb-0.5">Warehouse</label>
          <select className="form-input !w-auto" value={warehouse}
            onChange={(e) => { setWarehouse(e.target.value); setOffset(0); }} aria-label="Warehouse">
            <option value="">All warehouses</option>
            {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
        {loading && <span className="self-center text-[12px] text-[var(--text-muted)] pb-2">Refreshing…</span>}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>
      )}

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
          {anyFilter ? "No NPD samples match these filters." : "No NPD samples yet."}
        </div>
      ) : (
        <>
          {/* Under 1024px: cards. lg+: the full table. The switch is at `lg`, not `md`,
              because the 9-column table only fits without spilling from ~1024px up —
              measured, not guessed. The cards below carry the same fields, stacked. */}
          <div className="grid grid-cols-1 gap-2 lg:hidden">
            {rows.map((r) => {
              const flags = rowActionFlags(r, caps.canNpd, caps.canEdit, canNpdCreate, canEditReq, canDeleteReq);
              return (
                <div key={r.id} className="bg-white border border-[var(--aws-border)] rounded-md p-3 hover:border-[var(--aws-orange)]">
                  <button type="button" onClick={() => openRow(r.id)} className="block w-full text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[13px] text-[var(--text-primary)] tabular-nums"
                        title={`Warehouse: ${r.warehouse ?? "—"} · Type: ${typeLabel(r.sample_type)}`}>
                        {r.request_id ?? "—"}
                      </span>
                      <NpdStatusPill status={r.status} holdReason={r.hold_reason} bhSignoffState={r.bh_signoff_state} />
                    </div>
                    <div className="mt-1 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>{day(r.created_at)}</span>
                      <span>{typeLabel(r.sample_type)}</span>
                      {r.quantity != null && <span>Qty {r.quantity}</span>}
                      {r.warehouse && <span>{r.warehouse}</span>}
                    </div>
                    {/* The card lists EVERY target article with its own quantity — the
                        hover panel's job on the desktop table, done inline here where
                        there is nothing to hover. */}
                    {(r.npd_targets?.length ? r.npd_targets : r.npd_target_name
                      ? [{ name: r.npd_target_name, quantity: r.quantity }] : []
                    ).map((t, i) => (
                      <div key={i} className="mt-1 text-[12px] text-[var(--text-secondary)] truncate"
                        title={`${t.name ?? ""}${t.quantity != null ? ` — ${t.quantity} kg` : ""}`}>
                        {i === 0 ? "Target: " : ""}{t.name}
                        {t.quantity != null && <span className="text-[var(--text-muted)]"> — {t.quantity} kg</span>}
                      </div>
                    ))}
                    {/* Customer — the field this queue was read for and never showed. */}
                    {(r.customer_name || r.company_name) && (
                      <div className="mt-0.5 text-[12px] text-[var(--text-secondary)] truncate"
                        title={joinLines(r.customer_name, r.company_name, r.customer_contact, r.customer_ship_to_address)}>
                        Customer: {r.customer_name || "—"}{r.company_name ? ` · ${r.company_name}` : ""}
                      </div>
                    )}
                    <div className="mt-0.5 text-[12px] text-[var(--text-muted)] flex flex-wrap gap-x-3 gap-y-0.5">
                      {r.requestor_team && <span>BH {r.requestor_team}</span>}
                      {(r.sales_poc_name || r.sales_poc_email) && <span>POC {r.sales_poc_name ?? r.sales_poc_email}</span>}
                      <span>Disp {day(r.confirmed_dispatch_date) || day(r.expected_dispatch_date) || "TBC"}</span>
                      <span>{billingSummary(r)}</span>
                      {purposeLabel(r) && <span>{purposeLabel(r)}</span>}
                    </div>
                    {r.description && (
                      <div className="mt-0.5 text-[12px] text-[var(--text-muted)] truncate" title={r.description}>{r.description}</div>
                    )}
                  </button>
                  <div className="mt-2 pt-2 border-t border-[var(--surface-divider)]">
                    <RowActions flags={flags} busy={busyId === r.id}
                      onView={() => openRow(r.id)}
                      onAccept={() => run(r.id, () => npdReview(r.id, "ACCEPT"))}
                      onHold={() => openHold(r)} onCancel={() => openCancel(r)} onEdit={() => openEdit(r)} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* `table-fixed` + the colgroup below is what keeps this inside the 1280px
              shell with NO horizontal scroll: the columns are shares of the available
              width, so long values truncate instead of pushing the table wider. Every
              field still on the row that lost its own column rides a second line under
              the value it belongs to (see the widths comment), and the full text is on
              each cell's tooltip. */}
          {/* `table-fixed` with no column widths gives NINE EVEN columns, and is also what
              keeps the table inside the 1280px shell with no horizontal scroll: each
              column is a fixed share of the available width, so long values truncate
              rather than pushing the table wider. Truncation is safe here because the
              two cells that carry the most text — Request and Target article — open a
              hover panel with the full picture, and every other cell keeps a tooltip. */}
          <div className="hidden lg:block bg-white border border-[var(--aws-border)] rounded-md">
            <table className="w-full table-fixed border-collapse text-[13px] text-center">
              <thead>
                <tr className="bg-[var(--surface-subtle)] text-[12px] text-[var(--text-secondary)]">
                  {["Request", "Target article", "Customer", "Qty", "Dates",
                    "Description", "Business head", "Status", "Actions"].map((h) => (
                    <th key={h} className={`${CELL} py-2 font-semibold`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const flags = rowActionFlags(r, caps.canNpd, caps.canEdit, canNpdCreate, canEditReq, canDeleteReq);
                  const desc = r.description ?? "";
                  const purpose = purposeLabel(r);
                  const poc = r.sales_poc_name ?? r.sales_poc_email ?? "";
                  const confirmed = day(r.confirmed_dispatch_date);
                  const expected = day(r.expected_dispatch_date);
                  const billing = billingSummary(r);
                  const targets = r.npd_targets ?? [];
                  const flip = shouldFlip(i, rows.length);
                  return (
                    <tr key={r.id} onClick={() => openRow(r.id)}
                      className="hover:bg-[var(--surface-subtle)] cursor-pointer">
                      {/* Request ID — hovering opens the WHOLE entry. */}
                      <td className={`${CELL} py-2 text-[var(--text-secondary)] tabular-nums align-top`}>
                        <Hover flip={flip} panel={<EntryPanel r={r} />}>
                          <div className="truncate underline decoration-dotted underline-offset-2">
                            {r.request_id ?? "—"}
                          </div>
                        </Hover>
                        <Sub>{typeLabel(r.sample_type)}{r.warehouse ? ` · ${r.warehouse}` : ""}</Sub>
                      </td>
                      {/* Target article — the row shows target #1; hovering lists them ALL
                          with their own pcs × weight and quantity. */}
                      <td className={`${CELL} py-2 align-top`}>
                        <Hover flip={flip} panel={<TargetsPanel r={r} />}>
                          <div className="truncate">{r.npd_target_name ?? "—"}</div>
                        </Hover>
                        <Sub title={purpose}>
                          {targets.length > 1 ? `+${targets.length - 1} more` : purpose}
                        </Sub>
                      </td>
                      {/* Customer — the field this queue was read for and never showed. */}
                      <td className={`${CELL} py-2 align-top`}>
                        <div className="truncate"
                          title={joinLines(r.customer_name, r.customer_contact, r.customer_ship_to_address)}>
                          {r.customer_name || "—"}
                        </div>
                        {r.company_name && <Sub title={r.company_name}>{r.company_name}</Sub>}
                      </td>
                      <td className={`${CELL} py-2 tabular-nums align-top`}>
                        <div className="truncate">
                          {targets.length > 1
                            ? `${Math.round(targets.reduce((n, t) => n + (Number(t.quantity) || 0), 0) * 1000) / 1000} kg`
                            : r.quantity != null ? `${r.quantity} kg` : "—"}
                        </div>
                        <Sub title={targets.length > 1 ? `Total across ${targets.length} articles` : ""}>
                          {targets.length > 1
                            ? `${targets.length} articles`
                            : r.pcs != null && r.weight_per_piece != null ? `${r.pcs} × ${r.weight_per_piece}` : ""}
                        </Sub>
                      </td>
                      {/* Raised on, then the dispatch date — NPD's confirmed one once it
                          exists, else the BD team's expected one. */}
                      <td className={`${CELL} py-2 tabular-nums align-top`}>
                        <div className="truncate" title={`Raised ${day(r.created_at) || "—"}`}>{day(r.created_at) || "—"}</div>
                        <Sub title={joinLines(
                          expected ? `Expected dispatch ${expected}` : "Expected dispatch TBC",
                          confirmed ? `Confirmed by NPD ${confirmed}` : "",
                          r.mode_of_transport ? `By ${r.mode_of_transport}` : "")}>
                          {confirmed ? `✓ ${confirmed}` : `→ ${expected || "TBC"}`}
                        </Sub>
                      </td>
                      <td className={`${CELL} py-2 align-top`}>
                        <div className="truncate" title={desc}>{desc || "—"}</div>
                        <Sub title={billing}>{billing}</Sub>
                      </td>
                      <td className={`${CELL} py-2 align-top`}>
                        <div className="truncate" title={r.requestor_team ?? ""}>{r.requestor_team ?? "—"}</div>
                        {poc && <Sub title={`Sales POC: ${poc}`}>POC {poc}</Sub>}
                      </td>
                      <td className={`${CELL} py-2 align-top`}>
                        <NpdStatusPill status={r.status} holdReason={r.hold_reason} bhSignoffState={r.bh_signoff_state} />
                      </td>
                      <td className={`${CELL} py-2 align-top`}>
                        <div className="flex justify-center">
                          <RowActions flags={flags} busy={busyId === r.id}
                            onView={() => openRow(r.id)}
                            onAccept={() => run(r.id, () => npdReview(r.id, "ACCEPT"))}
                            onHold={() => openHold(r)} onCancel={() => openCancel(r)} onEdit={() => openEdit(r)} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Pagination — 50/page (kept available even on an emptied later page). */}
      {(rows.length > 0 || offset > 0) && (
        <div className="flex items-center justify-between gap-2 mt-3">
          <span className="text-[12px] text-[var(--text-muted)]">
            Showing {rows.length === 0 ? 0 : offset + 1}–{offset + rows.length}
          </span>
          <div className="flex items-center gap-2">
            <button disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Prev</button>
            <button disabled={rows.length < PAGE_SIZE || loading} onClick={() => setOffset((o) => o + PAGE_SIZE)}
              className="h-8 px-3 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] disabled:opacity-50 hover:bg-[var(--surface-subtle)]">Next</button>
          </div>
        </div>
      )}

      {/* Hold modal — reason + start date */}
      {modal?.kind === "HOLD" && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={() => setModal(null)}>
          <div className="bg-white rounded-md w-full max-w-md p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold mb-1">Hold request {modal.row.request_id ?? modal.row.id}</h3>
            <label className="block text-[11px] text-[var(--text-secondary)] mt-2">Start date
              <input type="date" className="form-input mt-0.5" value={holdStart} onChange={(e) => setHoldStart(e.target.value)} />
            </label>
            <label className="block text-[11px] text-[var(--text-secondary)] mt-3">Reason (required)
              <textarea className="form-input mt-0.5 !h-20 py-1.5" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setModal(null)}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Cancel</button>
              <div className="flex-1" />
              <button disabled={busyId === modal.row.id || !reason.trim()}
                onClick={() => run(modal.row.id, () => npdReview(modal.row.id, "HOLD", reason, holdStart || undefined))}
                className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{busyId === modal.row.id ? "Working…" : "Confirm hold"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel modal — reason */}
      {modal?.kind === "CANCEL" && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={() => setModal(null)}>
          <div className="bg-white rounded-md w-full max-w-md p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold mb-1">Cancel request {modal.row.request_id ?? modal.row.id}</h3>
            <label className="block text-[11px] text-[var(--text-secondary)] mt-2">Reason (required)
              <textarea className="form-input mt-0.5 !h-20 py-1.5" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setModal(null)}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Back</button>
              <div className="flex-1" />
              <button disabled={busyId === modal.row.id || !reason.trim()}
                onClick={() => run(modal.row.id, () => cancelRequisition(modal.row.id, reason))}
                className="h-9 px-5 rounded-[2px] bg-[#b1361e] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[#9a2f1a]">{busyId === modal.row.id ? "Working…" : "Confirm cancel"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal — request body */}
      {modal?.kind === "EDIT" && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={() => setModal(null)}>
          <div className="bg-white rounded-md w-full max-w-2xl p-4 shadow-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold mb-2">Edit request {modal.row.request_id ?? modal.row.id}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Target NPD article name</label>
                <input className="form-input" value={editForm.npd_target_name}
                  onChange={(e) => setEditForm((f) => ({ ...f, npd_target_name: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Pcs</label>
                <input type="number" min="0" step="1" className="form-input" value={editForm.pcs}
                  onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => setEditForm((f) => ({ ...f, pcs: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Weight per piece (kg)</label>
                <input type="number" min="0" step="0.001" className="form-input" value={editForm.weight_per_piece}
                  onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => setEditForm((f) => ({ ...f, weight_per_piece: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Quantity (kg)</label>
                <input className="form-input bg-[var(--surface-subtle)] cursor-not-allowed"
                  value={editQty > 0 ? editQty.toLocaleString("en-IN") : "—"} readOnly tabIndex={-1} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Warehouse</label>
                <select className="form-input" value={editForm.warehouse}
                  onChange={(e) => setEditForm((f) => ({ ...f, warehouse: e.target.value }))}>
                  <option value="">Select…</option>
                  {/* offer the NPD 5-set, plus the row's current value if it's a legacy code */}
                  {(editForm.warehouse && !(NPD_WAREHOUSES as readonly string[]).includes(editForm.warehouse)
                    ? [editForm.warehouse, ...NPD_WAREHOUSES]
                    : NPD_WAREHOUSES
                  ).map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Purpose</label>
                <select className="form-input" value={editForm.purpose_tag}
                  onChange={(e) => setEditForm((f) => ({ ...f, purpose_tag: e.target.value }))}>
                  <option value="">Select…</option>
                  {PURPOSE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Business head</label>
                {(
                  <select className="form-input" value={editForm.requestor_team}
                    onChange={(e) => setEditForm((f) => ({
                      ...f,
                      requestor_team: e.target.value,
                      requestor_user_id: reqChoices.find((b) => b.full_name === e.target.value)?.user_id || 0,
                    }))}>
                    <option value="">Select a business head…</option>
                    {reqChoices.map((b) => (
                      <option key={`${b.user_id}:${b.full_name}`} value={b.full_name}>{b.full_name}</option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Company name</label>
                <input className="form-input" value={editForm.company_name}
                  onChange={(e) => setEditForm((f) => ({ ...f, company_name: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Customer name</label>
                <input className="form-input" value={editForm.customer_name}
                  onChange={(e) => setEditForm((f) => ({ ...f, customer_name: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Customer contact</label>
                <input className="form-input" value={editForm.customer_contact}
                  onChange={(e) => setEditForm((f) => ({ ...f, customer_contact: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Mode of transport</label>
                <input className="form-input" value={editForm.mode_of_transport}
                  onChange={(e) => setEditForm((f) => ({ ...f, mode_of_transport: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Expected dispatch date</label>
                <input type="date" className="form-input" value={editForm.expected_dispatch_date}
                  onChange={(e) => setEditForm((f) => ({ ...f, expected_dispatch_date: e.target.value }))} />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Customer ship-to address</label>
                <textarea className="form-input min-h-[56px] resize-y" value={editForm.customer_ship_to_address}
                  onChange={(e) => setEditForm((f) => ({ ...f, customer_ship_to_address: e.target.value }))} />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-[var(--text-secondary)] mb-0.5">Description</label>
                <textarea className="form-input min-h-[56px] resize-y" value={editForm.description}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="sm:col-span-2">
                <BillingFields value={editForm.billing} onChange={(b) => setEditForm((f) => ({ ...f, billing: b }))} />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setModal(null)}
                className="h-9 px-4 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[13px] hover:bg-[var(--surface-subtle)]">Cancel</button>
              <div className="flex-1" />
              <button disabled={busyId === modal.row.id || !editForm.npd_target_name.trim() || !!editBillErr}
                onClick={() => saveEdit(modal.row)}
                className="h-9 px-5 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium disabled:opacity-50 hover:bg-[var(--aws-orange-hover)]">{busyId === modal.row.id ? "Saving…" : "Save changes"}</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

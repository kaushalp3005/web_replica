"use client";

// Production → Floor Requisitions — the store's side of floor requisitions.
//
// Material the floor asked for from a job card's Material allocation tab
// (server_replica app/modules/floor_requisition). Store issues each raised request
// with the quantity it actually sent, or cancels it with a reason; the floor then
// marks it received on the job card. Nothing here moves stock.
//
// Filtered and paged on the server, PAGE_SIZE rows a page — requests pile up over
// time. Opens on Raised, the ones waiting for store. The server also limits the
// list to the viewer's granted warehouses and floors.
//
// Layout: bordered table from md up, stacked cards below it.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BackLink } from "@/components/BackLink";
import { BrandMark } from "@/components/BrandMark";
import {
  BTN_LINK, BTN_PRIMARY, CancelRequisitionDialog, FIELD, StatusTag,
} from "@/components/floor-requisitions/RequisitionUi";
import { FLOORS_BY_WAREHOUSE } from "@/lib/admin-api";
import { friendlyApiError } from "@/lib/apiErrors";
import {
  formatQty, formatWhen, REQUISITION_STATUSES, STATUS_LABEL, storeResponseLine, type RequisitionStatus,
} from "@/lib/floor-requisition-form";
import {
  listFloorRequisitions, RequisitionApiError, type FloorRequisition, type FloorRequisitionPage,
} from "@/lib/floor-requisitions";
import { useHasPermission, useMe, useRequireAuth, useRequireModuleAccess, useUserInitial } from "@/lib/user";
import { IssueDialog } from "./_IssueDialog";

const PAGE_SIZE = 100;
const PLANTS = Object.keys(FLOORS_BY_WAREHOUSE);

const CARD =
  "bg-white border border-[var(--aws-border)] rounded-md shadow-[0_1px_1px_rgba(0,28,36,0.18)] p-3 sm:p-4 mb-4";
const TABLE = "w-full text-[12px] border-collapse";
const TH =
  "border border-[var(--aws-border)] bg-[#fafafa] px-2.5 py-2 text-left text-[10px] font-bold uppercase " +
  "tracking-wide text-[var(--text-secondary)] whitespace-nowrap";
const TD = "border border-[var(--aws-border)] px-2.5 py-2 align-top";
const HINT = "text-[12px] text-[var(--text-muted)] italic";
const SUB = "text-[11px] text-[var(--text-muted)] break-words";
const PAGE_BTN =
  "h-7 px-2.5 rounded-[2px] border border-[var(--aws-border-strong)] bg-white text-[12px] " +
  "hover:border-[var(--aws-navy)] disabled:opacity-50 disabled:cursor-not-allowed";

function Chrome({ children }: { children: ReactNode }) {
  const router = useRouter();
  const initial = useUserInitial();
  return (
    <div className="min-h-screen flex flex-col bg-[var(--background)]">
      <header className="bg-[var(--aws-navy)] h-[45px] flex items-center px-4 sm:px-6 gap-4">
        <BrandMark />
        <span className="text-[#d5dbdb] text-[13px] hidden sm:inline">Console</span>
        <nav className="text-[12px] text-[#d5dbdb] hidden md:flex items-center gap-2 ml-2">
          <button onClick={() => router.push("/modules")} className="hover:underline">Modules</button>
          <span>/</span>
          <button onClick={() => router.push("/modules/production")} className="hover:underline">Production</button>
          <span>/</span>
          <span className="text-white">Floor Requisitions</span>
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => router.push("/modules/profile")}
          aria-label="Open profile"
          title="Profile"
          className="w-8 h-8 rounded-full bg-[var(--aws-orange)] text-white text-[13px] font-bold flex items-center justify-center hover:bg-[var(--aws-orange-hover)]"
        >
          {initial}
        </button>
      </header>
      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6">
        <div className="mb-3">
          <BackLink parentHref="/modules/production" label="production" />
        </div>
        {children}
      </main>
    </div>
  );
}

function Issued({ r }: { r: FloorRequisition }) {
  if (r.issued_qty == null) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="font-mono tabular-nums whitespace-nowrap">{formatQty(r.issued_qty, r.requested_unit)}</span>
      <span className={SUB}>{r.issued_by} · {formatWhen(r.issued_at)}</span>
    </span>
  );
}

export default function FloorRequisitionsPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  useRequireModuleAccess("production/floor-requisitions", router.replace);
  const me = useMe();
  const canView = useHasPermission("production", "floor_requisitions", null, "view");
  const canIssue = useHasPermission("production", "floor_requisitions", null, "issue");
  const canCancel = useHasPermission("production", "floor_requisitions", null, "cancel");

  const [status, setStatus] = useState<RequisitionStatus | "">("raised");
  const [plant, setPlant] = useState("");
  const [floor, setFloor] = useState("");
  const [search, setSearch] = useState("");
  const [searchApplied, setSearchApplied] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FloorRequisitionPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A 403 here means the caller picked a plant/floor outside their granted
  // warehouses — not an outage. Kept separate from `err` so it reads calmly
  // (no red banner) and the filters stay usable to pick another.
  const [notAssigned, setNotAssigned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0); // bumped by Retry and after every change
  const [issuing, setIssuing] = useState<FloorRequisition | null>(null);
  const [cancelling, setCancelling] = useState<FloorRequisition | null>(null);

  // Search is sent a moment after typing stops, not on every key.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchApplied(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!canView) return;
    const ctrl = new AbortController();
    queueMicrotask(() => {
      setLoading(true);
      listFloorRequisitions(
        { status, warehouse: plant, floor, search: searchApplied, page, pageSize: PAGE_SIZE },
        ctrl.signal,
      )
        .then((p) => { if (!ctrl.signal.aborted) { setData(p); setErr(null); setNotAssigned(false); } })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          if (e instanceof RequisitionApiError && e.status === 403) {
            // Not a genuine error — the picked plant/floor just isn't one of
            // theirs. Clear any stale page so it doesn't show alongside the note.
            setData(null);
            setErr(null);
            setNotAssigned(true);
          } else {
            setErr(friendlyApiError(e));
            setNotAssigned(false);
          }
        })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    });
    return () => ctrl.abort();
  }, [canView, status, plant, floor, searchApplied, page, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  // Issuing the last row of the last page shrinks the list under the reader:
  // step back to the page that now exists.
  useEffect(() => {
    if (data && page > pageCount) queueMicrotask(() => setPage(pageCount));
  }, [data, page, pageCount]);

  if (!me) {
    return <Chrome><div className={CARD}><p className={HINT}>Loading…</p></div></Chrome>;
  }
  if (!canView) {
    return (
      <Chrome>
        <div className={CARD}>
          <p className={HINT}>
            You don&apos;t have access to floor requisitions. Ask an admin for the Floor Requisitions view permission.
          </p>
        </div>
      </Chrome>
    );
  }

  const floors = plant
    ? FLOORS_BY_WAREHOUSE[plant] ?? []
    : [...new Set(Object.values(FLOORS_BY_WAREHOUSE).flat())];
  const filtering = status !== "raised" || plant !== "" || floor !== "" || search.trim() !== "";
  const showActions = canIssue || canCancel;

  function action(r: FloorRequisition) {
    if (r.status !== "raised") return null;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {canIssue ? <button type="button" className={BTN_PRIMARY} onClick={() => setIssuing(r)}>Issue</button> : null}
        {canCancel ? <button type="button" className={BTN_LINK} onClick={() => setCancelling(r)}>Cancel</button> : null}
      </span>
    );
  }

  const pager = data && pageCount > 1 ? (
    <nav aria-label="Requisition pages" className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
      <span className="text-[var(--text-secondary)]">
        {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
      </span>
      <div className="flex items-center gap-1.5">
        <button type="button" className={PAGE_BTN} disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
        <span className="px-1 whitespace-nowrap text-[var(--text-secondary)]">Page {page} of {pageCount}</span>
        <button type="button" className={PAGE_BTN} disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next ›</button>
      </div>
    </nav>
  ) : null;

  return (
    <Chrome>
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
        <h1 className="text-[20px] leading-[24px] font-semibold text-[var(--text-primary)]">Floor Requisitions</h1>
        {data ? (
          <span className="text-[12px] text-[var(--text-secondary)]">
            {data.total} request{data.total !== 1 ? "s" : ""}{loading ? " · refreshing…" : ""}
          </span>
        ) : null}
      </div>

      <div className={CARD}>
        {/* Filters: stacked full-width on a phone, one wrapping row from sm up. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search article"
            aria-label="Search article"
            className={`${FIELD} w-full sm:w-auto sm:flex-1 sm:min-w-[220px]`}
          />
          <div className="flex flex-wrap gap-2">
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value as RequisitionStatus | ""); setPage(1); }}
              aria-label="Filter by status"
              className={`${FIELD} flex-1 sm:flex-none`}
            >
              <option value="">Status: all</option>
              {REQUISITION_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <select
              value={plant}
              onChange={(e) => {
                const next = e.target.value;
                setPlant(next);
                if (next && !(FLOORS_BY_WAREHOUSE[next] ?? []).includes(floor)) setFloor("");
                setPage(1);
              }}
              aria-label="Filter by plant"
              className={`${FIELD} flex-1 sm:flex-none`}
            >
              <option value="">Plant: all</option>
              {PLANTS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select
              value={floor}
              onChange={(e) => { setFloor(e.target.value); setPage(1); }}
              aria-label="Filter by floor"
              className={`${FIELD} flex-1 sm:flex-none`}
            >
              <option value="">Floor: all</option>
              {floors.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          {filtering ? (
            <button
              type="button"
              className={BTN_LINK}
              onClick={() => {
                setStatus("raised"); setPlant(""); setFloor(""); setSearch(""); setSearchApplied(""); setPage(1);
              }}
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>

      <div className={CARD}>
        {notAssigned ? (
          <p className={HINT}>You are not assigned to that plant or floor. Pick a different one above.</p>
        ) : err ? (
          <p className="text-[12px] text-[var(--aws-error)]">
            {err}{" "}
            <button type="button" onClick={reload} className="underline">Retry</button>
          </p>
        ) : !data ? (
          <p className={HINT}>Loading requisitions…</p>
        ) : data.items.length === 0 ? (
          <p className={HINT}>
            {status === "raised" && !filtering ? "Nothing is waiting for store." : "No requisitions match these filters."}
          </p>
        ) : (
          <>
            {pager ? <div className="mb-2">{pager}</div> : null}
            <div className="hidden md:block overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th className={TH}>Number</th>
                    <th className={TH}>Job card</th>
                    <th className={TH}>Place</th>
                    <th className={TH}>Article</th>
                    <th className={`${TH} text-right`}>Requested</th>
                    <th className={`${TH} text-right`}>Short when raised</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Raised</th>
                    <th className={TH}>Issued</th>
                    {showActions ? <th className={TH}>Action</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.requisition_id}>
                      <td className={`${TD} font-mono whitespace-nowrap`}>#{r.requisition_id}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <Link href={`/modules/job-card/${r.job_card_id}`} className="text-[var(--aws-link)] underline">
                          {r.job_card_id}
                        </Link>
                      </td>
                      <td className={TD}>{r.warehouse} · {r.floor}</td>
                      <td className={`${TD} text-[var(--text-primary)]`}>
                        {r.material_sku_name}
                        {r.item_type ? <span className="text-[var(--text-muted)]"> · {r.item_type}</span> : null}
                        {r.note ? <span className={`block ${SUB}`}>{r.note}</span> : null}
                      </td>
                      <td className={`${TD} text-right font-mono tabular-nums whitespace-nowrap`}>
                        {formatQty(r.requested_qty, r.requested_unit)}
                      </td>
                      <td className={`${TD} text-right font-mono tabular-nums whitespace-nowrap`}>
                        {r.shortage_qty != null ? formatQty(r.shortage_qty, r.requested_unit) : "—"}
                      </td>
                      <td className={TD}>
                        <StatusTag status={r.status} />
                        {r.status === "cancelled" && r.cancel_reason ? <span className={`block ${SUB}`}>{r.cancel_reason}</span> : null}
                        {r.status === "raised" && r.store_response ? (
                          <span className={`block ${SUB}`}>{storeResponseLine(r.store_response)}</span>
                        ) : null}
                      </td>
                      <td className={TD}>
                        <span className="block break-words">{r.raised_by}</span>
                        <span className={SUB}>{formatWhen(r.raised_at)}</span>
                      </td>
                      <td className={TD}><Issued r={r} /></td>
                      {showActions ? <td className={TD}>{action(r) ?? <span className="text-[var(--text-muted)]">—</span>}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="md:hidden space-y-2">
              {data.items.map((r) => {
                const act = showActions ? action(r) : null;
                return (
                  <li key={r.requisition_id} className="border border-[var(--aws-border)] rounded-[2px] bg-white p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-[13px] font-medium text-[var(--text-primary)]">
                        {r.material_sku_name}
                      </span>
                      <StatusTag status={r.status} />
                    </div>
                    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                      <dt className="text-[var(--text-muted)]">Number</dt>
                      <dd className="font-mono">#{r.requisition_id}</dd>
                      <dt className="text-[var(--text-muted)]">Job card</dt>
                      <dd>
                        <Link href={`/modules/job-card/${r.job_card_id}`} className="text-[var(--aws-link)] underline">
                          {r.job_card_id}
                        </Link>
                      </dd>
                      <dt className="text-[var(--text-muted)]">Place</dt>
                      <dd className="break-words">{r.warehouse} · {r.floor}</dd>
                      <dt className="text-[var(--text-muted)]">Requested</dt>
                      <dd className="font-mono tabular-nums">{formatQty(r.requested_qty, r.requested_unit)}</dd>
                      <dt className="text-[var(--text-muted)]">Raised</dt>
                      <dd className="break-words">{r.raised_by} · {formatWhen(r.raised_at)}</dd>
                      {r.status === "raised" && r.store_response ? (
                        <>
                          <dt className="text-[var(--text-muted)]">Store</dt>
                          <dd className="break-words">{storeResponseLine(r.store_response)}</dd>
                        </>
                      ) : null}
                      <dt className="text-[var(--text-muted)]">Issued</dt>
                      <dd><Issued r={r} /></dd>
                    </dl>
                    {act ? <div className="mt-2 border-t border-[var(--aws-border)] pt-2">{act}</div> : null}
                  </li>
                );
              })}
            </ul>
            {pager ? <div className="mt-3">{pager}</div> : null}
          </>
        )}
      </div>

      {issuing ? (
        <IssueDialog
          requisition={issuing}
          onClose={() => setIssuing(null)}
          onDone={() => { setIssuing(null); reload(); }}
        />
      ) : null}
      {cancelling ? (
        <CancelRequisitionDialog
          requisition={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => { setCancelling(null); reload(); }}
        />
      ) : null}
    </Chrome>
  );
}

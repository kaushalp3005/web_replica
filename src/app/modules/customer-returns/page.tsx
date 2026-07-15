"use client";

// Customer-Returns list. Live: GET /api/v1/customer-returns/{company} with
// status/customer/date filters, server pagination, xlsx export, delete.
// Keyed by rtv_id (the CR- string) — there is no numeric id.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import {
  listCustomerReturns,
  deleteCustomerReturn,
  exportCustomerReturns,
  toApiDate,
  type CRListItem,
  type CRStatus,
} from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "./_chrome";
import { CompanyToggle, StatusBadge, ErrorBanner, useCompany, cx, fmtDate } from "./_shared";

const PER_PAGE = 20;
const STATUS_TABS: { label: string; value: CRStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Pending", value: "Pending" },
  { label: "Approved", value: "Approved" },
  { label: "Submitted", value: "Submitted" },
];

export default function CustomerReturnsListPage() {
  const router = useRouter();
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const [company, setCompany] = useCompany();

  const [records, setRecords] = useState<CRListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<CRStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);

  const [deleteTarget, setDeleteTarget] = useState<CRListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listCustomerReturns(company, {
        page,
        per_page: PER_PAGE,
        status: statusFilter === "all" ? undefined : statusFilter,
        customer: search || undefined,
        from_date: toApiDate(fromDate),
        to_date: toApiDate(toDate),
        sort_by: "created_ts",
        sort_order: "desc",
      });
      setRecords(res.records);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load customer returns");
      setRecords([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [company, page, statusFilter, search, fromDate, toDate]);

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(load, 350); // debounce search/filter typing
    return () => clearTimeout(t);
  }, [isAdmin, load]);

  useEffect(() => {
    // Defer past the synchronous effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => setPage(1));
  }, [company, statusFilter, search, fromDate, toDate]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const hasFilters = !!(search || fromDate || toDate || statusFilter !== "all");

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCustomerReturn(company, deleteTarget.rtv_id);
      setDeleteTarget(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      const blob = await exportCustomerReturns(company, {
        status: statusFilter === "all" ? undefined : statusFilter,
        customer: search || undefined,
        from_date: toApiDate(fromDate),
        to_date: toApiDate(toDate),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `customer_returns_${company}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  const clearFilters = () => {
    setSearch("");
    setFromDate("");
    setToDate("");
    setStatusFilter("all");
  };

  const body = useMemo(() => {
    if (loading) {
      return <div className="p-8 text-center text-[13px] text-[var(--text-secondary)]">Loading…</div>;
    }
    if (records.length === 0) {
      return (
        <div className="p-10 text-center">
          <p className="text-[13px] font-medium text-[var(--text-primary)]">No customer returns found</p>
          <p className="text-[12px] text-[var(--text-secondary)] mt-1">
            {hasFilters ? "Try adjusting your filters." : "Create your first CR entry."}
          </p>
        </div>
      );
    }
    return (
      <>
        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                <th className="px-4 py-2.5 font-medium">CR No</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Business Head</th>
                <th className="px-4 py-2.5 font-medium hidden lg:table-cell">Factory</th>
                <th className="px-4 py-2.5 font-medium text-right">Items</th>
                <th className="px-4 py-2.5 font-medium text-right hidden lg:table-cell">Net Wt (kg)</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.rtv_id} className="border-b border-[var(--aws-border)] last:border-0 hover:bg-[var(--background)]">
                  <td className="px-4 py-2.5">
                    <Link href={`/modules/customer-returns/${r.rtv_id}?company=${company}`} className="font-medium text-[var(--aws-link)] hover:underline break-all">
                      {r.rtv_id}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)]">{fmtDate(r.rtv_date)}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)] truncate max-w-[200px]">{r.customer || "—"}</td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)] hidden lg:table-cell">{r.business_head || "—"}</td>
                  <td className="px-4 py-2.5 text-[var(--text-secondary)] hidden lg:table-cell">{r.factory_unit || "—"}</td>
                  <td className="px-4 py-2.5 text-right">{r.items_count}</td>
                  <td className="px-4 py-2.5 text-right text-[var(--text-secondary)] hidden lg:table-cell">{r.total_net_weight}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <Link href={`/modules/customer-returns/${r.rtv_id}?company=${company}`} className="text-[12px] text-[var(--aws-link)] hover:underline">
                        View
                      </Link>
                      {r.status === "Pending" && (
                        <button
                          onClick={() => setDeleteTarget(r)}
                          className="text-[12px] text-[var(--aws-error)] hover:underline"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden divide-y divide-[var(--aws-border)]">
          {records.map((r) => (
            <div key={r.rtv_id} className="p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/modules/customer-returns/${r.rtv_id}?company=${company}`} className="text-[13px] font-medium text-[var(--aws-link)] hover:underline break-all">
                    {r.rtv_id}
                  </Link>
                  <p className="text-[11px] text-[var(--text-secondary)]">
                    {fmtDate(r.rtv_date)}{r.customer ? ` · ${r.customer}` : ""}
                  </p>
                </div>
                <StatusBadge status={r.status} />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
                <span>{r.items_count} items</span>
                <span>Net: {r.total_net_weight} kg</span>
                {r.factory_unit && <span>{r.factory_unit}</span>}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }, [loading, records, hasFilters, company]);

  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title="Customer Returns">
        <h1 className="text-[20px] font-semibold text-[var(--text-primary)] mb-3">Customer Returns</h1>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module. Ask an administrator to grant you access, or
          switch to a different account.
        </section>
      </CustomerReturnsChrome>
    );
  }

  return (
    <CustomerReturnsChrome title="Customer Returns">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-[18px] font-bold text-[var(--text-primary)]">Customer Returns</h1>
          <p className="text-[12px] text-[var(--text-secondary)]">Returns received from customers · CR documents</p>
        </div>
        <div className="flex-1" />
        <CompanyToggle value={company} onChange={setCompany} />
        <Link
          href={`/modules/customer-returns/new?company=${company}`}
          className="text-[12px] font-semibold bg-[var(--aws-orange)] text-white rounded-[6px] px-3 py-[7px] hover:bg-[var(--aws-orange-hover)]"
        >
          + New CR
        </Link>
      </div>

      {/* Status tabs */}
      <div className="inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px] mb-3">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setStatusFilter(t.value)}
            aria-pressed={statusFilter === t.value}
            className={cx(
              "text-[12px] px-[12px] py-[4px] rounded-[6px]",
              statusFilter === t.value ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by customer…"
          className="flex-1 h-9 rounded-md border border-[var(--aws-border)] px-3 text-[13px] bg-white"
        />
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 rounded-md border border-[var(--aws-border)] px-2 text-[13px] bg-white" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 rounded-md border border-[var(--aws-border)] px-2 text-[13px] bg-white" />
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="h-9 rounded-md border border-[var(--aws-border)] px-3 text-[13px] bg-white hover:border-[var(--aws-orange)] disabled:opacity-50"
        >
          {downloading ? "Exporting…" : "Export"}
        </button>
        {hasFilters && (
          <button onClick={clearFilters} className="h-9 rounded-md px-3 text-[13px] text-[var(--text-secondary)] hover:underline">
            Clear
          </button>
        )}
      </div>

      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}

      <div className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">{body}</div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-3 text-[12px] text-[var(--text-secondary)]">
        <span>Page {page} of {totalPages} · {total} total</span>
        <div className="flex gap-1">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-[var(--aws-border)] px-3 py-1 bg-white disabled:opacity-40"
          >
            Prev
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-[var(--aws-border)] px-3 py-1 bg-white disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="bg-white rounded-lg max-w-md w-full p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Delete CR</h2>
            <p className="text-[13px] text-[var(--text-secondary)] mt-2">
              Delete <span className="font-medium text-[var(--text-primary)]">{deleteTarget.rtv_id}</span>? This removes all
              lines and boxes and cannot be undone.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="text-[13px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-[13px] rounded-md px-3 py-1.5 bg-[var(--aws-error)] text-white disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </CustomerReturnsChrome>
  );
}

"use client";

// Customer Return — read-only detail. Faithful port of the legacy rtv/[id] view
// (legacy-frontend/app/[company]/rtv/[id]/page.tsx): header card + lines table +
// boxes table, no edit/print/delete. Reached from the dashboard (the editable
// detail at ../[id] is reached from the list). Keyed by rtv_id (no numeric id);
// web_replica idiom: maroon --aws tokens, inline SVG, native date fmt.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { getCustomerReturn, type CRWithDetails } from "@/lib/customer-returns";
import { CustomerReturnsChrome } from "../../_chrome";
import { StatusBadge, CompanyChip, CrHeaderGrid, useCompanyParam, cx, fmtN, fmtV, fmtR } from "../../_shared";

const IArrowLeft = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-4 w-4"} aria-hidden="true"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
);
const IWarn = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-8 w-8"} aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
);

export default function CustomerReturnViewPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const crId = decodeURIComponent(params.id);
  useRequireAuth(router.replace);
  const isAdmin = useIsAdmin();
  const company = useCompanyParam();

  const [data, setData] = useState<CRWithDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dashHref = `/modules/customer-returns/dashboard?company=${company}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getCustomerReturn(company, crId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load customer return");
    } finally {
      setLoading(false);
    }
  }, [company, crId]);

  useEffect(() => {
    if (!isAdmin) return;
    queueMicrotask(() => { load(); });
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <CustomerReturnsChrome title="View">
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Customer Returns module.
        </section>
      </CustomerReturnsChrome>
    );
  }

  return (
    <CustomerReturnsChrome title="View">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Link href={dashHref} aria-label="Back to dashboard" className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-[var(--background)] text-[var(--text-secondary)] flex-shrink-0">
          <IArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[18px] sm:text-[22px] font-bold tracking-tight text-[var(--text-primary)] break-all">
              {data?.rtv_id ?? (loading ? "Loading…" : "Customer Return")}
            </h1>
            {data && <StatusBadge status={data.status} />}
            <CompanyChip company={company} />
          </div>
          <p className="text-[12px] text-[var(--text-secondary)]">Customer Return · Read-only view</p>
        </div>
      </div>

      {error && (
        <div className="bg-white border border-[#f0c7be] rounded-md py-8 text-center">
          <IWarn className="h-8 w-8 text-[var(--aws-error)] mx-auto mb-2" />
          <p className="text-[13px] font-medium text-[var(--text-primary)]">Customer return not found</p>
          <p className="text-[12px] text-[var(--text-secondary)] mt-1">{error}</p>
          <Link href={dashHref} className="inline-block mt-4 text-[12px] rounded-md border border-[var(--aws-border)] px-3 py-1.5 bg-white">Back to dashboard</Link>
        </div>
      )}

      {loading && !error && (
        <div className="space-y-4">
          <div className="h-40 rounded-md bg-[var(--background)] animate-pulse" />
          <div className="h-60 rounded-md bg-[var(--background)] animate-pulse" />
        </div>
      )}

      {data && !error && !loading && (
        <div className="space-y-4">
          {/* Header card */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Header</h2>
            <CrHeaderGrid cr={data} />
          </section>

          {/* Lines */}
          <section className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] px-4 pt-4 pb-3">Lines ({data.lines?.length ?? 0})</h2>
            {!data.lines || data.lines.length === 0 ? (
              <div className="py-8 text-center text-[13px] text-[var(--text-secondary)]">No lines</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                      <Th>Material</Th><Th>Category</Th><Th>Sub Category</Th><Th>Item</Th><Th>UOM</Th>
                      <Th right>Qty</Th><Th right>Rate</Th><Th right>Value</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => (
                      <tr key={l.item_description} className="border-b border-[var(--aws-border)] last:border-0">
                        <td className="px-3 py-2 text-[var(--text-secondary)]">{l.material_type}</td>
                        <td className="px-3 py-2 text-[var(--text-secondary)]">{l.item_category}</td>
                        <td className="px-3 py-2 text-[var(--text-secondary)]">{l.sub_category}</td>
                        <td className="px-3 py-2 break-words max-w-[220px]">{l.item_description}</td>
                        <td className="px-3 py-2 text-[var(--text-secondary)]">{l.uom}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtN(l.qty)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtR(l.rate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtV(l.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Boxes */}
          {data.boxes && data.boxes.length > 0 && (
            <section className="bg-white border border-[var(--aws-border)] rounded-md overflow-hidden">
              <h2 className="text-[13px] font-semibold text-[var(--text-primary)] px-4 pt-4 pb-3">Boxes ({data.boxes.length})</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--aws-border)] bg-[var(--background)] text-left text-[var(--text-secondary)]">
                      <Th>Box No</Th><Th>Box ID</Th><Th>Article</Th><Th>Lot</Th>
                      <Th right>Net Wt</Th><Th right>Gross Wt</Th><Th right>Count</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.boxes.map((b) => (
                      <tr key={`${b.article_description}#${b.box_number}`} className="border-b border-[var(--aws-border)] last:border-0">
                        <td className="px-3 py-2 tabular-nums">{b.box_number}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-[var(--text-secondary)]">{b.box_id || "—"}</td>
                        <td className="px-3 py-2 break-words max-w-[200px]">{b.article_description}</td>
                        <td className="px-3 py-2 text-[var(--text-secondary)]">{b.lot_number || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtN(b.net_weight)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtN(b.gross_weight)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{b.count ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </CustomerReturnsChrome>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={cx("text-[11px] uppercase tracking-wider font-medium px-3 py-2", right ? "text-right" : "text-left")}>{children}</th>;
}

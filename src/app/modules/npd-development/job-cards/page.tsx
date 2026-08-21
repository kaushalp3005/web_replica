"use client";

// NPD development job cards — standalone R&D, decoupled from sample requisitions.
// Lists npd_dev_job_cards; creation and closure (which promotes the trial recipe
// into a live BOM) are their own process, separate from the sample-issuance
// lifecycle. Hydration-safe via a `mounted` gate.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Breadcrumbs, NPD_DEV_ROOT } from "@/components/Breadcrumbs";
import { useRequireAuth, useUserInitial, useMe, useHasPermission } from "@/lib/user";
import { sampleCaps } from "@/lib/sample-roles";
import { listDevJobCards, type DevJobCard, type DevArticle } from "@/lib/npd-dev";
import { DEV_JC_STATUS_STYLES, DevJcStatusPill } from "../../sample/_shared";
import { CELL, Sub, Hover, Field, Pair, day, joinLines, qtyWithUom, shouldFlip } from "../_queue-ui";

const STATUS_OPTIONS = Object.keys(DEV_JC_STATUS_STYLES);

const num = (v: unknown): string =>
  v === null || v === undefined || v === "" ? "—" : Number(v).toLocaleString("en-IN");

/** The card's target articles (082). Falls back to the header mirror for a legacy
 *  single-product card, matching what the server sends. */
function articlesOf(r: DevJobCard): DevArticle[] {
  if (r.articles?.length) return r.articles;
  return [{ article_id: null, name: r.fg_sku_name ?? r.title, pcs: r.pcs,
            weight_per_piece: r.weight_per_piece, quantity: r.target_qty, uom: r.uom,
            yield_pct: r.yield_pct, promoted_bom_id: r.promoted_bom_id }];
}

/** Every target product on the card with its own pcs × weight → target qty, plus what
 *  it actually yielded once the card is closed. The row can only show article #1 (the
 *  header mirror), so a multi-product card looks single-product until you hover it. */
function ArticlesPanel({ r }: { r: DevJobCard }) {
  const arts = articlesOf(r);
  const total = arts.reduce((n, a) => n + (Number(a.quantity) || 0), 0);
  const anyOut = arts.some((a) => a.output_qty != null || a.promoted_bom_id != null);
  return (
    <>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {arts.length} target article{arts.length === 1 ? "" : "s"}
      </div>
      <table className="w-full text-[12px]">
        <tbody>
          {arts.map((a, i) => (
            <tr key={a.article_id ?? i} className="align-top">
              <td className="py-[3px] pr-2 text-[var(--text-primary)] break-words">
                {a.name || "—"}
                {a.promoted_bom_id != null && (
                  <span className="block text-[11px] text-[var(--text-muted)]">BOM #{a.promoted_bom_id}</span>
                )}
              </td>
              <td className="py-[3px] whitespace-nowrap text-right tabular-nums text-[var(--text-secondary)]">
                {a.pcs != null && a.weight_per_piece != null
                  ? `${a.pcs} pcs × ${a.weight_per_piece} ${a.uom || "kg"}`
                  : "—"}
              </td>
              <td className="py-[3px] pl-2 whitespace-nowrap text-right tabular-nums font-medium">
                {qtyWithUom(a.quantity, a.uom)}
                {anyOut && (
                  <span className="block text-[11px] font-normal text-[var(--text-muted)]">
                    {a.output_qty != null ? `out ${qtyWithUom(a.output_qty, a.output_uom ?? a.uom)}` : "—"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        {arts.length > 1 && (
          <tfoot>
            <tr className="border-t border-[var(--surface-divider)]">
              <td className="pt-1.5 text-[11px] text-[var(--text-muted)]" colSpan={2}>Total target</td>
              <td className="pt-1.5 pl-2 whitespace-nowrap text-right tabular-nums font-semibold">
                {Math.round(total * 1000) / 1000} {r.uom || "kg"}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </>
  );
}

/** The whole job card — everything the card carries plus what it inherited from the
 *  request it came from, so the queue answers "what is this?" without a round trip. */
function CardPanel({ r }: { r: DevJobCard }) {
  const arts = articlesOf(r);
  const ship = r.customer_ship_to_address ?? "";
  const billing = [
    r.returnable ? "Returnable" : r.non_returnable ? "Non-returnable" : "",
    r.paid ? `Paid ${num(r.amount)}` : "",
  ].filter(Boolean).join(" · ") || "—";
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[13px] font-semibold tabular-nums">{r.id}</span>
        <DevJcStatusPill status={r.status} />
      </div>
      <div className="divide-y divide-[var(--surface-divider)]">
        <div className="pb-1">
          <Pair a={["Title", r.title || "—"]} b={["Warehouse", r.warehouse ?? "—"]} />
          <Pair a={["Created", day(r.created_at) || "—"]}
                b={["Closed", day(r.closed_at) || (day(r.started_at) ? `started ${day(r.started_at)}` : "—")]} />
          <Pair a={["Target qty", qtyWithUom(r.target_qty, r.uom)]}
                b={["Output", r.output_qty != null ? qtyWithUom(r.output_qty, r.output_uom ?? r.uom) : "—"]} />
          <Pair a={["Yield", r.yield_pct != null ? `${num(r.yield_pct)}%` : "—"]}
                b={["Promoted BOM", r.promoted_bom_id != null ? `#${r.promoted_bom_id}` : "—"]} />
          {(r.rm_consumed_qty != null || r.wastage_qty != null) && (
            <Pair a={["RM consumed", r.rm_consumed_qty != null ? qtyWithUom(r.rm_consumed_qty, r.uom) : "—"]}
                  b={["Wastage", r.wastage_qty != null ? qtyWithUom(r.wastage_qty, r.uom) : "—"]} />
          )}
          {/* A COUNT, not the list: the Target FG cell one column over has a dedicated
              panel that lays every article out with its own pcs × weight, quantity and
              output. Repeating it here only made this panel taller than the viewport. */}
          <Pair a={["Articles", arts.length > 1
                      ? `${arts.length} · ${Math.round(arts.reduce((n, a) => n + (Number(a.quantity) || 0), 0) * 1000) / 1000} ${r.uom || "kg"}`
                      : (arts[0]?.name ?? "—")]}
                b={r.fg_sample_batch_id ? ["FG batch", r.fg_sample_batch_id] : undefined} />
        </div>
        <div className="py-1">
          <Field label="Customer">
            {r.customer_name || "—"}{r.company_name ? ` · ${r.company_name}` : ""}
          </Field>
          {r.customer_contact && <Field label="Contact">{r.customer_contact}</Field>}
          {ship && <Field label="Ship to">{ship}</Field>}
          {/* Paired rather than stacked: the panel already runs long, and these four are
              short enough to read two-up. */}
          <Pair a={["Dispatch", day(r.confirmed_dispatch_date)
                      ? `✓ ${day(r.confirmed_dispatch_date)}`
                      : day(r.expected_dispatch_date) || "TBC"]}
                b={["Billing", billing]} />
        </div>
        {/* Where the card came from — a standalone R&D card has no request behind it. */}
        <div className="py-1">
          <Pair a={["Source", r.source_requisition_id ? `Request ${r.source_requisition_id}` : "Standalone"]} />
          {(r.source_requestor_name || r.source_sales_poc_name) && (
            <Pair a={["Business head", r.source_requestor_name || "—"]}
                  b={r.source_sales_poc_name ? ["Sales POC", r.source_sales_poc_name] : undefined} />
          )}
        </div>
        {(r.description ?? "").trim() && (
          <div className="py-1"><Field label="Description">{r.description}</Field></div>
        )}
        {r.cancellation_reason && (
          <div className="pt-1"><Field label="Cancelled">{r.cancellation_reason}</Field></div>
        )}
      </div>
    </>
  );
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
          <button onClick={() => router.push("/modules/npd-development")} className="hover:underline">NPD Development</button>
          <span>/</span>
          <span className="text-white">Job cards</span>
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

export default function NpdDevJobCardsPage() {
  const router = useRouter();
  const authed = useRequireAuth(router.replace);
  const initial = useUserInitial();
  const me = useMe();
  const caps = useMemo(() => sampleCaps(me), [me]);
  const canCreateJc = useHasPermission("sample", "npd", null, "create");

  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<DevJobCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { queueMicrotask(() => setMounted(true)); }, []);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await listDevJobCards(status || undefined);
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load development job cards");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authed, status]);

  function openRow(id: number) {
    router.push(`/modules/npd-development/job-cards/${id}`);
  }

  if (!mounted) {
    return (
      <Shell initial={initial} router={router}>
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-2 text-[13px]">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading development job cards…
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell initial={initial} router={router}>
      <Breadcrumbs items={[...NPD_DEV_ROOT, { label: "Job cards", href: "/modules/npd-development/job-cards" }]} className="mb-3" />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-7 font-semibold text-[var(--text-primary)]">NPD development job cards</h1>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{rows.length} shown · standalone product development</p>
        </div>
        <div className="flex-1" />
        {caps.canNpd && canCreateJc && (
          <button
            onClick={() => router.push("/modules/npd-development/job-cards/new")}
            className="h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-white text-[13px] font-medium hover:bg-[var(--aws-orange-hover)]"
          >+ New job card</button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select className="form-input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        {loading && <span className="self-center text-[12px] text-[var(--text-muted)]">Refreshing…</span>}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-[#f0c7be] bg-[#fdf3f1] px-3 py-2 text-[13px] text-[#b1361e]">{error}</div>
      )}

      {rows.length === 0 && !loading ? (
        <div className="bg-white border border-[var(--aws-border)] rounded-md p-10 text-center text-[13px] text-[var(--text-secondary)]">
          No development job cards yet.{caps.canNpd ? " Use “+ New job card” to start one." : ""}
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="grid grid-cols-1 gap-2 lg:hidden">
            {rows.map((r) => (
              <button key={r.id} onClick={() => openRow(r.id)}
                className="text-left bg-white border border-[var(--aws-border)] rounded-md p-3 hover:border-[var(--aws-orange)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[13px] text-[var(--text-primary)] font-mono tabular-nums">{r.id}</span>
                  <DevJcStatusPill status={r.status} />
                </div>
                <div className="mt-0.5 text-[13px] text-[var(--text-primary)] truncate">{r.title}</div>
                {/* Every target article with its own quantity — the hover panel's job on
                    the desktop table, done inline here where there is nothing to hover. */}
                {articlesOf(r).map((a, i) => (
                  <div key={a.article_id ?? i} className="text-[12px] text-[var(--text-secondary)] truncate"
                    title={`${a.name ?? ""} — ${qtyWithUom(a.quantity, a.uom)}`}>
                    {i === 0 ? "Target: " : ""}{a.name}
                    {a.quantity != null && (
                      <span className="text-[var(--text-muted)]"> — {qtyWithUom(a.quantity, a.uom)}</span>
                    )}
                  </div>
                ))}
                <div className="mt-1 text-[12px] text-[var(--text-secondary)] flex flex-wrap gap-x-3 gap-y-0.5">
                  {r.customer_name && <span>{r.customer_name}</span>}
                  {r.warehouse && <span>{r.warehouse}</span>}
                  {r.target_qty != null && <span>{Number(r.target_qty).toLocaleString("en-IN")} {r.uom ?? "kg"}</span>}
                  <span>{r.line_count ?? 0} line(s)</span>
                  {r.yield_pct != null && <span>{Number(r.yield_pct).toLocaleString("en-IN")}% yield</span>}
                  {r.promoted_bom_id != null && <span>→ BOM #{r.promoted_bom_id}</span>}
                  <span>{(r.created_at ?? "").slice(0, 10)}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Desktop table — same chrome as the requests queue (see _queue-ui): nine EVEN
              columns from `table-fixed` with no widths, a gridline on every cell, and no
              horizontal scroll. Warehouse rides the Job card cell and Yield rides Output,
              which is what bought the room. */}
          <div className="hidden lg:block bg-white border border-[var(--aws-border)] rounded-md">
            <table className="w-full table-fixed border-collapse text-[13px] text-center">
              <thead>
                <tr className="bg-[var(--surface-subtle)] text-[12px] text-[var(--text-secondary)]">
                  {["Job card", "Title", "Target FG", "Customer", "Target qty",
                    "Output", "Promoted BOM", "Status", "Created"].map((h) => (
                    <th key={h} className={`${CELL} py-2 font-semibold`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const arts = articlesOf(r);
                  const flip = shouldFlip(i, rows.length);
                  return (
                    <tr key={r.id} onClick={() => openRow(r.id)}
                      className="hover:bg-[var(--surface-subtle)] cursor-pointer">
                      {/* Job card id — hovering opens the WHOLE card. */}
                      <td className={`${CELL} py-2 font-medium text-[var(--text-primary)] font-mono tabular-nums align-top`}>
                        <Hover flip={flip} panel={<CardPanel r={r} />}>
                          <div className="truncate underline decoration-dotted underline-offset-2">{r.id}</div>
                        </Hover>
                        <Sub>{r.warehouse ?? "—"}</Sub>
                      </td>
                      <td className={`${CELL} py-2 align-top`}>
                        <div className="truncate" title={r.title}>{r.title}</div>
                        <Sub title={r.description ?? ""}>{(r.description ?? "").trim() || `${r.line_count ?? 0} line(s)`}</Sub>
                      </td>
                      {/* Target FG — the row shows article #1; hovering lists them ALL with
                          their own pcs × weight, quantity and unit. */}
                      <td className={`${CELL} py-2 align-top`}>
                        <Hover flip={flip} panel={<ArticlesPanel r={r} />}>
                          <div className="truncate">{r.fg_sku_name ?? "—"}</div>
                        </Hover>
                        <Sub>{arts.length > 1 ? `+${arts.length - 1} more` : (r.base_bom_name ?? "")}</Sub>
                      </td>
                      <td className={`${CELL} py-2 align-top`}>
                        <div className="truncate"
                          title={joinLines(r.customer_name, r.customer_contact, r.customer_ship_to_address)}>
                          {r.customer_name ?? "—"}
                        </div>
                        {r.company_name && <Sub title={r.company_name}>{r.company_name}</Sub>}
                      </td>
                      <td className={`${CELL} py-2 tabular-nums align-top`}>
                        <div className="truncate">
                          {arts.length > 1
                            ? `${Math.round(arts.reduce((n, a) => n + (Number(a.quantity) || 0), 0) * 1000) / 1000} ${r.uom || "kg"}`
                            : qtyWithUom(r.target_qty, r.uom)}
                        </div>
                        <Sub title={arts.length > 1 ? `Total across ${arts.length} articles` : ""}>
                          {arts.length > 1
                            ? `${arts.length} articles`
                            : r.pcs != null && r.weight_per_piece != null ? `${r.pcs} × ${r.weight_per_piece}` : ""}
                        </Sub>
                      </td>
                      {/* What came out, and what that was as a yield — the pair only ever
                          reads together, so it is one column. */}
                      <td className={`${CELL} py-2 tabular-nums align-top`}>
                        <div className="truncate">
                          {r.output_qty != null ? qtyWithUom(r.output_qty, r.output_uom ?? r.uom) : "—"}
                        </div>
                        <Sub>{r.yield_pct != null ? `${num(r.yield_pct)}% yield` : ""}</Sub>
                      </td>
                      <td className={`${CELL} py-2 text-[var(--text-secondary)] align-top`}>
                        <div className="truncate">{r.promoted_bom_id != null ? `BOM #${r.promoted_bom_id}` : "—"}</div>
                        <Sub title={r.fg_sample_batch_id ?? ""}>{r.fg_sample_batch_id ?? ""}</Sub>
                      </td>
                      <td className={`${CELL} py-2 align-top`}><DevJcStatusPill status={r.status} /></td>
                      <td className={`${CELL} py-2 text-[var(--text-secondary)] tabular-nums align-top`}>
                        <div className="truncate">{day(r.created_at) || "—"}</div>
                        <Sub title={joinLines(
                          day(r.started_at) ? `Started ${day(r.started_at)}` : "",
                          day(r.closed_at) ? `Closed ${day(r.closed_at)}` : "")}>
                          {day(r.closed_at) ? `✓ ${day(r.closed_at)}` : day(r.started_at) ? `▶ ${day(r.started_at)}` : ""}
                        </Sub>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Shell>
  );
}

"use client";

// Item hub — one article, tabbed: Vouchers (Tally Stock Item Vouchers),
// Monthly, Batches & Lots, Ageing, FIFO, Traceability. Every tab is DERIVED
// per-item from the leaf record (see _item.ts), so the numbers tie back to the
// Stock Summary. `?tab=` seeds the active tab. Fixtures today.

import { Suspense, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { LedgerChrome } from "../../_chrome";
import { useLedgerLeaves, LedgerGate } from "../../_LedgerData";
import {
  SectionTabs, ExportBar, Pill, QtyCell, ValCell, TableShell, thCls, tdCls,
  fmtQty, StatCard, UomBadge, type ExportSpec, type TabDef,
} from "../../_ui";
import {
  findLeaf, buildVouchers, buildMonthly, buildLots, buildAgeing, buildGodown, buildFifo,
  type ItemVouchers, type GodownRow,
} from "../../_item";
import type { LeafItem, MonthlyRow, Lot, AgeingRow, FifoFlag, Direction, VoucherRow } from "@/lib/ledger";

const TABS: TabDef[] = [
  { key: "vouchers", label: "Vouchers" },
  { key: "monthly", label: "Monthly" },
  { key: "batches", label: "Batches & Lots" },
  { key: "ageing", label: "Ageing" },
  { key: "fifo", label: "FIFO" },
  { key: "trace", label: "Traceability" },
];

function unslug(s: string): string {
  return s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function dirTone(d: Direction) {
  return d === "IN" ? "in" as const : d === "TRANSFER" ? "xfer" as const : "out" as const;
}
const selCls = "border border-[var(--aws-border)] rounded-[8px] px-[9px] py-[5px] text-[11px] bg-white font-mono text-[var(--text-primary)]";

// ── Vouchers (granular: filters + sort + export) ───────────────────
type VSort = "date" | "in" | "out" | "balance";
function Vouchers({ data, uom }: { data: ItemVouchers; uom: string }) {
  const [dir, setDir] = useState<"" | Direction>("");
  const [mvt, setMvt] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<VSort>("date");
  const [asc, setAsc] = useState(true);

  const opening = data.rows[0];
  const body = data.rows.slice(1);
  const mvts = Array.from(new Set(body.map((r) => r.movement_type)));

  const shown = useMemo(() => {
    const f = body.filter((r) => {
      if (dir && r.direction !== dir) return false;
      if (mvt && r.movement_type !== mvt) return false;
      if (q && !`${r.counterpart_label ?? ""} ${r.vch_no ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    const key = (r: VoucherRow) =>
      sort === "date" ? r.posting_date : sort === "in" ? (r.in_qty ?? 0) : sort === "out" ? (r.out_qty ?? 0) : r.running_balance;
    f.sort((a, b) => {
      const ka = key(a), kb = key(b);
      const c = typeof ka === "string" ? ka.localeCompare(kb as string) : (ka as number) - (kb as number);
      return asc ? c : -c;
    });
    return f;
  }, [body, dir, mvt, q, sort, asc]);

  const visIn = shown.reduce((s, r) => s + (r.in_qty ?? 0), 0);
  const visOut = shown.reduce((s, r) => s + (r.out_qty ?? 0), 0);

  const spec: ExportSpec = {
    filename: `${data.rows[0].sku_name}-vouchers`.replace(/\s+/g, "-").toLowerCase(),
    sheet: "Vouchers",
    rows: () => [
      ["Date", "Particulars", "Vch Type", "Vch No", "In Qty", "Out Qty", "Balance", "Counterpart"],
      [opening.posting_date, "Opening Balance", "", "", "", "", opening.running_balance, "carried fwd"],
      ...shown.map((r) => [r.posting_date, r.sku_name, r.vch_type, r.vch_no ?? "", r.in_qty ?? "", r.out_qty ?? "", r.running_balance, r.counterpart_label ?? ""]),
      ["", "", "", "Totals (shown)", Math.round(visIn * 1000) / 1000, Math.round(visOut * 1000) / 1000, data.closing, ""],
    ],
  };
  const setS = (k: VSort) => { if (k === sort) setAsc((a) => !a); else { setSort(k); setAsc(k === "date"); } };
  const arr = (k: VSort) => (sort === k ? (asc ? " ▲" : " ▼") : "");

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex flex-wrap gap-[7px] items-center">
        <select value={dir} onChange={(e) => setDir(e.target.value as "" | Direction)} aria-label="Direction" className={selCls}>
          <option value="">Direction · All</option>
          <option value="IN">Inward</option><option value="OUT">Outward</option><option value="TRANSFER">Transfer</option>
        </select>
        <select value={mvt} onChange={(e) => setMvt(e.target.value)} aria-label="Movement type" className={selCls}>
          <option value="">Movement · All</option>
          {mvts.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search counterpart / doc…" aria-label="Search" className={`${selCls} flex-1 min-w-[150px]`} />
        <ExportBar spec={spec} />
      </div>
      <TableShell minW={760}>
        <thead>
          <tr>
            <th className={`${thCls} cursor-pointer`} onClick={() => setS("date")}>Date{arr("date")}</th>
            <th className={thCls}>Particulars</th><th className={thCls}>Vch Type</th><th className={thCls}>Vch No</th>
            <th className={`${thCls} text-right cursor-pointer`} onClick={() => setS("in")}>In Qty{arr("in")}</th>
            <th className={`${thCls} text-right cursor-pointer`} onClick={() => setS("out")}>Out Qty{arr("out")}</th>
            <th className={`${thCls} text-right cursor-pointer`} onClick={() => setS("balance")}>Balance{arr("balance")}</th>
            <th className={thCls}>Counterpart</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={`${tdCls} font-mono text-[10.5px]`}>{opening.posting_date.slice(5)}</td>
            <td className={tdCls}>Opening Balance</td><td className={tdCls}>—</td><td className={tdCls}></td>
            <td className={`${tdCls} text-right`}></td><td className={`${tdCls} text-right`}></td>
            <td className={`${tdCls} text-right`}><QtyCell n={opening.running_balance} uom={uom} /></td>
            <td className={`${tdCls} font-mono text-[10px] text-[var(--text-muted)]`}>carried fwd</td>
          </tr>
          {shown.map((r) => (
            <tr key={r.ledger_id} className="hover:bg-[var(--surface-subtle)]">
              <td className={`${tdCls} font-mono text-[10.5px]`}>{r.posting_date.slice(5)}</td>
              <td className={tdCls}>{r.sku_name}</td>
              <td className={tdCls}><Pill tone={dirTone(r.direction)}>{r.vch_type}</Pill></td>
              <td className={`${tdCls} font-mono text-[10.5px]`}>{r.vch_no}</td>
              <td className={`${tdCls} text-right`}>{r.in_qty === null ? "" : <span className="font-mono tabular-nums font-semibold text-[#1d8102]">{fmtQty(r.in_qty, uom === "nos" || uom === "no" ? 0 : 3)}</span>}</td>
              <td className={`${tdCls} text-right`}>{r.out_qty === null ? "" : <span className="font-mono tabular-nums font-semibold text-[var(--aws-error)]">{fmtQty(r.out_qty, uom === "nos" || uom === "no" ? 0 : 3)}</span>}</td>
              <td className={`${tdCls} text-right`}><QtyCell n={r.running_balance} uom={uom} /></td>
              <td className={`${tdCls} font-mono text-[10px] text-[var(--text-secondary)]`}>
                {r.counterpart_label}
                {r.is_synthetic && <> <Pill tone="warn">{r.movement_type} bridge</Pill></>}
                {r.fifo_flag && <> <Pill tone={r.fifo_flag === "violation" ? "out" : "warn"}>{r.fifo_flag}</Pill></>}
              </td>
            </tr>
          ))}
          <tr className="bg-[#9a393e0d]">
            <td className={`${tdCls} font-mono text-[10.5px]`} colSpan={4}>Totals · shown ({shown.length})</td>
            <td className={`${tdCls} text-right`}><span className="font-mono tabular-nums font-semibold text-[#1d8102]">{fmtQty(visIn, uom === "nos" || uom === "no" ? 0 : 3)}</span></td>
            <td className={`${tdCls} text-right`}><span className="font-mono tabular-nums font-semibold text-[var(--aws-error)]">{fmtQty(visOut, uom === "nos" || uom === "no" ? 0 : 3)}</span></td>
            <td className={`${tdCls} text-right`}><QtyCell n={data.closing} uom={uom} /></td>
            <td className={tdCls}></td>
          </tr>
        </tbody>
      </TableShell>
      <p className="font-mono text-[10px] text-[var(--text-muted)]"># Running balance is the row&rsquo;s position in the full ledger (filters hide rows, they don&rsquo;t re-base it). Only 261 consumption posts a material_document today; other legs are bridge-derived. Value excluded — quantity of record.</p>
    </div>
  );
}

// ── Monthly ────────────────────────────────────────────────────────
function Monthly({ rows, sku }: { rows: MonthlyRow[]; sku: string }) {
  const spec: ExportSpec = {
    filename: `${sku}-monthly`.replace(/\s+/g, "-").toLowerCase(), sheet: "Monthly",
    rows: () => [
      ["Month", "In Qty", "In ≈", "Out Qty", "Out ≈", "Closing Qty", "Closing ≈"],
      ...rows.map((m) => [m.month, m.in_qty ?? "", m.in_value ?? "", m.out_qty ?? "", m.out_value ?? "", m.closing_qty, m.closing_value ?? ""]),
    ],
  };
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex"><ExportBar spec={spec} /></div>
      <TableShell minW={620}>
        <thead>
          <tr>
            <th className={thCls}>Month</th>
            <th className={`${thCls} text-right`}>In Qty</th><th className={`${thCls} text-right`}>In ≈</th>
            <th className={`${thCls} text-right`}>Out Qty</th><th className={`${thCls} text-right`}>Out ≈</th>
            <th className={`${thCls} text-right`}>Closing Qty</th><th className={`${thCls} text-right`}>Closing ≈</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.month} className={m.month === "Opening Balance" ? "bg-[var(--surface-subtle)] italic" : "hover:bg-[var(--surface-subtle)]"}>
              <td className={tdCls}>{m.month}</td>
              <td className={`${tdCls} text-right`}>{m.in_qty === null ? "" : <span className="font-mono tabular-nums font-semibold text-[#1d8102]">{fmtQty(m.in_qty)}</span>}</td>
              <td className={`${tdCls} text-right`}><ValCell n={m.in_value} /></td>
              <td className={`${tdCls} text-right`}>{m.out_qty === null ? "" : <span className="font-mono tabular-nums font-semibold text-[var(--aws-error)]">{fmtQty(m.out_qty)}</span>}</td>
              <td className={`${tdCls} text-right`}><ValCell n={m.out_value} /></td>
              <td className={`${tdCls} text-right`}><QtyCell n={m.closing_qty} /></td>
              <td className={`${tdCls} text-right`}><ValCell n={m.closing_value} /></td>
            </tr>
          ))}
        </tbody>
      </TableShell>
      <p className="font-mono text-[10px] text-[var(--text-muted)]"># Monthly buckets are aggregated from the vouchers — the two tabs always tie. Negative closing shown as-is.</p>
    </div>
  );
}

// ── Batches & Lots ─────────────────────────────────────────────────
function Batches({ lots, godown }: { lots: Lot[]; godown: GodownRow[] }) {
  return (
    <div className="flex flex-col gap-[13px]">
      {lots.length === 0 ? (
        <div className="rounded-[11px] border border-[#c07d0966] bg-[#fbf0d8] text-[#c07d09] p-[13px] font-mono text-[12px]">
          Over-issued — no positive lots on hand. Net balance is negative; see Reconciliation to resolve the shrink / mis-sequence.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-[9px]">
          {lots.map((l) => {
            const border = l.status === "BLOCKED" ? "#dd4a4f" : l.near_expiry ? "#c07d09" : "#1d8102";
            return (
              <div key={l.batch_id} className="rounded-[11px] border border-[var(--aws-border)] bg-white p-[11px] flex flex-col gap-[7px]" style={{ borderLeft: `3px solid ${border}` }}>
                <div className="flex justify-between items-center gap-[8px]">
                  <span className="font-mono text-[11px] font-bold text-[var(--text-primary)]">{l.batch_id}</span>
                  <Pill tone={l.status === "AVAILABLE" ? "in" : l.status === "BLOCKED" ? "out" : "warn"}>{l.near_expiry ? "NEAR-EXPIRY" : l.status}</Pill>
                </div>
                <div className="font-mono tabular-nums text-[14px] font-bold text-[var(--text-primary)]">{fmtQty(l.current_qty, l.uom_class === "nos" || l.uom_class === "no" ? 0 : 3)} <span className="text-[10px] text-[var(--text-muted)] font-medium">{l.uom_class}</span></div>
                <div className="font-mono text-[10px] text-[var(--text-muted)] flex justify-between"><span>lot {l.lot_number}</span><span>{l.warehouse_code}</span></div>
                <div className="font-mono text-[10px] text-[var(--text-muted)] flex justify-between"><span>in {l.inward_date.slice(5)}</span><span>age {l.age_days}d</span></div>
              </div>
            );
          })}
        </div>
      )}
      <div className="rounded-[11px] border border-[var(--aws-border)] bg-white p-[12px]">
        <h5 className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-[10px]">Godown split</h5>
        <TableShell minW={0}>
          <tbody>
            {godown.map((g) => (
              <tr key={g.godown}>
                <td className={tdCls}>{g.godown}</td>
                <td className={`${tdCls} text-right`}><QtyCell n={g.qty} uom={g.uom_class} /></td>
                <td className={tdCls}>{g.note ? <Pill tone="warn">{g.note}</Pill> : <Pill tone="kg">{g.uom_class.toUpperCase()}</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      </div>
      <p className="font-mono text-[10px] text-[var(--text-muted)]"># Lots-available UNIONs inventory_batch + po_box + cold_stocks + floor_inventory. Ageing computed live from inward_date.</p>
    </div>
  );
}

// ── Ageing ─────────────────────────────────────────────────────────
function Ageing({ a }: { a: AgeingRow }) {
  const max = Math.max(a.b_0_30, a.b_31_60, a.b_61_90, a.b_90_plus, 1);
  const rows = [
    { label: "0–30 d", qty: a.b_0_30, color: "#1d8102" },
    { label: "31–60 d", qty: a.b_31_60, color: "#12b0bd" },
    { label: "61–90 d", qty: a.b_61_90, color: "#c07d09" },
    { label: "90+ d", qty: a.b_90_plus, color: "#dd4a4f" },
  ];
  return (
    <div className="max-w-[560px] rounded-[11px] border border-[var(--aws-border)] bg-white p-[13px] flex flex-col gap-[8px]">
      <h5 className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Ageing — by inward date ({a.uom_class})</h5>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-[10px]">
          <span className="font-mono text-[10.5px] text-[var(--text-primary)] w-[64px] shrink-0">{r.label}</span>
          <span className="flex-1 h-[16px] bg-[var(--surface-subtle)] rounded-[5px] overflow-hidden">
            <span className="block h-full rounded-[5px]" style={{ width: `${(r.qty / max) * 100}%`, background: r.color }} />
          </span>
          <span className="font-mono tabular-nums text-[11px] w-[96px] text-right shrink-0">{fmtQty(r.qty, a.uom_class === "nos" || a.uom_class === "no" ? 0 : 3)}</span>
        </div>
      ))}
      {a.near_expiry_qty ? <p className="font-mono text-[10px] text-[#c07d09]">⚑ {fmtQty(a.near_expiry_qty)} near shelf-life threshold.</p> : null}
    </div>
  );
}

// ── FIFO ───────────────────────────────────────────────────────────
function Fifo({ flags }: { flags: FifoFlag[] }) {
  const count = (t: string) => flags.filter((f) => f.flag_type === t).length;
  if (flags.length === 0) {
    return <div className="rounded-[11px] border border-[#1d810244] bg-[#e5f5ee] text-[#1d8102] p-[13px] font-mono text-[12px]">✓ No FIFO exceptions for this item in the period.</div>;
  }
  return (
    <div className="flex flex-col gap-[13px]">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-[9px]">
        <StatCard label="Violations" value={String(count("violation"))} delta="newer before older" />
        <StatCard label="Overrides" value={String(count("override"))} flag delta="force_reassign" />
        <StatCard label="Blocked skips" value={String(count("blocked"))} delta="for SO" />
        <StatCard label="Near / expired" value={String(count("near_expiry"))} flag delta="≤ threshold" />
      </div>
      <TableShell>
        <thead>
          <tr><th className={thCls}>Voucher</th><th className={thCls}>Lot consumed</th><th className={thCls}>Oldest available</th><th className={thCls}>Flag</th><th className={thCls}>Reason</th></tr>
        </thead>
        <tbody>
          {flags.map((f) => (
            <tr key={f.flag_id} className="hover:bg-[var(--surface-subtle)]">
              <td className={`${tdCls} font-mono text-[10.5px]`}>{f.vch_no}</td>
              <td className={`${tdCls} font-mono text-[10.5px]`}>{f.consumed_lot}</td>
              <td className={`${tdCls} font-mono text-[10.5px]`}>{f.oldest_available_lot ?? "—"}</td>
              <td className={tdCls}><Pill tone={f.flag_type === "violation" ? "out" : f.flag_type === "blocked" ? "mut" : "warn"}>{f.flag_type}</Pill></td>
              <td className={`${tdCls} font-mono text-[10px] text-[var(--text-secondary)]`}>{f.reason}</td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  );
}

// ── Traceability ───────────────────────────────────────────────────
function Trace({ leaf, lots }: { leaf: LeafItem; lots: Lot[] }) {
  const lot = lots[0];
  return (
    <div className="rounded-[11px] border border-[var(--aws-border)] bg-white p-[14px] flex flex-col gap-[10px] max-w-[640px]">
      <h5 className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Genealogy &amp; box → PO chain</h5>
      <div className="font-mono text-[11px] text-[var(--text-primary)] leading-[1.9]">
        {leaf.item_type === "fg" ? (
          <>
            <div>Inputs (RM/PM) → JC → <b>{leaf.label}</b> (FG)</div>
            <div className="text-[var(--text-muted)]">└→ packed as sfg_box cartons · 531 <Pill tone="warn">not posted — cartons only</Pill></div>
          </>
        ) : (
          <>
            <div>PO-{1000 + (leaf.sku_id % 8999)} → box → lot <b>{lot?.lot_number ?? "—"}</b> → batch {lot?.batch_id ?? "—"}</div>
            <div className="text-[var(--text-muted)]">└→ consumed in job cards (261) → downstream FG</div>
          </>
        )}
        {leaf.transfer_out_qty > 0 && <div className="text-[var(--text-muted)]">└→ transferred out (301) <Pill tone="warn">box-relabel xref</Pill></div>}
      </div>
      <p className="font-mono text-[10px] text-[var(--text-muted)]"># RM/PM lineage reaches transaction_no (PO); FG genealogy via sfg_genealogy. sfg_box.lot_number/parent_box_id NULL in base schema — chain break badged.</p>
    </div>
  );
}

function ItemHubInner() {
  const router = useRouter();
  useRequireAuth(router.replace); // redirect side-effect only (see page.tsx note)
  const isAdmin = useIsAdmin();
  const { leaves } = useLedgerLeaves();
  const params = useParams<{ sku: string }>();
  const search = useSearchParams();
  const initialTab = search.get("tab") ?? "vouchers";
  const [tab, setTab] = useState(initialTab);
  const leaf = useMemo(() => findLeaf(params.sku, leaves), [params.sku, leaves]);

  if (!isAdmin) {
    return (
      <LedgerChrome title={unslug(params.sku)}>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Inventory Ledger module. Ask an administrator to grant access.
        </section>
      </LedgerChrome>
    );
  }

  if (!leaf) {
    // LedgerGate shows the live loading/error state first; the "not found"
    // section only appears once the leaf set has loaded and the slug is absent.
    return (
      <LedgerChrome title={unslug(params.sku)}>
        <LedgerGate>
          <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)] flex flex-col gap-2">
            <b className="text-[var(--text-primary)]">“{unslug(params.sku)}” wasn&rsquo;t found in the current data set.</b>
            <span>Item-level data is derived from the loaded article set. In live mode every SKU resolves by id once the <span className="font-mono">/api/v1/ledger</span> backend returns it.</span>
            <button onClick={() => router.push("/modules/inventory-ledger")} className="self-start font-mono text-[11px] text-[var(--aws-link)] hover:underline">‹ Back to Stock Summary</button>
          </section>
        </LedgerGate>
      </LedgerChrome>
    );
  }

  const vouchers = buildVouchers(leaf);
  const monthly = buildMonthly(leaf);
  const lots = buildLots(leaf);
  const ageing = buildAgeing(lots, leaf.uom_class, leaf.label);
  const godown = buildGodown(leaf);
  const fifo = buildFifo(leaf, lots);
  const typeLabel = leaf.item_type.toUpperCase();

  return (
    <LedgerChrome title={leaf.label}>
      <div className="rounded-[11px] border border-[var(--aws-border)] bg-white p-[13px] flex justify-between gap-[16px] flex-wrap items-center mb-4">
        <div className="flex flex-col gap-[6px]">
          <span className="text-[15px] font-extrabold text-[var(--text-primary)]">{leaf.label}</span>
          <div className="flex gap-[5px] flex-wrap">
            <Pill tone={leaf.item_type === "fg" ? "in" : leaf.item_type === "pm" ? "nos" : "xfer"}>{typeLabel}</Pill>
            <UomBadge uom={leaf.uom_class} />
            <Pill tone="mut">{leaf.godown}</Pill>
            <Pill tone="mut">{leaf.group} · {leaf.subgroup}</Pill>
            <Pill tone="mut">FEFO→FIFO</Pill>
          </div>
        </div>
        <div className="flex gap-[20px]">
          <div><div className="font-mono text-[9.5px] uppercase tracking-wide text-[var(--text-muted)]">Opening · 1-Apr</div><div className="font-mono tabular-nums text-[18px] font-extrabold">{fmtQty(vouchers.opening, leaf.uom_class === "nos" || leaf.uom_class === "no" ? 0 : 3)}</div></div>
          <div><div className="font-mono text-[9.5px] uppercase tracking-wide text-[var(--text-muted)]">Closing</div><div className={`font-mono tabular-nums text-[18px] font-extrabold ${vouchers.closing < 0 ? "text-[var(--aws-error)]" : "text-[#1d8102]"}`}>{fmtQty(vouchers.closing, leaf.uom_class === "nos" || leaf.uom_class === "no" ? 0 : 3)}</div></div>
        </div>
      </div>

      <SectionTabs tabs={TABS} active={tab} onSelect={setTab} />
      <div className="mt-4">
        {tab === "vouchers" && <Vouchers data={vouchers} uom={leaf.uom_class} />}
        {tab === "monthly" && <Monthly rows={monthly} sku={leaf.label} />}
        {tab === "batches" && <Batches lots={lots} godown={godown} />}
        {tab === "ageing" && <Ageing a={ageing} />}
        {tab === "fifo" && <Fifo flags={fifo} />}
        {tab === "trace" && <Trace leaf={leaf} lots={lots} />}
      </div>
    </LedgerChrome>
  );
}

export default function ItemHubPage() {
  // useSearchParams needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <ItemHubInner />
    </Suspense>
  );
}

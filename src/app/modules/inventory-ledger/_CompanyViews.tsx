"use client";

// Company-level landing tabs — Batches & Lots, Ageing, FIFO, Reconcile,
// Registers. All derived across the whole item set (_company.ts), filterable,
// sortable and exportable. Quantity-first; per-UOM where quantities roll up.

import { useMemo, useState } from "react";
import {
  StatCard, ExportBar, Pill, QtyCell, TableShell, thCls, tdCls, fmtQty, fmtInt,
  uomDp, type ExportSpec,
} from "./_ui";
import { companyLots, companyFifo, companyAgeing, companyRecon } from "./_company";
import { useLedgerLeaves } from "./_LedgerData";
import type { FifoFlagType } from "@/lib/ledger";

const selCls = "border border-[var(--aws-border)] rounded-[8px] px-[9px] py-[5px] text-[11px] bg-white font-mono text-[var(--text-primary)]";

// ── Batches & Lots (company) ───────────────────────────────────────
export function CompanyBatches() {
  const { leaves } = useLedgerLeaves();
  const lots = useMemo(() => companyLots(leaves), [leaves]);
  const godowns = useMemo(() => Array.from(new Set(leaves.map((l) => l.godown))).sort(), [leaves]);
  const [q, setQ] = useState("");
  const [godown, setGodown] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<"age" | "qty">("age");
  const [asc, setAsc] = useState(false);

  const statuses = Array.from(new Set(lots.map((l) => l.status)));
  const shown = useMemo(() => {
    const f = lots.filter((l) =>
      (!godown || l.warehouse_code === godown) &&
      (!status || l.status === status) &&
      (!q || `${l.sku_name} ${l.lot_number ?? ""} ${l.batch_id}`.toLowerCase().includes(q.toLowerCase())),
    );
    f.sort((a, b) => {
      const c = sort === "age" ? a.age_days - b.age_days : a.current_qty - b.current_qty;
      return asc ? c : -c;
    });
    return f;
  }, [lots, godown, status, q, sort, asc]);

  const near = shown.filter((l) => l.near_expiry).length;
  const blocked = shown.filter((l) => l.status === "BLOCKED").length;
  const spec: ExportSpec = {
    filename: "lots-available", sheet: "Lots",
    rows: () => [
      ["Batch", "Item", "Lot", "Qty", "UOM", "Godown", "Status", "Age(d)", "Inward"],
      ...shown.map((l) => [l.batch_id, l.sku_name, l.lot_number ?? "", l.current_qty, l.uom_class, l.warehouse_code ?? "", l.status, l.age_days, l.inward_date]),
    ],
  };
  const setS = (k: "age" | "qty") => { if (k === sort) setAsc((a) => !a); else { setSort(k); setAsc(false); } };
  const arr = (k: "age" | "qty") => (sort === k ? (asc ? " ▲" : " ▼") : "");

  return (
    <div className="flex flex-col gap-[13px]">
      <div className="grid grid-cols-3 gap-[9px]">
        <StatCard label="Lots on hand" value={fmtInt(shown.length)} delta="across all items" />
        <StatCard label="Near-expiry" value={fmtInt(near)} flag={near > 0} delta="≤ threshold" />
        <StatCard label="Blocked for SO" value={fmtInt(blocked)} delta="excluded from pick" />
      </div>
      <div className="flex flex-wrap gap-[7px] items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item / lot / batch…" aria-label="Search" className={`${selCls} flex-1 min-w-[160px]`} />
        <select value={godown} onChange={(e) => setGodown(e.target.value)} aria-label="Godown" className={selCls}>
          <option value="">Godown · All</option>{godowns.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className={selCls}>
          <option value="">Status · All</option>{statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <ExportBar spec={spec} />
      </div>
      <p className="font-mono text-[10.5px] text-[var(--text-muted)]"># Lots-available UNIONs inventory_batch + po_box + cold_stocks + floor_inventory. Ageing computed live from inward_date.</p>
      <TableShell minW={760}>
        <thead>
          <tr>
            <th className={thCls}>Batch</th><th className={thCls}>Item</th><th className={thCls}>Lot</th>
            <th className={`${thCls} text-right cursor-pointer`} onClick={() => setS("qty")}>Qty{arr("qty")}</th>
            <th className={thCls}>Godown</th><th className={thCls}>Status</th>
            <th className={`${thCls} text-right cursor-pointer`} onClick={() => setS("age")}>Age{arr("age")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => (
            <tr key={l.batch_id} className="hover:bg-[var(--surface-subtle)]">
              <td className={`${tdCls} font-mono text-[10.5px]`}>{l.batch_id}</td>
              <td className={tdCls}>{l.sku_name}</td>
              <td className={`${tdCls} font-mono text-[10.5px]`}>{l.lot_number}</td>
              <td className={`${tdCls} text-right`}><QtyCell n={l.current_qty} uom={l.uom_class} /> <span className="text-[10px] text-[var(--text-muted)]">{l.uom_class}</span></td>
              <td className={tdCls}>{l.warehouse_code}{l.floor_id ? ` · ${l.floor_id}` : ""}</td>
              <td className={tdCls}><Pill tone={l.status === "AVAILABLE" ? "in" : l.status === "BLOCKED" ? "out" : "warn"}>{l.status}</Pill>{l.near_expiry && <> <Pill tone="warn">near-exp</Pill></>}</td>
              <td className={`${tdCls} text-right font-mono ${l.age_days > 90 ? "text-[var(--aws-error)]" : ""}`}>{l.age_days}d</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td className={`${tdCls} text-[var(--text-muted)]`} colSpan={7}>No lots match the filters.</td></tr>}
        </tbody>
      </TableShell>
    </div>
  );
}

// ── Ageing (company) ───────────────────────────────────────────────
function AgeBar({ a }: { a: { b_0_30: number; b_31_60: number; b_61_90: number; b_90_plus: number; total_qty: number } }) {
  const segs = [
    { v: a.b_0_30, c: "#1d8102" }, { v: a.b_31_60, c: "#12b0bd" },
    { v: a.b_61_90, c: "#c07d09" }, { v: a.b_90_plus, c: "#dd4a4f" },
  ];
  const t = a.total_qty || 1;
  return (
    <span className="flex h-[14px] w-[130px] rounded-[4px] overflow-hidden bg-[var(--surface-subtle)]">
      {segs.map((s, i) => <span key={i} style={{ width: `${(s.v / t) * 100}%`, background: s.c }} />)}
    </span>
  );
}
export function CompanyAgeing() {
  const { leaves } = useLedgerLeaves();
  const rows = useMemo(() => companyAgeing(leaves), [leaves]);
  const [uom, setUom] = useState("");
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => (!uom || r.uom_class === uom) && (!q || r.group_key.toLowerCase().includes(q.toLowerCase())));

  const spec: ExportSpec = {
    filename: "ageing", sheet: "Ageing",
    rows: () => [
      ["Sub-group", "UOM", "0-30", "31-60", "61-90", "90+", "Total", "Near-expiry"],
      ...shown.map((r) => [r.group_key, r.uom_class, r.b_0_30, r.b_31_60, r.b_61_90, r.b_90_plus, r.total_qty, r.near_expiry_qty ?? 0]),
    ],
  };
  return (
    <div className="flex flex-col gap-[13px]">
      <div className="flex flex-wrap gap-[7px] items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sub-group…" aria-label="Search" className={`${selCls} flex-1 min-w-[160px]`} />
        <select value={uom} onChange={(e) => setUom(e.target.value)} aria-label="UOM" className={selCls}>
          <option value="">UOM · All</option><option value="kg">Kgs</option><option value="nos">NOS</option><option value="no">No</option>
        </select>
        <ExportBar spec={spec} />
      </div>
      <p className="font-mono text-[10.5px] text-[var(--text-muted)]"># Ageing by inward_date, per sub-group × UOM. Cold stock ages by inward only (no expiry). Green→red = fresh→old.</p>
      <TableShell minW={760}>
        <thead>
          <tr>
            <th className={thCls}>Sub-group</th><th className={thCls}>UOM</th><th className={thCls}>Distribution</th>
            <th className={`${thCls} text-right`}>0–30</th><th className={`${thCls} text-right`}>31–60</th>
            <th className={`${thCls} text-right`}>61–90</th><th className={`${thCls} text-right`}>90+</th>
            <th className={`${thCls} text-right`}>Total</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={`${r.group_key}-${r.uom_class}`} className="hover:bg-[var(--surface-subtle)]">
              <td className={`${tdCls} font-semibold`}>{r.group_key}{r.near_expiry_qty ? <> <Pill tone="warn">near-exp {fmtQty(r.near_expiry_qty, uomDp(r.uom_class))}</Pill></> : null}</td>
              <td className={tdCls}><Pill tone={r.uom_class === "nos" ? "nos" : "kg"}>{r.uom_class.toUpperCase()}</Pill></td>
              <td className={tdCls}><AgeBar a={r} /></td>
              <td className={`${tdCls} text-right font-mono tabular-nums text-[#1d8102]`}>{r.b_0_30 ? fmtQty(r.b_0_30, uomDp(r.uom_class)) : "·"}</td>
              <td className={`${tdCls} text-right font-mono tabular-nums text-[#0a8894]`}>{r.b_31_60 ? fmtQty(r.b_31_60, uomDp(r.uom_class)) : "·"}</td>
              <td className={`${tdCls} text-right font-mono tabular-nums text-[#c07d09]`}>{r.b_61_90 ? fmtQty(r.b_61_90, uomDp(r.uom_class)) : "·"}</td>
              <td className={`${tdCls} text-right font-mono tabular-nums text-[var(--aws-error)]`}>{r.b_90_plus ? fmtQty(r.b_90_plus, uomDp(r.uom_class)) : "·"}</td>
              <td className={`${tdCls} text-right`}><QtyCell n={r.total_qty} uom={r.uom_class} /></td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td className={`${tdCls} text-[var(--text-muted)]`} colSpan={8}>No ageing rows match.</td></tr>}
        </tbody>
      </TableShell>
    </div>
  );
}

// ── FIFO compliance (company) ──────────────────────────────────────
export function CompanyFifo() {
  const { leaves } = useLedgerLeaves();
  const flags = useMemo(() => companyFifo(leaves), [leaves]);
  const [type, setType] = useState<"" | FifoFlagType>("");
  const [q, setQ] = useState("");
  const shown = flags.filter((f) => (!type || f.flag_type === type) && (!q || `${f.sku_name} ${f.vch_no}`.toLowerCase().includes(q.toLowerCase())));
  const count = (t: string) => flags.filter((f) => f.flag_type === t).length;

  const spec: ExportSpec = {
    filename: "fifo-compliance", sheet: "FIFO",
    rows: () => [
      ["Voucher", "Item", "Lot consumed", "Oldest available", "Flag", "Reason"],
      ...shown.map((f) => [f.vch_no, f.sku_name, f.consumed_lot ?? "", f.oldest_available_lot ?? "", f.flag_type, f.reason ?? ""]),
    ],
  };
  return (
    <div className="flex flex-col gap-[13px]">
      <div className="rounded-[11px] px-[14px] py-[11px] font-mono text-[12px] bg-[#fbf0d8] text-[#c07d09] border border-[#c07d0966] flex gap-[10px]">
        <span>⚑</span>
        <span><b>Advisory FIFO:</b> issuance is not blocked on violation. Declared strategy FEFO→FIFO is hardcoded — <span className="font-semibold">all_sku.batch_strategy</span> is not read.</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-[9px]">
        <StatCard label="Violations" value={String(count("violation"))} delta="newer before older" />
        <StatCard label="Overrides" value={String(count("override"))} flag={count("override") > 0} delta="force_reassign" />
        <StatCard label="Blocked skips" value={String(count("blocked"))} delta="for SO" />
        <StatCard label="Near / expired" value={String(count("near_expiry"))} flag={count("near_expiry") > 0} delta="≤ threshold" />
      </div>
      <div className="flex flex-wrap gap-[7px] items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item / voucher…" aria-label="Search" className={`${selCls} flex-1 min-w-[160px]`} />
        <select value={type} onChange={(e) => setType(e.target.value as "" | FifoFlagType)} aria-label="Flag type" className={selCls}>
          <option value="">Flag · All</option><option value="violation">Violation</option><option value="override">Override</option>
          <option value="blocked">Blocked</option><option value="near_expiry">Near-expiry</option>
        </select>
        <ExportBar spec={spec} />
      </div>
      <TableShell minW={720}>
        <thead>
          <tr><th className={thCls}>Voucher</th><th className={thCls}>Item</th><th className={thCls}>Lot consumed</th><th className={thCls}>Oldest available</th><th className={thCls}>Flag</th><th className={thCls}>Reason</th></tr>
        </thead>
        <tbody>
          {shown.map((f) => (
            <tr key={f.flag_id} className="hover:bg-[var(--surface-subtle)]">
              <td className={`${tdCls} font-mono text-[10.5px]`}>{f.vch_no}</td>
              <td className={tdCls}>{f.sku_name}</td>
              <td className={`${tdCls} font-mono text-[10.5px]`}>{f.consumed_lot}</td>
              <td className={`${tdCls} font-mono text-[10.5px]`}>{f.oldest_available_lot ?? "—"}</td>
              <td className={tdCls}><Pill tone={f.flag_type === "violation" ? "out" : f.flag_type === "blocked" ? "mut" : "warn"}>{f.flag_type}</Pill></td>
              <td className={`${tdCls} font-mono text-[10px] text-[var(--text-secondary)]`}>{f.reason}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td className={`${tdCls} text-[var(--text-muted)]`} colSpan={6}>No FIFO exceptions match.</td></tr>}
        </tbody>
      </TableShell>
    </div>
  );
}

// ── Reconcile (company) ────────────────────────────────────────────
export function CompanyReconcile() {
  const { leaves } = useLedgerLeaves();
  const { rows, stats } = useMemo(() => companyRecon(leaves), [leaves]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => (!status || r.status === status) && (!q || `${r.sku_name} ${r.warehouse_code}`.toLowerCase().includes(q.toLowerCase())));

  const spec: ExportSpec = {
    filename: "reconciliation", sheet: "Reconcile",
    rows: () => [
      ["Item", "Godown", "inventory_batch", "floor_inventory", "Delta", "Status"],
      ...shown.map((r) => [r.sku_name, r.warehouse_code, r.batch_qty, r.floor_qty ?? "", r.delta_qty ?? "", r.status]),
    ],
  };
  return (
    <div className="flex flex-col gap-[13px]">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-[9px]">
        <StatCard label="Computed vs physical" value={stats.computedVsPhysical} delta={`${stats.matched} matched`} />
        <StatCard label="Qty variances" value={fmtInt(stats.variances)} flag={stats.variances > 0} delta="batch ≠ floor" />
        <StatCard label="Store gaps" value={fmtInt(stats.storeGaps)} delta="cold: no floor row" />
        <StatCard label="Unposted shrink" value={fmtQty(stats.shrink, 0)} unit="kg" flag={stats.shrink > 0} delta="→ post 551" />
      </div>
      <div className="flex flex-wrap gap-[7px] items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search item / godown…" aria-label="Search" className={`${selCls} flex-1 min-w-[160px]`} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className={selCls}>
          <option value="">Status · All</option><option value="variance">Variance</option><option value="store_gap">Store gap</option><option value="matched">Matched</option>
        </select>
        <ExportBar spec={spec} />
      </div>
      <TableShell minW={720}>
        <thead>
          <tr>
            <th className={thCls}>Item</th><th className={thCls}>Godown</th>
            <th className={`${thCls} text-right`}>inventory_batch</th><th className={`${thCls} text-right`}>floor_inventory</th>
            <th className={`${thCls} text-right`}>Δ Qty</th><th className={thCls}>Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={`${r.sku_name}-${r.warehouse_code}`} className="hover:bg-[var(--surface-subtle)]">
              <td className={`${tdCls} text-[var(--aws-link)] font-semibold`}>{r.sku_name}</td>
              <td className={tdCls}>{r.warehouse_code}</td>
              <td className={`${tdCls} text-right`}><QtyCell n={r.batch_qty} /></td>
              <td className={`${tdCls} text-right`}>{r.floor_qty === null ? <span className="text-[var(--text-muted)]">n/a</span> : <QtyCell n={r.floor_qty} />}</td>
              <td className={`${tdCls} text-right`}>{r.delta_qty === null ? <span className="text-[#c07d09] font-mono text-[11px]">store gap</span> : <QtyCell n={r.delta_qty} />}</td>
              <td className={tdCls}><Pill tone={r.status === "matched" ? "in" : r.status === "variance" ? "out" : "warn"}>{r.status === "matched" ? "✓ matched" : r.status === "variance" ? "variance" : "store gap"}</Pill></td>
            </tr>
          ))}
          <tr>
            <td colSpan={6} className="bg-[#fbf0d8] text-[#c07d09] font-mono text-[10.5px] px-[11px] py-2">
              <b>⚑ In-transit orphans:</b> 5,422 boxes in pending_transfer_stock owned by neither store · 2 close-with-shortage shrink events not posted as 551.
            </td>
          </tr>
        </tbody>
      </TableShell>
      <p className="font-mono text-[10px] text-[var(--text-muted)]"># All reconciliation is on quantity. Cold godowns have no floor_inventory row (store gap). Value is never a control total.</p>
    </div>
  );
}

// ── Registers ──────────────────────────────────────────────────────
const REGISTERS: { name: string; backing: string; status: "BACKED" | "PARTIAL" }[] = [
  { name: "Receipt Note Register (GRN)", backing: "material_document mvt 101 · qc/arrivals", status: "PARTIAL" },
  { name: "Delivery / Dispatch Register", backing: "job-cards/dispatch-log · mvt 531", status: "PARTIAL" },
  { name: "Rejections In / Out", backing: "ncr/* · inventory/batch/{id}/rejections", status: "BACKED" },
  { name: "Stock Transfer & Mfg Journal", backing: "transfer/transfers · floor-inventory/movements", status: "BACKED" },
  { name: "Purchase / Sales Orders Book", backing: "purchase/export · so/export", status: "BACKED" },
  { name: "Physical Stock Register", backing: "balance-scan/* · day-end/summary", status: "BACKED" },
];
export function RegistersView() {
  return (
    <TableShell>
      <thead>
        <tr><th className={thCls}>Register</th><th className={thCls}>Backing ERP endpoint(s)</th><th className={thCls}>Status</th></tr>
      </thead>
      <tbody>
        {REGISTERS.map((r) => (
          <tr key={r.name} className="hover:bg-[var(--surface-subtle)]">
            <td className={`${tdCls} font-semibold`}>{r.name}</td>
            <td className={`${tdCls} font-mono text-[10.5px] text-[var(--text-secondary)]`}>{r.backing}</td>
            <td className={tdCls}><Pill tone={r.status === "BACKED" ? "in" : "warn"}>{r.status}</Pill></td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

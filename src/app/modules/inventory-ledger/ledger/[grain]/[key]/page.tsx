"use client";

// Group / sub-group voucher ledger (the "or vice versa" view): the same Tally
// voucher ledger aggregated across a whole sub-group or group — one row per
// voucher, item shown, running balance per UOM class. Fixtures today.

import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { LedgerChrome } from "../../../_chrome";
import { slugifySku } from "../../../_ItemSearch";
import {
  ExportBar, Pill, QtyCell, TableShell, thCls, tdCls, fmtQty, type ExportSpec,
} from "../../../_ui";
import { SUBGROUP_LEDGER, SUBGROUP_LEDGER_TOTALS } from "../../../_fixtures";

const GRAINS = ["item", "subgroup", "group"] as const;

function unslug(s: string): string {
  return s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function GrainLedgerPage() {
  const router = useRouter();
  useRequireAuth(router.replace); // redirect side-effect only (see page.tsx note)
  const isAdmin = useIsAdmin();
  const params = useParams<{ grain: string; key: string }>();
  const grain = (GRAINS as readonly string[]).includes(params.grain) ? params.grain : "subgroup";
  const label = unslug(params.key);

  const spec: ExportSpec = {
    filename: `ledger-${grain}-${params.key}`,
    sheet: label.slice(0, 28),
    rows: () => [
      ["Date", "Item", "Vch Type", "Vch No", "In Qty", "Out Qty", "Bal Kgs"],
      ...SUBGROUP_LEDGER.map((v) => [v.posting_date, v.sku_name, v.vch_type, v.vch_no ?? "", v.in_qty ?? "", v.out_qty ?? "", v.running_balance]),
      ["", "", "", "Totals (Kgs)", SUBGROUP_LEDGER_TOTALS.in_qty, SUBGROUP_LEDGER_TOTALS.out_qty, SUBGROUP_LEDGER_TOTALS.closing],
    ],
  };

  if (!isAdmin) {
    return (
      <LedgerChrome title={`${label} — ledger`}>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Inventory Ledger module. Ask an administrator to grant access.
        </section>
      </LedgerChrome>
    );
  }

  return (
    <LedgerChrome title={`${label} — ledger`}>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-[18px] font-bold text-[var(--text-primary)]">{label} — all movements</h1>
          <p className="font-mono text-[11px] text-[var(--text-muted)]">{grain} grain · per-UOM running balance</p>
        </div>
        <div className="flex-1" />
        <div className="inline-flex bg-white border border-[var(--aws-border)] rounded-[8px] p-[2px] gap-[2px]">
          {GRAINS.map((g) => (
            <button
              key={g}
              onClick={() => router.replace(`/modules/inventory-ledger/ledger/${g}/${params.key}`)}
              className={`font-mono text-[11px] px-[11px] py-[4px] rounded-[6px] capitalize ${
                grain === g ? "bg-[var(--aws-navy)] text-white font-semibold" : "text-[var(--text-secondary)]"
              }`}
            >{g}</button>
          ))}
        </div>
        <ExportBar spec={spec} />
      </div>

      <TableShell minW={680}>
        <thead>
          <tr>
            <th className={thCls}>Date</th><th className={thCls}>Item</th><th className={thCls}>Vch Type</th>
            <th className={thCls}>Vch No</th><th className={`${thCls} text-right`}>In Qty</th>
            <th className={`${thCls} text-right`}>Out Qty</th><th className={`${thCls} text-right`}>Bal · Kgs</th>
          </tr>
        </thead>
        <tbody>
          {SUBGROUP_LEDGER.map((v) => (
            <tr key={v.ledger_id} className="hover:bg-[var(--surface-subtle)]">
              <td className={`${tdCls} font-mono text-[10.5px]`}>{v.posting_date.slice(5)}</td>
              <td className={tdCls}>
                <button className="text-[var(--aws-link)] font-semibold hover:underline" onClick={() => router.push(`/modules/inventory-ledger/item/${slugifySku(v.sku_name)}?tab=vouchers`)}>
                  {v.sku_name}
                </button>
              </td>
              <td className={tdCls}><Pill tone={v.direction === "IN" ? "in" : v.direction === "TRANSFER" ? "xfer" : "out"}>{v.vch_type}</Pill></td>
              <td className={`${tdCls} font-mono text-[10.5px]`}>{v.vch_no}</td>
              <td className={`${tdCls} text-right`}>{v.in_qty === null ? "" : <span className="font-mono tabular-nums font-semibold text-[#1d8102]">{fmtQty(v.in_qty)}</span>}</td>
              <td className={`${tdCls} text-right`}>{v.out_qty === null ? "" : <span className="font-mono tabular-nums font-semibold text-[var(--aws-error)]">{fmtQty(v.out_qty)}</span>}</td>
              <td className={`${tdCls} text-right`}><QtyCell n={v.running_balance} /></td>
            </tr>
          ))}
          <tr className="bg-[#9a393e0d]">
            <td className={`${tdCls} font-mono text-[10.5px]`} colSpan={4}>Sub-group totals · Kgs</td>
            <td className={`${tdCls} text-right`}><span className="font-mono tabular-nums font-semibold text-[#1d8102]">{fmtQty(SUBGROUP_LEDGER_TOTALS.in_qty)}</span></td>
            <td className={`${tdCls} text-right`}><span className="font-mono tabular-nums font-semibold text-[var(--aws-error)]">{fmtQty(SUBGROUP_LEDGER_TOTALS.out_qty)}</span></td>
            <td className={`${tdCls} text-right`}><QtyCell n={SUBGROUP_LEDGER_TOTALS.closing} /></td>
          </tr>
        </tbody>
      </TableShell>
      <p className="font-mono text-[10px] text-[var(--text-muted)] mt-2"># Grain toggle: Item ↔ Sub-group ↔ Group. Group grain runs one balance per UOM class.</p>
    </LedgerChrome>
  );
}

"use client";

// Group drill (Tally "Stock Group Summary"): group → sub-groups (cards) → items
// (table), with mixed-UOM preserved per row and a link to view the whole group
// as a voucher ledger. Fixtures today.

import { useParams, useRouter } from "next/navigation";
import { useRequireAuth, useIsAdmin } from "@/lib/user";
import { LedgerChrome } from "../_chrome";
import { slugifySku } from "../_ItemSearch";
import {
  StatCard, ExportBar, UomBadge, QtyCell, ValCell, TableShell, thCls, tdCls,
  fmtInt, type ExportSpec,
} from "../_ui";
import { FG_SUBGROUPS, BARS_ITEMS } from "../_fixtures";
import type { SummaryRow, UomClass } from "@/lib/ledger";

const GROUP_LABELS: Record<string, string> = {
  "finished-goods": "FINISHED GOODS",
  "raw-materials": "RAW MATERIALS",
  "packing-material": "PACKING MATERIAL",
  "capital-items": "Capital Items",
  "maintenance": "Maintenance",
  "expenses-lab": "Expenses Items · Lab",
};

// per-UOM sub-totals derived from the displayed rows (never cross-summed)
function uomSubtotals(rows: SummaryRow[]): { uom: UomClass; qty: number; value: number }[] {
  const m = new Map<UomClass, { qty: number; value: number }>();
  for (const r of rows) {
    if (r.uom_class === "mixed") continue;
    const e = m.get(r.uom_class) ?? { qty: 0, value: 0 };
    e.qty += r.closing_qty ?? 0;
    e.value += r.value_indicative ?? 0;
    m.set(r.uom_class, e);
  }
  return Array.from(m.entries()).map(([uom, e]) => ({ uom, ...e }));
}

export default function GroupPage() {
  const router = useRouter();
  useRequireAuth(router.replace); // redirect side-effect only (see page.tsx note)
  const isAdmin = useIsAdmin();
  const params = useParams<{ group: string }>();
  const groupKey = params.group;
  const groupLabel = GROUP_LABELS[groupKey] ?? groupKey;

  const subgroups: SummaryRow[] = FG_SUBGROUPS; // fixture stand-in for any group
  const items = BARS_ITEMS;
  const subtotals = uomSubtotals(items);

  const spec: ExportSpec = {
    filename: `stock-group-${groupKey}`,
    sheet: groupLabel.slice(0, 28),
    rows: () => [
      ["Item", "Closing Qty", "UOM", "Value (indicative)"],
      ...items.map((i) => [i.label, i.closing_qty ?? "", i.uom_class, i.value_indicative ?? ""]),
      [],
      ...subtotals.map((s) => [`Sub-total ${s.uom.toUpperCase()}`, s.qty, s.uom, s.value]),
    ],
  };

  if (!isAdmin) {
    return (
      <LedgerChrome title={groupLabel}>
        <section className="bg-white border border-[var(--aws-border)] rounded-md p-6 text-[13px] text-[var(--text-secondary)]">
          You don&rsquo;t have access to the Inventory Ledger module. Ask an administrator to grant access.
        </section>
      </LedgerChrome>
    );
  }

  return (
    <LedgerChrome title={groupLabel}>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-[18px] font-bold text-[var(--text-primary)]">{groupLabel} — sub-groups &amp; items</h1>
          <p className="font-mono text-[11px] text-[var(--text-muted)]">card view ↔ table view · godown breakdown on item pages</p>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => router.push(`/modules/inventory-ledger/ledger/group/${groupKey}`)}
          className="font-mono text-[11px] border border-[var(--aws-border)] rounded-[8px] px-[11px] py-[6px] hover:border-[var(--aws-orange)]"
        >▦ View as voucher ledger</button>
        <ExportBar spec={spec} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[9px] mb-4">
        {subgroups.map((s) => (
          <button
            key={s.drill_key}
            onClick={() => router.push(`/modules/inventory-ledger/ledger/subgroup/${s.drill_key}`)}
            className="text-left rounded-[11px] border border-[var(--aws-border)] p-3 flex flex-col gap-[8px] transition hover:-translate-y-[2px] hover:shadow-md bg-white"
          >
            <div className="flex justify-between items-center">
              <span className="font-bold text-[var(--text-primary)] text-[13px]">{s.label}</span>
              <span className="font-mono text-[var(--text-muted)]">→</span>
            </div>
            <div className="font-mono tabular-nums text-[15px] font-bold text-[var(--text-primary)]">
              {s.closing_qty === null ? <span className="text-[var(--text-muted)] text-[12px]">by NOS</span> : <>{s.closing_qty.toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} <span className="text-[10px] text-[var(--text-muted)] font-medium">{s.uom_class === "mixed" ? "Kgs" : s.uom_class}</span></>}
            </div>
            <div className="font-mono text-[10px] text-[var(--text-muted)]">≈ {fmtInt(s.value_indicative)} · {s.item_count} items</div>
          </button>
        ))}
      </div>

      <TableShell>
        <thead>
          <tr>
            <th className={thCls}>Particulars (item)</th>
            <th className={`${thCls} text-right`}>Closing Qty</th>
            <th className={thCls}>UOM</th>
            <th className={`${thCls} text-right`}>Value ≈</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-[var(--surface-subtle)]"><td className={`${tdCls} font-bold`} colSpan={4}>BARS &amp; CEREALS → items</td></tr>
          {items.map((i) => (
            <tr key={i.drill_key} className="hover:bg-[var(--surface-subtle)]">
              <td className={tdCls}>
                <button
                  className="text-[var(--aws-link)] font-semibold hover:underline text-left"
                  onClick={() => router.push(`/modules/inventory-ledger/item/${slugifySku(i.label)}?tab=vouchers`)}
                >{i.label}</button>
              </td>
              <td className={`${tdCls} text-right`}><QtyCell n={i.closing_qty} uom={i.uom_class} /></td>
              <td className={tdCls}><UomBadge uom={i.uom_class} /></td>
              <td className={`${tdCls} text-right`}><ValCell n={i.value_indicative} /></td>
            </tr>
          ))}
          {subtotals.map((s) => (
            <tr key={s.uom} className="bg-[#9a393e0d]">
              <td className={`${tdCls} font-mono text-[10.5px] text-[var(--text-secondary)]`}>Sub-total · {s.uom.toUpperCase()}</td>
              <td className={`${tdCls} text-right`}><QtyCell n={s.qty} uom={s.uom} /></td>
              <td className={tdCls}>{s.uom.toUpperCase()}</td>
              <td className={`${tdCls} text-right`}><ValCell n={s.value} /></td>
            </tr>
          ))}
        </tbody>
      </TableShell>
      <p className="font-mono text-[10px] text-[var(--text-muted)] mt-2"># Click a sub-group to view it as a voucher ledger; click an item to open its ledger. Per-UOM sub-totals are computed from the rows above and never cross-summed.</p>
      <div className="mt-3">
        <StatCard label="Unmapped / Other" value="2,200" unit="Kgs" flag delta="14 rows · needs SKU match" />
      </div>
    </LedgerChrome>
  );
}

// Preview fixtures for the Inventory Ledger module.
//
// Figures taken from the client's live Tally Prime "Stock Summary" screens
// (CFPL 25-26) and the build-preview artifact. These render the module today;
// each page swaps its fixture for the matching `LedgerApi.*` call once the
// /api/v1/ledger backend lands. Item/company data is derived from LEDGER_LEAVES
// (see _tree.ts / _item.ts / _company.ts) so every roll-up stays consistent.

import type { SummaryRow, VoucherRow, ItemSearchResult, LeafItem } from "@/lib/ledger";

// ── FINISHED GOODS → sub-groups (drill cards on the group page) ────
export const FG_SUBGROUPS: SummaryRow[] = [
  { drill_key: "almond-fg", label: "ALMOND FG", level: "subgroup", uom_class: "kg", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: 7792.108, value_indicative: 5768756, item_count: 12, has_children: true },
  { drill_key: "pista-fg", label: "PISTA FG", level: "subgroup", uom_class: "kg", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: 8773.108, value_indicative: 8513700, item_count: 9, has_children: true },
  { drill_key: "bars-cereals", label: "BARS & CEREALS", level: "subgroup", uom_class: "mixed", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: 2992.758, value_indicative: 814167, item_count: 41, has_children: true },
  { drill_key: "cashew-fg", label: "CASHEW FG", level: "subgroup", uom_class: "nos", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: null, value_indicative: 2257914, item_count: 18, has_children: true },
];

// ── BARS & CEREALS → items (group-page table) ──────────────────────
export const BARS_ITEMS: SummaryRow[] = [
  { drill_key: "ccd-energy-bar-jaggery", label: "CCD Energy Bar with Jaggery", level: "item", uom_class: "nos", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: 132.66, value_indicative: 2013.8, item_count: 1, has_children: false },
  { drill_key: "coconut-laddubar-semi", label: "Coconut Laddubar (Semi)", level: "item", uom_class: "kg", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: 19.392, value_indicative: 6739.64, item_count: 1, has_children: false },
  { drill_key: "dark-choc-almond-khalas", label: "Dark Choc Coated Almond Khalas", level: "item", uom_class: "nos", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: -277.04, value_indicative: -635.38, item_count: 1, has_children: false },
  { drill_key: "mie-dark-choc-cashew-1kg", label: "MIE Dark Choc Coated Cashew Khalas 1kg", level: "item", uom_class: "kg", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: 1060.328, value_indicative: 235288, item_count: 1, has_children: false },
  { drill_key: "moon-freeze-strawberry-45g", label: "Moon Freeze Strawberry Date Bar 45g", level: "item", uom_class: "nos", opening_qty: null, inward_qty: null, outward_qty: null, closing_qty: 2607, value_indicative: 62109, item_count: 1, has_children: false },
];

// ── Item search corpus (query "cashew") ────────────────────────────
export const ITEM_SEARCH: ItemSearchResult[] = [
  { sku_id: 30012, particulars: "Cashew 300", item_type: "rm", item_group: "Cashew Kernal", sub_group: "Cashew", uom_class: "kg", closing_qty: 1500.88, value_indicative: 1109169 },
  { sku_id: 30020, particulars: "Cashew 320", item_type: "rm", item_group: "Cashew Kernal", sub_group: "Cashew", uom_class: "kg", closing_qty: -1162.55, value_indicative: -909535 },
  { sku_id: 41120, particulars: "Cashew 320 250g", item_type: "fg", item_group: "Cashew FG", sub_group: "Cashew", uom_class: "nos", closing_qty: 3261, value_indicative: 235288 },
  { sku_id: 41130, particulars: "Cashew Roasted & Salted W320 250G", item_type: "fg", item_group: "Cashew FG", sub_group: "Cashew", uom_class: "nos", closing_qty: 986, value_indicative: 208626 },
  { sku_id: 41210, particulars: "Barbeque Cashew Bulk", item_type: "fg", item_group: "Cashew FG", sub_group: "Flavoured", uom_class: "kg", closing_qty: 240, value_indicative: 187200 },
  { sku_id: 41220, particulars: "Black Pepper Cashew Bulk", item_type: "fg", item_group: "Cashew FG", sub_group: "Flavoured", uom_class: "kg", closing_qty: 1365, value_indicative: 1064700 },
  { sku_id: 41230, particulars: "Cheese Cashew", item_type: "fg", item_group: "Cashew FG", sub_group: "Flavoured", uom_class: "kg", closing_qty: 173, value_indicative: 135805 },
  { sku_id: 30011, particulars: "Cashew 240", item_type: "rm", item_group: "Cashew Kernal", sub_group: "Cashew", uom_class: "kg", closing_qty: 2366.027, value_indicative: 2006445 },
  { sku_id: 30013, particulars: "Cashew 180", item_type: "rm", item_group: "Cashew Kernal", sub_group: "Cashew", uom_class: "kg", closing_qty: 83.036, value_indicative: 93621 },
];

// ── Sub-group voucher ledger (ledger/[grain]/[key] page) ───────────
export const SUBGROUP_LEDGER: VoucherRow[] = [
  { ledger_id: 51910001, posting_date: "2026-06-01", sku_name: "Cashew 320", vch_type: "Job Card", vch_no: "2316", movement_type: "261", direction: "OUT", in_qty: null, out_qty: 250, uom_class: "kg", running_balance: 15842.11, counterpart_label: "JC-2316", ref_type: "JOB_CARD", ref_id: "2316", is_synthetic: false, fifo_flag: null },
  { ledger_id: 51910002, posting_date: "2026-06-02", sku_name: "Cashew 240", vch_type: "Job Card", vch_no: "2408", movement_type: "261", direction: "OUT", in_qty: null, out_qty: 180, uom_class: "kg", running_balance: 15662.11, counterpart_label: "JC-2408", ref_type: "JOB_CARD", ref_id: "2408", is_synthetic: false, fifo_flag: null },
  { ledger_id: 51910003, posting_date: "2026-06-03", sku_name: "Cashew 320", vch_type: "Receipt", vch_no: "GR-0912", movement_type: "101", direction: "IN", in_qty: 1000, out_qty: null, uom_class: "kg", running_balance: 16662.11, counterpart_label: "PO-0912", ref_type: "PO", ref_id: "0912", is_synthetic: true, fifo_flag: null },
  { ledger_id: 51910004, posting_date: "2026-06-04", sku_name: "Cashew 180", vch_type: "Transfer", vch_no: "TR-0301", movement_type: "301", direction: "TRANSFER", in_qty: 500, out_qty: null, uom_class: "kg", running_balance: 17162.11, counterpart_label: "from Rishi", ref_type: "TRANSFER", ref_id: "0301", is_synthetic: true, fifo_flag: null },
  { ledger_id: 51910005, posting_date: "2026-06-05", sku_name: "Cashew 300", vch_type: "Job Card", vch_no: "2474", movement_type: "261", direction: "OUT", in_qty: null, out_qty: 320, uom_class: "kg", running_balance: 16842.11, counterpart_label: "JC-2474", ref_type: "JOB_CARD", ref_id: "2474", is_synthetic: false, fifo_flag: null },
];
export const SUBGROUP_LEDGER_TOTALS = { in_qty: 28940, out_qty: 31138.5, closing: 16842.11 };

// Company-level KPIs for the Stock Summary dashboard
export const COMPANY_KPIS = {
  closing_value_cr: "18.44",
  quantity_kg: 742180,
  boxes: 128540,
  in_transit_boxes: 5422,
  wip_sfg_kg: 31905,
  reconcile_flags: 17,
};

// ── Granular leaf dataset for the Stock Summary tree ───────────────
// One row per item. Closing is DERIVED (buildLedgerTree), so the movement
// columns and every roll-up/sub-total are guaranteed internally consistent.
// Top group = item_type label; sub-group = item_group; leaf = particulars.
function leaf(
  sku_id: number, label: string, item_type: string, group: string, subgroup: string,
  uom_class: LeafItem["uom_class"], godown: string, value_indicative: number,
  m: Partial<Pick<LeafItem, "opening_qty" | "inward_qty" | "production_qty" | "returns_qty" | "consumption_qty" | "outward_qty" | "transfer_out_qty">>,
): LeafItem {
  return {
    sku_id, label, item_type, group, subgroup, uom_class, godown, value_indicative,
    opening_qty: m.opening_qty ?? 0, inward_qty: m.inward_qty ?? 0,
    production_qty: m.production_qty ?? 0, returns_qty: m.returns_qty ?? 0,
    consumption_qty: m.consumption_qty ?? 0, outward_qty: m.outward_qty ?? 0,
    transfer_out_qty: m.transfer_out_qty ?? 0,
  };
}

export const LEDGER_LEAVES: LeafItem[] = [
  // RAW MATERIALS → Cashew Kernal (kg)
  leaf(30020, "Cashew 320", "rm", "RAW MATERIALS", "Cashew Kernal", "kg", "Savla D-39", -906788, { opening_qty: 663.822, inward_qty: 28000, consumption_qty: 29626.371, transfer_out_qty: 200 }),
  leaf(30011, "Cashew 240", "rm", "RAW MATERIALS", "Cashew Kernal", "kg", "Rishi", 2006445, { opening_qty: 2000.027, inward_qty: 3000, consumption_qty: 2634 }),
  leaf(30012, "Cashew 300", "rm", "RAW MATERIALS", "Cashew Kernal", "kg", "Savla D-39", 1109153, { opening_qty: 1200.883, inward_qty: 800, consumption_qty: 500 }),
  leaf(30013, "Cashew 180", "rm", "RAW MATERIALS", "Cashew Kernal", "kg", "Savla D-514", 93621, { opening_qty: 100, inward_qty: 50, consumption_qty: 66.964 }),
  // RAW MATERIALS → Almond (kg)
  leaf(31010, "Almond NP 27/30", "rm", "RAW MATERIALS", "Almond", "kg", "Supreme", 6771000, { opening_qty: 9300, inward_qty: 3000, consumption_qty: 1150, transfer_out_qty: 2000 }),
  leaf(31020, "American Almonds Running", "rm", "RAW MATERIALS", "Almond", "kg", "Supreme", 1224000, { opening_qty: 1500, inward_qty: 500, consumption_qty: 300 }),
  // RAW MATERIALS → Dates (kg)
  leaf(32010, "Kimia Wet Dates", "rm", "RAW MATERIALS", "Dates", "kg", "Eskimo", 2931600, { opening_qty: 22050, inward_qty: 6500, outward_qty: 4120 }),
  // FINISHED GOODS → Bars & Cereals (mixed kg + nos)
  leaf(41310, "CCD Energy Bar with Jaggery", "fg", "FINISHED GOODS", "Bars & Cereals", "nos", "Savla D-39", 2014, { opening_qty: 100, production_qty: 200, outward_qty: 167.34 }),
  leaf(41320, "Coconut Laddubar (Semi)", "fg", "FINISHED GOODS", "Bars & Cereals", "kg", "Factory", 6740, { opening_qty: 10, production_qty: 15, outward_qty: 5.608 }),
  leaf(41330, "MIE Dark Choc Coated Cashew Khalas 1kg", "fg", "FINISHED GOODS", "Bars & Cereals", "kg", "Savla D-514", 235287, { opening_qty: 900, production_qty: 300, outward_qty: 139.672 }),
  leaf(41340, "Moon Freeze Strawberry Date Bar 45g", "fg", "FINISHED GOODS", "Bars & Cereals", "nos", "Savla D-39", 62099, { opening_qty: 2000, production_qty: 1000, outward_qty: 393 }),
  // FINISHED GOODS → Cashew FG (mixed)
  leaf(41120, "Cashew 320 250g", "fg", "FINISHED GOODS", "Cashew FG", "nos", "Savla D-514", 235280, { opening_qty: 3000, production_qty: 500, outward_qty: 239 }),
  leaf(41210, "Barbeque Cashew Bulk", "fg", "FINISHED GOODS", "Cashew FG", "kg", "Savla D-514", 187200, { opening_qty: 200, production_qty: 100, outward_qty: 60 }),
  // PACKING MATERIAL (mixed nos + kg)
  leaf(51010, "Standup Pouch 100g - Chatpata", "pm", "PACKING MATERIAL", "Pouches", "nos", "W202", 150000, { opening_qty: 50000, inward_qty: 20000, consumption_qty: 10000 }),
  leaf(51020, "Laminated Roll 300mm", "pm", "PACKING MATERIAL", "Rolls", "kg", "W202", 306000, { opening_qty: 1200, inward_qty: 800, consumption_qty: 300 }),
];

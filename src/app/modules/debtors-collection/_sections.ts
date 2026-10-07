// The two DPD sections and the text columns each one is broken down and
// filtered by. Sections render as tabs in this order (the first is the
// default); dimensions appear as table columns and filters in this order.

import type { DpdDimension, DpdSectionKey } from "@/lib/debtors";

export interface DimensionDef {
  field: DpdDimension;
  /** Column header and filter label. */
  label: string;
  /** Breakdown card heading. */
  title: string;
  /** Group label for the parties with no value in this column. */
  blank: string;
  /** Render values as a neutral pill (a short fixed category) instead of text. */
  pill?: boolean;
}

export interface SectionDef {
  key: DpdSectionKey;
  label: string;
  dimensions: DimensionDef[];
  /** The breakdown shown first; defaults to the first dimension. */
  defaultBreakdown?: DpdDimension;
  searchPlaceholder: string;
}

export const SECTIONS: SectionDef[] = [
  {
    key: "cd-cf",
    label: "CD-CF",
    dimensions: [
      { field: "division", label: "CD - CF", title: "By CD - CF", blank: "Not set", pill: true },
      { field: "salesPerson", label: "Sales person", title: "By sales person", blank: "Unassigned" },
    ],
    defaultBreakdown: "salesPerson",
    searchPlaceholder: "Customer or sales person",
  },
  {
    key: "apmc",
    label: "APMC + Non-APMC",
    dimensions: [
      { field: "type", label: "Type", title: "By type", blank: "No type", pill: true },
      { field: "broker", label: "Broker", title: "By broker", blank: "No broker" },
    ],
    searchPlaceholder: "Customer, type or broker",
  },
];

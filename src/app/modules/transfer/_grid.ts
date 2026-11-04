// Fully ruled list tables for the transfer screens, per the BOM / Transfer-IN grid
// precedent. The cell rules ride on the table as descendant variants so every list
// shares one definition; `border-collapse` keeps adjacent rules from doubling up. They
// outrank a padding or border class on a single cell, so cell spacing is set here and
// nowhere else.
// GRID_WRAP holds a desktop table: on a narrow screen the table scrolls sideways inside
// it (as in BOM) instead of pushing the page wider.
export const GRID_WRAP = "hidden md:block overflow-x-auto";
export const GRID_TABLE =
  "w-full text-[12px] border-collapse border border-[var(--aws-border)] bg-white " +
  "[&_th]:border [&_th]:border-[var(--aws-border)] [&_th]:bg-[var(--surface-subtle)] [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold " +
  "[&_td]:border [&_td]:border-[var(--aws-border)] [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle";

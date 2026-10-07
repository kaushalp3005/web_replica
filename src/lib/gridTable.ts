// The Stock Take module's table look (app/modules/stock-take/page.tsx), shared by
// the plan-builder tables on SO Creation: a white rounded box, every cell
// bordered, a light header band with plain semibold labels, centred cells.

/** The box around the table: bordered and rounded; scroll the table inside it. */
export const GRID_WRAP = "bg-white border border-[var(--aws-border)] rounded-md overflow-hidden";
export const GRID_TABLE = "w-full text-[13px] border-collapse";
export const GRID_HEAD_ROW = "bg-[#fafafa]";
export const GRID_TH =
  "border border-[var(--aws-border)] px-3 py-2 font-semibold text-[var(--text-primary)] whitespace-nowrap text-center";
export const GRID_TD = "border border-[var(--aws-border)] px-3 py-2 text-center align-middle";
export const GRID_ROW = "hover:bg-[#fafafa]";

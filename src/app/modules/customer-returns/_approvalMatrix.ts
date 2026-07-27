// Approval matrix — customer-return e-mail routing. The recipient DATA now comes
// from the DB (GET /api/v1/customer-returns/email-routing -> CrEmailRouting),
// replacing the hardcoded maps this file used to carry (a verbatim port of the
// legacy backend shared/email_notifier.py literals). Only the pure resolve LOGIC
// lives here now — who is TO / CC / approver, and the warehouse-canonicalization
// test — with the values passed in.
//
// The rule that matters is unchanged: only the mapped Business Head receives the
// action buttons, so the BH is THE approver; everyone else is TO(notify_to)/CC.

import { normalizeWarehouseName } from "@/lib/transferBuildSummary";
import type { CrEmailRouting } from "@/lib/customer-returns";

// Empty routing — used as the initial value before the fetch resolves (and if it
// fails): no approver, no recipients, so the UI degrades to "cannot be actioned".
export const EMPTY_ROUTING: CrEmailRouting = {
  business_head: [], sales_poc: [], warehouse_cc: [], constant_cc: [], notify_to: null,
};

// Case-insensitive display-name -> email over a [{name,email}] list.
const ciEmail = (rows: { name: string; email: string }[], key: string | null | undefined): string | null => {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  for (const r of rows) if (r.name.trim().toLowerCase() === k) return r.email;
  return null;
};

export const lookupBusinessHeadEmail = (routing: CrEmailRouting, bh?: string | null) => ciEmail(routing.business_head, bh);
export const lookupSalesPocEmail = (routing: CrEmailRouting, poc?: string | null) => ciEmail(routing.sales_poc, poc);

// Reverse email -> known display name (from BH + POC), else derive from the
// local-part (b.hrithik -> "B Hrithik").
export function nameForEmail(routing: CrEmailRouting, email?: string | null): string | null {
  if (!email) return null;
  const k = email.trim().toLowerCase();
  for (const r of [...routing.sales_poc, ...routing.business_head]) if (r.email.toLowerCase() === k) return r.name;
  return null;
}

function deriveNameFromEmail(email: string): string {
  const local = email.split("@")[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || email;
}

export function formatActor(routing: CrEmailRouting, email?: string | null): string {
  const e = email?.trim();
  if (!e) return "-";
  return `${nameForEmail(routing, e) ?? deriveNameFromEmail(e)} (${e})`;
}

// factory_unit -> warehouse-owner CC. The routing carries warehouse_cc rows with
// match_type 'substring' (cold storages, tested against the canonicalized name)
// or 'code' (exact after stripping separators). Canonicalize first so a bare code
// like "D-39" resolves to "Savla D-39" and hits the cold branch. Rows are already
// ordered cold-substrings-before-codes by the endpoint (sort_order).
export function warehouseCcEmail(routing: CrEmailRouting, factoryUnit?: string | null): string | null {
  if (!factoryUnit) return null;
  const low = normalizeWarehouseName(factoryUnit).toLowerCase();
  const code = low.replace(/[-\s]/g, "");
  for (const r of routing.warehouse_cc) {
    const key = r.match_key.trim().toLowerCase();
    if (!key) continue;
    if (r.match_type === "substring" && low.includes(key)) return r.email;
    if (r.match_type === "code" && code === key.replace(/[-\s]/g, "")) return r.email;
  }
  return null;
}

export interface CRRecipientHeader {
  business_head?: string | null;
  sales_poc?: string | null;
  sales_poc_email?: string | null;
  factory_unit?: string | null;
  created_by?: string | null;
}

export interface ApprovalRecipients {
  approver: { name: string; email: string } | null; // the BH — gets the buttons
  to: string[]; // TO line (approver + notify_to)
  cc: string[]; // deduped CC line
}

// Resolve the recipient matrix exactly like the legacy notify_rtv_created: the
// mapped BH (if any) leads the TO alongside notify_to and is the sole approver;
// CC = sales POC (mapped + manual) + constants + creator + warehouse owner,
// deduped, with the TO addresses (and the approver) removed.
export function resolveRecipients(routing: CrEmailRouting, h: CRRecipientHeader): ApprovalRecipients {
  const bhEmail = lookupBusinessHeadEmail(routing, h.business_head);
  const approver = bhEmail ? { name: (h.business_head || "").trim() || bhEmail, email: bhEmail } : null;

  const to = [...(bhEmail ? [bhEmail] : []), ...(routing.notify_to ? [routing.notify_to] : [])];
  const toLower = new Set(to.map((a) => a.trim().toLowerCase()));

  const candidates: string[] = [];
  const pocEmail = lookupSalesPocEmail(routing, h.sales_poc);
  if (pocEmail) candidates.push(pocEmail);
  if (h.sales_poc_email && h.sales_poc_email.trim()) candidates.push(h.sales_poc_email.trim());
  candidates.push(...routing.constant_cc);
  if (h.created_by) candidates.push(h.created_by);
  const wh = warehouseCcEmail(routing, h.factory_unit);
  if (wh) candidates.push(wh);

  const seen = new Set<string>();
  const cc: string[] = [];
  for (const addr of candidates) {
    const n = addr.trim().toLowerCase();
    if (!n || seen.has(n) || toLower.has(n)) continue;
    seen.add(n);
    cc.push(addr.trim());
  }
  return { approver, to, cc };
}

// ── Runnable self-check (ponytail: one assert-based demo for the routing) ──
// Run:  npx tsx -e "import('./src/app/modules/customer-returns/_approvalMatrix').then(m=>m.demo())"
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error("approvalMatrix demo failed: " + m); };

  // A sample of what the endpoint returns.
  const routing: CrEmailRouting = {
    notify_to: "pooja.parkar@candorfoods.in",
    business_head: [
      { name: "Yash Gawdi", email: "yash@candorfoods.in" },
      { name: "Prashant Pal", email: "prashant.pal@candorfoods.in" },
    ],
    sales_poc: [
      { name: "Shubham Seth", email: "shubham.seth@candorfoods.in" },
      { name: "B Hrithik", email: "b.hrithik@candorfoods.in" },
    ],
    constant_cc: ["billing@candorfoods.in", "yash@candorfoods.in"],
    warehouse_cc: [
      { match_key: "savla", match_type: "substring", email: "vaibhav.kumkar@candorfoods.in" },
      { match_key: "a68", match_type: "code", email: "pankaj.ranga@candorfoods.in" },
    ],
  };

  // Mapped BH is the approver and leads TO; its address is excluded from CC.
  // factory_unit "D-39" (the bare code the CR form stores) exercises the
  // canonicalization the warehouse-CC lookup must apply (D-39 -> "Savla D-39").
  const r = resolveRecipients(routing, {
    business_head: "yash gawdi", // case-insensitive
    sales_poc: "Shubham Seth",
    factory_unit: "D-39",
    created_by: "warehouse@candorfoods.in",
  });
  assert(r.approver?.email === "yash@candorfoods.in", "approver = BH email");
  assert(r.to[0] === "yash@candorfoods.in" && r.to.includes("pooja.parkar@candorfoods.in"), "TO = BH + notify_to");
  assert(r.cc.includes("shubham.seth@candorfoods.in"), "POC email in CC");
  assert(r.cc.includes("vaibhav.kumkar@candorfoods.in"), "cold warehouse CC (bare D-39 canonicalized)");
  assert(r.cc.includes("warehouse@candorfoods.in"), "creator in CC");
  assert(!r.cc.some((a) => a.toLowerCase() === "yash@candorfoods.in"), "BH not duplicated into CC");
  assert(!r.cc.includes("pooja.parkar@candorfoods.in"), "notify_to not duplicated into CC");
  assert(new Set(r.cc.map((a) => a.toLowerCase())).size === r.cc.length, "CC deduped");

  // Manual (Other) sales_poc_email is added to CC as-is.
  const rManual = resolveRecipients(routing, { business_head: "Prashant Pal", sales_poc_email: "manual.poc@example.com" });
  assert(rManual.approver?.email === "prashant.pal@candorfoods.in", "manual case: approver = BH");
  assert(rManual.cc.includes("manual.poc@example.com"), "manual sales_poc_email in CC");

  // Warehouse-CC canonicalization.
  assert(warehouseCcEmail(routing, "D-39") === "vaibhav.kumkar@candorfoods.in", "bare D-39 -> cold CC");
  assert(warehouseCcEmail(routing, "A-68") === "pankaj.ranga@candorfoods.in", "A68 -> stores CC");
  assert(warehouseCcEmail(routing, "Random Unit") === null, "unmapped unit -> no warehouse CC");

  // No mapped BH -> no approver, TO is notify_to only.
  const r2 = resolveRecipients(routing, { business_head: "Someone Else", factory_unit: "A-68" });
  assert(r2.approver === null, "unmapped BH -> no approver");
  assert(r2.to.length === 1 && r2.to[0] === "pooja.parkar@candorfoods.in", "TO = notify_to only");
  assert(r2.cc.includes("pankaj.ranga@candorfoods.in"), "A68 warehouse CC");

  // Empty routing -> nothing resolves (graceful degrade before the fetch lands).
  const rEmpty = resolveRecipients(EMPTY_ROUTING, { business_head: "Yash Gawdi", factory_unit: "D-39" });
  assert(rEmpty.approver === null && rEmpty.to.length === 0 && rEmpty.cc.length === 0, "empty routing -> nothing");

  assert(formatActor(routing, "b.hrithik@candorfoods.in") === "B Hrithik (b.hrithik@candorfoods.in)", "actor known name");
  assert(formatActor(routing, "jane.doe@x.com") === "Jane Doe (jane.doe@x.com)", "actor derived name");
  assert(formatActor(routing, "") === "-", "empty actor");

  console.log("approvalMatrix demo: ALL ASSERTIONS PASSED");
}

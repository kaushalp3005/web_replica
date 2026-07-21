// Approval matrix — the customer-return e-mail routing, ported verbatim from the
// legacy backend `shared/email_notifier.py` so the review screen shows exactly
// who the Approve/Reject/Hold notification reaches and who is allowed to decide.
//
// The rule that matters: only the mapped **Business Head** receives the action
// buttons (magic-link), so the BH is THE approver. Everyone else is TO(pooja)/CC.
// See notify_rtv_created + _build_rtv_cc + _warehouse_cc_email in the backend.

// Business Head -> email (the approver). Matched case-insensitively.
export const BUSINESS_HEAD_EMAILS: Record<string, string> = {
  "Prashant Pal": "prashant.pal@candorfoods.in",
  "Ajay Bajaj": "ajay@candorfoods.in",
  "Rakesh Ratra": "rakesh@candorfoods.in",
  "Yash Gawdi": "yash@candorfoods.in",
  "Satyendra Garg": "satyendra@candorfoods.in",
  "R M Patil": "rmpatil@candorfoods.in",
};

// Sales POC -> email (added to CC). Matched case-insensitively.
export const SALES_POC_EMAILS: Record<string, string> = {
  "Shubham Shivekar": "shubham@candorfoods.in",
  "Shubham Seth": "shubham.seth@candorfoods.in",
  "Mayuresh Mahadik": "mayuresh@candorfoods.in",
  "Suraj Salunkhe": "suraj@candorfoods.in",
  "B Hrithik": "b.hrithik@candorfoods.in",
  "Sachin More": "sachin.more@candorfoods.in",
  "Dashrath Birajdar": "dashrath@candorfoods.in",
  "Ashwin Baghul": "ashwin@candorfoods.in",
  "Rakesh Ratra": "rakesh@candorfoods.in",
  "Ajay Bajaj": "ajay@candorfoods.in",
  "Yash Gawdi": "yash@candorfoods.in",
  "R M Patil": "rmpatil@candorfoods.in",
  "Satyendra Garg": "satyendra@candorfoods.in",
  "Prashant Pal": "prashant.pal@candorfoods.in",
  "Suresh Luthra": "suresh@candorfoods.in",
  "Swadhin Joshi": "swadhin.joshi@candorfoods.in",
};

// pooja is the standing TO on every customer-return mail.
export const RTV_NOTIFY_TO = "pooja.parkar@candorfoods.in";

// Constant CCs added to every customer-return notification.
export const RTV_CC_CONSTANT = [
  "sunil.jasoria@candorfoods.in",
  "b.hrithik@candorfoods.in",
  "billing@candorfoods.in",
  "satyendra@candorfoods.in",
  "sachin.more@candorfoods.in",
  "dipesh.sharma@ofbusiness.in",
  "yash@candorfoods.in",
];

const ci = (m: Record<string, string>, key: string | null | undefined): string | null => {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  for (const [name, email] of Object.entries(m)) if (name.toLowerCase() === k) return email;
  return null;
};

export const lookupBusinessHeadEmail = (bh?: string | null) => ci(BUSINESS_HEAD_EMAILS, bh);
export const lookupSalesPocEmail = (poc?: string | null) => ci(SALES_POC_EMAILS, poc);

// Reverse email -> known display name, else derive from the local-part
// (b.hrithik -> "B Hrithik"); renders an actor as "Name (email)".
export function nameForEmail(email?: string | null): string | null {
  if (!email) return null;
  const k = email.trim().toLowerCase();
  for (const [name, addr] of Object.entries({ ...SALES_POC_EMAILS, ...BUSINESS_HEAD_EMAILS }))
    if (addr.toLowerCase() === k) return name;
  return null;
}

function deriveNameFromEmail(email: string): string {
  const local = email.split("@")[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || email;
}

export function formatActor(email?: string | null): string {
  const e = email?.trim();
  if (!e) return "-";
  return `${nameForEmail(e) ?? deriveNameFromEmail(e)} (${e})`;
}

// factory_unit -> extra CC recipient (warehouse owner). Cold storages + W202 ->
// Vaibhav; A185/A68 -> their stores owners. Tolerant of hyphen/space/alias
// variants (matches the backend substring test on the canonical name).
// ponytail: substring match, not the full canonical_warehouse alias table — the
// four cold names + three codes below are all the backend actually branches on.
export function warehouseCcEmail(factoryUnit?: string | null): string | null {
  if (!factoryUnit) return null;
  const low = factoryUnit.trim().toLowerCase();
  if (["savla", "rishi", "supreme", "eskimo"].some((k) => low.includes(k)))
    return "vaibhav.kumkar@candorfoods.in";
  const code = low.replace(/[-\s]/g, "");
  if (code === "w202") return "vaibhav.kumkar@candorfoods.in";
  if (code === "a185") return "stores-a185@candorfoods.in";
  if (code === "a68") return "pankaj.ranga@candorfoods.in";
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
  to: string[]; // TO line (approver + pooja)
  cc: string[]; // deduped CC line
}

// Resolve the recipient matrix exactly like notify_rtv_created: BH (if mapped)
// leads the TO alongside pooja and is the sole approver; CC = sales POC (mapped
// + manual) + constants + creator + warehouse owner, deduped, with the TO
// addresses (and the approver) removed.
export function resolveRecipients(h: CRRecipientHeader): ApprovalRecipients {
  const bhEmail = lookupBusinessHeadEmail(h.business_head);
  const approver = bhEmail ? { name: (h.business_head || "").trim() || bhEmail, email: bhEmail } : null;

  const to = [...(bhEmail ? [bhEmail] : []), RTV_NOTIFY_TO];
  const toLower = new Set(to.map((a) => a.trim().toLowerCase()));

  const candidates: string[] = [];
  const pocEmail = lookupSalesPocEmail(h.sales_poc);
  if (pocEmail) candidates.push(pocEmail);
  if (h.sales_poc_email && h.sales_poc_email.trim()) candidates.push(h.sales_poc_email.trim());
  candidates.push(...RTV_CC_CONSTANT);
  if (h.created_by) candidates.push(h.created_by);
  const wh = warehouseCcEmail(h.factory_unit);
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
// Run:  npx tsx src/app/modules/customer-returns/_approvalMatrix.ts
export function demo(): void {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error("approvalMatrix demo failed: " + m); };

  // Mapped BH is the approver and leads TO; its address is excluded from CC.
  const r = resolveRecipients({
    business_head: "yash gawdi", // case-insensitive
    sales_poc: "Shubham Seth",
    factory_unit: "Savla D-39",
    created_by: "warehouse@candorfoods.in",
  });
  assert(r.approver?.email === "yash@candorfoods.in", "approver = BH email");
  assert(r.to[0] === "yash@candorfoods.in" && r.to.includes(RTV_NOTIFY_TO), "TO = BH + pooja");
  assert(r.cc.includes("shubham.seth@candorfoods.in"), "POC email in CC");
  assert(r.cc.includes("vaibhav.kumkar@candorfoods.in"), "cold warehouse CC");
  assert(r.cc.includes("warehouse@candorfoods.in"), "creator in CC");
  assert(!r.cc.some((a) => a.toLowerCase() === "yash@candorfoods.in"), "BH not duplicated into CC");
  assert(!r.cc.includes(RTV_NOTIFY_TO), "pooja not duplicated into CC");
  assert(new Set(r.cc.map((a) => a.toLowerCase())).size === r.cc.length, "CC deduped");

  // No mapped BH -> no approver, TO is pooja only.
  const r2 = resolveRecipients({ business_head: "Someone Else", factory_unit: "A-68" });
  assert(r2.approver === null, "unmapped BH -> no approver");
  assert(r2.to.length === 1 && r2.to[0] === RTV_NOTIFY_TO, "TO = pooja only");
  assert(r2.cc.includes("pankaj.ranga@candorfoods.in"), "A68 warehouse CC");

  assert(formatActor("b.hrithik@candorfoods.in") === "B Hrithik (b.hrithik@candorfoods.in)", "actor known name");
  assert(formatActor("jane.doe@x.com") === "Jane Doe (jane.doe@x.com)", "actor derived name");
  assert(formatActor("") === "-", "empty actor");

  console.log("approvalMatrix demo: ALL ASSERTIONS PASSED");
}

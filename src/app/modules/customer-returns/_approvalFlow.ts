// Customer-return approval flow — the pure parts the New, Detail and Review screens
// share:
//   * the status vocabulary: which statuses are still open (isUndecided), which count
//     as approved (isCrApproved) and what the UI calls each (crStatusLabel — the badge
//     and every sentence alike). _shared.tsx re-exports it for the badge, the list
//     tabs and the dashboard, so the module has one wording.
//   * sendOutcomeNotice / sendErrorNotice: what "Send for approval" actually achieved,
//     as one line for the operator. The server reports each channel truthfully (mail:
//     every copy sent, or why not; WhatsApp: sent / partial / failed / skipped), so a
//     failed send is never shown as sent.
//   * sendNoticeKey: the tab-scoped one-shot that carries that line from the New
//     screen to the Detail screen it navigates to.
//   * decisionGate: whether the logged-in user may Approve / Reject / Hold, with a
//     one-line reason when not. The server enforces the same rule for every channel
//     (approval_service.apply_cr_action): only the Business Head or a standing deputy,
//     never the person who raised the return, and only while it is Pending / On Hold.
//     This only explains it before the click.
//   * reviewAccess: who may open the Review screen — admins, and the return's own
//     approvers, who need not be admins (the in-app channel is theirs). The server's
//     GET needs only a login; this keeps the screen to the people it is for.
// Plain .ts with type-only imports so node can run the test next to it:
//
//     node src/app/modules/customer-returns/_approvalFlow.test.ts

import type { CRSendForApprovalResponse, CRStatus } from "../../../lib/customer-returns.ts";

/** A decision can be taken only from these (no status reads as Pending). Approved,
 *  Submitted (approved, then boxes saved) and Rejected are decided and final. */
export const UNDECIDED_STATUSES: readonly CRStatus[] = ["Pending", "On Hold"];

// A stored status as the server's decision rules read it (approval_service._status):
// spaces trimmed, none or blank being Pending — so this screen and the server agree.
const readStatus = (status: string | null | undefined) => (status ?? "").replace(/^ +| +$/g, "") || "Pending";

export function isUndecided(status: string | null | undefined): boolean {
  return (UNDECIDED_STATUSES as readonly string[]).includes(readStatus(status));
}

// 'Submitted' is stored for an approved return whose boxes were saved after the
// approval (the bulk box save flips Approved → Submitted), so it is shown — and
// styled — as approved. The raw value stays in the API, the list's status filter
// and the Excel export's Status column. (The server's own wording, in its mail-link
// pages, WhatsApp replies and error messages, is "Approved (boxes saved)".)
export const CR_STATUS_LABEL: Record<CRStatus, string> = {
  Pending: "Pending",
  Approved: "Approved",
  Submitted: "Approved · Boxed",
  Rejected: "Rejected",
  "On Hold": "On Hold",
};

/** A status as the UI shows it; an unknown value shows as stored (trimmed), none or
 *  blank as Pending. */
export function crStatusLabel(status: string | null | undefined): string {
  const s = readStatus(status);
  return Object.prototype.hasOwnProperty.call(CR_STATUS_LABEL, s) ? CR_STATUS_LABEL[s as CRStatus] : s;
}

/** Approved, including approved and then boxed (Submitted). */
export function isCrApproved(status: string | null | undefined): boolean {
  return status === "Approved" || status === "Submitted";
}

// ── Send for approval: the notice ───────────────────────────────────────────
export type SendNoticeTone = "success" | "warning" | "error";
export interface SendNotice {
  tone: SendNoticeTone;
  text: string;
}

const MAIL_REASON: Record<string, string> = {
  smtp_not_configured: "the mail server isn't configured on the ERP server",
  no_recipients: "no recipient e-mail address could be found",
  smtp_error: "the mail server failed or refused it",
  error: "an error on the server",
};

const WA_REASON: Record<string, string> = {
  wa_disabled: "WhatsApp isn't configured",
  no_approver_phone: "no approver has a WhatsApp number on file",
  send_failed: "WhatsApp refused the message",
  media_upload_failed: "the article image couldn't be uploaded to WhatsApp",
  mapping_store_failed: "the reply link couldn't be saved",
  exception: "an error on the server",
};

const NO_APPROVER =
  "nobody can approve this return: its Business Head isn't mapped to an e-mail and no deputy approver " +
  "is configured. Ask an admin to fix the approver setup, then use Send for approval.";

const ONLY_CREATOR =
  "nobody else can approve this return: its only approver is the person who raised it, and nobody " +
  "decides their own return. Ask an admin to set up another approver (a deputy approver), then use " +
  "Send for approval.";

const RETRY = "Use Send for approval to retry.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const why = (map: Record<string, string>, reason: string | undefined) =>
  (reason && map[reason]) || reason || "unknown reason";

function mailPart(res: CRSendForApprovalResponse): string {
  const m = res.mail;
  if (m.sent) {
    return `Approval mail sent to ${m.to.join(", ") || "—"}${m.cc_count ? ` (+${m.cc_count} cc)` : ""}`;
  }
  const reason = why(MAIL_REASON, m.reason);
  const approvers = res.approvers.length;
  if (m.approvers_mailed > 0) {
    return `Approval mail sent to ${m.approvers_mailed} of ${plural(approvers, "approver")}, ` +
      `not to ${(m.failed ?? []).join(", ") || "some recipients"} (${reason})`;
  }
  return `Approval mail NOT sent (${reason})`;
}

function whatsAppPart(res: CRSendForApprovalResponse): string {
  const w = res.whatsapp;
  const reason = why(WA_REASON, w.reason);
  switch (w.status) {
    case "sent":
      return `WhatsApp sent to ${plural(w.sent, "approver")}`;
    case "partial":
      return `WhatsApp sent to ${w.sent} of ${plural(w.sent + w.failed, "approver")} (${reason})`;
    case "failed":
      return `WhatsApp NOT sent (${reason})`;
    default:
      return `WhatsApp skipped (${reason})`;
  }
}

/** One line for what Send for approval achieved: green when every mail copy went out
 *  and WhatsApp did not fail (skipped is fine — the mail carries the same buttons),
 *  amber when only part of it went out, red when no approver who can decide was
 *  reached, or there is none (the person who raised the return never counts). */
export function sendOutcomeNotice(res: CRSendForApprovalResponse): SendNotice {
  if (res.reason === "no_approver") return { tone: "error", text: `Approval NOT sent: ${NO_APPROVER}` };
  if (res.reason === "only_creator") return { tone: "error", text: `Approval NOT sent: ${ONLY_CREATOR}` };
  const parts = `${mailPart(res)} · ${whatsAppPart(res)}.`;
  if (res.status === "sent") return { tone: "success", text: parts };
  if (res.status === "partial") return { tone: "warning", text: `Approval only partly sent — ${parts} ${RETRY}` };
  const mail = res.mail.sent ? "mail sent" : `mail — ${why(MAIL_REASON, res.mail.reason)}`;
  const wa = `WhatsApp — ${why(WA_REASON, res.whatsapp.reason)}`;
  return { tone: "error", text: `Approval NOT sent: ${mail}; ${wa}. ${RETRY}` };
}

/** The request itself failed (network, 500, or a refusal such as an already-decided
 *  return). `retry` false drops the retry hint when retrying can't help. */
export function sendErrorNotice(message: string, retry = true): SendNotice {
  const m = (message || "the request failed").trim().replace(/\.$/, "");
  return { tone: "error", text: `Approval NOT sent: ${m}.${retry ? ` ${RETRY}` : ""}` };
}

/** sessionStorage key of the one-shot notice for one return (this tab only). */
export function sendNoticeKey(company: string, crId: string): string {
  return `cr:send-notice:${company}:${crId}`;
}

// ── Who may decide ──────────────────────────────────────────────────────────
export interface DecisionGateInput {
  me: { email?: string | null } | null; // null while the session is still loading
  createdBy: string | null | undefined;
  approverEmails: readonly string[];
  status: string | null | undefined;
  usingSample: boolean;
  routingError: boolean;
  readOnly: boolean;
}

export interface DecisionGate {
  canDecide: boolean;
  reason: string | null; // one line, shown when the buttons are disabled
}

const norm = (email: string | null | undefined) => (email ?? "").trim().toLowerCase();
const no = (reason: string): DecisionGate => ({ canDecide: false, reason });

/** Mirrors the server's checks, in the server's order (no approver, no e-mail, own
 *  return, not an approver); the server still decides. */
export function decisionGate(i: DecisionGateInput): DecisionGate {
  if (i.usingSample) return no("The live return couldn't be loaded, so decisions are off while a sample is shown.");
  if (i.readOnly) return no("Customer Returns is read-only right now.");
  if (!isUndecided(i.status)) return no(`This return is already “${crStatusLabel(i.status)}”.`);
  if (i.routingError) return no("The approver list couldn't be loaded, so decisions are off. Reload to try again.");
  if (i.approverEmails.length === 0) {
    return no("Nobody can decide this return: its Business Head isn't mapped to an e-mail and no deputy approver is configured.");
  }
  if (i.me === null) return no("Checking your account…");
  const mine = norm(i.me.email);
  if (!mine) return no("Your account has no e-mail address, so it can't be matched to an approver.");
  if (mine === norm(i.createdBy)) return no("You raised this return, so another approver must decide it.");
  if (!i.approverEmails.some((e) => norm(e) === mine)) {
    return no("Only the Business Head or a deputy approver listed above can decide this return.");
  }
  return { canDecide: true, reason: null };
}

// ── Who may open the Review screen ──────────────────────────────────────────
export interface ReviewAccessInput {
  isAdmin: boolean;
  me: { email?: string | null } | null; // null while the session is still loading
  loaded: boolean; // the live return loaded (a sample fallback is for admins only)
  approverEmails: readonly string[]; // of the live return
  routingError: boolean;
}

export interface ReviewAccess {
  allowed: boolean;
  reason: string | null; // one line, shown instead of the screen
}

/** Admins, and anyone who is one of the return's approvers (its Business Head or a
 *  standing deputy) — the person who raised it included, who then sees why they
 *  can't decide it. Everyone else is turned away with the reason. */
export function reviewAccess(i: ReviewAccessInput): ReviewAccess {
  if (i.isAdmin) return { allowed: true, reason: null };
  const deny = (reason: string): ReviewAccess => ({ allowed: false, reason });
  if (!i.loaded) return deny("This customer return couldn't be loaded. Reload to try again.");
  if (i.routingError) {
    return deny("The approver list couldn't be loaded, so your access to this review can't be checked. Reload to try again.");
  }
  const mine = norm(i.me?.email);
  if (mine && i.approverEmails.some((e) => norm(e) === mine)) return { allowed: true, reason: null };
  return deny("Only admins and this return's approvers — its Business Head and the deputy approvers — can open this review.");
}

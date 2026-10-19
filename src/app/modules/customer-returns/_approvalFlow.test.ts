// node src/app/modules/customer-returns/_approvalFlow.test.ts
import {
  crStatusLabel,
  decisionGate,
  isCrApproved,
  isUndecided,
  reviewAccess,
  sendErrorNotice,
  sendNoticeKey,
  sendOutcomeNotice,
  type DecisionGateInput,
  type ReviewAccessInput,
} from "./_approvalFlow.ts";
import type { CRSendForApprovalResponse } from "../../../lib/customer-returns.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); }
}

// ── statuses ────────────────────────────────────────────────────────────────
check("undecided: Pending, On Hold, and no status at all",
  ["Pending", "On Hold", null, undefined, ""].map(isUndecided), [true, true, true, true, true]);
check("decided: Approved, Submitted (approved + boxes saved), Rejected",
  ["Approved", "Submitted", "Rejected"].map(isUndecided), [false, false, false]);
check("status label: Submitted as approved and boxed, none as Pending, unknown as stored",
  ["Submitted", "Approved", "On Hold", null, "", "toString"].map(crStatusLabel),
  ["Approved · Boxed", "Approved", "On Hold", "Pending", "Pending", "toString"]);
check("a padded or blank status reads as the server reads it (spaces trimmed, blank = Pending)",
  [["  ", " Pending ", "On Hold  ", " Approved"].map(isUndecided), ["  ", " Submitted "].map(crStatusLabel)],
  [[true, true, true, false], ["Pending", "Approved · Boxed"]]);
check("approved includes approved and then boxed",
  ["Approved", "Submitted", "Pending", "On Hold", "Rejected", null].map(isCrApproved),
  [true, true, false, false, false, false]);

// ── send-for-approval notices ───────────────────────────────────────────────
const BH = { name: "Prashant Pal", email: "prashant.pal@candorfoods.in" };
const DEP = { name: "Satyendra Kumar Garg", email: "satyendra@candorfoods.in" };
const TO = [BH.email, DEP.email, "pooja.parkar@candorfoods.in"];

function res(over: Partial<CRSendForApprovalResponse> = {}): CRSendForApprovalResponse {
  return {
    status: "sent", approver: BH, approvers: [BH, DEP], to: TO, cc_count: 3,
    mail: { sent: true, to: TO, cc_count: 3, approvers_mailed: 2 },
    whatsapp: { status: "sent", sent: 2, failed: 0, recipients: [{ name: BH.name, sent: true }, { name: DEP.name, sent: true }] },
    ...over,
  };
}

check("everything sent is green and names who got it", sendOutcomeNotice(res()), {
  tone: "success",
  text: `Approval mail sent to ${TO.join(", ")} (+3 cc) · WhatsApp sent to 2 approvers.`,
});
check("WhatsApp not configured is still green — the mail carries the buttons",
  sendOutcomeNotice(res({ whatsapp: { status: "skipped", sent: 0, failed: 0, reason: "wa_disabled" } })), {
    tone: "success",
    text: `Approval mail sent to ${TO.join(", ")} (+3 cc) · WhatsApp skipped (WhatsApp isn't configured).`,
  });
check("no cc is not printed",
  sendOutcomeNotice(res({ mail: { sent: true, to: [BH.email], cc_count: 0, approvers_mailed: 1 } })).text
    .startsWith(`Approval mail sent to ${BH.email} · `), true);
check("mail sent but WhatsApp refused is amber, with the retry hint",
  sendOutcomeNotice(res({ status: "partial", whatsapp: { status: "failed", sent: 0, failed: 2, reason: "send_failed" } })), {
    tone: "warning",
    text: `Approval only partly sent — Approval mail sent to ${TO.join(", ")} (+3 cc) · WhatsApp NOT sent ` +
      "(WhatsApp refused the message). Use Send for approval to retry.",
  });
check("WhatsApp to some approvers is counted",
  sendOutcomeNotice(res({ status: "partial", whatsapp: { status: "partial", sent: 1, failed: 1, reason: "send_failed" } })).text
    .includes("WhatsApp sent to 1 of 2 approvers (WhatsApp refused the message)"), true);
check("a mail that reached some approvers names who it missed",
  sendOutcomeNotice(res({
    status: "partial",
    mail: { sent: false, to: TO, cc_count: 3, approvers_mailed: 1, reason: "smtp_error", failed: [DEP.email] },
  })).text.includes(`Approval mail sent to 1 of 2 approvers, not to ${DEP.email} (the mail server failed or refused it)`), true);
check("nothing reached an approver is red, with both reasons and the retry hint",
  sendOutcomeNotice(res({
    status: "failed",
    mail: { sent: false, to: TO, cc_count: 3, approvers_mailed: 0, reason: "smtp_not_configured", failed: TO },
    whatsapp: { status: "skipped", sent: 0, failed: 0, reason: "no_approver_phone" },
  })), {
    tone: "error",
    text: "Approval NOT sent: mail — the mail server isn't configured on the ERP server; WhatsApp — no approver " +
      "has a WhatsApp number on file. Use Send for approval to retry.",
  });
check("an unknown reason is shown as given",
  sendOutcomeNotice(res({
    status: "failed", mail: { sent: false, to: TO, cc_count: 3, approvers_mailed: 0, reason: "quota" },
    whatsapp: { status: "failed", sent: 0, failed: 2 },
  })).text, "Approval NOT sent: mail — quota; WhatsApp — unknown reason. Use Send for approval to retry.");
check("a return nobody can approve says so",
  sendOutcomeNotice(res({ status: "failed", reason: "no_approver", approver: null, approvers: [] })).text
    .startsWith("Approval NOT sent: nobody can approve this return"), true);
check("a return whose only approver raised it is red, not green, even though a notice mail went out",
  sendOutcomeNotice(res({
    status: "failed", reason: "only_creator", approvers: [],
    mail: { sent: true, to: ["pooja.parkar@candorfoods.in"], cc_count: 3, approvers_mailed: 0 },
    whatsapp: { status: "skipped", sent: 0, failed: 0, reason: "no_approver_phone" },
  })), {
    tone: "error",
    text: "Approval NOT sent: nobody else can approve this return: its only approver is the person who raised " +
      "it, and nobody decides their own return. Ask an admin to set up another approver (a deputy approver), " +
      "then use Send for approval.",
  });
check("a failed request is red with the retry hint", sendErrorNotice("Internal server error"), {
  tone: "error", text: "Approval NOT sent: Internal server error. Use Send for approval to retry.",
});
check("a refusal without the hint, and no doubled full stop",
  sendErrorNotice("CR-1 is already “Approved”, so it can't be sent for approval again.", false).text,
  "Approval NOT sent: CR-1 is already “Approved”, so it can't be sent for approval again.");
check("notice key", sendNoticeKey("CDPL", "CR-20261019103000"), "cr:send-notice:CDPL:CR-20261019103000");

// ── who may decide ──────────────────────────────────────────────────────────
const gate = (over: Partial<DecisionGateInput> = {}) => decisionGate({
  me: { email: BH.email }, createdBy: "warehouse.w202@candorfoods.in",
  approverEmails: [BH.email, DEP.email], status: "Pending", usingSample: false, routingError: false,
  readOnly: false, ...over,
});

check("the Business Head can decide", gate(), { canDecide: true, reason: null });
check("a deputy can decide, e-mail compared trimmed and case-insensitively",
  gate({ me: { email: "  SATYENDRA@candorfoods.in " }, status: "On Hold" }).canDecide, true);
check("an admin who is not an approver cannot", gate({ me: { email: "admin@candorfoods.in" } }), {
  canDecide: false, reason: "Only the Business Head or a deputy approver listed above can decide this return.",
});
check("the creator cannot, even as the Business Head", gate({ createdBy: " Prashant.Pal@CandorFoods.in" }), {
  canDecide: false, reason: "You raised this return, so another approver must decide it.",
});
check("an account without an e-mail cannot", gate({ me: { email: "" } }).reason,
  "Your account has no e-mail address, so it can't be matched to an approver.");
check("while the session loads", gate({ me: null }).canDecide, false);
check("nobody to decide", gate({ approverEmails: [] }).reason?.startsWith("Nobody can decide this return"), true);
check("decided returns offer nothing",
  ["Approved", "Submitted", "Rejected"].map((status) => gate({ status }).reason),
  ["This return is already “Approved”.", "This return is already “Approved · Boxed”.",
    "This return is already “Rejected”."]);
check("never on a sample shown because the live return failed to load",
  gate({ usingSample: true }).reason, "The live return couldn't be loaded, so decisions are off while a sample is shown.");
check("not without the approver list", gate({ routingError: true }).canDecide, false);
check("not while read-only", gate({ readOnly: true }).canDecide, false);

// ── who may open the Review screen ──────────────────────────────────────────
const access = (over: Partial<ReviewAccessInput> = {}) => reviewAccess({
  isAdmin: false, me: { email: DEP.email }, loaded: true, approverEmails: [BH.email, DEP.email],
  routingError: false, ...over,
});
check("a deputy who is not an admin opens it", access(), { allowed: true, reason: null });
check("so does the Business Head, e-mail compared trimmed and case-insensitively",
  access({ me: { email: " Prashant.Pal@CandorFoods.in " } }).allowed, true);
check("an admin always does — also on the sample shown when the live return failed",
  [access({ isAdmin: true, me: { email: "admin@candorfoods.in" } }), access({ isAdmin: true, loaded: false })]
    .map((a) => a.allowed), [true, true]);
check("anyone else is turned away with who it is for", access({ me: { email: "stores@candorfoods.in" } }), {
  allowed: false,
  reason: "Only admins and this return's approvers — its Business Head and the deputy approvers — can open this review.",
});
check("an account without an e-mail is turned away", access({ me: { email: "" } }).allowed, false);
check("a non-admin never gets the sample: a failed load is said so",
  access({ loaded: false }).reason, "This customer return couldn't be loaded. Reload to try again.");
check("without the approver list a non-admin can't be checked, so is not let in",
  access({ routingError: true }).allowed, false);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("customer-returns approval flow: all passed");

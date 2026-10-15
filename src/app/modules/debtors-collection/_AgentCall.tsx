"use client";

// The AI call inside the "Call now" sheet: one button that asks the Sarvam
// Collections agent to ring the party, then follows the call until it ends.
//
// Placing the call is one request; the result arrives at the backend later,
// from Sarvam. So after the call is accepted this polls the call's status
// until it is no longer "initiated". Closing the sheet only stops the watching:
// the call carries on, and its conversation and summary are saved either way.

import { useEffect, useState } from "react";
import { formatAsOf, formatInr, type DpdParty, type DpdSectionKey } from "@/lib/debtors";
import { dispositionLabel, fetchCall, placeCall, type CallStatus, type CollectionCall, type PlacedCall } from "@/lib/debtor-calls";
import { PhoneIcon, Pill } from "./_ui";

const POLL_MS = 4000;

type Phase =
  | { at: "idle" }
  | { at: "placing" }
  | { at: "live"; placed: PlacedCall }
  | { at: "done"; placed: PlacedCall; call: CollectionCall }
  | { at: "error"; message: string };

const OUTCOME: Record<Exclude<CallStatus, "initiated">, string> = {
  connected: "Connected — the agent spoke to them",
  no_answer: "No answer",
  busy: "The line was busy",
  failed: "The call could not be placed",
  unknown: "No result came back for this call",
};

/** Mount with `key={party.id}` so each party starts from idle. */
export function AgentCall({
  section,
  party,
  dialable,
  onViewSummary,
}: {
  section: DpdSectionKey;
  party: DpdParty;
  /** The party has a number to ring; without one the button stays off. */
  dialable: boolean;
  onViewSummary: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const liveId = phase.at === "live" ? phase.placed.callId : null;

  // Follow the call until Sarvam reports how it ended. A failed poll is not the
  // end of the call — keep asking.
  useEffect(() => {
    if (!liveId) return;
    const ctrl = new AbortController();
    const timer = setInterval(() => {
      fetchCall(liveId, ctrl.signal)
        .then((call) => {
          if (call.status === "initiated") return;
          setPhase((p) => (p.at === "live" && p.placed.callId === liveId ? { at: "done", placed: p.placed, call } : p));
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [liveId]);

  async function start() {
    setPhase({ at: "placing" });
    try {
      setPhase({ at: "live", placed: await placeCall(section, party) });
    } catch (err) {
      setPhase({ at: "error", message: err instanceof Error ? err.message : "Couldn't start the call." });
    }
  }

  const placed = phase.at === "live" || phase.at === "done" ? phase.placed : null;
  const call = phase.at === "done" ? phase.call : null;
  const promised = call
    ? [call.promiseAmount !== null ? formatInr(call.promiseAmount) : null, formatAsOf(call.promiseDate) ? `by ${formatAsOf(call.promiseDate)}` : null]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <div className="rounded-md border border-[var(--aws-border)] px-3 py-3">
      <p className="text-[11px] font-medium text-[var(--text-secondary)]">AI agent call</p>

      {phase.at === "idle" || phase.at === "placing" || phase.at === "error" ? (
        <>
          <p className="mt-1 text-[12px] leading-[17px] text-[var(--text-secondary)]">
            The agent rings this party, talks through the overdue amount and saves the conversation and a summary.
          </p>
          {phase.at === "error" ? (
            <p role="alert" className="mt-2 text-[12px] text-[#b0280e]">{phase.message}</p>
          ) : null}
          <button
            type="button"
            onClick={start}
            disabled={!dialable || phase.at === "placing"}
            className="mt-2.5 inline-flex items-center gap-2 h-9 px-4 rounded-[2px] bg-[var(--aws-orange)] text-[13px] font-semibold text-white hover:bg-[var(--aws-orange-hover)] disabled:opacity-50 disabled:hover:bg-[var(--aws-orange)]"
          >
            <PhoneIcon className="w-4 h-4" />
            {phase.at === "placing" ? "Starting the call…" : phase.at === "error" ? "Try again" : "Call with AI agent"}
          </button>
          {!dialable ? (
            <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">Needs a phone number on file for this party.</p>
          ) : null}
        </>
      ) : null}

      {placed ? (
        <div aria-live="polite" className="mt-1.5">
          {placed.isTest ? (
            <p className="mb-1.5 text-[12px] text-[var(--text-secondary)]">
              <Pill>Test mode</Pill> This call rang the test phone{placed.dialedNumber ? ` (${placed.dialedNumber})` : ""}, not
              the customer.
            </p>
          ) : null}
          {call ? (
            <>
              <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                {OUTCOME[call.status === "initiated" ? "unknown" : call.status]}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--text-secondary)]">
                {call.disposition ? <Pill>{dispositionLabel(call.disposition)}</Pill> : null}
                {promised ? <span className="font-medium text-[var(--text-primary)]">Promised {promised}</span> : null}
                {call.durationSec !== null ? <span className="tabular-nums">{Math.round(call.durationSec)} sec</span> : null}
              </p>
              {call.failureReason ? (
                <p className="mt-1 text-[12px] text-[var(--text-secondary)] break-words">{call.failureReason}</p>
              ) : null}
              {call.status === "connected" ? (
                <button
                  type="button"
                  onClick={onViewSummary}
                  className="mt-2 text-[12px] font-medium text-[var(--aws-link)] hover:underline"
                >
                  View the summary and conversation
                </button>
              ) : null}
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <span aria-hidden className="inline-block w-2 h-2 rounded-full bg-[var(--aws-orange)] animate-pulse motion-reduce:animate-none" />
                Call in progress{placed.dialedNumber && !placed.isTest ? ` to ${placed.dialedNumber}` : ""}
              </p>
              <p className="mt-1 text-[12px] leading-[17px] text-[var(--text-secondary)]">
                This updates when the call ends. You can close this window: the conversation and summary are saved
                either way.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

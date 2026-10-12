"use client";

// The call summaries in a party's Summary sheet: what the Sarvam Collections
// agent noted after each call, newest first, each under the day the call was
// placed, with the conversation itself one click away. Any summary can be
// deleted — that removes the summary for good; the call and its conversation
// stay in the database.
//
// Deleting asks once, in place: these are the team's only record of what a
// customer said, and there is no undo.

import { useEffect, useState } from "react";
import { formatAsOf, formatInr } from "@/lib/debtors";
import {
  deleteCallSummary, dispositionLabel, fetchCall, fetchCallSummaries, type CallSummary, type ConversationTurn,
} from "@/lib/debtor-calls";
import { Pill } from "./_ui";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; items: CallSummary[] }
  | { status: "error"; message: string };

const H3 = "text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";
const LINK = "text-[12px] font-medium text-[var(--aws-link)] hover:underline disabled:opacity-50 disabled:no-underline";

/** "Promised ₹46,272 by 15 Oct 2026", or whichever half the agent got. */
function promiseText(s: CallSummary): string | null {
  const by = formatAsOf(s.promiseDate);
  if (s.promiseAmount !== null && by) return `Promised ${formatInr(s.promiseAmount)} by ${by}`;
  if (s.promiseAmount !== null) return `Promised ${formatInr(s.promiseAmount)}`;
  return by ? `Promised payment by ${by}` : null;
}

type TalkState =
  | { status: "closed" }
  | { status: "loading" }
  | { status: "ready"; turns: ConversationTurn[] }
  | { status: "error"; message: string };

/** The call behind a summary, turn by turn. Loaded only when opened: a
 *  conversation is long, and most are never read. */
function Conversation({ callId }: { callId: string }) {
  const [state, setState] = useState<TalkState>({ status: "closed" });

  async function open() {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", turns: (await fetchCall(callId)).conversation });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Couldn't load the conversation." });
    }
  }

  if (state.status === "closed" || state.status === "error") {
    return (
      <p className="mt-1.5 text-[12px]">
        <button type="button" onClick={open} className={LINK}>
          {state.status === "error" ? "Try again" : "Show conversation"}
        </button>
        {state.status === "error" ? <span role="alert" className="ml-2 text-[#b0280e]">{state.message}</span> : null}
      </p>
    );
  }
  if (state.status === "loading") return <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">Loading the conversation…</p>;
  return (
    <div className="mt-2 border-t border-[var(--surface-divider)] pt-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium text-[var(--text-secondary)]">Conversation</p>
        <button type="button" onClick={() => setState({ status: "closed" })} className={LINK}>
          Hide
        </button>
      </div>
      {state.turns.length === 0 ? (
        <p className="mt-1 text-[12px] text-[var(--text-secondary)]">No conversation was recorded for this call.</p>
      ) : (
        <ol className="mt-1 space-y-1.5">
          {state.turns.map((t, i) => (
            <li key={i} className="text-[12px] leading-[17px] text-[var(--text-primary)] break-words">
              <span className={`font-semibold ${t.role === "agent" ? "text-[var(--aws-orange)]" : "text-[var(--text-primary)]"}`}>
                {t.role === "agent" ? "Agent" : "Customer"}:
              </span>{" "}
              {t.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Mount with `key={partyKey}` so each party starts from its own load. */
export function CallSummaries({ partyKey }: { partyKey: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The entry whose Delete was pressed and is waiting for a yes.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchCallSummaries(partyKey, ctrl.signal)
      .then((items) => setState({ status: "ready", items }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Couldn't load the call summaries." });
      });
    return () => ctrl.abort();
  }, [partyKey, attempt]);

  function retry() {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }

  async function remove(id: string) {
    setDeleting(id);
    setDeleteError(null);
    try {
      await deleteCallSummary(partyKey, id);
      setState((s) => (s.status === "ready" ? { status: "ready", items: s.items.filter((i) => i.id !== id) } : s));
      setConfirming(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Couldn't delete the summary.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div>
      <h3 className={H3}>
        Call summaries{state.status === "ready" && state.items.length > 0 ? ` · ${state.items.length}` : ""}
      </h3>

      {state.status === "loading" ? (
        <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">Loading…</p>
      ) : state.status === "error" ? (
        <p role="alert" className="mt-1.5 text-[12px] text-[var(--text-secondary)]">
          {state.message}{" "}
          <button type="button" onClick={retry} className={LINK}>
            Try again
          </button>
        </p>
      ) : state.items.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]">
          No call summaries yet. One is added here each time the calling agent finishes a call with this party.
        </p>
      ) : (
        <ul role="list" className="mt-1.5 space-y-2">
          {state.items.map((s) => {
            const promise = promiseText(s);
            const asking = confirming === s.id;
            const busy = deleting === s.id;
            return (
              <li key={s.id} className="rounded-[2px] border border-[var(--surface-divider)] bg-[var(--surface-subtle)] px-2.5 py-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                    <span className="font-semibold tabular-nums text-[var(--text-primary)]">{formatAsOf(s.date) ?? s.date}</span>
                    <span className="tabular-nums text-[var(--text-muted)]">{s.at.slice(11, 16)}</span>
                    {s.disposition ? <Pill>{dispositionLabel(s.disposition)}</Pill> : null}
                    {s.isTest ? <Pill>Test call</Pill> : null}
                  </p>
                  {asking ? (
                    <span className="flex items-center gap-2 text-[12px]">
                      <span className="text-[var(--text-secondary)]">Delete this summary?</span>
                      <button type="button" disabled={busy} onClick={() => setConfirming(null)} className={LINK}>
                        Keep
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(s.id)}
                        className="h-6 px-2 rounded-[2px] bg-[#b0280e] text-[12px] font-semibold text-white hover:bg-[#8f1f0a] disabled:opacity-60"
                      >
                        {busy ? "Deleting…" : "Delete"}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null);
                        setConfirming(s.id);
                      }}
                      aria-label={`Delete the summary of ${formatAsOf(s.date) ?? s.date}`}
                      className="text-[12px] font-medium text-[var(--text-secondary)] hover:text-[#b0280e] hover:underline"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-[12px] leading-[18px] text-[var(--text-primary)] whitespace-pre-line break-words">{s.summary}</p>
                {promise ? <p className="mt-1 text-[12px] font-medium text-[var(--text-primary)]">{promise}</p> : null}
                <Conversation callId={s.id} />
                {asking && deleteError ? (
                  <p role="alert" className="mt-1 text-[12px] text-[#b0280e]">{deleteError}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

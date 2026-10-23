// Completing a batch / job card whose accounting doesn't balance. Admins and
// floor managers may complete it anyway with a typed reason; the server decides
// who may (it answers override_available) and records the reason as a remark on
// the card. Pure, so it is tested without a browser (job-card-override.test.ts).

/** The server's minimum (backend balance_override.MIN_REASON_LEN). */
export const MIN_REASON_LEN = 5;

/** The reason as typed (trimmed), or null when it says nothing. */
export function cleanReason(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  return text.length >= MIN_REASON_LEN ? text : null;
}

export type OverrideOffer = {
  code: string | null;
  message: string | null;
  /** The server says this user may complete it anyway. */
  overrideAvailable: boolean;
};

/** Read a refusal: either the error envelope ({error, message, details: {...}})
 *  or a completion_blocked object ({error, message, override_available}). */
export function readOverrideOffer(body: unknown): OverrideOffer {
  if (!body || typeof body !== "object") return { code: null, message: null, overrideAvailable: false };
  const b = body as Record<string, unknown>;
  const details = b.details && typeof b.details === "object" ? (b.details as Record<string, unknown>) : {};
  return {
    code: typeof b.error === "string" ? b.error : null,
    message: typeof b.message === "string" ? b.message : null,
    overrideAvailable: b.override_available === true || details.override_available === true,
  };
}

export function completeAnywayPrompt(message: string): string {
  return `${message}\n\nYou can complete it anyway. Type the reason (at least ${MIN_REASON_LEN} characters) — it is recorded on the job card:`;
}

// Shared hydration helper for the job-card and sample dashboards.
//
// Both dashboards list N records, then fetch a per-record detail to get the
// numbers they actually report on. That burst needs three things the plain
// apiFetch does not give it:
//
//   * A timeout. apiFetch has none, so one hung request would hold a
//     concurrency slot forever and the progress counter would stall at N-1
//     with no way to recover.
//   * A 403 short-circuit. The job-card accounting endpoint sits behind a
//     DIFFERENT permission from the list that produced the ids, so a user can
//     legitimately list 248 job cards and be refused all 248 details. That
//     must abort the burst and degrade the page once, not 248 times.
//   * A low concurrency cap. The API runs a single uvicorn worker whose
//     connection pool is shared with every other request, and each accounting
//     call issues several sequential queries. Three at a time is deliberate.

export const HYDRATE_CONCURRENCY = 3;
export const HYDRATE_TIMEOUT_MS = 20_000;

export interface HydrateResult<T> {
  ok: Map<number, T>;
  failed: number[];
  forbidden: boolean;   // 403 seen → caller drops to header-only, blanks metrics
}

/** Fetch a detail for every id, capped at HYDRATE_CONCURRENCY in flight.
 *
 *  `fetchOne` should throw Error("forbidden") on a 403 so the whole burst can
 *  stop. Any other failure is recorded in `failed` and the walk continues —
 *  a partial answer the caller can label is better than none, but the caller
 *  MUST label it rather than presenting a short total as complete. */
export async function hydrateAll<T>(
  ids: number[],
  fetchOne: (id: number, signal: AbortSignal) => Promise<T>,
  opts: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<HydrateResult<T>> {
  const ok = new Map<number, T>();
  const failed: number[] = [];
  let forbidden = false;
  let i = 0;
  let done = 0;

  const worker = async () => {
    while (i < ids.length && !forbidden && !opts.signal?.aborted) {
      const id = ids[i++];
      const timer = AbortSignal.timeout(HYDRATE_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer;
      try {
        ok.set(id, await fetchOne(id, signal));
      } catch (e) {
        if (e instanceof Error && e.message === "forbidden") forbidden = true;
        else failed.push(id);
      } finally {
        opts.onProgress?.(++done, ids.length);
      }
    }
  };

  await Promise.all(Array.from({ length: HYDRATE_CONCURRENCY }, worker));
  return { ok, failed, forbidden };
}

// What the job card page does when loading it fails. The page refreshes itself
// every 60 s and whenever the window regains focus, so on a shop floor with
// patchy Wi-Fi a refresh fails often — and replacing the page with an error
// screen then threw away everything the operator had typed. Once the card is on
// screen, a failed refresh keeps the page and retries; only a first load that
// fails, or a card that no longer exists, gets the error page.
// Pure, so it is tested without a browser (job-card-refresh.test.ts).

/** How long to wait before retrying a failed refresh (also retried at once
 *  when the browser reports the connection is back). */
export const REFRESH_RETRY_MS = 15_000;

export function refreshFailureView(o: { loadedBefore: boolean; notFound: boolean }): "error-page" | "keep-page" {
  return o.loadedBefore && !o.notFound ? "keep-page" : "error-page";
}

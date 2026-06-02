// Server-side multipart upload forwarder.
//
// WHY THIS EXISTS
// ───────────────
// In the deployed topology the web app is served over HTTPS while the
// FastAPI backend is a bare-IP HTTP origin. To dodge the browser's
// mixed-content block, the client talks to a same-origin relative `/api/*`
// URL and `next.config.ts` `rewrites` forwards it to the backend
// server-side (see resolveApiBase() in src/lib/auth.ts).
//
// That config-level rewrite proxy delivers JSON bodies fine (login works),
// but it does NOT deliver a `multipart/form-data` body + boundary intact —
// so FastAPI's `file: UploadFile = File(...)` parameter is never populated
// and the endpoint rejects the request with 422 Unprocessable Entity.
//
// The desktop (Electron) client never hits this: it POSTs the multipart
// upload DIRECTLY to the backend. This handler replicates that exact
// behaviour for the web app — it receives the upload same-origin (the
// browser → Next hop is lossless), then re-issues a fresh, well-formed
// multipart POST to the backend server→server (plain HTTP is fine here, no
// mixed-content exposure). Mirrors Next.js 16's "Backend for Frontend →
// Proxying to a backend" guidance.
//
// Kept in sync with next.config.ts: same env var, same prod fallback.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://65.0.86.156";

/**
 * Re-issue an inbound multipart upload to the backend with the body intact.
 *
 * @param request     the incoming Route Handler request (browser → Next)
 * @param backendPath backend path to forward to, e.g. "/api/v1/so/upload-so-book"
 */
export async function forwardUpload(
  request: Request,
  backendPath: string,
): Promise<Response> {
  // Re-parse the inbound multipart body. Handing the resulting FormData back
  // to fetch makes it serialise a brand-new multipart body with a matching
  // boundary — so we never depend on the inbound Content-Type/boundary
  // surviving any intermediate hop. File names are preserved on the File
  // entries, which the backend relies on (it validates the .xlsx extension).
  const formData = await request.formData();

  const headers: Record<string, string> = {};
  const auth = request.headers.get("authorization");
  if (auth) headers["Authorization"] = auth;
  // Deliberately NOT forwarding Content-Type: fetch derives
  // `multipart/form-data; boundary=…` from the FormData body itself. Setting
  // it here would desync the boundary from the re-serialised payload — the
  // very failure mode that breaks the config-level rewrite proxy.

  // Preserve any query string (e.g. a future ?entity=… param); the SO upload
  // endpoints take none, but this keeps the forwarder reusable.
  const search = new URL(request.url).search;

  const upstream = await fetch(`${API_PROXY_TARGET}${backendPath}${search}`, {
    method: "POST",
    headers,
    body: formData,
  });

  // Relay the backend response verbatim so the client's existing success /
  // error handling (which reads res.ok, res.status, and the JSON `detail`)
  // works unchanged.
  const body = await upstream.arrayBuffer();
  const out = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) out.set("content-type", contentType);
  return new Response(body, { status: upstream.status, headers: out });
}

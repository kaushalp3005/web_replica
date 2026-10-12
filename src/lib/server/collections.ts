// Server-side bridge to the collections backend (the Parties table, outbound
// calls, their conversations and summaries) — a different service from the ERP
// backend the rest of /api/* is proxied to.
//
// WHY THIS EXISTS
// ───────────────
// That backend takes one shared key (x-api-key) and cannot verify an ERP
// login: the ERP's JWT secret is not its to hold. So the browser never talks
// to it. It calls a Route Handler here, which:
//   1. checks the caller's ERP session by asking the ERP backend who they are,
//      and that they are an admin — Debtors Collection is an admin-only module;
//   2. adds the key from a server-only env var and forwards the request.
//
// Never give either variable a NEXT_PUBLIC_ name: that would ship the key to
// every browser. Set them in .env.local for dev and in the host's environment
// for deploys:
//   COLLECTIONS_API_URL   origin of the collections backend, no trailing path
//   COLLECTIONS_API_KEY   the key that backend expects in x-api-key

import type { MeResponse } from "@/lib/auth";
import { isAdminMe } from "@/lib/sample-roles";

// Kept in sync with next.config.ts: same env var, same prod fallback.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://65.0.86.156";
const COLLECTIONS_API_URL = (process.env.COLLECTIONS_API_URL ?? "").replace(/\/+$/, "");
const COLLECTIONS_API_KEY = process.env.COLLECTIONS_API_KEY ?? "";

function problem(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

/** The signed-in admin making the request, or the response to send instead. */
async function requireAdmin(request: Request): Promise<MeResponse | Response> {
  const auth = request.headers.get("authorization");
  if (!auth) return problem(401, "Sign in to continue.");
  let res: Response;
  try {
    res = await fetch(`${API_PROXY_TARGET}/api/v1/auth/me`, { headers: { Authorization: auth }, cache: "no-store" });
  } catch {
    return problem(502, "Couldn't check your sign-in. Try again.");
  }
  if (res.status === 401) return problem(401, "Your session has expired. Sign in again.");
  if (!res.ok) return problem(502, "Couldn't check your sign-in. Try again.");
  const me = (await res.json().catch(() => null)) as MeResponse | null;
  return me && isAdminMe(me) ? me : problem(403, "Only administrators can use Debtors Collection.");
}

/** Who to record as having placed a call: the verified sign-in, never
 *  something the browser claims. */
function actorOf(me: MeResponse): string {
  return me.email || me.full_name || me.phone || me.user_id || "unknown";
}

/**
 * Forward one request to the collections backend on behalf of a signed-in admin.
 *
 * @param request the incoming Route Handler request (browser → Next)
 * @param method  the backend method
 * @param path    path under /api/collections, e.g. "/parties/<id>/summaries";
 *                the caller encodes each segment
 * @param body    for POST: the JSON to send. It is given `initiated_by` here,
 *                from the verified sign-in, overriding whatever it carried.
 */
export async function forwardCollections(
  request: Request,
  method: "GET" | "DELETE" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const me = await requireAdmin(request);
  if (me instanceof Response) return me;
  if (!COLLECTIONS_API_URL || !COLLECTIONS_API_KEY) {
    return problem(503, "The collections service is not set up on this server yet (COLLECTIONS_API_URL, COLLECTIONS_API_KEY).");
  }
  const headers: Record<string, string> = { "x-api-key": COLLECTIONS_API_KEY };
  if (body) headers["content-type"] = "application/json";
  let upstream: Response;
  try {
    upstream = await fetch(`${COLLECTIONS_API_URL}/api/collections${path}`, {
      method,
      headers,
      body: body ? JSON.stringify({ ...body, initiated_by: actorOf(me) }) : undefined,
      cache: "no-store",
    });
  } catch {
    return problem(502, "Couldn't reach the collections service. Try again.");
  }
  // Relay status and JSON as they are; the client reads `detail` on errors.
  const reply = await upstream.arrayBuffer();
  const out = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) out.set("content-type", contentType);
  return new Response(reply, { status: upstream.status, headers: out });
}

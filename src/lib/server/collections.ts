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
//      and that they hold the debtors_collection permission the request needs
//      (view, call, edit, export, upload or delete — see lib/debtors-access;
//      admins hold them all);
//   2. adds the key from a server-only env var and forwards the request.
//
// Never give either variable a NEXT_PUBLIC_ name: that would ship the key to
// every browser. Set them in .env.local for dev and in the host's environment
// for deploys:
//   COLLECTIONS_API_URL   origin of the collections backend, no trailing path
//   COLLECTIONS_API_KEY   the key that backend expects in x-api-key

import type { MeResponse } from "@/lib/auth";
import { mayDebtors, type DebtorsAction } from "@/lib/debtors-access";

// Kept in sync with next.config.ts: same env var, same prod fallback.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://65.0.86.156";
const COLLECTIONS_API_URL = (process.env.COLLECTIONS_API_URL ?? "").replace(/\/+$/, "");
const COLLECTIONS_API_KEY = process.env.COLLECTIONS_API_KEY ?? "";

function problem(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

const REFUSED: Record<DebtorsAction, string> = {
  view: "You don't have access to Debtors Collection.",
  call: "You can't place calls in Debtors Collection.",
  edit: "You can't change parties in Debtors Collection.",
  export: "You can't export from Debtors Collection.",
  upload: "You can't upload to Debtors Collection.",
  delete: "You can't delete call summaries.",
};

/** The signed-in user making the request, if they may take `action`, or the
 *  response to send instead. */
async function requireAccess(request: Request, action: DebtorsAction): Promise<MeResponse | Response> {
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
  return me && mayDebtors(me, action) ? me : problem(403, `${REFUSED[action]} Ask an administrator for access.`);
}

/** Who to record as having placed a call: the verified sign-in, never
 *  something the browser claims. */
function actorOf(me: MeResponse): string {
  return me.email || me.full_name || me.phone || me.user_id || "unknown";
}

/**
 * Forward one request to the collections backend on behalf of a signed-in user
 * who may take `action`.
 *
 * @param request the incoming Route Handler request (browser → Next)
 * @param action  the debtors_collection permission the request needs
 * @param method  the backend method
 * @param path    path under /api/collections, e.g. "/parties/<id>/summaries";
 *                the caller encodes each segment
 * @param body    for POST and PUT: the JSON to send. It is stamped here with
 *                who is doing it (`actorField`), from the verified sign-in,
 *                overriding whatever the browser put there.
 * @param actorField  the backend's name for that: who placed a call, or who
 *                changed a value.
 */
export async function forwardCollections(
  request: Request,
  action: DebtorsAction,
  method: "GET" | "DELETE" | "POST" | "PUT",
  path: string,
  body?: Record<string, unknown>,
  actorField: "initiated_by" | "updated_by" = "initiated_by",
): Promise<Response> {
  const me = await requireAccess(request, action);
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
      body: body ? JSON.stringify({ ...body, [actorField]: actorOf(me) }) : undefined,
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

/**
 * Forward an upload (multipart form) to the collections backend on behalf of a
 * signed-in user who may upload — both steps, the preview as well as the apply,
 * need debtors_collection.upload. The form is rebuilt here, so only the expected fields go on,
 * and it is stamped with who is uploading (`uploaded_by`) from the verified
 * sign-in.
 *
 * @param path   path under /api/collections, e.g. "/dpd-upload/preview"
 * @param fields the text fields to send
 * @param files  the files to send, by field name
 */
export async function forwardCollectionsUpload(
  request: Request,
  path: string,
  fields: Record<string, string>,
  files: Record<string, File>,
): Promise<Response> {
  const me = await requireAccess(request, "upload");
  if (me instanceof Response) return me;
  if (!COLLECTIONS_API_URL || !COLLECTIONS_API_KEY) {
    return problem(503, "The collections service is not set up on this server yet (COLLECTIONS_API_URL, COLLECTIONS_API_KEY).");
  }
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  form.set("uploaded_by", actorOf(me));
  for (const [name, file] of Object.entries(files)) form.set(name, file, file.name);
  let upstream: Response;
  try {
    // No Content-Type: fetch writes multipart/form-data with its own boundary.
    upstream = await fetch(`${COLLECTIONS_API_URL}/api/collections${path}`, {
      method: "POST",
      headers: { "x-api-key": COLLECTIONS_API_KEY },
      body: form,
      cache: "no-store",
    });
  } catch {
    return problem(502, "Couldn't reach the collections service. Try again.");
  }
  const reply = await upstream.arrayBuffer();
  const out = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) out.set("content-type", contentType);
  return new Response(reply, { status: upstream.status, headers: out });
}

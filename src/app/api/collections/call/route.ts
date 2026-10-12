import { forwardCollections } from "@/lib/server/collections";

// One collection call, placed by the Sarvam Collections agent:
//
//   POST /api/collections/call?party=<party key>   place it; the body is the party
//   GET  /api/collections/call?id=<call id>        its status, outcome and conversation
//
// The ids travel in the query string, not the path, ON PURPOSE: the catch-all
// `/api/:path*` rewrite in next.config.ts wins over dynamic route segments and
// would send the request to the ERP backend. See forwardCollections() for the
// rest — including who the call is recorded as placed by.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const missing = (what: string) => Response.json({ detail: `${what} is required.` }, { status: 400 });

export async function POST(request: Request): Promise<Response> {
  const party = new URL(request.url).searchParams.get("party")?.trim();
  if (!party) return missing("party");
  const body: unknown = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return missing("The party's details");
  return forwardCollections(request, "POST", `/parties/${encodeURIComponent(party)}/call`, body as Record<string, unknown>);
}

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return missing("id");
  return forwardCollections(request, "GET", `/calls/${encodeURIComponent(id)}`);
}

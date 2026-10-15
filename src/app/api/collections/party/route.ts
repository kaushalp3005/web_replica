import { forwardCollections } from "@/lib/server/collections";

// One row of the Parties table, edited on the screen:
//
//   PUT /api/collections/party?party=<party id>   body: the columns that changed
//
// Only the columns sent are changed. The party travels in the query string,
// not the path, ON PURPOSE: the catch-all `/api/:path*` rewrite in
// next.config.ts wins over dynamic route segments and would send the request
// to the ERP backend. See forwardCollections() for the rest — including who
// the edit is logged as.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const missing = (what: string) => Response.json({ detail: `${what} is required.` }, { status: 400 });

export async function PUT(request: Request): Promise<Response> {
  const party = new URL(request.url).searchParams.get("party")?.trim();
  if (!party) return missing("party");
  const body: unknown = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return missing("The changes");
  return forwardCollections(request, "PUT", `/parties/${encodeURIComponent(party)}`, body as Record<string, unknown>, "updated_by");
}

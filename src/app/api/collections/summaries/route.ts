import { forwardCollections } from "@/lib/server/collections";

// A party's call summaries — what the Sarvam Collections agent noted after
// each call:
//
//   GET    /api/collections/summaries?party=<party key>           newest first
//   DELETE /api/collections/summaries?party=<party key>&id=<id>   remove one
//
// The party travels in the query string, not the path, ON PURPOSE. The
// catch-all `/api/:path*` rewrite in next.config.ts is an afterFiles rewrite:
// it loses to a route made of static segments but WINS over a dynamic one, so
// `/api/collections/parties/[partyId]/…` would be proxied to the ERP backend
// and never reach this handler. See forwardCollections() for the rest.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function partyPath(request: Request): string | null {
  const party = new URL(request.url).searchParams.get("party")?.trim();
  return party ? `/parties/${encodeURIComponent(party)}/summaries` : null;
}

const missing = (what: string) => Response.json({ detail: `${what} is required.` }, { status: 400 });

export async function GET(request: Request): Promise<Response> {
  const path = partyPath(request);
  if (!path) return missing("party");
  return forwardCollections(request, "GET", path);
}

export async function DELETE(request: Request): Promise<Response> {
  const path = partyPath(request);
  if (!path) return missing("party");
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return missing("id");
  return forwardCollections(request, "DELETE", `${path}/${encodeURIComponent(id)}`);
}

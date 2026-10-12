import { forwardCollections } from "@/lib/server/collections";

// The Parties table for one section, from the collections backend's database:
//
//   GET /api/collections/parties?section=cd-cf | apmc
//
// A static path ON PURPOSE: the catch-all `/api/:path*` rewrite in
// next.config.ts wins over dynamic route segments and would send the request
// to the ERP backend. See forwardCollections() for the rest.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const section = new URL(request.url).searchParams.get("section")?.trim();
  if (!section) return Response.json({ detail: "section is required." }, { status: 400 });
  return forwardCollections(request, "GET", `/parties?section=${encodeURIComponent(section)}`);
}

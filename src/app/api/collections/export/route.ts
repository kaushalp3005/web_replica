import { forwardCollections } from "@/lib/server/collections";

// One tab's Parties table with each party's call summaries and calls (outcome
// and conversation), for the Excel export:
//
//   GET /api/collections/export?section=cd-cf | apmc
//
// A static path ON PURPOSE — see the other collections routes.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const section = new URL(request.url).searchParams.get("section")?.trim();
  if (!section) return Response.json({ detail: "section is required." }, { status: 400 });
  return forwardCollections(request, "GET", `/export?section=${encodeURIComponent(section)}`);
}

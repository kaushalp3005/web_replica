import { forwardCollections } from "@/lib/server/collections";

// A party's contact number — the one the Sarvam Collections agent calls:
//
//   PUT /api/collections/contact?party=<party key>   body: { "contact_number": "…" }
//
// Blank clears it. The party travels in the query string, not the path, ON
// PURPOSE: the catch-all `/api/:path*` rewrite in next.config.ts wins over
// dynamic route segments and would send the request to the ERP backend. See
// forwardCollections() for the rest — including who the change is logged as.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const missing = (what: string) => Response.json({ detail: `${what} is required.` }, { status: 400 });

export async function PUT(request: Request): Promise<Response> {
  const party = new URL(request.url).searchParams.get("party")?.trim();
  if (!party) return missing("party");
  const body: unknown = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return missing("contact_number");
  const number = (body as Record<string, unknown>).contact_number;
  return forwardCollections(
    request,
    "PUT",
    `/parties/${encodeURIComponent(party)}/contact-number`,
    { contact_number: typeof number === "string" ? number : null },
    "updated_by",
  );
}

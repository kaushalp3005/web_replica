import { forwardCollectionsUpload } from "@/lib/server/collections";

// Tally's raw "Group Outstandings" export, uploaded to replace a section's DPD:
//
//   POST /api/collections/upload?step=preview   what the files would change; writes nothing
//   POST /api/collections/upload?step=apply     replace the DPD; `include` lists the new customers to add
//
// Form fields: section ("cd-cf" | "apmc"); the files cf_file and/or cd_file,
// for either tab; include (JSON list, apply only).
// A static path ON PURPOSE — see the other collections routes — and the step
// in the query string for the same reason.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE_FIELDS = ["cf_file", "cd_file"] as const;
const bad = (detail: string) => Response.json({ detail }, { status: 400 });

export async function POST(request: Request): Promise<Response> {
  const step = new URL(request.url).searchParams.get("step");
  if (step !== "preview" && step !== "apply") return bad("step must be preview or apply.");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("The upload could not be read. Choose the files again.");
  }
  const section = form.get("section");
  if (section !== "cd-cf" && section !== "apmc") return bad("section must be cd-cf or apmc.");
  const fields: Record<string, string> = { section };
  if (step === "apply") fields.include = String(form.get("include") ?? "[]");
  const files: Record<string, File> = {};
  for (const name of FILE_FIELDS) {
    const value = form.get(name);
    if (value instanceof File && value.size > 0) files[name] = value;
  }
  return forwardCollectionsUpload(request, `/dpd-upload/${step}`, fields, files);
}

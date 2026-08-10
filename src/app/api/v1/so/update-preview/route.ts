import { forwardUpload } from "@/lib/server/forward-upload";

// Same-origin proxy for the "Update SO via Excel" preview upload.
//
// The client (src/lib/so.ts → previewSoUpdate) POSTs a multipart/form-data
// file to the relative `/api/v1/so/update-preview`. Without this handler the
// upload falls through to the catch-all `rewrites` proxy in next.config.ts,
// which mangles the multipart body and makes FastAPI return 422. A
// static-segment Route Handler is matched BEFORE the array-form
// (`afterFiles`) rewrite, so this intercepts only the upload and forwards an
// intact multipart POST to the backend server-side — exactly what the desktop
// client does with its direct call. See forwardUpload() for the full why.

// Per-request execution on the Node.js runtime: this handler buffers a
// multipart upload and must never be statically optimised or run on the
// size-limited Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return forwardUpload(request, "/api/v1/so/update-preview");
}

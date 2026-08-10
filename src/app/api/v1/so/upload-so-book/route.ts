import { forwardUpload } from "@/lib/server/forward-upload";

// Same-origin proxy for the SO Book upload.
//
// The client (src/lib/so.ts → uploadSoBook) POSTs a multipart/form-data file
// to the relative `/api/v1/so/upload-so-book`. In the deployed topology that
// relative URL would otherwise fall through to the catch-all `rewrites` proxy
// in next.config.ts, which mangles the multipart body and makes FastAPI
// return 422. A static-segment Route Handler is matched BEFORE the array-form
// (`afterFiles`) rewrite, so this intercepts only the upload and forwards an
// intact multipart POST to the backend server-side — exactly what the desktop
// client does with its direct call.

// Per-request execution on the Node.js runtime: this handler buffers a
// multipart upload and must never be statically optimised or run on the
// size-limited Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return forwardUpload(request, "/api/v1/so/upload-so-book");
}

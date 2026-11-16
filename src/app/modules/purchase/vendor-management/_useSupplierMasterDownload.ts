"use client";

// Vendor Management · "Download Excel" hook — the vendor master export, shared
// by the hub card (page.tsx) and the Existing Vendors header button
// (existing/page.tsx) so both use the same wording and the same repeat-click
// guard.
//
//   GET /api/v1/vendors/export — whole vendor master as .xlsx. Needs
//                                vendor/master/view AND vendor/banking/view.
//
// download() never throws: it settles to { ok, message } and the calling page
// decides where the message is shown.

import { useCallback, useRef, useState } from "react";
import { downloadSupplierMasterExcel, VendorApiError } from "@/lib/vendor";

export type SupplierMasterDownloadResult = { ok: true; message: string } | { ok: false; message: string };

const FORBIDDEN_MSG =
  "You don't have permission to download the vendor master. It needs view access to vendors and their banking details.";
const GENERIC_MSG = "Couldn't download the vendor master. Please try again.";

export function useSupplierMasterDownload(): {
  downloading: boolean;
  download: () => Promise<SupplierMasterDownloadResult>;
} {
  const [downloading, setDownloading] = useState(false);
  // The in-flight guard is a ref, not the `downloading` state: a second click
  // can land before the re-render that disables the button, and reading state
  // here would change `download`'s identity on every toggle. The ref holds the
  // running promise, so a repeat call starts nothing new and simply settles
  // with the first call's result.
  const inFlight = useRef<Promise<SupplierMasterDownloadResult> | null>(null);

  const download = useCallback((): Promise<SupplierMasterDownloadResult> => {
    if (inFlight.current) return inFlight.current;
    setDownloading(true);
    const run = (async (): Promise<SupplierMasterDownloadResult> => {
      try {
        const { rows, filename } = await downloadSupplierMasterExcel();
        // rows is 0 (or NaN) when X-Total-Rows did not come through — leave the
        // count out rather than report "0 vendors" for a file that has rows.
        return {
          ok: true,
          message: rows > 0
            ? `Downloaded ${filename} — ${rows} vendor${rows === 1 ? "" : "s"}.`
            : `Downloaded ${filename}.`,
        };
      } catch (err) {
        if (err instanceof VendorApiError) {
          return { ok: false, message: err.status === 403 ? FORBIDDEN_MSG : err.message };
        }
        return { ok: false, message: GENERIC_MSG };
      } finally {
        inFlight.current = null;
        setDownloading(false);
      }
    })();
    inFlight.current = run;
    return run;
  }, []);

  return { downloading, download };
}

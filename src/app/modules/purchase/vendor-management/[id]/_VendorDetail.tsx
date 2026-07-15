"use client";

// Vendor Detail — main client component. Loads the nested GET /{id} payload plus
// the 9 lookup bundles, renders the header card (Edit / Approve / Delete), the
// 5-tab bar, the Overview pane, and hosts the edit modal, toast and confirm
// modal. Banking/Documents/Contracts/History live in their own co-located files.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useHasRole, useMe } from "@/lib/user";
import { BackLink } from "@/components/BackLink";
import {
  approveVendor,
  deleteVendor,
  getLookupBundle,
  getLookupLabel,
  getVendor,
  VendorApiError,
  type LookupRow,
  type VendorDetailResponse,
  type VendorResponse,
} from "@/lib/vendor";
import {
  ApprovalBadge,
  asId,
  asStr,
  CARD_CLS,
  errMsg,
  fmtDate,
  GHOST_BTN,
  InfoCard,
  InfoRow,
  PRIMARY_BTN,
  SECONDARY_BTN,
  StatusBadge,
  Toast,
  useConfirm,
  useToast,
} from "./_shared";
import { EditVendorModal } from "./_EditVendorModal";
import { BankingTab } from "./_BankingTab";
import { DocumentsTab } from "./_DocumentsTab";
import { ContractsTab } from "./_ContractsTab";
import { HistoryTab } from "./_HistoryTab";

const EXISTING_HREF = "/modules/purchase/vendor-management/existing";

// The 9 lookup types this screen consumes (spec §1).
const LOOKUP_TYPES = [
  "CATEGORY_CODE",
  "SUPPLIER_TYPE",
  "FIRM_STATUS",
  "BUSINESS_TYPE",
  "LOCAL_OS",
  "MSME_TYPE",
  "KYC_STATUS",
  "DOC_STATUS",
  "ACCOUNT_TYPE",
] as const;

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "banking", label: "Banking" },
  { key: "documents", label: "Documents" },
  { key: "contracts", label: "Contracts" },
  { key: "history", label: "History" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

interface LoadError {
  msg: string;
  code: string | null;
  status: number | null;
}

function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    const s = asStr(v).trim();
    if (s) return s;
  }
  return "—";
}

function composeAddress(v: VendorResponse): string {
  return [v.address_line, v.city, v.state, v.pin_code]
    .map((x) => asStr(x).trim())
    .filter(Boolean)
    .join(", ");
}

export function VendorDetail({ vendorId }: { vendorId: string }): React.JSX.Element {
  const router = useRouter();
  const me = useMe();
  const canManage = useHasRole("purchase_manager");

  const { toast, showToast, clearToast } = useToast();
  const { confirm, confirmElement } = useConfirm();

  const [detail, setDetail] = useState<VendorDetailResponse | null>(null);
  const [lookups, setLookups] = useState<Record<string, LookupRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<LoadError | null>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [dataVersion, setDataVersion] = useState(0); // bumped to remount tabs after a revert
  const [historyNonce, setHistoryNonce] = useState(0); // signals History to reload after an edit
  const [editOpen, setEditOpen] = useState(false);
  const [headerBusy, setHeaderBusy] = useState(false);

  // Full re-fetch of the nested payload (used after a revert). Remounts the tab
  // panes so their seeded lists reflect the fresh server state.
  const reloadVendor = useCallback(async () => {
    const d = await getVendor(vendorId);
    setDetail(d);
    setDataVersion((v) => v + 1);
  }, [vendorId]);

  // Boot: resolve id, then load vendor + lookups in parallel. Runs once the
  // role gate is known (canManage flips true after /me resolves).
  useEffect(() => {
    if (!canManage) return;
    if (!vendorId) {
      showToast("No vendor selected", "error");
      const t = setTimeout(() => router.push(EXISTING_HREF), 1200);
      return () => clearTimeout(t);
    }
    let live = true;
    (async () => {
      setLoading(true);
      setLoadErr(null);
      try {
        const [d, lk] = await Promise.all([getVendor(vendorId), getLookupBundle([...LOOKUP_TYPES])]);
        if (!live) return;
        setDetail(d);
        setLookups(lk);
      } catch (e) {
        if (!live) return;
        setLoadErr({
          msg: errMsg(e, "Failed to load vendor"),
          code: e instanceof VendorApiError ? e.code : null,
          status: e instanceof VendorApiError ? e.status : null,
        });
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [vendorId, canManage, router, showToast]);

  // ── Header actions ─────────────────────────────────────────────────────────

  async function handleApprove() {
    const ok = await confirm({
      title: "Approve vendor",
      message: "Approve this vendor for purchase? Backend pre-conditions: KYC complete + ≥1 active primary banking row.",
      confirmLabel: "Approve",
    });
    if (!ok) return;
    setHeaderBusy(true);
    try {
      const updated = await approveVendor(vendorId);
      setDetail((d) => (d ? { ...d, vendor: updated } : d));
      showToast("Vendor approved", "ok");
      if (activeTab === "history") setHistoryNonce((n) => n + 1);
    } catch (e) {
      const code = e instanceof VendorApiError ? e.code : null;
      if (code === "kyc_incomplete") showToast("Can't approve — KYC fields are incomplete.", "error");
      else if (code === "no_primary_bank") showToast("Can't approve — no active primary banking row.", "error");
      else showToast(`Couldn't approve — ${errMsg(e, "unknown error")}`, "error");
    } finally {
      setHeaderBusy(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete vendor",
      message: "Delete this vendor? This soft-deletes the row.",
      danger: true,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setHeaderBusy(true);
    try {
      await deleteVendor(vendorId);
      showToast("Vendor deleted", "ok");
      setTimeout(() => router.push(EXISTING_HREF), 800);
    } catch (e) {
      showToast(`Couldn't delete — ${errMsg(e, "unknown error")}`, "error");
      setHeaderBusy(false);
    }
  }

  // ── Gates ──────────────────────────────────────────────────────────────────

  if (me === null) {
    // Auth/session still resolving — hold the paint (avoids an access-denied flash).
    return (
      <div className={`${CARD_CLS} p-10 text-center text-[var(--text-secondary)]`}>
        <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div>
        <div className="mb-3">
          <BackLink parentHref={EXISTING_HREF} label="vendors" />
        </div>
        <div className={`${CARD_CLS} p-10 text-center`}>
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">Access denied</div>
          <div className="text-[13px] text-[var(--text-secondary)] mt-1">
            You don&rsquo;t have permission to manage vendors.
          </div>
        </div>
      </div>
    );
  }

  const vendor = detail?.vendor ?? null;

  return (
    <div>
      <div className="mb-3">
        <BackLink parentHref={EXISTING_HREF} label="vendors" />
      </div>

      {loading ? (
        <div className={`${CARD_CLS} p-10 text-center text-[var(--text-secondary)]`}>
          <span className="inline-flex items-center gap-2">
            <span className="inline-block w-4 h-4 border-2 border-[var(--aws-border-strong)] border-t-[var(--aws-orange)] rounded-full animate-spin" />
            Loading vendor…
          </span>
        </div>
      ) : loadErr ? (
        <LoadErrorCard err={loadErr} onBack={() => router.push(EXISTING_HREF)} />
      ) : vendor ? (
        <>
          <HeaderCard
            vendor={vendor}
            lookups={lookups}
            headerBusy={headerBusy}
            onEdit={() => setEditOpen(true)}
            onApprove={() => void handleApprove()}
            onDelete={() => void handleDelete()}
          />

          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-[var(--aws-border)] mb-4 mt-5 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`h-9 px-3 text-[13px] font-medium border-b-2 -mb-px whitespace-nowrap ${
                  activeTab === t.key
                    ? "border-[var(--aws-navy)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Panes — kept mounted so per-tab filter/modal state survives switches. */}
          <div hidden={activeTab !== "overview"}>
            <OverviewPane vendor={vendor} lookups={lookups} />
          </div>
          <div hidden={activeTab !== "banking"}>
            <BankingTab
              key={`bank-${dataVersion}`}
              vendorId={vendorId}
              initial={detail?.banking ?? []}
              lookups={lookups}
              showToast={showToast}
              confirm={confirm}
            />
          </div>
          <div hidden={activeTab !== "documents"}>
            <DocumentsTab
              key={`doc-${dataVersion}`}
              vendorId={vendorId}
              initial={detail?.documents ?? []}
              lookups={lookups}
              showToast={showToast}
              confirm={confirm}
            />
          </div>
          <div hidden={activeTab !== "contracts"}>
            <ContractsTab
              key={`ctr-${dataVersion}`}
              vendorId={vendorId}
              initial={detail?.contracts ?? []}
              showToast={showToast}
              confirm={confirm}
            />
          </div>
          <div hidden={activeTab !== "history"}>
            <HistoryTab
              vendorId={vendorId}
              active={activeTab === "history"}
              reloadNonce={historyNonce}
              showToast={showToast}
              onReloadVendor={reloadVendor}
            />
          </div>

          {editOpen && (
            <EditVendorModal
              vendorId={vendorId}
              vendor={vendor}
              lookups={lookups}
              onClose={() => setEditOpen(false)}
              onSaved={(updated) => {
                setDetail((d) => (d ? { ...d, vendor: updated } : d));
                if (activeTab === "history") setHistoryNonce((n) => n + 1);
              }}
              showToast={showToast}
            />
          )}
        </>
      ) : null}

      {confirmElement}
      <Toast toast={toast} onClose={clearToast} />
    </div>
  );
}

// ── Load-error card (404 / forbidden / generic) ──────────────────────────────

function LoadErrorCard({ err, onBack }: { err: LoadError; onBack: () => void }): React.JSX.Element {
  const notFound = err.code === "vendor_not_found" || err.status === 404;
  const forbidden = err.code === "forbidden";
  return (
    <div className={`${CARD_CLS} p-10 text-center`}>
      {notFound ? (
        <>
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">Vendor not found</div>
          <div className="text-[13px] text-[var(--text-secondary)] mt-1">It may have been deleted.</div>
          <button type="button" onClick={onBack} className={`${GHOST_BTN} mt-3`}>
            Go back to list
          </button>
        </>
      ) : forbidden ? (
        <>
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">Access denied</div>
          <div className="text-[13px] text-[var(--text-secondary)] mt-1">You don&rsquo;t have permission to view this vendor.</div>
        </>
      ) : (
        <>
          <div className="text-[15px] font-semibold text-[var(--text-primary)]">Couldn&rsquo;t load vendor</div>
          <div className="text-[13px] text-[var(--aws-error)] mt-1">{err.msg}</div>
        </>
      )}
    </div>
  );
}

// ── Header card ──────────────────────────────────────────────────────────────

function HeaderCard({
  vendor,
  lookups,
  headerBusy,
  onEdit,
  onApprove,
  onDelete,
}: {
  vendor: VendorResponse;
  lookups: Record<string, LookupRow[]>;
  headerBusy: boolean;
  onEdit: () => void;
  onApprove: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const name = vendor.name || "—";
  const initial = (vendor.name || "V").charAt(0).toUpperCase();
  const category = getLookupLabel(lookups.CATEGORY_CODE ?? [], asId(vendor.category_code_id)) || "—";
  const contact = firstNonEmpty(vendor.contact_person, vendor.mobile, vendor.email);
  const approved = !!vendor.approved_at;
  const showApprove = !approved && vendor.status !== "blacklisted";

  return (
    <div className={`${CARD_CLS} p-4`}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="w-11 h-11 shrink-0 rounded-full bg-[var(--aws-navy)] text-white text-[18px] font-bold flex items-center justify-center">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[18px] leading-[24px] font-semibold text-[var(--text-primary)] truncate">{name}</h1>
            <StatusBadge status={vendor.status} />
            <ApprovalBadge approvedAt={vendor.approved_at} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[12px] text-[var(--text-secondary)]">
            <span>
              Code <span className="font-mono text-[var(--text-primary)]">{asStr(vendor.supplier_code) || "—"}</span>
            </span>
            <span>{category}</span>
            <span className="truncate" title={contact}>{contact}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={SECONDARY_BTN} onClick={onEdit} disabled={headerBusy}>
            Edit basics
          </button>
          {showApprove && (
            <button type="button" className={PRIMARY_BTN} onClick={onApprove} disabled={headerBusy}>
              Approve
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={headerBusy}
            className="h-8 px-4 text-[13px] rounded-[2px] border border-[#f5c6bc] text-[var(--aws-error)] bg-white hover:bg-[#fdf3f1] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Overview pane (6 cards, ~41 fields) ──────────────────────────────────────

function OverviewPane({
  vendor,
  lookups,
}: {
  vendor: VendorResponse;
  lookups: Record<string, LookupRow[]>;
}): React.JSX.Element {
  const lk = (type: string) => lookups[type] ?? [];
  const label = (type: string, id: unknown) => getLookupLabel(lk(type), asId(id));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* Card 1 — Identity */}
      <InfoCard title="Identity">
        <InfoRow label="Name" value={vendor.name} />
        <InfoRow label="Supplier code" value={vendor.supplier_code} mono />
        <InfoRow label="Reg year" value={vendor.supplier_reg_year} />
        <InfoRow label="Status" value={vendor.status} />
        <InfoRow label="Supplier type" value={label("SUPPLIER_TYPE", vendor.supplier_type_id)} />
        <InfoRow label="Firm status" value={label("FIRM_STATUS", vendor.firm_status_id)} />
        <InfoRow label="Business type" value={label("BUSINESS_TYPE", vendor.business_type_id)} />
        <InfoRow label="Category" value={label("CATEGORY_CODE", vendor.category_code_id)} />
        <InfoRow label="Sub-category" value={vendor.sub_category} />
        <InfoRow label="Local / OS" value={label("LOCAL_OS", vendor.local_os_id)} />
      </InfoCard>

      {/* Card 2 — Contact */}
      <InfoCard title="Contact">
        <InfoRow label="Contact person" value={vendor.contact_person} />
        <InfoRow label="Designation" value={vendor.designation} />
        <InfoRow label="Mobile" value={vendor.mobile} />
        <InfoRow label="Phone (company)" value={vendor.phone_company} />
        <InfoRow label="Email" value={vendor.email} />
        <InfoRow label="Website" value={vendor.website} />
        <InfoRow label="Address" value={composeAddress(vendor)} />
      </InfoCard>

      {/* Card 3 — Compliance */}
      <InfoCard title="Compliance">
        <InfoRow label="FSSAI" value={vendor.fssai_no} mono />
        <InfoRow label="GSTIN" value={vendor.gstn} mono />
        <InfoRow label="PAN" value={vendor.pan_no} mono />
        <InfoRow label="CIN" value={vendor.cin_no} mono />
        <InfoRow label="IEC" value={vendor.iec_no} mono />
        <InfoRow label="TIN / TAN" value={vendor.tin_tan} mono />
        <InfoRow label="Pollution / EPR" value={vendor.pollution_epr} />
        <InfoRow label="BRC / other" value={vendor.brc_other} />
        <InfoRow label="SCOC status" value={label("KYC_STATUS", vendor.scoc_status_id)} />
        <InfoRow label="KYC status" value={label("KYC_STATUS", vendor.kyc_status_id)} />
        <InfoRow label="Document status" value={label("DOC_STATUS", vendor.doc_status_id)} />
      </InfoCard>

      {/* Card 4 — MSME */}
      <InfoCard title="MSME">
        <InfoRow label="Is MSME?" value={vendor.is_msme ? "Yes" : "No"} />
        <InfoRow label="MSME type" value={label("MSME_TYPE", vendor.msme_type_id)} />
        <InfoRow label="Registration date" value={vendor.msme_registration_date} />
        <InfoRow label="UAM / Udyam" value={vendor.uam_udyam_no} mono />
      </InfoCard>

      {/* Card 5 — Notes */}
      <InfoCard title="Notes">
        <InfoRow label="Core business" value={vendor.core_business} />
        <InfoRow label="Capabilities" value={vendor.capabilities} />
        <InfoRow label="3-yr turnover" value={vendor.business_turnover_3y} />
        <InfoRow label="Reference" value={vendor.reference} />
        <InfoRow label="Remarks" value={vendor.remarks} />
      </InfoCard>

      {/* Card 6 — Audit */}
      <InfoCard title="Audit">
        <InfoRow label="Created at" value={fmtDate(vendor.created_at)} />
        <InfoRow label="Updated at" value={fmtDate(vendor.updated_at)} />
        <InfoRow label="Approved by" value={vendor.approved_by} mono />
        <InfoRow label="Approved at" value={fmtDate(vendor.approved_at)} />
      </InfoCard>
    </div>
  );
}

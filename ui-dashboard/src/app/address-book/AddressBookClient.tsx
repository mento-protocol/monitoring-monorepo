"use client";

import { useRef, useState, useCallback, useMemo } from "react";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelEditor } from "@/components/address-label-editor";
import { useAddressReportsIndex } from "@/hooks/use-address-reports-index";
import { isValidAddress } from "@/lib/format";
import { explorerAddressUrl } from "@/lib/tokens";
import { NETWORKS, DEFAULT_NETWORK } from "@/lib/networks";
import { buildAddressBookRows } from "@/lib/address-book";
import { AddressTableRow } from "./_components/address-table-row";
import { ImportDialog } from "./_components/import-dialog";
import {
  buildContractRows,
  buildCustomRows,
  buildReportOnlyRows,
  filterRows,
  findContractInitial,
  hasAmbiguousContractMatches,
  type AddressRow,
} from "./_lib/address-book-rows";
import { importFile, exportLabels } from "./_lib/address-book-import-export";

type EditTarget = { address: string };

type AddressBookPageProps = { canEdit?: boolean };

// 6 useState calls — independent UI pieces (search, modal targets,
// import banners, draft); a reducer would just rename the setters.
// Keep the table + modal ownership in one component so pending label/report
// ledgers stay easy to audit.
// react-doctor-disable-next-line react-doctor/prefer-useReducer, react-doctor/no-giant-component
export default function AddressBookPage(props: AddressBookPageProps) {
  const { canEdit: userCanEdit = false } = props;
  const {
    customEntries,
    getEntry,
    revalidate,
    isLoading,
    error,
    markPendingMutation,
    isMutationPending,
    markPendingReportMutation,
    isReportMutationPending,
  } = useAddressLabels();
  // Hook lifted from AddressTableRow so the SWR subscription, useSession
  // call, and per-render Set construction happen ONCE per table render
  // instead of N times (one per row). Cursor flagged the per-row pattern
  // as a perf regression at 200–500 rows; passing `hasReport` down keeps
  // the row component pure.
  const {
    data: reportsIndex,
    hasReport,
    error: reportsIndexError,
    mutate: retryReportsIndex,
  } = useAddressReportsIndex();

  const [search, setSearch] = useState("");
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Display network for global rows — keeps the Chain column populated with
  // something reasonable so explorer links don't break. `scope === "global"`
  // is what actually drives the "All chains" pill in the Chain column.
  const globalDisplayNetwork = NETWORKS[DEFAULT_NETWORK];

  // Contract labels from every configured network — one row per (chainId, address).
  // Empty dep array is correct: buildContractRows reads only module-level
  // constants (NETWORKS, NETWORK_IDS) that never change at runtime.
  const contractRows = useMemo<AddressRow[]>(() => buildContractRows(), []);

  // Custom rows: global entries render as a single "All chains" row;
  // per-chain entries render as one row per chain.
  const customRows = useMemo<AddressRow[]>(
    () => buildCustomRows(customEntries, globalDisplayNetwork),
    [customEntries, globalDisplayNetwork],
  );

  const reportOnlyRows = useMemo<AddressRow[]>(
    () =>
      buildReportOnlyRows(reportsIndex?.addresses ?? [], globalDisplayNetwork, [
        ...customRows,
        ...contractRows,
      ]),
    [reportsIndex?.addresses, globalDisplayNetwork, customRows, contractRows],
  );

  const allRows = useMemo<AddressRow[]>(
    () =>
      filterRows(
        buildAddressBookRows(contractRows, [...customRows, ...reportOnlyRows]),
        search,
      ),
    [customRows, reportOnlyRows, contractRows, search],
  );

  // Pending-ledger wiring for both modal flows (edit + add-new) —
  // mirrors the detail page's pattern (see `[address]/page.tsx`).
  // The address parameter comes from the form's current state
  // (passed via the callback), so the add-new modal — where
  // `editTarget` is null and the user types the address inside the
  // form — still marks pending against the right address. Keys by
  // `formId:op` so save and delete on the same mount don't
  // overwrite each other's unmark closure (codex round 13).
  // Track add-new draft for `requireExplicitName` evaluation as the
  // user types — needs to flip live on each keystroke since
  // `hasAmbiguousContractMatches` only matters for valid addresses.
  const [addNewDraftAddress, setAddNewDraftAddress] = useState("");
  const labelUnmarkRef = useRef<Map<string, () => void>>(new Map());
  const reportUnmarkRef = useRef<Map<string, () => void>>(new Map());
  const handleLabelSavingChange = useCallback(
    (saving: boolean, formId: string, address: string) => {
      const key = `${formId}:save`;
      if (saving) {
        labelUnmarkRef.current.set(key, markPendingMutation(address));
      } else {
        const u = labelUnmarkRef.current.get(key);
        labelUnmarkRef.current.delete(key);
        u?.();
      }
    },
    [markPendingMutation],
  );
  const handleLabelDeletingChange = useCallback(
    (deleting: boolean, formId: string, address: string) => {
      const key = `${formId}:delete`;
      if (deleting) {
        labelUnmarkRef.current.set(key, markPendingMutation(address));
      } else {
        const u = labelUnmarkRef.current.get(key);
        labelUnmarkRef.current.delete(key);
        u?.();
      }
    },
    [markPendingMutation],
  );
  const handleReportSavingChange = useCallback(
    (saving: boolean, editorId: string, address: string) => {
      const key = `${editorId}:save`;
      if (saving) {
        reportUnmarkRef.current.set(key, markPendingReportMutation(address));
      } else {
        const u = reportUnmarkRef.current.get(key);
        reportUnmarkRef.current.delete(key);
        u?.();
      }
    },
    [markPendingReportMutation],
  );
  const handleReportDeletingChange = useCallback(
    (deleting: boolean, editorId: string, address: string) => {
      const key = `${editorId}:delete`;
      if (deleting) {
        reportUnmarkRef.current.set(key, markPendingReportMutation(address));
      } else {
        const u = reportUnmarkRef.current.get(key);
        reportUnmarkRef.current.delete(key);
        u?.();
      }
    },
    [markPendingReportMutation],
  );

  const handleExport = useCallback(() => {
    exportLabels();
  }, []);

  const handleImportClick = () => {
    setImportError(null);
    setImportSuccess(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      const result = await importFile(file, revalidate);
      if (result.error) {
        setImportError(result.error);
      } else if (result.success) {
        setImportSuccess(result.success);
      }
    },
    [revalidate],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white">Address Book</h1>
          <p className="mt-1 text-sm text-slate-400">
            Contract and custom labels across every chain — one unified view.
          </p>
        </div>
        {userCanEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleExport}
              className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
            >
              Export JSON
            </button>
            <ImportDialog
              fileInputRef={fileInputRef}
              onImportClick={handleImportClick}
              onFileChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => setAddingNew(true)}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
            >
              + Add label
            </button>
          </div>
        )}
      </div>

      {userCanEdit && importError && (
        <p
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950 px-4 py-2 text-xs text-red-300"
        >
          {importError}
        </p>
      )}
      {userCanEdit && importSuccess && (
        <p
          role="status"
          className="rounded-lg border border-emerald-800 bg-emerald-950 px-4 py-2 text-xs text-emerald-300"
        >
          {importSuccess}
        </p>
      )}

      <div>
        <input
          type="search"
          placeholder="Search by address, name, tag, or chain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search address book"
          className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading labels…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          Error loading custom labels: {error.message}
        </p>
      )}
      {reportsIndexError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-800 bg-amber-950 px-4 py-2 text-xs text-amber-200"
        >
          <span>
            Forensic report index failed to load; report-only rows may be
            hidden.
          </span>
          <button
            type="button"
            onClick={() => void retryReportsIndex()}
            className="rounded border border-amber-700 px-2 py-1 text-amber-100 hover:border-amber-500 hover:text-white"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && allRows.length === 0 && (
        <p className="text-sm text-slate-500">
          {search ? "No labels match your search." : "No labels yet. Add one!"}
        </p>
      )}

      {allRows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Chain
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Address
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Name
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Tags
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Notes
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Source
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Visibility
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Created at
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Updated at
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 w-20">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {allRows.map((row) => {
                const resolved = row.isCustom
                  ? getEntry(row.address)
                  : undefined;
                return (
                  <AddressTableRow
                    key={row.key}
                    address={row.address}
                    name={row.name}
                    tags={row.tags}
                    network={row.network}
                    notes={resolved?.entry.notes}
                    isPublic={resolved?.entry.isPublic}
                    isCustom={row.isCustom}
                    kind={row.kind}
                    source={row.source}
                    createdAt={row.createdAt ?? resolved?.entry.createdAt}
                    updatedAt={row.updatedAt ?? resolved?.entry.updatedAt}
                    canEdit={userCanEdit}
                    reportPresent={hasReport(row.address)}
                    explorerUrl={
                      // Custom rows are chainless (the `network` is just the
                      // display placeholder for "All chains"), so a
                      // chain-specific explorer link would be wrong — e.g.
                      // a Monad-only address would open CeloScan. Suppress
                      // the link entirely; users can still edit, copy, or
                      // open via the inline AddressLink in other tables.
                      row.isCustom ||
                      row.kind === "report" ||
                      !row.network.explorerBaseUrl
                        ? null
                        : explorerAddressUrl(row.network, row.address)
                    }
                    onEdit={() => setEditTarget({ address: row.address })}
                    // The detail page renders the writable label form +
                    // forensic report editor unconditionally. Read-only
                    // surfaces (e.g. embedded views with `canEdit=false`)
                    // hide the inline Edit / +Tag actions; we must also
                    // skip the row overlay link, otherwise a row click
                    // would round-trip into an editable detail page and
                    // bypass the read-only mode entirely.
                    detailHref={
                      userCanEdit ? `/address-book/${row.address}` : undefined
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {userCanEdit && addingNew && (
        <AddressLabelEditor
          address=""
          onClose={() => {
            setAddingNew(false);
            setAddNewDraftAddress("");
          }}
          onDraftAddressChange={setAddNewDraftAddress}
          // Same ambig-contract guard as the edit / detail flows:
          // when the user types an address that's registered as a
          // contract under multiple disagreeing names, force an
          // explicit name so a tag-only save can't persist
          // `name: ""` and suppress every contract row in the index.
          requireExplicitName={
            isValidAddress(addNewDraftAddress) &&
            !getEntry(addNewDraftAddress)?.entry &&
            hasAmbiguousContractMatches(addNewDraftAddress)
          }
          // Pending-ledger wiring — a save kicked off in the add-new
          // modal contributes to the same global ledger as edit /
          // detail-page saves. Disable when there's a pending
          // mutation against THIS draft address (rare but real if
          // the user types an address that's mid-save somewhere
          // else).
          onLabelSavingChange={handleLabelSavingChange}
          onLabelDeletingChange={handleLabelDeletingChange}
          externallyDisabledLabel={isMutationPending(addNewDraftAddress)}
          onReportSavingChange={handleReportSavingChange}
          onReportDeletingChange={handleReportDeletingChange}
          externallyDisabledReport={isReportMutationPending(addNewDraftAddress)}
        />
      )}

      {userCanEdit && editTarget && (
        <AddressLabelEditor
          address={editTarget.address}
          initial={
            getEntry(editTarget.address)?.entry ??
            findContractInitial(editTarget.address)
          }
          onClose={() => setEditTarget(null)}
          // Mirror of the detail page's `requireExplicitName` gate.
          // When the address is registered as a contract under
          // multiple disagreeing names AND there's no custom entry
          // yet, force the user to type the right name — otherwise a
          // tag-only save persists `name: ""` and `buildAddressBookRows`
          // suppresses every contract row for that address under a
          // nameless custom row.
          requireExplicitName={
            !getEntry(editTarget.address)?.entry &&
            hasAmbiguousContractMatches(editTarget.address)
          }
          // Pending-ledger wiring — modal saves count toward the same
          // global ledger as detail-page saves. Disable label/report
          // editors when there's a pending mutation against this
          // address from any other surface (detail page, prior
          // modal). Once the original request settles, both ledgers
          // decrement and the disabled state lifts automatically.
          onLabelSavingChange={handleLabelSavingChange}
          onLabelDeletingChange={handleLabelDeletingChange}
          externallyDisabledLabel={isMutationPending(editTarget.address)}
          onReportSavingChange={handleReportSavingChange}
          onReportDeletingChange={handleReportDeletingChange}
          externallyDisabledReport={isReportMutationPending(editTarget.address)}
        />
      )}
    </div>
  );
}

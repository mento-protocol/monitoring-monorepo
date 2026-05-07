"use client";

import { useRef, useState, useCallback, useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelEditor } from "@/components/address-label-editor";
import { useAddressReportsIndex } from "@/hooks/use-address-reports-index";
import { explorerAddressUrl } from "@/lib/tokens";
import { NETWORKS, DEFAULT_NETWORK, networkForChainId } from "@/lib/networks";
import { type Scope } from "@/lib/address-labels-shared";
import { buildAddressBookRows } from "@/lib/address-book";
import { AddressTableRow } from "./_components/address-table-row";
import { ImportDialog } from "./_components/import-dialog";
import {
  buildContractRows,
  buildCustomRows,
  filterRows,
  type AddressRow,
} from "./_lib/address-book-rows";
import { importFile, exportLabels } from "./_lib/address-book-import-export";

type EditTarget = { address: string; scope: Scope; chainId: number };

export default function AddressBookPage({
  canEdit: userCanEdit = false,
}: {
  canEdit?: boolean;
}) {
  const { network: currentNetwork } = useNetwork();
  const { customEntries, getEntry, revalidate, isLoading, error } =
    useAddressLabels();
  // Hook lifted from AddressTableRow so the SWR subscription, useSession
  // call, and per-render Set construction happen ONCE per table render
  // instead of N times (one per row). Cursor flagged the per-row pattern
  // as a perf regression at 200–500 rows; passing `hasReport` down keeps
  // the row component pure.
  const { hasReport } = useAddressReportsIndex();

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

  const allRows = useMemo<AddressRow[]>(
    () => filterRows(buildAddressBookRows(contractRows, customRows), search),
    [customRows, contractRows, search],
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
                  ? getEntry(row.address, row.network.chainId)
                  : undefined;
                return (
                  <AddressTableRow
                    key={row.key}
                    address={row.address}
                    name={row.name}
                    tags={row.tags}
                    scope={row.scope}
                    network={row.network}
                    notes={resolved?.entry.notes}
                    isPublic={resolved?.entry.isPublic}
                    isCustom={row.isCustom}
                    source={row.source}
                    createdAt={row.createdAt ?? resolved?.entry.createdAt}
                    updatedAt={row.updatedAt ?? resolved?.entry.updatedAt}
                    canEdit={userCanEdit}
                    reportPresent={hasReport(row.address)}
                    explorerUrl={
                      row.network.explorerBaseUrl
                        ? explorerAddressUrl(row.network, row.address)
                        : null
                    }
                    onEdit={() =>
                      setEditTarget({
                        address: row.address,
                        // Always pass the row's actual scope. The editor's
                        // report tab uses this to look up reports at exactly
                        // that scope (strict scope match), so contract rows
                        // with chain-scoped reports remain reachable. The
                        // label tab still defaults its scope-radio to
                        // `startingScope` and the user can change it before
                        // saving a new label.
                        scope: row.scope,
                        // Chain context for the editor's "Only on X" option.
                        // Global-scope rows use the current network (user's
                        // active view) so "Only on X" means "demote to the
                        // chain I'm currently looking at".
                        chainId:
                          row.scope === "global"
                            ? currentNetwork.chainId
                            : row.network.chainId,
                      })
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {userCanEdit && addingNew && (
        <AddressLabelEditor address="" onClose={() => setAddingNew(false)} />
      )}

      {userCanEdit && editTarget && (
        <AddressLabelEditor
          address={editTarget.address}
          chainId={editTarget.chainId}
          scope={editTarget.scope}
          initial={
            getEntry(editTarget.address, editTarget.chainId)?.entry ??
            contractInitial(editTarget.address, editTarget.chainId)
          }
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}

function contractInitial(address: string, chainId: number) {
  const net = networkForChainId(chainId);
  const name = net?.addressLabels[address];
  if (!name) return undefined;
  return {
    name,
    tags: [],
    updatedAt: new Date().toISOString(),
  };
}

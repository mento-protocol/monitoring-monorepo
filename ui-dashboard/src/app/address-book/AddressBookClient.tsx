"use client";

import { useRef, useState, useCallback, useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelEditor } from "@/components/address-label-editor";
import { explorerAddressUrl } from "@/lib/tokens";
import { truncateAddress } from "@/lib/format";
import { NETWORKS, NETWORK_IDS, isConfiguredNetworkId } from "@/lib/networks";
import {
  buildAddressBookRows,
  resolveIsCustom,
  resolveCanEdit,
  countImportLabels,
  type AddressBookRow,
} from "@/lib/address-book";

// AddressBookRow is imported from @/lib/address-book (shared with tests).
// Local alias for brevity.
type AddressRow = AddressBookRow;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AddressBookPage({
  canEdit: userCanEdit = false,
}: {
  /** Server-determined: true only for authenticated @mentolabs.xyz sessions */
  canEdit?: boolean;
}) {
  const { network: selectedNetwork } = useNetwork();
  const { customLabels, getLabel, isCustomLabel, getEntry, isLoading, error } =
    useAddressLabels();

  const [search, setSearch] = useState("");
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Aggregate contract labels from ALL configured non-local networks.
  // Each address can appear in multiple networks (e.g. same token on mainnet
  // and testnet) — we emit one row per (address, network) pair.
  const contractRows = useMemo<AddressRow[]>(() => {
    const configuredIds = NETWORK_IDS.filter(isConfiguredNetworkId);
    const rows: AddressRow[] = [];
    const seen = new Set<string>(); // dedupe address within each network

    for (const id of configuredIds) {
      const net = NETWORKS[id];
      for (const [address, label] of Object.entries(net.addressLabels)) {
        const key = `${id}:${address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ key, address, label, isCustom: false, network: net });
      }
    }

    return rows;
  }, []);

  // Custom labels are scoped to the selected network (storage is per-chainId).
  // Using getLabel() is correct here since these ARE on the selected network.
  const customRows = useMemo<AddressRow[]>(
    () =>
      customLabels.map((r) => ({
        key: `custom:${r.address}`,
        address: r.address,
        label: getLabel(r.address),
        isCustom: true,
        network: selectedNetwork,
      })),
    [customLabels, getLabel, selectedNetwork],
  );

  // Merge: custom labels on the selected network take precedence over contract
  // rows for the same (selectedChainId, address) pair. Contract rows from
  // OTHER networks are always shown — dedupe is per (chainId, address).
  const allRows = useMemo<AddressRow[]>(
    () =>
      buildAddressBookRows(
        contractRows,
        customRows,
        selectedNetwork.chainId,
      ).filter((row) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          row.address.includes(q) ||
          row.label.toLowerCase().includes(q) ||
          (row.network?.label.toLowerCase().includes(q) ?? false)
        );
      }),
    [customRows, contractRows, selectedNetwork.chainId, search],
  );

  const handleExport = useCallback(() => {
    // Export all chains
    const a = document.createElement("a");
    a.href = `/api/address-labels/export`;
    a.download = "";
    a.click();
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

      const isCsv =
        file.name.toLowerCase().endsWith(".csv") ||
        file.type === "text/csv" ||
        // text/plain is treated as CSV only when the filename confirms it —
        // some OSes send text/plain for .csv files, but JSON files can also
        // arrive as text/plain and should still go through the JSON path.
        (file.type === "text/plain" &&
          file.name.toLowerCase().endsWith(".csv"));

      if (isCsv) {
        // Send CSV directly — backend parses it and imports into all mainnet chains.
        try {
          const text = await file.text();
          const res = await fetch("/api/address-labels/import", {
            method: "POST",
            headers: { "Content-Type": "text/csv" },
            body: text,
          });
          if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            setImportError(body.error ?? "Import failed.");
            return;
          }
          const { imported } = (await res.json()) as { imported?: number };
          const count = imported ?? 0;
          setImportSuccess(
            `Imported ${count} label${count !== 1 ? "s" : ""} from CSV.`,
          );
        } catch (err) {
          setImportError(err instanceof Error ? err.message : "Import failed.");
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        setImportError("Invalid file. Expected JSON or CSV (address,name).");
        return;
      }

      try {
        const res = await fetch("/api/address-labels/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          setImportError(body.error ?? "Import failed.");
          return;
        }
        const count = countImportLabels(parsed);
        setImportSuccess(`Imported ${count} label${count !== 1 ? "s" : ""}.`);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Import failed.");
      }
    },
    [],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white">Address Book</h1>
          <p className="mt-1 text-sm text-slate-400">
            Contract labels across all chains. Custom labels for{" "}
            <span className="text-slate-300">
              {selectedNetwork.label.replace(/ \(.*\)$/, "")}
            </span>{" "}
            — use the network selector to edit labels on other chains.
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
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleImportClick}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
              >
                Import
              </button>
              <details className="relative">
                <summary
                  aria-label="Supported import formats"
                  title="Supported import formats"
                  className="cursor-pointer list-none rounded-full p-1 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  <span aria-hidden="true">&#9432;</span>
                </summary>
                <div className="absolute right-0 top-8 z-10 w-80 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs text-slate-400 shadow-xl">
                  <p className="mb-2 font-semibold text-slate-300">
                    Supported import formats:
                  </p>
                  <p className="mb-1 font-medium text-slate-400">
                    Mento export:
                  </p>
                  <pre className="mb-2 overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`{ "exportedAt": "...",\n  "chains": { "42220": {\n    "0x...": { "label": "...",\n      "category": "...",\n      "notes": "..." } } } }`}</pre>
                  <p className="mb-1 font-medium text-slate-400">
                    Gnosis Safe address book:
                  </p>
                  <pre className="mb-2 overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`[{ "address": "0x...",\n   "chainId": "1",\n   "name": "My Label" }]`}</pre>
                  <p className="mb-1 font-medium text-slate-400">
                    CSV (address,name):
                  </p>
                  <pre className="overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`address,name\n0x...,My Label`}</pre>
                </div>
              </details>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.csv,application/json,text/csv,text/plain"
              onChange={handleFileChange}
              className="hidden"
              aria-label="Import address labels (JSON or CSV)"
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
          placeholder="Search by address, label, or chain…"
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
                  Address
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Label
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Chain
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Category
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
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 w-20">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {allRows.map((row) => {
                // entry/isCustom are only meaningful on the selected network —
                // only fetch them for custom rows (which ARE on selectedNetwork).
                const entry = row.isCustom ? getEntry(row.address) : undefined;
                // isCustomLabel() is scoped to selectedNetwork; only use it for
                // Use shared helpers (also used in tests) for consistent resolution.
                const isCustomResolved = resolveIsCustom(
                  row,
                  selectedNetwork.chainId,
                  isCustomLabel,
                );
                const canEdit =
                  userCanEdit && resolveCanEdit(row, selectedNetwork.chainId);
                const net = row.network ?? selectedNetwork;

                return (
                  <AddressTableRow
                    key={`${row.network?.id ?? selectedNetwork.id}:${row.address}`}
                    address={row.address}
                    label={row.label}
                    networkLabel={
                      row.network
                        ? row.network.label.replace(/ \(.*\)$/, "")
                        : null
                    }
                    category={entry?.category}
                    notes={entry?.notes}
                    isPublic={entry?.isPublic}
                    isCustom={isCustomResolved}
                    canEdit={canEdit}
                    explorerUrl={explorerAddressUrl(net, row.address)}
                    onEdit={() => setEditingAddress(row.address)}
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

      {userCanEdit && editingAddress && (
        <AddressLabelEditor
          address={editingAddress}
          initial={
            getEntry(editingAddress) ??
            (selectedNetwork.addressLabels[editingAddress]
              ? {
                  label: selectedNetwork.addressLabels[editingAddress],
                  updatedAt: new Date().toISOString(),
                }
              : undefined)
          }
          onClose={() => setEditingAddress(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

type AddressRowProps = {
  address: string;
  label: string;
  networkLabel: string | null;
  category?: string;
  notes?: string;
  isPublic?: boolean;
  isCustom: boolean;
  /** False for contract rows on non-selected networks — edit would write to wrong chain */
  canEdit: boolean;
  explorerUrl: string;
  onEdit: () => void;
};

function AddressTableRow({
  address,
  label,
  networkLabel,
  category,
  notes,
  isPublic,
  isCustom,
  canEdit,
  explorerUrl,
  onEdit,
}: AddressRowProps) {
  return (
    <tr className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
      <td className="px-4 py-3">
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={address}
          className="font-mono text-xs text-slate-300 hover:text-indigo-300 transition-colors"
        >
          {truncateAddress(address)}
          <span className="ml-1 text-slate-600" aria-hidden="true">
            ↗
          </span>
        </a>
      </td>
      <td className="px-4 py-3">
        <span
          className={`text-sm ${isCustom ? "font-medium text-indigo-400" : "text-slate-300"}`}
        >
          {label}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-slate-400">
        {networkLabel ?? <span className="text-slate-600">All chains</span>}
      </td>
      <td className="px-4 py-3 text-xs text-slate-400">
        {category ?? <span className="text-slate-600">—</span>}
      </td>
      <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate">
        {notes ?? <span className="text-slate-600">—</span>}
      </td>
      <td className="px-4 py-3">
        {isCustom ? (
          <span className="inline-flex items-center rounded-full bg-indigo-950 px-2 py-0.5 text-xs font-medium text-indigo-300 ring-1 ring-inset ring-indigo-800">
            custom
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-400 ring-1 ring-inset ring-slate-700">
            contract
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {isCustom &&
          (isPublic === true ? (
            <span className="inline-flex items-center rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-800">
              public
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-800">
              private
            </span>
          ))}
      </td>
      <td className="px-4 py-3">
        {!canEdit ? (
          <button
            type="button"
            disabled
            aria-label="Switch to this network to edit"
            className="text-xs text-slate-700 cursor-not-allowed"
          >
            Switch network
          </button>
        ) : isCustom ? (
          <button
            type="button"
            onClick={onEdit}
            className="text-xs text-slate-400 hover:text-indigo-300 transition-colors"
          >
            Edit
          </button>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            title="Add category or notes to this contract"
            className="text-xs text-slate-600 hover:text-indigo-300 transition-colors"
          >
            + Category
          </button>
        )}
      </td>
    </tr>
  );
}

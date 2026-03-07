"use client";

import { useRef, useState, useCallback } from "react";
import { useNetwork } from "@/components/network-provider";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelEditor } from "@/components/address-label-editor";
import { explorerAddressUrl } from "@/lib/tokens";
import { truncateAddress } from "@/lib/format";
import type {
  AddressLabelEntry,
  AddressLabelsSnapshot,
} from "@/lib/address-labels";

export default function AddressBookPage() {
  const { network } = useNetwork();
  const { customLabels, getLabel, isCustomLabel, getEntry, isLoading, error } =
    useAddressLabels();

  const [search, setSearch] = useState("");
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Merge static contract labels with custom labels for the full table view
  const staticLabels = Object.entries(network.addressLabels).map(
    ([address, label]) => ({
      address,
      label,
      isCustom: false,
    }),
  );

  const allRows = [
    ...customLabels.map((r) => ({ ...r, isCustom: true })),
    ...staticLabels.filter(
      (s) => !customLabels.some((c) => c.address === s.address),
    ),
  ].filter((row) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return row.address.includes(q) || row.label.toLowerCase().includes(q);
  });

  const handleExport = useCallback(() => {
    const url = `/api/address-labels/export?chainId=${network.chainId}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.click();
  }, [network.chainId]);

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

      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        setImportError("Invalid JSON file.");
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
        const count = countLabels(parsed);
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
            Labels for {network.label.replace(/ \(.*\)$/, "")}. Custom labels
            take precedence over contract labels.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleExport}
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
          >
            Import JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            className="hidden"
            aria-label="Import address labels JSON"
          />
          <button
            type="button"
            onClick={() => setAddingNew(true)}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
          >
            + Add label
          </button>
        </div>
      </div>

      {importError && (
        <p
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950 px-4 py-2 text-xs text-red-300"
        >
          {importError}
        </p>
      )}
      {importSuccess && (
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
          placeholder="Search by address or label…"
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
                  Category
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Notes
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Source
                </th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 w-20">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {allRows.map((row) => {
                const entry = getEntry(row.address);
                return (
                  <AddressRow
                    key={row.address}
                    address={row.address}
                    label={getLabel(row.address)}
                    category={entry?.category}
                    notes={entry?.notes}
                    isCustom={row.isCustom || isCustomLabel(row.address)}
                    explorerUrl={explorerAddressUrl(network, row.address)}
                    onEdit={() => setEditingAddress(row.address)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {addingNew && (
        <AddressLabelEditor address="" onClose={() => setAddingNew(false)} />
      )}

      {editingAddress && (
        <AddressLabelEditor
          address={editingAddress}
          initial={
            // For contract rows with no custom entry yet, pre-fill the label
            // so the user can add category/notes without having to retype it.
            getEntry(editingAddress) ??
            (network.addressLabels[editingAddress]
              ? {
                  label: network.addressLabels[editingAddress],
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
  category?: string;
  notes?: string;
  isCustom: boolean;
  explorerUrl: string;
  onEdit: () => void;
};

function AddressRow({
  address,
  label,
  category,
  notes,
  isCustom,
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
        {isCustom ? (
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function countLabels(parsed: unknown): number {
  if (typeof parsed === "object" && parsed !== null && "chains" in parsed) {
    return Object.values((parsed as AddressLabelsSnapshot).chains).reduce(
      (sum, entries) => sum + Object.keys(entries).length,
      0,
    );
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "labels" in parsed &&
    typeof (parsed as { labels: unknown }).labels === "object"
  ) {
    return Object.keys(
      (parsed as { labels: Record<string, AddressLabelEntry> }).labels,
    ).length;
  }
  return 0;
}

"use client";

import { useRef, useState, useCallback, useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelEditor } from "@/components/address-label-editor";
import { TagPills } from "@/components/tag-pills";
import { ChainIcon } from "@/components/chain-icon";
import { explorerAddressUrl } from "@/lib/tokens";
import { truncateAddress } from "@/lib/format";
import type { Scope } from "@/lib/address-labels-shared";
import {
  NETWORKS,
  NETWORK_IDS,
  DEFAULT_NETWORK,
  isConfiguredNetworkId,
  networkIdForChainId,
  type Network,
} from "@/lib/networks";
import { buildAddressBookRows, type AddressBookRow } from "@/lib/address-book";

type AddressRow = AddressBookRow;

type EditTarget = { address: string; scope: Scope; chainId: number };

type ImportedCounts = {
  global: number;
  chains: Record<string, number>;
};

function formatImportCounts(counts?: ImportedCounts): string {
  if (!counts) return "Imported 0 labels.";
  const parts: string[] = [];
  if (counts.global > 0) {
    parts.push(`${counts.global} global`);
  }
  for (const [chainId, n] of Object.entries(counts.chains)) {
    if (n === 0) continue;
    const id = networkIdForChainId(Number(chainId));
    const label = id ? NETWORKS[id].label : `Chain ${chainId}`;
    parts.push(`${n} ${label}-only`);
  }
  const total =
    counts.global + Object.values(counts.chains).reduce((a, b) => a + b, 0);
  if (parts.length === 0) return "Imported 0 labels.";
  return `Imported ${total} label${total !== 1 ? "s" : ""}: ${parts.join(", ")}.`;
}

export default function AddressBookPage({
  canEdit: userCanEdit = false,
}: {
  canEdit?: boolean;
}) {
  const { network: currentNetwork } = useNetwork();
  const { customEntries, getEntry, isLoading, error } = useAddressLabels();

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
  const contractRows = useMemo<AddressRow[]>(() => {
    const rows: AddressRow[] = [];
    const seen = new Set<string>();
    for (const id of NETWORK_IDS.filter(isConfiguredNetworkId)) {
      const net = NETWORKS[id];
      for (const [address, name] of Object.entries(net.addressLabels)) {
        const key = `${net.chainId}:${address.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          key: `${id}:${address}`,
          address,
          name,
          tags: [],
          isCustom: false,
          scope: net.chainId,
          network: net,
        });
      }
    }
    return rows;
  }, []);

  // Custom rows: global entries render as a single "All chains" row;
  // per-chain entries render as one row per chain.
  const customRows = useMemo<AddressRow[]>(
    () =>
      customEntries.flatMap((r) => {
        if (r.scope === "global") {
          return [
            {
              key: `custom:global:${r.address}`,
              address: r.address,
              name: r.name,
              tags: r.tags,
              isCustom: true,
              scope: "global" as Scope,
              network: globalDisplayNetwork,
            },
          ];
        }
        const net = networkForChainId(r.scope);
        if (!net) return [];
        return [
          {
            key: `custom:${r.scope}:${r.address}`,
            address: r.address,
            name: r.name,
            tags: r.tags,
            isCustom: true,
            scope: r.scope,
            network: net,
          },
        ];
      }),
    [customEntries, globalDisplayNetwork],
  );

  const allRows = useMemo<AddressRow[]>(
    () =>
      buildAddressBookRows(contractRows, customRows).filter((row) => {
        if (!search) return true;
        const q = search.toLowerCase();
        const chainText =
          row.scope === "global" ? "all chains" : row.network.label;
        return (
          row.address.toLowerCase().includes(q) ||
          row.name.toLowerCase().includes(q) ||
          chainText.toLowerCase().includes(q) ||
          row.tags.some((t) => t.toLowerCase().includes(q))
        );
      }),
    [customRows, contractRows, search],
  );

  const handleExport = useCallback(() => {
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
        (file.type === "text/plain" &&
          file.name.toLowerCase().endsWith(".csv"));

      if (isCsv) {
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
          const body = (await res.json()) as { imported?: ImportedCounts };
          setImportSuccess(formatImportCounts(body.imported));
        } catch (err) {
          setImportError(err instanceof Error ? err.message : "Import failed.");
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        setImportError(
          "Invalid file. Expected JSON or CSV (address,name,tags,chainId).",
        );
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
        const body = (await res.json()) as { imported?: ImportedCounts };
        setImportSuccess(formatImportCounts(body.imported));
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
                  <pre className="mb-2 overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`{ "exportedAt": "...",\n  "chains": { "42220": {\n    "0x...": { "name": "...",\n      "tags": ["..."],\n      "notes": "..." } } } }`}</pre>
                  <p className="mb-1 font-medium text-slate-400">
                    Gnosis Safe address book:
                  </p>
                  <pre className="mb-2 overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`[{ "address": "0x...",\n   "chainId": "1",\n   "name": "My Label" }]`}</pre>
                  <p className="mb-1 font-medium text-slate-400">
                    CSV (address,name,tags,chainId) — chainId blank =
                    cross-chain:
                  </p>
                  <pre className="overflow-x-auto rounded bg-slate-800 p-2 text-slate-400 text-[10px] leading-relaxed">{`address,name,tags,chainId\n0x...,My Label,"Whale",\n0x...,Celo Rebalancer,,42220`}</pre>
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
                    canEdit={userCanEdit}
                    explorerUrl={explorerAddressUrl(row.network, row.address)}
                    onEdit={() =>
                      setEditTarget({
                        address: row.address,
                        // For custom rows, scope is authoritative. For contract
                        // rows (no custom entry yet), default to "global" so
                        // new labels are cross-chain by default.
                        scope: row.isCustom ? row.scope : "global",
                        // Chain context for the editor's "Only on X" option.
                        // Global-scope custom rows use the current network
                        // (user's active view) so "Only on X" means "demote
                        // to the chain I'm currently looking at".
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

function networkForChainId(chainId: number): Network | null {
  const id = networkIdForChainId(chainId);
  return id ? NETWORKS[id] : null;
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

// Row component

type AddressRowProps = {
  address: string;
  name: string;
  tags: string[];
  scope: Scope;
  network: Network;
  notes?: string;
  isPublic?: boolean;
  isCustom: boolean;
  canEdit: boolean;
  explorerUrl: string;
  onEdit: () => void;
};

function AddressTableRow({
  address,
  name,
  tags,
  scope,
  network,
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
        {scope === "global" ? (
          <span className="inline-flex items-center rounded-full bg-purple-950 px-2 py-0.5 text-xs font-medium text-purple-300 ring-1 ring-inset ring-purple-800">
            All chains
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <ChainIcon network={network} />
            <span className="text-xs text-slate-400">
              {network.label.replace(/ \(.*\)$/, "")}
            </span>
          </div>
        )}
      </td>
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
          {name}
        </span>
      </td>
      <td className="px-4 py-3">
        {tags.length > 0 ? (
          <TagPills tags={tags} />
        ) : (
          <span className="text-xs text-slate-600">—</span>
        )}
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
        {!canEdit ? null : isCustom ? (
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
            title="Add tags or notes to this contract"
            className="text-xs text-slate-600 hover:text-indigo-300 transition-colors"
          >
            + Tag
          </button>
        )}
      </td>
    </tr>
  );
}

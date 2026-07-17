"use client";

import { NETWORK_IDS, NETWORKS } from "@/lib/networks";

const BRIDGE_NETWORKS = NETWORK_IDS.flatMap((id) => {
  const network = NETWORKS[id];
  return network.local || network.testnet ? [] : [network];
});

export const BRIDGE_CHAIN_IDS: ReadonlySet<number> = new Set(
  BRIDGE_NETWORKS.map((network) => network.chainId),
);

export function BridgeChainFilters({
  sourceChainId,
  destChainId,
  onSourceChange,
  onDestinationChange,
}: {
  sourceChainId: number | null;
  destChainId: number | null;
  onSourceChange: (chainId: number | null) => void;
  onDestinationChange: (chainId: number | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ChainSelect
        label="Source chain"
        allLabel="All sources"
        value={sourceChainId}
        onChange={onSourceChange}
      />
      <ChainSelect
        label="Destination chain"
        allLabel="All destinations"
        value={destChainId}
        onChange={onDestinationChange}
      />
    </div>
  );
}

function ChainSelect({
  label,
  allLabel,
  value,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: number | null;
  onChange: (chainId: number | null) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-500">
      <span>{label}:</span>
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value ? Number(event.target.value) : null)
        }
        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        <option value="">{allLabel}</option>
        {BRIDGE_NETWORKS.map((network) => (
          <option key={network.chainId} value={network.chainId}>
            {network.label}
          </option>
        ))}
      </select>
    </label>
  );
}

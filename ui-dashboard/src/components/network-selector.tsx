"use client";

import { useNetwork } from "@/components/network-provider";
import {
  NETWORK_IDS,
  NETWORKS,
  isConfiguredNetworkId,
  type IndexerNetworkId,
} from "@/lib/networks";

// Only show networks that are fully configured (hasuraUrl set, local hidden unless opted in).
// isConfiguredNetworkId enforces the same rules used by NetworkProvider for URL routing,
// so the selector and ?network= param are always in sync.
const VISIBLE_NETWORK_IDS = NETWORK_IDS.filter((id) =>
  isConfiguredNetworkId(id),
);

export function NetworkSelector() {
  const { networkId, setNetworkId } = useNetwork();

  return (
    <select
      value={networkId}
      onChange={(e) => setNetworkId(e.target.value as IndexerNetworkId)}
      aria-label="Select network"
      className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs font-mono text-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
    >
      {VISIBLE_NETWORK_IDS.map((id) => {
        const label = NETWORKS[id].label;
        return (
          <option key={id} value={id}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

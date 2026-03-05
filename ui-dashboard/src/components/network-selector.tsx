"use client";

import { useNetwork } from "@/components/network-provider";
import { NETWORK_IDS, NETWORKS, type IndexerNetworkId } from "@/lib/networks";

// Local networks require a locally-running indexer and are hidden by default.
// Set NEXT_PUBLIC_SHOW_LOCAL_NETWORKS=true in .env.local to show them.
const showLocalNetworks =
  process.env.NEXT_PUBLIC_SHOW_LOCAL_NETWORKS === "true";

const VISIBLE_NETWORK_IDS = NETWORK_IDS.filter(
  (id) => showLocalNetworks || !NETWORKS[id].local,
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
        const label = showLocalNetworks
          ? NETWORKS[id].label
          : NETWORKS[id].label.replace(" (hosted)", "");
        return (
          <option key={id} value={id}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

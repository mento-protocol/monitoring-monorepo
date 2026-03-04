"use client";

import { useNetwork } from "@/components/network-provider";
import { NETWORK_IDS, NETWORKS, type NetworkId } from "@/lib/networks";

export function NetworkSelector() {
  const { networkId, setNetworkId } = useNetwork();

  return (
    <select
      value={networkId}
      onChange={(e) => setNetworkId(e.target.value as NetworkId)}
      aria-label="Select network"
      className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs font-mono text-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
    >
      {NETWORK_IDS.map((id) => (
        <option key={id} value={id}>
          {NETWORKS[id].label}
        </option>
      ))}
    </select>
  );
}

"use client";

import { useNetwork } from "@/components/network-provider";
import { explorerTxUrl } from "@/lib/tokens";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";

export function TxHashCell({
  txHash,
  chainId,
}: {
  txHash: string;
  chainId?: number;
}) {
  const { network: contextNetwork } = useNetwork();
  const network = (() => {
    if (chainId == null) return contextNetwork;
    const id = networkIdForChainId(chainId);
    return id ? NETWORKS[id] : contextNetwork;
  })();
  const short = `${txHash.slice(0, 6)}…${txHash.slice(-4)}`;
  return (
    <td className="px-2 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs">
      <a
        href={explorerTxUrl(network, txHash)}
        target="_blank"
        rel="noopener noreferrer"
        title={txHash}
        className="font-mono text-slate-300 hover:text-indigo-300 transition-colors"
      >
        {short}
        <span className="ml-1 text-slate-600" aria-hidden="true">
          {"\u2197"}
        </span>
      </a>
    </td>
  );
}

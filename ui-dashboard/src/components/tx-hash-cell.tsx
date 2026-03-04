"use client";

import { useNetwork } from "@/components/network-provider";
import { explorerTxUrl } from "@/lib/tokens";

export function TxHashCell({ txHash }: { txHash: string }) {
  const { network } = useNetwork();
  const short = `${txHash.slice(0, 8)}…${txHash.slice(-6)}`;
  return (
    <td className="px-4 py-2 text-xs">
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

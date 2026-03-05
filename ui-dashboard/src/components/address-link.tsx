"use client";

import { useNetwork } from "@/components/network-provider";
import { addressLabel, hasLabel, explorerAddressUrl } from "@/lib/tokens";

export function AddressLink({ address }: { address: string }) {
  const { network } = useNetwork();
  const label = addressLabel(network, address);
  const labeled = hasLabel(network, address);
  return (
    <a
      href={explorerAddressUrl(network, address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className={`hover:text-indigo-300 transition-colors ${
        labeled ? "font-medium text-indigo-400" : "font-mono text-slate-300"
      }`}
    >
      {label}
      <span className="ml-1 text-slate-600" aria-hidden="true">
        {"\u2197"}
      </span>
    </a>
  );
}

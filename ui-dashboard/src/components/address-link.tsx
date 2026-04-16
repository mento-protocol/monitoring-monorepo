"use client";

import { useState } from "react";
import { useNetwork } from "@/components/network-provider";
import { useAddressLabels } from "@/components/address-labels-provider";
import { AddressLabelEditor } from "@/components/address-label-editor";
import { explorerAddressUrl } from "@/lib/tokens";
import { NETWORKS, networkIdForChainId } from "@/lib/networks";

type Props = {
  address: string;
  /** When true, hides the inline edit pencil (e.g. for contract addresses in read-only views) */
  readOnly?: boolean;
  /**
   * Overrides the network context (useful in multichain tables where a row's
   * chain differs from the page-level network). Falls back to `useNetwork()`
   * when absent.
   */
  chainId?: number;
};

export function AddressLink({ address, readOnly = false, chainId }: Props) {
  const { network: contextNetwork } = useNetwork();
  const { getName, hasName, isCustom, getEntry } = useAddressLabels();
  const [editing, setEditing] = useState(false);

  const resolvedNetwork = (() => {
    if (chainId == null) return contextNetwork;
    const id = networkIdForChainId(chainId);
    return id ? NETWORKS[id] : contextNetwork;
  })();

  const label = getName(address, chainId);
  const labeled = hasName(address, chainId);
  const custom = isCustom(address, chainId);
  const entry = getEntry(address, chainId);

  return (
    <>
      <span className="group inline-flex items-center gap-1">
        <a
          href={explorerAddressUrl(resolvedNetwork, address)}
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

        {!readOnly && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={
              custom ? `Edit label for ${address}` : `Add label for ${address}`
            }
            title={custom ? "Edit label" : "Add label"}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 text-slate-600 hover:text-slate-300 transition-all"
          >
            <PencilIcon />
          </button>
        )}
      </span>

      {editing && (
        <AddressLabelEditor
          address={address}
          initial={entry}
          chainId={chainId}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

function PencilIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L2.317 11.21a1.75 1.75 0 0 0-.463.89l-.5 2.5a.75.75 0 0 0 .876.876l2.5-.5a1.75 1.75 0 0 0 .89-.463l8.697-8.696a1.75 1.75 0 0 0 0-2.475Zm-1.414 1.06a.25.25 0 0 1 .354 0l.987.988a.25.25 0 0 1 0 .353L12.06 6.27 9.73 3.94l1.344-1.366ZM8.67 4.999l2.33 2.33L4.81 13.51a.25.25 0 0 1-.127.065l-1.857.372.372-1.857a.25.25 0 0 1 .065-.127L8.67 5Z" />
    </svg>
  );
}

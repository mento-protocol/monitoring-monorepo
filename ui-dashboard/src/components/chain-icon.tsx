import type { ComponentType } from "react";
import { NetworkCelo, NetworkMonad, NetworkPolygon } from "@web3icons/react";
import type { Network } from "@/lib/networks";

type BrandedIconProps = {
  size?: number | string;
  variant?: "branded" | "mono" | "background";
  className?: string;
};

const CHAIN_ICONS: Record<number, ComponentType<BrandedIconProps>> = {
  42220: NetworkCelo,
  11142220: NetworkCelo,
  143: NetworkMonad,
  137: NetworkPolygon,
};

function GenericChainIcon({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="12" fill="#64748b" />
    </svg>
  );
}

export function ChainIcon({
  network,
  size = 14,
}: {
  network: Network;
  size?: number;
}) {
  const Icon = CHAIN_ICONS[network.chainId];
  const dim = network.testnet || network.local;
  return (
    <span
      role="img"
      aria-label={network.label}
      title={network.label}
      className={`inline-flex flex-shrink-0 items-center${dim ? " opacity-60" : ""}`}
    >
      {Icon ? (
        <Icon size={size} variant="branded" />
      ) : (
        <GenericChainIcon size={size} />
      )}
    </span>
  );
}

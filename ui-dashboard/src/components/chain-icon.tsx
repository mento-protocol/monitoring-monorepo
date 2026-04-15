import type { ReactElement } from "react";
import type { Network } from "@/lib/networks";

type ChainVisual = { fill: string; mark: ReactElement | null };

const CELO_MARK = (
  <path
    d="M17.5 8.2c-.9-1.7-2.6-2.7-4.6-2.7-2.8 0-5 2.2-5 5s2.2 5 5 5c1.9 0 3.7-1 4.6-2.7h-2.1a3.1 3.1 0 0 1-2.5 1.1 3.4 3.4 0 1 1 0-6.8c1 0 2 .4 2.5 1.1h2.1z"
    fill="#000"
  />
);
const MONAD_MARK = (
  <path
    d="M12 3.5c-2.2 4-3.4 6.5-3.4 8.5s1.2 4.5 3.4 8.5c2.2-4 3.4-6.5 3.4-8.5S14.2 7.5 12 3.5z"
    fill="#fff"
  />
);

const CHAIN_VISUALS: Record<number, ChainVisual> = {
  42220: { fill: "#FCFF52", mark: CELO_MARK },
  11142220: { fill: "#FCFF52", mark: CELO_MARK },
  143: { fill: "#836EF9", mark: MONAD_MARK },
  10143: { fill: "#836EF9", mark: MONAD_MARK },
};

const GENERIC_VISUAL: ChainVisual = { fill: "#64748b", mark: null };

export function ChainIcon({ network }: { network: Network }) {
  const visual = CHAIN_VISUALS[network.chainId] ?? GENERIC_VISUAL;
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      role="img"
      aria-label={network.label}
      className={`inline-block flex-shrink-0${network.testnet ? " opacity-60" : ""}`}
    >
      <title>{network.label}</title>
      <rect width="24" height="24" rx="12" fill={visual.fill} />
      {visual.mark}
    </svg>
  );
}

/**
 * Wormhole ↔ EVM chain id mapping.
 * See https://docs.wormhole.com/wormhole/reference/constants
 */
export const WORMHOLE_TO_EVM_CHAIN_IDS: Record<number, readonly number[]> = {
  14: [42220, 11142220], // Celo mainnet/testnet
  48: [143, 10143], // Monad mainnet/testnet
  // 5: 137, // Polygon (future)
};

export function wormholeToEvmChainId(
  wormholeId: number,
  activeChainIds: Iterable<number>,
): number | null {
  const candidates = WORMHOLE_TO_EVM_CHAIN_IDS[wormholeId] ?? [];
  if (candidates.length === 0) return null;

  const active = new Set(activeChainIds);
  const matches = candidates.filter((chainId) => active.has(chainId));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  throw new Error(
    `[wormhole.chainIds] Wormhole chain ${wormholeId} matches multiple active EVM chains: ${matches.join(", ")}`,
  );
}

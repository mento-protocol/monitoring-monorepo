/**
 * Wormhole ↔ EVM chain id mapping.
 * See https://docs.wormhole.com/wormhole/reference/constants
 */
export const WORMHOLE_TO_EVM_CHAIN_ID: Record<number, number> = {
  14: 42220, // Celo
  48: 143, // Monad
  // 5: 137, // Polygon (future)
};

export function wormholeToEvmChainId(wormholeId: number): number | null {
  return WORMHOLE_TO_EVM_CHAIN_ID[wormholeId] ?? null;
}

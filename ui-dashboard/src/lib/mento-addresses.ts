// Known router addresses per chainId (sourced from @mento-protocol/contracts)
// Chain IDs: Celo Mainnet=42220, Celo Sepolia=11142220, Monad Mainnet=143, Monad Testnet=10143
export const ROUTER_ADDRESSES: Record<number, Set<string>> = {
  42220: new Set([
    "0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", // Router
  ]),
  11142220: new Set([
    "0xcf6cd45210b3ffe3ca28379c4683f1e60d0c2ccd", // Router
    "0x8e4fb12d86d5df911086a9153e79ca27e0c96156", // MentoRouter
  ]),
  143: new Set([
    "0x4861840c2efb2b98312b0ae34d86fd73e8f9b6f6", // Routerv300
  ]),
  10143: new Set([
    "0xcf6cd45210b3ffe3ca28379c4683f1e60d0c2ccd", // Routerv300
  ]),
};

// Known LP strategy addresses per chainId (sourced from @mento-protocol/contracts)
export const STRATEGY_ADDRESSES: Record<number, Set<string>> = {
  42220: new Set([
    "0xa0fb8b16ce6af3634ff9f3f4f40e49e1c1ae4f0b", // ReserveLiquidityStrategy
    "0x4e78bd9565341eabe99cdc024acb044d9bdcb985", // CDPLiquidityStrategy
  ]),
  11142220: new Set([
    "0x734bb3251ec3f1a83f8f2a8609bcef649d54ebf8", // ReserveLiquidityStrategy
    "0x625bd9cc583b5f9a88a38b0657ce816a3f02d367", // ReserveLiquidityStrategyv301
    "0x77b2d6d2220cb0ea20ea9d9eb7a75dd11343e412", // ReserveLiquidityStrategyv300
    "0x065ae7d4e207c8f4dca112d0b79e668cc7e93e03", // CDPLiquidityStrategy
  ]),
  143: new Set([
    "0xa0fb8b16ce6af3634ff9f3f4f40e49e1c1ae4f0b", // ReserveLiquidityStrategy
    "0x420fbdb50dadf0286144bff91ed62a6893dee148", // ReserveLiquidityStrategyv301
    "0x54e2ae8c8448912e17ce0b2453bafb7b0d80e40f", // OpenLiquidityStrategy
  ]),
  10143: new Set([
    "0x734bb3251ec3f1a83f8f2a8609bcef649d54ebf8", // ReserveLiquidityStrategy
    "0x625bd9cc583b5f9a88a38b0657ce816a3f02d367", // ReserveLiquidityStrategyv301
    "0xccd2ad0603a08ebc14d223a983171ef18192e8c9", // OpenLiquidityStrategy
  ]),
};

export type SwapKind = "trade" | "lp_swap" | "direct";

export function classifySwap(sender: string, chainId: number): SwapKind {
  const s = sender.toLowerCase();
  if (ROUTER_ADDRESSES[chainId]?.has(s)) return "trade";
  if (STRATEGY_ADDRESSES[chainId]?.has(s)) return "lp_swap";
  return "direct";
}

export function isTradeSwap(kind: SwapKind): boolean {
  return kind !== "lp_swap";
}

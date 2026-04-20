import type { BridgeDailySnapshot, BridgeTransfer } from "@/lib/types";

export function makeTransfer(
  overrides: Partial<BridgeTransfer> = {},
): BridgeTransfer {
  const id = overrides.id ?? "wormhole-0xabc";
  return {
    id,
    provider: "WORMHOLE",
    providerMessageId:
      overrides.providerMessageId ?? id.replace(/^wormhole-/, ""),
    status: "PENDING",
    tokenSymbol: "USDm",
    tokenAddress: "0x0",
    tokenDecimals: 18,
    sourceChainId: null,
    sourceContract: null,
    destChainId: null,
    destContract: null,
    sender: null,
    recipient: null,
    amount: null,
    sentBlock: null,
    sentTimestamp: null,
    sentTxHash: null,
    attestationCount: 0,
    firstAttestedTimestamp: null,
    lastAttestedTimestamp: null,
    deliveredBlock: null,
    deliveredTimestamp: null,
    deliveredTxHash: null,
    cancelledTimestamp: null,
    failedReason: null,
    usdPriceAtSend: null,
    usdValueAtSend: null,
    firstSeenAt: "0",
    lastUpdatedAt: "0",
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<BridgeDailySnapshot> = {},
): BridgeDailySnapshot {
  return {
    id: "snap",
    date: "0",
    provider: "WORMHOLE",
    tokenSymbol: "USDm",
    sourceChainId: 42220,
    destChainId: 143,
    sentCount: 0,
    deliveredCount: 0,
    cancelledCount: 0,
    sentVolume: "0",
    deliveredVolume: "0",
    sentUsdValue: null,
    updatedAt: "0",
    ...overrides,
  };
}

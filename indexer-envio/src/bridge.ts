/**
 * Generic (provider-agnostic) bridge helpers.
 *
 * These helpers know nothing about Wormhole/LayerZero/Axelar — they operate
 * on the generic BridgeTransfer / BridgeAttestation / BridgeDailySnapshot /
 * BridgeBridger entities. Provider-specific logic lives in src/wormhole/ (and
 * future sibling directories).
 */
import type {
  BridgeTransfer,
  BridgeDailySnapshot,
  BridgeBridger,
} from "generated";

export type BridgeProvider = "WORMHOLE";

/**
 * Build a BridgeTransfer.id from (provider, providerMessageId). Lowercased,
 * URL-safe. Same format consumed by the dashboard route `/bridge-flows/[id]`.
 */
export function buildTransferId(
  provider: BridgeProvider,
  providerMessageId: string,
): string {
  return `${provider.toLowerCase()}-${providerMessageId.toLowerCase()}`;
}

const ADDRESS_ZERO_PADDING = "0".repeat(24);

/**
 * Decode a Wormhole-style bytes32 recipient to an EVM address. Returns the
 * raw bytes32 (lowercase) when upper 12 bytes are non-zero — indicating a
 * non-EVM recipient (e.g., Solana).
 */
export function bytes32ToAddress(b32: string): string {
  const hex = b32.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 64) return b32.toLowerCase();
  const upper = hex.slice(0, 24);
  const lower = hex.slice(24);
  if (upper !== ADDRESS_ZERO_PADDING) return `0x${hex}`;
  return `0x${lower}`;
}

/** Default-fill a BridgeTransfer row when first created via any handler. */
export function defaultBridgeTransfer(args: {
  id: string;
  provider: BridgeProvider;
  providerMessageId: string;
  blockTimestamp: bigint;
}): BridgeTransfer {
  return {
    id: args.id,
    provider: args.provider,
    providerMessageId: args.providerMessageId.toLowerCase(),
    status: "PENDING",

    tokenSymbol: "UNKNOWN",
    tokenAddress: "0x0000000000000000000000000000000000000000",
    tokenDecimals: 18,

    sourceChainId: undefined,
    sourceContract: undefined,
    destChainId: undefined,
    destContract: undefined,

    sender: undefined,
    recipient: undefined,
    amount: undefined,

    sentBlock: undefined,
    sentTimestamp: undefined,
    sentTxHash: undefined,

    attestationCount: 0,
    firstAttestedTimestamp: undefined,
    lastAttestedTimestamp: undefined,

    deliveredBlock: undefined,
    deliveredTimestamp: undefined,
    deliveredTxHash: undefined,

    cancelledTimestamp: undefined,
    failedReason: undefined,

    usdPriceAtSend: undefined,
    usdValueAtSend: undefined,

    firstSeenAt: args.blockTimestamp,
    lastUpdatedAt: args.blockTimestamp,
  };
}

/**
 * Build a BridgeDailySnapshot id: "{dayTs}-{provider}-{tokenSymbol}-{src}-{dst}".
 * Day bucket uses UTC midnight seconds.
 */
export function snapshotId(args: {
  blockTimestamp: bigint;
  provider: BridgeProvider;
  tokenSymbol: string;
  sourceChainId: number;
  destChainId: number;
}): { id: string; date: bigint } {
  const dayTs = (args.blockTimestamp / 86_400n) * 86_400n;
  const id = `${dayTs.toString()}-${args.provider}-${args.tokenSymbol}-${args.sourceChainId}-${args.destChainId}`;
  return { id, date: dayTs };
}

export function defaultSnapshot(args: {
  id: string;
  date: bigint;
  provider: BridgeProvider;
  tokenSymbol: string;
  sourceChainId: number;
  destChainId: number;
  blockTimestamp: bigint;
}): BridgeDailySnapshot {
  return {
    id: args.id,
    date: args.date,
    provider: args.provider,
    tokenSymbol: args.tokenSymbol,
    sourceChainId: args.sourceChainId,
    destChainId: args.destChainId,
    sentCount: 0,
    deliveredCount: 0,
    cancelledCount: 0,
    sentVolume: 0n,
    deliveredVolume: 0n,
    sentUsdValue: "0.00",
    updatedAt: args.blockTimestamp,
  };
}

export function defaultBridger(args: {
  sender: string;
  blockTimestamp: bigint;
}): BridgeBridger {
  return {
    id: args.sender.toLowerCase(),
    sender: args.sender.toLowerCase(),
    totalSentCount: 0,
    totalSentUsd: "0.00",
    sourceChainsUsed: "[]",
    tokensUsed: "[]",
    providersUsed: "[]",
    firstSeenAt: args.blockTimestamp,
    lastSeenAt: args.blockTimestamp,
  };
}

/**
 * Merge a new element into a JSON-array string, preserving uniqueness.
 * Used by BridgeBridger to accumulate chains/tokens/providers seen.
 */
export function appendJsonSet(jsonArray: string, value: string): string {
  try {
    const arr = JSON.parse(jsonArray) as Array<string | number>;
    if (arr.includes(value as never)) return jsonArray;
    arr.push(value as never);
    return JSON.stringify(arr);
  } catch {
    return JSON.stringify([value]);
  }
}

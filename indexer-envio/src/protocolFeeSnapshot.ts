// ---------------------------------------------------------------------------
// PoolDailyFeeSnapshot upsert — pre-rolls ProtocolFeeTransfer rows into
// per-pool UTC-day buckets so the dashboard can paginate ~1 row/pool/day
// instead of one row per raw transfer, fitting all-time totals within
// Hasura's silent 1000-row page cap.
// ---------------------------------------------------------------------------

import type { Pool, PoolDailyFeeSnapshot } from "generated";
import { dayBucket, dailySnapshotId } from "./helpers";
import { computeFeeUsdWei, USD_PEGGED_SYMBOLS } from "./usd";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal context interface needed by upsertPoolDailyFeeSnapshot. */
interface FeeSnapshotContext {
  PoolDailyFeeSnapshot: {
    get: (id: string) => Promise<PoolDailyFeeSnapshot | undefined>;
    set: (entity: PoolDailyFeeSnapshot) => void;
  };
}

/** Input for a single transfer's contribution to the snapshot. */
export interface FeeSnapshotInput {
  chainId: number;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  token: string; // lowercased token contract address
  tokenSymbol: string;
  tokenDecimals: number;
  amount: bigint;
}

// ---------------------------------------------------------------------------
// Pure merge function — fully testable without mockDb
// ---------------------------------------------------------------------------

/**
 * Merge a new transfer's contribution into an existing (or undefined) snapshot.
 *
 * Handles:
 * - First-write of the day → seeds all fields, transferCount: 1.
 * - Same-token re-write → finds existing index in tokens[], sums amounts[i],
 *   transferCount += 1.
 * - New-token-on-existing-day → pushes parallel entries to all four arrays,
 *   transferCount += 1.
 * - feesUsdWei += contribution (0 for non-pegged).
 * - allPegged stays true only if all prior transfers AND this one were pegged.
 * - unresolvedCount += 1 iff tokenSymbol === "UNKNOWN".
 * - blockNumber = max of existing and new.
 * - updatedAtTimestamp = new (most recent).
 */
export function mergeFeeSnapshot(
  existing: PoolDailyFeeSnapshot | undefined,
  input: {
    id: string;
    chainId: number;
    poolId: string;
    poolAddress: string;
    timestamp: bigint;
    token: string;
    tokenSymbol: string;
    tokenDecimals: number;
    amount: bigint;
    blockNumber: bigint;
    updatedAtTimestamp: bigint;
  },
): PoolDailyFeeSnapshot {
  const usdContribution = computeFeeUsdWei({
    tokenSymbol: input.tokenSymbol,
    tokenDecimals: input.tokenDecimals,
    amount: input.amount,
  });
  const isUnresolved = input.tokenSymbol === "UNKNOWN";
  const isThisTokenPegged = USD_PEGGED_SYMBOLS.has(input.tokenSymbol);

  if (!existing) {
    // First write for this pool/day
    return {
      id: input.id,
      chainId: input.chainId,
      poolId: input.poolId,
      poolAddress: input.poolAddress,
      timestamp: input.timestamp,
      tokens: [input.token],
      tokenSymbols: [input.tokenSymbol],
      tokenDecimals: [input.tokenDecimals],
      amounts: [input.amount],
      feesUsdWei: usdContribution,
      allPegged: isThisTokenPegged,
      unresolvedCount: isUnresolved ? 1 : 0,
      transferCount: 1,
      blockNumber: input.blockNumber,
      updatedAtTimestamp: input.updatedAtTimestamp,
    };
  }

  // Existing snapshot — find the token index (if already tracked this day)
  const tokenIdx = existing.tokens.indexOf(input.token);

  let newTokens: string[];
  let newTokenSymbols: string[];
  let newTokenDecimals: number[];
  let newAmounts: bigint[];

  if (tokenIdx >= 0) {
    // Same token already seen this day — sum the amount
    newTokens = [...existing.tokens];
    newTokenSymbols = [...existing.tokenSymbols];
    newTokenDecimals = [...existing.tokenDecimals];
    newAmounts = existing.amounts.map((a, i) =>
      i === tokenIdx ? a + input.amount : a,
    );
  } else {
    // New token for this day — push parallel entries
    newTokens = [...existing.tokens, input.token];
    newTokenSymbols = [...existing.tokenSymbols, input.tokenSymbol];
    newTokenDecimals = [...existing.tokenDecimals, input.tokenDecimals];
    newAmounts = [...existing.amounts, input.amount];
  }

  return {
    ...existing,
    tokens: newTokens,
    tokenSymbols: newTokenSymbols,
    tokenDecimals: newTokenDecimals,
    amounts: newAmounts,
    feesUsdWei: existing.feesUsdWei + usdContribution,
    // allPegged flips to false as soon as any non-pegged transfer arrives
    allPegged: existing.allPegged && isThisTokenPegged,
    unresolvedCount: existing.unresolvedCount + (isUnresolved ? 1 : 0),
    transferCount: existing.transferCount + 1,
    blockNumber:
      input.blockNumber > existing.blockNumber
        ? input.blockNumber
        : existing.blockNumber,
    updatedAtTimestamp: input.updatedAtTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Async upsert — reads existing row, merges, writes
// ---------------------------------------------------------------------------

/**
 * Upsert a PoolDailyFeeSnapshot for the given pool/transfer.
 *
 * Note: The existing backfill loop in feeToken.ts (lines 50–72) fixes stale
 * UNKNOWN ProtocolFeeTransfer rows when a token's symbol later resolves.
 * The snapshot's tokenSymbols[] array is NOT backfilled in this version —
 * degraded mode where old UNKNOWN entries stay in past snapshots is
 * acceptable; the next deploy's full resync corrects them automatically.
 */
export async function upsertPoolDailyFeeSnapshot({
  context,
  chainId,
  pool,
  blockTimestamp,
  blockNumber,
  token,
  tokenSymbol,
  tokenDecimals,
  amount,
}: {
  context: FeeSnapshotContext;
  chainId: number;
  pool: Pool;
  blockTimestamp: bigint;
  blockNumber: bigint;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: bigint;
}): Promise<void> {
  const dayTs = dayBucket(blockTimestamp);
  const id = dailySnapshotId(pool.id, dayTs);
  const existing = await context.PoolDailyFeeSnapshot.get(id);

  const poolAddress = pool.id.replace(/^\d+-/, ""); // extract raw address from poolId

  const merged = mergeFeeSnapshot(existing, {
    id,
    chainId,
    poolId: pool.id,
    poolAddress,
    timestamp: dayTs,
    token,
    tokenSymbol,
    tokenDecimals,
    amount,
    blockNumber,
    updatedAtTimestamp: blockTimestamp,
  });

  context.PoolDailyFeeSnapshot.set(merged);
}

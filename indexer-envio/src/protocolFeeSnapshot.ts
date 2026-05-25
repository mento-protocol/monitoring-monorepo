// ---------------------------------------------------------------------------
// PoolDailyFeeSnapshot upsert — pre-rolls ProtocolFeeTransfer rows into
// per-pool UTC-day buckets so the dashboard can paginate ~1 row/pool/day
// instead of one row per raw transfer, fitting all-time totals within
// Hasura's silent 1000-row page cap.
//
// Two modes:
// - "add": new event indexed for the first time. Adds the transfer's amount
//   and USD contribution; bumps transferCount.
// - "heal": replay (or new event) where the prior snapshot slot for this
//   token was UNKNOWN and the symbol has now resolved. Repairs the slot's
//   metadata and reprices the prior accumulated amount; does NOT add to
//   amounts/transferCount.
//
// Self-heal also fires automatically inside "add" mode when a same-day
// re-write transitions a slot from UNKNOWN → resolved (the common case
// where a later transfer's symbol resolution arrives within the same day
// before any restart/reorg).
//
// `unresolvedCount` is the number of UNKNOWN slots currently in `tokens[]`
// (NOT the count of UNKNOWN transfers). This matches the dashboard's
// "is this row approximate?" signal — multiple UNKNOWN transfers for the
// same token collapse into one slot, so they count once.
// ---------------------------------------------------------------------------

import type { Pool, PoolDailyFeeSnapshot } from "envio";
import {
  dayBucket,
  dailySnapshotId,
  extractAddressFromPoolId,
} from "./helpers.js";
import { computeFeeUsdWei, USD_PEGGED_SYMBOLS } from "./usd.js";

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

/** Upsert mode — add a new transfer's contribution, or heal-only repair. */
export type FeeSnapshotMode = "add" | "heal";

interface MergeInput {
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recomputeAllPegged(symbols: ReadonlyArray<string>): boolean {
  return symbols.every((s) => USD_PEGGED_SYMBOLS.has(s));
}

// ---------------------------------------------------------------------------
// Pure merge function — fully testable without an Envio test indexer
// ---------------------------------------------------------------------------

/**
 * Merge a new transfer's contribution into an existing (or undefined) snapshot.
 *
 * Mode "add" (default): standard path for a freshly indexed event.
 *   - First write of the day → seeds all fields, transferCount: 1.
 *   - Same-token re-write → sums amounts[i], transferCount += 1. If the
 *     prior slot had UNKNOWN and the new symbol is resolved, also self-heals
 *     that slot's metadata and reprices the prior accumulated amount.
 *   - New-token-on-existing-day → pushes parallel entries to all four arrays.
 *
 * Mode "heal": replay where the same event's symbol just resolved (the prior
 * indexing wrote UNKNOWN; the cache has since populated). Repairs metadata
 * and reprices the prior accumulated amount for that slot. Does NOT add to
 * amounts or transferCount — that contribution was already counted on the
 * original "add". Returns null (no-op) if the snapshot or slot doesn't exist.
 */
type InputFlags = {
  input: MergeInput;
  inputContribution: bigint;
  isInputPegged: boolean;
  isUnresolvedInput: boolean;
};

function createFeeSnapshot(flags: InputFlags): PoolDailyFeeSnapshot {
  const { input, inputContribution, isInputPegged, isUnresolvedInput } = flags;
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
    feesUsdWei: inputContribution,
    allPegged: isInputPegged,
    unresolvedCount: isUnresolvedInput ? 1 : 0,
    transferCount: 1,
    blockNumber: input.blockNumber,
    updatedAtTimestamp: input.updatedAtTimestamp,
  };
}

function appendNewTokenSlot(
  existing: PoolDailyFeeSnapshot,
  flags: InputFlags,
): PoolDailyFeeSnapshot {
  const { input, inputContribution, isInputPegged, isUnresolvedInput } = flags;
  return {
    ...existing,
    tokens: [...existing.tokens, input.token],
    tokenSymbols: [...existing.tokenSymbols, input.tokenSymbol],
    tokenDecimals: [...existing.tokenDecimals, input.tokenDecimals],
    amounts: [...existing.amounts, input.amount],
    feesUsdWei: existing.feesUsdWei + inputContribution,
    allPegged: existing.allPegged && isInputPegged,
    unresolvedCount: existing.unresolvedCount + (isUnresolvedInput ? 1 : 0),
    transferCount: existing.transferCount + 1,
    blockNumber:
      input.blockNumber > existing.blockNumber
        ? input.blockNumber
        : existing.blockNumber,
    updatedAtTimestamp: input.updatedAtTimestamp,
  };
}

function effectiveAddFlagsForTrackedSlot(
  existing: PoolDailyFeeSnapshot,
  tokenIdx: number,
  flags: InputFlags,
): InputFlags {
  const existingSymbol = existing.tokenSymbols[tokenIdx];
  if (
    !flags.isUnresolvedInput ||
    existingSymbol === undefined ||
    existingSymbol === "UNKNOWN"
  ) {
    return flags;
  }

  const tokenDecimals = existing.tokenDecimals[tokenIdx];
  if (tokenDecimals === undefined) {
    return flags;
  }

  const input = {
    ...flags.input,
    tokenSymbol: existingSymbol,
    tokenDecimals,
  };
  return {
    input,
    isUnresolvedInput: false,
    isInputPegged: USD_PEGGED_SYMBOLS.has(existingSymbol),
    inputContribution: computeFeeUsdWei({
      tokenSymbol: existingSymbol,
      tokenDecimals,
      amount: input.amount,
    }),
  };
}

export function mergeFeeSnapshot(
  existing: PoolDailyFeeSnapshot | undefined,
  input: MergeInput,
  mode: FeeSnapshotMode = "add",
): PoolDailyFeeSnapshot | null {
  const flags: InputFlags = {
    input,
    isUnresolvedInput: input.tokenSymbol === "UNKNOWN",
    isInputPegged: USD_PEGGED_SYMBOLS.has(input.tokenSymbol),
    inputContribution: computeFeeUsdWei({
      tokenSymbol: input.tokenSymbol,
      tokenDecimals: input.tokenDecimals,
      amount: input.amount,
    }),
  };

  if (!existing) {
    // Heal mode requires an existing snapshot — caller misuse if missing.
    if (mode === "heal") return null;
    return createFeeSnapshot(flags);
  }

  const tokenIdx = existing.tokens.indexOf(input.token);

  // ---- New-token slot path (only valid in "add" mode) -----------------------
  if (tokenIdx < 0) {
    if (mode === "heal") {
      // Nothing to heal — the slot we'd want to repair doesn't exist. The
      // caller invokes heal mode only when a prior add wrote this slot, so
      // reaching here implies state drift. Return existing unchanged.
      return existing;
    }
    return appendNewTokenSlot(existing, flags);
  }

  // ---- Same-token-already-tracked path -------------------------------------
  const slotWasUnknown = existing.tokenSymbols[tokenIdx] === "UNKNOWN";
  const shouldHeal = slotWasUnknown && !flags.isUnresolvedInput;

  let nextSymbols = existing.tokenSymbols;
  let nextDecimals = existing.tokenDecimals;
  let nextFeesUsdWei = existing.feesUsdWei;
  let nextUnresolvedCount = existing.unresolvedCount;
  let nextAllPegged = existing.allPegged;

  if (shouldHeal) {
    // Repair this slot's metadata.
    nextSymbols = existing.tokenSymbols.map((s, i) =>
      i === tokenIdx ? input.tokenSymbol : s,
    );
    nextDecimals = existing.tokenDecimals.map((d, i) =>
      i === tokenIdx ? input.tokenDecimals : d,
    );
    // Reprice the prior accumulated amount that was previously priced as 0n
    // (the slot was UNKNOWN). Use the just-resolved metadata.
    const priorAmount = existing.amounts[tokenIdx] ?? 0n;
    const repairedPriorUsd = computeFeeUsdWei({
      tokenSymbol: input.tokenSymbol,
      tokenDecimals: input.tokenDecimals,
      amount: priorAmount,
    });
    nextFeesUsdWei = existing.feesUsdWei + repairedPriorUsd;
    nextUnresolvedCount = Math.max(0, existing.unresolvedCount - 1);
    nextAllPegged = recomputeAllPegged(nextSymbols);
  }

  const state: MergedSlotState = {
    nextSymbols,
    nextDecimals,
    nextFeesUsdWei,
    nextAllPegged,
    nextUnresolvedCount,
  };
  if (mode === "heal") {
    return finalizeHeal(existing, input, state);
  }

  const addFlags = effectiveAddFlagsForTrackedSlot(existing, tokenIdx, flags);
  return finalizeAdd(existing, {
    flags: addFlags,
    tokenIdx,
    shouldHeal,
    state,
  });
}

type MergedSlotState = {
  nextSymbols: readonly string[];
  nextDecimals: readonly number[];
  nextFeesUsdWei: bigint;
  nextAllPegged: boolean;
  nextUnresolvedCount: number;
};

function finalizeHeal(
  existing: PoolDailyFeeSnapshot,
  input: MergeInput,
  state: MergedSlotState,
): PoolDailyFeeSnapshot {
  // Heal-only: don't add the input's amount or contribution; the original
  // event's amount is already in amounts[tokenIdx] from the prior add.
  return {
    ...existing,
    tokenSymbols: state.nextSymbols,
    tokenDecimals: state.nextDecimals,
    feesUsdWei: state.nextFeesUsdWei,
    allPegged: state.nextAllPegged,
    unresolvedCount: state.nextUnresolvedCount,
    blockNumber:
      input.blockNumber > existing.blockNumber
        ? input.blockNumber
        : existing.blockNumber,
    updatedAtTimestamp: input.updatedAtTimestamp,
  };
}

function finalizeAdd(
  existing: PoolDailyFeeSnapshot,
  ctx: {
    flags: InputFlags;
    tokenIdx: number;
    shouldHeal: boolean;
    state: MergedSlotState;
  },
): PoolDailyFeeSnapshot {
  const { flags, tokenIdx, shouldHeal, state } = ctx;
  const { input, isUnresolvedInput, isInputPegged, inputContribution } = flags;
  const nextAmounts = existing.amounts.map((a, i) =>
    i === tokenIdx ? a + input.amount : a,
  );
  let nextFeesUsdWei = state.nextFeesUsdWei;
  if (!isUnresolvedInput) {
    nextFeesUsdWei += inputContribution;
  }
  // allPegged: if the new transfer is non-pegged (or UNKNOWN), the row can no
  // longer be all-pegged. If shouldHeal already recomputed it, that's the
  // canonical value — only flip from true→false here, never the reverse.
  let nextAllPegged = state.nextAllPegged;
  if (!shouldHeal && (isUnresolvedInput || !isInputPegged)) {
    nextAllPegged = false;
  }
  return {
    ...existing,
    tokenSymbols: state.nextSymbols,
    tokenDecimals: state.nextDecimals,
    amounts: nextAmounts,
    feesUsdWei: nextFeesUsdWei,
    allPegged: nextAllPegged,
    unresolvedCount: state.nextUnresolvedCount,
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
 * `mode: "add"` is the default: a freshly indexed event contributes its
 * amount + USD contribution. `mode: "heal"` is the replay path: the prior
 * indexing of the same event wrote an UNKNOWN slot; the symbol has since
 * resolved, so we repair metadata and reprice the prior accumulated amount
 * without adding the transfer twice.
 *
 * The handler decides which mode applies by inspecting whether the matching
 * `ProtocolFeeTransfer` already exists and whether its prior `tokenSymbol`
 * was UNKNOWN — see `handlers/feeToken.ts`.
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
  mode = "add",
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
  mode?: FeeSnapshotMode;
}): Promise<void> {
  const dayTs = dayBucket(blockTimestamp);
  const id = dailySnapshotId(pool.id, dayTs);
  const existing = await context.PoolDailyFeeSnapshot.get(id);

  const poolAddress = extractAddressFromPoolId(pool.id);

  const merged = mergeFeeSnapshot(
    existing,
    {
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
    },
    mode,
  );

  if (merged === null) return; // heal-mode no-op
  context.PoolDailyFeeSnapshot.set(merged);
}

export async function preloadPoolDailyFeeSnapshot({
  context,
  pool,
  blockTimestamp,
}: {
  context: FeeSnapshotContext;
  pool: Pool;
  blockTimestamp: bigint;
}): Promise<void> {
  await context.PoolDailyFeeSnapshot.get(
    dailySnapshotId(pool.id, dayBucket(blockTimestamp)),
  );
}

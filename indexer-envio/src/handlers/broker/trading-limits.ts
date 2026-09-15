// ---------------------------------------------------------------------------
// v2 Broker trading limits for VirtualPool-wrapped exchanges.
//
// The Broker enforces limits per (exchange, token leg), so a direct v2 swap
// and a VirtualPool-routed swap move the SAME limit. Gating is therefore at
// the EXCHANGE level — "does a VirtualPool wrap this exchangeId" — never on
// the Broker caller.
//
// State has no event: `Broker.Swap` triggers an at-block RPC read, gated by a
// freshness window so a full resync costs about 31k reads instead of 1-2M.
// Config is authoritative from `Broker.TradingLimitConfigured`; the at-block
// config read is a one-time bootstrap for limits configured before
// `start_block`. That event also samples state once at its own block, because
// the contract's `reset()` invalidates whatever the last gated read stored.
// ---------------------------------------------------------------------------

import type { BrokerTradingLimit, EvmOnEventContext, Pool } from "envio";
import { indexer } from "../../indexer.js";
import { asAddress, asBigInt } from "../../helpers.js";
import {
  EMPTY_BROKER_LIMIT_CONFIG,
  EMPTY_BROKER_LIMIT_STATE,
  brokerLimitConfigFromRow,
  brokerLimitId,
  brokerLimitStateFromRow,
  brokerTradingLimitRowId,
  buildBrokerTradingLimitRow,
  foldPoolLimitFields,
  resetBrokerState,
  shouldRefreshBrokerState,
  type BrokerLimitConfig,
  type PoolLimitFields,
} from "../../brokerTradingLimits.js";
import { brokerTradingLimitEffect } from "../../rpc/effects.js";
import { findWrappedPool } from "../biPoolManager.js";

export type BrokerTradingLimitArgs = {
  context: EvmOnEventContext;
  chainId: number;
  /** Broker proxy that emitted the event; the contract holding the mappings. */
  brokerAddress: string;
  exchangeId: string;
  exchangeProvider: string;
  /** The swap's two token legs, in event order. */
  tokens: readonly string[];
  blockNumber: bigint;
  blockTimestamp: bigint;
};

type WrappedExchange = { poolId: string; exchangeProvider: string };

function exchangeRowId(chainId: number, exchangeId: string): string {
  return `${chainId}-${exchangeId.toLowerCase()}`;
}

/** Both passes call this, so preload warms exactly the reads processing makes.
 * Pure entity reads — no RPC. */
async function resolveWrappedExchange(
  context: EvmOnEventContext,
  chainId: number,
  exchangeId: string,
): Promise<WrappedExchange | undefined> {
  const exchange = await context.BiPoolExchange.get(
    exchangeRowId(chainId, exchangeId),
  );
  // A checked exchange with no wrapper stays unwrapped until a VP-side
  // self-heal writes `wrappedByPoolId` here, so skip the `getWhere`. Most
  // Broker swaps are on the unwrapped deprecated exchanges.
  if (
    exchange &&
    !exchange.wrappedByPoolId &&
    exchange.wrappedByPoolIdChecked
  ) {
    return undefined;
  }
  const poolId =
    exchange?.wrappedByPoolId ??
    (await findWrappedPool(context, chainId, exchangeId));
  if (!poolId) return undefined;
  return { poolId, exchangeProvider: exchange?.exchangeProvider ?? "" };
}

/** Effect key. Derived from event params and the stored row only, so preload
 * and processing present byte-identical inputs and Envio dedupes them. */
function effectInput(
  args: BrokerTradingLimitArgs,
  token: string,
  row: BrokerTradingLimit | undefined,
) {
  return {
    chainId: args.chainId,
    brokerAddress: args.brokerAddress,
    limitId: brokerLimitId(args.exchangeId, token),
    blockNumber: args.blockNumber,
    readConfig: !(row?.configKnown ?? false),
  };
}

function legRowId(args: BrokerTradingLimitArgs, token: string): string {
  return brokerTradingLimitRowId(args.chainId, args.exchangeId, token);
}

export async function preloadBrokerTradingLimits(
  args: BrokerTradingLimitArgs,
): Promise<void> {
  const wrapped = await resolveWrappedExchange(
    args.context,
    args.chainId,
    args.exchangeId,
  );
  if (!wrapped) return;
  await args.context.Pool.get(wrapped.poolId);
  for (const token of args.tokens) {
    const row = await args.context.BrokerTradingLimit.get(
      legRowId(args, token),
    );
    if (!shouldRefreshBrokerState(row, args.blockNumber, args.blockTimestamp)) {
      continue;
    }
    await args.context.effect(
      brokerTradingLimitEffect,
      effectInput(args, token, row),
    );
  }
}

type LegOutcome = { row: BrokerTradingLimit; adopted: boolean };

async function applyLeg(
  args: BrokerTradingLimitArgs,
  poolId: string,
  token: string,
): Promise<LegOutcome> {
  const existing = await args.context.BrokerTradingLimit.get(
    legRowId(args, token),
  );
  if (
    existing &&
    !shouldRefreshBrokerState(existing, args.blockNumber, args.blockTimestamp)
  ) {
    return { row: existing, adopted: false };
  }
  const read = await args.context.effect(
    brokerTradingLimitEffect,
    effectInput(args, token, existing),
  );
  const base = {
    chainId: args.chainId,
    exchangeId: args.exchangeId,
    exchangeProvider: args.exchangeProvider,
    poolId,
    token,
    blockNumber: args.blockNumber,
    blockTimestamp: args.blockTimestamp,
  };
  if (!read) {
    // Null-read rule: a discarded read never overwrites a good row. A leg with
    // no row yet gets a placeholder so the next swap retries and the dashboard
    // can say "state pending" instead of "not applicable".
    if (existing) return { row: existing, adopted: false };
    const placeholder = buildBrokerTradingLimitRow({
      ...base,
      config: EMPTY_BROKER_LIMIT_CONFIG,
      configKnown: false,
      state: EMPTY_BROKER_LIMIT_STATE,
      stateKnown: false,
      stateBlock: 0n,
      stateTimestamp: 0n,
    });
    args.context.BrokerTradingLimit.set(placeholder);
    return { row: placeholder, adopted: false };
  }
  const row = buildBrokerTradingLimitRow({
    ...base,
    config:
      read.config ??
      (existing
        ? brokerLimitConfigFromRow(existing)
        : EMPTY_BROKER_LIMIT_CONFIG),
    configKnown: read.config !== null || (existing?.configKnown ?? false),
    state: read.state,
    stateKnown: true,
    stateBlock: args.blockNumber,
    stateTimestamp: args.blockTimestamp,
  });
  args.context.BrokerTradingLimit.set(existing ? { ...existing, ...row } : row);
  return { row, adopted: true };
}

function foldIsCurrent(
  pool: Pick<Pool, "limitStatus" | "limitPressure0" | "limitPressure1">,
  fields: PoolLimitFields,
): boolean {
  return (
    pool.limitStatus === fields.limitStatus &&
    pool.limitPressure0 === fields.limitPressure0 &&
    pool.limitPressure1 === fields.limitPressure1
  );
}

async function refoldPool(
  context: EvmOnEventContext,
  poolId: string,
  rows: readonly BrokerTradingLimit[],
  args: { adopted: boolean; blockNumber: bigint; blockTimestamp: bigint },
): Promise<void> {
  const pool = await context.Pool.get(poolId);
  if (!pool) return;
  const fields = foldPoolLimitFields(rows, pool);
  // Nothing fresh this event: write only when the stored fold is actually out
  // of date. The first fold can land before the pool mirrors its tokens, and
  // nothing else re-folds afterwards; skipping the no-op write keeps an RPC
  // blip from flapping a good homepage status.
  if (!args.adopted && foldIsCurrent(pool, fields)) return;
  // A Broker event is the only writer on this path, so the Pool cursor must
  // advance with it. The dashboard's live/fleet merge reads an equal
  // `updatedAtBlock` as the same indexed state and would keep the old fields.
  context.Pool.set({
    ...pool,
    ...fields,
    updatedAtBlock: args.blockNumber,
    updatedAtTimestamp: args.blockTimestamp,
  });
}

export async function applyBrokerTradingLimits(
  args: BrokerTradingLimitArgs,
): Promise<void> {
  const wrapped = await resolveWrappedExchange(
    args.context,
    args.chainId,
    args.exchangeId,
  );
  if (!wrapped) return;
  const outcomes: LegOutcome[] = [];
  for (const token of args.tokens) {
    outcomes.push(await applyLeg(args, wrapped.poolId, token));
  }
  await refoldPool(
    args.context,
    wrapped.poolId,
    outcomes.map((outcome) => outcome.row),
    {
      adopted: outcomes.some((outcome) => outcome.adopted),
      blockNumber: args.blockNumber,
      blockTimestamp: args.blockTimestamp,
    },
  );
}

// ---------------------------------------------------------------------------
// Broker.TradingLimitConfigured — config from the event, plus one state read
// pinned to the reconfigure block.
// ---------------------------------------------------------------------------

type ConfiguredParams = {
  timestep0: bigint | number;
  timestep1: bigint | number;
  limit0: bigint | number;
  limit1: bigint | number;
  limitGlobal: bigint | number;
  flags: bigint | number;
};

function configFromEvent(params: ConfiguredParams): BrokerLimitConfig {
  return {
    timestep0: BigInt(params.timestep0),
    timestep1: BigInt(params.timestep1),
    limit0: BigInt(params.limit0),
    limit1: BigInt(params.limit1),
    limitGlobal: BigInt(params.limitGlobal),
    flags: Number(params.flags),
  };
}

/** Both legs of the wrapped exchange, with `updated` overriding its stored
 * twin, so the re-fold keeps the other leg's pressure instead of zeroing it. */
async function legRowsForPool(
  context: EvmOnEventContext,
  poolId: string,
  updated: BrokerTradingLimit,
): Promise<BrokerTradingLimit[]> {
  const stored = await context.BrokerTradingLimit.getWhere({
    poolId: { _eq: poolId },
  });
  return [updated, ...stored.filter((row) => row.id !== updated.id)];
}

indexer.onEvent(
  { contract: "Broker", event: "TradingLimitConfigured" },
  async ({ event, context }) => {
    const exchangeId = event.params.exchangeId.toLowerCase();
    const token = asAddress(event.params.token);
    const rowId = brokerTradingLimitRowId(event.chainId, exchangeId, token);
    const wrapped = await resolveWrappedExchange(
      context,
      event.chainId,
      exchangeId,
    );
    if (!wrapped) return;
    const existing = await context.BrokerTradingLimit.get(rowId);
    if (context.isPreload) {
      await Promise.all([
        context.Pool.get(wrapped.poolId),
        context.BrokerTradingLimit.getWhere({
          poolId: { _eq: wrapped.poolId },
        }),
      ]);
      return;
    }

    const config = configFromEvent(event.params.config);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const limitId = brokerLimitId(exchangeId, token);
    // The chain ran `reset()` inside this block, so a read pinned to it returns
    // the post-reset netflow. Sampling it here is what keeps the row from
    // pricing stale netflow against the new limit until the next swap.
    // preload-effect-exempt: TradingLimitConfigured fires once per governance
    // reconfigure, so this processing-only read is bounded, not
    // replay-traffic-scaled.
    const read = await context.effect(brokerTradingLimitEffect, {
      chainId: event.chainId,
      brokerAddress: asAddress(event.srcAddress),
      limitId,
      blockNumber,
      readConfig: false,
    });
    if (!read) {
      context.log.warn(
        `[BrokerTradingLimits] State read failed after TradingLimitConfigured ` +
          `for limitId=${limitId} on chain ${event.chainId} at block ` +
          `${blockNumber}; keeping the local reset mirror and re-reading on ` +
          `the next Broker swap.`,
      );
    }
    const row = buildBrokerTradingLimitRow({
      chainId: event.chainId,
      exchangeId,
      exchangeProvider: existing?.exchangeProvider ?? wrapped.exchangeProvider,
      poolId: wrapped.poolId,
      token,
      config,
      configKnown: true,
      // A null read falls back to mirroring the contract's `reset()` locally,
      // which leaves `stateKnown` as it was and a zero `stateTimestamp` so the
      // next Broker.Swap re-reads.
      state: read
        ? read.state
        : resetBrokerState(
            existing ? brokerLimitStateFromRow(existing) : undefined,
            config,
          ),
      stateKnown: read ? true : (existing?.stateKnown ?? false),
      stateBlock: read ? blockNumber : (existing?.stateBlock ?? 0n),
      stateTimestamp: read ? blockTimestamp : 0n,
      blockNumber,
      blockTimestamp,
    });
    context.BrokerTradingLimit.set(existing ? { ...existing, ...row } : row);
    await refoldPool(
      context,
      wrapped.poolId,
      await legRowsForPool(context, wrapped.poolId, row),
      { adopted: true, blockNumber, blockTimestamp },
    );
  },
);

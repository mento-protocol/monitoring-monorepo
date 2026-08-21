import { ZERO_ADDRESS } from "../constants.js";
import { asAddress, eventId } from "../helpers.js";
import { indexer } from "../indexer.js";
import {
  handleSusdsYieldDailySnapshotHeartbeat,
  handleSusdsYieldLaunchBaseline,
  readSharePrice,
} from "./susds/dailySnapshots.js";
import {
  recordDeposit,
  recordTransfer,
  recordWithdraw,
  shouldProcess,
} from "./susds/movements.js";
import { updateSummary } from "./susds/positions.js";
import {
  ETHEREUM_CHAIN_ID,
  SUSDS_DAILY_SNAPSHOT_BLOCK_INTERVAL,
  TRACKED_SUSDS_WALLETS,
  V3_REVENUE_LAUNCH_BLOCK,
  isTrackedWallet,
  type EventMeta,
} from "./susds/shared.js";

const transferWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { from: address },
  { to: address },
]);
// Deliver deposits initiated by, or minted to, a tracked wallet. The handler
// re-filters by owner because owner receives the shares.
const depositWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { sender: address },
  { owner: address },
]);
const withdrawWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { sender: address },
  { receiver: address },
  { owner: address },
]);
const susdsRegistrationState = globalThis as typeof globalThis & {
  __mentoSusdsYieldEventHandlersRegistered?: boolean;
};

function eventMeta(event: {
  chainId: number;
  block: { number: number; timestamp: number };
  logIndex: number;
  transaction: { hash: string };
}): EventMeta {
  return {
    chainId: event.chainId,
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  };
}

function registerSusdsYieldSamplers(): void {
  indexer.onBlock(
    {
      name: "SusdsLaunchBaseline",
      where: ({ chain }) => {
        if (chain.id !== ETHEREUM_CHAIN_ID) return false;
        const chainEndBlock =
          "endBlock" in chain && typeof chain.endBlock === "number"
            ? chain.endBlock
            : undefined;
        if (
          chainEndBlock !== undefined &&
          chainEndBlock < V3_REVENUE_LAUNCH_BLOCK
        ) {
          return false;
        }
        if (chain.startBlock > V3_REVENUE_LAUNCH_BLOCK) return false;
        return {
          block: {
            number: {
              _gte: V3_REVENUE_LAUNCH_BLOCK,
              _lte: V3_REVENUE_LAUNCH_BLOCK,
            },
          },
        };
      },
    },
    async (args) => {
      await handleSusdsYieldLaunchBaseline(args);
    },
  );

  indexer.onBlock(
    {
      name: "SusdsYieldDailySnapshots",
      where: ({ chain }) =>
        chain.id === ETHEREUM_CHAIN_ID
          ? {
              block: {
                number: {
                  _gte: Math.max(chain.startBlock, V3_REVENUE_LAUNCH_BLOCK),
                  _every: SUSDS_DAILY_SNAPSHOT_BLOCK_INTERVAL,
                },
              },
            }
          : false,
    },
    async (args) => {
      await handleSusdsYieldDailySnapshotHeartbeat(args);
    },
  );
}

export function registerSusdsYieldEventHandlers(): void {
  if (susdsRegistrationState.__mentoSusdsYieldEventHandlersRegistered) {
    return;
  }
  susdsRegistrationState.__mentoSusdsYieldEventHandlersRegistered = true;
  registerSusdsYieldSamplers();

  indexer.onEvent(
    {
      contract: "Susds",
      event: "Deposit",
      where: () => ({ params: depositWhereParams }),
    },
    async ({ event, context }) => {
      const meta = eventMeta(event);
      const owner = asAddress(event.params.owner);
      if (!isTrackedWallet(owner)) return;
      const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
      // preload-handler-note: the tracked-owner predicate is event-derived and
      // identical in both phases; share price is awaited during preload.
      // preload-effect-helpers: readSharePrice
      if (context.isPreload) {
        await readSharePrice(context, meta);
        return;
      }
      if (!(await shouldProcess(context, id))) return;
      const sharePriceUsdWei = await readSharePrice(context, meta);
      await recordDeposit(
        context,
        meta,
        owner,
        event.params.assets,
        event.params.shares,
        sharePriceUsdWei,
      );
      await updateSummary(context, meta, sharePriceUsdWei);
    },
  );

  indexer.onEvent(
    {
      contract: "Susds",
      event: "Withdraw",
      where: () => ({ params: withdrawWhereParams }),
    },
    async ({ event, context }) => {
      const meta = eventMeta(event);
      const owner = asAddress(event.params.owner);
      if (!isTrackedWallet(owner)) return;
      const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
      // preload-handler-note: the tracked-owner predicate is event-derived and
      // identical in both phases; share price is awaited during preload.
      // preload-effect-helpers: readSharePrice
      if (context.isPreload) {
        await readSharePrice(context, meta);
        return;
      }
      if (!(await shouldProcess(context, id))) return;
      const sharePriceUsdWei = await readSharePrice(context, meta);
      await recordWithdraw(context, meta, {
        owner,
        receiver: asAddress(event.params.receiver),
        assets: event.params.assets,
        shares: event.params.shares,
        sharePriceUsdWei,
      });
      await updateSummary(context, meta, sharePriceUsdWei);
    },
  );

  indexer.onEvent(
    {
      contract: "Susds",
      event: "Transfer",
      where: () => ({ params: transferWhereParams }),
    },
    async ({ event, context }) => {
      const from = asAddress(event.params.from);
      const to = asAddress(event.params.to);
      if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) return;
      if (from === to) return;
      const meta = eventMeta(event);
      const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
      // preload-handler-note: the address predicates are event-derived and
      // identical in both phases; share price is awaited during preload.
      // preload-effect-helpers: readSharePrice
      if (context.isPreload) {
        await readSharePrice(context, meta);
        return;
      }
      if (!(await shouldProcess(context, id))) return;
      const sharePriceUsdWei = await readSharePrice(context, meta);
      await recordTransfer(
        context,
        meta,
        from,
        to,
        event.params.value,
        sharePriceUsdWei,
      );
      await updateSummary(context, meta, sharePriceUsdWei);
    },
  );
}

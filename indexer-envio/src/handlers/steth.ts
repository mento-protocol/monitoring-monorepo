import { ZERO_ADDRESS } from "../constants.js";
import { asAddress, eventId } from "../helpers.js";
import { indexer } from "../indexer.js";
import {
  handleStethLaunchBaseline,
  handleStethYieldDailySnapshotHeartbeat,
  recordStethYieldEventDailySnapshots,
} from "./steth/dailySnapshots.js";
import { recordTransfer, shouldProcess } from "./steth/movements.js";
import { updateSummary } from "./steth/positions.js";
import {
  ETHEREUM_CHAIN_ID,
  STETH_DAILY_SNAPSHOT_BLOCK_INTERVAL,
  TRACKED_STETH_WALLETS,
  V3_REVENUE_LAUNCH_BLOCK,
  isTrackedWallet,
  type EventMeta,
} from "./steth/shared.js";

export {
  ETHEREUM_CHAIN_ID,
  FIRST_TRACKED_STETH_BLOCK,
  FIRST_TRACKED_STETH_TX,
  STETH_ADDRESS,
  STETH_DAILY_SNAPSHOT_BLOCK_INTERVAL,
  TRACKED_STETH_WALLETS,
  V3_REVENUE_LAUNCH_BLOCK,
  V3_REVENUE_LAUNCH_TIMESTAMP,
} from "./steth/shared.js";

const transferWhereParams = TRACKED_STETH_WALLETS.flatMap((address) => [
  { from: address },
  { to: address },
]);
const stethRegistrationState = globalThis as typeof globalThis & {
  __mentoStethYieldEventHandlersRegistered?: boolean;
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

if (!stethRegistrationState.__mentoStethYieldEventHandlersRegistered) {
  stethRegistrationState.__mentoStethYieldEventHandlersRegistered = true;
  indexer.onBlock(
    {
      name: "StethLaunchBaseline",
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
      await handleStethLaunchBaseline(args);
    },
  );
  indexer.onBlock(
    {
      name: "StethYieldDailySnapshots",
      where: ({ chain }) =>
        chain.id === ETHEREUM_CHAIN_ID
          ? {
              block: {
                number: {
                  _gte: Math.max(chain.startBlock, V3_REVENUE_LAUNCH_BLOCK),
                  _every: STETH_DAILY_SNAPSHOT_BLOCK_INTERVAL,
                },
              },
            }
          : false,
    },
    async (args) => {
      await handleStethYieldDailySnapshotHeartbeat(args);
    },
  );
  indexer.onEvent(
    {
      contract: "Steth",
      event: "Transfer",
      where: () => ({ params: transferWhereParams }),
    },
    async ({ event, context }) => {
      const from = asAddress(event.params.from);
      const to = asAddress(event.params.to);
      if (from === ZERO_ADDRESS && to === ZERO_ADDRESS) return;
      if (from === to) return;
      if (!isTrackedWallet(from) && !isTrackedWallet(to)) return;
      const meta = eventMeta(event);
      const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
      // preload-handler-note: snapshot writes follow ordered movements; preload-safe
      // balance collection is tracked in #1396.
      // preload-effect-helpers: recordStethYieldEventDailySnapshots
      if (context.isPreload) return;
      if (!(await shouldProcess(context, id))) return;
      if (await recordTransfer(context, meta, from, to, event.params.value)) {
        await updateSummary(context, meta);
        await recordStethYieldEventDailySnapshots(context, meta);
      }
    },
  );
}

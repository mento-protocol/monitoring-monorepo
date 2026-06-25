import { ZERO_ADDRESS } from "../constants.js";
import { asAddress, eventId } from "../helpers.js";
import { indexer } from "../indexer.js";
import {
  handleSusdsYieldDailySnapshotHeartbeat,
  readSharePrice,
  recordSusdsYieldDailySnapshot,
  sharePriceFromAssetsAndShares,
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
  TRACKED_SUSDS_WALLETS,
  isTrackedWallet,
  type EventMeta,
} from "./susds/shared.js";

export {
  ETHEREUM_CHAIN_ID,
  SUSDS_ADDRESS,
  TRACKED_SUSDS_WALLETS,
  V3_REVENUE_LAUNCH_TIMESTAMP,
} from "./susds/shared.js";
export {
  handleSusdsYieldDailySnapshotHeartbeat,
  recordSusdsYieldDailySnapshot,
  recordSusdsYieldHeartbeatSnapshot,
} from "./susds/dailySnapshots.js";

const SUSDS_DAILY_HEARTBEAT_BLOCK_INTERVAL = 300;

const transferWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { from: address },
  { to: address },
]);
const depositWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { sender: address },
  { owner: address },
]);
const withdrawWhereParams = TRACKED_SUSDS_WALLETS.flatMap((address) => [
  { sender: address },
  { receiver: address },
  { owner: address },
]);

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
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    const sharePriceUsdWei = await readSharePrice(
      context,
      meta,
      sharePriceFromAssetsAndShares(event.params.assets, event.params.shares),
    );
    await recordDeposit(
      context,
      meta,
      owner,
      event.params.assets,
      event.params.shares,
      sharePriceUsdWei,
    );
    const totals = await updateSummary(context, meta, sharePriceUsdWei);
    await recordSusdsYieldDailySnapshot(
      context,
      meta,
      sharePriceUsdWei,
      totals,
    );
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
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    const sharePriceUsdWei = await readSharePrice(
      context,
      meta,
      sharePriceFromAssetsAndShares(event.params.assets, event.params.shares),
    );
    await recordWithdraw(context, meta, {
      owner,
      receiver: asAddress(event.params.receiver),
      assets: event.params.assets,
      shares: event.params.shares,
      sharePriceUsdWei,
    });
    const totals = await updateSummary(context, meta, sharePriceUsdWei);
    await recordSusdsYieldDailySnapshot(
      context,
      meta,
      sharePriceUsdWei,
      totals,
    );
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
    if (context.isPreload) return;
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
    const totals = await updateSummary(context, meta, sharePriceUsdWei);
    await recordSusdsYieldDailySnapshot(
      context,
      meta,
      sharePriceUsdWei,
      totals,
    );
  },
);

indexer.onBlock(
  {
    name: "SusdsYieldDailySnapshotHeartbeat",
    where: ({ chain }) =>
      chain.id === ETHEREUM_CHAIN_ID
        ? {
            block: {
              number: {
                _gte: chain.startBlock,
                _every: SUSDS_DAILY_HEARTBEAT_BLOCK_INTERVAL,
              },
            },
          }
        : false,
  },
  async ({ block, context }) => {
    await handleSusdsYieldDailySnapshotHeartbeat({ block, context });
  },
);

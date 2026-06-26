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
import { SUSDS_FIRST_TRACKED_EVENT_BLOCK } from "../startupChecks.js";

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

export const SUSDS_DAILY_HEARTBEAT_BLOCK_INTERVAL = 1_000;
export const SUSDS_DAILY_HEARTBEAT_START_BLOCK =
  SUSDS_FIRST_TRACKED_EVENT_BLOCK;

type ChainFilterInput = {
  id: number | string;
  startBlock: number | string;
  endBlock?: number | string | undefined;
};

function finiteNumber(value: number | string | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function susdsDailySnapshotHeartbeatFilter(chain: ChainFilterInput) {
  if (finiteNumber(chain.id) !== ETHEREUM_CHAIN_ID) return false;
  const chainStartBlock = finiteNumber(chain.startBlock);
  if (chainStartBlock == null) return false;
  return {
    block: {
      number: {
        _gte: Math.max(SUSDS_DAILY_HEARTBEAT_START_BLOCK, chainStartBlock),
        _every: SUSDS_DAILY_HEARTBEAT_BLOCK_INTERVAL,
      },
    },
  };
}

export function ethereumReserveYieldStartAnchorFilter(chain: ChainFilterInput) {
  if (finiteNumber(chain.id) !== ETHEREUM_CHAIN_ID) return false;
  const chainStartBlock = finiteNumber(chain.startBlock);
  if (chainStartBlock == null) return false;
  return {
    block: {
      number: {
        _gte: chainStartBlock,
        _lte: chainStartBlock,
      },
    },
  };
}

function blockTimestamp(block: {
  readonly number: number | bigint;
  readonly timestamp?: number | bigint;
}): bigint {
  return BigInt(block.timestamp ?? 0);
}

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

async function readEventSharePrice(
  context: Parameters<typeof readSharePrice>[0],
  meta: Parameters<typeof readSharePrice>[1],
  assets: bigint,
  shares: bigint,
): Promise<bigint> {
  const eventSharePrice = sharePriceFromAssetsAndShares(assets, shares);
  return readSharePrice(context, meta, eventSharePrice);
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
    if (event.params.shares <= 0n) return;
    const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    const sharePriceUsdWei = await readEventSharePrice(
      context,
      meta,
      event.params.assets,
      event.params.shares,
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
    if (event.params.shares <= 0n) return;
    const id = eventId(meta.chainId, Number(meta.blockNumber), meta.logIndex);
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    const sharePriceUsdWei = await readEventSharePrice(
      context,
      meta,
      event.params.assets,
      event.params.shares,
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
    if (event.params.value <= 0n) return;
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
    name: "EthereumReserveYieldStartAnchor",
    where: ({ chain }) => ethereumReserveYieldStartAnchorFilter(chain),
  },
  async ({ block, context }) => {
    context.EthereumReserveYieldAnchor.set({
      id: `${ETHEREUM_CHAIN_ID}-reserve-yield-start`,
      chainId: ETHEREUM_CHAIN_ID,
      blockNumber: BigInt(block.number),
      blockTimestamp: blockTimestamp(block),
    });
  },
);

indexer.onBlock(
  {
    name: "SusdsYieldDailySnapshotHeartbeat",
    where: ({ chain }) => susdsDailySnapshotHeartbeatFilter(chain),
  },
  async ({ block, context }) => {
    await handleSusdsYieldDailySnapshotHeartbeat({ block, context });
  },
);

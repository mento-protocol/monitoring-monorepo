import { ZERO_ADDRESS } from "../constants.js";
import { asAddress, eventId } from "../helpers.js";
import { indexer } from "../indexer.js";
import { recordTransfer, shouldProcess } from "./steth/movements.js";
import { updateSummary } from "./steth/positions.js";
import {
  TRACKED_STETH_WALLETS,
  isTrackedWallet,
  type EventMeta,
} from "./steth/shared.js";

export {
  ETHEREUM_CHAIN_ID,
  FIRST_TRACKED_STETH_BLOCK,
  FIRST_TRACKED_STETH_TX,
  STETH_ADDRESS,
  TRACKED_STETH_WALLETS,
} from "./steth/shared.js";

const transferWhereParams = TRACKED_STETH_WALLETS.flatMap((address) => [
  { from: address },
  { to: address },
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
    if (context.isPreload) return;
    if (!(await shouldProcess(context, id))) return;
    if (await recordTransfer(context, meta, from, to, event.params.value)) {
      await updateSummary(context, meta);
    }
  },
);

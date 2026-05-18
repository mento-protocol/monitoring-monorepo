import { indexer } from "../../indexer.js";
import { ZERO_ADDRESS } from "../../constants.js";
import { asAddress, asBigInt } from "../../helpers.js";
import { findLiquityMarketByEventSource, makeCollateralId } from "./config.js";
import { getOrCreateTrove, updateBorrowerCount } from "./troves.js";

indexer.onEvent(
  { contract: "LiquityTroveNFT", event: "Transfer" },
  async ({ event, context }) => {
    const market = findLiquityMarketByEventSource(
      event.chainId,
      event.srcAddress,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const blockNumber = asBigInt(event.block.number);
    const blockTimestamp = asBigInt(event.block.timestamp);
    const from = asAddress(event.params.from);
    const to = asAddress(event.params.to);
    const trove = await getOrCreateTrove(context, {
      chainId: event.chainId,
      collateralId,
      troveId: event.params.tokenId,
      blockNumber,
      blockTimestamp,
      txHash: event.transaction.hash,
    });

    if (from === ZERO_ADDRESS) {
      context.Trove.set({
        ...trove,
        owner: to,
        lastUpdatedAt: blockTimestamp,
        lastUpdatedBlock: blockNumber,
      });
      await updateBorrowerCount(context, event.chainId, to, collateralId, 1);
      return;
    }

    if (to === ZERO_ADDRESS) {
      context.Trove.set({
        ...trove,
        previousOwner: trove.owner,
        owner: ZERO_ADDRESS,
        lastUpdatedAt: blockTimestamp,
        lastUpdatedBlock: blockNumber,
      });
      await updateBorrowerCount(context, event.chainId, from, collateralId, -1);
      return;
    }

    context.Trove.set({
      ...trove,
      previousOwner: trove.owner,
      owner: to,
      lastUpdatedAt: blockTimestamp,
      lastUpdatedBlock: blockNumber,
    });
    await updateBorrowerCount(context, event.chainId, from, collateralId, -1);
    await updateBorrowerCount(context, event.chainId, to, collateralId, 1);
  },
);

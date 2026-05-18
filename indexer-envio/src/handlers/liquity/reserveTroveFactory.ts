import { indexer } from "../../indexer.js";
import { asAddress, asBigInt } from "../../helpers.js";
import {
  findLiquityMarketByAddressesRegistry,
  makeCollateralId,
} from "./config.js";

indexer.onEvent(
  { contract: "ReserveTroveFactory", event: "ReserveTroveCreated" },
  async ({ event, context }) => {
    const addressesRegistry = asAddress(event.params.addressesRegistry);
    const market = findLiquityMarketByAddressesRegistry(
      event.chainId,
      addressesRegistry,
    );
    if (market === undefined) return;
    const collateralId = makeCollateralId(market);
    const troveId = `0x${event.params.troveId.toString(16)}`;
    context.ReserveTrove.set({
      id: `${event.chainId}-${addressesRegistry}-${troveId}`,
      chainId: event.chainId,
      collateralId,
      poolId: undefined,
      addressesRegistry,
      troveId,
      initialDebt: event.params.debtAmount,
      initialColl: event.params.collateralAmount,
      createdAtBlock: asBigInt(event.block.number),
      createdAtTimestamp: asBigInt(event.block.timestamp),
      createdTxHash: event.transaction.hash,
    });
  },
);

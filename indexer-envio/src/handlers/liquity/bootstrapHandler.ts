import { indexer } from "../../indexer.js";
import { bootstrapCollaterals } from "./bootstrap.js";
import { LIQUITY_MARKETS } from "./config.js";

const LIQUITY_CHAIN_IDS = new Set(
  LIQUITY_MARKETS.map((market) => market.chainId),
);

indexer.onBlock(
  {
    name: "LiquityBootstrapCollaterals",
    where: ({ chain }) =>
      LIQUITY_CHAIN_IDS.has(chain.id)
        ? {
            block: {
              number: { _gte: chain.startBlock, _lte: chain.startBlock },
            },
          }
        : false,
    // Envio passes onBlock handlers only `number` plus the fields selected
    // here. Before 3.15 there was no selection, so `timestamp` was absent and
    // `createdAtTimestamp` was written as 0.
    fields: { block: ["timestamp"] },
  },
  async ({ block, context }) => {
    await bootstrapCollaterals(
      context,
      BigInt(block.number),
      BigInt(block.timestamp),
    );
  },
);

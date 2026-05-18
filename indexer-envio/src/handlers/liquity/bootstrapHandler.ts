import { indexer } from "../../indexer.js";
import { bootstrapCollaterals } from "./bootstrap.js";
import { LIQUITY_MARKETS } from "./config.js";

const LIQUITY_CHAIN_IDS = new Set(
  LIQUITY_MARKETS.map((market) => market.chainId),
);

type BlockWithTimestamp = {
  readonly number: number;
  readonly timestamp?: number;
};

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
  },
  async ({ block, context }) => {
    const blockWithTimestamp = block as BlockWithTimestamp;
    await bootstrapCollaterals(
      context,
      BigInt(block.number),
      BigInt(blockWithTimestamp.timestamp ?? 0),
    );
  },
);

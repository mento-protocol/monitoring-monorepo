// ===========================================================================
// EventHandlers.ts — Envio entry point
//
// CONSTRAINT: Every config.*.yaml specifies `handler: src/EventHandlers.ts`.
// Envio expects handler registrations to originate from this file. All handler
// modules are imported below; their registrations fire at module load time.
// ===========================================================================

// ---------------------------------------------------------------------------
// Startup invariant: fail loudly if ENVIO_START_BLOCK is set above the
// FPMMFactory's first deployment block for any chain. If start_block is too
// high, FPMMDeployed events are never seen, contractRegister never fires,
// and all pool events are silently dropped — no error, just missing data.
//
// First factory deployment blocks (inclusive):
//   Celo mainnet (42220):  60668100 — initial batch of 4 FPMM pools
//   Monad mainnet (143):   60759432 — initial batch of 3 FPMM pools
//   Celo Sepolia (11142220): ~18946570 — testnet deployment
//   Monad testnet (10143): ~17932599 — testnet FPMMFactory deployment
// ---------------------------------------------------------------------------
const FPMM_FIRST_DEPLOY_BLOCK: Record<number, number> = {
  42220: 60668100, // Celo mainnet
  143: 60759432, // Monad mainnet
  11142220: 18946570, // Celo Sepolia
  10143: 17932599, // Monad testnet
};

const START_BLOCK_ENV: Record<number, string | undefined> = {
  42220: process.env.ENVIO_START_BLOCK_CELO,
  143: process.env.ENVIO_START_BLOCK_MONAD,
  11142220: process.env.ENVIO_START_BLOCK,
  10143: process.env.ENVIO_START_BLOCK,
};

for (const [chainIdStr, firstDeployBlock] of Object.entries(
  FPMM_FIRST_DEPLOY_BLOCK,
)) {
  const chainId = Number(chainIdStr);
  const envVal = START_BLOCK_ENV[chainId];
  if (envVal !== undefined && envVal !== "") {
    const startBlock = Number(envVal);
    if (!Number.isFinite(startBlock)) continue;
    if (startBlock > firstDeployBlock) {
      throw new Error(
        `[EventHandlers] FATAL: start block for chain ${chainId} is ${startBlock}, ` +
          `but FPMMFactory first deployed at block ${firstDeployBlock}. ` +
          `All factory deploy events will be missed and no pools will be indexed. ` +
          `Lower ENVIO_START_BLOCK${chainId === 42220 ? "_CELO" : chainId === 143 ? "_MONAD" : ""} ` +
          `to ≤${firstDeployBlock} or remove the override.`,
      );
    }
  }
}

// Handler registrations (side-effect imports)
import "./handlers/fpmm";
import "./handlers/sortedOracles";
import "./handlers/virtualPool";
import "./handlers/feeToken";
import "./handlers/openLiquidityStrategy";

// ---------------------------------------------------------------------------
// Re-exports for backwards compatibility with existing tests.
// Tests import from "../src/EventHandlers" — these re-exports ensure that
// all existing import paths continue to work without modification.
// ---------------------------------------------------------------------------

// RPC test mocks
export {
  _setMockRebalancingState,
  _clearMockRebalancingStates,
  _setMockReserves,
  _clearMockReserves,
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
  _setMockRateFeedID,
  _clearMockRateFeedIDs,
  _setMockReportExpiry,
  _clearMockReportExpiry,
} from "./rpc";

// Fee token test mocks and helpers
export {
  _setMockFeeTokenMeta,
  _clearMockFeeTokenMeta,
  _clearBackfilledTokens,
  _clearFeeTokenMetaCache,
  selectStaleTransfers,
} from "./feeToken";

// Price math (used by priceDifference.test.ts, decimals.test.ts)
export {
  computePriceDifference,
  normalizeTo18,
  scalingFactorToDecimals,
} from "./priceDifference";

// Trading limits constant (used by decimals.test.ts)
export { TRADING_LIMITS_INTERNAL_DECIMALS } from "./tradingLimits";

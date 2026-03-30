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
// First factory deployment blocks for production mainnet chains only.
// We only validate mainnet chains here to avoid false-fatal errors when a
// testnet env var (e.g. ENVIO_START_BLOCK_MONAD_TESTNET) is left set in
// .env from a previous testnet run — that should never block a mainnet start.
// Testnet configs are dev-only and not deployed to hosted Envio production.
//
// Celo mainnet (42220):  60668100 — initial batch of 4 FPMM pools
// Monad mainnet (143):   60759432 — initial batch of 3 FPMM pools
// ---------------------------------------------------------------------------
export const FPMM_FIRST_DEPLOY_BLOCK: Record<number, number> = {
  42220: 60668100, // Celo mainnet
  143: 60759432, // Monad mainnet
};

// Each mainnet chain maps to its dedicated env var.
export const START_BLOCK_ENV_NAME: Record<number, string> = {
  42220: "ENVIO_START_BLOCK_CELO",
  143: "ENVIO_START_BLOCK_MONAD",
};

/**
 * Validate that no ENVIO_START_BLOCK_* env var is set above the first
 * FPMMFactory deployment block for its chain. If it is, all factory deploy
 * events are missed and no pools are ever registered — a silent data loss.
 *
 * Exported for testing. Called at module load time below.
 */
export function assertStartBlocksValid(
  envOverrides: Record<number, string | undefined>,
): void {
  for (const [chainIdStr, firstDeployBlock] of Object.entries(
    FPMM_FIRST_DEPLOY_BLOCK,
  )) {
    const chainId = Number(chainIdStr);
    const envVal = envOverrides[chainId];
    if (envVal === undefined || envVal === "") continue;
    const startBlock = Number(envVal);
    if (!Number.isFinite(startBlock)) continue;
    if (startBlock > firstDeployBlock) {
      const envVarName = START_BLOCK_ENV_NAME[chainId];
      throw new Error(
        `[EventHandlers] FATAL: start block for chain ${chainId} is ${startBlock}, ` +
          `but FPMMFactory first deployed at block ${firstDeployBlock}. ` +
          `All factory deploy events will be missed and no pools will be indexed. ` +
          `Lower ${envVarName} to ≤${firstDeployBlock} or remove the override.`,
      );
    }
  }
}

// Run the check at startup with mainnet env var values only.
assertStartBlocksValid({
  42220: process.env.ENVIO_START_BLOCK_CELO,
  143: process.env.ENVIO_START_BLOCK_MONAD,
});

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

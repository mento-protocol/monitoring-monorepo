// ===========================================================================
// EventHandlers.ts — Envio entry point (primary, full multichain configs)
//
// Both `config.multichain.mainnet.yaml` and `config.multichain.testnet.yaml`
// declare `handler: src/EventHandlers.ts`, so every handler registration in
// this file fires at module load time for those configs.
//
// ===========================================================================

import { runStartupChecks } from "./startupChecks.js";

// Run startup invariant checks (skipped in NODE_ENV=test).
// See src/startupChecks.ts for details and rationale.
runStartupChecks();

// Effect registrations (side-effect import — registers RPC effects
// with the Envio runtime so they're available via `context.effect(...)`).
import "./rpc/effects.js";

// Handler registrations (side-effect imports)
import "./handlers/broker.js";
import "./handlers/fpmm.js";
import "./handlers/fpmm/factory.js";
import "./handlers/fpmm/liquidity.js";
import "./handlers/fpmm/state-sync.js";
import "./handlers/fpmm/limits-and-fees.js";
import "./handlers/rateFeed.js";
import "./handlers/sortedOracles.js";
import "./handlers/virtualPool.js";
import "./handlers/biPoolManager.js";
import "./handlers/feeToken.js";
import "./handlers/stables/transfer.js";
import "./handlers/openLiquidityStrategy.js";
import "./handlers/liquity/collateralRegistry.js";
import "./handlers/liquity/bootstrapHandler.js";
import "./handlers/liquity/troveManager.js";
import "./handlers/liquity/stabilityPool.js";
import "./handlers/liquity/troveNFT.js";
import "./handlers/liquity/borrowerOperations.js";
import "./handlers/liquity/cdpLiquidityStrategy.js";
import "./handlers/liquity/reserveTroveFactory.js";
import "./handlers/liquity/pools.js";
import "./handlers/breakerBox.js";
import "./handlers/medianDeltaBreaker.js";
import "./handlers/valueDeltaBreaker.js";
import "./handlers/wormhole/nttManager.js";
import "./handlers/wormhole/wormholeTransceiver.js";

// ---------------------------------------------------------------------------
// Re-exports for backwards compatibility with existing tests.
// Tests import from "../src/EventHandlers.js" — these re-exports ensure that
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
  _setMockTokenDecimalsScaling,
  _clearMockTokenDecimalsScaling,
  _setMockRebalanceThresholds,
  _clearMockRebalanceThresholds,
  _setMockRateFeedID,
  _clearMockRateFeedIDs,
  _setMockReportExpiry,
  _clearMockReportExpiry,
  _setMockRateFeedOracles,
  _clearMockRateFeedOracles,
  _setMockFees,
  _clearMockFees,
  _setMockBreakerKind,
  _setMockBreakerDefaults,
  _setMockBreakerFeedState,
  _setMockBreakerList,
  _clearBreakerMocks,
  _setMockPoolExchange,
  _clearMockPoolExchanges,
  _setMockVpExchangeId,
  _clearMockVpExchangeIds,
} from "./rpc.js";

export { _clearBootstrapCaches } from "./breakers.js";

export {
  _setMockStableTotalSupply,
  _clearMockStableTotalSupply,
} from "./rpc/stable-fetchers.js";

// Fee token test mocks and helpers
export {
  _setMockFeeTokenMeta,
  _clearMockFeeTokenMeta,
  _clearBackfilledTokens,
  _clearFeeTokenMetaCache,
  _addMockAllowedFeeToken,
  _clearMockAllowedFeeTokens,
  selectStaleTransfers,
  resolveFeeTokenMeta,
  isKnownFeeToken,
} from "./feeToken.js";

// Price math (used by priceDifference.test.ts, decimals.test.ts)
export {
  computePriceDifference,
  hasDegenerateReserves,
  normalizeTo18,
  scalingFactorToDecimals,
} from "./priceDifference.js";

// Trading limits constant (used by decimals.test.ts)
export { TRADING_LIMITS_INTERNAL_DECIMALS } from "./tradingLimits.js";

// Startup checks (used by startBlockInvariant.test.ts)
export {
  assertStartBlocksValid,
  FPMM_FIRST_DEPLOY_BLOCK,
  START_BLOCK_ENV_NAME,
} from "./startupChecks.js";

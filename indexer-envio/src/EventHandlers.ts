// ===========================================================================
// EventHandlers.ts — Envio entry point.
//
// Both `config.multichain.mainnet.yaml` and `config.multichain.testnet.yaml`
// declare `handler: src/EventHandlers.ts`, so every handler registration in
// this file fires at module load time.
// ===========================================================================

import { runStartupChecks } from "./startupChecks.js";

// Run startup invariant checks (skipped in NODE_ENV=test).
// See src/startupChecks.ts for details and rationale.
runStartupChecks();

// Effect registrations (side-effect import — registers the 16 RPC effects
// with the Envio runtime so they're available via `context.effect(...)`).
import "./rpc/effects.js";

// Handler registrations (side-effect imports)
import "./handlers/broker.js";
import "./handlers/fpmm.js";
import "./handlers/fpmm/factory.js";
import "./handlers/fpmm/liquidity.js";
import "./handlers/fpmm/state-sync.js";
import "./handlers/fpmm/limits-and-fees.js";
import "./handlers/sortedOracles.js";
import "./handlers/virtualPool.js";
import "./handlers/feeToken.js";
import "./handlers/openLiquidityStrategy.js";
import "./handlers/breakerBox.js";
import "./handlers/medianDeltaBreaker.js";
import "./handlers/valueDeltaBreaker.js";
import "./handlers/wormhole/nttManager.js";
import "./handlers/wormhole/wormholeTransceiver.js";

// ---------------------------------------------------------------------------
// Re-exports for the active vitest suites that import RPC/fee-token mock
// helpers and bootstrap-cache resetters from "../src/EventHandlers.js".
// The 19 v2 MockDb-pattern tests quarantined in vitest.config.ts won't need
// these once they migrate to msw-based mocking (BACKLOG.md), at which point
// most of these re-exports can be dropped.
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
  _setMockFees,
  _clearMockFees,
  _setMockBreakerKind,
  _setMockBreakerDefaults,
  _setMockBreakerFeedState,
  _setMockBreakerList,
  _clearBreakerMocks,
} from "./rpc.js";

export { _clearBootstrapCaches } from "./breakers.js";

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

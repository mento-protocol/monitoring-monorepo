// ===========================================================================
// EventHandlers.ts — Envio entry point (primary, full multichain configs)
//
// Both `config.multichain.mainnet.yaml` and `config.multichain.testnet.yaml`
// declare `handler: src/EventHandlers.ts`, so every handler registration in
// this file fires at module load time for those configs.
//
// The bridge-only local harness (`config.multichain.bridge-only.yaml`) uses a
// separate entry point — `src/EventHandlersBridgeOnly.ts`. Keep the Wormhole
// handler imports at the bottom of this file in sync with the imports there.
// ===========================================================================

import { runStartupChecks } from "./startupChecks";

// Run startup invariant checks (skipped in NODE_ENV=test).
// See src/startupChecks.ts for details and rationale.
runStartupChecks();

// Handler registrations (side-effect imports)
import "./handlers/fpmm";
import "./handlers/sortedOracles";
import "./handlers/virtualPool";
import "./handlers/feeToken";
import "./handlers/openLiquidityStrategy";
import "./handlers/wormhole/nttManager";
import "./handlers/wormhole/wormholeTransceiver";

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
  resolveFeeTokenMeta,
} from "./feeToken";

// Price math (used by priceDifference.test.ts, decimals.test.ts)
export {
  computePriceDifference,
  normalizeTo18,
  scalingFactorToDecimals,
} from "./priceDifference";

// Trading limits constant (used by decimals.test.ts)
export { TRADING_LIMITS_INTERNAL_DECIMALS } from "./tradingLimits";

// Startup checks (used by startBlockInvariant.test.ts)
export {
  assertStartBlocksValid,
  FPMM_FIRST_DEPLOY_BLOCK,
  START_BLOCK_ENV_NAME,
} from "./startupChecks";

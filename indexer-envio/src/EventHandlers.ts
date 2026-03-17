// ===========================================================================
// EventHandlers.ts — Envio entry point
//
// CONSTRAINT: Every config.*.yaml specifies `handler: src/EventHandlers.ts`.
// Envio expects handler registrations to originate from this file. All handler
// modules are imported below; their registrations fire at module load time.
// ===========================================================================

// Handler registrations (side-effect imports)
import "./handlers/fpmm";
import "./handlers/sortedOracles";
import "./handlers/virtualPool";
import "./handlers/feeToken";

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

// ---------------------------------------------------------------------------
// ABI definitions and contract wrappers
// ---------------------------------------------------------------------------

import _sortedOraclesAbi from "@mento-protocol/contracts/abis/SortedOracles.json" with { type: "json" };
import { requireContractAddress } from "./contractAddresses.js";

export const SortedOraclesContract = {
  /** Returns the SortedOracles address for the given chainId, throwing if missing. */
  address: (chainId: number): `0x${string}` =>
    requireContractAddress(chainId, "SortedOracles"),
  abi: _sortedOraclesAbi,
};

export const FPMM_TRADING_LIMITS_ABI = [
  {
    type: "function",
    name: "getTradingLimits",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "config",
        type: "tuple",
        components: [
          { name: "limit0", type: "int120" },
          { name: "limit1", type: "int120" },
          { name: "decimals", type: "uint8" },
        ],
      },
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "lastUpdated0", type: "uint32" },
          { name: "lastUpdated1", type: "uint32" },
          { name: "netflow0", type: "int96" },
          { name: "netflow1", type: "int96" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

export const FPMM_FEE_ABI = [
  {
    type: "function",
    name: "lpFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "protocolFee",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rebalanceIncentive",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const FPMM_MINIMAL_ABI = [
  {
    type: "function",
    name: "getReserves",
    inputs: [],
    outputs: [
      { name: "_reserve0", type: "uint256" },
      { name: "_reserve1", type: "uint256" },
      { name: "_blockTimestampLast", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals0",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals1",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rebalanceThresholdAbove",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rebalanceThresholdBelow",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRebalancingState",
    inputs: [],
    outputs: [
      { name: "oraclePriceNumerator", type: "uint256" },
      { name: "oraclePriceDenominator", type: "uint256" },
      { name: "reservePriceNumerator", type: "uint256" },
      { name: "reservePriceDenominator", type: "uint256" },
      { name: "reservePriceAboveOraclePrice", type: "bool" },
      { name: "rebalanceThreshold", type: "uint16" },
      { name: "priceDifference", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "referenceRateFeedID",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "invertRateFeed",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

// ---------------------------------------------------------------------------
// Breakers — minimal inline ABIs for RPC self-heal and bootstrap reads.
// Event indexing uses the full vendored ABIs at indexer-envio/abis/.
// ---------------------------------------------------------------------------

/** BreakerBox getters used by RPC self-heal. */
export const BREAKER_BOX_ABI = [
  {
    type: "function",
    name: "breakerTradingMode",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rateFeedBreakerStatus",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [
      { name: "tradingMode", type: "uint8" },
      { name: "lastUpdatedTime", type: "uint64" },
      { name: "enabled", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rateFeedTradingMode",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const;

/** MedianDeltaBreaker getters used by RPC self-heal. `value`-named outputs are
 * Fixidity-wrapped uint256 (1e24 = 100%) — viem decodes as plain bigint. */
export const MEDIAN_DELTA_BREAKER_ABI = [
  {
    type: "function",
    name: "defaultCooldownTime",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "defaultRateChangeThreshold",
    inputs: [],
    outputs: [{ name: "value", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rateFeedCooldownTime",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rateChangeThreshold",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "value", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "smoothingFactors",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "value", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "medianRatesEMA",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** ValueDeltaBreaker getters used by RPC self-heal. */
export const VALUE_DELTA_BREAKER_ABI = [
  {
    type: "function",
    name: "defaultCooldownTime",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "defaultRateChangeThreshold",
    inputs: [],
    outputs: [{ name: "value", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rateFeedCooldownTime",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rateChangeThreshold",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "value", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "referenceValues",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export const ERC20_DECIMALS_ABI = [
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const;

// Used by `fetchStableTotalSupply` to seed the stable supply baseline
// from on-chain at the block before the first observed Transfer event.
// Inline minimal ABI rather than vendoring a full StableToken ABI for the
// same reason as ERC20_DECIMALS_ABI above — keeps the read site type-safe
// without importing 1000+ lines of unrelated event signatures.
export const ERC20_TOTAL_SUPPLY_ABI = [
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// Used by `fetchStableBalanceOf` to seed the NTT lock-custody baseline
// from on-chain at the block before the first observed manager lock/unlock
// Transfer event.
export const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ---------------------------------------------------------------------------
// BiPoolManager — getPoolExchange backfill
//
// `BiPoolManager.ExchangeCreated` carries asset0/asset1/pricingModule but NOT
// the rest of the PoolExchange struct (spread, referenceRateFeedID, reset
// frequency, …). Those land via the BiPoolManager.PoolConfig sub-events
// (SpreadUpdated, BucketsUpdated) AFTER ExchangeCreated, but governance can
// also call `setExchangeConfig` between create and first bucket update —
// leaving the indexer's row stubbed (zeros) for that gap. To populate fully
// at create time we read the struct directly via `getPoolExchange` once.
//
// Inline minimal ABI rather than the vendored full ABI at indexer-envio/abis/
// to mirror the FPMM_*_ABI pattern; keeps the read site type-safe without
// importing 1000 lines of unrelated event signatures.
// ---------------------------------------------------------------------------

export const BI_POOL_MANAGER_GET_POOL_EXCHANGE_ABI = [
  {
    type: "function",
    name: "getPoolExchange",
    inputs: [{ name: "exchangeId", type: "bytes32" }],
    outputs: [
      {
        name: "exchange",
        type: "tuple",
        components: [
          { name: "asset0", type: "address" },
          { name: "asset1", type: "address" },
          { name: "pricingModule", type: "address" },
          { name: "bucket0", type: "uint256" },
          { name: "bucket1", type: "uint256" },
          { name: "lastBucketUpdate", type: "uint256" },
          {
            name: "config",
            type: "tuple",
            components: [
              {
                name: "spread",
                type: "tuple",
                components: [{ name: "value", type: "uint256" }],
              },
              { name: "referenceRateFeedID", type: "address" },
              { name: "referenceRateResetFrequency", type: "uint256" },
              { name: "minimumReports", type: "uint256" },
              { name: "stablePoolResetSize", type: "uint256" },
            ],
          },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

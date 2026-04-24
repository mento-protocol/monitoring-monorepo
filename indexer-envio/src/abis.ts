// ---------------------------------------------------------------------------
// ABI definitions and contract wrappers
// ---------------------------------------------------------------------------

import _sortedOraclesAbi from "@mento-protocol/contracts/abis/SortedOracles.json";
import { requireContractAddress } from "./contractAddresses";

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

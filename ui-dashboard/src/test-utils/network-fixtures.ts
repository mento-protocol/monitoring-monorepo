import type { NetworkData } from "@/hooks/use-all-networks-data";
import type { Network } from "@/lib/networks";
import type { Pool, PoolSnapshotWindow } from "@/lib/types";

export const BASE_NETWORK: Network = {
  id: "celo-mainnet",
  label: "Celo",
  chainId: 42220,
  contractsNamespace: null,
  hasuraUrl: "https://mainnet.example.com/v1/graphql",
  hasuraSecret: "",
  explorerBaseUrl: "https://celoscan.io",
  tokenSymbols: {},
  addressLabels: {},
  local: false,
  hasVirtualPools: false,
  testnet: false,
};

export const NETWORK_2: Network = {
  ...BASE_NETWORK,
  id: "celo-sepolia",
  label: "Celo Sepolia",
  chainId: 11142220,
};

// USDm/KESm symbols paired with a 1e24 oracle price in makeTvlPool give both
// legs a $1 price, so poolTvlUSD = r0 + r1 — arithmetic in TVL tests stays trivial.
export const TVL_NETWORK: Network = {
  ...BASE_NETWORK,
  tokenSymbols: {
    "0xtoken0": "USDm",
    "0xtoken1": "KESm",
  },
};

export const TVL_NETWORK_2: Network = {
  ...TVL_NETWORK,
  id: "celo-sepolia",
  label: "Celo Sepolia",
  chainId: 11142220,
};

export function makeTvlPool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "pool-a",
    chainId: 42220,
    token0: "0xtoken0",
    token1: "0xtoken1",
    token0Decimals: 18,
    token1Decimals: 18,
    oraclePrice: "1000000000000000000000000",
    source: "FPMM",
    createdAtBlock: "0",
    createdAtTimestamp: "0",
    updatedAtBlock: "0",
    updatedAtTimestamp: "0",
    reserves0: "0",
    reserves1: "0",
    ...overrides,
  };
}

type SnapshotOverrides = Partial<
  Omit<PoolSnapshotWindow, "timestamp" | "reserves0" | "reserves1">
> & {
  timestamp?: number | string;
  reserves0?: number | string;
  reserves1?: number | string;
};

export function makeSnapshot(
  overrides: SnapshotOverrides = {},
): PoolSnapshotWindow {
  const {
    poolId = "pool-a",
    timestamp = "0",
    reserves0 = "0",
    reserves1 = "0",
    swapCount = 0,
    swapVolume0 = "0",
    swapVolume1 = "0",
  } = overrides;
  return {
    poolId,
    timestamp: String(timestamp),
    reserves0: String(reserves0),
    reserves1: String(reserves1),
    swapCount,
    swapVolume0,
    swapVolume1,
  };
}

export function makeNetworkData(
  overrides: Partial<NetworkData> = {},
): NetworkData {
  return {
    network: BASE_NETWORK,
    pools: [],
    snapshots: [],
    snapshots7d: [],
    snapshots30d: [],
    fees: null,
    uniqueLpAddresses: [],
    rates: new Map(),
    error: null,
    feesError: null,
    snapshotsError: null,
    snapshots7dError: null,
    snapshots30dError: null,
    lpError: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Network definitions — add new chains here
// ---------------------------------------------------------------------------

import contractsData from "@mento-protocol/contracts/contracts.json";

// Official treb deployment namespace per chain — update when a new deployment is promoted.
// These must match the namespace keys in @mento-protocol/contracts contracts.json.
const ACTIVE_DEPLOYMENT = {
  "celo-sepolia": "testnet-v2-rc5",
  "celo-mainnet": "mainnet",
} as const satisfies Record<string, string | null>;

export type IndexerNetworkId =
  | "devnet"
  | "celo-sepolia-local"
  | "celo-sepolia-hosted"
  | "celo-mainnet-local"
  | "celo-mainnet-hosted";

export type Network = {
  id: IndexerNetworkId;
  label: string;
  chainId: number;
  /** Treb deployment namespace in @mento-protocol/contracts backing this network, or null if not yet available */
  contractsNamespace: string | null;
  hasuraUrl: string;
  hasuraSecret: string;
  explorerBaseUrl: string;
  /** token address (lower) → symbol */
  tokenSymbols: Record<string, string>;
  /** address (lower) → human label */
  addressLabels: Record<string, string>;
  /** True for networks that require a locally-running indexer — hidden in deployed environments */
  local: boolean;
};

type ContractEntry = {
  address: string;
  type: "token" | "pool" | "contract";
};

type ContractsData = Record<
  string,
  Record<string, Record<string, ContractEntry>>
>;

function buildNetworkMaps(
  chainId: number,
  namespace: string | null,
): Pick<Network, "tokenSymbols" | "addressLabels"> {
  const contracts =
    (contractsData as ContractsData)[String(chainId)]?.[namespace ?? ""] ?? {};
  const entries = Object.entries(contracts);
  return {
    tokenSymbols: Object.fromEntries(
      entries
        .filter(([, entry]) => entry.type === "token")
        .map(([name, entry]) => [entry.address.toLowerCase(), name]),
    ),
    addressLabels: Object.fromEntries(
      entries.map(([name, entry]) => [entry.address.toLowerCase(), name]),
    ),
  };
}

function makeNetwork(
  config: Omit<Network, "tokenSymbols" | "addressLabels" | "local"> &
    Partial<Pick<Network, "local">>,
): Network {
  return {
    local: false,
    ...config,
    ...buildNetworkMaps(config.chainId, config.contractsNamespace),
  };
}

export const NETWORKS: Record<IndexerNetworkId, Network> = {
  devnet: makeNetwork({
    id: "devnet",
    label: "Celo Devnet (local)",
    local: true,
    chainId: 42220,
    contractsNamespace: ACTIVE_DEPLOYMENT["celo-mainnet"],
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_DEVNET ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret: process.env.NEXT_PUBLIC_HASURA_SECRET_DEVNET ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_DEVNET ?? "http://localhost:5100",
  }),
  "celo-sepolia-local": makeNetwork({
    id: "celo-sepolia-local",
    label: "Celo Sepolia (local)",
    local: true,
    chainId: 11142220,
    contractsNamespace: ACTIVE_DEPLOYMENT["celo-sepolia"],
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_SEPOLIA ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret: process.env.NEXT_PUBLIC_HASURA_SECRET_SEPOLIA ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_SEPOLIA ??
      "https://celo-sepolia.blockscout.com",
  }),
  "celo-sepolia-hosted": makeNetwork({
    id: "celo-sepolia-hosted",
    label: "Celo Sepolia (hosted)",
    chainId: 11142220,
    contractsNamespace: ACTIVE_DEPLOYMENT["celo-sepolia"],
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED ?? "",
    hasuraSecret: process.env.NEXT_PUBLIC_HASURA_SECRET_SEPOLIA_HOSTED ?? "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_SEPOLIA_HOSTED ??
      "https://celo-sepolia.blockscout.com",
  }),
  "celo-mainnet-local": makeNetwork({
    id: "celo-mainnet-local",
    label: "Celo Mainnet (local)",
    local: true,
    chainId: 42220,
    contractsNamespace: ACTIVE_DEPLOYMENT["celo-mainnet"],
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_MAINNET ??
      "http://localhost:8082/v1/graphql",
    hasuraSecret: process.env.NEXT_PUBLIC_HASURA_SECRET_MAINNET ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_MAINNET ?? "https://celoscan.io",
  }),
  "celo-mainnet-hosted": makeNetwork({
    id: "celo-mainnet-hosted",
    label: "Celo Mainnet (hosted)",
    chainId: 42220,
    contractsNamespace: ACTIVE_DEPLOYMENT["celo-mainnet"],
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED ?? "",
    hasuraSecret: process.env.NEXT_PUBLIC_HASURA_SECRET_MAINNET_HOSTED ?? "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_MAINNET_HOSTED ??
      "https://celoscan.io",
  }),
};

export const NETWORK_IDS = Object.keys(NETWORKS) as IndexerNetworkId[];
export const DEFAULT_NETWORK: IndexerNetworkId = "celo-mainnet-hosted";

export function isNetworkId(v: string): v is IndexerNetworkId {
  return v in NETWORKS;
}

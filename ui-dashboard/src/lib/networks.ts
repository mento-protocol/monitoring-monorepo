// ---------------------------------------------------------------------------
// Network definitions — add new chains here
// ---------------------------------------------------------------------------

import contractsData from "@mento-protocol/contracts/contracts.json";
import DEPLOYMENT_NAMESPACES from "@mento-protocol/monitoring-config/deployment-namespaces.json";

// Semantic aliases over the shared chain ID → namespace map.
// Defined once here so call sites stay readable; the actual namespace strings
// live in shared-config/deployment-namespaces.json (single source of truth).
const NS = {
  "celo-mainnet": DEPLOYMENT_NAMESPACES["42220"],
  "celo-sepolia": DEPLOYMENT_NAMESPACES["11142220"],
  "monad-mainnet": DEPLOYMENT_NAMESPACES["143"],
  "monad-testnet": DEPLOYMENT_NAMESPACES["10143"],
} as const;

export type IndexerNetworkId =
  | "devnet"
  | "celo-sepolia-local"
  | "celo-sepolia-hosted"
  | "celo-mainnet-local"
  | "celo-mainnet-hosted"
  | "monad-mainnet-hosted"
  | "monad-testnet-hosted";

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
  /** Whether this network has VirtualPool contracts (Celo only). Controls UI visibility of virtual-pool-related elements. */
  hasVirtualPools: boolean;
  /** JSON-RPC endpoint used for on-chain reads (e.g. rebalance simulation) */
  rpcUrl?: string;
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

export function makeNetwork(
  config: Omit<
    Network,
    "tokenSymbols" | "addressLabels" | "local" | "hasVirtualPools" | "rpcUrl"
  > &
    Partial<
      Pick<
        Network,
        | "local"
        | "tokenSymbols"
        | "addressLabels"
        | "hasVirtualPools"
        | "rpcUrl"
      >
    >,
): Network {
  const maps = buildNetworkMaps(config.chainId, config.contractsNamespace);
  return {
    local: false,
    hasVirtualPools: false,
    ...config,
    tokenSymbols: { ...maps.tokenSymbols, ...config.tokenSymbols },
    addressLabels: { ...maps.addressLabels, ...config.addressLabels },
  };
}

export const NETWORKS: Record<IndexerNetworkId, Network> = {
  devnet: makeNetwork({
    id: "devnet",
    label: "Celo Devnet (local)",
    local: true,
    hasVirtualPools: true,
    chainId: 42220,
    contractsNamespace: NS["celo-mainnet"],
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL_DEVNET ?? "http://localhost:8545",
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_DEVNET ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret: process.env.NEXT_PUBLIC_HASURA_SECRET_DEVNET ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_DEVNET ?? "http://localhost:5100",
    addressLabels: {
      "0x287810f677516f10993ff63a520aad5509f35796": "Deployer",
    },
  }),
  "celo-sepolia-local": makeNetwork({
    id: "celo-sepolia-local",
    label: "Celo Sepolia (local)",
    local: true,
    hasVirtualPools: true,
    chainId: 11142220,
    contractsNamespace: NS["celo-sepolia"],
    rpcUrl:
      process.env.NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA ??
      "https://forno.celo-sepolia.celo-testnet.org",
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret:
      process.env.NEXT_PUBLIC_HASURA_SECRET_CELO_SEPOLIA ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA ??
      "https://celo-sepolia.blockscout.com",
  }),
  "celo-sepolia-hosted": makeNetwork({
    id: "celo-sepolia-hosted",
    label: "Celo Sepolia (hosted)",
    hasVirtualPools: true,
    chainId: 11142220,
    contractsNamespace: NS["celo-sepolia"],
    rpcUrl:
      process.env.NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA ??
      "https://forno.celo-sepolia.celo-testnet.org",
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA_HOSTED ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA_HOSTED ??
      "https://celo-sepolia.blockscout.com",
  }),
  "celo-mainnet-local": makeNetwork({
    id: "celo-mainnet-local",
    label: "Celo Mainnet (local)",
    local: true,
    hasVirtualPools: true,
    chainId: 42220,
    contractsNamespace: NS["celo-mainnet"],
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL_CELO ?? "https://forno.celo.org",
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_CELO_MAINNET ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret:
      process.env.NEXT_PUBLIC_HASURA_SECRET_CELO_MAINNET ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET ??
      "https://celoscan.io",
  }),
  "celo-mainnet-hosted": makeNetwork({
    id: "celo-mainnet-hosted",
    label: "Celo Mainnet (hosted)",
    hasVirtualPools: true,
    chainId: 42220,
    contractsNamespace: NS["celo-mainnet"],
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL_CELO ?? "https://forno.celo.org",
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_CELO_MAINNET_HOSTED ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET_HOSTED ??
      "https://celoscan.io",
  }),
  "monad-mainnet-hosted": makeNetwork({
    id: "monad-mainnet-hosted",
    label: "Monad Mainnet",
    chainId: 143,
    contractsNamespace: NS["monad-mainnet"],
    rpcUrl:
      process.env.NEXT_PUBLIC_RPC_URL_MONAD_MAINNET ?? "https://rpc2.monad.xyz",
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_MONAD_MAINNET_HOSTED ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET_HOSTED ??
      "https://monadscan.com",
  }),
  "monad-testnet-hosted": makeNetwork({
    id: "monad-testnet-hosted",
    label: "Monad Testnet",
    chainId: 10143,
    contractsNamespace: NS["monad-testnet"],
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL_MONAD_TESTNET,
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_MONAD_TESTNET_HOSTED ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_TESTNET_HOSTED ??
      "https://testnet.monadscan.com",
  }),
};

export const NETWORK_IDS = Object.keys(NETWORKS) as IndexerNetworkId[];
export const DEFAULT_NETWORK: IndexerNetworkId = "celo-mainnet-hosted";

export function isNetworkId(v: string): v is IndexerNetworkId {
  return v in NETWORKS;
}

/**
 * A network is "configured" if it has a Hasura URL set.
 * Unconfigured networks (e.g. Monad before Envio deploy) are excluded from
 * navigation and URL routing so users can never land on a broken state.
 * Local networks are always considered unconfigured unless NEXT_PUBLIC_SHOW_LOCAL_NETWORKS=true.
 */
const showLocalNetworks =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_SHOW_LOCAL_NETWORKS === "true";

export function isConfiguredNetworkId(v: string): v is IndexerNetworkId {
  if (!isNetworkId(v)) return false;
  const network = NETWORKS[v];
  if (!showLocalNetworks && network.local) return false;
  return !!network.hasuraUrl;
}

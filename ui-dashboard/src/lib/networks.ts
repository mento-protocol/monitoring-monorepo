// Network definitions — add new chains here

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
  | "celo-sepolia"
  | "celo-mainnet-local"
  | "celo-mainnet"
  | "monad-mainnet"
  | "monad-testnet";

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
  /** True for test/staging networks — hidden in production unless NEXT_PUBLIC_SHOW_TESTNET_NETWORKS=true */
  testnet: boolean;
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

// Wormhole NTT hub/spoke split: on Monad chains, token entries are published
// under names like "USDmSpoke" / "EURmSpoke" / "GBPmSpoke". Strip the suffix
// for token entries only — implementation-contract rows like
// "StableTokenSpoke" stay raw so the address book keeps precise names.
// Keep in sync with indexer-envio/src/feeToken.ts buildKnownTokenMeta.
function canonicalTokenSymbol(name: string): string {
  return name.endsWith("Spoke") ? name.slice(0, -5) : name;
}

// Implementation contracts that should never surface as pool-token symbols.
// Applied to tokenSymbols only — addressLabels keeps every named entry so the
// address book still renders `StableTokenV3v300`, `StableTokenSpoke`, etc. as
// contract rows. Narrower than the indexer's equivalent filter in
// indexer-envio/src/feeToken.ts:buildKnownTokenMeta: we do NOT exclude Mock*
// because Sepolia/Monad-testnet MockERC20* deployments ARE real pool tokens.
function isInternalTokenName(name: string): boolean {
  return name.startsWith("StableToken");
}

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
        .filter(
          ([name, entry]) =>
            entry.type === "token" && !isInternalTokenName(name),
        )
        .map(([name, entry]) => [
          entry.address.toLowerCase(),
          canonicalTokenSymbol(name),
        ]),
    ),
    addressLabels: Object.fromEntries(
      entries.map(([name, entry]) => [
        entry.address.toLowerCase(),
        // Canonicalize only the user-facing ERC20 token names (USDmSpoke →
        // USDm). Leave contract labels like "StableTokenSpoke" raw so
        // operators can identify the exact deployment in the address book.
        entry.type === "token" ? canonicalTokenSymbol(name) : name,
      ]),
    ),
  };
}

export function makeNetwork(
  config: Omit<
    Network,
    | "tokenSymbols"
    | "addressLabels"
    | "local"
    | "hasVirtualPools"
    | "rpcUrl"
    | "testnet"
  > &
    Partial<
      Pick<
        Network,
        | "local"
        | "testnet"
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
    testnet: false,
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
    testnet: true,
    hasVirtualPools: true,
    chainId: 11142220,
    contractsNamespace: NS["celo-sepolia"],
    rpcUrl:
      process.env.NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA ??
      "https://forno.celo-sepolia.celo-testnet.org",
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA_LOCAL ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret:
      process.env.NEXT_PUBLIC_HASURA_SECRET_CELO_SEPOLIA_LOCAL ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA_LOCAL ??
      "https://celo-sepolia.blockscout.com",
  }),
  "celo-sepolia": makeNetwork({
    id: "celo-sepolia",
    label: "Celo Sepolia",
    testnet: true,
    hasVirtualPools: true,
    chainId: 11142220,
    contractsNamespace: NS["celo-sepolia"],
    rpcUrl:
      process.env.NEXT_PUBLIC_RPC_URL_CELO_SEPOLIA ??
      "https://forno.celo-sepolia.celo-testnet.org",
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_SEPOLIA ??
      "https://celo-sepolia.blockscout.com",
  }),
  "celo-mainnet-local": makeNetwork({
    id: "celo-mainnet-local",
    label: "Celo (local)",
    local: true,
    hasVirtualPools: true,
    chainId: 42220,
    contractsNamespace: NS["celo-mainnet"],
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL_CELO ?? "https://forno.celo.org",
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_CELO_MAINNET_LOCAL ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret:
      process.env.NEXT_PUBLIC_HASURA_SECRET_CELO_MAINNET_LOCAL ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET_LOCAL ??
      "https://celoscan.io",
    addressLabels: {
      "0x0dd57f6f181d0469143fe9380762d8a112e96e4a": "Yield Split",
    },
  }),
  "celo-mainnet": makeNetwork({
    id: "celo-mainnet",
    label: "Celo",
    hasVirtualPools: true,
    chainId: 42220,
    contractsNamespace: NS["celo-mainnet"],
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL_CELO ?? "https://forno.celo.org",
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_MULTICHAIN?.trim() ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_CELO_MAINNET ??
      "https://celoscan.io",
    addressLabels: {
      "0x0dd57f6f181d0469143fe9380762d8a112e96e4a": "Yield Split",
    },
  }),
  "monad-mainnet": makeNetwork({
    id: "monad-mainnet",
    label: "Monad",
    chainId: 143,
    contractsNamespace: NS["monad-mainnet"],
    rpcUrl:
      process.env.NEXT_PUBLIC_RPC_URL_MONAD_MAINNET ?? "https://rpc2.monad.xyz",
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_MULTICHAIN?.trim() ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_MAINNET ??
      "https://monadscan.com",
  }),
  "monad-testnet": makeNetwork({
    id: "monad-testnet",
    label: "Monad Testnet",
    testnet: true,
    chainId: 10143,
    contractsNamespace: NS["monad-testnet"],
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL_MONAD_TESTNET,
    hasuraUrl: process.env.NEXT_PUBLIC_HASURA_URL_MONAD_TESTNET ?? "",
    hasuraSecret: "",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_MONAD_TESTNET ??
      "https://testnet.monadscan.com",
  }),
};

export const NETWORK_IDS = Object.keys(NETWORKS) as IndexerNetworkId[];
export const DEFAULT_NETWORK: IndexerNetworkId = "celo-mainnet";

// Explicit (not derived from NETWORKS) so a future local/staging variant
// sharing a chainId can't silently reroute prod pool URLs.
const PROD_NETWORK_BY_CHAIN_ID: Record<number, IndexerNetworkId> = {
  42220: "celo-mainnet",
  11142220: "celo-sepolia",
  143: "monad-mainnet",
  10143: "monad-testnet",
};

// Canonical network id for a chainId (used to derive the active network
// from a namespaced pool id without needing ?network=).
export function networkIdForChainId(chainId: number): IndexerNetworkId | null {
  return PROD_NETWORK_BY_CHAIN_ID[chainId] ?? null;
}

// True when `networkId` is the canonical variant for its chainId. Used by
// link builders to decide whether ?network= can be omitted.
export function isCanonicalNetwork(networkId: IndexerNetworkId): boolean {
  return networkIdForChainId(NETWORKS[networkId].chainId) === networkId;
}

export function isNetworkId(v: string): v is IndexerNetworkId {
  return v in NETWORKS;
}

/**
 * A network is "configured" if it has a Hasura URL set.
 * Unconfigured networks (e.g. Monad before Envio deploy) are excluded from
 * navigation and URL routing so users can never land on a broken state.
 * Local networks are always considered unconfigured unless NEXT_PUBLIC_SHOW_LOCAL_NETWORKS=true.
 * Testnet networks are excluded in production unless NEXT_PUBLIC_SHOW_TESTNET_NETWORKS=true.
 */
const showLocalNetworks =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_SHOW_LOCAL_NETWORKS === "true";

const showTestnetNetworks =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_SHOW_TESTNET_NETWORKS === "true";

export function isConfiguredNetworkId(v: string): v is IndexerNetworkId {
  if (!isNetworkId(v)) return false;
  const network = NETWORKS[v];
  if (!showLocalNetworks && network.local) return false;
  if (!showTestnetNetworks && network.testnet) return false;
  return !!network.hasuraUrl;
}

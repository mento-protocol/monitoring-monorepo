// ---------------------------------------------------------------------------
// Network definitions — add new chains here
// ---------------------------------------------------------------------------

export type NetworkId = "devnet" | "sepolia";

export type Network = {
  id: NetworkId;
  label: string;
  chainId: number;
  hasuraUrl: string;
  hasuraSecret: string;
  explorerBaseUrl: string;
  /** token address (lower) → symbol */
  tokenSymbols: Record<string, string>;
  /** address (lower) → human label */
  addressLabels: Record<string, string>;
};

export const NETWORKS: Record<NetworkId, Network> = {
  devnet: {
    id: "devnet",
    label: "Celo Devnet",
    chainId: 42220,
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_DEVNET ??
      "http://localhost:8080/v1/graphql",
    hasuraSecret:
      process.env.NEXT_PUBLIC_HASURA_SECRET_DEVNET ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_DEVNET ??
      "http://localhost:5100",
    tokenSymbols: {
      "0x765de816845861e75a25fca122bb6898b8b1282a": "USDm",
      "0xfaea5f3404bba20d3cc2f8c4b0a888f55a3c7313": "cGHS",
    },
    addressLabels: {
      "0x287810f677516f10993ff63a520aad5509f35796": "Deployer",
    },
  },
  sepolia: {
    id: "sepolia",
    label: "Celo Sepolia",
    chainId: 11142220,
    hasuraUrl:
      process.env.NEXT_PUBLIC_HASURA_URL_SEPOLIA ??
      "http://localhost:8081/v1/graphql",
    hasuraSecret:
      process.env.NEXT_PUBLIC_HASURA_SECRET_SEPOLIA ?? "testing",
    explorerBaseUrl:
      process.env.NEXT_PUBLIC_EXPLORER_URL_SEPOLIA ??
      "https://celo-sepolia.blockscout.com",
    tokenSymbols: {
      "0xde9e4c3ce781b4ba68120d6261cbad65ce0ab00b": "USDm",
    },
    addressLabels: {},
  },
};

export const NETWORK_IDS = Object.keys(NETWORKS) as NetworkId[];
export const DEFAULT_NETWORK: NetworkId = "sepolia";

export function isNetworkId(v: string): v is NetworkId {
  return v in NETWORKS;
}

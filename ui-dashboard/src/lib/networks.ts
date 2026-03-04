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
      "0xfaea5f3404bba20d3cc2f8c4b0a888f55a3c7313": "GHSm",
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
      "0x0352976d940a2c3fba0c3623198947ee1d17869e": "PHPm",
      "0x5873faeb42f3563dcd77f0fbbda818e6d6da3139": "AUDm",
      "0xf151c9a13b78c84f93f50b8b3bc689fedc134f60": "CADm",
      "0x284e9b7b623eae866914b7fa0eb720c2bb3c2980": "CHFm",
      "0x5f8d55c3627d2dc0a2b4afa798f877242f382f67": "COPm",
      "0xa99dc247d6b7b2e3ab48a1fee101b83cd6acd82a": "EURm",
      "0x85f5181abdbf0e1814fc4358582ae07b8eba3af3": "GBPm",
      "0x5e94b8c872bd47bc4255e60ecbf44d5e66e7401c": "GHSm",
      "0x85bee67d435a39f7467a8a9de34a5b73d25df426": "JPYm",
      "0xc7e4635651e3e3af82b61d3e23c159438dae3bbf": "KESm",
      "0x3d5ae86f34e2a82771496d140dafaef3789df888": "NGNm",
      "0x2294298942fdc79417de9e0d740a4957e0e7783a": "BRLm",
      "0x10ccfb235b0e1ed394bace4560c3ed016697687e": "ZARm",
      "0x5505b70207ae3b826c1a7607f19f3bf73444a082": "XOFm",
    },
    addressLabels: {
      "0x887955f28723b0e9bddc358448cb5b1fde692da4": "VirtualPoolFactory",
      "0x5e2a42d760aa6969c3da49b249ec181115887391": "FPMMFactory",
      "0xcf6cd45210b3ffe3ca28379c4683f1e60d0c2ccd": "Router",
    },
  },
};

export const NETWORK_IDS = Object.keys(NETWORKS) as NetworkId[];
export const DEFAULT_NETWORK: NetworkId = "sepolia";

export function isNetworkId(v: string): v is NetworkId {
  return v in NETWORKS;
}

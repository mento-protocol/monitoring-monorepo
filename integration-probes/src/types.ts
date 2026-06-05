export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const LATEST_SNAPSHOT_KEY = "integration-probes:latest";
export const HISTORY_KEY_PREFIX = "integration-probes:history:";

export const PROBE_CHAIN_IDS = [42220, 143] as const;

export type ProbeChainId = (typeof PROBE_CHAIN_IDS)[number];

export type AggregatorKind = "dex" | "cross_chain" | "meta" | "excluded";
export type ProbeStatus =
  | "pass"
  | "partial"
  | "fail"
  | "unsupported"
  | "needs_key"
  | "no_liquidity"
  | "rate_limited"
  | "error";

type EvidenceType = "router-address" | "pool-address" | "source-label";

export type AddressEvidence = {
  type: EvidenceType;
  value: string;
  path: string;
};

export type TokenProbe = {
  symbol: string;
  address: string;
  decimals: number;
};

export type HubPair = {
  id: string;
  chainId: number;
  poolId: string;
  poolAddress: string;
  poolSource: string;
  base: TokenProbe;
  quote: TokenProbe;
  baseReserveRaw?: string | undefined;
  quoteReserveRaw?: string | undefined;
};

type PairDirection = "base-to-usdm" | "usdm-to-base";

export type QuoteProbeInput = {
  chainId: number;
  pairId: string;
  direction: PairDirection;
  sellToken: TokenProbe;
  buyToken: TokenProbe;
  amountDecimal: string;
  amountRaw: string;
  sellReserveRaw?: string | undefined;
  buyReserveRaw?: string | undefined;
  takerAddress: string;
};

export type PairProbeResult = {
  pairId: string;
  poolId: string;
  direction: PairDirection;
  sellSymbol: string;
  buySymbol: string;
  status: ProbeStatus;
  evidence: AddressEvidence[];
  sourceLabels: string[];
  txTarget: string | null;
  downstreamProvider: string | null;
  routeVariant: string | null;
  routeAmountUsd: string | null;
  attemptCount: number | null;
  requestUrl: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  responsePreview: string | null;
  error: string | null;
};

export type ChainProbeResult = {
  chainId: number;
  chainSlug: string;
  chainLabel: string;
  status: ProbeStatus;
  pairCoverage: {
    passed: number;
    total: number;
  };
  blockingReason: string | null;
  nextStep: string | null;
  pairs: PairProbeResult[];
};

export type AggregatorProbeResult = {
  id: string;
  label: string;
  kind: AggregatorKind;
  tier: 1 | 2 | 3;
  credentialEnv: string[];
  researchNote: string;
  chains: ChainProbeResult[];
};

export type ChainProbeConfig = {
  chainId: number;
  chainSlug: string;
  chainLabel: string;
  routerAddresses: string[];
  poolAddresses: string[];
  pairs: HubPair[];
};

export type IntegrationProbeSnapshot = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  generatedAt: string;
  amountUsd: string;
  takerAddress: string;
  pairSource: {
    kind: "hasura" | "contracts-fallback";
    hasuraUrlConfigured: boolean;
    note: string;
  };
  chains: ChainProbeConfig[];
  aggregators: AggregatorProbeResult[];
  summary: {
    aggregators: number;
    chainChecks: number;
    passingChainChecks: number;
    partialChainChecks: number;
    failingChainChecks: number;
    needsKeyChainChecks: number;
    unsupportedChainChecks: number;
  };
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

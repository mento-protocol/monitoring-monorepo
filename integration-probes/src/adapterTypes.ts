import type {
  AggregatorKind,
  ChainProbeConfig,
  FetchLike,
  PairProbeResult,
  QuoteProbeInput,
} from "./types.js";

export type ChainSupport = "supported" | "unsupported" | "unknown";

export type BeforeQuoteRequest = () => Promise<void>;

export type QuoteBuildContext = {
  chain: ChainProbeConfig;
  fetcher: FetchLike;
};

export type QuoteBuildResult =
  | QuoteRequest
  | readonly QuoteRequest[]
  | Promise<QuoteRequest | readonly QuoteRequest[]>;

export type AggregatorAdapter = {
  id: string;
  label: string;
  kind: AggregatorKind;
  tier: 1 | 2 | 3;
  credentialEnv?: readonly string[];
  researchNote: string;
  support: Partial<Record<number, ChainSupport>>;
  quote?: (
    input: QuoteProbeInput,
    env: NodeJS.ProcessEnv,
    context?: QuoteBuildContext,
  ) => QuoteBuildResult;
  maxQuoteRequestsPerRun?: number;
  quoteRequestDelayMs?: number;
  nextStep?: string;
};

export type QuoteRequest = {
  url: string;
  init?: RequestInit;
  variant?: string;
  amountDecimal?: string;
  amountRaw?: string;
  afterResponse?: QuoteResponseEvidenceHook;
  afterFailure?: QuoteFailureDiscoveryHook;
};

export type QuoteAttemptBudget = {
  remaining: number;
};

export type RequestHeaders = Record<string, string>;

export type QuoteResponseEvidenceHook = (
  args: QuoteResponseEvidenceArgs,
) => Promise<PairProbeResult | null>;

type QuoteFailureDiscoveryHook = (
  args: QuoteFailureDiscoveryArgs,
) => Promise<readonly QuoteRequest[]>;

export type QuoteResponseEvidenceArgs = {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  request: QuoteRequest;
  payload: unknown;
  primaryResult: PairProbeResult;
  quoteBudget?: QuoteAttemptBudget | undefined;
};

type QuoteFailureDiscoveryArgs = {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  request: QuoteRequest;
  primaryResult: PairProbeResult;
};

export type TimedPayload = {
  payload: unknown;
  statusCode: number;
  latencyMs: number;
  requestUrl: string;
};

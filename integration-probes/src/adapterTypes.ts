import type {
  ChainProbeConfig,
  FetchLike,
  PairProbeResult,
  QuoteProbeInput,
} from "./types.js";

export type QuoteRequest = {
  url: string;
  init?: RequestInit;
  variant?: string;
  amountDecimal?: string;
  amountRaw?: string;
  afterResponse?: QuoteResponseEvidenceHook;
};

export type QuoteAttemptBudget = {
  remaining: number;
};

export type RequestHeaders = Record<string, string>;

export type QuoteResponseEvidenceHook = (
  args: QuoteResponseEvidenceArgs,
) => Promise<PairProbeResult | null>;

export type QuoteResponseEvidenceArgs = {
  chain: ChainProbeConfig;
  input: QuoteProbeInput;
  fetcher: FetchLike;
  request: QuoteRequest;
  payload: unknown;
  primaryResult: PairProbeResult;
  quoteBudget?: QuoteAttemptBudget | undefined;
};

export type TimedPayload = {
  payload: unknown;
  statusCode: number;
  latencyMs: number;
  requestUrl: string;
};

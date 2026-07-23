import type {
  BookLevel,
  ExecutableSellQuote,
  FetchLike,
  MarketState,
  PegObservation,
  Sleep,
} from "./types.js";

export const MAX_PROVIDER_RETRIES = 1;
export const MAX_RETRY_DELAY_MS = 1_000;
export const DEFAULT_RETRY_DELAY_MS = 100;

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MAX_SEQUENCE_LENGTH = 512;

export interface BoundedJsonRequest {
  url: string;
  fetch: FetchLike;
  sleep: Sleep;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface PegObservationInput {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  refSize: number;
  spreadEnvelopeBps: number;
  marketState: MarketState;
  lastTradeAt: number | null;
  fetchedAt: number;
  observationAt: number | null;
  sequence: string | null;
}

export const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertFinitePositive = (value: number, field: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be finite and greater than zero`);
  }
};

const assertTimestamp = (value: number, field: string) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative timestamp`);
  }
};

export const parsePositiveDecimal = (value: unknown, field: string) => {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`${field} must be a positive decimal string`);
  }
  const parsed = Number(value);
  assertFinitePositive(parsed, field);
  return parsed;
};

export const parseIsoTimestamp = (value: unknown, field: string) => {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
  const parsed = Date.parse(value);
  assertTimestamp(parsed, field);
  return parsed;
};

const validateLevel = (level: BookLevel, field: string) => {
  assertFinitePositive(level.price, `${field}.price`);
  assertFinitePositive(level.size, `${field}.size`);
  return { price: level.price, size: level.size };
};

export const sortBookLevels = (
  levels: readonly BookLevel[],
  direction: "ascending" | "descending",
) => {
  const sorted = levels.map((level, index) =>
    validateLevel(level, `levels[${index}]`),
  );
  const multiplier = direction === "ascending" ? 1 : -1;
  return sorted.sort((left, right) => multiplier * (left.price - right.price));
};

const effectivelyFilled = (filled: number, requested: number) =>
  requested - filled <= Number.EPSILON * Math.max(1, requested) * 8;

const assertFiniteQuoteArithmetic = (value: number, operation: string) => {
  if (!Number.isFinite(value)) {
    throw new Error(`order-book ${operation} must be finite`);
  }
  return value;
};

export const executableSellQuote = (
  bids: readonly BookLevel[],
  refSize: number,
): ExecutableSellQuote => {
  assertFinitePositive(refSize, "refSize");
  const sortedBids = sortBookLevels(bids, "descending");
  let filled = 0;
  let quoteAmount = 0;

  for (const level of sortedBids) {
    const fill = Math.min(level.size, refSize - filled);
    const quoteContribution = assertFiniteQuoteArithmetic(
      fill * level.price,
      "fill multiplication",
    );
    quoteAmount = assertFiniteQuoteArithmetic(
      quoteAmount + quoteContribution,
      "quote accumulation",
    );
    filled += fill;
    if (effectivelyFilled(filled, refSize)) break;
  }

  const capped = !effectivelyFilled(filled, refSize);
  const vwap =
    filled === 0
      ? null
      : assertFiniteQuoteArithmetic(quoteAmount / filled, "VWAP");
  return {
    vwap,
    filledFraction: capped ? filled / refSize : 1,
    capped,
  };
};

const oneSidedState = (bidCount: number, askCount: number) => {
  if (bidCount === 0) {
    return askCount === 0 ? ("evacuated" as const) : ("one_sided_ask" as const);
  }
  return askCount === 0 ? ("one_sided_bid" as const) : null;
};

const venueState = (input: {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
  marketState: MarketState;
  spreadEnvelopeBps: number;
}) => {
  if (input.marketState === "absent") {
    throw new Error("market is absent from the provider listing");
  }
  if (input.marketState === "halted") return "halted" as const;
  const shapeState = oneSidedState(input.bids.length, input.asks.length);
  if (shapeState !== null) return shapeState;

  const bid = input.bids[0]?.price;
  const ask = input.asks[0]?.price;
  if (bid === undefined || ask === undefined || bid > ask) {
    throw new Error("provider returned a crossed order book");
  }
  const midpoint = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / midpoint) * 10_000;
  return spreadBps > input.spreadEnvelopeBps ? "wide" : "ok";
};

const validateStatusOnlyHalt = (
  input: Pick<
    PegObservationInput,
    "asks" | "bids" | "lastTradeAt" | "marketState"
  >,
) => {
  if (input.marketState !== "halted") {
    throw new Error(
      "only a status-only halted observation may omit provider identity",
    );
  }
  if (
    input.bids.length > 0 ||
    input.asks.length > 0 ||
    input.lastTradeAt !== null
  ) {
    throw new Error(
      "a status-only halted observation without provider identity must not include bids, asks, or lastTradeAt",
    );
  }
};

const validateObservationIdentity = (
  input: Pick<
    PegObservationInput,
    | "asks"
    | "bids"
    | "lastTradeAt"
    | "marketState"
    | "observationAt"
    | "sequence"
  >,
) => {
  const hasObservationAt = input.observationAt !== null;
  const hasSequence = input.sequence !== null;
  if (hasObservationAt !== hasSequence) {
    throw new Error("observationAt and sequence must both be present or null");
  }
  if (!hasObservationAt) validateStatusOnlyHalt(input);
  if (input.observationAt !== null) {
    assertTimestamp(input.observationAt, "observationAt");
  }
  if (
    input.sequence !== null &&
    (input.sequence.length === 0 || input.sequence.length > MAX_SEQUENCE_LENGTH)
  ) {
    throw new Error("sequence must contain between 1 and 512 characters");
  }
};

export const createPegObservation = (
  input: PegObservationInput,
): PegObservation => {
  assertFinitePositive(input.refSize, "refSize");
  if (
    !Number.isFinite(input.spreadEnvelopeBps) ||
    input.spreadEnvelopeBps < 0
  ) {
    throw new Error("spreadEnvelopeBps must be finite and non-negative");
  }
  assertTimestamp(input.fetchedAt, "fetchedAt");
  if (input.lastTradeAt !== null) {
    assertTimestamp(input.lastTradeAt, "lastTradeAt");
  }
  validateObservationIdentity(input);

  const bids = sortBookLevels(input.bids, "descending");
  const asks = sortBookLevels(input.asks, "ascending");
  return {
    ...executableSellQuote(bids, input.refSize),
    bid: bids[0]?.price ?? null,
    ask: asks[0]?.price ?? null,
    lastTradeAt: input.lastTradeAt,
    fetchedAt: input.fetchedAt,
    observationAt: input.observationAt,
    sequence: input.sequence,
    venueState: venueState({
      bids,
      asks,
      marketState: input.marketState,
      spreadEnvelopeBps: input.spreadEnvelopeBps,
    }),
  };
};

const declaredContentLength = (response: Response) => {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const readBoundedBody = async (response: Response, maxBytes: number) => {
  const declared = declaredContentLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`provider response exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`provider response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
};

const retryDelay = (response: Response) => {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null || !/^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return DEFAULT_RETRY_DELAY_MS;
  }
  return Math.min(Number(retryAfter) * 1_000, MAX_RETRY_DELAY_MS);
};

const isRetryableStatus = (status: number) =>
  status === 429 || (status >= 500 && status <= 599);

const fetchAttempt = async (request: BoundedJsonRequest) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await request.fetch(request.url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { response, body: null };
    }
    return {
      response,
      body: await readBoundedBody(response, request.maxResponseBytes),
    };
  } finally {
    clearTimeout(timer);
  }
};

export const fetchBoundedJson = async (request: BoundedJsonRequest) => {
  assertFinitePositive(request.timeoutMs, "timeoutMs");
  assertFinitePositive(request.maxResponseBytes, "maxResponseBytes");

  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
    const { response, body } = await fetchAttempt(request);
    if (body !== null) {
      try {
        return JSON.parse(body) as unknown;
      } catch (error) {
        throw new Error("provider returned invalid JSON", { cause: error });
      }
    }
    if (
      !isRetryableStatus(response.status) ||
      attempt === MAX_PROVIDER_RETRIES
    ) {
      throw new Error(`provider returned HTTP ${response.status}`);
    }
    await request.sleep(retryDelay(response));
  }
  throw new Error("provider request exhausted its retry budget");
};

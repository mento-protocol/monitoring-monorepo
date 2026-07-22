import {
  createPegObservation,
  defaultSleep,
  fetchBoundedJson,
  parsePositiveDecimal,
} from "../order-book.js";
import type {
  AdapterRuntime,
  BookLevel,
  MarketState,
  ObservationPolicy,
  ParsedOrderBook,
  PegObservation,
} from "../types.js";

export const BITVAVO_TIMEOUT_MS = 5_000;
export const BITVAVO_MAX_RESPONSE_BYTES = 512 * 1_024;
export const BITVAVO_BOOK_DEPTH = 1_000;
export const BITVAVO_BOOK_LEVEL_CAP = 1_000;
export const BITVAVO_REQUESTS_PER_POLL = 3;
export const BITVAVO_MAX_HTTP_REQUESTS_PER_POLL = 6;

const BITVAVO_API_URL = "https://api.bitvavo.com/v2";
const BITVAVO_MARKET_STATUSES = new Set([
  "trading",
  "halted",
  "auction",
  "auctionMatching",
  "cancelOnly",
]);

type JsonRecord = Record<string, unknown>;

export interface BitvavoObservationRequest extends ObservationPolicy {
  market: string;
}

const asRecord = (value: unknown, field: string): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonRecord;
};

export const parseBitvavoMarketState = (
  payload: unknown,
  expectedMarket: string,
): MarketState => {
  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length === 0) return "absent";
  if (entries.length !== 1) {
    throw new Error("Bitvavo market lookup must return exactly one market");
  }
  const market = asRecord(entries[0], "Bitvavo market");
  if (market.market !== expectedMarket) {
    throw new Error("Bitvavo market identity does not match the request");
  }
  if (
    typeof market.status !== "string" ||
    !BITVAVO_MARKET_STATUSES.has(market.status)
  ) {
    throw new Error("Bitvavo market status is unsupported");
  }
  return market.status === "trading" ? "listed" : "halted";
};

const parseBookLevel = (value: unknown, field: string): BookLevel => {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${field} must be a [price, size] tuple`);
  }
  return {
    price: parsePositiveDecimal(value[0], `${field}[0]`),
    size: parsePositiveDecimal(value[1], `${field}[1]`),
  };
};

const parseBookSide = (value: unknown, field: string) => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > BITVAVO_BOOK_LEVEL_CAP) {
    throw new Error(`${field} exceeds the ${BITVAVO_BOOK_LEVEL_CAP}-level cap`);
  }
  return value.map((entry, index) =>
    parseBookLevel(entry, `${field}[${index}]`),
  );
};

const nanosecondsToMilliseconds = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive nanosecond timestamp`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer nanosecond timestamp`);
  }
  return Math.floor(value / 1_000_000);
};

export const parseBitvavoBook = (
  payload: unknown,
  expectedMarket: string,
): ParsedOrderBook => {
  const book = asRecord(payload, "Bitvavo book");
  if (book.market !== expectedMarket) {
    throw new Error("Bitvavo book market does not match the request");
  }
  if (!Number.isSafeInteger(book.nonce) || Number(book.nonce) < 0) {
    throw new Error("Bitvavo book nonce must be a non-negative safe integer");
  }
  return {
    bids: parseBookSide(book.bids, "Bitvavo book.bids"),
    asks: parseBookSide(book.asks, "Bitvavo book.asks"),
    observationAt: nanosecondsToMilliseconds(
      book.timestamp,
      "Bitvavo book.timestamp",
    ),
    sequence: `bitvavo:${String(book.nonce)}`,
  };
};

const parseTrade = (value: unknown, field: string) => {
  const trade = asRecord(value, field);
  if (typeof trade.id !== "string" || trade.id.length === 0) {
    throw new Error(`${field}.id must be a non-empty string`);
  }
  if (!Number.isSafeInteger(trade.timestamp) || Number(trade.timestamp) < 0) {
    throw new Error(`${field}.timestamp must be a non-negative safe integer`);
  }
  parsePositiveDecimal(trade.amount, `${field}.amount`);
  parsePositiveDecimal(trade.price, `${field}.price`);
  if (trade.side !== "buy" && trade.side !== "sell") {
    throw new Error(`${field}.side must be buy or sell`);
  }
  return Number(trade.timestamp);
};

export const parseBitvavoTrades = (payload: unknown) => {
  if (!Array.isArray(payload) || payload.length > 1) {
    throw new Error("Bitvavo trades must contain at most one trade");
  }
  return payload.length === 0
    ? null
    : parseTrade(payload[0], "Bitvavo trades[0]");
};

const bookUrl = (market: string) => {
  const url = new URL(`${BITVAVO_API_URL}/${encodeURIComponent(market)}/book`);
  url.searchParams.set("depth", String(BITVAVO_BOOK_DEPTH));
  return url.toString();
};

const marketUrl = (market: string) => {
  const url = new URL(`${BITVAVO_API_URL}/markets`);
  url.searchParams.set("market", market);
  return url.toString();
};

const tradesUrl = (market: string) => {
  const url = new URL(
    `${BITVAVO_API_URL}/${encodeURIComponent(market)}/trades`,
  );
  url.searchParams.set("limit", "1");
  return url.toString();
};

async function fetchOptionalLastTradeAt(
  boundedRequest: (url: string) => Promise<unknown>,
  market: string,
): Promise<number | null> {
  try {
    return parseBitvavoTrades(await boundedRequest(tradesUrl(market)));
  } catch {
    // The book nonce and timestamp are authoritative. Latest trades only add
    // optional context and must not suppress an otherwise valid observation.
    return null;
  }
}

export const fetchBitvavoObservation = async (
  request: BitvavoObservationRequest,
  runtime: AdapterRuntime = {},
): Promise<PegObservation> => {
  const fetch = runtime.fetch ?? globalThis.fetch;
  const sleep = runtime.sleep ?? defaultSleep;
  const boundedRequest = (url: string) =>
    fetchBoundedJson({
      url,
      fetch,
      sleep,
      timeoutMs: BITVAVO_TIMEOUT_MS,
      maxResponseBytes: BITVAVO_MAX_RESPONSE_BYTES,
    });

  const marketState = parseBitvavoMarketState(
    await boundedRequest(marketUrl(request.market)),
    request.market,
  );
  if (marketState === "absent") {
    throw new Error("Bitvavo market is absent from the provider listing");
  }
  const now = runtime.now ?? Date.now;
  if (marketState === "halted") {
    return createPegObservation({
      bids: [],
      asks: [],
      refSize: request.refSize,
      spreadEnvelopeBps: request.spreadEnvelopeBps,
      marketState,
      lastTradeAt: null,
      fetchedAt: now(),
      observationAt: null,
      sequence: null,
    });
  }
  const book = parseBitvavoBook(
    await boundedRequest(bookUrl(request.market)),
    request.market,
  );
  if (book.observationAt === null || book.sequence === null) {
    throw new Error("Bitvavo book omitted its authoritative snapshot identity");
  }
  const lastTradeAt = await fetchOptionalLastTradeAt(
    boundedRequest,
    request.market,
  );

  return createPegObservation({
    bids: book.bids,
    asks: book.asks,
    refSize: request.refSize,
    spreadEnvelopeBps: request.spreadEnvelopeBps,
    marketState,
    lastTradeAt,
    fetchedAt: now(),
    observationAt: book.observationAt,
    sequence: book.sequence,
  });
};

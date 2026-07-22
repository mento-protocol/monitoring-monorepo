import {
  createPegObservation,
  defaultSleep,
  fetchBoundedJson,
  parseIsoTimestamp,
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

export const KRAKEN_TIMEOUT_MS = 5_000;
export const KRAKEN_MAX_RESPONSE_BYTES = 128 * 1_024;
export const KRAKEN_BOOK_LEVEL_CAP = 10;
export const KRAKEN_REQUESTS_PER_POLL = 3;
export const KRAKEN_MAX_HTTP_REQUESTS_PER_POLL = 6;

const KRAKEN_API_URL = "https://api.kraken.com/0/public";

type JsonRecord = Record<string, unknown>;

export interface KrakenObservationRequest extends ObservationPolicy {
  symbol: string;
}

interface ParsedKrakenTrades {
  lastTradeAt: number | null;
  latestAt: number;
  latestSequence: string;
}

interface TimestampedLevel {
  level: BookLevel;
  publicationAt: number;
  publicationSequence: string;
}

const asRecord = (value: unknown, field: string): JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonRecord;
};

const parseEnvelope = (payload: unknown) => {
  const envelope = asRecord(payload, "Kraken response");
  if (!Array.isArray(envelope.error)) {
    throw new Error("Kraken response.error must be an array");
  }
  if (!envelope.error.every((error) => typeof error === "string")) {
    throw new Error("Kraken response.error must contain strings");
  }
  if (envelope.error.length > 0) {
    throw new Error(`Kraken API error: ${envelope.error.join(", ")}`);
  }
  return asRecord(envelope.result, "Kraken response.result");
};

export const parseKrakenMarketState = (
  payload: unknown,
  expectedSymbol: string,
): MarketState => {
  const result = parseEnvelope(payload);
  const markets = Object.values(result).filter((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return (value as JsonRecord).wsname === expectedSymbol;
  });
  if (markets.length === 0) return "absent";
  if (markets.length !== 1) {
    throw new Error("Kraken market lookup returned duplicate symbols");
  }
  const market = asRecord(markets[0], "Kraken market");
  if (typeof market.status !== "string" || market.status.length === 0) {
    throw new Error("Kraken market status must be a non-empty string");
  }
  return market.status === "online" ? "listed" : "halted";
};

const parseBookLevel = (
  value: unknown,
  side: "BUY" | "SELL",
  field: string,
): TimestampedLevel => {
  const level = asRecord(value, field);
  if (level.side !== side) throw new Error(`${field}.side must be ${side}`);
  if (!Number.isSafeInteger(level.count) || Number(level.count) < 1) {
    throw new Error(`${field}.count must be a positive safe integer`);
  }
  if (typeof level.publication_ts !== "string") {
    throw new Error(`${field}.publication_ts must be a string`);
  }
  return {
    level: {
      price: parsePositiveDecimal(level.price, `${field}.price`),
      size: parsePositiveDecimal(level.qty, `${field}.qty`),
    },
    publicationAt: parseIsoTimestamp(
      level.publication_ts,
      `${field}.publication_ts`,
    ),
    publicationSequence: level.publication_ts,
  };
};

const parseBookSide = (value: unknown, side: "BUY" | "SELL", field: string) => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > KRAKEN_BOOK_LEVEL_CAP) {
    throw new Error(`${field} exceeds the ${KRAKEN_BOOK_LEVEL_CAP}-level cap`);
  }
  return value.map((entry, index) =>
    parseBookLevel(entry, side, `${field}[${index}]`),
  );
};

const latestPublication = (levels: readonly TimestampedLevel[]) => {
  let latest: TimestampedLevel | null = null;
  for (const level of levels) {
    if (
      latest === null ||
      level.publicationAt > latest.publicationAt ||
      (level.publicationAt === latest.publicationAt &&
        level.publicationSequence > latest.publicationSequence)
    ) {
      latest = level;
    }
  }
  return latest;
};

export const parseKrakenPreTrade = (
  payload: unknown,
  expectedSymbol: string,
): ParsedOrderBook => {
  const result = parseEnvelope(payload);
  if (result.symbol !== expectedSymbol) {
    throw new Error("Kraken PreTrade symbol does not match the request");
  }
  const bids = parseBookSide(result.bids, "BUY", "Kraken result.bids");
  const asks = parseBookSide(result.asks, "SELL", "Kraken result.asks");
  // Paging measures executable sells, so only bid-side publication can
  // advance the authoritative price identity. A fresh ask must not keep a
  // frozen executable bid book healthy.
  const latest = latestPublication(bids);
  return {
    bids: bids.map(({ level }) => level),
    asks: asks.map(({ level }) => level),
    observationAt: latest?.publicationAt ?? null,
    sequence: latest === null ? null : `kraken:${latest.publicationSequence}`,
  };
};

const parseTrade = (value: unknown, expectedSymbol: string, field: string) => {
  const trade = asRecord(value, field);
  if (trade.symbol !== expectedSymbol) {
    throw new Error(`${field}.symbol does not match the request`);
  }
  parsePositiveDecimal(trade.price, `${field}.price`);
  parsePositiveDecimal(trade.quantity, `${field}.quantity`);
  parseIsoTimestamp(trade.publication_ts, `${field}.publication_ts`);
  return parseIsoTimestamp(trade.trade_ts, `${field}.trade_ts`);
};

export const parseKrakenPostTrade = (
  payload: unknown,
  expectedSymbol: string,
): ParsedKrakenTrades => {
  const result = parseEnvelope(payload);
  if (!Number.isSafeInteger(result.count) || Number(result.count) < 0) {
    throw new Error(
      "Kraken PostTrade count must be a non-negative safe integer",
    );
  }
  if (!Array.isArray(result.trades) || result.trades.length > 1) {
    throw new Error("Kraken PostTrade trades must contain at most one trade");
  }
  if (Number(result.count) !== result.trades.length) {
    throw new Error("Kraken PostTrade count does not match trades length");
  }
  if (typeof result.last_ts !== "string") {
    throw new Error("Kraken PostTrade last_ts must be a string");
  }
  const latestAt = parseIsoTimestamp(
    result.last_ts,
    "Kraken PostTrade last_ts",
  );
  return {
    lastTradeAt:
      result.trades.length === 0
        ? null
        : parseTrade(
            result.trades[0],
            expectedSymbol,
            "Kraken PostTrade trades[0]",
          ),
    latestAt,
    latestSequence: result.last_ts,
  };
};

const providerUrl = (endpoint: "PreTrade" | "PostTrade", symbol: string) => {
  const url = new URL(`${KRAKEN_API_URL}/${endpoint}`);
  url.searchParams.set("symbol", symbol);
  if (endpoint === "PostTrade") url.searchParams.set("count", "1");
  return url.toString();
};

const marketUrl = (symbol: string) => {
  const url = new URL(`${KRAKEN_API_URL}/AssetPairs`);
  url.searchParams.set("pair", symbol);
  return url.toString();
};

async function fetchKrakenBookIdentity(
  boundedRequest: (url: string) => Promise<unknown>,
  symbol: string,
  book: ReturnType<typeof parseKrakenPreTrade>,
): Promise<{
  lastTradeAt: number | null;
  observationAt: number;
  sequence: string;
}> {
  if (book.observationAt !== null && book.sequence !== null) {
    let lastTradeAt: number | null = null;
    try {
      lastTradeAt = parseKrakenPostTrade(
        await boundedRequest(providerUrl("PostTrade", symbol)),
        symbol,
      ).lastTradeAt;
    } catch {
      // PreTrade already supplies executable-book identity. Latest trades are
      // optional context on this path and may fail independently.
    }
    return {
      lastTradeAt,
      observationAt: book.observationAt,
      sequence: book.sequence,
    };
  }

  const trades = parseKrakenPostTrade(
    await boundedRequest(providerUrl("PostTrade", symbol)),
    symbol,
  );
  return {
    lastTradeAt: trades.lastTradeAt,
    observationAt: trades.latestAt,
    sequence: `kraken:${trades.latestSequence}:empty-book`,
  };
}

export const fetchKrakenObservation = async (
  request: KrakenObservationRequest,
  runtime: AdapterRuntime = {},
): Promise<PegObservation> => {
  const fetch = runtime.fetch ?? globalThis.fetch;
  const sleep = runtime.sleep ?? defaultSleep;
  const boundedRequest = (url: string) =>
    fetchBoundedJson({
      url,
      fetch,
      sleep,
      timeoutMs: KRAKEN_TIMEOUT_MS,
      maxResponseBytes: KRAKEN_MAX_RESPONSE_BYTES,
    });

  const marketState = parseKrakenMarketState(
    await boundedRequest(marketUrl(request.symbol)),
    request.symbol,
  );
  if (marketState === "absent") {
    throw new Error("Kraken market is absent from the provider listing");
  }
  const now = runtime.now ?? Date.now;
  // AssetPairs is authoritative for halts. Return before scheduling the
  // PreTrade and PostTrade requests, which do not supply executable identity
  // for a halted market.
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
  const book = parseKrakenPreTrade(
    await boundedRequest(providerUrl("PreTrade", request.symbol)),
    request.symbol,
  );
  const identity = await fetchKrakenBookIdentity(
    boundedRequest,
    request.symbol,
    book,
  );

  return createPegObservation({
    bids: book.bids,
    asks: book.asks,
    refSize: request.refSize,
    spreadEnvelopeBps: request.spreadEnvelopeBps,
    marketState,
    lastTradeAt: identity.lastTradeAt,
    fetchedAt: now(),
    observationAt: identity.observationAt,
    sequence: identity.sequence,
  });
};

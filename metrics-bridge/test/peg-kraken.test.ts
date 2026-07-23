import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchKrakenObservation,
  KRAKEN_BOOK_LEVEL_CAP,
  KRAKEN_MAX_RESPONSE_BYTES,
  KRAKEN_TIMEOUT_MS,
  parseKrakenMarketState,
  parseKrakenPreTrade,
} from "../src/peg/adapters/kraken.js";
import type { FetchLike } from "../src/peg/types.js";

const SYMBOL = "EUROP/EUR";
const BOOK_TIME = "2026-07-22T10:00:00.123456Z";
const ASK_TIME = "2026-07-22T10:00:01.123456Z";
const TRADE_TIME = "2026-07-22T09:59:59.555555Z";

const level = (
  side: "BUY" | "SELL",
  price: unknown,
  qty: unknown,
  publication_ts = BOOK_TIME,
) => ({ side, price, qty, count: 1, publication_ts });

const preTrade = (
  overrides: Partial<Record<"symbol" | "bids" | "asks", unknown>> = {},
) => ({
  error: [],
  result: {
    symbol: SYMBOL,
    bids: [level("BUY", "1.0000", "6")],
    asks: [level("SELL", "1.0010", "7", ASK_TIME)],
    ...overrides,
  },
});

const postTrade = () => ({
  error: [],
  result: {
    last_ts: "2026-07-22T10:00:02.123456789Z",
    count: 1,
    trades: [
      {
        trade_id: "TRADE-1",
        price: "1.0001",
        quantity: "2",
        symbol: SYMBOL,
        trade_ts: TRADE_TIME,
        publication_ts: "2026-07-22T10:00:00.000001Z",
      },
    ],
  },
});

const assetPairs = (status = "online", listed = true) => ({
  error: [],
  result: listed
    ? {
        [SYMBOL]: {
          wsname: SYMBOL,
          status,
        },
      }
    : {},
});

const jsonResponse = (
  payload: unknown,
  status = 200,
  headers: HeadersInit = {},
) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const queuedFetch = (responses: Array<Response | Error>) => {
  const queue = [...responses];
  return vi.fn<FetchLike>(async () => {
    const response = queue.shift();
    if (response === undefined) throw new Error("unexpected provider request");
    if (response instanceof Error) throw response;
    return response;
  });
};

const request = {
  symbol: SYMBOL,
  refSize: 10,
  spreadEnvelopeBps: 20,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Kraken response parsing", () => {
  it("binds observation identity to executable bids, not fresher asks", async () => {
    const fetch = queuedFetch([
      jsonResponse(assetPairs()),
      jsonResponse(preTrade()),
      jsonResponse(postTrade()),
    ]);
    const observation = await fetchKrakenObservation(request, {
      fetch,
      now: () => 1_800_000_000_000,
    });

    expect(observation).toMatchObject({
      bid: 1,
      ask: 1.001,
      vwap: 1,
      filledFraction: 0.6,
      capped: true,
      lastTradeAt: Date.parse(TRADE_TIME),
      fetchedAt: 1_800_000_000_000,
      observationAt: Date.parse(BOOK_TIME),
      sequence: `kraken:${BOOK_TIME}`,
      venueState: "ok",
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "AssetPairs?pair=EUROP%2FEUR",
    );
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      "PreTrade?symbol=EUROP%2FEUR",
    );
    expect(String(fetch.mock.calls[2]?.[0])).toContain(
      "PostTrade?symbol=EUROP%2FEUR&count=1",
    );
  });

  it("keeps sequence and observationAt stable for a frozen provider payload", async () => {
    const payloads = [
      jsonResponse(assetPairs()),
      jsonResponse(preTrade()),
      jsonResponse(postTrade()),
      jsonResponse(assetPairs()),
      jsonResponse(preTrade()),
      jsonResponse(postTrade()),
    ];
    const fetch = queuedFetch(payloads);
    let now = 1_800_000_000_000;
    const first = await fetchKrakenObservation(request, {
      fetch,
      now: () => now,
    });
    now += 60_000;
    const second = await fetchKrakenObservation(request, {
      fetch,
      now: () => now,
    });

    expect(second.sequence).toBe(first.sequence);
    expect(second.observationAt).toBe(first.observationAt);
    expect(second.fetchedAt).not.toBe(first.fetchedAt);
  });

  it("keeps an authoritative book when the latest-trade request fails", async () => {
    const observation = await fetchKrakenObservation(request, {
      fetch: queuedFetch([
        jsonResponse(assetPairs()),
        jsonResponse(preTrade()),
        new Error("PostTrade unavailable"),
      ]),
    });

    expect(observation).toMatchObject({
      bid: 1,
      ask: 1.001,
      lastTradeAt: null,
      observationAt: Date.parse(BOOK_TIME),
      sequence: `kraken:${BOOK_TIME}`,
      venueState: "ok",
    });
  });

  it("keeps an authoritative book when the latest-trade payload is malformed", async () => {
    const observation = await fetchKrakenObservation(request, {
      fetch: queuedFetch([
        jsonResponse(assetPairs()),
        jsonResponse(preTrade()),
        jsonResponse({ error: [], result: { malformed: true } }),
      ]),
    });

    expect(observation).toMatchObject({
      lastTradeAt: null,
      observationAt: Date.parse(BOOK_TIME),
      sequence: `kraken:${BOOK_TIME}`,
      venueState: "ok",
    });
  });

  it("uses PostTrade provider time to represent an empty listed book", async () => {
    const fetch = queuedFetch([
      jsonResponse(assetPairs()),
      jsonResponse(preTrade({ bids: [], asks: [] })),
      jsonResponse(postTrade()),
    ]);
    const observation = await fetchKrakenObservation(request, { fetch });

    expect(observation).toMatchObject({
      venueState: "evacuated",
      bid: null,
      ask: null,
      observationAt: Date.parse("2026-07-22T10:00:02.123456789Z"),
      sequence: "kraken:2026-07-22T10:00:02.123456789Z:empty-book",
    });
  });

  it("requires PostTrade when the listed book has no provider identity", async () => {
    await expect(
      fetchKrakenObservation(request, {
        fetch: queuedFetch([
          jsonResponse(assetPairs()),
          jsonResponse(preTrade({ bids: [], asks: [] })),
          new Error("PostTrade unavailable"),
        ]),
      }),
    ).rejects.toThrow("PostTrade unavailable");
  });

  it("rejects malformed numeric fields and oversized books", () => {
    expect(() =>
      parseKrakenPreTrade(
        preTrade({ bids: [level("BUY", "-1", "2")] }),
        SYMBOL,
      ),
    ).toThrow(/price/);
    expect(() =>
      parseKrakenPreTrade(
        preTrade({ bids: [level("BUY", Number.NaN, "2")] }),
        SYMBOL,
      ),
    ).toThrow(/price/);
    expect(() =>
      parseKrakenPreTrade(
        preTrade({
          bids: Array.from({ length: KRAKEN_BOOK_LEVEL_CAP + 1 }, () =>
            level("BUY", "1", "1"),
          ),
        }),
        SYMBOL,
      ),
    ).toThrow(/level cap/);
  });

  it("emits a status-only halt without requesting book or trade data", async () => {
    const fetch = queuedFetch([jsonResponse(assetPairs("cancel_only"))]);
    const halted = await fetchKrakenObservation(request, {
      fetch,
      now: () => 1_800_000_000_000,
    });
    expect(halted).toEqual({
      venueState: "halted",
      bid: null,
      ask: null,
      vwap: null,
      filledFraction: 0,
      capped: true,
      lastTradeAt: null,
      fetchedAt: 1_800_000_000_000,
      observationAt: null,
      sequence: null,
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.kraken.com/0/public/AssetPairs?pair=EUROP%2FEUR",
    ]);
  });

  it("rejects a market absent from the provider listing", async () => {
    const fetch = queuedFetch([jsonResponse(assetPairs("online", false))]);
    await expect(fetchKrakenObservation(request, { fetch })).rejects.toThrow(
      /absent/,
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(parseKrakenMarketState(assetPairs(), SYMBOL)).toBe("listed");
  });
});

describe("Kraken transport bounds", () => {
  it("retries one 429 response and then succeeds", async () => {
    const fetch = queuedFetch([
      jsonResponse({}, 429, { "retry-after": "0" }),
      jsonResponse(assetPairs()),
      jsonResponse(preTrade()),
      jsonResponse(postTrade()),
    ]);
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchKrakenObservation(request, { fetch, sleep }),
    ).resolves.toMatchObject({ sequence: `kraken:${BOOK_TIME}` });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("caps retryable failures at one retry", async () => {
    const fetch = queuedFetch([jsonResponse({}, 503), jsonResponse({}, 503)]);

    await expect(fetchKrakenObservation(request, { fetch })).rejects.toThrow(
      /HTTP 503/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a request at the provider timeout without retrying", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<FetchLike>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const pending = fetchKrakenObservation(request, { fetch });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(KRAKEN_TIMEOUT_MS);
    await assertion;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a response whose declared size exceeds the byte cap", async () => {
    const fetch = queuedFetch([
      jsonResponse(assetPairs()),
      jsonResponse(preTrade(), 200, {
        "content-length": String(KRAKEN_MAX_RESPONSE_BYTES + 1),
      }),
      jsonResponse(postTrade()),
    ]);

    await expect(fetchKrakenObservation(request, { fetch })).rejects.toThrow(
      /exceeds/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

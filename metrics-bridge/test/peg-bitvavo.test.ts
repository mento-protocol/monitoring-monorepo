import { describe, expect, it, vi } from "vitest";
import {
  BITVAVO_BOOK_LEVEL_CAP,
  BITVAVO_MAX_RESPONSE_BYTES,
  fetchBitvavoObservation,
  parseBitvavoBook,
  parseBitvavoMarketState,
  parseBitvavoTrades,
} from "../src/peg/adapters/bitvavo.js";
import type { FetchLike } from "../src/peg/types.js";

const MARKET = "EUROP-EUR";
// JSON numbers at nanosecond scale are already rounded by JSON.parse; the
// provider nonce remains the exact frozen-payload identity.
const BOOK_NS = Number("1752139200123456789");
const TRADE_MS = 1_752_139_199_987;

const book = (
  overrides: Partial<
    Record<"market" | "nonce" | "bids" | "asks" | "timestamp", unknown>
  > = {},
) => ({
  market: MARKET,
  nonce: 438_524,
  bids: [
    ["0.999", "6"],
    ["1.000", "6"],
  ],
  asks: [
    ["1.002", "8"],
    ["1.001", "8"],
  ],
  timestamp: BOOK_NS,
  ...overrides,
});

const trades = () => [
  {
    id: "57b1159b-6bf5-4cde-9e2c-6bd6a5678baf",
    timestamp: TRADE_MS,
    amount: "0.1",
    price: "1.0001",
    side: "sell",
  },
];

const market = (status = "trading") => ({
  market: MARKET,
  status,
  base: "EUROP",
  quote: "EUR",
});

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
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
  market: MARKET,
  refSize: 10,
  spreadEnvelopeBps: 20,
};

describe("Bitvavo response parsing", () => {
  it("uses the book nonce and nanosecond snapshot time as provider identity", async () => {
    const fetch = queuedFetch([
      jsonResponse(market()),
      jsonResponse(book()),
      jsonResponse(trades()),
    ]);
    const observation = await fetchBitvavoObservation(request, {
      fetch,
      now: () => 1_900_000_000_000,
    });

    expect(observation).toMatchObject({
      bid: 1,
      ask: 1.001,
      vwap: 0.9996,
      filledFraction: 1,
      capped: false,
      lastTradeAt: TRADE_MS,
      fetchedAt: 1_900_000_000_000,
      observationAt: Math.floor(BOOK_NS / 1_000_000),
      sequence: "bitvavo:438524",
      venueState: "ok",
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "markets?market=EUROP-EUR",
    );
    expect(String(fetch.mock.calls[1]?.[0])).toContain(
      "EUROP-EUR/book?depth=1000",
    );
    expect(String(fetch.mock.calls[2]?.[0])).toContain(
      "EUROP-EUR/trades?limit=1",
    );
  });

  it("keeps sequence and observationAt stable for a frozen nonce", async () => {
    const fetch = queuedFetch([
      jsonResponse(market()),
      jsonResponse(book()),
      jsonResponse(trades()),
      jsonResponse(market()),
      jsonResponse(book()),
      jsonResponse(trades()),
    ]);
    let now = 1_900_000_000_000;
    const first = await fetchBitvavoObservation(request, {
      fetch,
      now: () => now,
    });
    now += 60_000;
    const second = await fetchBitvavoObservation(request, {
      fetch,
      now: () => now,
    });

    expect(second.sequence).toBe(first.sequence);
    expect(second.observationAt).toBe(first.observationAt);
    expect(second.fetchedAt).not.toBe(first.fetchedAt);
  });

  it("keeps an authoritative book when the latest-trade request fails", async () => {
    const observation = await fetchBitvavoObservation(request, {
      fetch: queuedFetch([
        jsonResponse(market()),
        jsonResponse(book()),
        new Error("latest trades unavailable"),
      ]),
    });

    expect(observation).toMatchObject({
      bid: 1,
      ask: 1.001,
      lastTradeAt: null,
      observationAt: Math.floor(BOOK_NS / 1_000_000),
      sequence: "bitvavo:438524",
      venueState: "ok",
    });
  });

  it("keeps an authoritative book when the latest-trade payload is malformed", async () => {
    const observation = await fetchBitvavoObservation(request, {
      fetch: queuedFetch([
        jsonResponse(market()),
        jsonResponse(book()),
        jsonResponse({ malformed: true }),
      ]),
    });

    expect(observation).toMatchObject({
      lastTradeAt: null,
      observationAt: Math.floor(BOOK_NS / 1_000_000),
      sequence: "bitvavo:438524",
      venueState: "ok",
    });
  });

  it("classifies wide and empty listed markets", async () => {
    const wide = await fetchBitvavoObservation(
      { ...request, spreadEnvelopeBps: 5 },
      {
        fetch: queuedFetch([
          jsonResponse(market()),
          jsonResponse(book()),
          jsonResponse(trades()),
        ]),
      },
    );
    expect(wide.venueState).toBe("wide");

    const empty = await fetchBitvavoObservation(request, {
      fetch: queuedFetch([
        jsonResponse(market()),
        jsonResponse(book({ bids: [], asks: [] })),
        jsonResponse([]),
      ]),
    });
    expect(empty).toMatchObject({
      venueState: "evacuated",
      lastTradeAt: null,
      bid: null,
      ask: null,
    });
  });

  it.each(["halted", "auction", "auctionMatching", "cancelOnly"])(
    "emits a status-only halt for %s without requesting a 409-prone book or trade",
    async (status) => {
      const fetch = queuedFetch([jsonResponse(market(status))]);
      const halted = await fetchBitvavoObservation(request, {
        fetch,
        now: () => 1_900_000_000_000,
      });

      expect(halted).toMatchObject({
        venueState: "halted",
        bid: null,
        ask: null,
        vwap: null,
        filledFraction: 0,
        capped: true,
        lastTradeAt: null,
        fetchedAt: 1_900_000_000_000,
        observationAt: null,
        sequence: null,
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(String(fetch.mock.calls[0]?.[0])).toContain(
        "markets?market=EUROP-EUR",
      );
    },
  );

  it("rejects an absent provider listing before reading its book", async () => {
    const fetch = queuedFetch([jsonResponse([])]);
    await expect(fetchBitvavoObservation(request, { fetch })).rejects.toThrow(
      /absent/,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("parses every documented non-trading status as halted", () => {
    expect(parseBitvavoMarketState(market(), MARKET)).toBe("listed");
    for (const status of [
      "halted",
      "auction",
      "auctionMatching",
      "cancelOnly",
    ]) {
      expect(parseBitvavoMarketState(market(status), MARKET)).toBe("halted");
    }
  });

  it("rejects malformed numeric fields and oversized books", () => {
    expect(() =>
      parseBitvavoBook(book({ bids: [["-1", "2"]] }), MARKET),
    ).toThrow(/bids\[0\]\[0\]/);
    expect(() =>
      parseBitvavoBook(book({ bids: [[Number.NaN, "2"]] }), MARKET),
    ).toThrow(/bids\[0\]\[0\]/);
    expect(() =>
      parseBitvavoBook(
        book({
          bids: Array.from({ length: BITVAVO_BOOK_LEVEL_CAP + 1 }, () => [
            "1",
            "1",
          ]),
        }),
        MARKET,
      ),
    ).toThrow(/level cap/);
  });

  it("rejects malformed latest-trade payloads", () => {
    expect(() => parseBitvavoTrades({})).toThrow(/at most one trade/);
    expect(() =>
      parseBitvavoTrades([{ ...trades()[0], timestamp: -1 }]),
    ).toThrow(/timestamp/);
    expect(() =>
      parseBitvavoTrades([{ ...trades()[0], side: "unknown" }]),
    ).toThrow(/side/);
  });
});

describe("Bitvavo transport bounds", () => {
  it("does not retry a non-retryable 4xx response", async () => {
    const fetch = queuedFetch([jsonResponse({}, 400)]);
    await expect(fetchBitvavoObservation(request, { fetch })).rejects.toThrow(
      /HTTP 400/,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops streaming a response after the byte cap", async () => {
    const fetch = queuedFetch([
      jsonResponse(market()),
      new Response(" ".repeat(BITVAVO_MAX_RESPONSE_BYTES + 1), {
        status: 200,
      }),
      jsonResponse(trades()),
    ]);
    await expect(fetchBitvavoObservation(request, { fetch })).rejects.toThrow(
      /exceeds/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

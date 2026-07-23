import { describe, expect, it, vi } from "vitest";
import {
  createPegObservation,
  executableSellQuote,
  fetchBoundedJson,
  sortBookLevels,
} from "../src/peg/order-book.js";
import type { PegObservationInput } from "../src/peg/order-book.js";

const observationInput = (
  overrides: Partial<PegObservationInput> = {},
): PegObservationInput => ({
  bids: [{ price: 1, size: 20 }],
  asks: [{ price: 1.001, size: 20 }],
  refSize: 10,
  spreadEnvelopeBps: 20,
  marketState: "listed",
  lastTradeAt: 1_720_000_000_000,
  fetchedAt: 1_720_000_001_000,
  observationAt: 1_720_000_000_500,
  sequence: "provider:123",
  ...overrides,
});

describe("executableSellQuote", () => {
  it("walks descending bids to fill the requested sell size", () => {
    const quote = executableSellQuote(
      [
        { price: 0.98, size: 100 },
        { price: 1, size: 5 },
        { price: 0.99, size: 10 },
      ],
      10,
    );

    expect(quote.vwap).toBeCloseTo(0.995);
    expect(quote).toMatchObject({ filledFraction: 1, capped: false });
  });

  it("treats an exact aggregate fill as uncapped", () => {
    expect(
      executableSellQuote(
        [
          { price: 1, size: 4 },
          { price: 0.99, size: 6 },
        ],
        10,
      ),
    ).toEqual({ vwap: 0.994, filledFraction: 1, capped: false });
  });

  it("returns the partial-fill VWAP and marks insufficient depth capped", () => {
    expect(executableSellQuote([{ price: 0.97, size: 4 }], 10)).toEqual({
      vwap: 0.97,
      filledFraction: 0.4,
      capped: true,
    });
  });

  it("sorts a copy and leaves provider order untouched", () => {
    const levels = [
      { price: 0.9, size: 1 },
      { price: 1.1, size: 1 },
      { price: 1, size: 1 },
    ];
    expect(
      sortBookLevels(levels, "descending").map(({ price }) => price),
    ).toEqual([1.1, 1, 0.9]);
    expect(levels.map(({ price }) => price)).toEqual([0.9, 1.1, 1]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid refSize %s",
    (refSize) => {
      expect(() => executableSellQuote([], refSize)).toThrow(/refSize/);
    },
  );

  it("rejects negative, zero, NaN, and infinite book values", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => executableSellQuote([{ price: value, size: 1 }], 1)).toThrow(
        /price/,
      );
      expect(() => executableSellQuote([{ price: 1, size: value }], 1)).toThrow(
        /size/,
      );
    }
  });

  it("rejects finite levels whose fill multiplication overflows", () => {
    expect(() =>
      executableSellQuote([{ price: Number.MAX_VALUE, size: 2 }], 2),
    ).toThrow(/fill multiplication must be finite/);
  });

  it("rejects finite fill products whose quote accumulation overflows", () => {
    expect(() =>
      executableSellQuote(
        [
          { price: Number.MAX_VALUE, size: 1 },
          { price: Number.MAX_VALUE, size: 1 },
        ],
        2,
      ),
    ).toThrow(/quote accumulation must be finite/);
  });

  it("preserves a quote at the maximum finite arithmetic boundary", () => {
    expect(
      executableSellQuote(
        [
          { price: Number.MAX_VALUE, size: 0.5 },
          { price: Number.MAX_VALUE, size: 0.5 },
        ],
        1,
      ),
    ).toEqual({
      vwap: Number.MAX_VALUE,
      filledFraction: 1,
      capped: false,
    });
  });
});

describe("createPegObservation", () => {
  it("classifies normal and envelope-excess two-sided books", () => {
    expect(createPegObservation(observationInput()).venueState).toBe("ok");
    expect(
      createPegObservation(
        observationInput({
          bids: [{ price: 0.99, size: 20 }],
          asks: [{ price: 1.01, size: 20 }],
          spreadEnvelopeBps: 100,
        }),
      ).venueState,
    ).toBe("wide");
  });

  it("classifies one-sided and evacuated listed books", () => {
    const bidOnly = createPegObservation(observationInput({ asks: [] }));
    expect(bidOnly.venueState).toBe("one_sided_bid");
    expect(bidOnly.ask).toBeNull();

    const askOnly = createPegObservation(observationInput({ bids: [] }));
    expect(askOnly).toMatchObject({
      venueState: "one_sided_ask",
      bid: null,
      vwap: null,
      filledFraction: 0,
      capped: true,
    });

    expect(
      createPegObservation(observationInput({ bids: [], asks: [] })),
    ).toMatchObject({ venueState: "evacuated", bid: null, ask: null });
  });

  it("lets an injected halt state take precedence over book shape", () => {
    expect(
      createPegObservation(
        observationInput({
          bids: [],
          asks: [],
          marketState: "halted",
        }),
      ).venueState,
    ).toBe("halted");
  });

  it("allows only status-only halted observations to omit provider identity", () => {
    expect(
      createPegObservation(
        observationInput({
          bids: [],
          asks: [],
          marketState: "halted",
          lastTradeAt: null,
          observationAt: null,
          sequence: null,
        }),
      ),
    ).toMatchObject({
      venueState: "halted",
      observationAt: null,
      sequence: null,
    });
    expect(() =>
      createPegObservation(
        observationInput({ observationAt: null, sequence: null }),
      ),
    ).toThrow(/only a status-only halted observation/);
    expect(() =>
      createPegObservation(observationInput({ sequence: null })),
    ).toThrow(/both be present or null/);
  });

  it.each([
    ["bids", { bids: [{ price: 1, size: 1 }] }],
    ["asks", { asks: [{ price: 1, size: 1 }] }],
    ["lastTradeAt", { lastTradeAt: 1_720_000_000_000 }],
  ] satisfies ReadonlyArray<[string, Partial<PegObservationInput>]>)(
    "rejects %s on a halted observation without provider identity",
    (_field, unsafeFields) => {
      expect(() =>
        createPegObservation(
          observationInput({
            bids: [],
            asks: [],
            marketState: "halted",
            lastTradeAt: null,
            observationAt: null,
            sequence: null,
            ...unsafeFields,
          }),
        ),
      ).toThrow(/status-only halted observation/);
    },
  );

  it("rejects an absent market as registry rot", () => {
    expect(() =>
      createPegObservation(observationInput({ marketState: "absent" })),
    ).toThrow(/absent/);
  });

  it("rejects crossed books and invalid spread policy", () => {
    expect(() =>
      createPegObservation(
        observationInput({
          bids: [{ price: 1.01, size: 1 }],
          asks: [{ price: 1, size: 1 }],
        }),
      ),
    ).toThrow(/crossed/);
    expect(() =>
      createPegObservation(observationInput({ spreadEnvelopeBps: -1 })),
    ).toThrow(/spreadEnvelopeBps/);
  });

  it("rejects overflowing quote arithmetic before publishing an observation", () => {
    expect(() =>
      createPegObservation(
        observationInput({
          bids: [{ price: Number.MAX_VALUE, size: 2 }],
          asks: [{ price: Number.MAX_VALUE, size: 2 }],
          refSize: 2,
        }),
      ),
    ).toThrow(/fill multiplication must be finite/);
  });
});

const trackedErrorResponse = (status: number) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("upstream error"));
    },
    cancel,
  });
  return { cancel, response: new Response(body, { status }) };
};

describe("fetchBoundedJson", () => {
  const request = (fetch: typeof globalThis.fetch, sleep = vi.fn()) => ({
    url: "https://provider.invalid/book",
    fetch,
    sleep,
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
  });

  it("cancels a retryable error body before the retry", async () => {
    const retryable = trackedErrorResponse(503);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(retryable.response)
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(fetchBoundedJson(request(fetch, sleep))).resolves.toEqual({
      ok: true,
    });
    expect(retryable.cancel).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels a terminal error body before throwing", async () => {
    const terminal = trackedErrorResponse(400);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(terminal.response);

    await expect(fetchBoundedJson(request(fetch))).rejects.toThrow(/HTTP 400/);
    expect(terminal.cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a body whose declared content length exceeds the cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(body, {
        headers: { "content-length": "2048" },
      }),
    );

    await expect(fetchBoundedJson(request(fetch))).rejects.toThrow(
      /exceeds 1024 bytes/,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

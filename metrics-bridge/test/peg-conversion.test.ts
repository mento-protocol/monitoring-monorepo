import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  conversionFeedPair,
  convertQuotePriceToPeg,
  MAX_ORACLE_CLOCK_SKEW_SECONDS,
  readPegConversionLeg,
} from "../src/peg/conversion.js";
import type { PegConversion } from "../src/peg/registry.js";

const CONVERSION: PegConversion = {
  chainId: 137,
  rateFeedId: "0xec57482aa55e3ad026c315a0e4a692b776c318ca",
  fromCurrency: "USD",
  toCurrency: "EUR",
};

function client(results: unknown[]): PublicClient {
  return {
    readContract: vi.fn().mockImplementation(() => {
      const result = results.shift();
      if (result instanceof Error) throw result;
      return Promise.resolve(result);
    }),
  } as unknown as PublicClient;
}

describe("Peg conversion", () => {
  it("binds the feed to the declared chain and currency direction", () => {
    expect(conversionFeedPair(CONVERSION)).toBe("EUR/USD");
    expect(() =>
      conversionFeedPair({ ...CONVERSION, chainId: 143 }),
    ).not.toThrow();
    expect(() => conversionFeedPair({ ...CONVERSION, chainId: 42220 })).toThrow(
      /Unknown conversion feed/,
    );
    expect(() =>
      conversionFeedPair({ ...CONVERSION, toCurrency: "GBP" }),
    ).toThrow(/does not compose/);
  });

  it("reads token-first expiry and divides USD price by EUR/USD", async () => {
    const leg = await readPegConversionLeg(
      CONVERSION,
      client([[1_14n, 100n], 1_700_000_000n, 300n]),
      1_700_000_100,
    );

    expect(leg).toMatchObject({
      rate: 1.14,
      medianAt: 1_700_000_000,
      expirySeconds: 300,
      authoritative: true,
      unavailableReason: null,
    });
    expect(convertQuotePriceToPeg(1.14, leg)).toBeCloseTo(1, 12);
  });

  it("falls back to the global expiry when the token override is zero", async () => {
    const rpc = client([[114n, 100n], 1_700_000_000n, 0n, 360n]);
    const leg = await readPegConversionLeg(CONVERSION, rpc, 1_700_000_100);
    expect(leg.expirySeconds).toBe(360);
    expect(rpc.readContract).toHaveBeenCalledTimes(4);
  });

  it("demotes stale and FX-weekend legs from alert authority", async () => {
    const stale = await readPegConversionLeg(
      CONVERSION,
      client([[114n, 100n], 1_700_000_000n, 150n]),
      1_700_000_151,
    );
    expect(stale).toMatchObject({
      authoritative: false,
      unavailableReason: "stale",
    });
    expect(() => convertQuotePriceToPeg(1.14, stale)).toThrow(
      /not alert-authoritative/,
    );

    // Friday 2024-01-05 22:00 UTC is inside the configured FX weekend.
    const weekendNow = Date.UTC(2024, 0, 5, 22) / 1_000;
    const weekend = await readPegConversionLeg(
      CONVERSION,
      client([[114n, 100n], BigInt(weekendNow - 30), 300n]),
      weekendNow,
    );
    expect(weekend).toMatchObject({
      authoritative: false,
      unavailableReason: "fx_market_pause",
    });
  });

  it("demotes a median timestamp beyond bounded future clock skew", async () => {
    const now = 1_700_000_000;
    const future = await readPegConversionLeg(
      CONVERSION,
      client([
        [114n, 100n],
        BigInt(now + MAX_ORACLE_CLOCK_SKEW_SECONDS + 1),
        300n,
      ]),
      now,
    );

    expect(future).toMatchObject({
      authoritative: false,
      unavailableReason: "future_timestamp",
    });
  });

  it("rejects invalid on-chain rate and timestamp values", async () => {
    await expect(
      readPegConversionLeg(
        CONVERSION,
        client([[0n, 100n], 1_700_000_000n, 300n]),
      ),
    ).rejects.toThrow(/median rate must be positive/);
    await expect(
      readPegConversionLeg(CONVERSION, client([[114n, 100n], 0n, 300n])),
    ).rejects.toThrow(/medianTimestamp/);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PegStructuralContextResult } from "../src/peg/graphql.js";
import type { PegAssetMetricSnapshot } from "../src/peg/metrics.js";
import {
  PegPolicyVersionSchema,
  pegPolicyVersionForContent,
} from "../src/peg/policy.js";
import {
  createPegPoller,
  MAX_PROVIDER_CLOCK_SKEW_MS,
  type PegPollCycleInput,
  type PegPollErrorEvent,
} from "../src/peg/poller.js";
import { parsePegRegistry } from "../src/peg/registry.js";
import type { PegObservation } from "../src/peg/types.js";

const fixed15 = (tokens: number) => (BigInt(tokens) * 10n ** 15n).toString();

const address = (character: string) => `0x${character.repeat(40)}`;

interface SourceSpec {
  id: string;
  provider: "bitvavo" | "kraken";
  pair: string;
  authority: "deep" | "secondary" | "display";
  pollIntervalSeconds?: number;
  staleAfterSeconds?: number;
  converted?: boolean;
}

interface AssetSpec {
  id: string;
  token: string;
  pool: string;
  feed: string;
  sources: SourceSpec[];
}

const primarySource = (overrides: Partial<SourceSpec> = {}): SourceSpec => ({
  id: "deep_eur",
  provider: "bitvavo",
  pair: "PEG-EUR",
  authority: "deep",
  pollIntervalSeconds: 30,
  staleAfterSeconds: 120,
  ...overrides,
});

const primaryAsset = (overrides: Partial<AssetSpec> = {}): AssetSpec => ({
  id: "asset-one",
  token: address("1"),
  pool: address("2"),
  feed: address("3"),
  sources: [primarySource()],
  ...overrides,
});

const makeInput = (specs: AssetSpec[]) => {
  const registry: Record<string, unknown> = {};
  const assets: Record<string, unknown> = {};
  for (const spec of specs) {
    registry[spec.id] = {
      peg: "EUR",
      tokenRefs: [{ chainId: 137, address: spec.token }],
      sources: spec.sources.map((source) => ({
        id: source.id,
        provider: source.provider,
        pair: source.pair,
        baseCurrency: "PEG",
        quoteCurrency: source.converted ? "USD" : "EUR",
        role:
          source.authority === "deep"
            ? "primary"
            : source.authority === "secondary"
              ? "secondary"
              : "display",
        ...(source.converted
          ? {
              convertVia: {
                chainId: 137,
                rateFeedId: address("4"),
                fromCurrency: "USD",
                toCurrency: "EUR",
              },
            }
          : {}),
      })),
      monitors: [
        {
          chainId: 137,
          poolAddress: spec.pool,
          rateFeedId: spec.feed,
          monitoredTokenAddress: spec.token,
        },
      ],
      coverageClass: "cex-book+indexed-pool",
      rejectedSources: [],
    };
    assets[spec.id] = {
      target: 1,
      warnDeviationBps: 25,
      criticalDeviationBps: 50,
      premiumWarnBps: 25,
      warnSustainSeconds: 600,
      criticalSustainSeconds: 1_200,
      durationQuantile: 0.2,
      minimumCoverageFraction: 0.8,
      blindConsecutivePolls: 3,
      permanentlyDeadSeconds: 259_200,
      structuralWarnFraction: 0.8,
      freshnessGraceSeconds: 300,
      deepVenueSource: spec.sources.find(
        ({ authority }) => authority === "deep",
      )?.id,
      sources: Object.fromEntries(
        spec.sources.map((source) => [
          source.id,
          {
            authority: source.authority,
            referenceSizeCap: 50,
            pollIntervalSeconds: source.pollIntervalSeconds ?? 30,
            staleAfterSeconds: source.staleAfterSeconds ?? 120,
            spreadEnvelopeBps: 50,
            conversionErrorBps: source.converted ? 30 : 0,
          },
        ]),
      ),
    };
  }
  const candidate = {
    rolloverAckExpectedSeconds: 300,
    assets,
  };
  return {
    registry: parsePegRegistry(registry),
    policy: PegPolicyVersionSchema.parse({
      ...candidate,
      version: pegPolicyVersionForContent("test-v1", candidate),
    }),
  };
};

const structuralContext = (
  spec: AssetSpec,
  nowSeconds: number,
  overrides: {
    limit0?: string;
    limit1?: string;
    netflow0?: string;
    netflow1?: string;
    decimals?: number;
    feed?: string;
    source?: string;
    pageSaturated?: boolean;
  } = {},
): PegStructuralContextResult => ({
  status: "ok",
  pool: {
    id: `137-${spec.pool}`,
    chainId: 137,
    source: overrides.source ?? "fpmm_factory",
    token0: spec.token,
    token1: address("a"),
    token0Decimals: 6,
    token1Decimals: 18,
    reserves0: "100000000",
    reserves1: "100000000000000000000",
    referenceRateFeedID: overrides.feed ?? spec.feed,
  },
  tradingLimit: {
    id: `137-${spec.pool}-${spec.token}`,
    chainId: 137,
    poolId: `137-${spec.pool}`,
    token: spec.token,
    limit0: overrides.limit0 ?? fixed15(50),
    limit1: overrides.limit1 ?? fixed15(250),
    decimals: overrides.decimals ?? 15,
    netflow0: overrides.netflow0 ?? fixed15(10),
    netflow1: overrides.netflow1 ?? fixed15(20),
    lastUpdated0: String(nowSeconds),
    lastUpdated1: String(nowSeconds),
    updatedAtBlock: "123",
    updatedAtTimestamp: String(nowSeconds),
  },
  swaps: [
    {
      id: "swap-1",
      caller: address("b"),
      amount0In: "1000000",
      amount1In: "0",
      amount0Out: "0",
      amount1Out: "0",
      blockTimestamp: String(nowSeconds),
    },
  ],
  pageSaturated: overrides.pageSaturated ?? false,
});

const observation = (
  nowMs: number,
  overrides: Partial<PegObservation> = {},
): PegObservation => ({
  vwap: 1,
  filledFraction: 1,
  capped: false,
  bid: 0.999,
  ask: 1.001,
  lastTradeAt: nowMs - 1_000,
  fetchedAt: nowMs,
  observationAt: nowMs,
  sequence: `sequence-${nowMs}`,
  venueState: "ok",
  ...overrides,
});

const source = (snapshot: PegAssetMetricSnapshot, sourceId = "deep_eur") => {
  const found = snapshot.sources.find(({ source: id }) => id === sourceId);
  if (found === undefined) throw new Error(`missing source ${sourceId}`);
  return found;
};

describe("peg poll cycle freshness and measurements", () => {
  it("does not count a frozen at-par book and fails it stale", async () => {
    const spec = primaryAsset({
      sources: [primarySource({ staleAfterSeconds: 60 })],
    });
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    const frozen = observation(baseMs, { sequence: "frozen" });
    const publish = vi.fn<(snapshots: PegAssetMetricSnapshot[]) => void>();
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () => frozen),
      publish,
    });

    const first = (await poller.pollCycle(input))[0]!;
    expect(source(first)).toMatchObject({
      healthy: true,
      newSuccess: true,
      newUsableDecision: true,
      deviationBps: 0,
    });
    expect(first).toMatchObject({
      blind: false,
      lastPollAt: Math.floor(baseMs / 1_000),
    });

    nowMs = baseMs + 30_000;
    const second = (await poller.pollCycle(input))[0]!;
    expect(source(second)).toMatchObject({
      healthy: false,
      observation: null,
      newSuccess: false,
      newUsableDecision: false,
    });

    nowMs = baseMs + 61_000;
    const third = (await poller.pollCycle(input))[0]!;
    expect(source(third)).toMatchObject({
      healthy: false,
      newSuccess: false,
      newUsableDecision: false,
      observation: null,
    });
    expect(third.blind).toBe(true);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("rejects a different but older recent provider snapshot", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    const responses = [
      observation(baseMs, { sequence: "newer" }),
      observation(baseMs + 30_000, {
        observationAt: baseMs - 1,
        sequence: "older-but-different",
      }),
    ];
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () => {
        const next = responses.shift();
        if (next === undefined) throw new Error("unexpected provider request");
        return next;
      }),
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const accepted = (await poller.pollCycle(input))[0]!;
    expect(source(accepted)).toMatchObject({
      healthy: true,
      newSuccess: true,
      observation: { sequence: "newer" },
    });

    nowMs += 30_000;
    const regressed = (await poller.pollCycle(input))[0]!;
    expect(source(regressed)).toMatchObject({
      healthy: false,
      observation: null,
      newSuccess: false,
    });
    expect(regressed.blind).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "source_freshness" });
    expect(errors[0]?.cause).toEqual(
      new Error("venue observation timestamp regressed"),
    );
  });

  it("accepts distinct same-millisecond updates once and rejects A/B replay", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    const responses = ["A", "B", "A", "B"].map((sequence) =>
      observation(baseMs, { sequence }),
    );
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () => {
        const next = responses.shift();
        if (next === undefined) throw new Error("unexpected provider request");
        return next;
      }),
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const successes: boolean[] = [];
    for (let index = 0; index < 4; index += 1) {
      const snapshot = (await poller.pollCycle(input))[0]!;
      successes.push(source(snapshot).newSuccess);
      nowMs += 30_000;
    }

    expect(successes).toEqual([true, true, false, false]);
    expect(errors.map(({ kind }) => kind)).toEqual([
      "source_freshness",
      "source_freshness",
    ]);
    expect(errors.map(({ cause }) => cause)).toEqual([
      new Error("venue observation did not advance"),
      new Error("venue observation did not advance"),
    ]);
  });

  it("fails closed when one timestamp exceeds the bounded identity set", async () => {
    const spec = primaryAsset({
      sources: [primarySource({ staleAfterSeconds: 3_600 })],
    });
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    let sequence = 0;
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () =>
        observation(baseMs, { sequence: `same-ms-${sequence++}` }),
      ),
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const successes: boolean[] = [];
    for (let index = 0; index < 65; index += 1) {
      const snapshot = (await poller.pollCycle(input))[0]!;
      successes.push(source(snapshot).newSuccess);
      nowMs += 30_000;
    }

    expect(successes.filter(Boolean)).toHaveLength(64);
    expect(successes.at(-1)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.cause).toEqual(
      new Error("venue observation identity bound exceeded"),
    );
  });

  it("falls back to the cap for disabled limits and binds to a positive limit", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    let nowMs = 1_800_000_000_000;
    let limit0 = "0";
    const fetchBitvavo = vi.fn(async () => observation(nowMs));
    const fetchStructuralContext = vi.fn(async () =>
      structuralContext(spec, Math.floor(nowMs / 1_000), {
        limit0,
        limit1: "0",
        netflow0: "0",
        netflow1: "0",
      }),
    );
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext,
      fetchBitvavo,
      publish: vi.fn(),
    });

    const capSnapshot = (await poller.pollCycle(input))[0]!;
    expect(source(capSnapshot).referenceSize).toBe(50);
    expect(fetchBitvavo.mock.calls[0]?.[0]).toMatchObject({
      market: "PEG-EUR",
      refSize: 50,
    });
    expect(fetchStructuralContext.mock.calls[0]?.[0]).toMatchObject({
      poolId: `137-${spec.pool}`,
      monitoredToken: spec.token,
      since: BigInt(Math.floor(nowMs / 1_000) - 86_400),
    });

    limit0 = fixed15(20);
    nowMs += 1_000;
    const limitedSnapshot = (await poller.pollCycle(input))[0]!;
    expect(source(limitedSnapshot).referenceSize).toBe(20);
    expect(fetchBitvavo.mock.calls[1]?.[0].refSize).toBe(20);
  });

  it("marks a capped deep observation blind and omits deviation", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const nowMs = 1_800_000_000_000;
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () =>
        observation(nowMs, {
          vwap: 0.9,
          filledFraction: 0.5,
          capped: true,
        }),
      ),
      publish: vi.fn(),
    });

    const snapshot = (await poller.pollCycle(input))[0]!;
    expect(snapshot).toMatchObject({
      blind: true,
      blindConsecutivePolls: 1,
      structuralSaturation: 0.2,
      counterpartyCount: 1,
    });
    expect(source(snapshot)).toMatchObject({
      healthy: true,
      newSuccess: true,
      newUsableDecision: false,
      deviationBps: null,
      premiumBps: null,
    });
    expect(source(snapshot).observation?.vwap).toBe(0.9);
  });

  it("counts only due deep slots across a blind-usable-blind evaluation gap", async () => {
    const spec = primaryAsset({
      sources: [
        primarySource(),
        primarySource({
          id: "secondary_eur",
          pair: "PEG2-EUR",
          authority: "secondary",
          pollIntervalSeconds: 15,
        }),
      ],
    });
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    const fetchBitvavo = vi.fn(async ({ market }: { market: string }) => {
      const elapsedSeconds = (nowMs - baseMs) / 1_000;
      const usable = market === "PEG-EUR" && elapsedSeconds === 30;
      return observation(nowMs, {
        vwap: usable ? 1 : 0.9,
        capped: !usable,
        filledFraction: usable ? 1 : 0.5,
        sequence: `${market}-${elapsedSeconds}`,
      });
    });
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      publish: vi.fn(),
    });

    for (const [elapsedSeconds, expectedBlind, expectedCount] of [
      [0, true, 1],
      [15, true, 1],
      [30, false, 0],
      [45, false, 0],
      [60, true, 1],
      [90, true, 2],
      [120, true, 3],
      [150, true, 3],
    ] as const) {
      nowMs = baseMs + elapsedSeconds * 1_000;
      const current = (await poller.pollCycle(input))[0]!;
      expect(current).toMatchObject({
        blind: expectedBlind,
        blindConsecutivePolls: expectedCount,
      });
    }

    const deepCalls = fetchBitvavo.mock.calls.filter(
      ([request]) => request.market === "PEG-EUR",
    );
    const secondaryCalls = fetchBitvavo.mock.calls.filter(
      ([request]) => request.market === "PEG2-EUR",
    );
    expect(deepCalls).toHaveLength(6);
    expect(secondaryCalls).toHaveLength(8);
  });

  it("rejects a materially future-dated provider timestamp", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const nowMs = 1_800_000_000_000;
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () =>
        observation(nowMs, {
          observationAt: nowMs + MAX_PROVIDER_CLOCK_SKEW_MS + 1,
        }),
      ),
      publish: vi.fn(),
    });

    const snapshot = (await poller.pollCycle(input))[0]!;
    expect(source(snapshot)).toMatchObject({
      healthy: false,
      observation: null,
      newSuccess: false,
    });
    expect(snapshot.blind).toBe(true);
  });

  it("keeps a halted book visible but excludes it from executable paging", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const nowMs = 1_800_000_000_000;
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () =>
        observation(nowMs, { venueState: "halted", vwap: 0.9 }),
      ),
      publish: vi.fn(),
    });

    const snapshot = (await poller.pollCycle(input))[0]!;
    expect(source(snapshot)).toMatchObject({
      healthy: false,
      observation: { venueState: "halted", vwap: 0.9 },
      deviationBps: null,
      premiumBps: null,
      newSuccess: false,
      newUsableDecision: false,
    });
    expect(snapshot.blind).toBe(true);
  });

  it("keeps status-only halted state diagnostic without claiming freshness", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    let nowMs = 1_800_000_000_000;
    const fetchBitvavo = vi.fn(async () =>
      observation(nowMs, {
        vwap: null,
        filledFraction: 0,
        capped: true,
        bid: null,
        ask: null,
        lastTradeAt: null,
        observationAt: null,
        sequence: null,
        venueState: "halted",
      }),
    );
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      publish: vi.fn(),
    });

    const first = (await poller.pollCycle(input))[0]!;
    expect(source(first)).toMatchObject({
      healthy: false,
      newSuccess: false,
      newUsableDecision: false,
      deviationBps: null,
      observation: {
        venueState: "halted",
        observationAt: null,
        sequence: null,
      },
    });
    expect(first.blind).toBe(true);

    nowMs += 10_000;
    const cached = (await poller.pollCycle(input))[0]!;
    expect(source(cached)).toMatchObject({
      healthy: false,
      newSuccess: false,
      newUsableDecision: false,
      observation: { venueState: "halted" },
    });
    expect(fetchBitvavo).toHaveBeenCalledTimes(1);
  });

  it("preserves the last successful identity across a status-only halt", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    const frozen = observation(baseMs, { sequence: "frozen" });
    const halted = observation(baseMs + 30_000, {
      vwap: null,
      filledFraction: 0,
      capped: true,
      bid: null,
      ask: null,
      lastTradeAt: null,
      observationAt: null,
      sequence: null,
      venueState: "halted",
    });
    const responses: PegObservation[] = [frozen, halted, frozen];
    const fetchBitvavo = vi.fn(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected provider request");
      return next;
    });
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const initial = (await poller.pollCycle(input))[0]!;
    expect(source(initial)).toMatchObject({ healthy: true, newSuccess: true });

    nowMs = baseMs + 30_000;
    const stopped = (await poller.pollCycle(input))[0]!;
    expect(source(stopped)).toMatchObject({
      healthy: false,
      newSuccess: false,
      observation: {
        venueState: "halted",
        observationAt: null,
        sequence: null,
      },
    });

    nowMs = baseMs + 60_000;
    const reopened = (await poller.pollCycle(input))[0]!;
    expect(source(reopened)).toMatchObject({
      healthy: false,
      observation: null,
      deviationBps: null,
      newSuccess: false,
    });
    expect(reopened.blind).toBe(true);
    expect(fetchBitvavo).toHaveBeenCalledTimes(3);
    expect(errors.map(({ kind }) => kind)).toContain("source_freshness");
  });
});

describe("peg poll cycle isolation", () => {
  it("fails only the affected asset closed when its structural query fails", async () => {
    const first = primaryAsset();
    const second = primaryAsset({
      id: "asset-two",
      token: address("5"),
      pool: address("6"),
      feed: address("7"),
      sources: [primarySource({ id: "deep_two", pair: "TWO-EUR" })],
    });
    const input = makeInput([first, second]);
    const nowMs = 1_800_000_000_000;
    const errors: PegPollErrorEvent[] = [];
    const fetchStructuralContext = vi.fn(
      async ({ poolId }: { poolId: string }) => {
        if (poolId === `137-${first.pool}`)
          throw new Error("Hasura unavailable");
        return structuralContext(second, Math.floor(nowMs / 1_000));
      },
    );
    const fetchBitvavo = vi.fn(async ({ market }: { market: string }) =>
      observation(nowMs, {
        vwap: market === "PEG-EUR" ? 0.98 : 1,
        sequence: market,
      }),
    );
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext,
      fetchBitvavo,
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const snapshots = await poller.pollCycle(input);
    const failedStructural = snapshots.find(({ asset }) => asset === first.id)!;
    const healthyStructural = snapshots.find(
      ({ asset }) => asset === second.id,
    )!;
    expect(failedStructural).toMatchObject({
      indexedPoolReachable: false,
      structuralSaturation: null,
      blind: true,
      blindConsecutivePolls: 1,
    });
    expect(failedStructural.sources).toEqual([]);
    expect(healthyStructural.indexedPoolReachable).toBe(true);
    expect(source(healthyStructural, "deep_two")).toMatchObject({
      healthy: true,
      referenceSize: 50,
    });
    expect(fetchBitvavo).toHaveBeenCalledTimes(1);
    expect(errors.map(({ kind }) => kind)).toContain("structural_query");
  });

  it("counts only due deep cadence slots when structural authority starts unavailable", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    const fetchBitvavo = vi.fn(async () => observation(nowMs));
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () => {
        throw new Error("Hasura unavailable");
      }),
      fetchBitvavo,
      publish: vi.fn(),
    });

    for (const [elapsedSeconds, expectedCount] of [
      [0, 1],
      [15, 1],
      [30, 2],
      [31, 2],
      [60, 3],
      [90, 3],
    ] as const) {
      nowMs = baseMs + elapsedSeconds * 1_000;
      const current = (await poller.pollCycle(input))[0]!;
      expect(current).toMatchObject({
        blind: true,
        blindConsecutivePolls: expectedCount,
        indexedPoolReachable: false,
        sources: [],
      });
    }

    expect(fetchBitvavo).not.toHaveBeenCalled();
  });

  it("keeps a fresh deep price independent from unreachable structural state", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    let nowMs = 1_800_000_000_000;
    let structuralAvailable = true;
    const fetchStructuralContext = vi.fn(async () => {
      if (!structuralAvailable) throw new Error("Hasura unavailable");
      return structuralContext(spec, Math.floor(nowMs / 1_000), {
        limit0: fixed15(10),
        limit1: "0",
        netflow0: "0",
        netflow1: "0",
      });
    });
    const fetchBitvavo = vi.fn(async ({ refSize }: { refSize: number }) =>
      observation(nowMs, {
        vwap: 0.9,
        capped: refSize > 10,
        filledFraction: refSize > 10 ? 0.2 : 1,
      }),
    );
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext,
      fetchBitvavo,
      publish: vi.fn(),
    });

    const known = (await poller.pollCycle(input))[0]!;
    expect(source(known)).toMatchObject({
      referenceSize: 10,
      observation: { capped: false },
    });
    expect(source(known).deviationBps).toBeCloseTo(1_000);

    structuralAvailable = false;
    nowMs += 30_000;
    const unknown = (await poller.pollCycle(input))[0]!;
    expect(unknown).toMatchObject({
      blind: false,
      blindConsecutivePolls: 1,
      indexedPoolReachable: false,
      structuralSaturation: null,
    });
    expect(source(unknown)).toMatchObject({
      healthy: true,
      referenceSize: 10,
      newSuccess: false,
      newUsableDecision: false,
      observation: { vwap: 0.9, capped: false },
    });
    expect(fetchBitvavo).toHaveBeenCalledTimes(1);
    expect(fetchBitvavo.mock.calls[0]?.[0].refSize).toBe(10);
  });

  it("preserves provider identity while structural authority is unavailable", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    let structuralAvailable = true;
    const frozen = observation(baseMs, { sequence: "frozen", vwap: 0.9 });
    const fetchStructuralContext = vi.fn(async () => {
      if (!structuralAvailable) throw new Error("Hasura unavailable");
      return structuralContext(spec, Math.floor(nowMs / 1_000), {
        limit0: fixed15(10),
        limit1: "0",
        netflow0: "0",
        netflow1: "0",
      });
    });
    const fetchBitvavo = vi.fn(async () => frozen);
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext,
      fetchBitvavo,
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const initial = (await poller.pollCycle(input))[0]!;
    expect(source(initial)).toMatchObject({
      healthy: true,
      referenceSize: 10,
      newSuccess: true,
    });

    structuralAvailable = false;
    nowMs = baseMs + 30_000;
    const unavailable = (await poller.pollCycle(input))[0]!;
    expect(unavailable).toMatchObject({
      blind: false,
      blindConsecutivePolls: 1,
      indexedPoolReachable: false,
      structuralSaturation: null,
    });
    expect(source(unavailable)).toMatchObject({
      healthy: true,
      referenceSize: 10,
      newSuccess: false,
      observation: { vwap: 0.9, capped: false },
    });
    expect(fetchBitvavo).toHaveBeenCalledOnce();

    structuralAvailable = true;
    nowMs = baseMs + 60_000;
    const recovered = (await poller.pollCycle(input))[0]!;
    expect(recovered.indexedPoolReachable).toBe(true);
    expect(source(recovered)).toMatchObject({
      healthy: false,
      observation: null,
      deviationBps: null,
      newSuccess: false,
    });
    expect(recovered.blind).toBe(true);
    expect(recovered.blindConsecutivePolls).toBe(2);
    expect(fetchBitvavo).toHaveBeenCalledTimes(2);
    expect(errors.map(({ kind }) => kind)).toEqual([
      "structural_query",
      "source_freshness",
    ]);
  });

  it.each([
    ["non-15-decimal TradingLimit", { decimals: 18 }],
    ["non-FPMM pool source", { source: "uniswap_v3" }],
  ])(
    "fails a %s closed and suppresses price authority",
    async (_name, overrides) => {
      const spec = primaryAsset();
      const input = makeInput([spec]);
      const nowMs = 1_800_000_000_000;
      const errors: PegPollErrorEvent[] = [];
      const fetchBitvavo = vi.fn(async () => observation(nowMs));
      const poller = createPegPoller({
        nowMs: () => nowMs,
        fetchStructuralContext: vi.fn(async () =>
          structuralContext(spec, Math.floor(nowMs / 1_000), overrides),
        ),
        fetchBitvavo,
        publish: vi.fn(),
        onError: (event) => errors.push(event),
      });

      const snapshot = (await poller.pollCycle(input))[0]!;
      expect(snapshot).toMatchObject({
        indexedPoolReachable: false,
        blind: true,
      });
      expect(snapshot.sources).toEqual([]);
      expect(fetchBitvavo).not.toHaveBeenCalled();
      expect(errors.map(({ kind }) => kind)).toContain("structural_binding");
    },
  );

  it("fails a missing TradingLimit closed without cap-sized price polling", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const nowMs = 1_800_000_000_000;
    const complete = structuralContext(spec, Math.floor(nowMs / 1_000));
    if (complete.status !== "ok") throw new Error("invalid fixture");
    const errors: PegPollErrorEvent[] = [];
    const fetchBitvavo = vi.fn(async () => observation(nowMs, { vwap: 0.99 }));
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () => ({
        status: "trading_limit_missing" as const,
        pool: complete.pool,
        monitoredToken: spec.token,
        swaps: complete.swaps,
        pageSaturated: true,
      })),
      fetchBitvavo,
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const snapshot = (await poller.pollCycle(input))[0]!;
    expect(snapshot).toMatchObject({
      indexedPoolReachable: false,
      structuralSaturation: null,
      structuralQuerySaturated: true,
      blind: true,
    });
    expect(snapshot.sources).toEqual([]);
    expect(fetchBitvavo).not.toHaveBeenCalled();
    expect(errors.map(({ kind }) => kind)).toContain("structural_missing");
  });

  it("drops only the failed source while publishing its healthy sibling", async () => {
    const spec = primaryAsset({
      sources: [
        primarySource(),
        primarySource({
          id: "kraken_eur",
          provider: "kraken",
          pair: "PEG/EUR",
          authority: "secondary",
        }),
      ],
    });
    const input = makeInput([spec]);
    const nowMs = 1_800_000_000_000;
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () => {
        throw new Error("Bitvavo failed");
      }),
      fetchKraken: vi.fn(async () => observation(nowMs)),
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const snapshot = (await poller.pollCycle(input))[0]!;
    expect(source(snapshot)).toMatchObject({
      healthy: false,
      observation: null,
    });
    expect(source(snapshot, "kraken_eur").healthy).toBe(true);
    expect(errors.map(({ kind }) => kind)).toEqual(["source_fetch"]);
  });

  it("rolls back accepted source state when publication fails", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const nowMs = 1_800_000_000_000;
    const fetchBitvavo = vi.fn(async () => observation(nowMs));
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("Prometheus failed"))
      .mockResolvedValueOnce(undefined);
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      publish,
      onError: (event) => errors.push(event),
    });

    await expect(poller.pollCycle(input)).resolves.toEqual([]);
    const recovered = (await poller.pollCycle(input))[0]!;

    expect(source(recovered)).toMatchObject({
      healthy: true,
      newSuccess: true,
      newUsableDecision: true,
    });
    expect(fetchBitvavo).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(errors.map(({ kind }) => kind)).toEqual(["publish"]);
  });

  it("contains both cycle failures and a throwing error observer", async () => {
    const input = makeInput([primaryAsset()]);
    const poller = createPegPoller({
      nowMs: () => Number.NaN,
      publish: () => {
        throw new Error("publisher failed");
      },
      onError: () => {
        throw new Error("observer failed");
      },
    });

    await expect(poller.pollCycle(input)).resolves.toEqual([]);
  });

  it("rejects a cycle with more than two policy versions", async () => {
    const input = makeInput([primaryAsset()]);
    const secondCandidate = {
      ...input.policy,
      rolloverAckExpectedSeconds: 301,
    };
    const second = PegPolicyVersionSchema.parse({
      ...secondCandidate,
      version: pegPolicyVersionForContent("test-v2", secondCandidate),
    });
    const thirdCandidate = {
      ...input.policy,
      rolloverAckExpectedSeconds: 302,
    };
    const third = PegPolicyVersionSchema.parse({
      ...thirdCandidate,
      version: pegPolicyVersionForContent("test-v3", thirdCandidate),
    });
    const publish = vi.fn();
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => 1_800_000_000_000,
      publish,
      onError: (event) => errors.push(event),
    });
    const cycle = {
      registry: input.registry,
      policies: [input.policy, second, third],
    } as unknown as PegPollCycleInput;

    await expect(poller.pollCycle(cycle)).resolves.toEqual([]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "cycle" });
    expect(errors[0]?.cause).toEqual(
      new Error("peg poll cycle requires one or two policies"),
    );
  });
});

describe("peg poll cycle conversion and cadence", () => {
  it("converts an authoritative source and demotes it when the leg expires", async () => {
    const spec = primaryAsset({
      sources: [primarySource({ pair: "PEG/USD", converted: true })],
    });
    const input = makeInput([spec]);
    let nowMs = 1_800_000_000_000;
    let authoritative = true;
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo: vi.fn(async () =>
        observation(nowMs, { vwap: 2, bid: 1.998, ask: 2.002 }),
      ),
      readConversionLeg: vi.fn(async () => ({
        rate: 2,
        medianAt: Math.floor(nowMs / 1_000),
        expirySeconds: 120,
        authoritative,
        unavailableReason: authoritative ? null : ("stale" as const),
      })),
      publish: vi.fn(),
      onError: (event) => errors.push(event),
    });

    const converted = (await poller.pollCycle(input))[0]!;
    expect(source(converted).observation).toMatchObject({
      vwap: 1,
      bid: 0.999,
      ask: 1.001,
    });
    expect(converted.blind).toBe(false);

    authoritative = false;
    nowMs += 30_000;
    const demoted = (await poller.pollCycle(input))[0]!;
    expect(source(demoted)).toMatchObject({
      healthy: false,
      observation: null,
      deviationBps: null,
    });
    expect(demoted.blind).toBe(true);
    expect(errors.map(({ kind }) => kind)).toContain("conversion_unavailable");
  });

  it("honors independent Bitvavo and Kraken source cadences", async () => {
    const spec = primaryAsset({
      sources: [
        primarySource(),
        primarySource({
          id: "kraken_eur",
          provider: "kraken",
          pair: "PEG/EUR",
          authority: "secondary",
          pollIntervalSeconds: 60,
        }),
      ],
    });
    const input = makeInput([spec]);
    let nowMs = 1_800_000_000_000;
    const fetchBitvavo = vi.fn(async () => observation(nowMs));
    const fetchKraken = vi.fn(async () => observation(nowMs));
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      fetchKraken,
      publish: vi.fn(),
    });

    await poller.pollCycle(input);
    nowMs += 30_000;
    const middle = (await poller.pollCycle(input))[0]!;
    expect(source(middle, "kraken_eur")).toMatchObject({
      healthy: true,
      newSuccess: false,
    });
    nowMs += 30_000;
    await poller.pollCycle(input);

    expect(fetchBitvavo).toHaveBeenCalledTimes(3);
    expect(fetchKraken).toHaveBeenCalledTimes(2);
  });

  it("polls each policy subset from the retained topology union", async () => {
    const spec = primaryAsset({
      sources: [
        primarySource(),
        primarySource({
          id: "kraken_eur",
          provider: "kraken",
          pair: "PEG/EUR",
          authority: "secondary",
        }),
      ],
    });
    const union = makeInput([spec]);
    const activeAssets = structuredClone(union.policy.assets);
    delete activeAssets[spec.id]!.sources.kraken_eur;
    const activeCandidate = { ...union.policy, assets: activeAssets };
    const active = PegPolicyVersionSchema.parse({
      ...activeCandidate,
      version: pegPolicyVersionForContent("test-v2", activeCandidate),
    });
    const nowMs = 1_800_000_000_000;
    const fetchBitvavo = vi.fn(async () => observation(nowMs));
    const fetchKraken = vi.fn(async () => observation(nowMs));
    const publish = vi.fn<(snapshots: PegAssetMetricSnapshot[]) => void>();
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      fetchKraken,
      publish,
    });

    const snapshots = await poller.pollCycle({
      registry: union.registry,
      policies: [active, union.policy],
    });

    expect(snapshots.map(({ policyVersion }) => policyVersion)).toEqual([
      active.version,
      union.policy.version,
    ]);
    expect(snapshots[0]!.sources.map(({ source }) => source)).toEqual([
      "deep_eur",
    ]);
    expect(snapshots[1]!.sources.map(({ source }) => source)).toEqual([
      "deep_eur",
      "kraken_eur",
    ]);
    expect(fetchBitvavo).toHaveBeenCalledTimes(2);
    expect(fetchKraken).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(snapshots);
  });

  it("clears metrics and rolls back state when one policy build is incomplete", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const retainedCandidate = {
      ...input.policy,
      rolloverAckExpectedSeconds: 301,
    };
    const retained = PegPolicyVersionSchema.parse({
      ...retainedCandidate,
      version: pegPolicyVersionForContent("test-v0", retainedCandidate),
    });
    let nowMs = 1_800_000_000_000;
    const fetchBitvavo = vi.fn(async () => observation(nowMs));
    const publish = vi.fn<(snapshots: PegAssetMetricSnapshot[]) => void>();
    const errors: PegPollErrorEvent[] = [];
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      publish,
      onError: (event) => errors.push(event),
    });
    const rollover = {
      registry: input.registry,
      policies: [input.policy, retained] as const,
    };
    await poller.pollCycle(rollover);

    nowMs += 30_000;
    const retainedAsset = retained.assets[spec.id]!;
    const brokenAsset = new Proxy(retainedAsset, {
      get(target, property, receiver) {
        if (property === "deepVenueSource") {
          throw new Error("retained policy build failed");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const brokenRetained = {
      ...retained,
      assets: { ...retained.assets, [spec.id]: brokenAsset },
    };
    const failed = await poller.pollCycle({
      registry: input.registry,
      policies: [input.policy, brokenRetained],
    });

    expect(failed).toEqual([]);
    expect(publish).toHaveBeenNthCalledWith(2, []);
    expect(errors.map(({ kind }) => kind)).toEqual(["cycle"]);

    const recovered = await poller.pollCycle(rollover);
    expect(recovered.map((snapshot) => source(snapshot).newSuccess)).toEqual([
      true,
      true,
    ]);
    expect(fetchBitvavo).toHaveBeenCalledTimes(6);
    expect(publish).toHaveBeenNthCalledWith(3, recovered);
  });

  it("publishes two exact-version snapshots atomically and evicts retained state", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const retainedCandidate = {
      ...input.policy,
      rolloverAckExpectedSeconds: 301,
    };
    const retained = PegPolicyVersionSchema.parse({
      ...retainedCandidate,
      version: pegPolicyVersionForContent("test-v0", retainedCandidate),
    });
    let nowMs = 1_800_000_000_000;
    const now = vi.fn(() => nowMs);
    const fetchBitvavo = vi.fn(async () =>
      observation(nowMs, { sequence: `book-${nowMs}` }),
    );
    const publish = vi.fn<(snapshots: PegAssetMetricSnapshot[]) => void>();
    const poller = createPegPoller({
      nowMs: now,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      publish,
    });
    const rollover = {
      registry: input.registry,
      policies: [input.policy, retained] as const,
    };

    const first = await poller.pollCycle(rollover);
    expect(first.map(({ policyVersion }) => policyVersion)).toEqual([
      input.policy.version,
      retained.version,
    ]);
    expect(first.map((snapshot) => source(snapshot).newUsableDecision)).toEqual(
      [true, true],
    );
    expect(now).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith(first);

    nowMs += 10_000;
    const cached = await poller.pollCycle(rollover);
    expect(cached.map((snapshot) => source(snapshot))).toEqual([
      expect.objectContaining({
        newSuccess: false,
        newUsableDecision: false,
      }),
      expect.objectContaining({
        newSuccess: false,
        newUsableDecision: false,
      }),
    ]);
    expect(fetchBitvavo).toHaveBeenCalledTimes(2);

    nowMs += 10_000;
    await poller.pollCycle({
      registry: input.registry,
      policies: [input.policy],
    });
    const reintroduced = await poller.pollCycle(rollover);
    expect(source(reintroduced[0]!)).toMatchObject({
      newSuccess: false,
      newUsableDecision: false,
    });
    expect(source(reintroduced[1]!)).toMatchObject({
      newSuccess: true,
      newUsableDecision: true,
    });
    expect(fetchBitvavo).toHaveBeenCalledTimes(3);
    expect(now).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenLastCalledWith(reintroduced);
  });

  it("isolates blind streak state by policy version and resets it after cleanup", async () => {
    const spec = primaryAsset();
    const input = makeInput([spec]);
    const retainedCandidate = {
      ...input.policy,
      rolloverAckExpectedSeconds: 301,
    };
    const retained = PegPolicyVersionSchema.parse({
      ...retainedCandidate,
      version: pegPolicyVersionForContent("test-v0", retainedCandidate),
    });
    const baseMs = 1_800_000_000_000;
    let nowMs = baseMs;
    const responses = [
      { usable: false, sequence: "active-blind-1" },
      { usable: true, sequence: "retained-usable-1" },
      { usable: false, sequence: "active-blind-2" },
      { usable: false, sequence: "retained-blind-1" },
      { usable: true, sequence: "active-usable-1" },
      { usable: false, sequence: "retained-reintroduced-blind-1" },
    ];
    const fetchBitvavo = vi.fn(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("unexpected provider request");
      return observation(nowMs, {
        vwap: next.usable ? 1 : 0.9,
        capped: !next.usable,
        filledFraction: next.usable ? 1 : 0.5,
        sequence: next.sequence,
      });
    });
    const poller = createPegPoller({
      nowMs: () => nowMs,
      fetchStructuralContext: vi.fn(async () =>
        structuralContext(spec, Math.floor(nowMs / 1_000)),
      ),
      fetchBitvavo,
      publish: vi.fn(),
    });
    const rollover = {
      registry: input.registry,
      policies: [input.policy, retained] as const,
    };

    const first = await poller.pollCycle(rollover);
    expect(
      first.map(({ blindConsecutivePolls }) => blindConsecutivePolls),
    ).toEqual([1, 0]);

    nowMs = baseMs + 30_000;
    const second = await poller.pollCycle(rollover);
    expect(
      second.map(({ blindConsecutivePolls }) => blindConsecutivePolls),
    ).toEqual([2, 1]);

    nowMs = baseMs + 60_000;
    const cleaned = await poller.pollCycle({
      registry: input.registry,
      policies: [input.policy],
    });
    expect(cleaned[0]?.blindConsecutivePolls).toBe(0);

    const reintroduced = await poller.pollCycle(rollover);
    expect(
      reintroduced.map(({ blindConsecutivePolls }) => blindConsecutivePolls),
    ).toEqual([0, 1]);
    expect(fetchBitvavo).toHaveBeenCalledTimes(6);
  });
});

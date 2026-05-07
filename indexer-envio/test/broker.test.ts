/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";
import {
  _setMockFeeTokenMeta,
  _clearMockFeeTokenMeta,
} from "../src/EventHandlers.ts";
import { dayBucket, makePoolId } from "../src/helpers.ts";
import { getContractAddress } from "../src/contractAddresses.ts";

// MockDb shape is hand-typed per the existing pattern in dailySnapshot.test.ts —
// generated types aren't exported in a stable form for direct import.
type MockDb = {
  entities: {
    BrokerSwapEvent: {
      get: (id: string) => unknown;
    };
    BrokerDailySnapshot: {
      get: (id: string) => unknown;
    };
    BrokerTraderDailySnapshot: {
      get: (id: string) => unknown;
    };
    BrokerAggregatorDailySnapshot: {
      get: (id: string) => unknown;
    };
    BrokerAggregatorTraderDayMarker: {
      get: (id: string) => unknown;
    };
    Pool: {
      get: (id: string) => unknown;
    };
  };
};

type EventProcessor = {
  createMockEvent: (args: unknown) => unknown;
  processEvent: (args: { event: unknown; mockDb: MockDb }) => Promise<MockDb>;
};

type GeneratedModule = {
  TestHelpers: {
    MockDb: { createMockDb: () => MockDb };
    Broker: { Swap: EventProcessor };
    VirtualPoolFactory: { VirtualPoolDeployed: EventProcessor };
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, Broker, VirtualPoolFactory } = TestHelpers;

const CHAIN_CELO = 42220;
// Real Mento BiPoolManager (v2 legacy) on Celo — what the chart will filter for.
const BIPOOL_MANAGER = "0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901";
// cUSD (Celo Dollar) — 18 decimals, USD-pegged via USD_PEGGED_SYMBOLS so
// volumeUsdWei ≠ 0. Both legs of a cUSD/USDC swap are pegged; the larger
// one wins under `pickPeggedSide`.
const CUSD = "0x765de816845861e75a25fca122bb6898b8b1282a";
// USDC bridged token — 6 decimals.
const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const TRADER = "0xAbCdEf1234567890aBCdef1234567890ABCDef12";
const EXCHANGE_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
// Default tx.to for a "broker-direct" swap (legacy v2 path). Tests that
// simulate router-driven swaps override this to V3_ROUTER below.
const BROKER_PROXY = "0x777A8255cA72412f0d706dc03C9D1987306B4CaD";
// Real v3 Router (Router:v3.0.0) — must match the constant in handlers/broker.ts
// so the routedViaV3Router classifier flips correctly.
const V3_ROUTER = "0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6";

const fireSwap = async (
  mockDb: MockDb,
  args: {
    blockNumber: number;
    blockTimestamp: number;
    logIndex: number;
    exchangeProvider?: string;
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: bigint;
    amountOut?: bigint;
    txTo?: string;
    trader?: string;
  },
): Promise<MockDb> => {
  const event = Broker.Swap.createMockEvent({
    exchangeProvider: args.exchangeProvider ?? BIPOOL_MANAGER,
    exchangeId: EXCHANGE_ID,
    trader: args.trader ?? TRADER,
    tokenIn: args.tokenIn ?? CUSD,
    tokenOut: args.tokenOut ?? USDC,
    amountIn: args.amountIn ?? 1_000n * 10n ** 18n, // 1000 CUSD
    amountOut: args.amountOut ?? 999_500_000n, // 999.5 USDC (6dp)
    mockEventData: {
      chainId: CHAIN_CELO,
      logIndex: args.logIndex,
      // event.srcAddress = the Broker proxy. Not load-bearing for the handler
      // (it reads from event.params), but kept realistic so traces match.
      srcAddress: BROKER_PROXY,
      block: { number: args.blockNumber, timestamp: args.blockTimestamp },
      transaction: { to: args.txTo ?? BROKER_PROXY },
    },
  });
  return Broker.Swap.processEvent({ event, mockDb });
};

describe("Broker.Swap handler", () => {
  // The handler resolves token metadata via `resolveFeeTokenMeta`, which uses
  // the fee-token mock map (`_setMockFeeTokenMeta`), not the ERC20-decimals
  // map. Mocking through the wrong helper would silently rely on
  // KNOWN_TOKEN_META static fallback for cUSD/USDC and provide false coverage
  // the moment a test introduces a non-standard token.
  beforeEach(() => {
    _clearMockFeeTokenMeta();
    _setMockFeeTokenMeta(CHAIN_CELO, CUSD, { symbol: "cUSD", decimals: 18 });
    _setMockFeeTokenMeta(CHAIN_CELO, USDC, { symbol: "USDC", decimals: 6 });
  });

  afterEach(() => {
    _clearMockFeeTokenMeta();
  });

  it("persists a BrokerSwapEvent row with lowercased addresses and 18-dp USD notional", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
    });

    const id = `${CHAIN_CELO}_100_0`;
    const row = mockDb.entities.BrokerSwapEvent.get(id) as
      | {
          chainId: number;
          exchangeProvider: string;
          trader: string;
          tokenIn: string;
          tokenOut: string;
          amountIn: bigint;
          amountOut: bigint;
          volumeUsdWei: bigint;
          txTo: string;
          routedViaV3Router: boolean;
        }
      | undefined;
    assert.isOk(row, "BrokerSwapEvent row missing");
    assert.equal(row!.chainId, CHAIN_CELO);
    // All address fields lowercased per `asAddress`.
    assert.equal(row!.exchangeProvider, BIPOOL_MANAGER.toLowerCase());
    assert.equal(row!.trader, TRADER.toLowerCase());
    assert.equal(row!.tokenIn, CUSD.toLowerCase());
    assert.equal(row!.tokenOut, USDC.toLowerCase());
    // Amounts pass through untouched.
    assert.equal(row!.amountIn, 1_000n * 10n ** 18n);
    assert.equal(row!.amountOut, 999_500_000n);
    // CUSD leg drives the USD notional: 1000 CUSD = 1000 × 1e18 = 1e21 USD-wei.
    assert.equal(row!.volumeUsdWei, 1_000n * 10n ** 18n);
    // Default fixture sends to BROKER_PROXY → not router-driven.
    assert.equal(row!.txTo, BROKER_PROXY.toLowerCase());
    assert.equal(row!.routedViaV3Router, false);
  });

  it("flags routedViaV3Router=true when tx.to is the v3 Router (sibling-of-VirtualPool path)", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 200,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txTo: V3_ROUTER,
    });
    const row = mockDb.entities.BrokerSwapEvent.get(`${CHAIN_CELO}_200_0`) as
      | { txTo: string; routedViaV3Router: boolean }
      | undefined;
    assert.isOk(row, "BrokerSwapEvent row missing");
    assert.equal(row!.txTo, V3_ROUTER.toLowerCase());
    // Crucial: the v2 chart filter (`routedViaV3Router=false`) excludes this
    // row, preventing double-count against the VirtualPool.Swap volume that
    // fired in the same tx.
    assert.equal(row!.routedViaV3Router, true);
  });

  it("rolls (chain, exchangeProvider, day) into a single BrokerDailySnapshot that accumulates", async () => {
    let mockDb = MockDb.createMockDb();
    // Two swaps in the same UTC day on the same provider. Both swaps have a
    // CUSD leg larger than the USDC leg so `pickPeggedSide` consistently picks
    // CUSD as the notional side — keeps the assertion stable.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      amountIn: 1_000n * 10n ** 18n, // 1000 CUSD in
      amountOut: 999_500_000n, // 999.5 USDC out (1000 > 999.5 → CUSD wins)
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500, // same day
      logIndex: 0,
      amountIn: 500n * 10n ** 18n, // 500 CUSD in
      amountOut: 499_750_000n, // 499.75 USDC out (500 > 499.75 → CUSD wins)
    });

    const dayTs = dayBucket(1_700_000_000n);
    const snapshotId = `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`;
    const snap = mockDb.entities.BrokerDailySnapshot.get(snapshotId) as
      | { swapCount: number; volumeUsdWei: bigint; routedViaV3Router: boolean }
      | undefined;
    assert.isOk(snap, "BrokerDailySnapshot missing");
    assert.equal(snap!.swapCount, 2);
    // 1000 + 500 = 1500 CUSD in USD-wei.
    assert.equal(snap!.volumeUsdWei, 1_500n * 10n ** 18n);
    assert.equal(snap!.routedViaV3Router, false);
  });

  it("buckets router-driven and broker-direct swaps into separate daily snapshots", async () => {
    // Same day, same provider, but different `tx.to`: one direct broker call,
    // one via the v3 Router. The v2 chart's filter
    // (`routedViaV3Router=false`) reads only the direct row.
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      // tx.to defaults to BROKER_PROXY → routedViaV3Router=false
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500,
      logIndex: 0,
      txTo: V3_ROUTER, // routedViaV3Router=true
    });

    const dayTs = dayBucket(1_700_000_000n);
    const direct = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`,
    ) as { swapCount: number } | undefined;
    const router = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-router-${dayTs}`,
    ) as { swapCount: number } | undefined;
    assert.equal(direct?.swapCount, 1);
    assert.equal(router?.swapCount, 1);
  });

  it("rolls broker-direct swaps into BrokerTraderDailySnapshot per (chain, trader, day)", async () => {
    let mockDb = MockDb.createMockDb();
    // Two same-day v2 swaps from the same trader; assert the rollup
    // accumulates and is keyed correctly.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      amountIn: 1_000n * 10n ** 18n,
      amountOut: 999_500_000n,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500,
      logIndex: 0,
      amountIn: 500n * 10n ** 18n,
      amountOut: 499_750_000n,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const id = `${CHAIN_CELO}-${TRADER.toLowerCase()}-${dayTs}`;
    const row = mockDb.entities.BrokerTraderDailySnapshot.get(id) as
      | {
          chainId: number;
          trader: string;
          timestamp: bigint;
          swapCount: number;
          volumeUsdWei: bigint;
          isSystemAddress: boolean;
          lastSeenTimestamp: bigint;
        }
      | undefined;
    assert.isOk(row, "BrokerTraderDailySnapshot missing");
    assert.equal(row!.chainId, CHAIN_CELO);
    assert.equal(row!.trader, TRADER.toLowerCase());
    assert.equal(row!.swapCount, 2);
    assert.equal(row!.volumeUsdWei, 1_500n * 10n ** 18n);
    assert.equal(row!.isSystemAddress, false);
    // lastSeenTimestamp tracks the most recent swap's block timestamp
    // (not the day bucket) for sub-day "Last active" precision.
    assert.equal(row!.lastSeenTimestamp, 1_700_000_500n);
  });

  it("does NOT write trader/aggregator rollups when routedViaV3Router=true (avoids double-count vs v3)", async () => {
    // Same trader, two swaps: one direct, one via the v3 Router. Only the
    // direct row should land in the v2 trader rollup; the router-driven row
    // is already covered by the v3 leaderboard's TraderDailySnapshot via the
    // VirtualPool.Swap sibling that fired in the same tx.
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500,
      logIndex: 0,
      txTo: V3_ROUTER, // routedViaV3Router=true → skip rollups
    });

    const dayTs = dayBucket(1_700_000_000n);
    const traderRow = mockDb.entities.BrokerTraderDailySnapshot.get(
      `${CHAIN_CELO}-${TRADER.toLowerCase()}-${dayTs}`,
    ) as { swapCount: number; volumeUsdWei: bigint } | undefined;
    assert.isOk(
      traderRow,
      "BrokerTraderDailySnapshot should still exist for the broker-direct swap",
    );
    // The router-driven swap was excluded — count and volume reflect ONE swap.
    assert.equal(traderRow!.swapCount, 1);
    assert.equal(traderRow!.volumeUsdWei, 1_000n * 10n ** 18n);
  });

  it("does NOT write trader/aggregator rollups when trader is a registered VirtualPool (avoids double-count vs v3 VirtualPool.Swap path)", async () => {
    // Scenario: third-party aggregator → VirtualPool → Broker. The v3
    // leaderboard already counts the sibling VirtualPool.Swap (via
    // applyLeaderboardSnapshots in handlers/virtualPool.ts). `tx.to` is the
    // aggregator's router (so `routedViaV3Router=false`), but Broker emits
    // `trader = msg.sender = the VirtualPool address`. The handler's Pool
    // lookup on `trader` should detect the virtual_pool_factory source and
    // skip the v2 producer/aggregator rollups even though the simple
    // routedViaV3Router guard misses this path.
    const VIRTUAL_POOL_ADDR =
      "0x00000000000000000000000000000000000000aa".toLowerCase();
    // Some external aggregator router that ISN'T Routerv300 — proves the
    // routedViaV3Router guard alone wouldn't skip this swap.
    const EXTERNAL_AGGREGATOR =
      "0x0000000000000000000000000000000000001111".toLowerCase();

    let mockDb = MockDb.createMockDb();

    // Register the VirtualPool with source="virtual_pool_factory" via the
    // real factory deploy handler so the Pool entity matches what
    // production would index.
    const deployEvent = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
      pool: VIRTUAL_POOL_ADDR,
      token0: CUSD,
      token1: USDC,
      mockEventData: {
        chainId: CHAIN_CELO,
        logIndex: 0,
        srcAddress: "0x00000000000000000000000000000000000000cc",
        block: { number: 99, timestamp: 1_699_999_999 },
      },
    });
    mockDb = await VirtualPoolFactory.VirtualPoolDeployed.processEvent({
      event: deployEvent,
      mockDb,
    });
    const seededPool = mockDb.entities.Pool.get(
      makePoolId(CHAIN_CELO, VIRTUAL_POOL_ADDR),
    ) as { source: string } | undefined;
    assert.ok(seededPool, "VirtualPool must exist after VirtualPoolDeployed");
    assert.include(
      seededPool!.source,
      "virtual",
      "Seeded pool must carry a virtual_* source so isVirtualPool() detects it",
    );

    // Now fire a Broker.Swap whose trader is the VirtualPool address — the
    // signature of an aggregator → VirtualPool → Broker tx.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      trader: VIRTUAL_POOL_ADDR,
      txTo: EXTERNAL_AGGREGATOR, // routedViaV3Router=false (not Routerv300)
    });

    const dayTs = dayBucket(1_700_000_000n);

    // BrokerSwapEvent: still written (raw audit log preserves all events).
    const eventRow = mockDb.entities.BrokerSwapEvent.get(`${CHAIN_CELO}_100_0`);
    assert.isOk(
      eventRow,
      "BrokerSwapEvent should still record the raw VirtualPool-routed swap",
    );

    // BrokerDailySnapshot: still written (preserves the existing partition;
    // any future Swaps-KPI consumer can decide how to filter VirtualPool
    // siblings).
    const dailyRow = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`,
    );
    assert.isOk(
      dailyRow,
      "BrokerDailySnapshot should still record this swap in the legacy 'direct' partition",
    );

    // BrokerTraderDailySnapshot: NOT written (the whole point of the fix).
    const traderRow = mockDb.entities.BrokerTraderDailySnapshot.get(
      `${CHAIN_CELO}-${VIRTUAL_POOL_ADDR}-${dayTs}`,
    );
    assert.isUndefined(
      traderRow,
      "VirtualPool-routed Broker.Swap must not produce a BrokerTraderDailySnapshot — would double-count vs the v3 VirtualPool.Swap path",
    );

    // BrokerAggregatorDailySnapshot: also NOT written for the same reason.
    // classifyAggregator(EXTERNAL_AGGREGATOR) would yield "unknown" for an
    // un-registered router, so the negative assertion checks all aggregator
    // names that could plausibly land here.
    const allAggregatorRowsEmpty = (
      ["unknown", "direct", "system"] as const
    ).every(
      (name) =>
        !mockDb.entities.BrokerAggregatorDailySnapshot.get(
          `${CHAIN_CELO}-${name}-${dayTs}`,
        ),
    );
    assert.isTrue(
      allAggregatorRowsEmpty,
      "VirtualPool-routed Broker.Swap must not produce any BrokerAggregatorDailySnapshot row",
    );
  });

  it("rolls broker-direct swaps into BrokerAggregatorDailySnapshot keyed by classifyAggregator(txTo)", async () => {
    let mockDb = MockDb.createMockDb();
    // Two distinct traders both entering via the Broker proxy (a
    // "direct"-classified entry-point per classifyAggregator). Assert the
    // aggregator rollup tallies swaps + uniqueTraders correctly across them.
    const TRADER_B = "0xBeefBeefBeefBeefBeefBeefBeefBeefBeefBeef";
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      trader: TRADER,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500,
      logIndex: 0,
      trader: TRADER_B,
    });
    // Same trader as the first swap — uniqueTraders should NOT increment.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 102,
      blockTimestamp: 1_700_000_900,
      logIndex: 0,
      trader: TRADER,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const id = `${CHAIN_CELO}-direct-${dayTs}`;
    const row = mockDb.entities.BrokerAggregatorDailySnapshot.get(id) as
      | {
          aggregator: string;
          lastSeenAggregatorAddress: string;
          swapCount: number;
          uniqueTraders: number;
          volumeUsdWei: bigint;
        }
      | undefined;
    assert.isOk(row, "BrokerAggregatorDailySnapshot missing");
    assert.equal(row!.aggregator, "direct");
    assert.equal(row!.lastSeenAggregatorAddress, BROKER_PROXY.toLowerCase());
    assert.equal(row!.swapCount, 3);
    // First-touch dedup via BrokerAggregatorTraderDayMarker — TRADER seen
    // twice on the same day shouldn't double-count.
    assert.equal(row!.uniqueTraders, 2);
    // 1000 + 1000 + 1000 CUSD.
    assert.equal(row!.volumeUsdWei, 3_000n * 10n ** 18n);

    // Marker entities exist per (aggregator, trader, day).
    assert.isOk(
      mockDb.entities.BrokerAggregatorTraderDayMarker.get(
        `${CHAIN_CELO}-direct-${TRADER.toLowerCase()}-${dayTs}`,
      ),
    );
    assert.isOk(
      mockDb.entities.BrokerAggregatorTraderDayMarker.get(
        `${CHAIN_CELO}-direct-${TRADER_B.toLowerCase()}-${dayTs}`,
      ),
    );
  });

  it("classifies an unknown txTo as 'unknown' so unlabelled v2 routers surface for follow-up", async () => {
    // A swap that entered via some random contract not in
    // contracts.json / aggregators.json. The leaderboard's "unknown" bucket
    // is the curation backlog: anything large here should be triaged into
    // aggregators.json so it gets a readable label.
    const MYSTERY_ROUTER = "0x1234567890abcdef1234567890abcdef12345678";
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txTo: MYSTERY_ROUTER,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const row = mockDb.entities.BrokerAggregatorDailySnapshot.get(
      `${CHAIN_CELO}-unknown-${dayTs}`,
    ) as
      | {
          aggregator: string;
          lastSeenAggregatorAddress: string;
          swapCount: number;
        }
      | undefined;
    assert.isOk(row, "unknown-bucket row missing");
    assert.equal(row!.aggregator, "unknown");
    assert.equal(row!.lastSeenAggregatorAddress, MYSTERY_ROUTER.toLowerCase());
    assert.equal(row!.swapCount, 1);
  });

  it("buckets distinct exchangeProviders into separate daily snapshots", async () => {
    // Per-provider rows are kept so a future "v2 by exchange provider"
    // breakdown is a query-time filter rather than a schema migration. The
    // current chart's v2 filter is `routedViaV3Router=false` only — any
    // future non-BiPoolManager provider (CDP, OLS, etc., if they ever emit
    // `Broker.Swap`) will land in the same v2 series intentionally; that's
    // the user-chosen design ("v2 = anything entering the Broker that
    // didn't come from the v3 Router").
    const OTHER_PROVIDER = "0x000000000000000000000000000000000000beef";
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      exchangeProvider: BIPOOL_MANAGER,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_100,
      logIndex: 0,
      exchangeProvider: OTHER_PROVIDER,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const bipool = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`,
    ) as { swapCount: number } | undefined;
    const other = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${OTHER_PROVIDER}-direct-${dayTs}`,
    ) as { swapCount: number } | undefined;
    assert.equal(bipool?.swapCount, 1);
    assert.equal(other?.swapCount, 1);
  });
});

describe("v3 router lookup smoke test", () => {
  it("@mento-protocol/contracts still registers the v3 Router on Celo at the expected address", () => {
    // The handler at handlers/broker.ts derives `routedViaV3Router` from
    // `getContractAddress(chainId, "Routerv300")`. If the package ever loses
    // that entry (rename, repackaging) the comparison silently always returns
    // false → every Broker.Swap gets misclassified as v2-direct, inflating
    // legacy volume on the chart. This catches that regression at test time
    // rather than at production sync.
    assert.equal(
      getContractAddress(CHAIN_CELO, "Routerv300")?.toLowerCase(),
      V3_ROUTER.toLowerCase(),
      "If this fails, @mento-protocol/contracts has changed Routerv300 — update V3_ROUTER constant or restore the entry.",
    );
  });
});

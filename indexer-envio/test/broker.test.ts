import { assert } from "vitest";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
} from "./helpers/indexerTestHarness.js";
import {
  _setMockFeeTokenMeta,
  _clearMockFeeTokenMeta,
} from "../src/EventHandlers.ts";
import { dayBucket, makePoolId } from "../src/helpers.ts";
import { getContractAddress } from "../src/contractAddresses.ts";

type MockDb = MockDbWith<{
  BrokerSwapEvent: EntityReader;
  BrokerDailySnapshot: EntityReader;
  BrokerExchangeDailySnapshot: EntityReader;
  BrokerTraderDailySnapshot: EntityReader;
  BrokerAggregatorDailySnapshot: EntityReader;
  BrokerAggregatorTraderDayMarker: EntityReader;
  BrokerTraderRouterDayMarker: EntityReader;
  Pool: EntityReader;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
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
// Direct-trade path (no router): `event.params.trader = msg.sender = tx.from`,
// so brokerCaller and caller end up equal. Most tests use this single value to
// keep the address space readable; the routed-trade tests below introduce a
// distinct ROUTER_CONTRACT to exercise the brokerCaller ≠ caller path.
const SIGNER_EOA = "0xAbCdEf1234567890aBCdef1234567890ABCDef12";
const EXCHANGE_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
// Default tx.to for a direct Broker swap (legacy v2 path).
const BROKER_PROXY = "0x777A8255cA72412f0d706dc03C9D1987306B4CaD";
// Real Router address on Celo. The same address can be a legacy v2 Router
// entry point or a v3 Router entry point; Broker.Swap distinguishes those by
// brokerCaller (Router direct-to-Broker vs VirtualPool).
const V3_ROUTER = "0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6";
const VIRTUAL_POOL_ADDR =
  "0x00000000000000000000000000000000000000aa".toLowerCase();

const fireSwap = async (
  mockDb: MockDb,
  args: {
    blockNumber: number;
    blockTimestamp: number;
    logIndex: number;
    exchangeProvider?: string;
    exchangeId?: string;
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: bigint;
    amountOut?: bigint;
    txTo?: string;
    /** `event.params.trader` from Broker.Swap = msg.sender to Broker. For
     *  direct trades equals `txFrom`; for routed trades it's the router
     *  contract address. Defaults to `SIGNER_EOA` (direct path). */
    brokerCaller?: string;
    /** `event.transaction.from` = signer EOA. Defaults to `SIGNER_EOA`. */
    txFrom?: string;
  },
): Promise<MockDb> => {
  const event = Broker.Swap.createMockEvent({
    exchangeProvider: args.exchangeProvider ?? BIPOOL_MANAGER,
    exchangeId: args.exchangeId ?? EXCHANGE_ID,
    trader: args.brokerCaller ?? SIGNER_EOA,
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
      transaction: {
        from: args.txFrom ?? SIGNER_EOA,
        to: args.txTo ?? BROKER_PROXY,
      },
    },
  });
  return Broker.Swap.processEvent({ event, mockDb });
};

const seedVirtualPool = async (
  mockDb: MockDb,
  pool = VIRTUAL_POOL_ADDR,
): Promise<MockDb> => {
  const deployEvent = VirtualPoolFactory.VirtualPoolDeployed.createMockEvent({
    pool,
    token0: CUSD,
    token1: USDC,
    mockEventData: {
      chainId: CHAIN_CELO,
      logIndex: 0,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: 99, timestamp: 1_699_999_999 },
    },
  });
  return VirtualPoolFactory.VirtualPoolDeployed.processEvent({
    event: deployEvent,
    mockDb,
  });
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
          brokerCaller: string;
          caller: string;
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
    // Direct path: `event.params.trader = msg.sender = tx.from`, so the
    // brokerCaller and caller fields converge on SIGNER_EOA.
    assert.equal(row!.brokerCaller, SIGNER_EOA.toLowerCase());
    assert.equal(row!.caller, SIGNER_EOA.toLowerCase());
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

  it("populates `caller` from event.transaction.from and `brokerCaller` from event.params.trader (routed path)", async () => {
    // Routed path: a router contract calls Broker, but the underlying signer
    // (`tx.from`) is the user's EOA. brokerCaller = router; caller = EOA.
    // The volume must roll up by `caller` so the user — not the router —
    // shows up as the producer.
    const ROUTER_CONTRACT = "0xa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const USER_EOA = "0xb2BBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      brokerCaller: ROUTER_CONTRACT,
      txFrom: USER_EOA,
    });

    const row = mockDb.entities.BrokerSwapEvent.get(`${CHAIN_CELO}_100_0`) as
      | { brokerCaller: string; caller: string }
      | undefined;
    assert.isOk(row, "BrokerSwapEvent row missing");
    assert.equal(row!.brokerCaller, ROUTER_CONTRACT.toLowerCase());
    assert.equal(row!.caller, USER_EOA.toLowerCase());

    const dayTs = dayBucket(1_700_000_000n);
    // Rollup is keyed by `caller` (the EOA), not `brokerCaller` (the router).
    const traderRow = mockDb.entities.BrokerTraderDailySnapshot.get(
      `${CHAIN_CELO}-${USER_EOA.toLowerCase()}-${dayTs}`,
    ) as { caller: string; volumeUsdWei: bigint } | undefined;
    assert.isOk(
      traderRow,
      "BrokerTraderDailySnapshot must roll up by signer EOA (caller), not router (brokerCaller)",
    );
    assert.equal(traderRow!.caller, USER_EOA.toLowerCase());
    // No row keyed by the router address (would mis-attribute the swap).
    assert.isUndefined(
      mockDb.entities.BrokerTraderDailySnapshot.get(
        `${CHAIN_CELO}-${ROUTER_CONTRACT.toLowerCase()}-${dayTs}`,
      ),
      "BrokerTraderDailySnapshot must NOT be keyed by brokerCaller (router contract)",
    );
  });

  it("flags routedViaV3Router=true when Router enters Broker through a VirtualPool sibling", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await seedVirtualPool(mockDb);
    mockDb = await fireSwap(mockDb, {
      blockNumber: 200,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txTo: V3_ROUTER,
      brokerCaller: VIRTUAL_POOL_ADDR,
    });
    const row = mockDb.entities.BrokerSwapEvent.get(`${CHAIN_CELO}_200_0`) as
      | { txTo: string; routedViaV3Router: boolean }
      | undefined;
    assert.isOk(row, "BrokerSwapEvent row missing");
    assert.equal(row!.txTo, V3_ROUTER.toLowerCase());
    // Crucial: the v2 chart filter (`routedViaV3Router=false`) excludes only
    // Router → VirtualPool → Broker rows, preventing double-count against the
    // VirtualPool.Swap volume that fired in the same tx.
    assert.equal(row!.routedViaV3Router, true);
  });

  it("keeps legacy Router direct-to-Broker swaps in v2 and labels the entry point", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 200,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txTo: V3_ROUTER,
      brokerCaller: V3_ROUTER,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const eventRow = mockDb.entities.BrokerSwapEvent.get(
      `${CHAIN_CELO}_200_0`,
    ) as { routedViaV3Router: boolean } | undefined;
    assert.isOk(eventRow, "BrokerSwapEvent row missing");
    assert.equal(eventRow!.routedViaV3Router, false);
    assert.isOk(
      mockDb.entities.BrokerDailySnapshot.get(
        `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`,
      ),
      "legacy Router direct-to-Broker swaps should remain in the v2 daily series",
    );
    const routeRow = mockDb.entities.BrokerAggregatorDailySnapshot.get(
      `${CHAIN_CELO}-mento-router-v3-${dayTs}`,
    ) as { aggregator: string; lastSeenAggregatorAddress: string } | undefined;
    assert.isOk(routeRow, "Mento Router v3 route row missing");
    assert.equal(routeRow!.aggregator, "mento-router-v3");
    assert.equal(routeRow!.lastSeenAggregatorAddress, V3_ROUTER.toLowerCase());
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

  it("rolls every Broker.Swap into BrokerExchangeDailySnapshot by (chain, exchangeProvider, exchangeId, day)", async () => {
    let mockDb = MockDb.createMockDb();
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
      txTo: V3_ROUTER,
      amountIn: 250n * 10n ** 18n,
      amountOut: 249_875_000n,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const snapshotId = `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-${EXCHANGE_ID.toLowerCase()}-${dayTs}`;
    const snap = mockDb.entities.BrokerExchangeDailySnapshot.get(snapshotId) as
      | {
          chainId: number;
          exchangeProvider: string;
          exchangeId: string;
          timestamp: bigint;
          swapCount: number;
          volumeUsdWei: bigint;
          blockNumber: bigint;
        }
      | undefined;

    assert.isOk(snap, "BrokerExchangeDailySnapshot missing");
    assert.equal(snap!.chainId, CHAIN_CELO);
    assert.equal(snap!.exchangeProvider, BIPOOL_MANAGER.toLowerCase());
    assert.equal(snap!.exchangeId, EXCHANGE_ID.toLowerCase());
    assert.equal(snap!.timestamp, dayTs);
    assert.equal(snap!.swapCount, 2);
    assert.equal(snap!.volumeUsdWei, 1_250n * 10n ** 18n);
    assert.equal(snap!.blockNumber, 101n);
  });

  it("keeps BrokerExchangeDailySnapshot rows separated by exchangeId", async () => {
    const otherExchangeId =
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const mixedCaseOtherExchangeId = `0x${otherExchangeId
      .slice(2)
      .toUpperCase()}`;
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      exchangeId: EXCHANGE_ID,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500,
      logIndex: 0,
      exchangeId: mixedCaseOtherExchangeId,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const first = mockDb.entities.BrokerExchangeDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-${EXCHANGE_ID.toLowerCase()}-${dayTs}`,
    ) as { swapCount: number } | undefined;
    const second = mockDb.entities.BrokerExchangeDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-${otherExchangeId}-${dayTs}`,
    ) as { swapCount: number } | undefined;

    assert.equal(first?.swapCount, 1);
    assert.equal(second?.swapCount, 1);
  });

  it("excludes v3-router VirtualPool siblings from BrokerDailySnapshot", async () => {
    // Same day, same provider, but different `tx.to`: one direct broker call,
    // one via the v3 Router → VirtualPool path. The v2 chart reads only the
    // direct row; the v3 sibling is already counted by VirtualPool.Swap.
    let mockDb = MockDb.createMockDb();
    mockDb = await seedVirtualPool(mockDb);
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
      brokerCaller: VIRTUAL_POOL_ADDR,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const direct = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`,
    ) as { swapCount: number } | undefined;
    const v3Sibling = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-router-${dayTs}`,
    ) as { swapCount: number } | undefined;
    assert.equal(direct?.swapCount, 1);
    assert.isUndefined(v3Sibling);
  });

  it("rolls broker-direct swaps into BrokerTraderDailySnapshot per (chain, caller, day)", async () => {
    let mockDb = MockDb.createMockDb();
    // Two same-day v2 swaps from the same caller; assert the rollup
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
    const id = `${CHAIN_CELO}-${SIGNER_EOA.toLowerCase()}-${dayTs}`;
    const row = mockDb.entities.BrokerTraderDailySnapshot.get(id) as
      | {
          chainId: number;
          caller: string;
          timestamp: bigint;
          swapCount: number;
          volumeUsdWei: bigint;
          isSystemAddress: boolean;
          lastSeenTimestamp: bigint;
        }
      | undefined;
    assert.isOk(row, "BrokerTraderDailySnapshot missing");
    assert.equal(row!.chainId, CHAIN_CELO);
    assert.equal(row!.caller, SIGNER_EOA.toLowerCase());
    assert.equal(row!.swapCount, 2);
    assert.equal(row!.volumeUsdWei, 1_500n * 10n ** 18n);
    assert.equal(row!.isSystemAddress, false);
    // lastSeenTimestamp tracks the most recent swap's block timestamp
    // (not the day bucket) for sub-day "Last active" precision.
    assert.equal(row!.lastSeenTimestamp, 1_700_000_500n);
  });

  it("does NOT flag isSystemAddress on brokerCaller-side match (avoids hiding MentoRouter users as system volume)", async () => {
    // Codex P1 finding on PR #363: an earlier draft of this PR OR-ed the
    // `isSystemAddress` check across both `caller` and `brokerCaller`. That
    // looks correct in isolation but it pulls double duty against the flat
    // system-addresses set, which includes user-facing routers (MentoRouter
    // v1/v2, Routerv300) alongside true protocol-internal addresses
    // (Reserve, MigrationMultisig). For a normal user routing via
    // MentoRouter, `brokerCaller = MentoRouter` (in system-addresses) while
    // `caller = user EOA` (not). OR-checking would hide the user as system
    // volume — false positive. The current rule is signer-EOA-only.
    const RESERVE = "0x9380fA34Fd9e4Fd14c06305fd7B6199089eD4eb9"; // Celo Reserve from @mento-protocol/contracts
    const NORMAL_EOA = "0xc1cccccccccccccccccccccccccccccccccccccc";
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      brokerCaller: RESERVE, // IS in system-addresses
      txFrom: NORMAL_EOA, // NOT in system-addresses
    });

    const dayTs = dayBucket(1_700_000_000n);
    const id = `${CHAIN_CELO}-${NORMAL_EOA.toLowerCase()}-${dayTs}`;
    const row = mockDb.entities.BrokerTraderDailySnapshot.get(id) as
      | { caller: string; isSystemAddress: boolean }
      | undefined;
    assert.isOk(row, "BrokerTraderDailySnapshot row missing");
    assert.equal(row!.caller, NORMAL_EOA.toLowerCase());
    assert.equal(
      row!.isSystemAddress,
      false,
      "isSystemAddress must check ONLY caller (signer EOA); checking brokerCaller too would wrongly hide MentoRouter users",
    );
  });

  it("does NOT write trader/aggregator rollups when routedViaV3Router=true (avoids double-count vs v3)", async () => {
    // Same caller, two swaps: one direct, one via the v3 Router. Only the
    // direct row should land in the v2 trader rollup; the router-driven row
    // is already covered by the v3 volume table's TraderDailySnapshot via the
    // VirtualPool.Swap sibling that fired in the same tx.
    let mockDb = MockDb.createMockDb();
    mockDb = await seedVirtualPool(mockDb);
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
      brokerCaller: VIRTUAL_POOL_ADDR,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const traderRow = mockDb.entities.BrokerTraderDailySnapshot.get(
      `${CHAIN_CELO}-${SIGNER_EOA.toLowerCase()}-${dayTs}`,
    ) as { swapCount: number; volumeUsdWei: bigint } | undefined;
    assert.isOk(
      traderRow,
      "BrokerTraderDailySnapshot should still exist for the broker-direct swap",
    );
    // The router-driven swap was excluded — count and volume reflect ONE swap.
    assert.equal(traderRow!.swapCount, 1);
    assert.equal(traderRow!.volumeUsdWei, 1_000n * 10n ** 18n);
  });

  it("does NOT write trader/aggregator rollups when brokerCaller is a registered VirtualPool (avoids double-count vs v3 VirtualPool.Swap path)", async () => {
    // Scenario: third-party aggregator → VirtualPool → Broker. The v3
    // volume already counts the sibling VirtualPool.Swap (via
    // applyVolumeSnapshots in handlers/virtualPool.ts). `tx.to` is the
    // aggregator's router (so `routedViaV3Router=false`), but Broker emits
    // `trader = msg.sender = the VirtualPool address`. The handler's Pool
    // lookup on `brokerCaller` should detect the virtual_pool_factory
    // source and skip the v2 producer/aggregator rollups even though the
    // simple routedViaV3Router guard misses this path.
    // Some external aggregator router that ISN'T Routerv300 — proves the
    // routedViaV3Router guard alone wouldn't skip this swap.
    const EXTERNAL_AGGREGATOR =
      "0x0000000000000000000000000000000000001111".toLowerCase();

    let mockDb = MockDb.createMockDb();

    mockDb = await seedVirtualPool(mockDb);
    const seededPool = mockDb.entities.Pool.get(
      makePoolId(CHAIN_CELO, VIRTUAL_POOL_ADDR),
    ) as { source: string } | undefined;
    assert.ok(seededPool, "VirtualPool must exist after VirtualPoolDeployed");
    assert.include(
      seededPool!.source,
      "virtual",
      "Seeded pool must carry a virtual_* source so isVirtualPool() detects it",
    );

    // Now fire a Broker.Swap whose brokerCaller is the VirtualPool address —
    // the signature of an aggregator → VirtualPool → Broker tx.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      brokerCaller: VIRTUAL_POOL_ADDR,
      txTo: EXTERNAL_AGGREGATOR, // routedViaV3Router=false (not Routerv300)
    });

    const dayTs = dayBucket(1_700_000_000n);

    // BrokerSwapEvent: still written (raw audit log preserves all events).
    const eventRow = mockDb.entities.BrokerSwapEvent.get(`${CHAIN_CELO}_100_0`);
    assert.isOk(
      eventRow,
      "BrokerSwapEvent should still record the raw VirtualPool-routed swap",
    );

    // BrokerDailySnapshot: NOT written either. The dashboard's v2
    // volume-over-time chart consumes BrokerDailySnapshot rows filtered
    // only by `routedViaV3Router=false`; if a VirtualPool-routed swap
    // landed in that bucket it would inflate the legacy-v2 series, since
    // the v3 VirtualPool.Swap sibling is already counted by
    // applyVolumeSnapshots. Cursor flagged this specifically on
    // PR #363 — see the deploy-ordering / handler scope discussion there.
    const dailyRow = mockDb.entities.BrokerDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`,
    );
    assert.isUndefined(
      dailyRow,
      "BrokerDailySnapshot should NOT record VirtualPool-routed Broker swaps — the v3 VirtualPool.Swap sibling already counts them",
    );

    const exchangeActivityRow = mockDb.entities.BrokerExchangeDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-${EXCHANGE_ID.toLowerCase()}-${dayTs}`,
    );
    assert.isOk(
      exchangeActivityRow,
      "BrokerExchangeDailySnapshot should record full exchange activity for the VirtualPool header even when the legacy-v2 rollups skip VP-routed swaps",
    );

    // BrokerTraderDailySnapshot: NOT written (the whole point of the fix).
    // Check both the brokerCaller-keyed id (legacy attribution) and the
    // caller-keyed id (current attribution) — neither should exist.
    const traderRowByVirtualPool =
      mockDb.entities.BrokerTraderDailySnapshot.get(
        `${CHAIN_CELO}-${VIRTUAL_POOL_ADDR}-${dayTs}`,
      );
    assert.isUndefined(
      traderRowByVirtualPool,
      "VirtualPool-routed Broker.Swap must not produce a BrokerTraderDailySnapshot — would double-count vs the v3 VirtualPool.Swap path",
    );
    const traderRowByCaller = mockDb.entities.BrokerTraderDailySnapshot.get(
      `${CHAIN_CELO}-${SIGNER_EOA.toLowerCase()}-${dayTs}`,
    );
    assert.isUndefined(
      traderRowByCaller,
      "VirtualPool-routed Broker.Swap must not produce a BrokerTraderDailySnapshot keyed by caller either — same double-count concern",
    );

    // BrokerAggregatorDailySnapshot: also NOT written for the same reason.
    // classifyAggregator(EXTERNAL_AGGREGATOR) would yield "unknown" for an
    // un-registered router, so the negative assertion checks all aggregator
    // names that could plausibly land here.
    const allAggregatorRowsEmpty = (
      [
        "unknown",
        "broker",
        "mento-router-v2",
        "mento-router-v3",
        "direct",
        "system",
      ] as const
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

  it("rolls broker-direct swaps into BrokerAggregatorDailySnapshot keyed by entry point", async () => {
    let mockDb = MockDb.createMockDb();
    // Two distinct callers both entering via the Broker proxy (a
    // Broker entry point. Assert the
    // aggregator rollup tallies swaps + uniqueTraders correctly across them.
    const SIGNER_B = "0xBeefBeefBeefBeefBeefBeefBeefBeefBeefBeef";
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txFrom: SIGNER_EOA,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500,
      logIndex: 0,
      txFrom: SIGNER_B,
    });
    // Same caller as the first swap — uniqueTraders should NOT increment.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 102,
      blockTimestamp: 1_700_000_900,
      logIndex: 0,
      txFrom: SIGNER_EOA,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const id = `${CHAIN_CELO}-broker-${dayTs}`;
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
    assert.equal(row!.aggregator, "broker");
    assert.equal(row!.lastSeenAggregatorAddress, BROKER_PROXY.toLowerCase());
    assert.equal(row!.swapCount, 3);
    // First-touch dedup via BrokerAggregatorTraderDayMarker — SIGNER_EOA seen
    // twice on the same day shouldn't double-count.
    assert.equal(row!.uniqueTraders, 2);
    // 1000 + 1000 + 1000 CUSD.
    assert.equal(row!.volumeUsdWei, 3_000n * 10n ** 18n);

    // Marker entities exist per (aggregator, caller, day).
    assert.isOk(
      mockDb.entities.BrokerAggregatorTraderDayMarker.get(
        `${CHAIN_CELO}-broker-${SIGNER_EOA.toLowerCase()}-${dayTs}`,
      ),
    );
    assert.isOk(
      mockDb.entities.BrokerAggregatorTraderDayMarker.get(
        `${CHAIN_CELO}-broker-${SIGNER_B.toLowerCase()}-${dayTs}`,
      ),
    );
  });

  it("classifies an unknown txTo as 'unknown' so unlabelled v2 routers surface for follow-up", async () => {
    // A swap that entered via some random contract not in
    // contracts.json / aggregators.json. The volume table's "unknown" bucket
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

  it("writes BrokerTraderRouterDayMarker per (caller, tx.to, day) for v2 Via attribution", async () => {
    // Two swaps from the same caller through the SAME tx.to on the same day:
    // exactly one marker row should exist (idempotent get → set if undefined).
    const ROUTER_A = "0x1111111111111111111111111111111111111111";
    const ROUTER_B = "0x2222222222222222222222222222222222222222";
    let mockDb = MockDb.createMockDb();
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txTo: ROUTER_A,
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500,
      logIndex: 0,
      txTo: ROUTER_A,
    });
    // Third swap from the same caller routes through a DIFFERENT tx.to on the
    // same day — a second marker row should exist for the (caller, ROUTER_B)
    // pair. This is the case the new entity exists to capture: today's
    // `BrokerAggregatorTraderDayMarker` collapses both swaps under
    // `aggregator=unknown` and loses the address split.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 102,
      blockTimestamp: 1_700_001_000,
      logIndex: 0,
      txTo: ROUTER_B,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const aMarkerId = `${CHAIN_CELO}-${SIGNER_EOA.toLowerCase()}-${ROUTER_A.toLowerCase()}-${dayTs}`;
    const bMarkerId = `${CHAIN_CELO}-${SIGNER_EOA.toLowerCase()}-${ROUTER_B.toLowerCase()}-${dayTs}`;
    const aMarker = mockDb.entities.BrokerTraderRouterDayMarker.get(
      aMarkerId,
    ) as
      | {
          chainId: number;
          caller: string;
          txTo: string;
          aggregator: string;
          timestamp: bigint;
        }
      | undefined;
    const bMarker = mockDb.entities.BrokerTraderRouterDayMarker.get(bMarkerId);
    assert.isOk(aMarker, "ROUTER_A marker missing");
    assert.isOk(bMarker, "ROUTER_B marker missing");
    assert.equal(aMarker!.chainId, CHAIN_CELO);
    assert.equal(aMarker!.caller, SIGNER_EOA.toLowerCase());
    assert.equal(aMarker!.txTo, ROUTER_A.toLowerCase());
    assert.equal(aMarker!.aggregator, "unknown");
    assert.equal(aMarker!.timestamp, dayTs);
  });

  it("does NOT write BrokerTraderRouterDayMarker when routedViaV3Router=true", async () => {
    // Mirrors the existing aggregator-marker skip: router-driven swaps that
    // sibling a VirtualPool.Swap are excluded from the v2 producer rollups
    // (already counted via the v3 volume). The new per-trader-router
    // marker follows the same skip rule.
    let mockDb = MockDb.createMockDb();
    mockDb = await seedVirtualPool(mockDb);
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txTo: V3_ROUTER,
      brokerCaller: VIRTUAL_POOL_ADDR,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const markerId = `${CHAIN_CELO}-${SIGNER_EOA.toLowerCase()}-${V3_ROUTER.toLowerCase()}-${dayTs}`;
    assert.isUndefined(
      mockDb.entities.BrokerTraderRouterDayMarker.get(markerId),
      "router-driven swap should not produce a trader-router marker",
    );
  });

  it("does NOT write BrokerTraderRouterDayMarker when brokerCaller is a registered VirtualPool (aggregator → VirtualPool → Broker path)", async () => {
    // Sibling of the existing "does NOT write trader/aggregator rollups
    // when brokerCaller is a registered VirtualPool" test (around line 524).
    // The aggregator → VirtualPool → Broker path has `tx.to = aggregator`
    // (NOT Routerv300), so `routedViaV3Router=false` — but the v3 volume
    // already counts the sibling `VirtualPool.Swap`. Writing a marker here
    // would attribute v3 flow as legacy-v2 trader activity. This test pins
    // the skip symmetry between the two double-count guards.
    const EXTERNAL_AGGREGATOR =
      "0x0000000000000000000000000000000000001111".toLowerCase();
    let mockDb = MockDb.createMockDb();
    mockDb = await seedVirtualPool(mockDb);
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      txTo: EXTERNAL_AGGREGATOR,
      brokerCaller: VIRTUAL_POOL_ADDR,
    });

    const dayTs = dayBucket(1_700_000_000n);
    const markerId = `${CHAIN_CELO}-${SIGNER_EOA.toLowerCase()}-${EXTERNAL_AGGREGATOR}-${dayTs}`;
    assert.isUndefined(
      mockDb.entities.BrokerTraderRouterDayMarker.get(markerId),
      "VirtualPool-routed swap should not produce a trader-router marker",
    );
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

    const bipoolExchange = mockDb.entities.BrokerExchangeDailySnapshot.get(
      `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-${EXCHANGE_ID.toLowerCase()}-${dayTs}`,
    ) as { exchangeProvider: string; swapCount: number } | undefined;
    const otherExchange = mockDb.entities.BrokerExchangeDailySnapshot.get(
      `${CHAIN_CELO}-${OTHER_PROVIDER}-${EXCHANGE_ID.toLowerCase()}-${dayTs}`,
    ) as { exchangeProvider: string; swapCount: number } | undefined;
    assert.equal(
      bipoolExchange?.exchangeProvider,
      BIPOOL_MANAGER.toLowerCase(),
    );
    assert.equal(otherExchange?.exchangeProvider, OTHER_PROVIDER);
    assert.equal(bipoolExchange?.swapCount, 1);
    assert.equal(otherExchange?.swapCount, 1);
  });
});

describe("v3 router lookup smoke test", () => {
  it("@mento-protocol/contracts still registers the v3 Router on Celo at the expected address", () => {
    // The handler at handlers/broker.ts uses this address together with the
    // Broker caller VirtualPool check to separate v3 Router siblings from
    // legacy Router direct-to-Broker calls. If the package ever loses that
    // entry (rename, repackaging), Router sibling classification regresses.
    assert.equal(
      getContractAddress(CHAIN_CELO, "Routerv300")?.toLowerCase(),
      V3_ROUTER.toLowerCase(),
      "If this fails, @mento-protocol/contracts has changed Routerv300 — update V3_ROUTER constant or restore the entry.",
    );
  });
});

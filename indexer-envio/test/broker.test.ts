/// <reference types="mocha" />
import { assert } from "chai";
import generated from "generated";
import {
  _setMockERC20Decimals,
  _clearMockERC20Decimals,
} from "../src/EventHandlers.ts";
import { dayBucket } from "../src/helpers.ts";
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
  };
};

const { TestHelpers } = generated as unknown as GeneratedModule;
const { MockDb, Broker } = TestHelpers;

const CHAIN_CELO = 42220;
// Real Mento BiPoolManager (v2 legacy) on Celo — what the chart will filter for.
const BIPOOL_MANAGER = "0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901";
// USDM (cUSD-equivalent on Mento V2) — 18 decimals; USD-pegged so volumeUsdWei ≠ 0.
const USDM = "0x765de816845861e75a25fca122bb6898b8b1282a";
// USDC bridged token — 6 decimals; non-pegged in pickPeggedSide so the
// USDM leg is what gets used as the USD notional.
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
  },
): Promise<MockDb> => {
  const event = Broker.Swap.createMockEvent({
    exchangeProvider: args.exchangeProvider ?? BIPOOL_MANAGER,
    exchangeId: EXCHANGE_ID,
    trader: TRADER,
    tokenIn: args.tokenIn ?? USDM,
    tokenOut: args.tokenOut ?? USDC,
    amountIn: args.amountIn ?? 1_000n * 10n ** 18n, // 1000 USDM
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
  beforeEach(() => {
    _clearMockERC20Decimals();
    _setMockERC20Decimals(CHAIN_CELO, USDM, 18);
    _setMockERC20Decimals(CHAIN_CELO, USDC, 6);
  });

  afterEach(() => {
    _clearMockERC20Decimals();
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
    assert.equal(row!.tokenIn, USDM.toLowerCase());
    assert.equal(row!.tokenOut, USDC.toLowerCase());
    // Amounts pass through untouched.
    assert.equal(row!.amountIn, 1_000n * 10n ** 18n);
    assert.equal(row!.amountOut, 999_500_000n);
    // USDM leg drives the USD notional: 1000 USDM = 1000 × 1e18 = 1e21 USD-wei.
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
    // USDM leg larger than the USDC leg so `pickPeggedSide` consistently picks
    // USDM as the notional side — keeps the assertion stable.
    mockDb = await fireSwap(mockDb, {
      blockNumber: 100,
      blockTimestamp: 1_700_000_000,
      logIndex: 0,
      amountIn: 1_000n * 10n ** 18n, // 1000 USDM in
      amountOut: 999_500_000n, // 999.5 USDC out (1000 > 999.5 → USDM wins)
    });
    mockDb = await fireSwap(mockDb, {
      blockNumber: 101,
      blockTimestamp: 1_700_000_500, // same day
      logIndex: 0,
      amountIn: 500n * 10n ** 18n, // 500 USDM in
      amountOut: 499_750_000n, // 499.75 USDC out (500 > 499.75 → USDM wins)
    });

    const dayTs = dayBucket(1_700_000_000n);
    const snapshotId = `${CHAIN_CELO}-${BIPOOL_MANAGER.toLowerCase()}-direct-${dayTs}`;
    const snap = mockDb.entities.BrokerDailySnapshot.get(snapshotId) as
      | { swapCount: number; volumeUsdWei: bigint; routedViaV3Router: boolean }
      | undefined;
    assert.isOk(snap, "BrokerDailySnapshot missing");
    assert.equal(snap!.swapCount, 2);
    // 1000 + 500 = 1500 USDM in USD-wei.
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

  it("buckets distinct exchangeProviders into separate daily snapshots", async () => {
    // Future-proofs against the dashboard treating non-BiPoolManager events
    // as v2: each provider gets its own snapshot row, so the filter
    // `exchangeProvider == BiPoolManager` is mechanically a no-op against
    // unrelated providers (CDP, OLS, etc., if they ever emit Broker.Swap).
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

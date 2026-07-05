/**
 * Issue #1054 scenario 5 — multichain namespacing: the same contract address
 * emitting on two chains must produce two distinct `{chainId}-{address}`
 * entities with zero field bleed. Covers both the "pool" variant (FPMM pools
 * deploy on both Celo and Monad) and the "trove" variant (Liquity entity ID
 * construction, since Liquity itself only deploys on Celo today — see
 * `LIQUITY_CHAIN_ID` in `src/handlers/liquity/config.ts` — so the collision
 * guarantee is pinned at the ID-construction level rather than through a
 * live two-chain handler run).
 */
import { strict as assert } from "assert";
import {
  _clearMockERC20Decimals,
  _clearMockRebalanceThresholds,
  _clearMockRebalancingStates,
  _clearMockReserves,
  _setMockERC20Decimals,
  _setMockRebalanceThresholds,
  _setMockRebalancingState,
} from "../src/EventHandlers.ts";
import { makePoolId } from "../src/helpers.ts";
import {
  makeCollateralId,
  LIQUITY_MARKETS,
} from "../src/handlers/liquity/config.ts";
import { makeTroveId } from "../src/handlers/liquity/troves.ts";
import {
  indexerTestHelpers,
  type EntityReader,
  type MockDbWith,
} from "./helpers/indexerTestHarness.js";

type MockDb = MockDbWith<{
  Pool: EntityReader<{ id: string; reserves0: bigint; reserves1: bigint }>;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, FPMMFactory, FPMM } = TestHelpers;

const POOL_ADDR = "0x00000000000000000000000000000000000000fa";
const TOKEN0 = "0x00000000000000000000000000000000000004a0";
const TOKEN1 = "0x00000000000000000000000000000000000004a1";
const CELO = 42220;
const MONAD = 143;

async function deployAndUpdateReserves(
  mockDb: MockDb,
  chainId: number,
  reserve0: bigint,
  reserve1: bigint,
) {
  _setMockERC20Decimals(chainId, TOKEN0, 18);
  _setMockERC20Decimals(chainId, TOKEN1, 18);
  _setMockRebalanceThresholds(chainId, POOL_ADDR, { above: 5000, below: 5000 });
  _setMockRebalancingState(chainId, POOL_ADDR, null);

  const deployEvent = FPMMFactory.FPMMDeployed.createMockEvent({
    token0: TOKEN0,
    token1: TOKEN1,
    fpmmProxy: POOL_ADDR,
    fpmmImplementation: "0x00000000000000000000000000000000000000bc",
    mockEventData: {
      chainId,
      logIndex: 1,
      srcAddress: "0x00000000000000000000000000000000000000cc",
      block: { number: 1_000, timestamp: 10_000 },
    },
  });
  let db = await FPMMFactory.FPMMDeployed.processEvent({
    event: deployEvent,
    mockDb,
  });

  const updateEvent = FPMM.UpdateReserves.createMockEvent({
    reserve0,
    reserve1,
    blockTimestamp: 10_100,
    mockEventData: {
      chainId,
      srcAddress: POOL_ADDR,
      logIndex: 2,
      block: { number: 1_001, timestamp: 10_100 },
    },
  });
  db = await FPMM.UpdateReserves.processEvent({
    event: updateEvent,
    mockDb: db,
  });
  return db;
}

describe("Multichain namespacing — pool variant", () => {
  afterEach(() => {
    _clearMockReserves();
    _clearMockERC20Decimals();
    _clearMockRebalancingStates();
    _clearMockRebalanceThresholds();
  });

  it("the same FPMM proxy address on Celo and Monad produces two distinct Pool rows with zero field bleed", async () => {
    let mockDb = MockDb.createMockDb();
    mockDb = await deployAndUpdateReserves(
      mockDb,
      CELO,
      100n * 10n ** 18n,
      200n * 10n ** 18n,
    );
    mockDb = await deployAndUpdateReserves(
      mockDb,
      MONAD,
      999n * 10n ** 18n,
      888n * 10n ** 18n,
    );

    const celoPoolId = makePoolId(CELO, POOL_ADDR);
    const monadPoolId = makePoolId(MONAD, POOL_ADDR);
    assert.notEqual(celoPoolId, monadPoolId, "namespaced ids differ per chain");

    const celoPool = mockDb.entities.Pool.get(celoPoolId);
    const monadPool = mockDb.entities.Pool.get(monadPoolId);
    assert.ok(celoPool, "Celo Pool row exists");
    assert.ok(monadPool, "Monad Pool row exists");

    assert.equal(celoPool?.reserves0, 100n * 10n ** 18n);
    assert.equal(celoPool?.reserves1, 200n * 10n ** 18n);
    assert.equal(
      monadPool?.reserves0,
      999n * 10n ** 18n,
      "Monad's reserves are untouched by the Celo UpdateReserves event",
    );
    assert.equal(monadPool?.reserves1, 888n * 10n ** 18n);
  });
});

describe("Multichain namespacing — trove variant (ID-construction guarantee)", () => {
  // Liquity's LIQUITY_MARKETS are Celo-only today (see config.ts's hardcoded
  // LIQUITY_CHAIN_ID) — there is no real second-chain deployment to drive
  // through the harness. The collision-resistance guarantee lives in the ID
  // construction helpers themselves (`makeCollateralId` / `makeTroveId`),
  // which is what the handlers rely on if Liquity ever ships on a second
  // chain with the same deterministic (CREATE3) addresses.
  it("makeCollateralId namespaces the same troveManager address per chain", () => {
    const market = LIQUITY_MARKETS[0]!;
    const collateralIdCelo = makeCollateralId(market);
    const collateralIdOtherChain = makeCollateralId({
      ...market,
      chainId: 143,
    });
    assert.notEqual(collateralIdCelo, collateralIdOtherChain);
    assert.equal(collateralIdCelo, `${market.chainId}-${market.troveManager}`);
    assert.equal(collateralIdOtherChain, `143-${market.troveManager}`);
  });

  it("makeTroveId composes on top of the chain-namespaced collateralId, so the same troveId never collides across chains", () => {
    const market = LIQUITY_MARKETS[0]!;
    const collateralIdCelo = makeCollateralId(market);
    const collateralIdOtherChain = makeCollateralId({
      ...market,
      chainId: 143,
    });

    const troveIdCelo = makeTroveId(collateralIdCelo, "0x1");
    const troveIdOtherChain = makeTroveId(collateralIdOtherChain, "0x1");
    assert.notEqual(
      troveIdCelo,
      troveIdOtherChain,
      "the same on-chain troveId 0x1 under the same troveManager address must resolve to distinct rows per chain",
    );
  });
});

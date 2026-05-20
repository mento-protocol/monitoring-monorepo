import { createTestIndexer } from "envio";
import { assert } from "vitest";
import "../src/EventHandlers.ts";
import { makePoolId } from "../src/helpers.ts";

const CHAIN_ID = 42220;
const POOL = "0x00000000000000000000000000000000000000aa";
const OLS = "0x00000000000000000000000000000000000000bb";
const DEBT_TOKEN = "0x00000000000000000000000000000000000000cc";
const FEE_RECIPIENT = "0x00000000000000000000000000000000000000dd";
const TOKEN_IN = "0x00000000000000000000000000000000000000ee";
const TOKEN_OUT = "0x00000000000000000000000000000000000000ff";
const TX_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

type EntityRow = { id: string };
type EntityChange = { sets?: EntityRow[]; deleted?: string[] };

function eventBase(blockNumber: number, logIndex: number) {
  return {
    srcAddress: OLS,
    logIndex,
    block: { number: blockNumber, timestamp: 1_700_000_000 + blockNumber },
    transaction: {
      hash: TX_HASH,
      from: "0x0000000000000000000000000000000000001234",
      to: OLS,
    },
  };
}

function poolAdded(blockNumber: number, logIndex: number, cooldown: bigint) {
  return {
    contract: "OpenLiquidityStrategy",
    event: "PoolAdded",
    ...eventBase(blockNumber, logIndex),
    params: {
      pool: POOL,
      params: {
        debtToken: DEBT_TOKEN,
        cooldown,
        protocolFeeRecipient: FEE_RECIPIENT,
        liquiditySourceIncentiveExpansion: 10n,
        liquiditySourceIncentiveContraction: 11n,
        protocolIncentiveExpansion: 12n,
        protocolIncentiveContraction: 13n,
      },
    },
  };
}

function liquidityMoved(blockNumber: number, logIndex: number) {
  return {
    contract: "OpenLiquidityStrategy",
    event: "LiquidityMoved",
    ...eventBase(blockNumber, logIndex),
    params: {
      pool: POOL,
      direction: 0n,
      tokenGivenToPool: TOKEN_IN,
      amountGivenToPool: 100n,
      tokenTakenFromPool: TOKEN_OUT,
      amountTakenFromPool: 95n,
    },
  };
}

function finalRows(
  changes: readonly Record<string, unknown>[],
  entityName: string,
): Map<string, EntityRow> {
  const rows = new Map<string, EntityRow>();
  for (const change of changes) {
    const entityChange = change[entityName] as EntityChange | undefined;
    if (!entityChange) continue;
    for (const row of entityChange.sets ?? []) rows.set(row.id, row);
    for (const id of entityChange.deleted ?? []) rows.delete(id);
  }
  return rows;
}

describe("OpenLiquidityStrategy handlers", () => {
  it("keeps one OlsPool row per PoolAdded registration and rolls counters into the latest active registration", async () => {
    const indexer = createTestIndexer();
    const result = await indexer.process({
      chains: {
        [CHAIN_ID]: {
          startBlock: 100,
          endBlock: 120,
          simulate: [
            poolAdded(100, 0, 60n),
            poolAdded(110, 0, 120n),
            liquidityMoved(120, 0),
          ],
        },
      },
    });

    const poolId = makePoolId(CHAIN_ID, POOL);
    const olsAddress = OLS.toLowerCase();
    const firstId = `${poolId}-${olsAddress}-${CHAIN_ID}_100_0`;
    const secondId = `${poolId}-${olsAddress}-${CHAIN_ID}_110_0`;
    const rows = finalRows(result.changes, "OlsPool");
    const first = rows.get(firstId) as
      | {
          isActive: boolean;
          rebalanceCooldown: bigint;
          olsRebalanceCount: number;
        }
      | undefined;
    const second = rows.get(secondId) as
      | {
          isActive: boolean;
          rebalanceCooldown: bigint;
          olsRebalanceCount: number;
        }
      | undefined;

    assert.isOk(first, "first registration row missing");
    assert.isOk(second, "second registration row missing");
    assert.equal(first!.isActive, false);
    assert.equal(first!.rebalanceCooldown, 60n);
    assert.equal(first!.olsRebalanceCount, 0);
    assert.equal(second!.isActive, true);
    assert.equal(second!.rebalanceCooldown, 120n);
    assert.equal(second!.olsRebalanceCount, 1);
    assert.isOk(
      finalRows(result.changes, "OlsLiquidityEvent").get(`${CHAIN_ID}_120_0`),
      "liquidity event row missing",
    );
  });
});

import assert from "node:assert/strict";
import type { Pool } from "envio";
import {
  type EntityCollection,
  indexerTestHelpers,
  type MockDbWith,
  type WritableEntity,
} from "../helpers/indexerTestHarness.js";
import {
  _clearMockMedianTimestamps,
  _setMockMedianTimestamp,
} from "../../src/EventHandlers.ts";
import { makePoolId } from "../../src/helpers.js";
import { registerMockRateFeedDependenciesHttp } from "../../src/rpc/http-test-mock-bridge.js";
import { makePool } from "../helpers/makePool.js";

type MockDb = MockDbWith<{
  OracleSnapshot: WritableEntity & EntityCollection;
  Pool: WritableEntity<Pool>;
}>;

const TestHelpers = indexerTestHelpers<MockDb>();
const { MockDb, SortedOracles } = TestHelpers;
const CHAIN_ID = 42220;
const FEED = "0xf4f9bbda9cd6841fcb9b1510f9269e2db42a6e3a";
const SORTED_ORACLES = "0xefb84935239dacdecf7c5ba76d8de40b077b7b33";
const EVENT_NAME = process.env.SORTED_ORACLES_FAILURE_EVENT;

if (EVENT_NAME !== "OracleReported" && EVENT_NAME !== "MedianUpdated") {
  throw new Error(`Unsupported SORTED_ORACLES_FAILURE_EVENT=${EVENT_NAME}`);
}

it(`fails closed before writes for tracked ${EVENT_NAME}`, async () => {
  registerMockRateFeedDependenciesHttp(CHAIN_ID, FEED, []);
  _setMockMedianTimestamp(CHAIN_ID, FEED, null);

  const poolId = makePoolId(
    CHAIN_ID,
    "0x0000000000000000000000000000000000008562",
  );
  const initialPool = makePool({
    id: poolId,
    referenceRateFeedID: FEED,
    reserves0: 10n ** 21n,
    reserves1: 10n ** 21n,
    invertRateFeedKnown: true,
    tokenDecimalsKnown: true,
    oracleExpiry: 300n,
    lastMedianPrice: 10n ** 24n,
  });
  let mockDb = MockDb.createMockDb();
  mockDb = mockDb.entities.Pool.set(initialPool);

  const mockEventData = {
    chainId: CHAIN_ID,
    logIndex: 9,
    srcAddress: SORTED_ORACLES,
    block: { number: 60_664_503, timestamp: 1_700_002_200 },
  };
  const event =
    EVENT_NAME === "OracleReported"
      ? SortedOracles.OracleReported.createMockEvent({
          token: FEED,
          reporter: "0x00000000000000000000000000000000000000aa",
          value: 10n ** 24n,
          timestamp: 1_700_002_150n,
          mockEventData,
        })
      : SortedOracles.MedianUpdated.createMockEvent({
          token: FEED,
          value: 10n ** 24n,
          mockEventData,
        });

  try {
    await assert.rejects(
      () =>
        SortedOracles[EVENT_NAME].processEvent({
          event,
          mockDb,
        }),
      /Worker exited with code 1/,
    );
    assert.deepEqual(mockDb.entities.Pool.get(poolId), initialPool);
    assert.deepEqual(mockDb.entities.OracleSnapshot.getAll(), []);
    assert.equal(initialPool.healthTotalSeconds, 0n);
    assert.equal(initialPool.healthBinarySeconds, 0n);
    assert.equal(initialPool.lastOracleSnapshotTimestamp, 0n);
  } finally {
    _clearMockMedianTimestamps();
  }
});

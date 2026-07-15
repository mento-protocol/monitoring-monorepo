import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGraphQL } from "../tests/browser/fixtures/hasura-fixture-server.mjs";

const DAY_SECONDS = 86_400;
const QUERY =
  "query HomepageOgDailySnapshots { PoolDailySnapshot { timestamp } }";
const POOL_ID = "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
const FIXED_NOW_MS = Date.UTC(2026, 5, 16, 12, 0, 0);

function dailyRows(variables) {
  return handleGraphQL({ query: QUERY, variables }).PoolDailySnapshot;
}

describe("hasura fixture daily snapshot filters", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("honors HomepageOgDailySnapshots since variables", () => {
    const todayStart =
      Math.floor(FIXED_NOW_MS / 1000 / DAY_SECONDS) * DAY_SECONDS;

    const rows = dailyRows({
      poolIds: [],
      since: todayStart - 1,
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => Number(row.timestamp) === todayStart)).toBe(
      true,
    );
  });

  it("prefers afterTimestamp when both daily snapshot variables are present", () => {
    const todayStart =
      Math.floor(FIXED_NOW_MS / 1000 / DAY_SECONDS) * DAY_SECONDS;

    const rows = dailyRows({
      poolIds: [],
      afterTimestamp: 0,
      since: todayStart - 1,
    });

    // Five rows per fixture pool (today, 1d, 2d, plus deliberate 365d and
    // 366d full-history sentinels used by the bounded-SSR browser flow).
    expect(rows).toHaveLength(10);
  });

  it.each(["PoolDailySnapshotsChart", "PoolOgDailySnapshots"])(
    "keeps the old all-history sentinels out of %s",
    (operation) => {
      const todayStart =
        Math.floor(FIXED_NOW_MS / 1000 / DAY_SECONDS) * DAY_SECONDS;
      const rows = handleGraphQL({
        query: `query ${operation} { PoolDailySnapshot { timestamp } }`,
        variables: { poolId: POOL_ID },
      }).PoolDailySnapshot;

      expect(rows).toHaveLength(3);
      expect(rows.map((row) => Number(row.timestamp))).toEqual([
        todayStart,
        todayStart - DAY_SECONDS,
        todayStart - 2 * DAY_SECONDS,
      ]);
    },
  );
});

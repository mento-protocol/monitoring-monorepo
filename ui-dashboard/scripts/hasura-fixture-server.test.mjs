import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGraphQL } from "../tests/browser/fixtures/hasura-fixture-server.mjs";

const DAY_SECONDS = 86_400;
const QUERY =
  "query HomepageOgDailySnapshots { PoolDailySnapshot { timestamp } }";
const POOLS_QUERY = "query PoolsForVolume { Pool { id } }";
const FIXED_NOW_MS = Date.UTC(2026, 5, 16, 12, 0, 0);

function dailyRows(variables) {
  return handleGraphQL({ query: QUERY, variables }).PoolDailySnapshot;
}

function fixturePoolCount() {
  return handleGraphQL({ query: POOLS_QUERY }).Pool.length;
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

    expect(rows).toHaveLength(fixturePoolCount());
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

    expect(rows).toHaveLength(fixturePoolCount() * 3);
  });
});

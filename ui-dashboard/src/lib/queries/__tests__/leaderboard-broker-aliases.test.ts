import { describe, it, expect } from "vitest";

import {
  BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS,
  BROKER_TRADER_DAILY_TOP,
  BROKER_LEADERBOARD_WINDOW_FIRSTDAY_LATEST,
  BROKER_LEADERBOARD_TODAY_TRADERS,
  BROKER_LEADERBOARD_YESTERDAY_TRADERS,
  LEADERBOARD_PARTIAL_OVERLAP_TRADERS,
  LEADERBOARD_WINDOW_FIRSTDAY_LATEST,
} from "../leaderboard";
import { BROKER_TRADER_ROUTER_DAY_MARKERS } from "../leaderboard-via";

// Cursor flagged on PR #363 that the v2 dashboard's whole `BrokerTraderDaily*`
// path now relies on the GraphQL aliasing `trader: caller` to keep the row
// shape uniform with v3 (so `aggregateBrokerTradersByWindow` /
// `mergeHeroSnapshot` / `BrokerTraderDailyRow` consumers don't need a parallel
// type). `useGQL<...>`'s handwritten generics don't validate selection sets,
// and the leaderboard data-shape tests in `leaderboard.test.ts` mock
// already-shaped `{ trader: ... }` rows — so a missed alias on any of the
// three queries below would still typecheck and only fail at runtime in prod.
//
// These contract tests are the cheap, focused fix: they pin the alias on every
// site so a future edit that drops `trader: caller` (e.g. while changing the
// rollup schema, renaming `caller` again, or re-shaping the queries) breaks
// here at test-time, not on a Vercel deploy with the dashboard down. The full
// query-shape snapshot in `lib/__tests__/queries.test.ts` covers other surfaces;
// this file is the dedicated guard for the v2-trader-attribution alias.
describe("v2 broker leaderboard queries — caller→trader alias", () => {
  it("BROKER_TRADER_DAILY_TOP aliases caller → trader", () => {
    expect(BROKER_TRADER_DAILY_TOP).toContain("trader: caller");
    // Sanity: the re-keyed schema field must actually be the source of the alias.
    // If someone refactors the indexer to rename `caller` again, this test
    // surfaces the dashboard-side gap before the dashboard breaks.
    expect(BROKER_TRADER_DAILY_TOP).not.toContain(
      /* a bare `trader` selection without the alias would pass the
         `toContain("trader")` assertion above; pin the absence of the
         no-alias form explicitly. */
      "      trader\n",
    );
  });

  it("BROKER_LEADERBOARD_TODAY_TRADERS aliases caller → trader", () => {
    expect(BROKER_LEADERBOARD_TODAY_TRADERS).toContain("trader: caller");
    expect(BROKER_LEADERBOARD_TODAY_TRADERS).not.toContain("      trader\n");
  });

  it("BROKER_LEADERBOARD_YESTERDAY_TRADERS aliases caller → trader", () => {
    expect(BROKER_LEADERBOARD_YESTERDAY_TRADERS).toContain("trader: caller");
    expect(BROKER_LEADERBOARD_YESTERDAY_TRADERS).not.toContain(
      "      trader\n",
    );
  });

  it("BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS uses caller for filters and aliases it", () => {
    expect(BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS).toContain(
      "{ caller: asc }",
    );
    expect(BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS).toContain(
      "distinct_on: [chainId, caller, isSystemAddress]",
    );
    expect(BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS).toContain(
      "trader: caller",
    );
    expect(BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS).not.toContain(
      "      trader\n",
    );
  });
});

describe("leaderboard hero rollout-safe isolated queries", () => {
  it("first-day slice queries select only scalar fields used by the merge", () => {
    for (const query of [
      LEADERBOARD_WINDOW_FIRSTDAY_LATEST,
      BROKER_LEADERBOARD_WINDOW_FIRSTDAY_LATEST,
    ]) {
      expect(query).not.toContain("\n      firstDayExclusiveTraders\n");
      expect(query).not.toContain(
        "\n      firstDayExclusiveTradersIncludingSystem\n",
      );
    }
  });

  it("partial-overlap queries include system status for sticky-system de-dupe", () => {
    for (const query of [
      LEADERBOARD_PARTIAL_OVERLAP_TRADERS,
      BROKER_LEADERBOARD_PARTIAL_OVERLAP_TRADERS,
    ]) {
      expect(query).toContain("isSystemAddress");
    }
  });
});

describe("v2 Via marker query", () => {
  it("filters by caller + cutoff and surfaces tx.to + aggregator", () => {
    // The new entity carries the raw `tx.to` plus the cached `aggregator`
    // classification, so the column can render clickable router addresses for
    // traders the bucketed view today labels `unknown`. The filter shape uses
    // `caller _in` (matches the @index on BrokerTraderRouterDayMarker.caller)
    // rather than the older id-cartesian expansion — `_in` keeps the request
    // size linear in the visible top-N instead of `N × aggregators × days`.
    expect(BROKER_TRADER_ROUTER_DAY_MARKERS).toContain(
      "BrokerTraderRouterDayMarker",
    );
    expect(BROKER_TRADER_ROUTER_DAY_MARKERS).toContain(
      "caller: { _in: $callers }",
    );
    expect(BROKER_TRADER_ROUTER_DAY_MARKERS).toContain(
      "timestamp: { _gte: $afterTimestamp }",
    );
    expect(BROKER_TRADER_ROUTER_DAY_MARKERS).toContain("txTo");
    expect(BROKER_TRADER_ROUTER_DAY_MARKERS).toContain("aggregator");
  });
});

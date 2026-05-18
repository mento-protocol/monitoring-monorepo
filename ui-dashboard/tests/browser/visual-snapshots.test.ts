/**
 * Visual-regression baselines for key dashboard pages.
 *
 * Each test navigates to a page, waits for data to render, then captures a
 * screenshot via `toHaveScreenshot()`. Playwright diffs future runs against
 * the stored .png baselines. A diff above `maxDiffPixels` fails the test.
 *
 * Maintenance
 * -----------
 * - Re-baseline after a legitimate UI change:
 *     pnpm --filter ui-dashboard test:browser:update-snapshots
 * - Baselines live under __snapshots__/ next to this file.
 * - PRs that touch styled components MUST verify baselines still pass.
 *
 * Pages covered
 * -------------
 * 1. /pools              – global pools list with two fixture pools
 * 2. /pool/<celo>        – pool detail, LPs tab (default)
 * 3. /pool/<celo>?tab=swaps – pool detail, Swaps tab
 * 4. /bridge-flows       – bridge flows page (empty-state; bridge queries mocked)
 * 5. /leaderboard        – leaderboard page (empty-state; leaderboard queries mocked)
 */

import { expect, test, type Page } from "@playwright/test";

const CELO_POOL_ID = "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";

// Pin the clock to the same weekday fixture instant used in dashboard-flows
// so `isWeekend()` stays false and FX pools aren't short-circuited to WEEKEND.
const WEEKDAY_FIXTURE_INSTANT = new Date("2026-04-15T12:00:00Z");

function extractOperationName(postData: string | null): string | null {
  if (!postData) return null;
  return postData.match(/\bquery\s+([A-Za-z0-9_]+)/)?.[1] ?? null;
}

// Maps each unhandled bridge / leaderboard operation to the minimal empty-data
// shape its consumer expects. Using `{}` causes runtime errors when the client
// destructures fields (e.g. `data?.BridgeTransfer.length`).
const EMPTY_RESPONSE_BY_OP: Record<string, Record<string, unknown>> = {
  // Bridge operations
  BridgeTransfersWindow: { BridgeTransfer: [] },
  BridgeTransfersCount: { BridgeTransfer: [] },
  BridgePendingIds: { BridgeTransfer: [] },
  BridgeDeliveredRecent: { BridgeTransfer: [] },
  BridgeDailySnapshot: { BridgeDailySnapshot: [] },
  BridgeTopBridgers: { BridgeBridger: [] },
  // Leaderboard operations
  TraderDailyTop: { TraderDailyVolume: [] },
  TraderPoolDailyForTrader: { TraderPoolDailyVolume: [] },
  TraderDailyWindowTop: { TraderDailyVolume: [] },
  TraderPoolDailyTop: { TraderPoolDailyVolume: [] },
  SwapEventOutliers: { SwapEvent: [] },
  PoolsForLeaderboard: { Pool: [] },
  PoolDailyVolume: { PoolDailySnapshot: [] },
  AggregatorDailyTop: { AggregatorDailyVolume: [] },
  AggregatorDailyTopIncludingSystem: { AggregatorDailyVolume: [] },
  BrokerTraderDailyTop: { BrokerTraderDailyVolume: [] },
  BrokerAggregatorDailyTop: { BrokerAggregatorDailyVolume: [] },
  LeaderboardWindowLatest: { LeaderboardWindow: [] },
  BrokerLeaderboardWindowLatest: { BrokerLeaderboardWindow: [] },
  LeaderboardWindowFirstDayLatest: { LeaderboardWindowFirstDay: [] },
  BrokerLeaderboardWindowFirstDayLatest: {
    BrokerLeaderboardWindowFirstDay: [],
  },
  LeaderboardPartialOverlapTraders: { LeaderboardWindow: [] },
  BrokerLeaderboardPartialOverlapTraders: { BrokerLeaderboardWindow: [] },
  LeaderboardTodayTraders: { LeaderboardWindow: [] },
  BrokerLeaderboardTodayTraders: { BrokerLeaderboardWindow: [] },
  LeaderboardYesterdayTraders: { LeaderboardWindow: [] },
  BrokerLeaderboardYesterdayTraders: { BrokerLeaderboardWindow: [] },
  BrokerAggregatorTraderDayMarkersById: { BrokerAggregatorTraderDayMarker: [] },
};

/** Intercept GraphQL requests for `opNames` and fulfill them with
 *  empty-but-correctly-shaped data so the page renders a loaded empty state. */
async function mockEmptyGraphQLOps(page: Page, opNames: string[]) {
  await page.route("**/graphql", async (route) => {
    const op = extractOperationName(route.request().postData());
    if (!op || !opNames.includes(op)) {
      await route.continue();
      return;
    }
    const emptyData = EMPTY_RESPONSE_BY_OP[op] ?? {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: emptyData }),
    });
  });
}

/** Inject a CSS rule that freezes all animations + transitions so screenshots
 *  are deterministic across frames and platforms. */
async function freezeAnimations(page: Page) {
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; animation-duration: 0s !important; }",
  });
}

/** Build locators for all volatile regions on the current page.
 *
 * The fixture server generates timestamps from real wall-clock time, but the
 * browser clock is pinned — so relative strings like "Created 33d ago" advance
 * with real time and cause false-positive diffs. We mask those regions so only
 * structurally/visually meaningful pixel changes fail the snapshot tests.
 */
function timestampMasks(page: Page) {
  return [
    // data-testid conventions (used by newer components)
    page.locator('[data-testid="timestamp"]'),
    page.locator('[data-testid="last-updated"]'),
    // "Created 33d ago" anchor/span in pool-header (title="Created on YYYY-MM-DD")
    page.locator('[title*="Created "]'),
    // Any element whose visible text contains "Xd/h/m/s ago" (oracle freshness,
    // LP position timestamps, etc.)
    page.locator(':text-matches("\\d+[smhd] ago")'),
    // Swap row time cell: renders as "Xd ago" when pinned clock > real time, or
    // as an absolute locale date (e.g. "5/19/2026, 12:12:36 AM") when the fixture
    // timestamp is newer than the pinned browser clock (diff < 0 → formatTimestamp
    // fallback in relativeTime()). The <td> element gets title={formatTimestamp(...)}
    // so we match it by the fact that its title contains a localized date.
    // Using :text-matches to catch both the "Xd ago" and absolute-date variants.
    page.locator(':text-matches("\\d{1,2}/\\d{1,2}/\\d{4}")'),
  ];
}

test.describe("visual snapshots", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: WEEKDAY_FIXTURE_INSTANT });
  });

  test("pools list page", async ({ page }) => {
    await page.goto("/pools");

    // Wait for the pool rows to appear — the fixture returns two pools so we
    // can assert on a known pool name before snapping. Use .first() because the
    // pools list renders two links per pool (row name + mobile card name).
    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "USDC/USDm" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "AUSD/USDm" }).first(),
    ).toBeVisible();

    await page.waitForLoadState("networkidle");
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("pools-list.png", {
      maxDiffPixels: 100,
      mask: timestampMasks(page),
      fullPage: false,
    });
  });

  test("pool detail – LPs tab", async ({ page }) => {
    await page.goto(`/pool/${CELO_POOL_ID}`);

    await expect(
      page.getByRole("heading", { name: "USDC/USDm" }),
    ).toBeVisible();
    // LPs tab is selected by default in the fixture environment.
    await expect(page.getByRole("tab", { name: "LPs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.waitForLoadState("networkidle");
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("pool-detail-lps.png", {
      maxDiffPixels: 100,
      mask: timestampMasks(page),
      fullPage: false,
    });
  });

  test("pool detail – Swaps tab", async ({ page }) => {
    await page.goto(`/pool/${CELO_POOL_ID}?tab=swaps`);

    await expect(
      page.getByRole("heading", { name: "USDC/USDm" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "swaps" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Wait for swap rows to appear ("Sold" column is the fixture marker).
    await expect(page.getByRole("tabpanel")).toContainText("Sold");

    await page.waitForLoadState("networkidle");
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("pool-detail-swaps.png", {
      maxDiffPixels: 100,
      mask: timestampMasks(page),
      fullPage: false,
    });
  });

  test("bridge flows page", async ({ page }) => {
    // Route bridge queries to empty-data so the page renders loaded state
    // without relying on a separate bridge Hasura fixture server.
    await mockEmptyGraphQLOps(page, [
      "BridgeTransfersWindow",
      "BridgeTransfersCount",
      "BridgePendingIds",
      "BridgeDeliveredRecent",
      "BridgeDailySnapshot",
      "BridgeTopBridgers",
    ]);

    await page.goto("/bridge-flows");

    // The h1 heading is "Bridge Flows" — use exact match to avoid matching
    // lower-level headings like "Top bridgers".
    await expect(
      page.getByRole("heading", { name: "Bridge Flows" }),
    ).toBeVisible();

    await page.waitForLoadState("networkidle");
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("bridge-flows.png", {
      maxDiffPixels: 100,
      mask: timestampMasks(page),
      fullPage: false,
    });
  });

  test("leaderboard page", async ({ page }) => {
    // Return empty data for all leaderboard-specific operations so the page
    // renders the loaded empty state rather than a spinner or error.
    await mockEmptyGraphQLOps(page, [
      "TraderDailyTop",
      "TraderPoolDailyForTrader",
      "TraderDailyWindowTop",
      "TraderPoolDailyTop",
      "SwapEventOutliers",
      "PoolsForLeaderboard",
      "PoolDailyVolume",
      "AggregatorDailyTop",
      "AggregatorDailyTopIncludingSystem",
      "BrokerTraderDailyTop",
      "BrokerAggregatorDailyTop",
      "LeaderboardWindowLatest",
      "BrokerLeaderboardWindowLatest",
      "LeaderboardWindowFirstDayLatest",
      "BrokerLeaderboardWindowFirstDayLatest",
      "LeaderboardPartialOverlapTraders",
      "BrokerLeaderboardPartialOverlapTraders",
      "LeaderboardTodayTraders",
      "BrokerLeaderboardTodayTraders",
      "LeaderboardYesterdayTraders",
      "BrokerLeaderboardYesterdayTraders",
      "BrokerAggregatorTraderDayMarkersById",
    ]);

    await page.goto("/leaderboard");

    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible();

    await page.waitForLoadState("networkidle");
    await freezeAnimations(page);

    await expect(page).toHaveScreenshot("leaderboard.png", {
      maxDiffPixels: 100,
      mask: timestampMasks(page),
      fullPage: false,
    });
  });
});

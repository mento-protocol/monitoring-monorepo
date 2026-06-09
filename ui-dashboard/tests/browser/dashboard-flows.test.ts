import { expect, test, type Page } from "@playwright/test";

const CELO_POOL_ID = "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
const MONAD_POOL_ID = "143-0xb0a0264ce6847f101b76ba36a4a3083ba489f501";

function escapedPoolId(poolId: string): RegExp {
  return new RegExp(`/pool/${poolId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

function trackUnexpectedBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes("Failed to load resource")) return;
    errors.push(text);
  });
  return errors;
}

// Pin the browser clock to a weekday inside the FX trading window so
// `isWeekend()` (`ui-dashboard/src/lib/weekend.ts`) deterministically
// returns false. Without this, the suite was passing only on weekdays:
// during the Fri 21:00 UTC → Sun 23:00 UTC window `computeHealthStatus`
// short-circuits to "WEEKEND", `useRebalanceCheck` skips the API call,
// and the rebalance-blocked prose never renders. Wed 2026-04-15 12:00
// UTC is mid-window for FX trading hours on every supported chain.
const WEEKDAY_FIXTURE_INSTANT = new Date("2026-04-15T12:00:00Z");
const FIXTURE_NOW_SECONDS = Math.floor(
  WEEKDAY_FIXTURE_INSTANT.getTime() / 1000,
);

async function mockBlockedRebalanceProbe(page: Page) {
  await page.route("**/graphql", async (route) => {
    const body = route.request().postData() ?? "";
    if (!body.includes("query PoolDetailWithHealth")) {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const json = await response.json();
    // Compute stale relative to the pinned browser clock (not real Node
    // time): from the browser's perspective the page sees
    // WEEKDAY_FIXTURE_INSTANT as "now", so the mock has to be two hours
    // *before that*, not two hours before real wall-clock. Otherwise the
    // pretended-stale oracle timestamp is a real-world month in the
    // future and any code path that gates on oracle freshness wouldn't
    // trip into the stale branch.
    const staleOracleTimestamp = FIXTURE_NOW_SECONDS - 2 * 60 * 60;
    json.data.Pool = json.data.Pool.map((pool: Record<string, unknown>) => ({
      ...pool,
      oracleTimestamp: String(staleOracleTimestamp),
      priceDifference: "200",
      rebalanceThreshold: 100,
      lastRebalancedAt: "0",
      rebalancerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
    await route.fulfill({ response, json });
  });

  await page.route("**/api/rebalance-check?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        canRebalance: false,
        message: "Stability pool has insufficient liquidity",
        rawError: "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW",
        strategyType: "cdp",
        enrichment: {
          type: "cdp",
          stabilityPoolBalance: 5000,
          stabilityPoolTokenSymbol: "GBPm",
          stabilityPoolTokenDecimals: 18,
        },
      }),
    });
  });
}

test.describe("dashboard browser flows", () => {
  let browserErrors: string[];

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: WEEKDAY_FIXTURE_INSTANT });
    browserErrors = trackUnexpectedBrowserErrors(page);
  });

  test.afterEach(() => {
    expect(browserErrors).toEqual([]);
  });

  test("switches chain context through real pool navigation", async ({
    page,
  }) => {
    await page.goto("/pools");

    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Celo" }).first()).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Monad" }).first(),
    ).toBeVisible();

    await page.getByRole("link", { name: "AUSD/USDm" }).click();

    await expect(page).toHaveURL(escapedPoolId(MONAD_POOL_ID));
    await expect(
      page.getByRole("heading", { name: "AUSD/USDm" }),
    ).toBeVisible();
    await expect(page.getByRole("img", { name: "Monad" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "LPs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("renders CDP detail trove ranking with indexed ICR and interest", async ({
    page,
  }) => {
    await page.goto("/cdps/gbpm");

    await expect(
      page.getByRole("heading", { name: "GBPm CDP Market" }),
    ).toBeVisible();
    await expect(page.getByText("Total Supply (System Debt)")).toBeVisible();

    const table = page.getByRole("table", { name: "GBPm troves" });
    await expect(table).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Rank" }),
    ).toBeVisible();
    const icrInfo = table.getByRole("button", {
      name: "About indexed ICR",
    });
    await expect(icrInfo).toBeVisible();
    await expect(icrInfo).toHaveAccessibleDescription(
      /not a live oracle\/RPC read/,
    );
    await expect(
      table.getByRole("columnheader", { name: "Interest" }),
    ).toBeVisible();
    await expect(table).toContainText("2.10%");
    const firstUpdatedLink = table
      .locator("tbody tr")
      .first()
      .locator("td")
      .nth(7)
      .getByRole("link");
    await expect(firstUpdatedLink).toHaveAttribute(
      "href",
      "https://celoscan.io/tx/0x2222222222222222222222222222222222222222222222222222222222222222",
    );
    await expect(firstUpdatedLink).toHaveAttribute("aria-describedby", /.+/);
    await expect(firstUpdatedLink).not.toHaveAttribute("title", /.+/);

    await page.getByRole("tab", { name: "History" }).click();
    await expect(table).toContainText("redeemed");
  });

  test("keeps pool tabs manually activated with keyboard focus and URL state", async ({
    page,
  }) => {
    await page.goto(`/pool/${CELO_POOL_ID}`);

    const lpsTab = page.getByRole("tab", { name: "LPs" });
    const swapsTab = page.getByRole("tab", { name: "swaps" });

    await expect(
      page.getByRole("heading", { name: "USDC/USDm" }),
    ).toBeVisible();
    await expect(lpsTab).toHaveAttribute("aria-selected", "true");

    await lpsTab.focus();
    await page.keyboard.press("ArrowRight");

    await expect(swapsTab).toBeFocused();
    await expect(lpsTab).toHaveAttribute("aria-selected", "true");
    await expect(page).not.toHaveURL(/tab=swaps/);

    await page.keyboard.press("Enter");

    await expect(swapsTab).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/tab=swaps/);
    await expect(page.getByRole("tabpanel")).toContainText("Sold");
    await expect(page.getByRole("tabpanel")).toContainText("Bought");
  });

  test("switches pool tabs without refetching the route payload", async ({
    page,
  }) => {
    await page.goto(`/pool/${CELO_POOL_ID}`);

    await expect(
      page.getByRole("heading", { name: "USDC/USDm" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "LPs" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const rscRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("_rsc=")) rscRequests.push(url);
    });

    await page.getByRole("tab", { name: "swaps" }).click();

    await expect(page).toHaveURL(/tab=swaps/);
    await expect(page.getByRole("tab", { name: "swaps" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tabpanel")).toContainText("Sold");
    expect(rscRequests).toEqual([]);
  });

  test("contains the pool tab overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/pool/${CELO_POOL_ID}?tab=swaps`);

    await expect(page.getByRole("tab", { name: "swaps" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const hasDocumentOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(hasDocumentOverflow).toBe(false);
  });

  test("omits deviation threshold remnants on the Oracle tab", async ({
    page,
  }) => {
    await page.goto(`/pool/${CELO_POOL_ID}?tab=oracle`);

    await expect(page.getByRole("tab", { name: "Oracle" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const tabpanel = page.getByRole("tabpanel", { name: "oracle" });
    await expect(
      tabpanel.getByText("Oracle Price vs Breaker Band"),
    ).toBeVisible();
    await expect(tabpanel.getByText("Deviation breach started")).toHaveCount(0);
    await expect(tabpanel.getByText("Rebalance breach start")).toHaveCount(0);
    await expect(
      tabpanel.getByRole("columnheader", { name: "Price Diff" }),
    ).toHaveCount(0);
    await expect(
      tabpanel.getByRole("columnheader", { name: "Threshold" }),
    ).toHaveCount(0);
    await expect(tabpanel.getByText("one-sided")).toHaveCount(0);
  });

  test("shows a degraded query state without hiding healthy page sections", async ({
    page,
  }) => {
    await page.route("**/graphql", async (route) => {
      const body = route.request().postData() ?? "";
      if (!body.includes("query RecentSwaps")) {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          errors: [{ message: "Fixture recent swaps failed" }],
        }),
      });
    });

    await page.goto("/pools");

    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
    await expect(page.getByRole("link", { name: "AUSD/USDm" })).toBeVisible();
    await expect(
      page.getByText(/Failed to load swaps:.*Fixture recent swaps failed/),
    ).toBeVisible();
  });

  test("filters stable supply changes by committed USD threshold", async ({
    page,
  }) => {
    await page.goto("/stables");

    await expect(
      page.getByRole("heading", { name: "Mento stablecoins" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Supply changes" }),
    ).toBeVisible();

    const input = page.getByLabel("Minimum USD-equivalent supply change");
    const rows = page.locator("tbody tr");

    await expect(input).toHaveValue("0.01");
    await expect(
      page.getByText("Hiding changes below $0.01 equivalent."),
    ).toBeVisible();
    await expect(
      page.getByText("Keeping 1 unpriced event visible."),
    ).toBeVisible();
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: "USDm" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "GBPm" })).toHaveCount(2);
    await expect(rows.filter({ hasText: "BRLm" })).toHaveCount(1);

    await input.fill("1.");

    await expect(input).toHaveValue("1.");
    expect(page.url()).not.toContain("minSupplyChangeUsd");
    await expect(
      page.getByText("Hiding changes below $0.01 equivalent."),
    ).toBeVisible();
    await expect(rows).toHaveCount(4);

    await input.fill("1");
    await input.press("Enter");

    await expect(page).toHaveURL(/minSupplyChangeUsd=1/);
    await expect(input).toHaveValue("1");
    await expect(
      page.getByText("Hiding changes below $1.00 equivalent."),
    ).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "USDm" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "GBPm" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "BRLm" })).toHaveCount(1);

    await page.getByRole("button", { name: "Reset" }).click();

    await expect(page).not.toHaveURL(/minSupplyChangeUsd=/);
    await expect(input).toHaveValue("0.01");
    await expect(rows).toHaveCount(4);
  });

  test("shows the FX weekend banner after mount without a hydration mismatch", async ({
    page,
  }) => {
    // Pin the CLIENT clock to a Saturday so the weekend banner should show.
    // SSR renders with the server's own wall-clock day (often a weekday), so
    // gating the banner on a render-time isWeekend() would diverge from the
    // client and trip a hydration mismatch — caught by the afterEach
    // console-error assertion. useIsWeekend defers the banner to after mount, so
    // SSR and the hydration pass agree and the banner fades in client-side.
    await page.clock.setFixedTime(new Date("2026-04-18T12:00:00Z")); // Saturday
    await page.goto("/pools");

    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
    await expect(
      page.getByText(/FX markets are closed this weekend/),
    ).toBeVisible();
  });

  test("shows rebalance-blocked prose without the raw Solidity error code", async ({
    page,
  }) => {
    await mockBlockedRebalanceProbe(page);

    await page.goto(`/pool/${CELO_POOL_ID}`);

    await expect(page.getByText("Rebalance blocked")).toBeVisible();

    const diagnostics = page.getByRole("button", {
      name: /Rebalance diagnostics: Stability pool has insufficient liquidity/,
    });
    await expect(diagnostics).toHaveAccessibleDescription(
      "Stability pool has insufficient liquidity — Stability pool: 5.0k GBPm",
    );
    await expect(diagnostics).not.toHaveAttribute("title", /.+/);

    await diagnostics.click();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText(
      "Stability pool has insufficient liquidity",
    );
    await expect(tooltip).toContainText("Stability pool: 5.0k GBPm");
    await expect(tooltip).not.toContainText(
      "CDPLS_STABILITY_POOL_BALANCE_TOO_LOW",
    );
  });
});

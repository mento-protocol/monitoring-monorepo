import { expect, test, type Page, type Route } from "@playwright/test";

const CELO_POOL_ID = "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
const MONAD_POOL_ID = "143-0xb0a0264ce6847f101b76ba36a4a3083ba489f501";
const SWR_PERSISTED_CACHE_STORAGE_KEY = "mento-monitoring:swr-persisted-cache";

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
const WEEKEND_FIXTURE_INSTANT = new Date("2026-04-18T12:00:00Z");
const FIXED_WEEKEND_SERVER_CLOCK_HEADER = "x-playwright-fixed-weekend-clock";
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
      lastOracleReportAt: String(staleOracleTimestamp),
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

async function globalPoolsTableMetrics(page: Page) {
  return page.evaluate(() => {
    const table = [...document.querySelectorAll("table")].find((candidate) => {
      const headers = [...candidate.querySelectorAll("thead th")].map((th) =>
        (th.textContent || "").replace(/\s+/g, " ").trim(),
      );
      return (
        headers.some((header) => header.startsWith("Pool")) &&
        headers.includes("Reserves")
      );
    });
    if (!table) throw new Error("Global pools table not found");

    const wrapper = table.parentElement;
    return {
      bodyOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      tableOverflow:
        wrapper !== null && wrapper.scrollWidth > wrapper.clientWidth + 1,
      reserveRows: [...table.querySelectorAll("tbody tr")].flatMap((row) => {
        const pool = row
          .querySelector('a[href^="/pool/"]')
          ?.textContent?.trim();
        const reserve = row
          .querySelector('[aria-label^="Reserve composition:"]')
          ?.getAttribute("aria-label");
        return pool && reserve ? [{ pool, reserve }] : [];
      }),
    };
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

  test("keeps decoded homepage and pools documents below the Flight payload budget", async ({
    request,
  }) => {
    const paths = ["/", "/pools"] as const;
    const responses = await Promise.all(paths.map((path) => request.get(path)));
    const bodies = await Promise.all(
      responses.map((response) => response.body()),
    );

    responses.forEach((response) => expect(response.ok()).toBe(true));
    bodies.forEach((body, index) => {
      expect(
        body.byteLength,
        `${paths[index]} decoded document bytes`,
      ).toBeLessThan(500_000);
    });
  });

  test("filters homepage pools by name and multiple chain controls", async ({
    page,
  }) => {
    await page.goto("/");

    const search = page.getByPlaceholder("Filter by pool name");
    const chainFilters = page.getByRole("listbox", { name: "Chains" });
    await expect(search).toBeVisible();
    await expect(chainFilters).toHaveValues(["42220", "143"]);

    await search.fill("AUSD/USDm");
    await expect(page.getByRole("link", { name: "AUSD/USDm" })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "USDC/USDm" })).toHaveCount(0);

    await search.fill("");
    await chainFilters.selectOption(["143"]);
    await expect(chainFilters).toHaveValues(["143"]);
    await expect(page.getByRole("link", { name: "USDC/USDm" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "AUSD/USDm" })).toHaveCount(1);

    await chainFilters.selectOption([]);
    await expect(chainFilters).toHaveValues([]);
    await expect(
      page.getByRole("status", { name: "Filtered pool results" }),
    ).toHaveText("No pools match these filters.");
  });

  test("switches chain context through the pool list target", async ({
    page,
  }) => {
    await page.goto("/pools");

    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Celo" }).first()).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Monad" }).first(),
    ).toBeVisible();

    const monadPoolLink = page.getByRole("link", { name: "AUSD/USDm" });
    await expect(monadPoolLink).toHaveAttribute(
      "href",
      `/pool/${MONAD_POOL_ID}`,
    );
    await page.goto(`/pool/${MONAD_POOL_ID}`);

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

  test("keeps the bounded /pools SSR seed without an eager full-history client fetch", async ({
    page,
  }) => {
    let fullHistoryRequests = 0;
    await page.route("**/graphql", async (route) => {
      if (
        (route.request().postData() ?? "").includes(
          "query PoolDailySnapshotsAll",
        )
      ) {
        fullHistoryRequests += 1;
      }
      await route.continue();
    });

    await page.goto("/pools");
    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "USDC/USDm" }).first(),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");

    expect(fullHistoryRequests).toBe(0);
  });

  test("loads full homepage snapshot history on demand before rendering All", async ({
    page,
  }) => {
    let fullHistoryRequests = 0;
    let releaseFullHistory!: () => void;
    const fullHistoryGate = new Promise<void>((resolve) => {
      releaseFullHistory = resolve;
    });
    await page.route("**/graphql", async (route) => {
      if (
        !(route.request().postData() ?? "").includes(
          "query PoolDailySnapshotsAll",
        )
      ) {
        await route.continue();
        return;
      }
      fullHistoryRequests += 1;
      await fullHistoryGate;
      await route.continue();
    });

    await page.goto("/");
    const rangeGroup = page.getByRole("group", {
      name: "TVL chart time range",
    });
    await expect(rangeGroup).toBeVisible();
    await expect(
      rangeGroup.getByRole("button", { name: "1M" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(fullHistoryRequests).toBe(0);

    await rangeGroup.getByRole("button", { name: "All" }).click();

    await expect.poll(() => fullHistoryRequests).toBeGreaterThan(0);
    await expect(
      page.getByText("Total Value Locked chart is loading."),
    ).toHaveCount(1);
    await expect(
      rangeGroup.getByRole("button", { name: "All" }),
    ).toHaveAttribute("aria-pressed", "true");
    // The shared SWR key is revalidating, but its bounded SSR payload remains
    // valid last-good data for every surface except the selected capped chart.
    // Keep the loading state scoped to TVL "All" instead of blanking the 1M
    // Volume chart, KPI tiles, or pool table while the request is held.
    await expect(
      page.getByRole("figure", { name: "Volume chart, 1M range" }),
    ).toBeVisible();
    await expect(page.getByText("Volume chart is loading.")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /^Swap Fees:/ }),
    ).not.toHaveAttribute("aria-label", "Swap Fees: …");
    await expect(
      page
        .getByText("LPs", { exact: true })
        .locator("xpath=following-sibling::p[1]"),
    ).not.toHaveText("…");
    await expect(
      page
        .getByText("Swaps", { exact: true })
        .locator("xpath=following-sibling::p[1]"),
    ).not.toHaveText("…");
    await expect(
      page.getByRole("link", { name: "USDC/USDm" }).first(),
    ).toBeVisible();

    releaseFullHistory();

    await expect(
      page.getByText("Total Value Locked chart is loading."),
    ).toHaveCount(0);
    await expect(
      page.getByRole("figure", {
        name: "Total Value Locked chart, All range",
      }),
    ).toBeVisible();

    const completedRequestCount = fullHistoryRequests;
    await rangeGroup.getByRole("button", { name: "1M" }).click();
    await rangeGroup.getByRole("button", { name: "All" }).click();
    await page.waitForTimeout(200);
    expect(fullHistoryRequests).toBe(completedRequestCount);
  });

  test("shows an honest degraded state when full homepage history cannot load", async ({
    page,
  }) => {
    let fullHistoryRequests = 0;
    await page.route("**/graphql", async (route) => {
      if (
        (route.request().postData() ?? "").includes(
          "query PoolDailySnapshotsAll",
        )
      ) {
        fullHistoryRequests += 1;
        await route.abort("timedout");
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    const rangeGroup = page.getByRole("group", {
      name: "TVL chart time range",
    });
    await rangeGroup.getByRole("button", { name: "All" }).click();

    await expect.poll(() => fullHistoryRequests).toBeGreaterThan(0);
    const figure = page.getByRole("figure", {
      name: "Total Value Locked chart, All range",
    });
    await expect(
      figure.getByText("Unable to load full TVL history", { exact: true }),
    ).toBeVisible();
    await expect(figure.getByRole("img")).toHaveCount(0);
  });

  test("keeps a fresh live-health overlay ahead of an expiring fleet snapshot", async ({
    page,
  }) => {
    let browserNowSeconds = FIXTURE_NOW_SECONDS;
    let fleetResponses = 0;
    let liveHealthResponses = 0;
    // The fixture server stamps the base row from real Node time. This field
    // only orders base vs live rows; oracle freshness below stays pinned to
    // the browser clock for deterministic health assertions.
    const liveUpdatedAtTimestamp = String(Math.floor(Date.now() / 1000));

    await page.route("**/graphql", async (route) => {
      const body = route.request().postData() ?? "";

      if (body.includes("query AllPoolsLiveHealth")) {
        liveHealthResponses += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({
            data: {
              Pool: [
                {
                  id: CELO_POOL_ID,
                  updatedAtBlock: "1501",
                  updatedAtTimestamp: liveUpdatedAtTimestamp,
                  oracleOk: true,
                  oracleTimestamp: String(browserNowSeconds),
                  lastOracleReportAt: String(browserNowSeconds),
                  oracleExpiry: "300",
                  oracleNumReporters: 5,
                  priceDifference: "0",
                  rebalanceThreshold: 100,
                  rebalanceThresholdAbove: 100,
                  rebalanceThresholdBelow: 100,
                  rebalanceThresholdsKnown: true,
                  tokenDecimalsKnown: true,
                  degenerateReserves: false,
                  breakerTripped: false,
                  deviationBreachStartedAt: "0",
                  lastRebalancedAt: String(browserNowSeconds - 86_400),
                  hasHealthData: true,
                  limitStatus: "OK",
                  limitPressure0: "0",
                  limitPressure1: "0",
                  medianLive: true,
                  oracleFreshnessWindow: "0",
                },
              ],
            },
          }),
        });
        return;
      }

      if (!body.includes("query AllPoolsWithHealth")) {
        await route.continue();
        return;
      }

      const response = await route.fetch();
      const json = await response.json();
      // At the five-minute fleet refresh this row is just one second beyond
      // its expiry. The 30s live-health overlay above is current and must win
      // atomically, otherwise the homepage flashes a false CRITICAL badge
      // while the separately-fetched pool detail is healthy.
      json.data.Pool = json.data.Pool.map((pool: Record<string, unknown>) =>
        pool.id === CELO_POOL_ID
          ? {
              ...pool,
              oracleOk: true,
              oracleTimestamp: String(FIXTURE_NOW_SECONDS - 1),
              lastOracleReportAt: String(FIXTURE_NOW_SECONDS - 1),
              oracleExpiry: "300",
              priceDifference: "0",
              deviationBreachStartedAt: null,
              limitStatus: "OK",
              limitPressure0: "0",
              limitPressure1: "0",
            }
          : pool,
      );
      fleetResponses += 1;
      await route.fulfill({ response, json });
    });

    await page.goto("/");

    const poolLink = page.getByRole("link", { name: "USDC/USDm" }).first();
    await expect(poolLink).toBeVisible();
    await expect.poll(() => liveHealthResponses).toBeGreaterThan(0);

    const poolRow = page.getByRole("row").filter({ has: poolLink });
    const healthTrigger = poolRow.getByRole("button", {
      name: /^Pool health /,
    });
    await expect(healthTrigger).toHaveAccessibleName(
      /^Pool health OK: Oracle healthy \/ Pool balanced$/,
    );

    // Record even a one-render CRITICAL state; an eventual OK assertion alone
    // would miss the intermittent red flash reported on the homepage.
    await page.evaluate((poolId) => {
      const state = window as typeof window & {
        __criticalPoolHealthSeen?: boolean;
        __criticalPoolHealthObserver?: MutationObserver;
      };
      const check = () => {
        const link = document.querySelector(`a[href="/pool/${poolId}"]`);
        const label = link
          ?.closest("tr")
          ?.querySelector('button[aria-label^="Pool health "]')
          ?.getAttribute("aria-label");
        if (label?.startsWith("Pool health CRITICAL")) {
          state.__criticalPoolHealthSeen = true;
        }
      };

      state.__criticalPoolHealthSeen = false;
      state.__criticalPoolHealthObserver?.disconnect();
      state.__criticalPoolHealthObserver = new MutationObserver(check);
      state.__criticalPoolHealthObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-label"],
      });
      check();
    }, CELO_POOL_ID);

    const fleetResponsesBeforeRefresh = fleetResponses;
    browserNowSeconds = FIXTURE_NOW_SECONDS + 5 * 60;
    await page.clock.fastForward(5 * 60 * 1000);
    await expect
      .poll(() => fleetResponses)
      .toBeGreaterThan(fleetResponsesBeforeRefresh);

    browserNowSeconds += 30;
    const liveResponsesBeforeTick = liveHealthResponses;
    await page.clock.fastForward(30_000);
    await expect
      .poll(() => liveHealthResponses)
      .toBeGreaterThan(liveResponsesBeforeTick);

    await expect(healthTrigger).toHaveAccessibleName(
      /^Pool health OK: Oracle healthy \/ Pool balanced$/,
    );
    await expect(
      poolRow.getByText("Oracle stale — last update expired"),
    ).toHaveCount(0);
    const criticalHealthSeen = await page.evaluate(() => {
      const state = window as typeof window & {
        __criticalPoolHealthSeen?: boolean;
        __criticalPoolHealthObserver?: MutationObserver;
      };
      state.__criticalPoolHealthObserver?.disconnect();
      return state.__criticalPoolHealthSeen ?? false;
    });
    expect(criticalHealthSeen).toBe(false);

    await poolLink.click();
    await expect(page).toHaveURL(escapedPoolId(CELO_POOL_ID));
    await expect(
      page.getByRole("heading", { name: "USDC/USDm" }),
    ).toBeVisible();
    const oraclePrice = page.getByRole("button", {
      name: /^Showing 1 USDC = /,
    });
    await expect(oraclePrice).not.toHaveAccessibleName(/Oracle is stale/);
    await expect(page.getByText(/· stale/)).toHaveCount(0);
  });

  test("keeps pools tables within the viewport and mirrors pool token order in reserves", async ({
    page,
  }) => {
    // Widths chosen to exercise each column-reveal boundary: 1536 (2xl, Strategy
    // appears), 1280 (xl, 24h Vol. appears), 1024 (lg, neither), 390 (mobile).
    for (const path of ["/", "/pools"]) {
      for (const width of [1536, 1280, 1024, 390]) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Playwright drives a single shared page; viewport sizing + navigation must run sequentially, not via Promise.all.
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await expect(
          page.getByRole("link", { name: "USDC/USDm" }).first(),
        ).toBeVisible();

        const metrics = await globalPoolsTableMetrics(page);
        expect(metrics.bodyOverflow, `${path} ${width}px body`).toBe(false);
        expect(metrics.tableOverflow, `${path} ${width}px table`).toBe(false);

        for (const { pool, reserve } of metrics.reserveRows) {
          if (!pool?.endsWith("/USDm") || !reserve) continue;
          const firstSymbol = pool.split("/")[0];
          if (!firstSymbol) continue;
          expect(
            // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- reserve is a string; indexOf/lastIndexOf are string position searches, not array membership lookups.
            reserve.indexOf(firstSymbol),
            `${path} ${width}px ${pool} reserve label`,
          ).toBeLessThan(reserve.lastIndexOf("USDm"));
        }
      }
    }
  });

  test("renders CDP detail trove ranking with indexed ICR and interest", async ({
    page,
  }) => {
    await page.goto("/cdps/gbpm");

    await expect(
      page.getByRole("heading", { name: "GBPm CDP Market" }),
    ).toBeVisible();
    await expect(page.getByText("Total Supply (System Debt)")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Stability Pool LP Snapshots" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Current Deposit" }),
    ).toHaveAttribute("title", "Deposit at Last LP Update");
    await expect(
      page.getByRole("columnheader", { name: "Deposited (+)" }),
    ).toHaveAttribute("title", "Gross Deposited");
    await expect(
      page.getByRole("columnheader", { name: "Withdrawn (-)" }),
    ).toHaveAttribute("title", "Principal Withdrawn");
    await expect(
      page.getByRole("columnheader", { name: "Rebalance (-)" }),
    ).toHaveAttribute("title", "Rebalance Used");
    await expect(
      page.getByRole("columnheader", { name: "Liquidation (-)" }),
    ).toHaveAttribute("title", "Liquidation Used");
    await expect(
      page.getByRole("columnheader", { name: "Coll. Snapshot" }),
    ).toHaveAttribute("title", "Unclaimed Collateral at Last LP Update");
    await expect(
      page.getByTitle("0x9999999999999999999999999999999999999999"),
    ).toBeVisible();
    await expect(page.getByText("150.00 GBPm").first()).toBeVisible();
    await expect(page.getByText("2.00 USDm").first()).toBeVisible();
    await expect(page.getByText("SP Deposit").first()).toBeVisible();
    await expect(page.getByText("SP Withdraw").first()).toBeVisible();

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
    // The Updated time links straight to the tx — no custom tooltip popover;
    // the exact timestamp lives on the native title.
    await expect(firstUpdatedLink).not.toHaveAttribute(
      "aria-describedby",
      /.+/,
    );
    await expect(firstUpdatedLink).toHaveAttribute("title", /^Updated at /);

    await page.getByRole("tab", { name: "History" }).click();
    await expect(table).toContainText("redeemed");
  });

  test("renders CDP overview activity digest and grouped transactions", async ({
    page,
  }) => {
    await page.goto("/cdps");

    await expect(page.getByRole("heading", { name: "CDPs" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "24h CDP activity" }),
    ).toBeVisible();
    await expect(page.getByText(/Last 24h: .*redemption/)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Recent CDP Transactions" }),
    ).toBeVisible();
    await expect(page.getByText(/UTC/).first()).toBeVisible();
    await expect(page.getByText("Rebalance Redemption").first()).toBeVisible();
    await expect(page.getByText("SP Deposit").first()).toBeVisible();
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

    const poolRoutePattern = escapedPoolId(CELO_POOL_ID);
    const rscRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      // In production, next/link may prefetch unrelated nav destinations after
      // the page is visible. This assertion is specifically about tab state not
      // refetching the current pool route payload.
      if (url.includes("_rsc=") && poolRoutePattern.test(url)) {
        rscRequests.push(url);
      }
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

  test("warm-starts Trading Limits from bounded persisted SWR data before revalidation", async ({
    page,
  }) => {
    await page.goto(`/pool/${CELO_POOL_ID}?tab=limits`);

    const limitBars = page
      .getByRole("tabpanel", { name: "limits" })
      .getByRole("progressbar");
    await expect(limitBars).toHaveCount(4);
    await expect(limitBars.first()).toHaveAttribute("aria-valuenow", "0");

    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let tradingLimitsRequests = 0;

    await page.route("**/graphql", async (route) => {
      const body = route.request().postData() ?? "";
      if (!body.includes("query TradingLimits")) {
        await route.continue();
        return;
      }

      tradingLimitsRequests += 1;
      const response = await route.fetch();
      const json = await response.json();
      json.data.TradingLimit = json.data.TradingLimit.map(
        (row: Record<string, unknown>, index: number) =>
          index === 0
            ? {
                ...row,
                limitPressure0: "0.5",
                netflow0: "38500000000000000000",
              }
            : row,
      );
      markRefreshStarted();
      await refreshGate;
      await route.fulfill({ response, json });
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await refreshStarted;
    expect(tradingLimitsRequests).toBe(1);

    // The network response is still held above: these are the previous
    // session's real rows, not a skeleton or the mutated fixture response.
    await expect(limitBars).toHaveCount(4);
    await expect(limitBars.first()).toHaveAttribute("aria-valuenow", "0");
    await expect(
      page.getByRole("status").filter({ hasText: "Showing cached data" }),
    ).toBeVisible();

    const persisted = await page.evaluate((storageKey) => {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) throw new Error("Persisted SWR record is missing");
      const parsed = JSON.parse(raw) as {
        buildSalt: string;
        entries: Array<{ key: string }>;
        schemaVersion: number;
      };
      return {
        buildSalt: parsed.buildSalt,
        bytes: new Blob([raw]).size,
        keys: parsed.entries.map((entry) => entry.key),
        raw,
        schemaVersion: parsed.schemaVersion,
      };
    }, SWR_PERSISTED_CACHE_STORAGE_KEY);

    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.buildSalt).toBe("dev");
    expect(persisted.bytes).toBeLessThan(128 * 1024);
    expect(persisted.keys).toHaveLength(1);
    expect(persisted.keys[0]).toContain("query TradingLimits");
    for (const excluded of [
      "all-networks-data",
      "PoolDetailWithHealth",
      "PoolBreakerConfig",
      "PoolSwapsPage",
      "address-labels:all",
      "address-reports:index",
      "address-reports:single:",
    ]) {
      expect(persisted.raw).not.toContain(excluded);
    }

    // Give activation and its follow-up microtasks time to settle before
    // releasing the held response. A second request here would mean cache
    // activation bypassed SWR's in-flight deduplication.
    expect(tradingLimitsRequests).toBe(1);

    releaseRefresh();
    await expect(limitBars.first()).toHaveAttribute("aria-valuenow", "50");
    await expect(
      page.getByText("Showing cached data", { exact: false }),
    ).toHaveCount(0);
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

  test("filters pools swaps by raw address while preserving table sort URL state", async ({
    page,
  }) => {
    await page.goto("/pools");

    await expect(page.getByRole("heading", { name: "Pools" })).toBeVisible();
    await page.getByRole("button", { name: /TVL/ }).click();
    await expect(page).toHaveURL(/poolsSort=tvl/);
    await expect(page).toHaveURL(/poolsDir=asc/);

    await page
      .getByLabel("Filter swaps by pool ID or pool address")
      .fill("0x462fe04b4fd719cbd04c0310365d421d02aaa19e");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page).toHaveURL(/pool=42220-/);
    await expect(page).toHaveURL(/poolsSort=tvl/);
    await expect(page).toHaveURL(/poolsDir=asc/);
    await expect(
      page.getByRole("heading", { name: "Swaps for USDC/USDm" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
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

    await expect(input).toHaveValue("1000");
    await expect(
      page.getByText("Hiding changes below $1,000.00 equivalent."),
    ).toBeVisible();
    await expect(
      page.getByText("Keeping 1 unpriced event visible."),
    ).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.filter({ hasText: "USDm" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "GBPm" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "BRLm" })).toHaveCount(1);

    await input.fill("1.");

    await expect(input).toHaveValue("1.");
    expect(page.url()).not.toContain("minSupplyChangeUsd");
    await expect(
      page.getByText("Hiding changes below $1,000.00 equivalent."),
    ).toBeVisible();
    await expect(rows).toHaveCount(1);

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
    await expect(input).toHaveValue("1000");
    await expect(rows).toHaveCount(1);
  });

  test("SSR-renders the FX weekend banner on both pool surfaces and hydrates without a mismatch", async ({
    page,
    request,
  }) => {
    const fixedClockHeaders = {
      [FIXED_WEEKEND_SERVER_CLOCK_HEADER]: "true",
    };
    const routeDocumentWithFixedClock = async (route: Route) => {
      const request = route.request();
      if (request.resourceType() !== "document") {
        await route.continue();
        return;
      }
      await route.continue({
        headers: { ...request.headers(), ...fixedClockHeaders },
      });
    };
    try {
      // The Playwright-managed Next process scopes its matching Saturday
      // `new Date()` clock to this fixture header. Raw API responses never
      // execute page JavaScript, proving the banner is in SSR HTML rather than
      // inserted by the mounted client hook.
      await Promise.all(
        ["/", "/pools"].map(async (route) => {
          const response = await request.get(route, {
            headers: fixedClockHeaders,
          });
          expect(response.ok()).toBe(true);
          expect(await response.text()).toContain(
            "FX markets are closed this weekend.",
          );
        }),
      );

      // Scope the header to document requests. Sending it to the fixture
      // GraphQL origin would trigger an unnecessary CORS preflight.
      await page.route("**/*", routeDocumentWithFixedClock);
      await page.clock.setFixedTime(WEEKEND_FIXTURE_INSTANT);
      const expectHydratedWeekendBanner = async (route: string) => {
        await page.goto(route);
        await expect(
          page.getByText("FX markets are closed this weekend.", {
            exact: true,
          }),
        ).toBeVisible();
      };
      await expectHydratedWeekendBanner("/");
      await expectHydratedWeekendBanner("/pools");
    } finally {
      if (!page.isClosed()) {
        await page.unroute("**/*", routeDocumentWithFixedClock);
      }
    }
    // The suite's afterEach rejects every page/console hydration error.
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

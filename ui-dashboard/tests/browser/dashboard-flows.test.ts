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

async function mockBlockedRebalanceProbe(page: Page) {
  await page.route("**/graphql", async (route) => {
    const body = route.request().postData() ?? "";
    if (!body.includes("query PoolDetailWithHealth")) {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const json = await response.json();
    const staleOracleTimestamp = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
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

  test("shows rebalance-blocked prose without the raw Solidity error code", async ({
    page,
  }) => {
    await mockBlockedRebalanceProbe(page);

    await page.goto(`/pool/${CELO_POOL_ID}`);

    await expect(page.getByText("Rebalance blocked")).toBeVisible();

    const diagnostics = page.getByRole("button", {
      name: /Rebalance diagnostics: Stability pool has insufficient liquidity/,
    });
    await expect(diagnostics).toHaveAttribute(
      "title",
      "Stability pool has insufficient liquidity — Stability pool: 5.0k GBPm",
    );
    await expect(diagnostics).not.toHaveAttribute(
      "title",
      /CDPLS_STABILITY_POOL_BALANCE_TOO_LOW/,
    );

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

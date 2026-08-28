import { expect, test, type Page } from "@playwright/test";

// The fixture server's ticket-#0754 case-study trove (see the trove-history
// block in fixtures/hasura-fixture-server.mjs): opened at 0.5% with
// 39,955.00 USDm collateral against 25,012.87 debt, hit by five rebalance
// redemptions, rate moved to 1.6%, then adjusted +30,000.00 USDm /
// +2,500.00 debt — ending at 45,372.50 USDm collateral / 9,070.75 CHFm debt.
const CASE_TROVE_ID = "0x754";
const CASE_OWNER = "0xcca0a99b94529493ddffe7c61a3ae454828cd3bb";
const CASE_TROVE_PATH = `/cdps/chfm/troves/${CASE_TROVE_ID}`;
const CASE_TROVE_URL_PATTERN = /\/cdps\/chfm\/troves\/0x754$/;

// Same pinned weekday instant as dashboard-flows: the CDP fixtures'
// timestamps hang off this instant, so relative times stay deterministic.
const WEEKDAY_FIXTURE_INSTANT = new Date("2026-04-15T12:00:00Z");

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

function headerCard(page: Page) {
  return page.locator("header").filter({ hasText: "Manage in app" });
}

test.describe("trove history page", () => {
  let browserErrors: string[];

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: WEEKDAY_FIXTURE_INSTANT });
    browserErrors = trackUnexpectedBrowserErrors(page);
  });

  test.afterEach(() => {
    expect(browserErrors).toEqual([]);
  });

  test("renders header, ledger, queue, impact, and chart on a direct load", async ({
    page,
  }) => {
    await page.goto(CASE_TROVE_PATH);

    // Header card: identity plus non-empty collateral/debt/rate figures.
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toContainText("CHFm");
    await expect(heading).toContainText(`Trove ${CASE_TROVE_ID}`);
    await expect(heading).toContainText("Active");
    const header = headerCard(page);
    await expect(header.getByText("45,372.50 USDm")).toBeVisible();
    await expect(header.getByText("9,070.75 CHFm")).toBeVisible();
    await expect(header.getByText("1.60%", { exact: true })).toBeVisible();
    await expect(header.getByText("375.16%")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "← CHFm market" }),
    ).toBeVisible();

    // Complete ledger table: all eight recorded events with their badges,
    // plus the two client-side interest estimate rows the residuals imply
    // (+6.50 before the first redemption, +0.13 before the rate change).
    const ledgerTable = page.getByRole("table", { name: "Trove ledger" });
    await expect(ledgerTable).toBeVisible();
    await expect(
      ledgerTable.getByRole("columnheader", { name: "Δ Debt" }),
    ).toBeVisible();
    await expect(ledgerTable.locator("tbody tr")).toHaveCount(10);
    await expect(
      ledgerTable.getByText("Open Trove", { exact: true }),
    ).toBeVisible();
    await expect(
      ledgerTable.getByText("Rebalance Redemption", { exact: true }),
    ).toHaveCount(5);
    await expect(
      ledgerTable.getByText("Change Interest Rate", { exact: true }),
    ).toBeVisible();
    await expect(ledgerTable.getByText("→ 1.60%")).toBeVisible();
    await expect(
      ledgerTable.getByText("Adjust Trove", { exact: true }),
    ).toBeVisible();
    await expect(
      ledgerTable.getByText("Interest accrued", { exact: true }),
    ).toHaveCount(2);
    // Per-hit deltas and the chained tail snapshots.
    await expect(ledgerTable.getByText("-3,690.00 CHFm")).toHaveCount(5);
    await expect(ledgerTable.getByText("+2.50 USDm credited")).toHaveCount(5);
    await expect(ledgerTable.getByText("9,070.75 CHFm")).toBeVisible();
    await expect(ledgerTable.getByText("45,372.50 USDm")).toBeVisible();
    await expect(
      page.getByText(/client-side estimates between recorded snapshots/),
    ).toBeVisible();
    await expect(page.getByText(/history truncated/)).toHaveCount(0);

    // Redemption queue panel: rank, shield, and the three-rung ladder.
    await expect(
      page.getByRole("heading", { name: "Redemption queue" }),
    ).toBeVisible();
    await expect(
      page.getByText(/queue position #2 of 3 rate levels/),
    ).toBeVisible();
    await expect(
      page.getByText(
        "12,000.00 CHFm of recorded active debt at lower rates shields this trove.",
      ),
    ).toBeVisible();
    const ladder = page.getByRole("table", {
      name: "Redemption queue ladder",
    });
    await expect(
      ladder.getByRole("columnheader", { name: "Interest rate" }),
    ).toBeVisible();
    await expect(
      ladder.getByRole("columnheader", { name: "Debt at this rate" }),
    ).toBeVisible();
    await expect(
      ladder.getByRole("columnheader", { name: "Queue position" }),
    ).toBeVisible();
    await expect(ladder.locator("tbody tr")).toHaveCount(3);
    await expect(ladder.getByText("#2 · this trove")).toBeVisible();

    // Redemption impact panel: reconciled totals, the rebalance split, and
    // net equity at each hit's own oracle price.
    await expect(
      page.getByRole("heading", { name: "Redemption impact" }),
    ).toBeVisible();
    await expect(
      page.getByText(/reconciled to the trove's recorded cumulatives/),
    ).toBeVisible();
    await expect(page.getByText("all rebalancing")).toBeVisible();
    await expect(page.getByText("-18,450.00 CHFm")).toBeVisible();
    await expect(page.getByText("-24,582.50 USDm")).toBeVisible();
    await expect(page.getByText("+12.50 USDm")).toBeVisible();
    await expect(page.getByText("Net equity at oracle prices")).toBeVisible();
    await expect(page.getByText("+17.50 USDm")).toBeVisible();
    await expect(page.getByText("Ledger reconciliation failed")).toHaveCount(0);

    // Chart card mounts its plot once scrolled into view (deferred mount).
    await expect(
      page.getByRole("heading", { name: "Collateral & debt over time" }),
    ).toBeVisible();
    const figure = page.getByRole("figure", {
      name: "Collateral and debt over time chart, All range",
    });
    await expect(figure).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: "Trove chart time range" })
        .getByRole("button", { name: "All" }),
    ).toHaveAttribute("aria-pressed", "true");
    await figure.scrollIntoViewIfNeeded();
    await expect(
      figure.getByRole("group", {
        name: "Collateral and debt over time chart, All range",
      }),
    ).toBeVisible();
    await expect(figure.locator(".js-plotly-plot")).toBeVisible();
    await expect(
      page.getByText("Values are recorded as of each ledger event", {
        exact: false,
      }),
    ).toBeVisible();
  });

  test("enters the history page from the market trove table", async ({
    page,
  }) => {
    await page.goto("/cdps/chfm");

    await expect(
      page.getByRole("heading", { name: "CHFm CDP Market" }),
    ).toBeVisible();

    await page
      .getByRole("link", { name: `View history for trove ${CASE_TROVE_ID}` })
      .click();

    await expect(page).toHaveURL(CASE_TROVE_URL_PATTERN);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `Trove ${CASE_TROVE_ID}`,
    );
    await expect(
      page.getByRole("table", { name: "Trove ledger" }),
    ).toBeVisible();
  });

  test("finds troves by owner on /cdps and links to the history page", async ({
    page,
  }) => {
    await page.goto("/cdps");

    await expect(page.getByRole("heading", { name: "CDPs" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Find Troves by Owner" }),
    ).toBeVisible();

    await page.getByLabel("Find troves by owner address").fill(CASE_OWNER);

    await expect(page).toHaveURL(/owner=0xcca0a99b/);
    const results = page.getByRole("table", { name: "Troves by owner" });
    await expect(results).toBeVisible();
    const hitRow = results.locator("tbody tr").first();
    await expect(results.locator("tbody tr")).toHaveCount(1);
    await expect(hitRow).toContainText("CHFm");
    await expect(hitRow).toContainText("active");
    await expect(hitRow).toContainText("9,070.75 CHFm");
    await expect(hitRow).toContainText("45,372.50 USDm");

    await hitRow
      .getByRole("link", { name: `View history for trove ${CASE_TROVE_ID}` })
      .click();

    await expect(page).toHaveURL(CASE_TROVE_URL_PATTERN);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      `Trove ${CASE_TROVE_ID}`,
    );
    await expect(
      page.getByRole("heading", { name: "Redemption queue" }),
    ).toBeVisible();
  });
});

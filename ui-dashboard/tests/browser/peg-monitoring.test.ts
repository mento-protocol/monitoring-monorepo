import { expect, test } from "@playwright/test";
import {
  makePegMonitoringResponse,
  PEG_FIXTURE_CHAIN_ID,
  PEG_FIXTURE_POOL_ADDRESS,
  PEG_FIXTURE_PRODUCED_AT,
} from "../../src/test-utils/peg-monitoring-fixture";

const now = PEG_FIXTURE_PRODUCED_AT;
const poolId = `${PEG_FIXTURE_CHAIN_ID}-${PEG_FIXTURE_POOL_ADDRESS}`;
const initialPayload = makePegMonitoringResponse();
const initialPackage = initialPayload.packages[0]!;
/** A healthy primary-market price, so the board's default row is a clean one. */
const payload = {
  ...initialPayload,
  packages: [
    {
      ...initialPackage,
      sources: initialPackage.sources.map((source) =>
        source.id === initialPackage.policy.deepVenueSource
          ? { ...source, executablePrice: 0.999, deviationBps: 10 }
          : source,
      ),
    },
  ],
};

test("renders the status board, expands a row panel, and retains stale evidence", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now * 1000 + 20_000) });
  await page.setViewportSize({ width: 1440, height: 900 });
  let request = 0;
  let releaseFirstResponse!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  await page.route("**/api/peg-monitoring", async (route) => {
    request += 1;
    if (request === 1) {
      await firstResponseGate;
      await route.fulfill({ json: payload });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"offline"}',
    });
  });
  await page.goto("/peg-monitoring");

  await expect(
    page.locator('[aria-label="Loading peg monitoring"]'),
  ).toBeVisible();
  const skeletonBoard = page.getByTestId("peg-skeleton-board");
  await expect(skeletonBoard).toBeVisible();
  const skeletonBox = await skeletonBoard.boundingBox();
  releaseFirstResponse();

  const aggregate = page.getByTestId("peg-aggregate-status");
  await expect(aggregate).toBeVisible();
  await expect(aggregate).toHaveText("1 of 1 peg healthy");
  await expect(
    page.getByRole("heading", { name: "Peg Monitoring" }),
  ).toBeVisible();
  await expect(page.getByText("Checks every 30s")).toBeVisible();

  const row = page.getByTestId("peg-row-europ-schuman");
  await expect(row).toContainText("EUROP / EUR");
  await expect(row).toContainText("0.999");
  await expect(row).toContainText("10 bps below");
  await expect(row).toContainText("Bitvavo EUROP / EUR");
  await expect(row).toContainText("42%");
  await expect(row).toContainText("Ready");
  await expect(page.getByTestId("peg-status-europ-schuman")).toHaveText(
    "Healthy",
  );

  // The board keeps the loaded table the same shape as its skeleton.
  const boardBox = await page.getByTestId("peg-board").boundingBox();
  expect(skeletonBox).not.toBeNull();
  expect(boardBox).not.toBeNull();
  expect(Math.abs(skeletonBox!.height - boardBox!.height)).toBeLessThanOrEqual(
    64,
  );

  const venueLink = row.getByRole("link", { name: /Bitvavo EUROP \/ EUR/ });
  await expect(venueLink).toHaveAttribute(
    "href",
    "https://account.bitvavo.com/markets/EUROP-EUR",
  );
  await expect(venueLink).toHaveAttribute("rel", /noopener/);
  await expect(venueLink).toHaveAttribute("target", "_blank");

  // Clicking a link navigates instead of toggling the panel.
  const chevron = row.getByRole("button", { name: /Expand EUROP/ });
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await row.getByRole("link", { name: "Ready" }).click();
  await expect(page).toHaveURL(new RegExp(`/pool/${poolId}\\?tab=oracle`));
  await page.goBack();

  await expect(page.getByTestId("peg-panel-europ-schuman")).toHaveCount(0);
  await page
    .getByTestId("peg-row-europ-schuman")
    .getByText("EUROP / EUR", { exact: true })
    .click();
  const panel = page.getByTestId("peg-panel-europ-schuman");
  await expect(panel).toBeVisible();
  await expect(
    page.getByTestId("peg-row-europ-schuman").getByRole("button", {
      name: /Collapse EUROP/,
    }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toContainText("Supporting Markets");
  await expect(panel).toContainText("Peg History");
  await expect(panel).toContainText("History unavailable");
  await expect(
    panel.getByTestId("peg-supporting-source-kraken_eur"),
  ).toContainText("DEPTH ONLY");
  await expect(
    panel.getByTestId("peg-supporting-source-kraken_usd"),
  ).toContainText("DISPLAY ONLY");

  // Tooltips come from the design system and open on hover.
  await panel.getByRole("button", { name: "DEPTH ONLY" }).hover();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "can never set peg status" }),
  ).toBeVisible();

  const alerts = page.getByTestId("peg-recent-alerts");
  await expect(alerts).toContainText("Recent alerts");
  const grafanaLink = alerts.getByRole("link", {
    name: /Full history in Grafana/,
  });
  await expect(grafanaLink).toHaveAttribute(
    "href",
    "https://clabsmento.grafana.net/alerting/list?search=Peg",
  );
  await expect(grafanaLink).toHaveAttribute("rel", /noopener/);
  await expect(
    page.getByRole("link", { name: "Peg Monitoring", exact: true }),
  ).toBeVisible();

  await page.clock.runFor(80_000);
  await expect(aggregate).toContainText("latest data is stale");
  await expect(page.getByTestId("peg-row-europ-schuman")).toContainText(
    "· stale",
  );
  await expect(page.getByTestId("peg-panel-europ-schuman")).toContainText(
    "Showing the last confirmed check",
  );
});

test("keeps the board scrollable without pushing the page wider on mobile", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now * 1000 + 20_000) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/peg-monitoring", async (route) => {
    await route.fulfill({ json: payload });
  });
  await page.goto("/peg-monitoring");

  await expect(page.getByTestId("peg-row-europ-schuman")).toBeVisible();
  await page
    .getByTestId("peg-row-europ-schuman")
    .getByText("EUROP / EUR", { exact: true })
    .click();
  await expect(page.getByTestId("peg-panel-europ-schuman")).toBeVisible();

  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});

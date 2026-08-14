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
  let failRefreshes = false;
  let failedRefreshes = 0;
  let releaseFirstResponse!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  const historyRequests: Record<string, number> = {};
  const historyRequestEnds: Array<string | null> = [];
  await page.route("**/api/peg-monitoring", async (route) => {
    request += 1;
    if (request === 1) {
      await firstResponseGate;
      await route.fulfill({ json: payload });
      return;
    }
    if (!failRefreshes) {
      await route.fulfill({ json: payload });
      return;
    }
    failedRefreshes += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"offline"}',
    });
  });
  await page.route("**/api/peg-monitoring/history?*", async (route) => {
    expect(route.request().method()).toBe("POST");
    const url = new URL(route.request().url());
    const range = url.searchParams.get("range") ?? "7d";
    historyRequestEnds.push(url.searchParams.get("to"));
    historyRequests[range] = (historyRequests[range] ?? 0) + 1;
    const windowSeconds =
      range === "24h" ? 86_400 : range === "30d" ? 30 * 86_400 : 7 * 86_400;
    const stepSeconds = range === "24h" ? 300 : range === "30d" ? 7_200 : 1_800;
    await route.fulfill({
      json: {
        asset: "europ-schuman",
        source: "bitvavo_eur",
        policyVersion: payload.producedPolicyVersion,
        range,
        from: now - windowSeconds,
        to: now,
        stepSeconds,
        points: [
          { at: now - Math.min(windowSeconds, 3_600), bps: -4 },
          { at: now, bps: 1.5 },
        ],
      },
    });
  });
  await page.route("**/api/peg-monitoring/alerts", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      json: {
        from: now - 7 * 86_400,
        to: now,
        events: [
          {
            id: "europ-spread-cleared",
            at: now - 120,
            severity: "cleared",
            lead: "EUROP spread warning cleared",
            detail:
              "Bitvavo EUR · active policy returned to normal after 22 min.",
          },
        ],
      },
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
  await expect(
    panel.getByRole("img", { name: /Peg history over 7d: 2 readings/ }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "24h" }).click();
  await expect(
    panel.getByRole("img", { name: /Peg history over 24h: 2 readings/ }),
  ).toBeVisible();
  expect(historyRequests["24h"]).toBe(1);

  failRefreshes = true;
  await page.clock.runFor(30_000);
  await expect.poll(() => failedRefreshes).toBe(1);
  await expect(aggregate).toHaveText("1 of 1 peg healthy");
  await expect(aggregate).not.toContainText("latest data is stale");

  await page.clock.runFor(30_000);
  await expect.poll(() => failedRefreshes).toBeGreaterThanOrEqual(2);
  await expect(aggregate).toContainText("latest data is stale");
  await expect(page.getByTestId("peg-row-europ-schuman")).toContainText(
    "· stale",
  );
  await expect(page.getByTestId("peg-panel-europ-schuman")).toContainText(
    "Showing the last confirmed check",
  );

  await page.clock.runFor(300_000);
  await expect.poll(() => historyRequests["24h"]).toBeGreaterThan(1);
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
  await expect(alerts).toContainText("EUROP spread warning cleared");
  await expect(alerts).toContainText("normal after 22 min");
  const grafanaLink = alerts.getByRole("link", {
    name: /Full history in Grafana/,
  });
  await expect(grafanaLink).toHaveAttribute(
    "href",
    "https://clabsmento.grafana.net/alerting/history?var-LABELS_FILTER=service%3Dpeg-monitoring&from=now-7d&to=now&timezone=browser&var-STATE_FILTER_TO=Alerting",
  );
  await expect(grafanaLink).toHaveAttribute("rel", /noopener/);
  await expect(
    page.getByRole("link", { name: "Peg Monitoring", exact: true }),
  ).toBeVisible();

  await expect.poll(() => historyRequestEnds.at(-1)).toBe(String(now));
});

test("keeps the board scrollable without pushing the page wider on mobile", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now * 1000 + 20_000) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/peg-monitoring", async (route) => {
    await route.fulfill({ json: payload });
  });
  await page.route("**/api/peg-monitoring/history?*", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"history offline"}',
    });
  });
  await page.route("**/api/peg-monitoring/alerts", async (route) => {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: '{"error":"alert history offline"}',
    });
  });
  await page.goto("/peg-monitoring");

  await expect(page.getByTestId("peg-row-europ-schuman")).toBeVisible();
  await page
    .getByTestId("peg-row-europ-schuman")
    .getByText("EUROP / EUR", { exact: true })
    .click();
  await expect(page.getByTestId("peg-panel-europ-schuman")).toBeVisible();
  await expect(page.getByTestId("peg-panel-europ-schuman")).toContainText(
    "History unavailable",
  );
  await expect(page.getByTestId("peg-recent-alerts")).toContainText(
    "Recent alerts unavailable",
  );

  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});

test("refreshes the board when a hidden tab resumes", async ({ page }) => {
  await page.clock.install({ time: new Date(now * 1000 + 20_000) });
  await page.addInitScript(() => {
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    (
      window as Window & {
        __setPegTestVisibility?: (state: DocumentVisibilityState) => void;
      }
    ).__setPegTestVisibility = (state) => {
      visibilityState = state;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  let boardRequests = 0;
  const resumedAt = now + 120;
  const resumedPayload = {
    ...payload,
    producedAt: resumedAt,
    packages: payload.packages.map((item) => ({
      ...item,
      monitors: item.monitors.map((monitor) => ({
        ...monitor,
        breaker:
          monitor.breaker === null
            ? null
            : {
                ...monitor.breaker,
                lastUpdatedAt:
                  monitor.breaker.lastUpdatedAt === null
                    ? null
                    : monitor.breaker.lastUpdatedAt + 120,
                lastStatusUpdatedAt: monitor.breaker.lastStatusUpdatedAt + 120,
              },
      })),
      sources: item.sources.map((source) => ({
        ...source,
        observationAt:
          source.observationAt === null ? null : source.observationAt + 120,
        fetchedAt: source.fetchedAt === null ? null : source.fetchedAt + 120,
        lastTradeAt:
          source.lastTradeAt === null ? null : source.lastTradeAt + 120,
      })),
    })),
  };
  await page.route("**/api/peg-monitoring", async (route) => {
    boardRequests += 1;
    await route.fulfill({
      json: boardRequests === 1 ? payload : resumedPayload,
    });
  });
  await page.route("**/api/peg-monitoring/alerts", async (route) => {
    await route.fulfill({
      json: { from: now - 7 * 86_400, to: now, events: [] },
    });
  });
  await page.goto("/peg-monitoring");

  const aggregate = page.getByTestId("peg-aggregate-status");
  await expect(aggregate).toHaveText("1 of 1 peg healthy");
  expect(boardRequests).toBe(1);

  await page.evaluate(() => {
    (
      window as Window & {
        __setPegTestVisibility?: (state: DocumentVisibilityState) => void;
      }
    ).__setPegTestVisibility?.("hidden");
  });
  await page.clock.runFor(100_000);
  expect(boardRequests).toBe(1);

  await page.evaluate(() => {
    (
      window as Window & {
        __setPegTestVisibility?: (state: DocumentVisibilityState) => void;
      }
    ).__setPegTestVisibility?.("visible");
  });
  await page.clock.runFor(1);
  await expect.poll(() => boardRequests).toBe(2);
  await expect(aggregate).toHaveText("1 of 1 peg healthy");
  await expect(aggregate).not.toContainText("latest data is stale");
});

import { expect, test } from "@playwright/test";
import {
  makePegMonitoringResponse,
  PEG_FIXTURE_PRODUCED_AT,
} from "../../src/test-utils/peg-monitoring-fixture";

const now = PEG_FIXTURE_PRODUCED_AT;
const initialPayload = makePegMonitoringResponse();
const initialPackage = initialPayload.packages[0]!;
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

test("shows a decision scorecard, keeps evidence on demand, and retains stale evidence", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now * 1000 + 20_000) });
  await page.setViewportSize({ width: 1280, height: 900 });
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
  const loadingHeadlines = page.getByTestId("peg-skeleton-headlines");
  const loadingScorecard = page.getByTestId("peg-skeleton-scorecard");
  await expect(loadingHeadlines).toBeVisible();
  const [loadingHeadlineBox, loadingScorecardBox] = await Promise.all([
    loadingHeadlines.boundingBox(),
    loadingScorecard.boundingBox(),
  ]);
  releaseFirstResponse();

  const aggregate = page.getByTestId("peg-aggregate-status");
  await expect(aggregate).toBeVisible();
  await expect(aggregate).toHaveText("All pegs healthy");
  await expect(aggregate.locator("*")).toHaveCount(0);
  await expect(page.getByText("Nearest warning")).toBeVisible();
  await expect(page.getByText("Furthest from target")).toHaveCount(0);
  await expect(page.getByText("Data freshness")).toBeVisible();
  await expect(
    page.getByTestId("peg-headline-cards").getByText("Fresh", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("3 of 3 sources usable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("peg-target-europ-schuman")).toHaveAttribute(
    "style",
    /left: 50%/,
  );
  const currentMarker = page.getByTestId("peg-current-europ-schuman");
  const targetMarker = page.getByTestId("peg-target-europ-schuman");
  const [currentMarkerBox, targetMarkerBox] = await Promise.all([
    currentMarker.boundingBox(),
    targetMarker.boundingBox(),
  ]);
  expect(currentMarkerBox).not.toBeNull();
  expect(targetMarkerBox).not.toBeNull();
  expect(currentMarkerBox!.x).toBeLessThan(targetMarkerBox!.x);
  const [loadedHeadlineBox, loadedScorecardBox] = await Promise.all([
    page.getByTestId("peg-headline-cards").boundingBox(),
    page.getByTestId("peg-scorecard-europ-schuman").boundingBox(),
  ]);
  expect(loadingHeadlineBox).not.toBeNull();
  expect(loadingScorecardBox).not.toBeNull();
  expect(loadedHeadlineBox).not.toBeNull();
  expect(loadedScorecardBox).not.toBeNull();
  if (
    loadingHeadlineBox === null ||
    loadingScorecardBox === null ||
    loadedHeadlineBox === null ||
    loadedScorecardBox === null
  )
    throw new Error("Peg skeleton or loaded scorecard geometry is unavailable");
  expect(
    Math.abs(loadingHeadlineBox.height - loadedHeadlineBox.height),
  ).toBeLessThanOrEqual(48);
  expect(
    Math.abs(loadingScorecardBox.height - loadedScorecardBox.height),
  ).toBeLessThanOrEqual(64);

  const evidence = page.getByTestId("peg-evidence-policy");
  await expect(evidence).not.toHaveAttribute("open", "");
  await evidence
    .getByText("How this status was checked", { exact: true })
    .click();
  await expect(evidence).toHaveAttribute("open", "");
  await expect(
    page.getByText("A 50,000 EUROP sale would get about 0.999 EUR per EUROP.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Price: For the main market, at least 80% of usable full-size prices in the last 10 minutes must be 0.25% (25 bps) below target or 0.25% (25 bps) above target. Approved secondary markets are checked separately at their own limits.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Loss of a usable price: A page can fire sooner, without waiting for the full price window (20 minutes), when 10 scheduled main-market checks produce no new usable full-size price and fresh data also shows high pool inflow, an unusually wide spread, or a partial-sale price beyond the critical price-drop limit.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Critical alerts: Splunk On-Call and @support-engineer in #alerts-critical after 30 seconds.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Net pool inflow is at 42% of the active on-chain trading limit. Warn at 80%.",
      { exact: true },
    ),
  ).toBeVisible();

  const otherMarkets = page.getByTestId("peg-other-markets-europ-schuman");
  const technicalRecord = page.getByTestId("peg-technical-record");
  await expect(otherMarkets).not.toHaveAttribute("open", "");
  await expect(technicalRecord).not.toHaveAttribute("open", "");
  await otherMarkets.getByText("Other market checks (2)").click();
  await expect(
    otherMarkets.getByText(
      "These markets do not set the peg status shown above. Some can send a market warning. Their health or listing can send a monitoring warning.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Converted from USD to EUR using rate feed 0xec5748…c318ca on chain 137.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Price conversion:", { exact: false }),
  ).not.toBeVisible();
  await technicalRecord
    .getByText("Technical details for investigation", { exact: true })
    .click();
  await expect(
    page.getByText(
      "Price conversion: USD → EUR via feed 0xec5748…c318ca · chain 137",
    ),
  ).toBeVisible();

  const grafanaLink = page.getByRole("link", {
    name: /View alert rules and history/,
  });
  await expect(grafanaLink).toHaveAttribute(
    "href",
    "https://clabsmento.grafana.net/alerting/list?search=Peg",
  );
  await expect(grafanaLink).toHaveAttribute("rel", /noopener/);
  await expect(
    page.getByRole("link", { name: "Peg monitoring", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(30_000);
  await expect(aggregate).toContainText("Latest data is stale");
  await expect(aggregate).toContainText(
    "No fresh monitoring package has arrived",
  );
  await expect(aggregate).not.toContainText(/\b\d+[smh] old/);
  await expect(page.getByTestId("peg-aggregate-age")).toContainText(
    /Last confirmed package \d+[smh] old/,
  );
  await expect(
    page.getByText("Last confirmed conclusion", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Data is stale — showing the last confirmed check"),
  ).toBeVisible();
  await expect(
    page.getByText(/^Last confirmed package \d+[smh] ago$/),
  ).toBeVisible();
});

test("keeps the evidence hierarchy progressive and overflow-free on mobile", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now * 1000 + 20_000) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/peg-monitoring", async (route) => {
    await route.fulfill({ json: payload });
  });
  await page.goto("/peg-monitoring");

  const evidence = page.getByTestId("peg-evidence-policy");
  await evidence
    .getByText("How this status was checked", { exact: true })
    .click();
  await expect(
    page.getByText("This is the main market checked to set the status above.", {
      exact: true,
    }),
  ).toBeVisible();
  const otherMarkets = page.getByTestId("peg-other-markets-europ-schuman");
  const technicalRecord = page.getByTestId("peg-technical-record");
  await expect(otherMarkets).not.toHaveAttribute("open", "");
  await expect(technicalRecord).not.toHaveAttribute("open", "");
  await expect(page.getByText("Schema", { exact: true })).not.toBeVisible();

  await otherMarkets.getByText("Other market checks (2)").click();
  await expect(
    page.getByText(
      "Converted from USD to EUR using rate feed 0xec5748…c318ca on chain 137.",
    ),
  ).toBeVisible();
  await technicalRecord
    .getByText("Technical details for investigation", { exact: true })
    .click();
  await expect(page.getByText("Schema", { exact: true })).toBeVisible();

  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});

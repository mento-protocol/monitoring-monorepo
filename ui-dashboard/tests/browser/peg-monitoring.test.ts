import { expect, test } from "@playwright/test";

const now = 1_800_000_000;
const payload = {
  schemaVersion: 1,
  approvedActivePolicyVersion: "peg-policy-2026-07-01",
  producedPolicyVersion: "peg-policy-2026-07-01",
  policySlot: "active",
  producedAt: now,
  rolloverAckExpectedSeconds: 300,
  packages: [
    {
      asset: "europ-schuman",
      peg: "EUR",
      coverageClass: "cex-book+indexed-pool",
      tokenRefs: [
        {
          chainId: 42220,
          address: "0x3333333333333333333333333333333333333333",
        },
      ],
      policy: {
        target: 1,
        warnDeviationBps: 75,
        criticalDeviationBps: 150,
        premiumWarnBps: 100,
        warnSustainSeconds: 600,
        criticalSustainSeconds: 1200,
        durationQuantile: 0.75,
        minimumCoverageFraction: 0.8,
        blindConsecutivePolls: 3,
        permanentlyDeadSeconds: 259200,
        structuralWarnFraction: 0.75,
        freshnessGraceSeconds: 90,
        deepVenueSource: "kraken_eur",
      },
      structural: {
        blind: false,
        blindConsecutivePolls: 0,
        structuralSaturation: 0.42,
        structuralQuerySaturated: false,
        indexedPoolReachable: true,
        counterpartyCount: 7,
      },
      monitors: [
        {
          chainId: 42220,
          poolAddress: "0x1111111111111111111111111111111111111111",
          rateFeedId: "0x2222222222222222222222222222222222222222",
          monitoredTokenAddress: "0x3333333333333333333333333333333333333333",
          indexedPoolReachable: true,
          structuralSaturation: 0.42,
          structuralQuerySaturated: false,
          counterpartyCount: 7,
          breaker: null,
        },
      ],
      sources: [
        {
          id: "kraken_eur",
          provider: "kraken",
          pair: "EUROP/EUR",
          baseCurrency: "EUROP",
          quoteCurrency: "EUR",
          registryRole: "primary",
          authority: "deep",
          convertVia: null,
          policy: {
            referenceSizeCap: 1000000,
            pollIntervalSeconds: 30,
            staleAfterSeconds: 90,
            spreadEnvelopeBps: 50,
            conversionErrorBps: 0,
          },
          listingState: "listed",
          listingCheckedAt: now - 5,
          healthy: true,
          venueState: "ok",
          observationAt: now - 5,
          fetchedAt: now - 4,
          lastTradeAt: now - 12,
          executablePrice: 0.9965,
          filledFraction: 1,
          capped: false,
          referenceSize: 250000,
          bid: 0.996,
          ask: 0.997,
          spreadBps: 10.04,
          deviationBps: 35,
          premiumBps: 0,
        },
      ],
    },
  ],
};

test("intercepts peg monitoring, retains stale evidence, and keeps loading geometry", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now * 1000 + 20_000) });
  await page.setViewportSize({ width: 1280, height: 900 });
  let request = 0;
  await page.route("**/api/peg-monitoring", async (route) => {
    request += 1;
    if (request === 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
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
  const skeleton = page.locator('[aria-label="Loading peg monitoring"]');
  await expect(skeleton).toBeVisible();
  const skeletonRects = await Promise.all([
    page.getByTestId("peg-skeleton-status").boundingBox(),
    page.getByTestId("peg-skeleton-snapshot").boundingBox(),
    page.getByTestId("peg-skeleton-package").boundingBox(),
  ]);
  await expect(page.getByText(/^Current package ·/)).toBeVisible();
  const loadedRects = await Promise.all([
    page.getByTestId("peg-status").boundingBox(),
    page.getByTestId("peg-snapshot").boundingBox(),
    page.getByTestId("peg-package-0").boundingBox(),
  ]);
  for (const [skeletonRect, loadedRect] of skeletonRects.map(
    (rect, index) => [rect, loadedRects[index]] as const,
  )) {
    expect(skeletonRect).not.toBeNull();
    expect(loadedRect).not.toBeNull();
    expect(Math.abs(skeletonRect!.x - loadedRect!.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(skeletonRect!.width - loadedRect!.width),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(skeletonRect!.y - loadedRect!.y)).toBeLessThanOrEqual(48);
    expect(
      Math.abs(skeletonRect!.height - loadedRect!.height),
    ).toBeLessThanOrEqual(320);
  }
  await expect(
    page.getByRole("link", { name: /Open Peg Monitoring/ }),
  ).toHaveAttribute("rel", /noopener/);
  await expect(
    page.getByRole("link", { name: "Peg monitoring", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(30_000);
  await expect(page.getByText("Stale — last confirmed package.")).toBeVisible();
});

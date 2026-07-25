import { expect, test } from "@playwright/test";
import {
  makePegMonitoringResponse,
  PEG_FIXTURE_PRODUCED_AT,
} from "../../src/test-utils/peg-monitoring-fixture";

const now = PEG_FIXTURE_PRODUCED_AT;
const payload = makePegMonitoringResponse();

test("intercepts peg monitoring, retains stale evidence, and keeps regional loading geometry", async ({
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
  const regions = [
    ["status", "peg-skeleton-status", "peg-status", 8],
    ["snapshot", "peg-skeleton-snapshot", "peg-snapshot", 12],
    [
      "package header",
      "peg-skeleton-package-header",
      "peg-package-0-header",
      8,
    ],
    [
      "structural evidence",
      "peg-skeleton-structural",
      "peg-package-0-structural",
      12,
    ],
    ["policy context", "peg-skeleton-policy", "peg-package-0-policy", 16],
    [
      "pool and breaker evidence",
      "peg-skeleton-monitors",
      "peg-package-0-monitors",
      16,
    ],
    [
      "market-source evidence",
      "peg-skeleton-sources",
      "peg-package-0-sources",
      16,
    ],
  ] as const;
  const skeletonRects = await Promise.all(
    regions.map(([, skeletonTestId]) =>
      page.getByTestId(skeletonTestId).boundingBox(),
    ),
  );
  await expect(page.getByText(/^Current package ·/)).toBeVisible();
  const convertedSource = payload.packages[0]?.sources.find(
    ({ convertVia }) => convertVia !== null,
  );
  expect(convertedSource?.convertVia).not.toBeNull();
  await expect(
    page.getByText(
      "Price conversion: USD → EUR via feed 0xec5748…c318ca · chain 137",
    ),
  ).toBeVisible();
  await expect(page.getByText("Complete within page limit")).toBeVisible();
  const loadedRects = await Promise.all(
    regions.map(([, , loadedTestId]) =>
      page.getByTestId(loadedTestId).boundingBox(),
    ),
  );
  for (const [index, [name, , , verticalTolerance]] of regions.entries()) {
    const skeletonRect = skeletonRects[index];
    const loadedRect = loadedRects[index];
    expect(skeletonRect).not.toBeNull();
    expect(loadedRect).not.toBeNull();
    expect(
      Math.abs(skeletonRect!.x - loadedRect!.x),
      `${name} has a different left edge`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(skeletonRect!.width - loadedRect!.width),
      `${name} has a different width`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(skeletonRect!.y - loadedRect!.y),
      `${name} moved more than its text-height allowance`,
    ).toBeLessThanOrEqual(verticalTolerance);
    expect(
      Math.abs(skeletonRect!.height - loadedRect!.height),
      `${name} changed more than its text-height allowance`,
    ).toBeLessThanOrEqual(verticalTolerance);
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

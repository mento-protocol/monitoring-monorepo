import { expect, test, type Page } from "@playwright/test";

const POOL_ID = "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
const NOW = Math.floor(new Date("2026-09-30T09:00:00Z").getTime() / 1000);
const HISTORY = Array.from({ length: 1205 }, (_, i) => ({
  id: `42220_${i + 1}_0`,
  chainId: 42220,
  blockNumber: String(i + 1),
  blockTimestamp: String(NOW - (1204 - i) * 600),
  reserve0: String((1000 + (i % 20)) * 10 ** 18),
  reserve1: String((2000 - (i % 20)) * 10 ** 6),
  txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
}));

async function mockReserveData(page: Page, failHistory = false) {
  const requests: Record<string, unknown>[] = [];
  await page.clock.setFixedTime(new Date(NOW * 1000));
  await page.route("**/graphql", async (route) => {
    const { query, variables } = route.request().postDataJSON();
    if (query.includes("query PoolReserveHistory(")) {
      requests.push(variables);
      if (failHistory) {
        await route.fulfill({
          status: 503,
          json: { errors: [{ message: "History unavailable" }] },
        });
        return;
      }
      const rows = HISTORY.filter(
        (row) =>
          Number(row.blockTimestamp) >= Number(variables.from) &&
          Number(row.blockTimestamp) <= Number(variables.to) &&
          Number(row.blockNumber) > Number(variables.afterBlock),
      ).slice(0, Number(variables.limit));
      await route.fulfill({ json: { data: { ReserveUpdate: rows } } });
    } else if (query.includes("query PoolReserves(")) {
      await route.fulfill({
        json: {
          data: {
            ReserveUpdate: [...HISTORY]
              .reverse()
              .slice(0, Number(variables.limit)),
          },
        },
      });
    } else {
      await route.continue();
    }
  });
  return requests;
}

test("reserve ranges load their own history beyond 1,000 events and ignore table size", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("Failed to load resource")
    )
      errors.push(message.text());
  });
  const requests = await mockReserveData(page);
  await page.goto(`/pool/${POOL_ID}?tab=reserves`);
  const ranges = page.getByRole("group", {
    name: "Reserve history time range",
  });
  await expect(
    ranges.getByRole("button", { name: "1d", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("145 snapshots plotted.", { exact: false }),
  ).toHaveCount(2);
  await expect(
    page
      .getByRole("figure", { name: /Reserve history chart/ })
      .locator(".js-plotly-plot"),
  ).toBeVisible();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(26);
  const rowsControl = page.getByLabel("Rows per page");
  const searchInput = page.getByRole("searchbox", { name: "Search reserves" });
  const chart = page.getByRole("figure", { name: /Reserve history chart/ });
  const controlBox = await rowsControl.boundingBox();
  const searchBox = await searchInput.boundingBox();
  const chartBox = await chart.boundingBox();
  expect(controlBox!.y).toBeGreaterThan(chartBox!.y + chartBox!.height);
  expect(Math.abs(controlBox!.y - searchBox!.y)).toBeLessThan(12);

  await ranges.getByRole("button", { name: "All", exact: true }).click();
  await expect(
    page.getByText("1205 snapshots plotted.", { exact: false }),
  ).toHaveCount(2);
  expect(requests.filter((v) => v.from === 0)).toHaveLength(2);
  expect(requests.at(-1)?.afterBlock).toBe("1000");
  const historyRequestCount = requests.length;
  await page.getByLabel("Rows per page").selectOption("100");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(101);
  await expect(
    page.getByText("1205 snapshots plotted.", { exact: false }),
  ).toHaveCount(2);
  expect(requests).toHaveLength(historyRequestCount);
  await page
    .getByRole("heading", { name: "Reserve History", exact: true })
    .locator("..")
    .locator("..")
    .screenshot({
      path: testInfo.outputPath("reserve-history-all.png"),
    });

  await ranges.getByRole("button", { name: "1h", exact: true }).click();
  await expect(
    page.getByText("7 snapshots plotted.", { exact: false }),
  ).toHaveCount(2);
  expect(Number(requests.at(-1)?.to) - Number(requests.at(-1)?.from)).toBe(
    3600,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(ranges).toBeVisible();
  await expect(page.getByLabel("Rows per page")).toBeVisible();
  await page.getByLabel("Rows per page").selectOption("10");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(11);
  await expect(
    page
      .getByRole("figure", { name: /Reserve history chart/ })
      .locator(".js-plotly-plot"),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("reserve history failure keeps range controls and the transaction table usable", async ({
  page,
}) => {
  await mockReserveData(page, true);
  await page.goto(`/pool/${POOL_ID}?tab=reserves`);
  await expect(
    page.getByRole("alert").filter({ hasText: "Reserve history unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(26);
  await expect(
    page
      .getByRole("group", { name: "Reserve history time range" })
      .getByRole("button", { name: "All", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Rows per page").selectOption("10");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(11);
});

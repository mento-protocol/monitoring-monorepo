#!/usr/bin/env node
// Measure Interaction-to-Next-Paint (INP) across multiple high-churn
// dashboard surfaces and fail closed on any regression beyond INP_BUDGET_MS.
//
// Each surface runs in its own fresh chromium context so web-vitals state
// can't leak between interactions: navigate cold → inject web-vitals →
// drive the scripted interaction(s) → wait for the PerformanceObserver to
// settle → flush via visibilitychange → read `window.__inp`. Every
// recorded INP is asserted against INP_BUDGET_MS independently; the
// script aggregates per-surface results and exits non-zero if any one
// exceeds the budget.
//
// Why not Lighthouse user-flow:
//   Lighthouse's timespan mode estimates INP from main-thread timing in a
//   lab profile; web-vitals uses the same PerformanceEventTiming + Event
//   Timing API the browser surfaces to real users via RUM. The numbers
//   are directly comparable to the INP a real user would see, which is
//   what the CWV gate cares about. The Playwright+web-vitals path also
//   reuses the @playwright/test chromium the dashboard already installs
//   for browser tests — no new puppeteer / chrome-launcher / lighthouse
//   deps in the workspace.
//
// Required env:
//   PREVIEW_URL          — Vercel preview URL (no trailing slash)
//   BYPASS_HEADERS_JSON  — JSON object with both bypass headers
//                          (`x-vercel-protection-bypass` + `x-vercel-set-bypass-cookie`).
//                          Built by the workflow shell from BYPASS_SECRET so the raw
//                          secret never reaches PR-controlled Node code — matches the
//                          lhci step's `unset BYPASS_SECRET` pattern.
//   INP_BUDGET_MS        — optional, default 200 (web-vitals "good" threshold).
//
// Exit codes:
//   0 — every surface's INP ≤ budget.
//   1 — any surface exceeds the budget, captures no measurement, lands
//       on the SSO interstitial, or otherwise fails. Fail-closed: a
//       silently absent metric means the gate isn't validating anything,
//       so the workflow should fail loudly rather than green-light an
//       unverifiable run.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PREVIEW_URL = process.env.PREVIEW_URL;
const BYPASS_HEADERS_JSON = process.env.BYPASS_HEADERS_JSON;
const INP_BUDGET_MS = Number(process.env.INP_BUDGET_MS ?? 200);

if (!PREVIEW_URL || !BYPASS_HEADERS_JSON) {
  console.error(
    "::error::PREVIEW_URL and BYPASS_HEADERS_JSON env vars required",
  );
  process.exit(1);
}

let bypassHeaders;
try {
  bypassHeaders = JSON.parse(BYPASS_HEADERS_JSON);
} catch (err) {
  console.error(
    `::error::BYPASS_HEADERS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

if (!Number.isFinite(INP_BUDGET_MS) || INP_BUDGET_MS <= 0) {
  console.error(
    `::error::INP_BUDGET_MS must be a positive number; got ${process.env.INP_BUDGET_MS}`,
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const webVitalsIife = resolve(
  here,
  "..",
  "node_modules",
  "web-vitals",
  "dist",
  "web-vitals.iife.js",
);

// How long to wait for a surface's readiness anchor before failing. Most
// surfaces settle in well under this. `/volume` overrides it (see below):
// it fires the heaviest query waterfall on the page (top-traders +
// aggregator + broker + pools snapshots, then client-side re-aggregation),
// and on a cold preview deployment hit by a contended CI runner the sorted
// "Volume" header can take longer than the default to render. A warm-backend
// readiness ceiling measured at 20× CPU + Slow 4G is ~12s, so the override
// leaves headroom for preview cold-start latency without masking a genuine
// hang (a true stall still trips the override and fails closed). Issue #775.
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const VOLUME_READY_TIMEOUT_MS = 45_000;

// One surface = one navigation + interaction sequence + INP read. Each
// runs in a fresh chromium context so prior interactions can't pollute
// the next surface's `onINP` observer.
const SURFACES = [
  {
    name: "pools-filter",
    path: "/pools",
    readySelector:
      'input[aria-label="Filter swaps by pool ID or pool address"]',
    async interact(page) {
      const filterInput =
        'input[aria-label="Filter swaps by pool ID or pool address"]';
      await page.click(filterInput);
      // `pressSequentially()` sends real keydown/keyup events. `page.fill()`
      // would fire only a synthetic `input` event, which wouldn't surface
      // per-keystroke latency to web-vitals.
      await page
        .locator(filterInput)
        .pressSequentially("0x0000000000000000000000000000000000000000", {
          delay: 20,
        });
      await page.click('button:has-text("Apply")');
    },
  },
  {
    name: "volume-time-window",
    path: "/volume",
    // Wait for actual volume rows to render — NOT just the time-window
    // group itself, which mounts in the page header before any SWR data is
    // loaded. If we click while the tables are still empty/loading, the
    // measured INP only covers the cheap `window.history.replaceState`
    // URL-state update over empty arrays, missing the expensive
    // re-aggregation/re-render that this gate is meant to protect. The
    // Volume `SortableTh` only mounts once the table has columns, so it's
    // a reliable "rows have loaded" anchor.
    readySelector: 'th[aria-sort] button:has-text("Volume")',
    readyTimeout: VOLUME_READY_TIMEOUT_MS,
    async interact(page) {
      // The volume page ships with one window active by default; clicking
      // a sibling triggers a `window.history.replaceState`-backed re-render
      // via `updateRange` (see `_lib/url-state.ts` — `router.replace` was
      // deliberately avoided here because it measured ~700 ms on the
      // homepage in PR #314). The click is a qualifying Event-Timing
      // interaction. We pick an explicit alternative window so the click
      // flips state even when the default changes.
      const buttons = page.locator(
        '[role="group"][aria-label="Time window"] button',
      );
      const count = await buttons.count();
      if (count < 2) {
        throw new Error(
          `volume time-window group has ${count} button(s); expected at least 2`,
        );
      }
      // Find an inactive button (`aria-pressed="false"`) and click it.
      for (let i = 0; i < count; i += 1) {
        const btn = buttons.nth(i);
        const pressed = await btn.getAttribute("aria-pressed");
        if (pressed === "false") {
          await btn.click();
          return;
        }
      }
      throw new Error(
        "volume time-window group has no inactive button to click",
      );
    },
  },
  {
    name: "volume-sort",
    path: "/volume",
    // The `SortableTh` from `ui-dashboard/src/components/sortable-th.tsx`
    // renders a `<th scope="col" aria-sort>` containing a `<button>` —
    // we drive sort by clicking that button. `/volume` mounts two
    // tables that each have a Volume column (the top-traders
    // `VolumeTable` and the `AggregatorBreakdownSection`), so the
    // selector is anchored to whichever one renders first in document
    // order via `.first()` — both produce an equivalent INP signal for
    // gate purposes, and Playwright's strict-mode locator would
    // otherwise throw on the multi-match.
    readySelector: 'th[aria-sort] button:has-text("Volume")',
    readyTimeout: VOLUME_READY_TIMEOUT_MS,
    async interact(page) {
      // Click the Volume column header to toggle sort. The
      // `useTableSort` hook re-derives the sorted list on each click, so
      // every click is a qualifying interaction that produces an Event-
      // Timing entry.
      const volume = page
        .locator('th[aria-sort] button:has-text("Volume")')
        .first();
      await volume.click();
      // Click again to flip direction (ascending ↔ descending). Each
      // click is independently observed by web-vitals; with
      // `reportAllChanges`, the worst INP across both updates `window.__inp`.
      await volume.click();
    },
  },
  {
    name: "pool-detail-tvl-range",
    // Canonical Celo USDC/USDm Mento pool — verified stable on prod
    // (`/pool/42220-0x462f…aaa19e` renders as "USDC/USDm on Celo"). The
    // same fully-qualified ID powers `ui-dashboard/tests/browser/*` and
    // the fixture server. Mento v2 exchange contracts are immutable, so
    // hardcoding is safe; if the pool is ever retired the surface will
    // fail fast on the readySelector and the gate will surface it.
    path: "/pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
    // Anchor readiness on the actual Plotly plot inside the TVL card —
    // NOT on the range buttons alone. The `TimeSeriesChartCard`
    // (`components/time-series-chart-card.tsx:465-493`) renders its range
    // `<div role="group">` OUTSIDE the `isLoading` branch, so the buttons
    // are visible while `PlotSkeleton` is still rendered. Clicking before
    // Plotly mounts would measure a cheap `useState<RangeKey>` flip over
    // an empty/filtered-empty series instead of the
    // `filterSeriesByRange` + Plotly re-render this gate is meant to
    // protect. The CSS `section:has(range-group):has(.js-plotly-plot)`
    // anchor only matches once both have rendered in the same TVL card —
    // `.js-plotly-plot` is `react-plotly.js`'s root class, added by the
    // Plotly library once `Plotly.newPlot()` completes.
    readySelector:
      'section:has([role="group"][aria-label="Pool TVL chart time range"]):has(.js-plotly-plot)',
    async interact(page) {
      // The chart's default range is "all"; clicking a sibling range
      // (1D / 7D / 30D / 90D) flips `useState<RangeKey>` and triggers a
      // `filterSeriesByRange` recompute + a Plotly re-render — both
      // qualifying interactions. We pick an explicit inactive button so
      // the click flips state even if the default range ever changes.
      const buttons = page.locator(
        '[role="group"][aria-label="Pool TVL chart time range"] button',
      );
      const count = await buttons.count();
      if (count < 2) {
        throw new Error(
          `pool TVL range group has ${count} button(s); expected at least 2`,
        );
      }
      for (let i = 0; i < count; i += 1) {
        const btn = buttons.nth(i);
        const pressed = await btn.getAttribute("aria-pressed");
        if (pressed === "false") {
          await btn.click();
          return;
        }
      }
      throw new Error("pool TVL range group has no inactive button to click");
    },
  },
];

async function measureSurface(browser, surface) {
  // Each surface gets a fresh context so `onINP` state from a previous
  // surface can't leak in. `bypassCSP: true` is required because the
  // dashboard ships a nonce-based CSP — `page.addScriptTag({ path })`
  // injects an un-nonced inline `<script>` that Chromium would otherwise
  // block, leaving `window.webVitals` undefined.
  const context = await browser.newContext({
    bypassCSP: true,
    extraHTTPHeaders: bypassHeaders,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${PREVIEW_URL}${surface.path}`, {
      waitUntil: "load",
      timeout: 30_000,
    });

    // Sanity-check we landed on the dashboard, not the Vercel SSO
    // interstitial. Mirrors the audited-page guard in
    // `.github/workflows/lighthouse.yml` so a bypass regression fails
    // this step too, not just the lhci accessibility assertion.
    const landedUrl = page.url();
    if (landedUrl.includes("vercel.com/login")) {
      throw new Error(
        `Landed on Vercel SSO interstitial (${landedUrl}) — deployment-protection bypass likely regressed.`,
      );
    }

    await page.addScriptTag({ path: webVitalsIife });

    await page.evaluate(() => {
      window.__inp = null;
      // `reportAllChanges: true` makes onINP fire every time the
      // worst-observed INP value updates, not just once on
      // visibility-change. Without it, a `PerformanceEventTiming` entry
      // that arrives at the observer AFTER the visibility-change handler
      // runs is silently dropped.
      window.webVitals.onINP(
        (metric) => {
          window.__inp = metric.value;
        },
        { reportAllChanges: true },
      );
    });

    const readyTimeout = surface.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS;
    try {
      await page.waitForSelector(surface.readySelector, {
        timeout: readyTimeout,
      });
    } catch (err) {
      // The bare "Timeout 20000ms exceeded" can't tell slow-render from
      // empty/error data — both look identical and each needs a different
      // fix. Classify the terminal state the page actually settled into so
      // the next failure self-diagnoses instead of forcing a re-investigation
      // (#775). Loading skeleton still up → slow data fetch/render; ErrorBox
      // → the indexer's GraphQL endpoint is erroring; EmptyBox → the window
      // legitimately has no rows. Still fails closed regardless.
      const diag = await page.evaluate(() => ({
        loading: !!document.querySelector(
          '[role="status"][aria-label="Loading"]',
        ),
        error: !!document.querySelector('[role="alert"]'),
        empty:
          /no traders (matched|left)|no v[23] aggregator (activity|volume)/i.test(
            document.body.innerText,
          ),
      }));
      const cause = diag.error
        ? "data backend erroring (ErrorBox / role=alert present)"
        : diag.loading
          ? "still loading after timeout (slow data fetch/render — likely preview cold-start)"
          : diag.empty
            ? "no data (EmptyBox present — window legitimately empty)"
            : "unknown (no loading/error/empty marker found)";
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${msg} — terminal state: ${cause}`);
    }
    await surface.interact(page);

    // Settle window: let the browser paint and deliver every
    // `PerformanceEventTiming` entry to the observer before we flush.
    await page.waitForTimeout(1_500);

    // Flush via visibility-change in addition to the per-update
    // `reportAllChanges` callbacks. Belt-and-suspenders.
    await page.evaluate(() =>
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      }),
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await page
      .waitForFunction(() => window.__inp !== null, { timeout: 5_000 })
      .catch(() => {});

    const inp = await page.evaluate(() => window.__inp);
    return { name: surface.name, path: surface.path, inp };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
const results = [];
let exitCode = 0;
try {
  for (const surface of SURFACES) {
    try {
      const result = await measureSurface(browser, surface);
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `::error::INP measurement failed for ${surface.name} (${surface.path}): ${msg}`,
      );
      results.push({
        name: surface.name,
        path: surface.path,
        inp: null,
        error: msg,
      });
      exitCode = 1;
    }
  }
} finally {
  await browser.close();
}

console.log(`\nINP measurements (budget: ${INP_BUDGET_MS}ms):`);
for (const r of results) {
  if (r.error) {
    console.log(`  ✗ ${r.name} (${r.path}) → ERROR: ${r.error}`);
    continue;
  }
  if (r.inp === null) {
    console.log(`  ✗ ${r.name} (${r.path}) → no measurement captured`);
    exitCode = 1;
    continue;
  }
  if (r.inp > INP_BUDGET_MS) {
    console.log(
      `  ✗ ${r.name} (${r.path}) → ${r.inp.toFixed(1)}ms (over budget)`,
    );
    exitCode = 1;
    continue;
  }
  console.log(`  ✓ ${r.name} (${r.path}) → ${r.inp.toFixed(1)}ms`);
}

if (exitCode !== 0) {
  console.error(
    "::error::One or more INP measurements exceeded the budget, captured no value, or errored. Fail-closed: a silently absent metric means the gate isn't validating anything (web-vitals API change, broken flush, unqualifying interaction, bypass regression, or selector drift). Investigate before re-running.",
  );
}

process.exit(exitCode);

#!/usr/bin/env node
// Measure Interaction-to-Next-Paint (INP) for the dashboard's interactive
// surface and fail closed on a regression beyond INP_BUDGET_MS.
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
//   PREVIEW_URL    — Vercel preview URL (no trailing slash)
//   BYPASS_SECRET  — VERCEL_AUTOMATION_BYPASS_SECRET
//   INP_BUDGET_MS  — optional, default 200 (web-vitals "good" threshold)
//
// Exit codes:
//   0 — INP ≤ budget, or no measurement captured (interaction didn't
//       trigger one — surfaced as a warning, not a failure, because the
//       page may have already been hidden or no qualifying interaction
//       fired before the read window closed).
//   1 — INP > budget, or chromium / network failure.

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PREVIEW_URL = process.env.PREVIEW_URL;
const BYPASS_SECRET = process.env.BYPASS_SECRET;
const INP_BUDGET_MS = Number(process.env.INP_BUDGET_MS ?? 200);

if (!PREVIEW_URL || !BYPASS_SECRET) {
  console.error("::error::PREVIEW_URL and BYPASS_SECRET env vars required");
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

const browser = await chromium.launch({ headless: true });
let exitCode = 0;
try {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      "x-vercel-protection-bypass": BYPASS_SECRET,
      "x-vercel-set-bypass-cookie": "true",
    },
  });
  const page = await context.newPage();

  await page.goto(`${PREVIEW_URL}/pools`, {
    waitUntil: "load",
    timeout: 30_000,
  });

  // Sanity-check we landed on the dashboard, not the Vercel SSO interstitial.
  // Mirrors the audited-page guard in .github/workflows/lighthouse.yml so a
  // bypass regression fails this step too, not just the lhci accessibility
  // assertion.
  const landedUrl = page.url();
  if (landedUrl.includes("vercel.com/login")) {
    console.error(
      `::error::Landed on Vercel SSO interstitial (${landedUrl}) — deployment-protection bypass likely regressed.`,
    );
    exitCode = 1;
    throw new Error("SSO interstitial");
  }

  // Inject web-vitals' IIFE bundle so the page exposes window.webVitals.onINP.
  await page.addScriptTag({ path: webVitalsIife });

  await page.evaluate(() => {
    window.__inp = null;
    // onINP fires either when the page is hidden OR when web-vitals' internal
    // settling logic decides the interaction's reported duration is final.
    window.webVitals.onINP((metric) => {
      window.__inp = metric.value;
    });
  });

  // Wait for the dashboard's filter input to render — it's part of the
  // /pools client-rendered shell and proves the page hydrated past the SSR
  // skeleton.
  const filterInput =
    'input[aria-label="Filter swaps by pool ID or pool address"]';
  await page.waitForSelector(filterInput, { timeout: 20_000 });

  // Scripted interaction sequence: focus the input, type a filter value,
  // click Apply. Each click/keypress qualifies as an "interaction" under
  // the Event Timing API, so web-vitals will record an INP for the slowest
  // one.
  await page.click(filterInput);
  await page.fill(filterInput, "0x0000000000000000000000000000000000000000");
  await page.click('button:has-text("Apply")');

  // Force web-vitals to flush by hiding the page (its `onINP` reports on
  // visibility change). Wait briefly for the visibility handler.
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

  if (inp === null) {
    console.warn(
      "::warning::No INP measurement captured. web-vitals didn't observe a qualifying interaction inside the read window; nothing to assert against.",
    );
  } else if (inp > INP_BUDGET_MS) {
    console.error(
      `::error::INP regression: ${inp.toFixed(1)}ms > ${INP_BUDGET_MS}ms budget`,
    );
    exitCode = 1;
  } else {
    console.log(
      `INP measurement: ${inp.toFixed(1)}ms (budget: ${INP_BUDGET_MS}ms) — passed`,
    );
  }
} catch (err) {
  if (exitCode === 0) {
    console.error(
      `::error::INP measurement failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    exitCode = 1;
  }
} finally {
  await browser.close();
}

process.exit(exitCode);

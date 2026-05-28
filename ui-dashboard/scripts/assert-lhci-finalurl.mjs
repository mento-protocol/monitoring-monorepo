#!/usr/bin/env node
// Assert every Lighthouse run audited the right URL AND actually loaded
// the dashboard (not an in-place error / interstitial). Replaces the prior
// stdout `grep` for `vercel.com/login` with a structural three-gate check:
//
//   1. `finalUrl` host + pathname match the preview + expected dashboard
//      paths — catches host-level regressions (SSO interstitial host,
//      wrong vercel.app project, off-list path).
//   2. `lhr.runtimeError.code === 'NO_ERROR'` — catches Lighthouse-internal
//      failures (NO_FCP, NO_DOCUMENT_REQUEST, PROTOCOL_TIMEOUT).
//   3. The main-document network request returned HTTP 2xx — catches
//      Vercel "Deployment not found" / mid-deploy 503 / auth interstitial
//      pages that render in place with the same host+pathname but a 4xx
//      or 5xx status code. Without this, a 503-as-200-body or a 404 page
//      at `/pools` would silently pass.
//
// All of those used to silently pass when the gate only looked for
// `vercel.com/login`.
//
// Required env:
//   PREVIEW_URL  — the Vercel preview URL the workflow asked lhci to
//                  audit. Used to derive the expected host.
//
// Reads:
//   .lighthouseci/lhr-*.json — one full Lighthouse report per run, written
//                              by `lhci collect` / `lhci autorun`. Each
//                              has `finalUrl` (and `requestedUrl`) at the
//                              top level. We don't read `.lighthouseci/
//                              manifest.json` because `lhci autorun` only
//                              writes that when uploading to the
//                              filesystem target — with
//                              `upload.target: "temporary-public-storage"`
//                              (this repo's config) it's absent.
//
// Exit codes:
//   0 — every audited finalUrl matched the expected host + one of the
//       expected pathnames, Lighthouse reported no runtime error, and
//       the main document returned HTTP 2xx.
//   1 — no reports found, or at least one report failed any gate above.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const PREVIEW_URL = process.env.PREVIEW_URL;
if (!PREVIEW_URL) {
  console.error("::error::PREVIEW_URL env var required");
  process.exit(1);
}

const EXPECTED_HOST = new URL(PREVIEW_URL).host;
// Keep in sync with the `--collect.url` flags passed to `lhci autorun`
// in .github/workflows/lighthouse.yml. Adding a third audited URL there
// without updating this set will surface here as a "path mismatch"
// failure for the legitimate new page.
const EXPECTED_PATHS = new Set(["/", "/pools"]);
const LHCI_DIR = resolve(".lighthouseci");

if (!existsSync(LHCI_DIR)) {
  console.error(
    `::error::${LHCI_DIR} not found — lhci likely crashed before writing any reports. Failing closed.`,
  );
  process.exit(1);
}

// lhci writes one `lhr-<hash>.json` per run (numberOfRuns=3 × 2 URLs = 6
// files) under `.lighthouseci/`. Each is a full Lighthouse report JSON
// with `finalUrl` + `requestedUrl` at the top level.
const reports = readdirSync(LHCI_DIR)
  .filter((name) => name.startsWith("lhr-") && name.endsWith(".json"))
  .map((name) => join(LHCI_DIR, name));

if (reports.length === 0) {
  console.error(
    `::error::No lhr-*.json reports found under ${LHCI_DIR} — lhci likely crashed before writing any. Failing closed.`,
  );
  process.exit(1);
}

const failures = [];
const summary = [];

for (const reportPath of reports) {
  const lhr = JSON.parse(readFileSync(reportPath, "utf8"));
  const requestedUrl = lhr.requestedUrl ?? "<unknown>";
  const finalUrl = lhr.finalUrl ?? lhr.finalDisplayedUrl;
  if (!finalUrl) {
    failures.push(`Report ${reportPath} has no finalUrl`);
    continue;
  }
  let parsed;
  try {
    parsed = new URL(finalUrl);
  } catch (err) {
    failures.push(
      `finalUrl ${finalUrl} is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
    );
    continue;
  }
  const hostOk = parsed.host === EXPECTED_HOST;
  const pathOk = EXPECTED_PATHS.has(parsed.pathname);

  // Gate 2: Lighthouse runtime error. Set when Lighthouse itself couldn't
  // complete the audit — NO_FCP, NO_DOCUMENT_REQUEST, PROTOCOL_TIMEOUT,
  // etc. `'NO_ERROR'` is the success sentinel; absent field also counts
  // as success on older lhci versions.
  const runtimeErrorCode = lhr.runtimeError?.code;
  const runtimeOk = !runtimeErrorCode || runtimeErrorCode === "NO_ERROR";

  // Gate 3: HTTP status of the main document. `lhr.audits['network-
  // requests'].details.items` lists every request observed during the
  // audit; the entry whose `url` matches `finalUrl` is the main document
  // request. Vercel can serve a "Deployment not found" / 503 / auth
  // interstitial at the requested URL with status 4xx/5xx but a non-
  // empty HTML body — in that case host + pathname still match the
  // preview, but `statusCode >= 400` is the giveaway. If the network-
  // requests audit is unavailable (older lhci, plugin disabled) we skip
  // this gate rather than failing closed on an absent signal.
  const networkItems =
    lhr.audits?.["network-requests"]?.details?.items ?? null;
  let statusCode = null;
  let statusOk = true;
  if (Array.isArray(networkItems) && networkItems.length > 0) {
    const mainDoc =
      networkItems.find((item) => item?.url === finalUrl) ?? networkItems[0];
    statusCode = mainDoc?.statusCode ?? null;
    if (typeof statusCode === "number" && statusCode >= 400) {
      statusOk = false;
    }
  }

  const allOk = hostOk && pathOk && runtimeOk && statusOk;
  summary.push(
    `  ${allOk ? "✓" : "✗"} ${requestedUrl} → ${finalUrl}${statusCode !== null ? ` [${statusCode}]` : ""}${runtimeErrorCode && runtimeErrorCode !== "NO_ERROR" ? ` runtimeError=${runtimeErrorCode}` : ""}`,
  );
  if (!hostOk) {
    failures.push(
      `Host mismatch for ${requestedUrl}: expected ${EXPECTED_HOST}, got ${parsed.host} (finalUrl=${finalUrl})`,
    );
  }
  if (!pathOk) {
    failures.push(
      `Path mismatch for ${requestedUrl}: expected ${[...EXPECTED_PATHS].join(" or ")}, got ${parsed.pathname} (finalUrl=${finalUrl})`,
    );
  }
  if (!runtimeOk) {
    failures.push(
      `Lighthouse runtime error for ${requestedUrl}: ${runtimeErrorCode} (${lhr.runtimeError?.message ?? "no message"}) — Lighthouse could not complete the audit`,
    );
  }
  if (!statusOk) {
    failures.push(
      `Main document for ${requestedUrl} returned HTTP ${statusCode} (finalUrl=${finalUrl}) — likely a Vercel error/interstitial page rendered in place`,
    );
  }
}

console.log(`Audited ${reports.length} report(s) against ${EXPECTED_HOST}:`);
console.log(summary.join("\n"));

if (failures.length > 0) {
  console.error("::error::Lighthouse audited at least one unexpected URL:");
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  process.exit(1);
}

console.log("All audited URLs match the expected host + path set.");

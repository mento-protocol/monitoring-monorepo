#!/usr/bin/env node
// Assert every Lighthouse run audited a URL whose `finalUrl` matches the
// preview host + one of the expected dashboard paths. Replaces the prior
// stdout `grep` for `vercel.com/login` with a structural check that
// catches every kind of bypass / deployment regression, not just the SSO
// interstitial:
//
//   - Bypass token rotated and GitHub side stale → SSO interstitial host
//   - Deployment dropped (404 / 503 fallback) → Vercel error host
//   - Preview URL pointed at the wrong project → wrong vercel.app host
//   - Trailing-slash redirect to a different path → unexpected pathname
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
//       expected pathnames.
//   1 — no reports found, or at least one finalUrl mismatched.

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
  summary.push(
    `  ${hostOk && pathOk ? "✓" : "✗"} ${requestedUrl} → ${finalUrl}`,
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

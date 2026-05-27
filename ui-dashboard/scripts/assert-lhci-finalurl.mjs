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
// `vercel.com/login`. The manifest check fails closed on any mismatch.
//
// Required env:
//   PREVIEW_URL  — the Vercel preview URL the workflow asked lhci to
//                  audit. Used to derive the expected host.
//
// Reads:
//   .lighthouseci/manifest.json — written by `lhci collect` / `lhci
//                                  autorun`. Lists every per-run report
//                                  with its on-disk JSON path.
//
// Exit codes:
//   0 — every audited finalUrl matched the expected host + one of the
//       expected pathnames.
//   1 — manifest missing, no reports, or at least one finalUrl mismatched.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PREVIEW_URL = process.env.PREVIEW_URL;
if (!PREVIEW_URL) {
  console.error("::error::PREVIEW_URL env var required");
  process.exit(1);
}

const EXPECTED_HOST = new URL(PREVIEW_URL).host;
const EXPECTED_PATHS = new Set(["/", "/pools"]);
const MANIFEST_PATH = resolve(".lighthouseci/manifest.json");

if (!existsSync(MANIFEST_PATH)) {
  console.error(
    `::error::${MANIFEST_PATH} not found — lhci likely crashed before writing the manifest. Failing closed.`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
if (!Array.isArray(manifest) || manifest.length === 0) {
  console.error(
    `::error::${MANIFEST_PATH} is empty or not an array — no reports to verify. Failing closed.`,
  );
  process.exit(1);
}

const manifestDir = dirname(MANIFEST_PATH);
const failures = [];
const summary = [];

for (const entry of manifest) {
  if (!entry.jsonPath) {
    failures.push(
      `Manifest entry for ${entry.url ?? "<unknown>"} has no jsonPath`,
    );
    continue;
  }
  const reportPath = join(manifestDir, entry.jsonPath);
  if (!existsSync(reportPath)) {
    failures.push(`Report file missing: ${reportPath}`);
    continue;
  }
  const lhr = JSON.parse(readFileSync(reportPath, "utf8"));
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
    `  ${hostOk && pathOk ? "✓" : "✗"} ${entry.url ?? "<unknown>"} → ${finalUrl}`,
  );
  if (!hostOk) {
    failures.push(
      `Host mismatch for ${entry.url ?? "<unknown>"}: expected ${EXPECTED_HOST}, got ${parsed.host} (finalUrl=${finalUrl})`,
    );
  }
  if (!pathOk) {
    failures.push(
      `Path mismatch for ${entry.url ?? "<unknown>"}: expected ${[...EXPECTED_PATHS].join(" or ")}, got ${parsed.pathname} (finalUrl=${finalUrl})`,
    );
  }
}

console.log(`Audited ${manifest.length} report(s) against ${EXPECTED_HOST}:`);
console.log(summary.join("\n"));

if (failures.length > 0) {
  console.error("::error::Lighthouse audited at least one unexpected URL:");
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  process.exit(1);
}

console.log("All audited URLs match the expected host + path set.");

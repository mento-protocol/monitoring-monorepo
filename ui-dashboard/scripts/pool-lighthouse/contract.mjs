import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helperDir = dirname(fileURLToPath(import.meta.url));

export const dashboardRoot = resolve(helperDir, "../..");
export const repoRoot = resolve(dashboardRoot, "..");
export const fixtureScript = resolve(
  dashboardRoot,
  "tests/browser/fixtures/hasura-fixture-server.mjs",
);
export const diagnosticsScript = resolve(
  dashboardRoot,
  "scripts/lighthouse-pool-diagnostics.mjs",
);
export const lighthouseConfig = resolve(repoRoot, ".lighthouserc.cjs");
export const nextEnvPath = resolve(dashboardRoot, "next-env.d.ts");
export const nextDevPath = resolve(dashboardRoot, ".next/dev");
export const defaultOutputDir = resolve(
  dashboardRoot,
  "reports/lighthouse-pool",
);

export const CANONICAL_POOL_PATH =
  "/pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
export const TARGET_QUERY = "lhci=fixture";
export const FIXTURE_SCENARIO = "lighthouse-pool";
export const CLIENT_BREAKER_DELAY_MS = 2200;
export const FIXTURE_GRAPHQL_DELAY_FLOOR_MS = 1700;
export const EXPECTED_BREAKER_TEXT = "ref 1.171560 / actual 1.175000";
export const EXPECTED_VOLUME_TEXT = "$125.00";
export const EXPECTED_BREAKER_QUERY = "query PoolBreakerConfig";
export const EXPECTED_RUNS = 3;
export const MINIMUM_DELAYED_BREAKER_REQUESTS = EXPECTED_RUNS + 1;

export function log(message) {
  process.stdout.write(`[pool-lighthouse] ${message}\n`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

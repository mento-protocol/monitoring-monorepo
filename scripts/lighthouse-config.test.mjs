import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const config = require("../.lighthouserc.cjs");
const lhciPackagePath = require.resolve("@lhci/cli/package.json");
const lhciPackage = require(lhciPackagePath);
const LHCI_CLI_PATH = resolve(dirname(lhciPackagePath), lhciPackage.bin.lhci);
const CONFIG_PATH = fileURLToPath(
  new URL("../.lighthouserc.cjs", import.meta.url),
);

const PREVIEW_ORIGIN = "https://monitoring-example.vercel.app";
const ROOT_AND_POOLS_PATHS = ["/", "/pools"];
const VOLUME_PATH = "/volume";
const CANONICAL_POOL_PATH =
  "/pool/42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e";
const LIVE_POOL_PATH = `${CANONICAL_POOL_PATH}?lhci=live`;
const FIXTURE_POOL_PATH = `${CANONICAL_POOL_PATH}?lhci=fixture`;
const REAL_VOLUME_LCP_VALUES = [1981.264, 1885.954, 1940.19];

function makeLhr(path, lcpNumericValue) {
  const finalUrl = new URL(path, PREVIEW_ORIGIN).href;
  return {
    requestedUrl: finalUrl,
    finalUrl,
    categories: {
      performance: { score: 0.91 },
      accessibility: { score: 0.95 },
    },
    audits: {
      "first-contentful-paint": { score: 1, numericValue: 700 },
      interactive: { score: 1, numericValue: 900 },
      "largest-contentful-paint": {
        score: 1,
        scoreDisplayMode: "numeric",
        numericValue: lcpNumericValue,
        title: "Largest Contentful Paint",
        description: "",
      },
      "cumulative-layout-shift": {
        score: 1,
        scoreDisplayMode: "numeric",
        numericValue: 0.000716,
        title: "Cumulative Layout Shift",
        description: "",
      },
    },
  };
}

function reportsFor(path, values) {
  return values.map((value) => makeLhr(path, value));
}

function runLhciAssert(lhrs) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "lighthouse-config-"));
  const reportDir = join(fixtureRoot, ".lighthouseci");
  mkdirSync(reportDir);

  try {
    lhrs.forEach((lhr, index) => {
      writeFileSync(join(reportDir, `lhr-${index}.json`), JSON.stringify(lhr));
    });

    const result = spawnSync(
      process.execPath,
      [
        LHCI_CLI_PATH,
        "assert",
        `--config=${CONFIG_PATH}`,
        "--includePassedAssertions=true",
      ],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );
    const assertionsPath = join(reportDir, "assertion-results.json");
    const assertions = JSON.parse(readFileSync(assertionsPath, "utf8"));

    return { ...result, assertions };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function findLcpResult(result, path) {
  const url = new URL(path, PREVIEW_ORIGIN).href;
  const assertion = result.assertions.find(
    ({ auditId, url: assertionUrl }) =>
      auditId === "largest-contentful-paint" && assertionUrl === url,
  );
  assert.ok(assertion, `missing LCP assertion result for ${path}`);
  return assertion;
}

describe("Lighthouse route assertion matrix", () => {
  it("matches each audited route exactly once", () => {
    const paths = [
      ...ROOT_AND_POOLS_PATHS,
      VOLUME_PATH,
      LIVE_POOL_PATH,
      FIXTURE_POOL_PATH,
    ];

    for (const path of paths) {
      const url = new URL(path, PREVIEW_ORIGIN).href;
      const matches = config.ci.assert.assertMatrix.filter(
        ({ matchingUrlPattern }) => new RegExp(matchingUrlPattern).test(url),
      );
      assert.equal(matches.length, 1, path);
    }

    const unmatchedPaths = [
      "/volume-history",
      CANONICAL_POOL_PATH,
      `${CANONICAL_POOL_PATH}?lhci=other`,
      `${CANONICAL_POOL_PATH}?lhci=live&extra=true`,
      `${CANONICAL_POOL_PATH}?lhci=fixture&extra=true`,
    ];
    for (const path of unmatchedPaths) {
      const url = new URL(path, PREVIEW_ORIGIN).href;
      const matches = config.ci.assert.assertMatrix.filter(
        ({ matchingUrlPattern }) => new RegExp(matchingUrlPattern).test(url),
      );
      assert.equal(matches.length, 0, path);
    }
  });

  it("keeps every non-LCP assertion identical between matrix entries", () => {
    const withoutLcp = ({ "largest-contentful-paint": _lcp, ...rest }) => rest;
    const [first, ...remaining] = config.ci.assert.assertMatrix;
    assert.ok(first);

    for (const entry of remaining) {
      assert.deepEqual(
        withoutLcp(entry.assertions),
        withoutLcp(first.assertions),
      );
    }
    assert.deepEqual(withoutLcp(first.assertions), {
      "categories:performance": ["error", { minScore: 0.75 }],
      "categories:accessibility": ["error", { minScore: 0.94 }],
      "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
    });
    for (const entry of config.ci.assert.assertMatrix) {
      assert.equal(entry.aggregationMethod, "median");
    }
  });

  it("passes the real /volume measurements at the 2,440 ms ceiling", () => {
    const result = runLhciAssert(
      reportsFor(VOLUME_PATH, REAL_VOLUME_LCP_VALUES),
    );
    const lcp = findLcpResult(result, VOLUME_PATH);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(lcp.expected, 2440);
    assert.equal(lcp.actual, 1940.19);
    assert.equal(lcp.passed, true);
  });

  it("passes /volume at 2,440 ms and blocks values above it", () => {
    const atCeiling = runLhciAssert(
      reportsFor(VOLUME_PATH, [2440, 2440, 2440]),
    );
    const aboveCeiling = runLhciAssert(
      reportsFor(VOLUME_PATH, [2440.001, 2440.001, 2440.001]),
    );

    assert.equal(atCeiling.status, 0, atCeiling.stderr);
    assert.equal(findLcpResult(atCeiling, VOLUME_PATH).passed, true);
    assert.equal(aboveCeiling.status, 1, aboveCeiling.stderr);
    assert.equal(findLcpResult(aboveCeiling, VOLUME_PATH).passed, false);
  });

  it("uses the median /volume run instead of an optimistic outlier", () => {
    const oneLuckyRun = runLhciAssert(
      reportsFor(VOLUME_PATH, [2439, 2441, 2442]),
    );
    const oneSlowRun = runLhciAssert(
      reportsFor(VOLUME_PATH, [2438, 2440, 2442]),
    );

    assert.equal(oneLuckyRun.status, 1, oneLuckyRun.stderr);
    assert.equal(findLcpResult(oneLuckyRun, VOLUME_PATH).actual, 2441);
    assert.equal(findLcpResult(oneLuckyRun, VOLUME_PATH).passed, false);
    assert.equal(oneSlowRun.status, 0, oneSlowRun.stderr);
    assert.equal(findLcpResult(oneSlowRun, VOLUME_PATH).actual, 2440);
    assert.equal(findLcpResult(oneSlowRun, VOLUME_PATH).passed, true);
  });

  it("uses the median blocking 1,700 ms run instead of an optimistic outlier", () => {
    const blockingPaths = [...ROOT_AND_POOLS_PATHS, FIXTURE_POOL_PATH];
    const oneLuckyRun = runLhciAssert(
      blockingPaths.flatMap((path) => reportsFor(path, [1699, 1701, 1702])),
    );
    const oneSlowRun = runLhciAssert(
      blockingPaths.flatMap((path) => reportsFor(path, [1698, 1700, 1702])),
    );

    assert.equal(oneLuckyRun.status, 1, oneLuckyRun.stderr);
    assert.equal(oneSlowRun.status, 0, oneSlowRun.stderr);

    for (const path of blockingPaths) {
      assert.equal(findLcpResult(oneLuckyRun, path).actual, 1701, path);
      assert.equal(findLcpResult(oneLuckyRun, path).passed, false, path);
      assert.equal(findLcpResult(oneSlowRun, path).actual, 1700, path);
      assert.equal(findLcpResult(oneSlowRun, path).passed, true, path);
    }
  });

  it("retains the blocking 1,700 ms ceiling on root, pools, and fixture pool", () => {
    const blockingPaths = [...ROOT_AND_POOLS_PATHS, FIXTURE_POOL_PATH];
    const atCeiling = runLhciAssert(
      blockingPaths.flatMap((path) => reportsFor(path, [1700, 1700, 1700])),
    );
    const aboveCeiling = runLhciAssert(
      blockingPaths.flatMap((path) =>
        reportsFor(path, [1700.001, 1700.001, 1700.001]),
      ),
    );

    assert.equal(atCeiling.status, 0, atCeiling.stderr);
    assert.equal(aboveCeiling.status, 1, aboveCeiling.stderr);

    for (const path of blockingPaths) {
      const atCeilingLcp = findLcpResult(atCeiling, path);
      const aboveCeilingLcp = findLcpResult(aboveCeiling, path);

      assert.equal(atCeilingLcp.expected, 1700, path);
      assert.equal(atCeilingLcp.passed, true, path);
      assert.equal(aboveCeilingLcp.passed, false, path);
    }
  });

  it("records live pool LCP above 1,700 ms as a median warning", () => {
    const result = runLhciAssert(
      reportsFor(LIVE_POOL_PATH, [1699, 1701, 2640]),
    );
    const lcp = findLcpResult(result, LIVE_POOL_PATH);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(lcp.expected, 1700);
    assert.equal(lcp.actual, 1701);
    assert.equal(lcp.passed, false);
    assert.equal(lcp.level, "warn");
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /largest-contentful-paint.*warning/s,
    );
  });

  it("blocks fixture pool LCP above the same exact 1,700 ms ceiling", () => {
    const result = runLhciAssert(
      reportsFor(FIXTURE_POOL_PATH, [1699, 1701, 2640]),
    );
    const lcp = findLcpResult(result, FIXTURE_POOL_PATH);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(lcp.expected, 1700);
    assert.equal(lcp.actual, 1701);
    assert.equal(lcp.passed, false);
    assert.equal(lcp.level, "error");
  });
});

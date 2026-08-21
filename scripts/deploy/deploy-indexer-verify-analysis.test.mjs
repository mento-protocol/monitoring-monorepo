#!/usr/bin/env node

import assert from "node:assert/strict";
import { summarizeSusdsSamplerProgress } from "./deploy-indexer-verify-analysis.mjs";

const NOW_SECONDS = 2_000_000_000;
const SAMPLE_BLOCK = 24_573_803;

function summarize(overrides = {}) {
  return summarizeSusdsSamplerProgress({
    summaryNonzero: true,
    latestSnapshot: {
      sampledAtBlock: String(SAMPLE_BLOCK),
      sampledAtTimestamp: String(NOW_SECONDS - 1_000),
    },
    ethereumChain: { processedBlock: SAMPLE_BLOCK },
    nowSeconds: NOW_SECONDS,
    ...overrides,
  });
}

for (const lag of [0, 599]) {
  const summary = summarize({
    ethereumChain: { processedBlock: SAMPLE_BLOCK + lag },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.blockLag, lag);
}

for (const lag of [600, 601]) {
  const summary = summarize({
    ethereumChain: { processedBlock: SAMPLE_BLOCK + lag },
  });
  assert.equal(summary.ok, false);
  assert.match(summary.failures.join("\n"), /sUSDS sampler is stale/);
}

assert.match(
  summarize({ latestSnapshot: undefined }).failures.join("\n"),
  /has no daily snapshot row/,
);
assert.match(
  summarize({
    latestSnapshot: {
      sampledAtBlock: "invalid",
      sampledAtTimestamp: "invalid",
    },
  }).failures.join("\n"),
  /no valid sampledAtBlock[\s\S]*no valid sampledAtTimestamp/,
);
assert.match(
  summarize({ ethereumChain: undefined }).failures.join("\n"),
  /Ethereum status is missing[\s\S]*cannot verify Ethereum processed head/,
);
assert.match(
  summarize({
    latestSnapshot: {
      sampledAtBlock: "24573203",
      sampledAtTimestamp: "1772496000",
    },
  }).failures.join("\n"),
  /no post-launch progress[\s\S]*still the launch baseline/,
);
assert.match(
  summarize({
    ethereumChain: { processedBlock: SAMPLE_BLOCK - 1 },
  }).failures.join("\n"),
  /ahead of Ethereum processed head/,
);
assert.match(
  summarize({
    latestSnapshot: {
      sampledAtBlock: String(SAMPLE_BLOCK),
      sampledAtTimestamp: String(NOW_SECONDS + 1),
    },
  }).failures.join("\n"),
  /is in the future/,
);

const exactDayOld = summarize({
  latestSnapshot: {
    sampledAtBlock: String(SAMPLE_BLOCK),
    sampledAtTimestamp: String(NOW_SECONDS - 24 * 60 * 60),
  },
});
assert.equal(exactDayOld.ok, true);
assert.equal(exactDayOld.ageSeconds, 24 * 60 * 60);
assert.match(
  summarize({
    latestSnapshot: {
      sampledAtBlock: String(SAMPLE_BLOCK),
      sampledAtTimestamp: String(NOW_SECONDS - 24 * 60 * 60 - 1),
    },
  }).failures.join("\n"),
  /is 86401 seconds old/,
);

console.log("deploy-indexer-verify-analysis tests passed.");

#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildProbeQuery,
  summarizeSusdsLaunchBaseline,
  summarizeSusdsLaunchBaselineSchema,
  summarizeSusdsSamplerProgress,
} from "./deploy-indexer-verify-analysis.mjs";

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

const validLaunchBaseline = {
  id: "1-susds-launch",
  chainId: 1,
  token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
  launchBlock: "24573203",
  launchTimestamp: "1772496000",
  sharePriceUsdWei: "1100000000000000000",
  sampledAtBlock: "24573203",
  sampledAtTimestamp: "1772496000",
};

const strictProbeQuery = buildProbeQuery();
assert.match(strictProbeQuery, /SusdsYieldLaunchBaseline/);
assert.match(strictProbeQuery, /SusdsYieldDailySnapshot/);
assert.doesNotMatch(
  buildProbeQuery({ includeSusdsSampler: false }),
  /SusdsYield(?:LaunchBaseline|DailySnapshot)/,
);

assert.deepEqual(
  summarizeSusdsLaunchBaselineSchema({
    value: "type SusdsYieldLaunchBaseline { id: ID! }",
    readError: "",
  }),
  {
    ok: true,
    schemaPath: "indexer-envio/schema.graphql",
    detected: true,
    required: true,
    failures: [],
  },
);
assert.deepEqual(
  summarizeSusdsLaunchBaselineSchema({
    value: "type SusdsYieldDailySnapshot { id: ID! }",
    readError: "",
  }),
  {
    ok: true,
    schemaPath: "indexer-envio/schema.graphql",
    detected: false,
    required: false,
    failures: [],
  },
);
const unreadableSchema = summarizeSusdsLaunchBaselineSchema({
  value: null,
  readError: "schema unavailable",
});
assert.equal(unreadableSchema.ok, false);
assert.equal(unreadableSchema.required, true);
assert.match(unreadableSchema.failures.join("\n"), /schema unavailable/);
assert.match(
  buildProbeQuery({ includeSusdsSampler: unreadableSchema.required }),
  /SusdsYieldLaunchBaseline/,
);
assert.match(
  buildProbeQuery({ includeSusdsSampler: unreadableSchema.required }),
  /SusdsYieldDailySnapshot/,
);
const emptySchema = summarizeSusdsLaunchBaselineSchema({
  value: "",
  readError: "",
});
assert.equal(emptySchema.ok, false);
assert.equal(emptySchema.required, true);
assert.match(emptySchema.failures.join("\n"), /could not inspect/);
assert.match(
  buildProbeQuery({ includeSusdsSampler: emptySchema.required }),
  /SusdsYieldLaunchBaseline/,
);
assert.match(
  buildProbeQuery({ includeSusdsSampler: emptySchema.required }),
  /SusdsYieldDailySnapshot/,
);
for (const value of [
  "type Pool { id: ID!",
  "type SusdsYieldLaunchBaseline { id: ID!",
]) {
  const malformedSchema = summarizeSusdsLaunchBaselineSchema({
    value,
    readError: "",
  });
  assert.equal(malformedSchema.ok, false);
  assert.equal(malformedSchema.detected, null);
  assert.equal(malformedSchema.required, true);
  assert.match(malformedSchema.failures.join("\n"), /invalid GraphQL SDL/);
  assert.match(
    buildProbeQuery({
      includeSusdsSampler: malformedSchema.required,
    }),
    /SusdsYieldLaunchBaseline/,
  );
  assert.match(
    buildProbeQuery({
      includeSusdsSampler: malformedSchema.required,
    }),
    /SusdsYieldDailySnapshot/,
  );
}
const executableDocument = summarizeSusdsLaunchBaselineSchema({
  value: "query Probe { Pool { id } }",
  readError: "",
});
assert.equal(executableDocument.ok, false);
assert.equal(executableDocument.detected, null);
assert.equal(executableDocument.required, true);
assert.match(executableDocument.failures.join("\n"), /could not inspect/);

assert.equal(summarizeSusdsLaunchBaseline(validLaunchBaseline).ok, true);
assert.deepEqual(summarizeSusdsLaunchBaseline(undefined, { required: false }), {
  ok: true,
  id: null,
  chainId: null,
  token: null,
  launchBlock: null,
  launchTimestamp: null,
  sampledAtBlock: null,
  sampledAtTimestamp: null,
  sharePriceValid: false,
  failures: [],
});
assert.match(
  summarizeSusdsLaunchBaseline(undefined).failures.join("\n"),
  /launch baseline row 1-susds-launch is missing/,
);
assert.match(
  summarizeSusdsLaunchBaseline({
    ...validLaunchBaseline,
    token: "0x0000000000000000000000000000000000000000",
    launchBlock: "24573204",
    sampledAtTimestamp: "1772496001",
    sharePriceUsdWei: "0",
  }).failures.join("\n"),
  /token is[\s\S]*launchBlock is[\s\S]*sampledAtTimestamp is[\s\S]*no positive sharePriceUsdWei/,
);

assert.deepEqual(
  summarizeSusdsSamplerProgress({
    required: false,
    summaryNonzero: true,
    latestSnapshot: undefined,
    ethereumChain: { processedBlock: SAMPLE_BLOCK + 601 },
    nowSeconds: NOW_SECONDS,
  }),
  {
    ok: true,
    failures: [],
    latestSampledAtBlock: null,
    latestSampledAtTimestamp: null,
    processedBlock: SAMPLE_BLOCK + 601,
    blockLag: null,
    ageSeconds: null,
  },
);

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

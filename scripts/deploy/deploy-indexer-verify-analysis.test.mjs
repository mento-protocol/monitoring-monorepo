#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildProbeQuery,
  summarizeDeploymentIdentity,
  summarizeSusdsLaunchBaseline,
  summarizeSusdsLaunchBaselineSchema,
  summarizeSusdsSamplerProgress,
} from "./deploy-indexer-verify-analysis.mjs";

const NOW_SECONDS = 2_000_000_000;
const SAMPLE_BLOCK = 24_573_803;
const SAFE_LEGACY_HANDLER_INPUT = {
  value: "await updateSummary(context, meta, sharePriceUsdWei);",
  readError: "",
};

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
assert.match(strictProbeQuery, /SusdsYieldSamplerProgress/);
assert.doesNotMatch(strictProbeQuery, /_meta/);
assert.doesNotMatch(
  buildProbeQuery({ includeSusdsSampler: false }),
  /SusdsYield(?:LaunchBaseline|DailySnapshot|SamplerProgress)/,
);
assert.match(
  buildProbeQuery({ includeDeploymentIdentity: true }),
  /_meta\(order_by: \{ chainId: asc \}\) \{ chainId readyAt startBlock \}/,
);

const targetSync = {
  allSynced: true,
  chains: [
    {
      chainId: 1,
      startBlock: 19_111_760,
      syncedAt: "2026-08-24T16:59:33.166+00:00",
    },
    {
      chainId: 137,
      startBlock: 90_273_661,
      syncedAt: "2026-08-24T16:59:32.916+00:00",
    },
  ],
};
const matchingIdentityRows = [
  {
    chainId: 1,
    readyAt: "2026-08-24T16:59:33.166000Z",
    startBlock: 19_111_760,
  },
  {
    chainId: 137,
    readyAt: "2026-08-24T16:59:32.916Z",
    startBlock: 90_273_661,
  },
];

const matchingIdentity = summarizeDeploymentIdentity(
  { data: { _meta: matchingIdentityRows } },
  targetSync,
  { required: true },
);
assert.equal(matchingIdentity.ok, true);
assert.equal(matchingIdentity.required, true);
assert.deepEqual(matchingIdentity.expected, matchingIdentity.observed);

const oldStaticIdentity = summarizeDeploymentIdentity(
  {
    data: {
      _meta: matchingIdentityRows.map((row) => ({
        ...row,
        readyAt: "2026-08-21T10:46:13.111Z",
      })),
    },
  },
  targetSync,
  { required: true },
);
assert.equal(oldStaticIdentity.ok, false);
assert.match(
  oldStaticIdentity.failures.join("\n"),
  /does not match target chain 1[\s\S]*does not match target chain 137/,
);

for (const graphqlJson of [
  { data: {} },
  {
    data: {
      _meta: [matchingIdentityRows[0], { ...matchingIdentityRows[0] }],
    },
  },
  {
    data: {
      _meta: [
        matchingIdentityRows[0],
        { ...matchingIdentityRows[1], readyAt: "0" },
      ],
    },
  },
]) {
  assert.equal(
    summarizeDeploymentIdentity(graphqlJson, targetSync, { required: true }).ok,
    false,
  );
}
assert.deepEqual(summarizeDeploymentIdentity({}, targetSync), {
  required: false,
  ok: true,
  expected: [],
  observed: [],
  failures: [],
});

assert.deepEqual(
  summarizeSusdsLaunchBaselineSchema(
    {
      value: "type SusdsYieldLaunchBaseline { id: ID! }",
      readError: "",
    },
    { legacyHandlerInput: SAFE_LEGACY_HANDLER_INPUT },
  ),
  {
    ok: true,
    schemaPath: "indexer-envio/schema.graphql",
    detected: true,
    required: true,
    samplerProgressDetected: false,
    samplerProgressRequired: false,
    failures: [],
  },
);
const preProgressSamplerSchema = summarizeSusdsLaunchBaselineSchema(
  {
    value: "type SusdsYieldLaunchBaseline { id: ID! }",
    readError: "",
  },
  { legacyHandlerInput: SAFE_LEGACY_HANDLER_INPUT },
);
assert.match(
  buildProbeQuery({
    includeSusdsSampler: preProgressSamplerSchema.required,
    includeSusdsSamplerProgress:
      preProgressSamplerSchema.samplerProgressRequired,
  }),
  /SusdsYieldDailySnapshot/,
);
assert.doesNotMatch(
  buildProbeQuery({
    includeSusdsSampler: preProgressSamplerSchema.required,
    includeSusdsSamplerProgress:
      preProgressSamplerSchema.samplerProgressRequired,
  }),
  /SusdsYieldSamplerProgress/,
);
const unsafeLegacySamplerSchema = summarizeSusdsLaunchBaselineSchema(
  {
    value: "type SusdsYieldLaunchBaseline { id: ID! }",
    readError: "",
  },
  {
    legacyHandlerInput: {
      value:
        "await recordSusdsYieldEventDailySnapshot(context, meta, sharePriceUsdWei);",
      readError: "",
    },
  },
);
assert.equal(unsafeLegacySamplerSchema.ok, false);
assert.match(
  unsafeLegacySamplerSchema.failures.join("\n"),
  /writes event-time daily snapshots without SusdsYieldSamplerProgress/,
);
const unreadableLegacyHandlerSchema = summarizeSusdsLaunchBaselineSchema(
  {
    value: "type SusdsYieldLaunchBaseline { id: ID! }",
    readError: "",
  },
  {
    legacyHandlerInput: {
      value: null,
      readError: "could not read legacy sUSDS handler",
    },
  },
);
assert.equal(unreadableLegacyHandlerSchema.ok, false);
assert.match(
  unreadableLegacyHandlerSchema.failures.join("\n"),
  /could not read legacy sUSDS handler/,
);
assert.deepEqual(
  summarizeSusdsLaunchBaselineSchema({
    value:
      "type SusdsYieldLaunchBaseline { id: ID! } type SusdsYieldSamplerProgress { id: ID! }",
    readError: "",
  }),
  {
    ok: true,
    schemaPath: "indexer-envio/schema.graphql",
    detected: true,
    required: true,
    samplerProgressDetected: true,
    samplerProgressRequired: true,
    failures: [],
  },
);
const inconsistentProgressSchema = summarizeSusdsLaunchBaselineSchema({
  value: "type SusdsYieldSamplerProgress { id: ID! }",
  readError: "",
});
assert.equal(inconsistentProgressSchema.ok, false);
assert.equal(inconsistentProgressSchema.required, false);
assert.equal(inconsistentProgressSchema.samplerProgressRequired, true);
assert.match(
  inconsistentProgressSchema.failures.join("\n"),
  /exists without SusdsYieldLaunchBaseline/,
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
    samplerProgressDetected: false,
    samplerProgressRequired: false,
    failures: [],
  },
);
const unreadableSchema = summarizeSusdsLaunchBaselineSchema({
  value: null,
  readError: "schema unavailable",
});
assert.equal(unreadableSchema.ok, false);
assert.equal(unreadableSchema.required, true);
assert.equal(unreadableSchema.samplerProgressRequired, true);
assert.match(unreadableSchema.failures.join("\n"), /schema unavailable/);
assert.match(
  buildProbeQuery({ includeSusdsSampler: unreadableSchema.required }),
  /SusdsYieldLaunchBaseline/,
);
assert.match(
  buildProbeQuery({ includeSusdsSampler: unreadableSchema.required }),
  /SusdsYieldDailySnapshot/,
);
assert.match(
  buildProbeQuery({
    includeSusdsSampler: unreadableSchema.required,
    includeSusdsSamplerProgress: unreadableSchema.samplerProgressRequired,
  }),
  /SusdsYieldSamplerProgress/,
);
const emptySchema = summarizeSusdsLaunchBaselineSchema({
  value: "",
  readError: "",
});
assert.equal(emptySchema.ok, false);
assert.equal(emptySchema.required, true);
assert.equal(emptySchema.samplerProgressRequired, true);
assert.match(emptySchema.failures.join("\n"), /could not inspect/);
assert.match(
  buildProbeQuery({ includeSusdsSampler: emptySchema.required }),
  /SusdsYieldLaunchBaseline/,
);
assert.match(
  buildProbeQuery({ includeSusdsSampler: emptySchema.required }),
  /SusdsYieldDailySnapshot/,
);
assert.match(
  buildProbeQuery({
    includeSusdsSampler: emptySchema.required,
    includeSusdsSamplerProgress: emptySchema.samplerProgressRequired,
  }),
  /SusdsYieldSamplerProgress/,
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
  assert.equal(malformedSchema.samplerProgressDetected, null);
  assert.equal(malformedSchema.samplerProgressRequired, true);
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
      includeSusdsSamplerProgress: malformedSchema.samplerProgressRequired,
    }),
    /SusdsYieldDailySnapshot/,
  );
  assert.match(
    buildProbeQuery({
      includeSusdsSampler: malformedSchema.required,
      includeSusdsSamplerProgress: malformedSchema.samplerProgressRequired,
    }),
    /SusdsYieldSamplerProgress/,
  );
}
const executableDocument = summarizeSusdsLaunchBaselineSchema({
  value: "query Probe { Pool { id } }",
  readError: "",
});
assert.equal(executableDocument.ok, false);
assert.equal(executableDocument.detected, null);
assert.equal(executableDocument.required, true);
assert.equal(executableDocument.samplerProgressDetected, null);
assert.equal(executableDocument.samplerProgressRequired, true);
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

const staleHeartbeatBehindRecentEventRow = summarizeSusdsSamplerProgress({
  summaryNonzero: true,
  latestSnapshot: {
    sampledAtBlock: String(SAMPLE_BLOCK + 600),
    sampledAtTimestamp: String(NOW_SECONDS - 10),
  },
  samplerProgress: {
    sampledAtBlock: String(SAMPLE_BLOCK),
    sampledAtTimestamp: String(NOW_SECONDS - 1_000),
  },
  useSamplerProgress: true,
  ethereumChain: { processedBlock: SAMPLE_BLOCK + 600 },
  nowSeconds: NOW_SECONDS,
});
assert.equal(staleHeartbeatBehindRecentEventRow.ok, false);
assert.equal(
  staleHeartbeatBehindRecentEventRow.latestSampledAtBlock,
  SAMPLE_BLOCK,
);
assert.equal(staleHeartbeatBehindRecentEventRow.blockLag, 600);
assert.match(
  staleHeartbeatBehindRecentEventRow.failures.join("\n"),
  /sUSDS sampler is stale/,
);

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

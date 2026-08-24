#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  PROBE_QUERY,
  buildProbeQuery,
  buildSummary,
  extractJsonValue,
  parseArgs,
  parseJsonOutput,
  renderText,
  resolveDeployment,
  resolveProdDeployment,
  summarizeProbe,
  summarizeReplayIntegrity,
  summarizeSusdsSamplerProgress,
  summarizeSusdsLaunchBaselineSchema,
  summarizeStatus,
} from "./deploy-indexer-verify.mjs";
import {
  POLYGON_FPMM_EXPECTATIONS,
  summarizePolygonPools,
} from "../lib/polygon-deployment-semantics.mjs";

const NOW_SECONDS = 2_000_000_000;
const VALID_REPLAY_INTEGRITY = {
  value: { polygonExactMedianTimestamp: 3 },
  readError: "",
};

function validPolygonPools() {
  return POLYGON_FPMM_EXPECTATIONS.map((expected, index) => ({
    id: expected.id,
    source: "fpmm_factory",
    referenceRateFeedID: expected.referenceRateFeedID,
    lastOracleReportAt: String(NOW_SECONDS - 1_000 - index),
    oracleExpiry: expected.oracleExpiry.toString(),
    oracleOk: true,
    medianLive: true,
    healthStatus: "OK",
    hasHealthData: true,
    lastOracleSnapshotTimestamp: String(NOW_SECONDS - 500 - index),
    healthTotalSeconds: "1000",
    healthBinarySeconds: "900",
  }));
}

function validSusdsLaunchBaseline() {
  return {
    id: "1-susds-launch",
    chainId: 1,
    token: "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd",
    launchBlock: "24573203",
    launchTimestamp: "1772496000",
    sharePriceUsdWei: "1100000000000000000",
    sampledAtBlock: "24573203",
    sampledAtTimestamp: "1772496000",
  };
}

assert.match(
  PROBE_QUERY,
  /SusdsYieldLaunchBaseline[\s\S]*id: \{ _eq: "1-susds-launch" \}[\s\S]*sharePriceUsdWei/,
);
assert.match(PROBE_QUERY, /SusdsYieldDailySnapshot/);
assert.doesNotMatch(
  buildProbeQuery({ includeSusdsSampler: false }),
  /SusdsYield(?:LaunchBaseline|DailySnapshot)/,
);

const indexerJson = {
  data: {
    deployments: [
      {
        commit_hash: "abc1234",
        created_time: "2026-07-03T10:00:00.000Z",
        prod_status: "prod",
        gql_endpoint: "https://indexer.hyperindex.xyz/static/v1/graphql",
      },
      {
        commit_hash: "def5678",
        created_time: "2026-07-03T11:00:00.000Z",
        prod_status: "",
        gql_endpoint: "https://indexer.hyperindex.xyz/deployment/v1/graphql",
      },
    ],
  },
};

assert.deepEqual(parseArgs(["def5678", "--prod", "--json"]), {
  target: "def5678",
  json: true,
  prod: true,
  allowSyncing: false,
  help: false,
});

assert.equal(
  extractJsonValue('warning: noisy preamble\n{"data":{"ok":true}}\ntrailing'),
  '{"data":{"ok":true}}',
);
assert.deepEqual(parseJsonOutput('WARN [engine]\n{"ok":true}', "fixture"), {
  ok: true,
});
assert.deepEqual(parseJsonOutput('warn\n[{"ok":true}]', "fixture"), [
  { ok: true },
]);

assert.equal(resolveDeployment(indexerJson, "")?.commit_hash, "def5678");
assert.equal(resolveDeployment(indexerJson, "def")?.commit_hash, "def5678");
assert.equal(
  resolveDeployment(indexerJson, "1234567890", "def567899999")?.commit_hash,
  "def5678",
);
assert.equal(resolveDeployment(indexerJson, "missing"), null);
assert.throws(
  () =>
    resolveDeployment(
      {
        data: {
          deployments: [
            {
              commit_hash: "abc1234",
              created_time: "2026-07-03T11:00:00.000Z",
            },
            {
              commit_hash: "abc5678",
              created_time: "2026-07-03T10:00:00.000Z",
            },
          ],
        },
      },
      "abc",
    ),
  /Ambiguous deployment commit abc/,
);
assert.equal(
  resolveDeployment(
    {
      data: {
        deployments: [
          {
            commit_hash: null,
            created_time: "2026-07-03T11:00:00.000Z",
          },
        ],
      },
    },
    "1234567890",
    "1234567890",
  ),
  null,
);
assert.equal(resolveProdDeployment(indexerJson)?.commit_hash, "abc1234");

const validReplayIntegrity = summarizeReplayIntegrity(VALID_REPLAY_INTEGRITY);
assert.equal(validReplayIntegrity.ok, true);
assert.equal(validReplayIntegrity.requiredVersion, 3);
assert.match(
  summarizeReplayIntegrity({
    value: { polygonExactMedianTimestamp: 2 },
    readError: "",
  }).failures.join("\n"),
  /predates Polygon event-sourced oracle-freshness replay integrity v3/,
);
assert.match(
  summarizeReplayIntegrity({
    value: null,
    readError: "marker missing from old commit",
  }).failures.join("\n"),
  /marker missing[\s\S]*predates Polygon event-sourced oracle-freshness replay integrity/,
);
assert.equal(
  summarizeReplayIntegrity({
    value: { polygonExactMedianTimestamp: "not-a-version" },
    readError: "",
  }).ok,
  false,
);

assert.deepEqual(
  summarizeStatus({
    data: [
      {
        chain_id: 1,
        start_block: 10,
        block_height: 20,
        latest_processed_block: 19,
        latest_fetched_block_number: 20,
        num_events_processed: 3,
        timestamp_caught_up_to_head_or_endblock: "2026-07-03T12:00:00Z",
      },
      {
        chain_id: 42220,
        start_block: 5,
        block_height: 7,
        latest_processed_block: 7,
        latest_fetched_block_number: 7,
        num_events_processed: 9,
        timestamp_caught_up_to_head_or_endblock: "",
      },
    ],
  }),
  {
    allSynced: false,
    chains: [
      {
        chainId: 1,
        startBlock: 10,
        headBlock: 20,
        processedBlock: 19,
        fetchedBlock: 20,
        events: 3,
        syncedAt: "2026-07-03T12:00:00Z",
      },
      {
        chainId: 42220,
        startBlock: 5,
        headBlock: 7,
        processedBlock: 7,
        fetchedBlock: 7,
        events: 9,
        syncedAt: "",
      },
    ],
  },
);

assert.equal(summarizePolygonPools(validPolygonPools(), NOW_SECONDS).ok, true);

const missingPolygonPool = validPolygonPools().slice(1);
assert.match(
  summarizePolygonPools(missingPolygonPool, NOW_SECONDS).failures.join("\n"),
  /missing Polygon FPMMs/,
);

const zeroCursors = validPolygonPools();
zeroCursors[0].lastOracleReportAt = "0";
zeroCursors[0].lastOracleSnapshotTimestamp = "0";
assert.match(
  summarizePolygonPools(zeroCursors, NOW_SECONDS).failures.join("\n"),
  /no positive exact oracle anchor[\s\S]*no positive oracle snapshot cursor/,
);

const wrongFeedAndExpiry = validPolygonPools();
wrongFeedAndExpiry[1].referenceRateFeedID =
  "0x0000000000000000000000000000000000000001";
wrongFeedAndExpiry[1].oracleExpiry = "31536000";
assert.match(
  summarizePolygonPools(wrongFeedAndExpiry, NOW_SECONDS).failures.join("\n"),
  /feed is[\s\S]*expiry is/,
);

const expiredOneYearPool = validPolygonPools();
expiredOneYearPool[2].lastOracleReportAt = String(NOW_SECONDS - 31_536_001);
assert.match(
  summarizePolygonPools(expiredOneYearPool, NOW_SECONDS).failures.join("\n"),
  /one-year oracle anchor is expired/,
);

const invalidHealthCounters = validPolygonPools();
invalidHealthCounters[0].healthTotalSeconds = "10";
invalidHealthCounters[0].healthBinarySeconds = "11";
assert.match(
  summarizePolygonPools(invalidHealthCounters, NOW_SECONDS).failures.join("\n"),
  /health binary seconds exceed total seconds/,
);

const unexpectedPolygonPool = validPolygonPools();
unexpectedPolygonPool.push({
  ...unexpectedPolygonPool[0],
  id: "137-0x0000000000000000000000000000000000000001",
});
assert.match(
  summarizePolygonPools(unexpectedPolygonPool, NOW_SECONDS).failures.join("\n"),
  /unexpected Polygon FPMMs/,
);

assert.deepEqual(
  summarizeProbe({
    data: {
      Pool: [{ id: "pool" }],
      SusdsYieldSummary: [{ id: "susds" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      SusdsYieldDailySnapshot: [],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  }),
  {
    rowCounts: {
      Pool: 1,
      SusdsYieldSummary: 1,
      SusdsYieldMovement: 1,
      SusdsYieldDailySnapshot: 0,
      StethYieldSummary: 1,
      StethYieldMovement: 1,
    },
    errors: [],
    missingTables: [],
    susdsSummaryNonzero: false,
    ok: true,
  },
);

assert.deepEqual(
  summarizeProbe({
    data: {
      Pool: [{ id: "pool" }],
      SusdsYieldSummary: [{ id: "susds", currentShares: "1" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      SusdsYieldDailySnapshot: [],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  }),
  {
    rowCounts: {
      Pool: 1,
      SusdsYieldSummary: 1,
      SusdsYieldMovement: 1,
      SusdsYieldDailySnapshot: 0,
      StethYieldSummary: 1,
      StethYieldMovement: 1,
    },
    errors: [],
    missingTables: ["SusdsYieldDailySnapshot"],
    susdsSummaryNonzero: true,
    ok: false,
  },
);

assert.deepEqual(
  summarizeProbe({
    errors: [{ message: "field not found" }],
    data: { Pool: [] },
  }),
  {
    rowCounts: {
      Pool: 0,
      SusdsYieldSummary: 0,
      SusdsYieldMovement: 0,
      SusdsYieldDailySnapshot: 0,
      StethYieldSummary: 0,
      StethYieldMovement: 0,
    },
    errors: ["field not found"],
    missingTables: [
      "Pool",
      "SusdsYieldSummary",
      "SusdsYieldMovement",
      "StethYieldSummary",
      "StethYieldMovement",
    ],
    susdsSummaryNonzero: false,
    ok: false,
  },
);

const summary = buildSummary({
  args: { allowSyncing: false },
  deployment: indexerJson.data.deployments[0],
  endpoint: indexerJson.data.deployments[0].gql_endpoint,
  endpointMode: "prod-static",
  statusJson: {
    data: [
      {
        chain_id: 1,
        block_height: 20,
        latest_processed_block: 20,
        num_events_processed: 1,
        timestamp_caught_up_to_head_or_endblock: "2026-07-03T12:00:00Z",
      },
    ],
  },
  metricsJson: { data: [] },
  graphqlJson: {
    data: {
      Pool: [{ id: "pool" }],
      PolygonPool: validPolygonPools(),
      SusdsYieldSummary: [{ id: "susds" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      SusdsYieldLaunchBaseline: [validSusdsLaunchBaseline()],
      SusdsYieldDailySnapshot: [{ id: "susds-day" }],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  },
  nowSeconds: NOW_SECONDS,
  replayIntegrityInput: VALID_REPLAY_INTEGRITY,
});

assert.equal(summary.ok, true);
assert.match(renderText(summary), /Result: verified/);
assert.match(renderText(summary), /Polygon oracle freshness: v3\/v3/);

const semanticFailureWhileSyncing = buildSummary({
  args: { allowSyncing: true },
  deployment: indexerJson.data.deployments[1],
  endpoint: indexerJson.data.deployments[1].gql_endpoint,
  endpointMode: "deployment",
  statusJson: {
    data: [
      {
        chain_id: 137,
        block_height: 100,
        latest_processed_block: 50,
        num_events_processed: 1,
        timestamp_caught_up_to_head_or_endblock: "",
      },
    ],
  },
  metricsJson: { data: [] },
  graphqlJson: {
    data: {
      Pool: [{ id: "non-polygon-core-row" }],
      PolygonPool: missingPolygonPool,
      SusdsYieldSummary: [{ id: "susds" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      SusdsYieldLaunchBaseline: [validSusdsLaunchBaseline()],
      SusdsYieldDailySnapshot: [{ id: "susds-day" }],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  },
  nowSeconds: NOW_SECONDS,
  replayIntegrityInput: VALID_REPLAY_INTEGRITY,
});
assert.equal(semanticFailureWhileSyncing.ok, false);
assert.match(
  semanticFailureWhileSyncing.failures.join("\n"),
  /missing Polygon FPMMs/,
);
assert.doesNotMatch(
  semanticFailureWhileSyncing.failures.join("\n"),
  /not caught up/,
);

const missingSampler = buildSummary({
  args: { allowSyncing: false },
  deployment: indexerJson.data.deployments[0],
  endpoint: indexerJson.data.deployments[0].gql_endpoint,
  endpointMode: "prod-static",
  statusJson: {
    data: [
      {
        chain_id: 1,
        block_height: 24_574_403,
        latest_processed_block: 24_574_403,
        num_events_processed: 1,
        timestamp_caught_up_to_head_or_endblock: "2026-07-03T12:00:00Z",
      },
    ],
  },
  metricsJson: { data: [] },
  graphqlJson: {
    data: {
      Pool: [{ id: "pool" }],
      PolygonPool: validPolygonPools(),
      SusdsYieldSummary: [
        { id: "susds", currentShares: "1", lastUpdatedBlock: "24574403" },
      ],
      SusdsYieldMovement: [{ id: "susds-move", blockNumber: "24574403" }],
      SusdsYieldLaunchBaseline: [validSusdsLaunchBaseline()],
      SusdsYieldDailySnapshot: [],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  },
  nowSeconds: NOW_SECONDS,
  replayIntegrityInput: VALID_REPLAY_INTEGRITY,
});
assert.equal(missingSampler.ok, false);
const missingSamplerText = renderText(missingSampler);
assert.match(
  missingSamplerText,
  /latest sampled block: -; processed Ethereum head: 24,574,403; block lag: -/,
);
assert.match(
  missingSamplerText,
  /latest sampled timestamp: -; age: - seconds; healthy: no/,
);

const baselineOnlySampler = buildSummary({
  args: { allowSyncing: false },
  deployment: indexerJson.data.deployments[0],
  endpoint: indexerJson.data.deployments[0].gql_endpoint,
  endpointMode: "prod-static",
  statusJson: {
    data: [
      {
        chain_id: 1,
        block_height: 24_574_403,
        latest_processed_block: 24_574_403,
        num_events_processed: 1,
        timestamp_caught_up_to_head_or_endblock: "2026-07-03T12:00:00Z",
      },
    ],
  },
  metricsJson: { data: [] },
  graphqlJson: {
    data: {
      Pool: [{ id: "pool" }],
      PolygonPool: validPolygonPools(),
      SusdsYieldSummary: [
        { id: "susds", currentShares: "1", lastUpdatedBlock: "24574403" },
      ],
      SusdsYieldMovement: [{ id: "susds-move", blockNumber: "24574403" }],
      SusdsYieldLaunchBaseline: [validSusdsLaunchBaseline()],
      SusdsYieldDailySnapshot: [
        {
          id: "susds-launch-day",
          sampledAtBlock: "24573203",
          sampledAtTimestamp: "1772496000",
        },
      ],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  },
  nowSeconds: NOW_SECONDS,
  replayIntegrityInput: VALID_REPLAY_INTEGRITY,
});
assert.equal(baselineOnlySampler.ok, false);
assert.equal(baselineOnlySampler.probe.rowCounts.SusdsYieldDailySnapshot, 1);
assert.match(
  baselineOnlySampler.failures.join("\n"),
  /sUSDS sampler.*(no post-launch progress|still the launch baseline|stale)/,
);

for (const lag of [0, 599]) {
  const healthySampler = summarizeSusdsSamplerProgress({
    summaryNonzero: true,
    latestSnapshot: {
      sampledAtBlock: "24573803",
      sampledAtTimestamp: String(NOW_SECONDS - 1_000),
    },
    ethereumChain: {
      processedBlock: 24_573_803 + lag,
    },
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(healthySampler.ok, true);
  assert.equal(healthySampler.blockLag, lag);
  assert.equal(healthySampler.ageSeconds, 1_000);
}

for (const lag of [600, 601]) {
  const staleSampler = summarizeSusdsSamplerProgress({
    summaryNonzero: true,
    latestSnapshot: {
      sampledAtBlock: "24573803",
      sampledAtTimestamp: String(NOW_SECONDS - 1_000),
    },
    ethereumChain: {
      processedBlock: 24_573_803 + lag,
    },
    nowSeconds: NOW_SECONDS,
  });
  assert.equal(staleSampler.ok, false);
  assert.match(staleSampler.failures.join("\n"), /sUSDS sampler is stale/);
}

const staleSampler = summarizeSusdsSamplerProgress({
  summaryNonzero: true,
  latestSnapshot: {
    sampledAtBlock: "24573803",
    sampledAtTimestamp: String(NOW_SECONDS - 1_000),
  },
  ethereumChain: {
    processedBlock: 24_573_803 + 601,
  },
  nowSeconds: NOW_SECONDS,
});
assert.equal(staleSampler.ok, false);
assert.match(staleSampler.failures.join("\n"), /sUSDS sampler is stale/);

const healthySummaryInput = {
  args: { allowSyncing: false },
  deployment: indexerJson.data.deployments[0],
  endpoint: indexerJson.data.deployments[0].gql_endpoint,
  endpointMode: "prod-static",
  statusJson: {
    data: [
      {
        chain_id: 1,
        block_height: 24_573_803,
        latest_processed_block: 24_573_803,
        num_events_processed: 1,
        timestamp_caught_up_to_head_or_endblock: "2026-07-03T12:00:00Z",
      },
    ],
  },
  metricsJson: { data: [] },
  graphqlJson: {
    data: {
      Pool: [{ id: "pool" }],
      PolygonPool: validPolygonPools(),
      SusdsYieldSummary: [{ id: "susds", currentShares: "1" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      SusdsYieldLaunchBaseline: [validSusdsLaunchBaseline()],
      SusdsYieldDailySnapshot: [
        {
          id: "susds-sample",
          sampledAtBlock: "24573803",
          sampledAtTimestamp: String(NOW_SECONDS - 1_000),
        },
      ],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  },
  nowSeconds: NOW_SECONDS,
  replayIntegrityInput: VALID_REPLAY_INTEGRITY,
};
const healthySummary = buildSummary(healthySummaryInput);
assert.equal(healthySummary.ok, true);
assert.match(
  renderText(healthySummary),
  /latest sampled block: 24,573,803; processed Ethereum head: 24,573,803; block lag: 0/,
);
assert.match(
  renderText(healthySummary),
  /sUSDS launch baseline:[\s\S]*launch block: 24,573,203; sampled block: 24,573,203; healthy: yes/,
);

const recentSnapshotWithoutLaunchBaseline = buildSummary({
  ...healthySummaryInput,
  graphqlJson: {
    data: {
      ...healthySummaryInput.graphqlJson.data,
      SusdsYieldLaunchBaseline: [],
    },
  },
});
assert.equal(recentSnapshotWithoutLaunchBaseline.susdsSampler.ok, true);
assert.equal(recentSnapshotWithoutLaunchBaseline.ok, false);
assert.match(
  recentSnapshotWithoutLaunchBaseline.failures.join("\n"),
  /launch baseline row 1-susds-launch is missing/,
);

const preBaselineRollbackSummary = buildSummary({
  ...healthySummaryInput,
  graphqlJson: {
    data: {
      ...healthySummaryInput.graphqlJson.data,
      SusdsYieldLaunchBaseline: undefined,
      SusdsYieldDailySnapshot: undefined,
    },
  },
  susdsLaunchBaselineSchema: summarizeSusdsLaunchBaselineSchema({
    value: "type SusdsYieldDailySnapshot { id: ID! }",
    readError: "",
  }),
});
assert.equal(preBaselineRollbackSummary.ok, true);
assert.equal(
  preBaselineRollbackSummary.susdsLaunchBaselineSchema.required,
  false,
);
assert.equal(
  "SusdsYieldDailySnapshot" in preBaselineRollbackSummary.probe.rowCounts,
  false,
);
assert.equal(preBaselineRollbackSummary.susdsSampler.ok, true);
assert.doesNotMatch(
  preBaselineRollbackSummary.failures.join("\n"),
  /sUSDS sampler|launch baseline|SusdsYieldDailySnapshot/,
);
assert.match(
  renderText(preBaselineRollbackSummary),
  /sUSDS launch baseline:\n {2}required by target schema: no/,
);
assert.match(
  renderText(preBaselineRollbackSummary),
  /sUSDS sampler progress:\n {2}required by target schema: no/,
);

const recentSnapshotWithInvalidLaunchBaseline = buildSummary({
  ...healthySummaryInput,
  graphqlJson: {
    data: {
      ...healthySummaryInput.graphqlJson.data,
      SusdsYieldLaunchBaseline: [
        {
          ...validSusdsLaunchBaseline(),
          launchBlock: "24573204",
        },
      ],
    },
  },
});
assert.equal(recentSnapshotWithInvalidLaunchBaseline.susdsSampler.ok, true);
assert.equal(recentSnapshotWithInvalidLaunchBaseline.ok, false);
assert.match(
  recentSnapshotWithInvalidLaunchBaseline.failures.join("\n"),
  /launch baseline launchBlock is 24573204; expected 24573203/,
);

const staleSamplerSummary = buildSummary({
  args: { allowSyncing: false },
  deployment: indexerJson.data.deployments[0],
  endpoint: indexerJson.data.deployments[0].gql_endpoint,
  endpointMode: "prod-static",
  statusJson: {
    data: [
      {
        chain_id: 1,
        block_height: 24_574_403,
        latest_processed_block: 24_574_403,
        num_events_processed: 1,
        timestamp_caught_up_to_head_or_endblock: "2026-07-03T12:00:00Z",
      },
    ],
  },
  metricsJson: { data: [] },
  graphqlJson: {
    data: {
      Pool: [{ id: "pool" }],
      PolygonPool: validPolygonPools(),
      SusdsYieldSummary: [{ id: "susds", currentShares: "1" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      SusdsYieldLaunchBaseline: [validSusdsLaunchBaseline()],
      SusdsYieldDailySnapshot: [
        {
          id: "susds-sample",
          sampledAtBlock: "24573803",
          sampledAtTimestamp: String(NOW_SECONDS - 1_000),
        },
      ],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  },
  nowSeconds: NOW_SECONDS,
  replayIntegrityInput: VALID_REPLAY_INTEGRITY,
});
assert.equal(staleSamplerSummary.ok, false);
assert.match(staleSamplerSummary.failures.join("\n"), /sUSDS sampler is stale/);

console.log("deploy-indexer-verify tests passed.");

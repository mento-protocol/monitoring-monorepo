#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildSummary,
  extractJsonValue,
  parseArgs,
  parseJsonOutput,
  renderText,
  resolveDeployment,
  resolveProdDeployment,
  summarizeProbe,
  summarizeStatus,
} from "./deploy-indexer-verify.mjs";

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
assert.equal(resolveProdDeployment(indexerJson)?.commit_hash, "abc1234");

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

assert.deepEqual(
  summarizeProbe({
    data: {
      Pool: [{ id: "pool" }],
      SusdsYieldSummary: [{ id: "susds" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  }),
  {
    rowCounts: {
      Pool: 1,
      SusdsYieldSummary: 1,
      SusdsYieldMovement: 1,
      StethYieldSummary: 1,
      StethYieldMovement: 1,
    },
    errors: [],
    missingTables: [],
    ok: true,
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
      SusdsYieldSummary: [{ id: "susds" }],
      SusdsYieldMovement: [{ id: "susds-move" }],
      StethYieldSummary: [{ id: "steth" }],
      StethYieldMovement: [{ id: "steth-move" }],
    },
  },
});

assert.equal(summary.ok, true);
assert.match(renderText(summary), /Result: verified/);

console.log("deploy-indexer-verify tests passed.");

#!/usr/bin/env node

import assert from "node:assert/strict";
import { resolveDeployment } from "./deploy-indexer-perf.mjs";

const deployments = [
  {
    commit_hash: "abc1234",
    created_time: "2026-07-03T10:00:00.000Z",
  },
  {
    commit_hash: "def5678",
    created_time: "2026-07-03T11:00:00.000Z",
  },
];

assert.equal(resolveDeployment(deployments, "")?.commit_hash, "def5678");
assert.equal(resolveDeployment(deployments, "def")?.commit_hash, "def5678");
assert.equal(
  resolveDeployment(deployments, "def567899999")?.commit_hash,
  "def5678",
);
assert.equal(resolveDeployment(deployments, "missing"), null);

assert.equal(
  resolveDeployment(
    [
      {
        commit_hash: "",
        created_time: "2026-07-03T12:00:00.000Z",
      },
      ...deployments,
    ],
    "",
  )?.commit_hash,
  "def5678",
);

assert.equal(
  resolveDeployment(
    [
      {
        commit_hash: null,
        created_time: "2026-07-03T12:00:00.000Z",
      },
    ],
    "1234567890",
  ),
  null,
);

assert.throws(
  () =>
    resolveDeployment(
      [
        {
          commit_hash: "abc1234",
          created_time: "2026-07-03T11:00:00.000Z",
        },
        {
          commit_hash: "abc5678",
          created_time: "2026-07-03T10:00:00.000Z",
        },
      ],
      "abc",
    ),
  /Ambiguous deployment commit abc/,
);

console.log("deploy-indexer-perf tests passed.");

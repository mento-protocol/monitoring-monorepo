import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEPLOY_WORKFLOWS,
  buildSlackPayload,
  classifyStalledRuns,
  formatDuration,
  isDeployQueueCandidate,
  summarizeJobs,
} from "./check-terraform-deploy-queue.mjs";

const now = new Date("2026-07-07T12:00:00Z");
const workflow = DEPLOY_WORKFLOWS[0];
const workflowYaml = readFileSync(
  new URL(
    "../.github/workflows/terraform-deploy-queue-watch.yml",
    import.meta.url,
  ),
  "utf8",
);

assert.match(
  workflowYaml,
  /vars\.TERRAFORM_APPLY_SLACK_CHANNEL == '#ci-operations' && '#deploys' \|\| vars\.TERRAFORM_APPLY_SLACK_CHANNEL \|\| '#deploys'/,
);

const staleQueuedRun = {
  id: 101,
  run_number: 42,
  status: "queued",
  event: "push",
  head_branch: "main",
  head_sha: "abcdef1234567890",
  created_at: "2026-07-07T10:30:00Z",
  html_url:
    "https://github.com/mento-protocol/monitoring-monorepo/actions/runs/101",
  triggering_actor: { login: "chapati23" },
};

assert.equal(formatDuration(59 * 60000), "59m");
assert.equal(formatDuration(125 * 60000), "2h 5m");

assert.equal(isDeployQueueCandidate(staleQueuedRun), true);
assert.equal(
  isDeployQueueCandidate({
    ...staleQueuedRun,
    event: "pull_request",
  }),
  false,
);
assert.equal(
  isDeployQueueCandidate({
    ...staleQueuedRun,
    event: "push",
    head_branch: "agent/example",
  }),
  false,
);
assert.equal(
  isDeployQueueCandidate({
    ...staleQueuedRun,
    status: "in_progress",
  }),
  false,
);

assert.deepEqual(
  summarizeJobs([
    { id: 1, started_at: null },
    { id: 2, started_at: "2026-07-07T10:35:00Z" },
  ]),
  { total: 2, started: 1 },
);

const runsByWorkflow = new Map([
  [
    workflow.workflowFile,
    [
      staleQueuedRun,
      {
        ...staleQueuedRun,
        id: 102,
        run_number: 43,
        created_at: "2026-07-07T11:30:00Z",
      },
      {
        ...staleQueuedRun,
        id: 103,
        run_number: 44,
        status: "waiting",
        created_at: "2026-07-07T09:00:00Z",
      },
    ],
  ],
]);
const jobsByRun = new Map([
  [101, []],
  [102, []],
  [103, [{ id: 1, started_at: "2026-07-07T09:05:00Z" }]],
]);

const stalledRuns = classifyStalledRuns({
  workflows: [workflow],
  runsByWorkflow,
  jobsByRun,
  now,
  staleMinutes: 60,
});

assert.equal(stalledRuns.length, 1);
assert.deepEqual(stalledRuns[0], {
  workflowName: "Governance Watchdog Infra",
  workflowFile: "governance-watchdog.yml",
  id: 101,
  runNumber: 42,
  status: "queued",
  event: "push",
  actor: "chapati23",
  branch: "main",
  sha: "abcdef1234567890",
  createdAt: "2026-07-07T10:30:00Z",
  ageMs: 90 * 60000,
  jobs: { total: 0, started: 0 },
  url: "https://github.com/mento-protocol/monitoring-monorepo/actions/runs/101",
});

const payload = buildSlackPayload({
  channel: "#ci-operations",
  repo: "mento-protocol/monitoring-monorepo",
  serverUrl: "https://github.com",
  watcherRunUrl:
    "https://github.com/mento-protocol/monitoring-monorepo/actions/runs/999",
  staleMinutes: 60,
  stalledRuns,
});

assert.equal(payload.channel, "#ci-operations");
assert.equal(
  payload.text,
  "Terraform deploy queue may be wedged: 1 stale run(s)",
);
assert.match(JSON.stringify(payload.blocks), /Governance Watchdog Infra #42/);
assert.match(JSON.stringify(payload.blocks), /abcdef1/);
assert.match(JSON.stringify(payload.blocks), /chapati23/);
assert.match(JSON.stringify(payload.blocks), /zero started jobs/);
assert.match(JSON.stringify(payload.blocks), /cancel-in-progress: false/);

console.log("check-terraform-deploy-queue tests passed");

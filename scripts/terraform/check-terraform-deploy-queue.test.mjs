import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_SLACK_CHANNEL,
  DEPLOY_WORKFLOWS,
  buildSlackPayload,
  classifyStalledRuns,
  formatDuration,
  isDeployQueueCandidate,
  main,
  summarizeJobs,
} from "./check-terraform-deploy-queue.mjs";

const now = new Date("2026-07-07T12:00:00Z");
const workflow = DEPLOY_WORKFLOWS[0];
const workflowYaml = readFileSync(
  new URL(
    "../../.github/workflows/terraform-deploy-queue-watch.yml",
    import.meta.url,
  ),
  "utf8",
);

assert.equal(DEFAULT_SLACK_CHANNEL, "#deploys");

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
    event: "workflow_dispatch",
  }),
  true,
);
assert.equal(
  isDeployQueueCandidate({
    ...staleQueuedRun,
    event: "workflow_dispatch",
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
  channel: "#deploys",
  repo: "mento-protocol/monitoring-monorepo",
  serverUrl: "https://github.com",
  watcherRunUrl:
    "https://github.com/mento-protocol/monitoring-monorepo/actions/runs/999",
  staleMinutes: 60,
  stalledRuns,
});

assert.equal(payload.channel, "#deploys");
assert.equal(
  payload.text,
  "Terraform deploy queue may be wedged: 1 stale run(s)",
);
assert.match(JSON.stringify(payload.blocks), /Governance Watchdog Infra #42/);
assert.match(JSON.stringify(payload.blocks), /abcdef1/);
assert.match(JSON.stringify(payload.blocks), /chapati23/);
assert.match(JSON.stringify(payload.blocks), /zero started jobs/);
assert.match(JSON.stringify(payload.blocks), /cancel-in-progress: false/);

// main(): fake GitHub + Slack transport. One stale run on the first deploy
// workflow, none on the rest; jobs list is empty (nothing started). main()
// uses the real clock (it takes no injectable `now`), so anchor to
// Date.now() rather than the fixture `now` above.
function createFakeFetch({ jobs = [], slackOk = true } = {}) {
  const staleRun = {
    ...staleQueuedRun,
    id: 201,
    run_number: 7,
    created_at: new Date(Date.now() - 2 * 60 * 60000).toISOString(),
  };
  let slackCalls = 0;

  const fetchImpl = async (url) => {
    const target = url instanceof URL ? url : new URL(url);
    if (target.hostname === "slack.com") {
      slackCalls += 1;
      return {
        ok: true,
        json: async () => ({
          ok: slackOk,
          error: slackOk ? undefined : "channel_not_found",
        }),
      };
    }
    const runsMatch = target.pathname.match(
      /\/actions\/workflows\/([^/]+)\/runs$/,
    );
    if (runsMatch) {
      const runs = runsMatch[1] === workflow.workflowFile ? [staleRun] : [];
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    }
    if (/\/actions\/runs\/\d+\/jobs$/.test(target.pathname)) {
      return { ok: true, json: async () => ({ jobs }) };
    }
    throw new Error(`unexpected fetch ${target.pathname}`);
  };

  return { fetchImpl, getSlackCalls: () => slackCalls };
}

const mainEnv = {
  GITHUB_REPOSITORY: "mento-protocol/monitoring-monorepo",
  GITHUB_TOKEN: "gh-test-token",
  SLACK_BOT_TOKEN: "xoxb-test",
};

// main(): a successful --dry-run report of a stalled run leaves the exit code
// untouched and never calls Slack.
{
  const beforeExitCode = process.exitCode;
  const { fetchImpl, getSlackCalls } = createFakeFetch();
  const result = await main(mainEnv, ["--dry-run"], fetchImpl);
  assert.equal(result.stalledRuns.length, 1);
  assert.equal(getSlackCalls(), 0);
  assert.equal(process.exitCode, beforeExitCode);
}

// main(): a successful normal-mode report of a stalled run posts to Slack
// once and leaves the exit code untouched.
{
  const beforeExitCode = process.exitCode;
  const { fetchImpl, getSlackCalls } = createFakeFetch();
  const result = await main(mainEnv, [], fetchImpl);
  assert.equal(result.stalledRuns.length, 1);
  assert.equal(getSlackCalls(), 1);
  assert.equal(process.exitCode, beforeExitCode);
}

// main(): a Slack `ok: false` response still rejects (genuine delivery
// failures must stay a hard error).
{
  const { fetchImpl } = createFakeFetch({ slackOk: false });
  await assert.rejects(
    main(mainEnv, [], fetchImpl),
    /Slack chat\.postMessage failed: channel_not_found/,
  );
}

console.log("check-terraform-deploy-queue tests passed");

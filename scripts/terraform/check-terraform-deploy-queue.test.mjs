import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_SLACK_CHANNEL,
  DEPLOY_WORKFLOWS,
  buildSlackPayload,
  classifyStalledRuns,
  formatDuration,
  githubJson,
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

// githubJson(): a transient 5xx is retried and the later success is returned.
{
  const statuses = [502, 200];
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async () => {
    const status = statuses[calls];
    calls += 1;
    return {
      ok: status === 200,
      status,
      text: async () => "Server Error",
      json: async () => ({ workflow_runs: [] }),
    };
  };
  const payload = await githubJson({
    fetchImpl,
    apiUrl: "https://api.github.test",
    githubToken: "gh-test-token",
    path: "repos/o/r/actions/workflows/x.yml/runs",
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(payload, { workflow_runs: [] });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
}

// githubJson(): a persistent 5xx still fails after the last attempt.
{
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 503, text: async () => "Unavailable" };
  };
  await assert.rejects(
    githubJson({
      fetchImpl,
      apiUrl: "https://api.github.test",
      githubToken: "gh-test-token",
      path: "repos/o/r/actions/runs/1/jobs",
      sleep: async () => {},
    }),
    /failed: 503 Unavailable/,
  );
  assert.equal(calls, 3);
}

// githubJson(): a 4xx other than 429 fails at once, without a retry.
{
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 404, text: async () => "Not Found" };
  };
  await assert.rejects(
    githubJson({
      fetchImpl,
      apiUrl: "https://api.github.test",
      githubToken: "gh-test-token",
      path: "repos/o/r/actions/runs/1/jobs",
      sleep: async () => {},
    }),
    /failed: 404 Not Found/,
  );
  assert.equal(calls, 1);
}

// githubJson(): rate limits (429, or 403 with rate-limit headers) wait for
// what GitHub asks; longer waits and plain 403s fail at once.
{
  const rateLimitCase = async ({ responses, nowMs = 1_000_000 }) => {
    const sleeps = [];
    let calls = 0;
    const fetchImpl = async () => {
      const { status, headers = {}, body = "Rate limited" } = responses[calls];
      calls += 1;
      return {
        ok: status === 200,
        status,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        text: async () => body,
        json: async () => ({ workflow_runs: [] }),
      };
    };
    const result = githubJson({
      fetchImpl,
      apiUrl: "https://api.github.test",
      githubToken: "gh-test-token",
      path: "repos/o/r/actions/workflows/x.yml/runs",
      sleep: async (ms) => sleeps.push(ms),
      nowMs: () => nowMs,
    });
    return { result, sleeps, calls: () => calls };
  };

  // 403 secondary limit with Retry-After: wait exactly that long.
  let run = await rateLimitCase({
    responses: [
      { status: 403, headers: { "retry-after": "5" } },
      { status: 200 },
    ],
  });
  assert.deepEqual(await run.result, { workflow_runs: [] });
  assert.deepEqual(run.sleeps, [5000]);

  // Exhausted primary limit: wait until X-RateLimit-Reset.
  run = await rateLimitCase({
    nowMs: 1_000_000,
    responses: [
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1030" },
      },
      { status: 200 },
    ],
  });
  assert.deepEqual(await run.result, { workflow_runs: [] });
  assert.deepEqual(run.sleeps, [30000]);

  // 429 naming no wait: the one-minute secondary-limit floor.
  run = await rateLimitCase({ responses: [{ status: 429 }, { status: 200 }] });
  assert.deepEqual(await run.result, { workflow_runs: [] });
  assert.deepEqual(run.sleeps, [60000]);

  // A rate limit asking for longer than the job can wait fails at once.
  run = await rateLimitCase({
    responses: [{ status: 429, headers: { "retry-after": "3600" } }],
  });
  await assert.rejects(run.result, /failed: 429 Rate limited/);
  assert.equal(run.calls(), 1);
  assert.deepEqual(run.sleeps, []);

  // A secondary limit with no rate-limit headers is known by its message:
  // the one-minute floor.
  run = await rateLimitCase({
    responses: [
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "4999" },
        body: '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}',
      },
      { status: 200 },
    ],
  });
  assert.deepEqual(await run.result, { workflow_runs: [] });
  assert.deepEqual(run.sleeps, [60000]);

  // A 403 without rate-limit headers or message is a permission error: no retry.
  run = await rateLimitCase({
    responses: [
      {
        status: 403,
        headers: { "x-ratelimit-remaining": "42" },
        body: '{"message":"Resource not accessible by integration"}',
      },
    ],
  });
  await assert.rejects(run.result, /failed: 403 .*Resource not accessible/);
  assert.equal(run.calls(), 1);
}

console.log("check-terraform-deploy-queue tests passed");

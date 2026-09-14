#!/usr/bin/env node
/**
 * Fixture tests for scripts/workflows/report-ci-reliability.mjs.
 * Run: `node --test scripts/workflows/report-ci-reliability.test.mjs`
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MARKER_PREFIX,
  markerFor,
  LABEL,
  DEFAULT_CAP_MINUTES,
  JOB_FANOUT_WORKFLOWS,
  workflowCaps,
  capFor,
  percentile,
  RUN_QUERY_WINDOWS,
  RUN_QUERY_SOFT_CAP,
  runQueryWindows,
  wallDurationPercentiles,
  summarizeRunRates,
  summarizeJobDurations,
  stepMinutesByTotal,
  capKills,
  nearCapJobs,
  failingStepRunRates,
  formatMarkdownReport,
  issueTitle,
  upsertReportIssue,
  collectCiHealthReport,
} from "./report-ci-reliability.mjs";

function withFixtureRoot(workflows, fn) {
  const root = mkdtempSync(join(tmpdir(), "ci-health-report-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(workflows)) {
    writeFileSync(join(dir, file), text, "utf8");
  }
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("workflowCaps keys by workflow name + job display name, defaulting to 360", () => {
  withFixtureRoot(
    {
      "ci.yml":
        "name: CI\njobs:\n  scripts:\n    name: Lint + test root scripts\n    timeout-minutes: 55\n  changes:\n    timeout-minutes: 2\n",
      "infra.yml": "name: Infra\njobs:\n  apply:\n    name: Apply\n",
    },
    (root) => {
      const caps = workflowCaps(root);
      assert.equal(capFor(caps, "CI", "Lint + test root scripts"), 55);
      assert.equal(capFor(caps, "CI", "changes"), 2);
      assert.equal(capFor(caps, "Infra", "Apply"), DEFAULT_CAP_MINUTES);
      assert.equal(capFor(caps, "Unknown", "Unknown"), DEFAULT_CAP_MINUTES);
    },
  );
});

test("workflowCaps falls back to the file name when `name:` is absent", () => {
  withFixtureRoot(
    { "no-name.yml": "jobs:\n  build:\n    timeout-minutes: 9\n" },
    (root) => {
      const caps = workflowCaps(root);
      assert.equal(capFor(caps, "no-name.yml", "build"), 9);
    },
  );
});

test("percentile: p50/p90 over a known set, and null for empty input", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 90), 9);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 50), 42);
});

test("wallDurationPercentiles: p50/p90 minutes for one workflow+event, ignores other workflows/events/missing timestamps", () => {
  const runs = [
    {
      workflow: "CI",
      event: "pull_request",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:05:00Z",
    },
    {
      workflow: "CI",
      event: "pull_request",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:10:00Z",
    },
    {
      workflow: "CI",
      event: "push",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T01:00:00Z",
    },
    {
      workflow: "Trunk",
      event: "pull_request",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T02:00:00Z",
    },
    {
      workflow: "CI",
      event: "pull_request",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: null,
    },
  ];
  const result = wallDurationPercentiles(runs, {
    workflow: "CI",
    event: "pull_request",
  });
  assert.equal(result.samples, 2);
  assert.equal(result.p50Minutes, 5);
  assert.equal(result.p90Minutes, 10);
});

test("wallDurationPercentiles: zero samples when nothing matches", () => {
  const result = wallDurationPercentiles([], {
    workflow: "CI",
    event: "pull_request",
  });
  assert.equal(result.samples, 0);
  assert.equal(result.p50Minutes, null);
});

test("runQueryWindows: splits the window into count contiguous, non-overlapping ranges covering start to now", () => {
  const since = "2026-08-15T00:00:00.000Z";
  const now = "2026-09-14T00:00:00.000Z";
  const windows = runQueryWindows(since, now, 5);
  assert.equal(windows.length, 5);
  assert.equal(windows[0][0], since);
  assert.equal(windows.at(-1)[1], now);
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(windows[i][0], windows[i - 1][1]);
  }
});

test("summarizeRunRates: attempt>1 rate and cancellation rate per workflow", () => {
  const runs = [
    { workflow: "CI", conclusion: "success", run_attempt: 1 },
    { workflow: "CI", conclusion: "success", run_attempt: 2 },
    { workflow: "CI", conclusion: "cancelled", run_attempt: 1 },
    { workflow: "CI", conclusion: "success", run_attempt: 1 },
    { workflow: "Trunk", conclusion: "success", run_attempt: 1 },
  ];
  const [ci, trunk] = summarizeRunRates(runs);
  assert.equal(ci.workflow, "CI");
  assert.equal(ci.runs, 4);
  assert.equal(ci.attemptGt1Rate, 0.25);
  assert.equal(ci.cancelRate, 0.25);
  assert.equal(trunk.runs, 1);
  assert.equal(trunk.attemptGt1Rate, 0);
});

test("summarizeRunRates treats a missing run_attempt as attempt 1", () => {
  const [row] = summarizeRunRates([{ workflow: "CI", conclusion: "success" }]);
  assert.equal(row.attemptGt1Rate, 0);
});

test("summarizeJobDurations: p50/p90 duration and queue time in minutes", () => {
  const jobs = [
    {
      workflow: "CI",
      name: "scripts",
      created_at: "2026-01-01T00:00:00Z",
      started_at: "2026-01-01T00:01:00Z",
      completed_at: "2026-01-01T00:11:00Z",
    },
    {
      workflow: "CI",
      name: "scripts",
      created_at: "2026-01-01T00:00:00Z",
      started_at: "2026-01-01T00:02:00Z",
      completed_at: "2026-01-01T00:22:00Z",
    },
  ];
  const [row] = summarizeJobDurations(jobs);
  assert.equal(row.workflow, "CI");
  assert.equal(row.job, "scripts");
  assert.equal(row.samples, 2);
  assert.equal(row.p50Minutes, 10);
  assert.equal(row.p90Minutes, 20);
  assert.equal(row.queueP50Minutes, 1);
  assert.equal(row.queueP90Minutes, 2);
});

test("summarizeJobDurations skips jobs with no started_at/completed_at", () => {
  const rows = summarizeJobDurations([{ workflow: "CI", name: "queued" }]);
  assert.deepEqual(rows, []);
});

test("stepMinutesByTotal: ranks CI steps by total minutes across jobs, ignores other workflows", () => {
  const jobs = [
    {
      workflow: "CI",
      name: "scripts",
      steps: [
        {
          name: "install",
          started_at: "2026-01-01T00:00:00Z",
          completed_at: "2026-01-01T00:02:00Z",
        },
        {
          name: "test",
          started_at: "2026-01-01T00:02:00Z",
          completed_at: "2026-01-01T00:30:00Z",
        },
      ],
    },
    {
      workflow: "Trunk",
      name: "check",
      steps: [
        {
          name: "install",
          started_at: "2026-01-01T00:00:00Z",
          completed_at: "2026-01-01T00:05:00Z",
        },
      ],
    },
  ];
  const rows = stepMinutesByTotal(jobs, { workflow: "CI" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].step, "scripts › test");
  assert.equal(rows[0].totalMinutes, 28);
  assert.equal(rows[0].executions, 1);
});

test("capKills: only cancelled/failed jobs at or above their own cap, using workflow+job key", () => {
  const caps = new Map([["CI::Version skew", 5]]);
  const jobs = [
    {
      workflow: "CI",
      name: "Version skew",
      conclusion: "cancelled",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:05:12Z",
    },
    {
      workflow: "CI",
      name: "Version skew",
      conclusion: "cancelled",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:03:00Z",
    },
    {
      workflow: "CI",
      name: "Version skew",
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:05:30Z",
    },
  ];
  const rows = capKills(jobs, caps);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].durationMinutes >= 5);
});

test("capKills does not misclassify a supersession cancellation well under the cap as a cap kill", () => {
  const caps = new Map([["CI::scripts", 55]]);
  const jobs = [
    {
      workflow: "CI",
      name: "scripts",
      conclusion: "cancelled",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:14:09Z",
    },
  ];
  assert.deepEqual(capKills(jobs, caps), []);
});

test("nearCapJobs: only successful jobs within the ratio of their cap", () => {
  const caps = new Map([["CI::Quality Checks", 5]]);
  const jobs = [
    {
      workflow: "CI",
      name: "Quality Checks",
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:04:36Z",
    },
    {
      workflow: "CI",
      name: "Quality Checks",
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:02:00Z",
    },
    {
      workflow: "CI",
      name: "Quality Checks",
      conclusion: "cancelled",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:04:36Z",
    },
  ];
  const rows = nearCapJobs(jobs, caps, 0.8);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job, "Quality Checks");
});

test("failingStepRunRates: counts distinct runs, not job records — one outage is one run", () => {
  const jobs = [
    {
      workflow: "CI",
      run_id: 1,
      steps: [{ name: "pnpm-install", conclusion: "failure" }],
    },
    {
      workflow: "CI",
      run_id: 1,
      steps: [{ name: "pnpm-install", conclusion: "failure" }],
    },
    {
      workflow: "CI",
      run_id: 2,
      steps: [{ name: "pnpm-install", conclusion: "success" }],
    },
    {
      workflow: "CI",
      run_id: 3,
      steps: [{ name: "playwright", conclusion: "failure" }],
    },
  ];
  const rows = failingStepRunRates(jobs, { workflow: "CI" });
  const byStep = Object.fromEntries(rows.map((r) => [r.step, r]));
  assert.equal(byStep["pnpm-install"].runs, 1);
  assert.equal(byStep["pnpm-install"].rate, 1 / 3);
  assert.equal(byStep.playwright.runs, 1);
});

test("formatMarkdownReport: every section renders with units, and empty sections say so", () => {
  const report = {
    windowStart: "2026-08-15T00:00:00Z",
    windowEnd: "2026-09-14T00:00:00Z",
    sampleInfo: [{ workflow: "CI", sampledRuns: 40, totalRuns: 1084 }],
    ciPullRequestWall: { samples: 854, p50Minutes: 5.67, p90Minutes: 8.43 },
    perWorkflow: [
      { workflow: "CI", runs: 1084, attemptGt1Rate: 0.059, cancelRate: 0.213 },
    ],
    perJobDuration: [
      {
        workflow: "CI",
        job: "scripts",
        samples: 40,
        p50Minutes: 5.6,
        p90Minutes: 8.4,
        queueP50Minutes: 0.2,
        queueP90Minutes: 1.1,
      },
    ],
    stepMinutes: [
      {
        step: "scripts › test",
        totalMinutes: 100.5,
        executions: 40,
        medianMinutes: 2.5,
      },
    ],
    capKills: [],
    nearCap: [],
    failingSteps: [],
  };
  const body = formatMarkdownReport(report);
  assert.match(body, /## CI health report/);
  assert.match(body, /2026-08-15 to 2026-09-14/);
  assert.match(body, /40 of 1084 pull_request runs/);
  assert.match(body, /p50 5\.7 min, p90 8\.4 min, over 854 runs/);
  assert.match(body, /5\.9%/);
  assert.match(body, /21\.3%/);
  assert.match(body, /8\.4 min/);
  assert.match(body, /None in the sample\./);
  assert.match(body, /No failing steps in the sample\./);
});

test("issueTitle uses the calendar month", () => {
  assert.equal(
    issueTitle("2026-09-14T00:00:00.000Z"),
    "CI health report (2026-09)",
  );
});

test("upsertReportIssue creates a new marked issue when none exists", async () => {
  const calls = [];
  const github = {
    paginate: async (_method, _params) => [],
    rest: {
      issues: {
        create: async (params) => {
          calls.push(["create", params]);
          return { data: { number: 7, html_url: "https://example/issues/7" } };
        },
      },
    },
  };
  const now = new Date("2026-09-14T00:00:00.000Z");
  const issue = await upsertReportIssue({
    github,
    owner: "o",
    repo: "r",
    body: "report body",
    now,
  });
  assert.equal(issue.number, 7);
  assert.equal(calls[0][0], "create");
  assert.match(
    calls[0][1].body,
    new RegExp(
      markerFor(now.toISOString()).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    ),
  );
  assert.deepEqual(calls[0][1].labels, [LABEL]);
});

test("upsertReportIssue updates the existing marked issue and reopens it", async () => {
  const calls = [];
  const now = new Date("2026-09-14T00:00:00.000Z");
  const github = {
    paginate: async () => [
      {
        number: 3,
        pull_request: undefined,
        body: `${markerFor(now.toISOString())}\nold report`,
      },
    ],
    rest: {
      issues: {
        update: async (params) => {
          calls.push(["update", params]);
          return { data: { number: 3, html_url: "https://example/issues/3" } };
        },
      },
    },
  };
  const issue = await upsertReportIssue({
    github,
    owner: "o",
    repo: "r",
    body: "new report body",
    now,
  });
  assert.equal(issue.number, 3);
  assert.equal(calls[0][1].issue_number, 3);
  assert.equal(calls[0][1].state, "open");
});

test("upsertReportIssue opens a new issue for a new month instead of overwriting last month's", async () => {
  const calls = [];
  const lastMonth = new Date("2026-08-14T00:00:00.000Z");
  const thisMonth = new Date("2026-09-14T00:00:00.000Z");
  const github = {
    paginate: async () => [
      {
        number: 3,
        pull_request: undefined,
        body: `${markerFor(lastMonth.toISOString())}\naugust report`,
      },
    ],
    rest: {
      issues: {
        create: async (params) => {
          calls.push(["create", params]);
          return {
            data: { number: 11, html_url: "https://example/issues/11" },
          };
        },
      },
    },
  };
  const issue = await upsertReportIssue({
    github,
    owner: "o",
    repo: "r",
    body: "september report",
    now: thisMonth,
  });
  assert.equal(issue.number, 11);
  assert.equal(calls[0][0], "create");
  assert.match(
    calls[0][1].body,
    new RegExp(
      MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "2026-09",
    ),
  );
});

test("upsertReportIssue ignores an issue carrying the label but not the marker", async () => {
  const github = {
    paginate: async () => [
      { number: 9, pull_request: undefined, body: "unrelated issue" },
    ],
    rest: {
      issues: {
        create: async () => ({
          data: { number: 10, html_url: "https://example/issues/10" },
        }),
      },
    },
  };
  const issue = await upsertReportIssue({
    github,
    owner: "o",
    repo: "r",
    body: "report body",
  });
  assert.equal(issue.number, 10);
});

test("collectCiHealthReport samples only JOB_FANOUT_WORKFLOWS and covers every run in the rate tables", async () => {
  await withFixtureRoot(
    {
      "ci.yml":
        "name: CI\njobs:\n  scripts:\n    name: Lint + test root scripts\n    timeout-minutes: 55\n",
    },
    async (root) => {
      const workflows = [
        { id: 1, name: "CI" },
        { id: 2, name: "Trunk" },
      ];
      const runsByWorkflow = {
        1: [
          {
            id: 101,
            event: "pull_request",
            conclusion: "success",
            run_attempt: 1,
          },
          {
            id: 102,
            event: "pull_request",
            conclusion: "cancelled",
            run_attempt: 1,
          },
        ],
        2: [{ id: 201, event: "push", conclusion: "success", run_attempt: 1 }],
      };
      const jobsByRun = {
        101: [
          {
            name: "Lint + test root scripts",
            conclusion: "success",
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2026-01-01T00:05:00Z",
            steps: [],
          },
        ],
      };
      const summaryLines = [];
      const github = {
        paginate: async (method, params) => {
          if (params.workflow_id !== undefined)
            return runsByWorkflow[params.workflow_id] ?? [];
          if (params.run_id !== undefined)
            return jobsByRun[params.run_id] ?? [];
          return workflows;
        },
        rest: {
          actions: {
            listRepoWorkflows: "listRepoWorkflows",
            listWorkflowRuns: "listWorkflowRuns",
            listJobsForWorkflowRun: "listJobsForWorkflowRun",
          },
          issues: {
            listForRepo: "listForRepo",
            create: async () => ({
              data: { number: 1, html_url: "https://example/issues/1" },
            }),
          },
        },
      };
      const context = { repo: { owner: "o", repo: "r" } };
      const core = {
        summary: {
          addRaw: (text) => (summaryLines.push(text), core.summary),
          write: async () => {},
        },
      };
      const result = await collectCiHealthReport({
        github,
        context,
        core,
        root,
      });

      assert.equal(result.issue.number, 1);
      assert.equal(
        result.report.perWorkflow.find((r) => r.workflow === "CI").runs,
        2,
      );
      assert.equal(
        result.report.perWorkflow.find((r) => r.workflow === "Trunk").runs,
        1,
      );
      // Trunk is not in JOB_FANOUT_WORKFLOWS, so no jobs call happened for it —
      // its runs contribute rates only, no duration/step/cap rows.
      assert.ok(
        !result.report.perJobDuration.some((r) => r.workflow === "Trunk"),
      );
      assert.equal(result.report.sampleInfo.length, 1);
      assert.equal(result.report.sampleInfo[0].workflow, "CI");
      // Fixture runs carry no created_at/updated_at, so the wall-duration
      // metric is wired through with zero samples rather than throwing.
      assert.equal(result.report.ciPullRequestWall.samples, 0);
      assert.ok(summaryLines.length === 1);
      assert.deepEqual([...JOB_FANOUT_WORKFLOWS], ["CI", "PR Description"]);
    },
  );
});

test("collectCiHealthReport samples only pull_request runs within CI, and requests every job attempt", async () => {
  await withFixtureRoot(
    { "ci.yml": "name: CI\njobs:\n  scripts:\n" },
    async (root) => {
      const workflows = [{ id: 1, name: "CI" }];
      const runsByWorkflow = {
        1: [
          {
            id: 101,
            event: "pull_request",
            conclusion: "success",
            run_attempt: 2,
          },
          { id: 102, event: "push", conclusion: "success", run_attempt: 1 },
        ],
      };
      const jobsForRunParams = [];
      const github = {
        paginate: async (_method, params) => {
          if (params.workflow_id !== undefined)
            return runsByWorkflow[params.workflow_id] ?? [];
          if (params.run_id !== undefined) {
            jobsForRunParams.push(params);
            // Only run 101 (pull_request) should ever be asked for.
            return params.run_id === 101
              ? [
                  {
                    name: "scripts",
                    conclusion: "success",
                    started_at: "2026-01-01T00:00:00Z",
                    completed_at: "2026-01-01T00:05:00Z",
                    steps: [],
                  },
                ]
              : [];
          }
          return workflows;
        },
        rest: {
          actions: {
            listRepoWorkflows: "l",
            listWorkflowRuns: "l",
            listJobsForWorkflowRun: "l",
          },
          issues: {
            listForRepo: "l",
            create: async () => ({ data: { number: 1, html_url: "u" } }),
          },
        },
      };
      const context = { repo: { owner: "o", repo: "r" } };
      const result = await collectCiHealthReport({
        github,
        context,
        core: undefined,
        root,
      });
      assert.equal(jobsForRunParams.length, 1);
      assert.equal(jobsForRunParams[0].run_id, 101);
      assert.equal(jobsForRunParams[0].filter, "all");
      assert.equal(result.report.sampleInfo[0].sampledRuns, 1);
      assert.equal(result.report.sampleInfo[0].totalRuns, 1);
      assert.equal(result.report.perJobDuration.length, 1);
    },
  );
});

test("collectCiHealthReport queries runs in RUN_QUERY_WINDOWS ranges and deduplicates a run returned by more than one window", async () => {
  await withFixtureRoot(
    { "ci.yml": "name: CI\njobs:\n  scripts:\n" },
    async (root) => {
      const workflows = [{ id: 1, name: "CI" }];
      const createdParams = [];
      const github = {
        paginate: async (_method, params) => {
          if (params.workflow_id !== undefined) {
            createdParams.push(params.created);
            // Every window "sees" the same run near its boundary, as GitHub
            // would for a run whose created_at sits in more than one range.
            return [
              {
                id: 101,
                event: "pull_request",
                conclusion: "success",
                run_attempt: 1,
              },
            ];
          }
          if (params.run_id !== undefined) return [];
          return workflows;
        },
        rest: {
          actions: {
            listRepoWorkflows: "l",
            listWorkflowRuns: "l",
            listJobsForWorkflowRun: "l",
          },
          issues: {
            listForRepo: "l",
            create: async () => ({ data: { number: 1, html_url: "u" } }),
          },
        },
      };
      const context = { repo: { owner: "o", repo: "r" } };
      const result = await collectCiHealthReport({
        github,
        context,
        core: undefined,
        root,
      });
      assert.equal(createdParams.length, RUN_QUERY_WINDOWS);
      assert.ok(createdParams.every((c) => /^.+\.\..+$/u.test(c)));
      assert.equal(
        result.report.perWorkflow.find((r) => r.workflow === "CI").runs,
        1,
      );
    },
  );
});

test("collectCiHealthReport bisects a range that reaches RUN_QUERY_SOFT_CAP instead of trusting it as complete", async () => {
  await withFixtureRoot(
    { "ci.yml": "name: CI\njobs:\n  scripts:\n" },
    async (root) => {
      const workflows = [{ id: 1, name: "CI" }];
      let queryCount = 0;
      const github = {
        paginate: async (_method, params) => {
          if (params.workflow_id !== undefined) {
            queryCount += 1;
            const [from, to] = params.created.split("..");
            const widthMs = Date.parse(to) - Date.parse(from);
            // The 5 outer RUN_QUERY_WINDOWS ranges are 6 days wide; a
            // bisected half is ~3 days. Only the wide, un-split range
            // reports a suspiciously full page, forcing exactly one split.
            if (widthMs > 4 * 86400000) {
              return Array.from({ length: RUN_QUERY_SOFT_CAP }, (_, i) => ({
                id: `${from}-full-${i}`,
                event: "pull_request",
                conclusion: "success",
                run_attempt: 1,
              }));
            }
            return [
              {
                id: `${from}-half`,
                event: "pull_request",
                conclusion: "success",
                run_attempt: 1,
              },
            ];
          }
          if (params.run_id !== undefined) return [];
          return workflows;
        },
        rest: {
          actions: {
            listRepoWorkflows: "l",
            listWorkflowRuns: "l",
            listJobsForWorkflowRun: "l",
          },
          issues: {
            listForRepo: "l",
            create: async () => ({ data: { number: 1, html_url: "u" } }),
          },
        },
      };
      const context = { repo: { owner: "o", repo: "r" } };
      const result = await collectCiHealthReport({
        github,
        context,
        core: undefined,
        root,
      });
      // One outer-window query plus two bisected-half queries, per window —
      // the full-width query's own 900 rows are discarded in favor of the
      // two halves, which is why the final count is 2 per window, not 900+2.
      assert.equal(queryCount, RUN_QUERY_WINDOWS * 3);
      assert.equal(
        result.report.perWorkflow.find((r) => r.workflow === "CI").runs,
        RUN_QUERY_WINDOWS * 2,
      );
    },
  );
});

#!/usr/bin/env node
/**
 * Monthly CI health report: reads the Actions runs/jobs API for the last 30
 * days -> per-workflow run/attempt/cancellation rates, per-job p50/p90
 * duration and queue, CI per-step total minutes ranked by total, and jobs
 * within 20% of their `timeout-minutes` cap. Publishes the job summary and
 * upserts one labeled issue, like file-size-watchlist-issue.mjs does.
 *
 * Runs as a `github-script` step (ci-reliability-report.yml; same shape as
 * collect-m6-canary.mjs), so pagination/auth come from the injected Octokit
 * client. Per-run job/step data costs one call per run, so it is sampled at
 * random, at most SAMPLE_PER_STRATUM `pull_request` runs, for the two
 * workflows in JOB_FANOUT_WORKFLOWS — `push`/`workflow_call` runs are a small,
 * uneven fraction of `CI`'s volume, so mixing them into one merged sample
 * would weight the rare event as heavily as the dominant one; per-workflow
 * run counts and rates still cover every event and every run.
 *
 * Caps are parsed from every workflow YAML file, keyed by workflow `name:` +
 * job `name:`. This does NOT import EXPECTED_TIMEOUTS from
 * check-ci-contract.mjs: that map is keyed by ci.yml job id, has no
 * display-name mapping, and does not cover other workflows. It also does not
 * use `js-yaml`, a devDependency: this module runs unmodified inside
 * `actions/github-script`, which never runs an install step, the same
 * constraint that keeps collect-m6-canary.mjs and
 * file-size-watchlist-issue.mjs dependency-free. Instead it scans the
 * two-space-indented shape every workflow in this repository uses: a
 * top-level `name:`, then `jobs:` with one job id per two-space level and a
 * flat field body one level deeper. A `name:` or `timeout-minutes:` elsewhere
 * (matrix data, step fields, `run:` bodies) sits at a different indent and is
 * ignored; an unparsed field falls back to the job id or DEFAULT_CAP_MINUTES,
 * so a workflow shape this scan does not expect degrades caps, not crashes.
 *
 * Tests exercise the pure functions with fixtures, no network:
 * `node --test scripts/workflows/report-ci-reliability.test.mjs`
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MARKER_PREFIX = "<!-- ci-health-report:monthly:";
// A marker keyed by calendar month, so a second run in the same month
// updates that month's issue while a new month opens its own issue instead
// of overwriting the previous month's history.
export const markerFor = (isoDate) =>
  `${MARKER_PREFIX}${isoDate.slice(0, 7)} -->`;
export const LABEL = "ci-health-report";
export const WINDOW_DAYS = 30;
export const DEFAULT_CAP_MINUTES = 360;
export const JOB_FANOUT_WORKFLOWS = new Set(["CI", "PR Description"]);
export const SAMPLE_PER_STRATUM = 60;
export const CAP_NEAR_RATIO = 0.8; // "within 20% of the cap"

const mins = (ms) => ms / 60000;

// prettier-ignore
function scalarAfter(line, key) {
  const match = new RegExp(`^${key}:\\s*(.*?)\\s*(?:#.*)?$`, "u").exec(line);
  return match ? match[1].replace(/^["']|["']$/gu, "") : null;
}

// prettier-ignore
function parseWorkflowCaps(text, fallbackName, caps) {
  let workflowName = fallbackName;
  let jobsIndent = null;
  let job = null;
  const flush = () => { if (job) caps.set(`${workflowName}::${job.name}`, job.cap ?? DEFAULT_CAP_MINUTES); };
  for (const raw of text.split(/\r?\n/u)) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (jobsIndent === null) {
      const name = indent === 0 ? scalarAfter(line, "name") : null;
      if (name) workflowName = name;
      if (indent === 0 && /^jobs:\s*(?:#.*)?$/u.test(line)) jobsIndent = 0;
      continue;
    }
    const jobKey = indent === jobsIndent + 2 ? /^([\w.-]+):\s*(?:#.*)?$/u.exec(line) : null;
    if (jobKey) { flush(); job = { name: jobKey[1], cap: null }; continue; }
    if (job && indent === jobsIndent + 4) {
      const name = scalarAfter(line, "name");
      if (name) job.name = name;
      const cap = scalarAfter(line, "timeout-minutes");
      if (cap && /^\d+$/u.test(cap)) job.cap = Number(cap);
    }
  }
  flush();
}

export function workflowCaps(root = process.cwd()) {
  const dir = join(root, ".github", "workflows");
  const caps = new Map();
  for (const file of readdirSync(dir)) {
    if (!/\.ya?ml$/u.test(file)) continue;
    parseWorkflowCaps(readFileSync(join(dir, file), "utf8"), file, caps);
  }
  return caps;
}

export const capFor = (caps, workflow, job) =>
  caps.get(`${workflow}::${job}`) ?? DEFAULT_CAP_MINUTES;

// prettier-ignore
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Whole-run wall-clock p50/p90 in minutes (`created_at` -> `updated_at`) for
 * one workflow's runs of one event, e.g. `CI` `pull_request` — the metric the
 * per-job duration table cannot answer, and the one the budget in
 * docs/pr-checklists/ci-workflow-gates.md compares month over month. Costs no
 * extra API call: both timestamps are already on every run-listing row.
 */
// prettier-ignore
export function wallDurationPercentiles(runs, { workflow, event }) {
  const durations = runs
    .filter((run) => run.workflow === workflow && run.event === event && run.created_at && run.updated_at)
    .map((run) => mins(Date.parse(run.updated_at) - Date.parse(run.created_at)));
  return { samples: durations.length, p50Minutes: percentile(durations, 50), p90Minutes: percentile(durations, 90) };
}

/** Per-workflow run count, attempt>1 rate, and cancellation rate (every run). */
// prettier-ignore
export function summarizeRunRates(runs) {
  const byWorkflow = new Map();
  for (const run of runs) {
    const b = byWorkflow.get(run.workflow) ?? { count: 0, attemptGt1: 0, cancelled: 0 };
    b.count += 1;
    if ((run.run_attempt ?? 1) > 1) b.attemptGt1 += 1;
    if (run.conclusion === "cancelled") b.cancelled += 1;
    byWorkflow.set(run.workflow, b);
  }
  return [...byWorkflow.entries()]
    .map(([workflow, b]) => ({ workflow, runs: b.count, attemptGt1Rate: b.count ? b.attemptGt1 / b.count : 0, cancelRate: b.count ? b.cancelled / b.count : 0 }))
    .sort((a, b) => b.runs - a.runs);
}

/** Per-job p50/p90 duration and queue time, from sampled job records. */
// prettier-ignore
export function summarizeJobDurations(jobs) {
  const byJob = new Map();
  for (const job of jobs) {
    if (!job.started_at || !job.completed_at) continue;
    const key = `${job.workflow}::${job.name}`;
    const bucket = byJob.get(key) ?? { durations: [], queues: [] };
    bucket.durations.push(mins(Date.parse(job.completed_at) - Date.parse(job.started_at)));
    if (job.created_at) bucket.queues.push(mins(Date.parse(job.started_at) - Date.parse(job.created_at)));
    byJob.set(key, bucket);
  }
  return [...byJob.entries()]
    .map(([key, { durations, queues }]) => {
      const [workflow, name] = key.split("::");
      return { workflow, job: name, samples: durations.length, p50Minutes: percentile(durations, 50), p90Minutes: percentile(durations, 90), queueP50Minutes: percentile(queues, 50), queueP90Minutes: percentile(queues, 90) };
    })
    .sort((a, b) => (b.p90Minutes ?? 0) - (a.p90Minutes ?? 0));
}

/** CI per-step total minutes, ranked by total, from sampled job records. */
// prettier-ignore
export function stepMinutesByTotal(jobs, { workflow }) {
  const totals = new Map();
  for (const job of jobs) {
    if (job.workflow !== workflow) continue;
    for (const step of job.steps ?? []) {
      if (!step.started_at || !step.completed_at) continue;
      const key = `${job.name} › ${step.name}`;
      const list = totals.get(key) ?? [];
      list.push(mins(Date.parse(step.completed_at) - Date.parse(step.started_at)));
      totals.set(key, list);
    }
  }
  return [...totals.entries()]
    .map(([step, durations]) => ({ step, totalMinutes: durations.reduce((a, b) => a + b, 0), executions: durations.length, medianMinutes: percentile(durations, 50) }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);
}

// prettier-ignore
function jobDuration(job) {
  const durationMinutes = mins(Date.parse(job.completed_at) - Date.parse(job.started_at));
  return { workflow: job.workflow, job: job.name, durationMinutes };
}

/**
 * Cancelled/failed jobs whose wall duration is at/above their own cap — a job
 * cannot exceed `timeout-minutes` except by being killed at it, so this is an
 * exact classifier, not a heuristic band, GIVEN the cap it is compared
 * against. `caps` is read from the current checkout, not from the workflow
 * revision each sampled run actually executed under, so a `timeout-minutes`
 * edit inside the 30-day window can misclassify the runs on the other side of
 * that edit. Accepted for an advisory, human-reviewed report: resolving each
 * run's own historical cap would cost one more API call per sampled run.
 */
// prettier-ignore
export function capKills(jobs, caps) {
  return jobs
    .filter((job) => ["cancelled", "failure"].includes(job.conclusion) && job.started_at && job.completed_at)
    .map((job) => ({ ...jobDuration(job), cap: capFor(caps, job.workflow, job.name) }))
    .filter((row) => row.durationMinutes >= row.cap);
}

/** Successful jobs that finished within `ratio` of their declared cap. */
// prettier-ignore
export function nearCapJobs(jobs, caps, ratio = CAP_NEAR_RATIO) {
  return jobs
    .filter((job) => job.conclusion === "success" && job.started_at && job.completed_at)
    .map((job) => ({ ...jobDuration(job), cap: capFor(caps, job.workflow, job.name) }))
    .filter((row) => row.cap > 0 && row.durationMinutes >= row.cap * ratio);
}

/**
 * Per-step failing-run rate, counted by DISTINCT RUN (not job record), so one
 * outage that fails many jobs in one run counts once, not once per job.
 */
// prettier-ignore
export function failingStepRunRates(jobs, { workflow }) {
  const runIds = new Set();
  const runFailingSteps = new Map();
  for (const job of jobs) {
    if (job.workflow !== workflow) continue;
    runIds.add(job.run_id);
    for (const step of job.steps ?? []) {
      if (step.conclusion !== "failure") continue;
      const set = runFailingSteps.get(job.run_id) ?? new Set();
      set.add(step.name);
      runFailingSteps.set(job.run_id, set);
    }
  }
  const totalRuns = runIds.size;
  const perStep = new Map();
  for (const set of runFailingSteps.values()) for (const name of set) perStep.set(name, (perStep.get(name) ?? 0) + 1);
  return [...perStep.entries()].map(([step, count]) => ({ step, runs: count, rate: totalRuns ? count / totalRuns : 0 })).sort((a, b) => b.runs - a.runs);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const durationText = (x) =>
  x === null || x === undefined ? "n/a" : `${x.toFixed(1)} min`;
const table = (header, rows, empty) =>
  rows.length === 0 ? empty : [header[0], header[1], ...rows].join("\n");

// prettier-ignore
export function formatMarkdownReport(report) {
  const sampleLine = report.sampleInfo.length
    ? `Per-job duration, step minutes, cap comparisons, and failing-step rates sample at most ${SAMPLE_PER_STRATUM} \`pull_request\` runs for ${[...JOB_FANOUT_WORKFLOWS].join(" and ")}: ${report.sampleInfo.map((s) => `${s.workflow} ${s.sampledRuns} of ${s.totalRuns} pull_request runs`).join(", ")}.`
    : "No sampled workflow matched the job-fanout list.";
  return [
    "## CI health report",
    "",
    `Window: ${report.windowStart.slice(0, 10)} to ${report.windowEnd.slice(0, 10)} (${WINDOW_DAYS} days).`,
    sampleLine,
    "",
    "### CI pull_request wall duration in minutes (every run, not sampled)",
    "",
    report.ciPullRequestWall.samples === 0
      ? "No `CI` `pull_request` runs in the window."
      : `p50 ${durationText(report.ciPullRequestWall.p50Minutes)}, p90 ${durationText(report.ciPullRequestWall.p90Minutes)}, over ${report.ciPullRequestWall.samples} runs. Compare this p90 to last month's report for the budget in docs/pr-checklists/ci-workflow-gates.md.`,
    "",
    "### Per-workflow run counts, attempt>1 rate, cancellation rate",
    "",
    table(["| Workflow | Runs | Attempt>1 rate | Cancellation rate |", "| --- | ---: | ---: | ---: |"], report.perWorkflow.map((r) => `| ${r.workflow} | ${r.runs} | ${pct(r.attemptGt1Rate)} | ${pct(r.cancelRate)} |`), "No runs in the window."),
    "",
    "### Per-job duration and queue time in minutes (sampled)",
    "",
    table(
      ["| Workflow | Job | Samples | p50 duration | p90 duration | p50 queue | p90 queue |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |"],
      report.perJobDuration.map((r) => `| ${r.workflow} | ${r.job} | ${r.samples} | ${durationText(r.p50Minutes)} | ${durationText(r.p90Minutes)} | ${durationText(r.queueP50Minutes)} | ${durationText(r.queueP90Minutes)} |`),
      "No sampled jobs.",
    ),
    "",
    "### CI step minutes, ranked by total (sampled, top 15)",
    "",
    table(["| Job › step | Total minutes | Executions | Median minutes |", "| --- | ---: | ---: | ---: |"], report.stepMinutes.slice(0, 15).map((r) => `| ${r.step} | ${r.totalMinutes.toFixed(1)} min | ${r.executions} | ${durationText(r.medianMinutes)} |`), "No sampled CI steps."),
    "",
    `### Jobs finishing within ${Math.round((1 - CAP_NEAR_RATIO) * 100)}% of their timeout-minutes cap (sampled, successful jobs only)`,
    "",
    table(["| Workflow | Job | Duration | Cap |", "| --- | --- | ---: | ---: |"], report.nearCap.map((r) => `| ${r.workflow} | ${r.job} | ${durationText(r.durationMinutes)} | ${r.cap} min |`), "None in the sample."),
    "",
    "### Cap-adjacent cancellations and failures (duration at or above the job's cap, sampled)",
    "",
    table(["| Workflow | Job | Duration | Cap |", "| --- | --- | ---: | ---: |"], report.capKills.map((r) => `| ${r.workflow} | ${r.job} | ${durationText(r.durationMinutes)} | ${r.cap} min |`), "None in the sample."),
    "",
    "### CI failing-step rate by distinct run (sampled, top 10)",
    "",
    table(["| Step | Runs | Rate |", "| --- | ---: | ---: |"], report.failingSteps.slice(0, 10).map((r) => `| ${r.step} | ${r.runs} | ${pct(r.rate)} |`), "No failing steps in the sample."),
    "",
  ].join("\n");
}

export const issueTitle = (isoDate) =>
  `CI health report (${isoDate.slice(0, 7)})`;

// prettier-ignore
export async function upsertReportIssue({ github, owner, repo, body, now = new Date() }) {
  const marker = markerFor(now.toISOString());
  const issues = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "all", labels: LABEL, per_page: 100 });
  const existing = issues.find((issue) => issue.pull_request === undefined && issue.body?.includes(marker));
  const payload = { title: issueTitle(now.toISOString()), body: `${marker}\n\n${body}`, labels: [LABEL] };
  if (existing) {
    const { data } = await github.rest.issues.update({ owner, repo, issue_number: existing.number, state: "open", ...payload });
    return data;
  }
  const { data } = await github.rest.issues.create({ owner, repo, ...payload });
  return data;
}

// prettier-ignore
function sampleRandom(list, size) {
  const pool = [...list];
  const sample = [];
  while (pool.length > 0 && sample.length < size) sample.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return sample;
}

export const RUN_QUERY_WINDOWS = 5; // 30 days / 5 keeps each `created` range well under GitHub's ~1,000-result cap

/**
 * Split [sinceIso, now] into `count` equal `created:from..to` ranges. A
 * single `created:>=sinceIso` query over 30 days can carry ~1,450 `CI` runs,
 * close enough to GitHub's practical per-query result cap that a busy month
 * could silently drop the oldest runs while this report claims full
 * coverage; querying in bounded ranges and merging keeps each request small
 * regardless of monthly volume.
 */
// prettier-ignore
export function runQueryWindows(sinceIso, nowIso = new Date().toISOString(), count = RUN_QUERY_WINDOWS) {
  const start = Date.parse(sinceIso), end = Date.parse(nowIso), step = (end - start) / count;
  return Array.from({ length: count }, (_, i) => [new Date(start + i * step).toISOString(), i === count - 1 ? nowIso : new Date(start + (i + 1) * step).toISOString()]);
}

export const RUN_QUERY_SOFT_CAP = 900; // bisect a range that gets this close to the practical per-query result cap
const RUN_QUERY_MIN_RANGE_MS = 3600000; // stop bisecting below one hour: below this, a real cap-hit is implausible
const RUN_QUERY_MAX_DEPTH = 4; // bisection depth bound so a pathological case cannot fan out unbounded requests

/**
 * Fetch one `created:from..to` range and bisect it if the result count gets
 * close enough to the practical per-query cap that older rows in that exact
 * range could be silently missing — a fixed window count alone cannot rule
 * this out during a burst (a dependency wave, a bot-driven spree) or future
 * volume growth.
 */
// prettier-ignore
async function fetchRunsForRange({ github, owner, repo, workflowId, from, to, depth = 0 }) {
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, { owner, repo, workflow_id: workflowId, created: `${from}..${to}`, per_page: 100 });
  if (runs.length < RUN_QUERY_SOFT_CAP || depth >= RUN_QUERY_MAX_DEPTH || Date.parse(to) - Date.parse(from) < RUN_QUERY_MIN_RANGE_MS) return runs;
  const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString();
  const [head, tail] = await Promise.all([
    fetchRunsForRange({ github, owner, repo, workflowId, from, to: mid, depth: depth + 1 }),
    fetchRunsForRange({ github, owner, repo, workflowId, from: mid, to, depth: depth + 1 }),
  ]);
  return [...head, ...tail];
}

// prettier-ignore
async function fetchRunsForWorkflow({ github, owner, repo, workflowId, workflowName, sinceIso, nowIso }) {
  const byId = new Map();
  for (const [from, to] of runQueryWindows(sinceIso, nowIso)) {
    const runs = await fetchRunsForRange({ github, owner, repo, workflowId, from, to });
    for (const run of runs) byId.set(run.id, { workflow: workflowName, event: run.event, conclusion: run.conclusion, run_attempt: run.run_attempt, id: run.id, created_at: run.created_at, updated_at: run.updated_at });
  }
  return [...byId.values()];
}

/**
 * Sample only `pull_request` runs, not every event mixed together: `CI` also
 * runs on `push` and `workflow_call`, at a fraction of the volume, and
 * independent per-event sampling (each stratum capped at `sampleSize`) would
 * otherwise weight a rare event as heavily as the dominant one once merged.
 * `filter: "all"` on the jobs call includes every attempt, not just the
 * latest — the API defaults to latest-only, which would hide the failed
 * first attempt of exactly the runs `run_attempt > 1` counts as retried.
 */
// prettier-ignore
async function fetchSampledJobs({ github, owner, repo, workflowName, runs, sampleSize }) {
  const pullRequestRuns = runs.filter((run) => run.event === "pull_request");
  const sampled = sampleRandom(pullRequestRuns, sampleSize);
  const jobs = [];
  for (const run of sampled) {
    const runJobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { owner, repo, run_id: run.id, filter: "all", per_page: 100 });
    for (const job of runJobs) jobs.push({ ...job, workflow: workflowName, run_id: run.id });
  }
  return { jobs, sampledRunCount: sampled.length, totalEventRuns: pullRequestRuns.length };
}

/**
 * Orchestrator invoked from the `github-script` step. `github`/`context` are
 * the injected Octokit client and event context; `core` is used only for the
 * job summary (optional so unit tests can omit it).
 */
// prettier-ignore
export async function collectCiHealthReport({ github, context, core, root = process.cwd() }) {
  const { owner, repo } = context.repo;
  const nowIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  const caps = workflowCaps(root);
  const workflows = await github.paginate(github.rest.actions.listRepoWorkflows, { owner, repo, per_page: 100 });

  const allRuns = [];
  const sampleInfo = [];
  const sampledJobs = [];
  for (const workflow of workflows) {
    const runs = await fetchRunsForWorkflow({ github, owner, repo, workflowId: workflow.id, workflowName: workflow.name, sinceIso, nowIso });
    allRuns.push(...runs);
    if (JOB_FANOUT_WORKFLOWS.has(workflow.name)) {
      const { jobs, sampledRunCount, totalEventRuns } = await fetchSampledJobs({ github, owner, repo, workflowName: workflow.name, runs, sampleSize: SAMPLE_PER_STRATUM });
      sampledJobs.push(...jobs);
      sampleInfo.push({ workflow: workflow.name, sampledRuns: sampledRunCount, totalRuns: totalEventRuns });
    }
  }

  const report = {
    windowStart: sinceIso,
    windowEnd: nowIso,
    sampleInfo,
    ciPullRequestWall: wallDurationPercentiles(allRuns, { workflow: "CI", event: "pull_request" }),
    perWorkflow: summarizeRunRates(allRuns),
    perJobDuration: summarizeJobDurations(sampledJobs),
    stepMinutes: stepMinutesByTotal(sampledJobs, { workflow: "CI" }),
    capKills: capKills(sampledJobs, caps),
    nearCap: nearCapJobs(sampledJobs, caps),
    failingSteps: failingStepRunRates(sampledJobs, { workflow: "CI" }),
  };

  const body = formatMarkdownReport(report);
  if (core?.summary) await core.summary.addRaw(body).write();
  const issue = await upsertReportIssue({ github, owner, repo, body });
  return { issue: issue ? { number: issue.number, url: issue.html_url } : null, report };
}

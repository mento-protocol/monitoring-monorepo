#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const candidatePath = path.join(
  repositoryRoot,
  ".github/workflows/dependabot-auto-merge-candidate.yml",
);
const writerPath = path.join(
  repositoryRoot,
  ".github/workflows/dependabot-auto-merge.yml",
);
const candidate = loadYaml(readFileSync(candidatePath, "utf8"));
const writer = loadYaml(readFileSync(writerPath, "utf8"));

assert.deepEqual(candidate.concurrency, {
  group:
    "dependabot-auto-merge-candidate-${{ github.event.pull_request.head.repo.full_name }}-${{ github.event.pull_request.number }}",
  "cancel-in-progress": true,
});
assert.deepEqual(writer.concurrency, {
  group:
    "dependabot-auto-merge-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}",
  "cancel-in-progress": true,
});
assert.match(
  writer.jobs["auto-merge"].if,
  /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/u,
);

function stepScript(job, stepName) {
  assert(Array.isArray(job?.steps), `job for ${stepName} must contain steps`);
  const matches = job.steps.filter((step) => step.name === stepName);
  assert.equal(matches.length, 1, `step ${stepName} must exist exactly once`);
  assert.equal(
    typeof matches[0].run,
    "string",
    `step ${stepName} must run a script`,
  );
  return matches[0].run;
}

const candidateEventScript = stepScript(
  candidate.jobs.classify,
  "Validate candidate event",
);
const candidateDependencyScript = stepScript(
  candidate.jobs.classify,
  "Mark routine update eligible",
);
const writerScript = stepScript(
  writer.jobs["auto-merge"],
  "Merge the verified head after required checks",
);

const expectedRepository = "mento-protocol/monitoring-monorepo";
const workflowIdentity = {
  id: 99181,
  name: "Dependabot auto-merge candidate",
  path: ".github/workflows/dependabot-auto-merge-candidate.yml",
  state: "active",
};

function runCandidateEvent(headRef) {
  return spawnSync("bash", ["-c", candidateEventScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_REPOSITORY: expectedRepository,
      EVENT_REPOSITORY: expectedRepository,
      EVENT_ACTOR: "dependabot[bot]",
      EVENT_TRIGGERING_ACTOR: "dependabot[bot]",
      EVENT_AUTHOR: "dependabot[bot]",
      EVENT_BASE_REPOSITORY: expectedRepository,
      EVENT_BASE_REF: "main",
      EVENT_HEAD_REPOSITORY: expectedRepository,
      EVENT_HEAD_REF: headRef,
      EVENT_RUN_ATTEMPT: "1",
    },
  });
}

function runDependencyCheck(dependencyNames) {
  return spawnSync("bash", ["-c", candidateDependencyScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, DEPENDENCY_NAMES: dependencyNames },
  });
}

function successfulJob(runId, headSha) {
  return {
    name: "classify",
    run_id: runId,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    steps: [
      { name: "Validate candidate event", conclusion: "success" },
      {
        name: "Fetch verified Dependabot metadata",
        conclusion: "success",
      },
      { name: "Mark routine update eligible", conclusion: "success" },
    ],
  };
}

function pullRequest(number, headRef, headSha, changedFiles, commitCount) {
  return {
    number,
    state: "open",
    draft: false,
    body: "Bumps the routine GitHub Actions dependency group.",
    user: { login: "dependabot[bot]" },
    base: { ref: "main", repo: { full_name: expectedRepository } },
    head: {
      ref: headRef,
      sha: headSha,
      label: `mento-protocol:${headRef}`,
      repo: {
        full_name: expectedRepository,
        owner: { login: "mento-protocol" },
      },
    },
    commits: commitCount,
    changed_files: changedFiles.length,
  };
}

function commit(sha, author = "dependabot[bot]") {
  return {
    sha,
    author: { login: author },
    commit: { verification: { verified: true } },
  };
}

function scenario({
  number,
  runId,
  headRef,
  headSha,
  commits,
  files,
  reportedCommitCount = commits.length,
}) {
  const pr = pullRequest(number, headRef, headSha, files, reportedCommitCount);
  return {
    workflow: workflowIdentity,
    run: {
      id: runId,
      repository: { full_name: expectedRepository },
      head_repository: { full_name: expectedRepository },
      workflow_id: workflowIdentity.id,
      name: workflowIdentity.name,
      path: workflowIdentity.path,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      actor: { login: "dependabot[bot]" },
      triggering_actor: { login: "dependabot[bot]" },
      head_branch: headRef,
      head_sha: headSha,
      head_commit: { id: headSha },
    },
    jobsPages: [{ total_count: 1, jobs: [successfulJob(runId, headSha)] }],
    prPages: [[{ number }]],
    pr,
    historyPages: [
      [
        {
          id: 8400,
          event: "labeled",
          actor: { login: "dependabot[bot]" },
          created_at: "2026-08-30T09:00:00Z",
        },
      ],
    ],
    commitsPages: [commits],
    filesPages: [files.map((filename) => ({ filename, status: "modified" }))],
    queue: { data: { repository: { mergeQueue: null } } },
    requiredChecks: [
      { bucket: "pass", name: "ci", state: "SUCCESS" },
      { bucket: "pass", name: "Code Quality", state: "SUCCESS" },
      { bucket: "pass", name: "Vercel", state: "SUCCESS" },
      {
        bucket: "pass",
        name: "Vercel Preview Comments",
        state: "SUCCESS",
      },
    ],
    merge: {
      merged: true,
      message: "Pull Request successfully merged",
      sha: "deed9d4ca110580eefa54d565390d116acdf0dc4",
    },
  };
}

const mockGhSource = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const fixture = JSON.parse(readFileSync(process.env.MOCK_GH_SCENARIO, "utf8"));
const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(JSON.stringify(value));
const route = args.find((arg) => arg.startsWith("repos/"));
const isMerge =
  args[0] === "api" &&
  args.includes("--method") &&
  args.includes("PUT") &&
  /\\/pulls\\/[^/]+\\/merge$/u.test(route ?? "");
const token = process.env.GH_TOKEN ?? "";
appendFileSync(
  process.env.MOCK_GH_CALL_LOG,
  JSON.stringify({ args, token }) + "\\n",
);
if (isMerge) {
  if (token !== process.env.MOCK_EXPECTED_MERGE_TOKEN) process.exit(93);
} else if (token !== process.env.MOCK_EXPECTED_READ_TOKEN) {
  process.exit(94);
}
const state = JSON.parse(readFileSync(process.env.MOCK_GH_STATE, "utf8"));
function take(key) {
  const index = state[key] ?? 0;
  state[key] = index + 1;
  writeFileSync(process.env.MOCK_GH_STATE, JSON.stringify(state));
  const sequence = fixture[key + "Sequence"];
  return Array.isArray(sequence)
    ? sequence[Math.min(index, sequence.length - 1)]
    : fixture[key];
}
if (args[0] === "pr" && args[1] === "merge") process.exit(95);
if (args[0] === "pr" && args[1] === "checks") {
  if (args.includes("--watch")) {
    process.stdout.write("required checks completed\\n");
    process.exit(fixture.requiredChecksWatchExit ?? 0);
  }
  if (args.includes("--json")) {
    emit(take("requiredChecks"));
    process.exit(0);
  }
  process.exit(96);
}
if (args[0] !== "api") process.exit(91);
if (isMerge) {
  writeFileSync(
    process.env.MOCK_GH_MERGE_MARKER,
    JSON.stringify({ args, token }),
  );
  emit(fixture.merge);
  process.exit(fixture.mergeExit ?? 0);
}
if (args[1] === "graphql") {
  emit(take("queue"));
  process.exit(0);
}
if (route?.includes("/actions/workflows/")) emit(take("workflow"));
else if (route?.includes("/attempts/1/jobs")) emit(take("jobsPages"));
else if (route?.includes("/actions/runs/")) emit(take("run"));
else if (route?.includes("/issues/") && route?.endsWith("/events")) {
  if ((fixture.historyExit ?? 0) !== 0) process.exit(fixture.historyExit);
  emit(take("historyPages"));
}
else if (/\\/pulls\\/[^/]+\\/commits$/u.test(route ?? "")) emit(take("commitsPages"));
else if (/\\/pulls\\/[^/]+\\/files$/u.test(route ?? "")) emit(take("filesPages"));
else if (/\\/pulls\\/[^/]+$/u.test(route ?? "")) emit(take("pr"));
else if (route?.endsWith("/pulls")) emit(take("prPages"));
else process.exit(92);
`;

function runWriter(fixture) {
  const scratch = mkdtempSync(path.join(tmpdir(), "dependabot-merge-test-"));
  try {
    const ghPath = path.join(scratch, "gh");
    const scenarioPath = path.join(scratch, "scenario.json");
    const statePath = path.join(scratch, "state.json");
    const callLogPath = path.join(scratch, "calls.jsonl");
    const mergeMarker = path.join(scratch, "merge-called.txt");
    writeFileSync(ghPath, mockGhSource);
    chmodSync(ghPath, 0o755);
    writeFileSync(scenarioPath, JSON.stringify(fixture));
    writeFileSync(statePath, "{}");
    writeFileSync(callLogPath, "");
    const result = spawnSync("bash", ["-c", writerScript], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH}`,
        GITHUB_REPOSITORY: expectedRepository,
        GH_READ_TOKEN: "read-token",
        FINAL_MERGE_TOKEN: "merge-token",
        RUN_ID: String(fixture.run.id),
        MOCK_GH_SCENARIO: scenarioPath,
        MOCK_GH_STATE: statePath,
        MOCK_GH_CALL_LOG: callLogPath,
        MOCK_GH_MERGE_MARKER: mergeMarker,
        MOCK_EXPECTED_READ_TOKEN: "read-token",
        MOCK_EXPECTED_MERGE_TOKEN: "merge-token",
      },
    });
    const merged = existsSync(mergeMarker);
    const calls = readFileSync(callLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const mergeRequest = merged
      ? JSON.parse(readFileSync(mergeMarker, "utf8"))
      : null;
    return { ...result, calls, merged, mergeRequest };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function callsMatching(result, predicate) {
  return result.calls.filter(({ args }) => predicate(args));
}

function routeCalls(result, suffix) {
  return callsMatching(result, (args) =>
    args.some((arg) => arg.startsWith("repos/") && arg.endsWith(suffix)),
  );
}

const pr1872HeadRef =
  "dependabot/github_actions/actions-minor-patch-8914abacb8";
const pr1872Head = "93f0e6f803be170fd694425c192cbf3406414a7d";
const pr1872Files = [
  ".github/workflows/ci.yml",
  ".github/workflows/lighthouse.yml",
  ".github/workflows/mutation-testing.yml",
  ".github/workflows/schema-diff.yml",
  ".github/workflows/size-limit.yml",
];
assert.equal(
  runCandidateEvent(pr1872HeadRef).status,
  0,
  "PR #1872 must satisfy the candidate event identity",
);
assert.equal(
  runDependencyCheck("actions/cache").status,
  0,
  "a routine GitHub-owned action must pass the publisher check",
);
for (const excluded of [
  "actions/create-github-app-token",
  "Actions/Create-GitHub-App-Token",
  "re-actors/alls-green",
  "google-github-actions/auth",
  "hashicorp/setup-terraform",
  "anthropics/claude-code-action",
  "Anthropics/Claude-Code-Action",
  "dependabot/fetch-metadata",
]) {
  assert.notEqual(
    runDependencyCheck(excluded).status,
    0,
    `${excluded} must stay outside routine auto-merge`,
  );
}
const pr1872Result = runWriter(
  scenario({
    number: 1872,
    runId: 31995129967,
    headRef: pr1872HeadRef,
    headSha: pr1872Head,
    commits: [commit(pr1872Head)],
    files: pr1872Files,
  }),
);
assert.equal(
  pr1872Result.status,
  0,
  `PR #1872 safe historical shape must pass:\n${pr1872Result.stdout}\n${pr1872Result.stderr}`,
);
assert(pr1872Result.merged, "PR #1872 safe shape must reach the merge command");
const pr1872MergeCalls = routeCalls(pr1872Result, "/pulls/1872/merge");
assert.equal(
  pr1872MergeCalls.length,
  1,
  "the writer must make one final merge write",
);
assert.equal(
  pr1872Result.mergeRequest.token,
  "merge-token",
  "only the final write must use the future dedicated-App token seam",
);
assert(
  pr1872Result.mergeRequest.args.includes("PUT"),
  "the final write must use the synchronous REST merge endpoint",
);
assert(
  pr1872Result.mergeRequest.args.includes(`sha=${pr1872Head}`),
  "the synchronous REST merge must pin the verified PR head",
);
assert(
  pr1872Result.mergeRequest.args.includes("merge_method=squash"),
  "the synchronous REST merge must use the repository squash policy",
);
assert(
  !pr1872Result.calls.some(
    ({ args }) => args[0] === "pr" && args[1] === "merge",
  ),
  "the writer must not use gh pr merge, which can enable auto-merge or enqueue",
);
assert(
  !pr1872Result.calls.some(({ args }) => args.includes("--auto")),
  "the writer must never create a standing auto-merge request",
);
for (const { args, token } of pr1872Result.calls) {
  const finalMerge = args.some((arg) => arg.endsWith("/pulls/1872/merge"));
  assert.equal(
    token,
    finalMerge ? "merge-token" : "read-token",
    "the dedicated-App seam must be scoped to the final REST write",
  );
}

const requiredCheckCalls = callsMatching(
  pr1872Result,
  (args) => args[0] === "pr" && args[1] === "checks",
);
assert.equal(
  requiredCheckCalls.length,
  2,
  "the writer must wait for required checks and then read their final state",
);
assert(
  requiredCheckCalls[0].args.includes("--watch") &&
    requiredCheckCalls[0].args.includes("--fail-fast") &&
    requiredCheckCalls[0].args.includes("--required"),
  "the first required-check call must wait and fail fast",
);
assert(
  requiredCheckCalls[1].args.includes("--json") &&
    requiredCheckCalls[1].args.includes("--required"),
  "the second required-check call must prove the terminal required-only state",
);

for (const [label, count] of [
  [
    "workflow identity",
    routeCalls(
      pr1872Result,
      "/actions/workflows/dependabot-auto-merge-candidate.yml",
    ).length,
  ],
  [
    "classifier run",
    routeCalls(pr1872Result, "/actions/runs/31995129967").length,
  ],
  ["classifier jobs", routeCalls(pr1872Result, "/attempts/1/jobs").length],
  ["PR lookup", routeCalls(pr1872Result, "/pulls").length],
  ["PR state", routeCalls(pr1872Result, "/pulls/1872").length],
  ["close history", routeCalls(pr1872Result, "/issues/1872/events").length],
  ["commit list", routeCalls(pr1872Result, "/pulls/1872/commits").length],
  ["file list", routeCalls(pr1872Result, "/pulls/1872/files").length],
  [
    "merge queue",
    callsMatching(
      pr1872Result,
      (args) => args[0] === "api" && args[1] === "graphql",
    ).length,
  ],
]) {
  assert.equal(
    count,
    2,
    `${label} must be proved before and after required-check waiting`,
  );
}

const closeHistoryCalls = routeCalls(pr1872Result, "/issues/1872/events");
for (const { args } of closeHistoryCalls) {
  assert(
    args.includes("--method") &&
      args.includes("GET") &&
      args.includes("--paginate") &&
      args.includes("--slurp") &&
      args.includes("per_page=100"),
    "every close-history proof must use a paginated read-only request",
  );
}

for (const [label, jobsPages] of [
  ["missing total_count", [{ jobs: [successfulJob(31995129967, pr1872Head)] }]],
  [
    "malformed total_count",
    [{ total_count: "1", jobs: [successfulJob(31995129967, pr1872Head)] }],
  ],
  [
    "unsafe total_count",
    [{ total_count: 1.5, jobs: [successfulJob(31995129967, pr1872Head)] }],
  ],
  [
    "mismatched total_count",
    [{ total_count: 2, jobs: [successfulJob(31995129967, pr1872Head)] }],
  ],
  ["malformed jobs page", [[successfulJob(31995129967, pr1872Head)]]],
]) {
  const fixture = scenario({
    number: 1872,
    runId: 31995129967,
    headRef: pr1872HeadRef,
    headSha: pr1872Head,
    commits: [commit(pr1872Head)],
    files: pr1872Files,
  });
  fixture.jobsPages = jobsPages;
  const result = runWriter(fixture);
  assert.notEqual(
    result.status,
    0,
    `a classifier job page with ${label} must refuse`,
  );
  assert(
    result.stdout.includes(
      "The classifier attempt does not have the exact successful job shape.",
    ),
    `job-page metadata failure must be explicit for ${label}:\n${result.stdout}\n${result.stderr}`,
  );
  assert(
    !result.merged,
    `a classifier job page with ${label} must not reach merge`,
  );
}

const failedCheckFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
failedCheckFixture.requiredChecksWatchExit = 1;
const failedCheckResult = runWriter(failedCheckFixture);
assert.notEqual(
  failedCheckResult.status,
  0,
  "a failed required check must refuse",
);
assert(
  failedCheckResult.stdout.includes(
    "A required pull-request check failed or did not complete.",
  ),
  `required-check failure must be explicit:\n${failedCheckResult.stdout}\n${failedCheckResult.stderr}`,
);
assert(
  !failedCheckResult.merged,
  "failed required checks must not reach merge",
);

const emptyCheckFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
emptyCheckFixture.requiredChecks = [];
const emptyCheckResult = runWriter(emptyCheckFixture);
assert.notEqual(
  emptyCheckResult.status,
  0,
  "an empty required-check projection must refuse",
);
assert(
  emptyCheckResult.stdout.includes(
    "Every required pull-request check must pass.",
  ),
  `empty required-check state must fail closed:\n${emptyCheckResult.stdout}\n${emptyCheckResult.stderr}`,
);
assert(!emptyCheckResult.merged, "an empty check set must not reach merge");

const maintainerPushFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
maintainerPushFixture.prSequence = [
  maintainerPushFixture.pr,
  {
    ...maintainerPushFixture.pr,
    head: {
      ...maintainerPushFixture.pr.head,
      sha: "7b2ee8ef06eb247108d4769cfcf9ec39effd4671",
    },
    commits: 2,
  },
];
const maintainerPushResult = runWriter(maintainerPushFixture);
assert.notEqual(
  maintainerPushResult.status,
  0,
  "a maintainer push during required-check waiting must refuse",
);
assert(
  maintainerPushResult.stdout.includes(
    "The current pull request does not match the verified run.",
  ),
  `a changed head must fail the repeated PR proof:\n${maintainerPushResult.stdout}\n${maintainerPushResult.stderr}`,
);
assert(
  !maintainerPushResult.merged,
  "a later maintainer head must not reach the exact-head merge",
);

const maintainerBodyFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
maintainerBodyFixture.prSequence = [
  maintainerBodyFixture.pr,
  {
    ...maintainerBodyFixture.pr,
    body: `${maintainerBodyFixture.pr.body}\n\nMaintainer changes`,
  },
];
const maintainerBodyResult = runWriter(maintainerBodyFixture);
assert.notEqual(
  maintainerBodyResult.status,
  0,
  "a same-head maintainer-change body edit during required-check waiting must refuse",
);
assert(
  maintainerBodyResult.stdout.includes(
    "The current pull request reports maintainer changes.",
  ),
  `a current-body maintainer-change marker must fail the repeated PR proof:\n${maintainerBodyResult.stdout}\n${maintainerBodyResult.stderr}`,
);
assert(
  !maintainerBodyResult.merged,
  "a same-head maintainer-change body edit must not reach merge",
);

for (const event of ["closed", "reopened"]) {
  const priorCloseFixture = scenario({
    number: 1872,
    runId: 31995129967,
    headRef: pr1872HeadRef,
    headSha: pr1872Head,
    commits: [commit(pr1872Head)],
    files: pr1872Files,
  });
  priorCloseFixture.historyPages = [
    [
      {
        id: 8411,
        event,
        actor: { login: "chapati23" },
        created_at: "2026-08-30T10:00:00Z",
      },
    ],
  ];
  const priorCloseResult = runWriter(priorCloseFixture);
  assert.notEqual(
    priorCloseResult.status,
    0,
    `a prior ${event} event must remain a durable human veto`,
  );
  assert(
    priorCloseResult.stdout.includes(
      "The pull request history is malformed or contains a close or reopen event.",
    ),
    `a prior ${event} event must fail the close-history proof:\n${priorCloseResult.stdout}\n${priorCloseResult.stderr}`,
  );
  assert(
    !priorCloseResult.merged,
    `a prior ${event} event must not reach merge`,
  );
}

const laterHistoryPageFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
laterHistoryPageFixture.historyPages = [
  [{ id: 8414, event: "labeled" }],
  [{ id: 8415, event: "closed" }],
];
const laterHistoryPageResult = runWriter(laterHistoryPageFixture);
assert.notEqual(
  laterHistoryPageResult.status,
  0,
  "a close event on a later history page must refuse",
);
assert(
  laterHistoryPageResult.stdout.includes(
    "The pull request history is malformed or contains a close or reopen event.",
  ),
  `a later-page close must fail the complete history proof:\n${laterHistoryPageResult.stdout}\n${laterHistoryPageResult.stderr}`,
);
assert(
  !laterHistoryPageResult.merged,
  "a later-page close must not reach merge",
);

const closeDuringWaitFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
closeDuringWaitFixture.historyPagesSequence = [
  [[]],
  [
    [
      {
        id: 8412,
        event: "closed",
        actor: { login: "chapati23" },
        created_at: "2026-08-30T10:01:00Z",
      },
      {
        id: 8413,
        event: "reopened",
        actor: { login: "chapati23" },
        created_at: "2026-08-30T10:02:00Z",
      },
    ],
  ],
];
const closeDuringWaitResult = runWriter(closeDuringWaitFixture);
assert.notEqual(
  closeDuringWaitResult.status,
  0,
  "a human close and reopen at the same head during required-check waiting must refuse",
);
assert(
  closeDuringWaitResult.stdout.includes(
    "The pull request history is malformed or contains a close or reopen event.",
  ),
  `the second close-history read must preserve the human veto:\n${closeDuringWaitResult.stdout}\n${closeDuringWaitResult.stderr}`,
);
assert.equal(
  routeCalls(closeDuringWaitResult, "/issues/1872/events").length,
  2,
  "the close and reopen must be detected by the second authoritative read",
);
assert(
  !closeDuringWaitResult.merged,
  "a close and reopen at the same head must not reach merge",
);

for (const [label, historyPages] of [
  ["missing slurped page", []],
  ["non-array page", [{}]],
  ["missing event type", [[{}]]],
  ["non-string event type", [[{ event: null }]]],
]) {
  const malformedHistoryFixture = scenario({
    number: 1872,
    runId: 31995129967,
    headRef: pr1872HeadRef,
    headSha: pr1872Head,
    commits: [commit(pr1872Head)],
    files: pr1872Files,
  });
  malformedHistoryFixture.historyPages = historyPages;
  const malformedHistoryResult = runWriter(malformedHistoryFixture);
  assert.notEqual(
    malformedHistoryResult.status,
    0,
    `close history with ${label} must refuse`,
  );
  assert(
    malformedHistoryResult.stdout.includes(
      "The pull request history is malformed or contains a close or reopen event.",
    ),
    `close history with ${label} must fail closed:\n${malformedHistoryResult.stdout}\n${malformedHistoryResult.stderr}`,
  );
  assert(
    !malformedHistoryResult.merged,
    `close history with ${label} must not reach merge`,
  );
}

const unreadableHistoryFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
unreadableHistoryFixture.historyExit = 97;
const unreadableHistoryResult = runWriter(unreadableHistoryFixture);
assert.notEqual(
  unreadableHistoryResult.status,
  0,
  "an unreadable close history must refuse",
);
assert(
  unreadableHistoryResult.stdout.includes(
    "The pull request close history is unreadable.",
  ),
  `an unreadable close history must fail closed:\n${unreadableHistoryResult.stdout}\n${unreadableHistoryResult.stderr}`,
);
assert(
  !unreadableHistoryResult.merged,
  "an unreadable close history must not reach merge",
);

const lowercaseMaintainerBodyFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
lowercaseMaintainerBodyFixture.pr.body = `${lowercaseMaintainerBodyFixture.pr.body}\n\nmaintainer changes`;
const lowercaseMaintainerBodyResult = runWriter(lowercaseMaintainerBodyFixture);
assert.equal(
  lowercaseMaintainerBodyResult.status,
  0,
  `the writer must mirror the pinned action's case-sensitive marker:\n${lowercaseMaintainerBodyResult.stdout}\n${lowercaseMaintainerBodyResult.stderr}`,
);
assert(
  lowercaseMaintainerBodyResult.merged,
  "a lowercase lookalike must not widen the pinned maintainer-change rule",
);

const changedClassifierFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
changedClassifierFixture.runSequence = [
  changedClassifierFixture.run,
  {
    ...changedClassifierFixture.run,
    triggering_actor: { login: "chapati23" },
  },
];
const changedClassifierResult = runWriter(changedClassifierFixture);
assert.notEqual(
  changedClassifierResult.status,
  0,
  "a changed classifier proof after required-check waiting must refuse",
);
assert(
  changedClassifierResult.stdout.includes(
    "The authoritative upstream run is not an eligible classifier run.",
  ),
  `the second classifier read must fail closed:\n${changedClassifierResult.stdout}\n${changedClassifierResult.stderr}`,
);
assert(
  !changedClassifierResult.merged,
  "a changed classifier proof must not reach merge",
);

const activatedQueueFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
activatedQueueFixture.queueSequence = [
  activatedQueueFixture.queue,
  {
    data: {
      repository: {
        mergeQueue: {
          url: "https://github.com/mento-protocol/monitoring-monorepo/queue/main",
        },
      },
    },
  },
];
const activatedQueueResult = runWriter(activatedQueueFixture);
assert.notEqual(
  activatedQueueResult.status,
  0,
  "a queue activated during required-check waiting must refuse",
);
assert(
  activatedQueueResult.stdout.includes(
    "The routine auto-merge lane cannot prove that main has no merge queue.",
  ),
  `the second queue proof must fail closed:\n${activatedQueueResult.stdout}\n${activatedQueueResult.stderr}`,
);
assert(
  !activatedQueueResult.merged,
  "an activated queue must not reach the synchronous merge endpoint",
);

const queueErrorFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
queueErrorFixture.queue = {
  errors: [{ message: "merge queue state is not readable" }],
  data: { repository: { mergeQueue: null } },
};
const queueErrorResult = runWriter(queueErrorFixture);
assert.notEqual(
  queueErrorResult.status,
  0,
  "a GraphQL error must refuse even when mergeQueue is null",
);
assert(
  queueErrorResult.stdout.includes(
    "The routine auto-merge lane cannot prove that main has no merge queue.",
  ),
  `queue read errors must fail closed:\n${queueErrorResult.stdout}\n${queueErrorResult.stderr}`,
);
assert(!queueErrorResult.merged, "an unreadable queue must not reach merge");

const missingQueueFieldFixture = scenario({
  number: 1872,
  runId: 31995129967,
  headRef: pr1872HeadRef,
  headSha: pr1872Head,
  commits: [commit(pr1872Head)],
  files: pr1872Files,
});
missingQueueFieldFixture.queue = { data: { repository: {} } };
const missingQueueFieldResult = runWriter(missingQueueFieldFixture);
assert.notEqual(
  missingQueueFieldResult.status,
  0,
  "a missing mergeQueue field must refuse",
);
assert(
  missingQueueFieldResult.stdout.includes(
    "The routine auto-merge lane cannot prove that main has no merge queue.",
  ),
  `a missing queue field must fail closed:\n${missingQueueFieldResult.stdout}\n${missingQueueFieldResult.stderr}`,
);
assert(
  !missingQueueFieldResult.merged,
  "a missing mergeQueue field must not reach merge",
);

const truncatedCommitResult = runWriter(
  scenario({
    number: 1872,
    runId: 31995129967,
    headRef: pr1872HeadRef,
    headSha: pr1872Head,
    commits: Array.from({ length: 250 }, (_, index) =>
      commit(index === 249 ? pr1872Head : index.toString(16).padStart(40, "0")),
    ),
    files: pr1872Files,
    reportedCommitCount: 251,
  }),
);
assert.notEqual(
  truncatedCommitResult.status,
  0,
  "a PR above the commits endpoint cap must refuse",
);
assert(
  truncatedCommitResult.stdout.includes(
    "The current pull request does not match the verified run.",
  ),
  `a truncated commit list must fail before commit validation:\n${truncatedCommitResult.stdout}\n${truncatedCommitResult.stderr}`,
);
assert(
  !truncatedCommitResult.merged,
  "a truncated commit list must not reach merge",
);

const pr1742HeadRef =
  "dependabot/github_actions/actions-minor-patch-ca62abc165";
const pr1742Head = "cf6109b20aecf9273a0744c4cb45c2122714962c";
const pr1742Result = runWriter(
  scenario({
    number: 1742,
    runId: 31742000000,
    headRef: pr1742HeadRef,
    headSha: pr1742Head,
    commits: [
      commit("c750a49c5f6bd3a27e0a294e6c781b84a316156d"),
      commit("4715daa11827211eee816c693f903b37fce8c23c", "chapati23"),
      commit("3f3c38397e8af8c4fbef5c6f0b2020bdbd970353", "chapati23"),
      commit(pr1742Head, "chapati23"),
    ],
    files: [
      ".github/workflows/ci.yml",
      "scripts/production-infra-identity-contract/workflow-inventory.mjs",
    ],
  }),
);
assert.notEqual(pr1742Result.status, 0, "PR #1742 must be rejected");
assert(
  pr1742Result.stdout.includes(
    "Every commit must be unique, verified, and authored by Dependabot.",
  ),
  `PR #1742 must fail at the mixed-author check:\n${pr1742Result.stdout}\n${pr1742Result.stderr}`,
);
assert(!pr1742Result.merged, "PR #1742 must not reach the merge command");

console.log("dependabot auto-merge policy tests passed");

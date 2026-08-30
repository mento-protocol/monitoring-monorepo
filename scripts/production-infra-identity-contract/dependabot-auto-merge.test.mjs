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
const candidateEventScript = candidate.jobs.classify.steps[0].run;
const candidateDependencyScript = candidate.jobs.classify.steps[2].run;
const writerScript = writer.jobs["auto-merge"].steps[0].run;

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
    jobsPages: [{ jobs: [successfulJob(runId, headSha)] }],
    prPages: [[{ number }]],
    pr,
    commitsPages: [commits],
    filesPages: [files.map((filename) => ({ filename, status: "modified" }))],
    queue: { data: { repository: { mergeQueue: null } } },
  };
}

const mockGhSource = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const fixture = JSON.parse(readFileSync(process.env.MOCK_GH_SCENARIO, "utf8"));
const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "pr" && args[1] === "merge") {
  writeFileSync(process.env.MOCK_GH_MERGE_MARKER, args.join(" "));
  process.exit(0);
}
if (args[0] !== "api") process.exit(91);
if (args[1] === "graphql") {
  emit(fixture.queue);
  process.exit(0);
}
const route = args.find((arg) => arg.startsWith("repos/"));
if (route?.includes("/actions/workflows/")) emit(fixture.workflow);
else if (route?.includes("/attempts/1/jobs")) emit(fixture.jobsPages);
else if (route?.includes("/actions/runs/")) emit(fixture.run);
else if (/\\/pulls\\/[^/]+\\/commits$/u.test(route ?? "")) emit(fixture.commitsPages);
else if (/\\/pulls\\/[^/]+\\/files$/u.test(route ?? "")) emit(fixture.filesPages);
else if (/\\/pulls\\/[^/]+$/u.test(route ?? "")) emit(fixture.pr);
else if (route?.endsWith("/pulls")) emit(fixture.prPages);
else process.exit(92);
`;

function runWriter(fixture) {
  const scratch = mkdtempSync(path.join(tmpdir(), "dependabot-merge-test-"));
  const ghPath = path.join(scratch, "gh");
  const scenarioPath = path.join(scratch, "scenario.json");
  const mergeMarker = path.join(scratch, "merge-called.txt");
  writeFileSync(ghPath, mockGhSource);
  chmodSync(ghPath, 0o755);
  writeFileSync(scenarioPath, JSON.stringify(fixture));
  const result = spawnSync("bash", ["-c", writerScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${scratch}:${process.env.PATH}`,
      GITHUB_REPOSITORY: expectedRepository,
      RUN_ID: String(fixture.run.id),
      MOCK_GH_SCENARIO: scenarioPath,
      MOCK_GH_MERGE_MARKER: mergeMarker,
    },
  });
  const merged = existsSync(mergeMarker);
  rmSync(scratch, { recursive: true, force: true });
  return { ...result, merged };
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

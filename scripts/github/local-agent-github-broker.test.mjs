#!/usr/bin/env node

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BROKER_INSTALL_PATH,
  BROKER_MODULE_INSTALL_PATH,
  BROKER_NODE_PATH,
  BROKER_NODE_ROOT,
  BROKER_OPERATION_CWD,
  BROKER_OS_USER,
  BROKER_POLICY_INSTALL_PATH,
  FIXED_BROKER_ENV,
  GCLOUD_PATH,
  GCLOUD_PYTHON_PATH,
  GCLOUD_PYTHON_ROOT,
  GCLOUD_SDK_ROOT,
  GCP_BROKER_SERVICE_ACCOUNT,
  GCP_PROJECT_ID,
  GITHUB_API_VERSION,
  INSTALLATION_PERMISSIONS,
  MAX_RESPONSE_BYTES,
  PRIVATE_KEY_SECRET_ID,
  REPOSITORY_FULL_NAME,
  REPOSITORY_NAME,
  assertBrokerEnvironment,
  brokerFailureMessage,
  buildOperationRequest,
  buildTargetValidationRequest,
  createAppJwt,
  exchangeInstallationToken,
  executeGithubOperation,
  parseBrokerArgs,
  readPrivateKey,
  redactBrokerOutput,
  requestedPermissions,
  runBroker,
  verifyRootOwnedRuntimeTree,
  verifyTrustedRuntimePaths,
} from "./local-agent-github-broker.mjs";
import {
  GIT_PUBLICATION_SERVICE_ENABLED,
  ISSUE_BOARD_MUTEX_REF_PREFIX,
  PROFILE,
  TRUSTED_PROFILES,
  assertNoAmbientGithubCredential,
  parseClientArgs,
  parseStructuredOperation,
} from "./local-agent-github-command-policy.mjs";
import {
  invokeInstalledBroker,
  runClient,
  verifyInstalledBroker,
} from "./local-agent-github-exec.mjs";

const APP_ID = 123456;
const INSTALLATION_ID = 987654;
const NOW_SECONDS = 1_800_000_000;
const INSTALLATION_TOKEN = `ghs_${"a".repeat(40)}`;
const TOKEN_MARKER = `ghs_${"z".repeat(40)}`;
const PRIVATE_KEY_MARKER = "private-key-redaction-canary";
const PROVIDER_ONLY_MARKER = "provider-field-must-not-escape";
const RSA_PRIVATE_KEY_BEGIN = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
const RSA_PRIVATE_KEY_END = ["-----END RSA", "PRIVATE KEY-----"].join(" ");
const BASE_ENV = Object.freeze({
  HOME: "/agent/home",
  LANG: "C",
  PATH: "/attacker/bin",
  NODE_OPTIONS: "--require=/attacker/loader.cjs",
  LD_PRELOAD: "/attacker/loader.so",
  DYLD_INSERT_LIBRARIES: "/attacker/loader.dylib",
  HTTPS_PROXY: "https://attacker.invalid",
  npm_config_proxy: "https://attacker.invalid",
  MENTO_LOCAL_AGENT_GITHUB_APP_ID: String(APP_ID),
  MENTO_LOCAL_AGENT_GITHUB_APP_INSTALLATION_ID: String(INSTALLATION_ID),
});

function clientOptions(
  profile = PROFILE.READ,
  operation = "pr-view",
  args = ["1"],
) {
  return {
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    profile,
    operation,
    args,
  };
}

function brokerArgv(
  profile = PROFILE.READ,
  operation = "pr-view",
  args = ["1"],
) {
  return [
    "--app-id",
    String(APP_ID),
    "--installation-id",
    String(INSTALLATION_ID),
    "--profile",
    profile,
    "--",
    operation,
    ...args,
  ];
}

function tokenPayload(permissions, overrides = {}) {
  return {
    token: INSTALLATION_TOKEN,
    expires_at: new Date((NOW_SECONDS + 60 * 60) * 1000).toISOString(),
    permissions: { ...permissions, metadata: "read" },
    repository_selection: "selected",
    ...overrides,
  };
}

function tokenRepositoryScope(overrides = {}) {
  return {
    total_count: 1,
    repositories: [{ full_name: REPOSITORY_FULL_NAME }],
    ...overrides,
  };
}

function privateKeyFixture() {
  return Buffer.from(
    `${RSA_PRIVATE_KEY_BEGIN}\n${PRIVATE_KEY_MARKER}\n${RSA_PRIVATE_KEY_END}\n`,
  );
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  };
}

function safeFileStat(overrides = {}) {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100555,
    uid: 0,
    ...overrides,
  };
}

function safeDirectoryStat(overrides = {}) {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    mode: 0o040555,
    uid: 0,
    ...overrides,
  };
}

function issueFixture(overrides = {}) {
  const number = overrides.number ?? 1;
  return {
    number,
    title: "A fixed issue title",
    state: "open",
    html_url: `https://github.com/${REPOSITORY_FULL_NAME}/issues/${number}`,
    labels: [{ name: "security", extra: PROVIDER_ONLY_MARKER }],
    assignees: [{ login: "octocat", extra: PROVIDER_ONLY_MARKER }],
    body: PROVIDER_ONLY_MARKER,
    token: TOKEN_MARKER,
    ...overrides,
  };
}

function pullRequestFixture(overrides = {}) {
  const number = overrides.number ?? 1;
  return {
    number,
    title: "A fixed pull request title",
    state: "open",
    html_url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/${number}`,
    draft: false,
    head: { ref: "feature", extra: PROVIDER_ONLY_MARKER },
    base: { ref: "main", extra: PROVIDER_ONLY_MARKER },
    mergeable: true,
    merged: false,
    merged_at: null,
    body: PROVIDER_ONLY_MARKER,
    token: TOKEN_MARKER,
    ...overrides,
  };
}

function runFixture(overrides = {}) {
  const id = overrides.id ?? 11;
  return {
    id,
    name: "checks",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${REPOSITORY_FULL_NAME}/actions/runs/${id}`,
    head_branch: "feature",
    head_sha: "a".repeat(40),
    created_at: "2026-08-29T08:00:00Z",
    updated_at: "2026-08-29T08:05:00Z",
    logs_url: PROVIDER_ONLY_MARKER,
    token: TOKEN_MARKER,
    ...overrides,
  };
}

function commentFixture(overrides = {}) {
  return {
    id: 77,
    html_url: `https://github.com/${REPOSITORY_FULL_NAME}/issues/1#issuecomment-77`,
    created_at: "2026-08-29T08:00:00Z",
    body: PROVIDER_ONLY_MARKER,
    token: TOKEN_MARKER,
    ...overrides,
  };
}

function reviewFixture(overrides = {}) {
  return {
    id: 88,
    state: "COMMENTED",
    html_url: `https://github.com/${REPOSITORY_FULL_NAME}/pull/1#pullrequestreview-88`,
    submitted_at: "2026-08-29T08:00:00Z",
    body: PROVIDER_ONLY_MARKER,
    token: TOKEN_MARKER,
    ...overrides,
  };
}

test("permission profiles are exact and source-disabled lanes stay unavailable", () => {
  assert.deepEqual(PROFILE, {
    READ: "read",
    PR_ISSUE: "pr-issue-write",
    GIT_PUBLICATION: "git-publish",
    ISSUE_BOARD: "issue-board-write",
  });
  assert.deepEqual(new Set(TRUSTED_PROFILES), new Set(Object.values(PROFILE)));
  assert.deepEqual(requestedPermissions(clientOptions(PROFILE.READ)), {
    actions: "read",
    issues: "read",
    pull_requests: "read",
  });
  assert.deepEqual(requestedPermissions(clientOptions(PROFILE.PR_ISSUE)), {
    issues: "write",
    pull_requests: "write",
  });
  assert.deepEqual(
    requestedPermissions(clientOptions(PROFILE.GIT_PUBLICATION)),
    {
      contents: "write",
    },
  );
  assert.deepEqual(requestedPermissions(clientOptions(PROFILE.ISSUE_BOARD)), {
    issues: "write",
  });
  for (const permissions of Object.values(INSTALLATION_PERMISSIONS)) {
    assert.equal(permissions.workflows, undefined);
    assert.equal(permissions.administration, undefined);
    assert.equal(permissions.organization_projects, undefined);
  }
  assert.equal(
    INSTALLATION_PERMISSIONS[PROFILE.ISSUE_BOARD].contents,
    undefined,
  );
  assert.equal(GIT_PUBLICATION_SERVICE_ENABLED, false);
  assert.equal(ISSUE_BOARD_MUTEX_REF_PREFIX, "");
  assert.throws(() =>
    parseStructuredOperation(PROFILE.GIT_PUBLICATION, "git-publish", [
      "feature",
    ]),
  );
  assert.throws(() =>
    parseStructuredOperation(PROFILE.ISSUE_BOARD, "issue-board-claim", ["1"]),
  );
  assert.throws(() =>
    parseStructuredOperation(PROFILE.ISSUE_BOARD, "issue-comment", [
      "1",
      "claim",
    ]),
  );
});

test("client and broker parse one fixed structured operation", () => {
  assert.deepEqual(
    parseClientArgs(
      ["--profile", PROFILE.READ, "--", "pr-view", "1"],
      BASE_ENV,
    ),
    clientOptions(),
  );
  assert.deepEqual(parseBrokerArgs(brokerArgv()), {
    ...clientOptions(),
    parameters: { number: 1 },
  });
  for (const argv of [
    ["--", "repo-view"],
    ["--workflows-write", "--", "repo-view"],
    ["--profile", "workflow-write", "--", "repo-view"],
    ["--profile", PROFILE.READ, "--", "git", "push"],
    ["--profile", PROFILE.READ, "--", "gh", "api", "/user"],
  ]) {
    assert.throws(() => parseClientArgs(argv, BASE_ENV));
  }
  assert.throws(() =>
    parseBrokerArgs([
      "--app-id",
      String(APP_ID),
      "--app-id",
      String(APP_ID),
      "--installation-id",
      String(INSTALLATION_ID),
      "--profile",
      PROFILE.READ,
      "--",
      "repo-view",
    ]),
  );
});

test("the policy accepts only bounded positional parameters", () => {
  const accepted = [
    [PROFILE.READ, "repo-view", [], {}],
    [PROFILE.READ, "issue-view", ["7"], { number: 7 }],
    [PROFILE.READ, "issue-list", [], { state: "open", limit: 30 }],
    [PROFILE.READ, "issue-list", ["all", "100"], { state: "all", limit: 100 }],
    [PROFILE.READ, "pr-view", ["8"], { number: 8 }],
    [PROFILE.READ, "pr-list", ["closed", "2"], { state: "closed", limit: 2 }],
    [PROFILE.READ, "run-view", ["9"], { runId: 9 }],
    [PROFILE.READ, "run-list", ["5"], { limit: 5 }],
    [
      PROFILE.PR_ISSUE,
      "issue-comment",
      ["1", "body"],
      { number: 1, body: "body" },
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-comment",
      ["1", "body"],
      { number: 1, body: "body" },
    ],
    [PROFILE.PR_ISSUE, "issue-create", ["title"], { title: "title", body: "" }],
    [
      PROFILE.PR_ISSUE,
      "pr-create",
      ["feature/one", "main", "title", "body"],
      { head: "feature/one", base: "main", title: "title", body: "body" },
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-review",
      ["1", "request-changes", "fix this"],
      { number: 1, decision: "request-changes", body: "fix this" },
    ],
    [PROFILE.PR_ISSUE, "issue-close", ["1"], { number: 1 }],
    [PROFILE.PR_ISSUE, "issue-reopen", ["1"], { number: 1 }],
    [PROFILE.PR_ISSUE, "pr-close", ["1"], { number: 1 }],
    [PROFILE.PR_ISSUE, "pr-reopen", ["1"], { number: 1 }],
  ];
  for (const [profile, operation, args, expected] of accepted) {
    assert.deepEqual(
      parseStructuredOperation(profile, operation, args),
      expected,
    );
  }

  const rejected = [
    [PROFILE.PR_ISSUE, "pr-merge", ["1"]],
    [PROFILE.PR_ISSUE, "workflow-publish", ["x"]],
    [PROFILE.READ, "pr-view", ["other/repo#1"]],
    [PROFILE.READ, "issue-list", ["open", "101"]],
    [PROFILE.READ, "run-view", ["0"]],
    [PROFILE.PR_ISSUE, "issue-comment", ["1", ""]],
    [PROFILE.PR_ISSUE, "pr-create", ["owner:branch", "main", "x", ""]],
    [PROFILE.PR_ISSUE, "pr-create", ["../branch", "main", "x", ""]],
    [PROFILE.PR_ISSUE, "pr-create", [".hidden", "main", "x", ""]],
    [PROFILE.PR_ISSUE, "pr-create", ["feature.lock", "main", "x", ""]],
    [PROFILE.PR_ISSUE, "pr-review", ["1", "merge", "x"]],
    [PROFILE.PR_ISSUE, "pr-review", ["1", "approve", "approved"]],
    [PROFILE.PR_ISSUE, "pr-review", ["1", "comment", ""]],
    [PROFILE.PR_ISSUE, "pr-review", ["1", "comment"]],
    [PROFILE.PR_ISSUE, "issue-labels-set", ["1", "same", "same"]],
    [
      PROFILE.PR_ISSUE,
      "issue-comment",
      ["1", "Agent claim: codex claimed #1 for implementation."],
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-comment",
      ["1", "Moved to review: #1 is now represented by PR #2."],
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-comment",
      ["1", "Released agent claim: #1 is back in agent-ready."],
    ],
    [PROFILE.READ, "issue-view", ["1", "extra"]],
    [PROFILE.ISSUE_BOARD, "issue-create", ["x"]],
    [PROFILE.GIT_PUBLICATION, "pr-create", ["feature", "main", "x", ""]],
  ];
  for (const [profile, operation, args] of rejected) {
    assert.throws(() => parseStructuredOperation(profile, operation, args));
  }
});

test("every operation maps to one fixed selected-repository REST request", () => {
  const cases = [
    [
      PROFILE.READ,
      "repo-view",
      [],
      {
        method: "GET",
        path: `/repos/${REPOSITORY_FULL_NAME}`,
        statuses: [200],
      },
    ],
    [
      PROFILE.READ,
      "issue-view",
      ["1"],
      {
        method: "GET",
        path: `/repos/${REPOSITORY_FULL_NAME}/issues/1`,
        statuses: [200],
      },
    ],
    [
      PROFILE.READ,
      "issue-list",
      ["all", "5"],
      {
        method: "GET",
        path: `/repos/${REPOSITORY_FULL_NAME}/issues?state=all&per_page=5`,
        statuses: [200],
      },
    ],
    [
      PROFILE.READ,
      "pr-view",
      ["1"],
      {
        method: "GET",
        path: `/repos/${REPOSITORY_FULL_NAME}/pulls/1`,
        statuses: [200],
      },
    ],
    [
      PROFILE.READ,
      "pr-list",
      ["open", "5"],
      {
        method: "GET",
        path: `/repos/${REPOSITORY_FULL_NAME}/pulls?state=open&per_page=5`,
        statuses: [200],
      },
    ],
    [
      PROFILE.READ,
      "run-view",
      ["11"],
      {
        method: "GET",
        path: `/repos/${REPOSITORY_FULL_NAME}/actions/runs/11`,
        statuses: [200],
      },
    ],
    [
      PROFILE.READ,
      "run-list",
      ["5"],
      {
        method: "GET",
        path: `/repos/${REPOSITORY_FULL_NAME}/actions/runs?per_page=5`,
        statuses: [200],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-comment",
      ["1", "body"],
      {
        method: "POST",
        path: `/repos/${REPOSITORY_FULL_NAME}/issues/1/comments`,
        body: { body: "body" },
        statuses: [201],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-comment",
      ["1", "body"],
      {
        method: "POST",
        path: `/repos/${REPOSITORY_FULL_NAME}/issues/1/comments`,
        body: { body: "body" },
        statuses: [201],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-create",
      ["title", "body"],
      {
        method: "POST",
        path: `/repos/${REPOSITORY_FULL_NAME}/issues`,
        body: { title: "title", body: "body" },
        statuses: [201],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-create",
      ["feature", "main", "title", "body"],
      {
        method: "POST",
        path: `/repos/${REPOSITORY_FULL_NAME}/pulls`,
        body: { head: "feature", base: "main", title: "title", body: "body" },
        statuses: [201],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-close",
      ["1"],
      {
        method: "PATCH",
        path: `/repos/${REPOSITORY_FULL_NAME}/issues/1`,
        body: { state: "closed" },
        statuses: [200],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-reopen",
      ["1"],
      {
        method: "PATCH",
        path: `/repos/${REPOSITORY_FULL_NAME}/issues/1`,
        body: { state: "open" },
        statuses: [200],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-close",
      ["1"],
      {
        method: "PATCH",
        path: `/repos/${REPOSITORY_FULL_NAME}/pulls/1`,
        body: { state: "closed" },
        statuses: [200],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-reopen",
      ["1"],
      {
        method: "PATCH",
        path: `/repos/${REPOSITORY_FULL_NAME}/pulls/1`,
        body: { state: "open" },
        statuses: [200],
      },
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-review",
      ["1", "comment", "looks sound"],
      {
        method: "POST",
        path: `/repos/${REPOSITORY_FULL_NAME}/pulls/1/reviews`,
        body: { event: "COMMENT", body: "looks sound" },
        statuses: [200],
      },
    ],
  ];
  for (const [profile, operation, args, expected] of cases) {
    const parameters = parseStructuredOperation(profile, operation, args);
    const request = buildOperationRequest(operation, parameters);
    assert.deepEqual(request, expected);
    assert(request.path.startsWith(`/repos/${REPOSITORY_FULL_NAME}`));
    assert(!request.path.includes("/merge"));
    assert(!request.path.includes("/git/"));
    assert(!request.path.includes("/contents/"));
    assert(!request.path.includes("/actions/workflows/"));
  }
  assert.deepEqual(
    buildTargetValidationRequest("issue-comment", { number: 1 }),
    {
      kind: "issue",
      method: "GET",
      path: `/repos/${REPOSITORY_FULL_NAME}/issues/1`,
      statuses: [200],
    },
  );
  assert.deepEqual(buildTargetValidationRequest("pr-comment", { number: 1 }), {
    kind: "pull-request",
    method: "GET",
    path: `/repos/${REPOSITORY_FULL_NAME}/pulls/1`,
    statuses: [200],
  });
});

test("every active operation returns only its bounded normalized schema", async () => {
  const repository = {
    full_name: REPOSITORY_FULL_NAME,
    default_branch: "main",
    visibility: "public",
    archived: false,
    owner: PROVIDER_ONLY_MARKER,
    token: TOKEN_MARKER,
  };
  const issue = issueFixture();
  const pullRequest = pullRequestFixture();
  const run = runFixture();
  const comment = commentFixture();
  const review = reviewFixture();
  const cases = [
    [
      PROFILE.READ,
      "repo-view",
      [],
      [repository],
      ["nameWithOwner", "defaultBranch", "visibility", "archived"],
    ],
    [
      PROFILE.READ,
      "issue-view",
      ["1"],
      [issue],
      [
        "number",
        "title",
        "state",
        "url",
        "labels",
        "assignees",
        "isPullRequest",
      ],
    ],
    [
      PROFILE.READ,
      "issue-list",
      ["all", "5"],
      [[issue, { ...pullRequest, pull_request: {} }]],
      [
        "number",
        "title",
        "state",
        "url",
        "labels",
        "assignees",
        "isPullRequest",
      ],
    ],
    [
      PROFILE.READ,
      "pr-view",
      ["1"],
      [pullRequest],
      [
        "number",
        "title",
        "state",
        "url",
        "isDraft",
        "headRefName",
        "baseRefName",
        "mergeable",
        "merged",
      ],
    ],
    [
      PROFILE.READ,
      "pr-list",
      ["open", "5"],
      [[pullRequest]],
      [
        "number",
        "title",
        "state",
        "url",
        "isDraft",
        "headRefName",
        "baseRefName",
        "mergeable",
        "merged",
      ],
    ],
    [
      PROFILE.READ,
      "run-view",
      ["11"],
      [run],
      [
        "id",
        "name",
        "event",
        "status",
        "conclusion",
        "url",
        "headBranch",
        "headSha",
        "createdAt",
        "updatedAt",
      ],
    ],
    [
      PROFILE.READ,
      "run-list",
      ["5"],
      [{ workflow_runs: [run], token: TOKEN_MARKER }],
      [
        "id",
        "name",
        "event",
        "status",
        "conclusion",
        "url",
        "headBranch",
        "headSha",
        "createdAt",
        "updatedAt",
      ],
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-comment",
      ["1", "body"],
      [issue, comment],
      ["id", "url", "createdAt"],
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-comment",
      ["1", "body"],
      [pullRequest, comment],
      ["id", "url", "createdAt"],
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-create",
      ["title", "body"],
      [issue],
      [
        "number",
        "title",
        "state",
        "url",
        "labels",
        "assignees",
        "isPullRequest",
      ],
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-create",
      ["feature", "main", "title", "body"],
      [pullRequest],
      [
        "number",
        "title",
        "state",
        "url",
        "isDraft",
        "headRefName",
        "baseRefName",
        "mergeable",
        "merged",
      ],
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-close",
      ["1"],
      [issue, issueFixture({ state: "closed" })],
      [
        "number",
        "title",
        "state",
        "url",
        "labels",
        "assignees",
        "isPullRequest",
      ],
    ],
    [
      PROFILE.PR_ISSUE,
      "issue-reopen",
      ["1"],
      [issueFixture({ state: "closed" }), issue],
      [
        "number",
        "title",
        "state",
        "url",
        "labels",
        "assignees",
        "isPullRequest",
      ],
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-close",
      ["1"],
      [pullRequestFixture({ state: "closed" })],
      [
        "number",
        "title",
        "state",
        "url",
        "isDraft",
        "headRefName",
        "baseRefName",
        "mergeable",
        "merged",
      ],
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-reopen",
      ["1"],
      [pullRequest],
      [
        "number",
        "title",
        "state",
        "url",
        "isDraft",
        "headRefName",
        "baseRefName",
        "mergeable",
        "merged",
      ],
    ],
    [
      PROFILE.PR_ISSUE,
      "pr-review",
      ["1", "comment", "looks sound"],
      [review],
      ["id", "state", "url", "submittedAt"],
    ],
  ];

  for (const [profile, operation, args, payloads, expectedKeys] of cases) {
    const parameters = parseStructuredOperation(profile, operation, args);
    const request = buildOperationRequest(operation, parameters);
    const validation = buildTargetValidationRequest(operation, parameters);
    const statuses = validation
      ? [validation.statuses[0], request.statuses[0]]
      : [request.statuses[0]];
    const calls = [];
    let index = 0;
    const result = await executeGithubOperation(
      { operation, parameters, token: INSTALLATION_TOKEN },
      {
        fetchImpl: async (url, requestOptions) => {
          calls.push({ url, options: requestOptions });
          const response = jsonResponse(payloads[index], statuses[index]);
          index += 1;
          return response;
        },
      },
    );
    assert.equal(index, payloads.length, operation);
    const normalized = Array.isArray(result) ? result[0] : result;
    assert.deepEqual(Object.keys(normalized), expectedKeys, operation);
    assert(!JSON.stringify(result).includes(PROVIDER_ONLY_MARKER), operation);
    assert(!JSON.stringify(result).includes(TOKEN_MARKER), operation);
    for (const call of calls) {
      assert(
        call.url.startsWith(
          `https://api.github.com/repos/${REPOSITORY_FULL_NAME}`,
        ),
      );
      assert.equal(
        call.options.headers.Authorization,
        `Bearer ${INSTALLATION_TOKEN}`,
      );
      assert.equal(
        call.options.headers["X-GitHub-Api-Version"],
        GITHUB_API_VERSION,
      );
      assert.equal(call.options.redirect, "error");
      assert.equal(call.options.env, undefined);
      assert.equal(call.options.headers.PATH, undefined);
      assert.equal(call.options.headers.NODE_OPTIONS, undefined);
      assert.equal(call.options.headers.HTTPS_PROXY, undefined);
      assert.equal(call.options.headers.LD_PRELOAD, undefined);
    }
  }
});

test("issue operations validate that a target is not a pull request before mutation", async () => {
  const parameters = parseStructuredOperation(
    PROFILE.PR_ISSUE,
    "issue-comment",
    ["1", "claim"],
  );
  let calls = 0;
  await assert.rejects(
    executeGithubOperation(
      { operation: "issue-comment", parameters, token: INSTALLATION_TOKEN },
      {
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({ ...issueFixture(), pull_request: {} });
        },
      },
    ),
    /was not an issue/u,
  );
  assert.equal(calls, 1);
});

test("provider errors expose only fixed status or classification", async () => {
  const parameters = parseStructuredOperation(PROFILE.READ, "repo-view", []);
  const invoke = (fetchImpl) =>
    executeGithubOperation(
      { operation: "repo-view", parameters, token: INSTALLATION_TOKEN },
      { fetchImpl },
    );
  const rawFailure = `${TOKEN_MARKER} ${PRIVATE_KEY_MARKER}`;
  await assert.rejects(
    invoke(async () => ({
      ...jsonResponse({ message: rawFailure }, 422),
      headers: { get: () => rawFailure },
    })),
    (error) => {
      assert.equal(error.message, "GitHub operation returned HTTP 422");
      assert(!error.message.includes(rawFailure));
      return true;
    },
  );
  await assert.rejects(
    invoke(async () => ({ ...jsonResponse({}), status: rawFailure })),
    (error) => {
      assert.equal(error.message, "GitHub operation response was malformed");
      return true;
    },
  );
  await assert.rejects(
    invoke(async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => rawFailure,
    })),
    (error) => {
      assert.equal(error.message, "GitHub operation response was malformed");
      assert(!error.message.includes(rawFailure));
      return true;
    },
  );
  await assert.rejects(
    invoke(async () => {
      throw new Error(rawFailure);
    }),
    (error) => {
      assert.equal(error.message, "GitHub operation request failed");
      return true;
    },
  );
  await assert.rejects(
    invoke(async () => ({
      status: 200,
      headers: { get: () => String(MAX_RESPONSE_BYTES + 1) },
      text: async () => JSON.stringify({ token: rawFailure }),
    })),
    /response was too large/u,
  );
});

test("broker environment has no caller PATH, proxy, loader, or credential fallback", () => {
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_CONFIG_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GITHUB_OWNER",
    "GITHUB_ORGANIZATION",
    "GITHUB_BASE_URL",
    "TF_VAR_github_token",
    "TF_VAR_local_agent_github_app_private_key",
  ]) {
    assert.throws(() =>
      assertBrokerEnvironment({ ...FIXED_BROKER_ENV, [name]: TOKEN_MARKER }),
    );
  }
  for (const [name, value] of [
    ["PATH", "/attacker/bin"],
    ["HOME", "/attacker/home"],
    ["TMPDIR", "/attacker/tmp"],
  ]) {
    assert.throws(() =>
      assertBrokerEnvironment({ ...FIXED_BROKER_ENV, [name]: value }),
    );
  }
  for (const name of [
    "HTTPS_PROXY",
    "http_proxy",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "npm_config_proxy",
    "SSH_AUTH_SOCK",
  ]) {
    assert.throws(() =>
      assertBrokerEnvironment({ ...FIXED_BROKER_ENV, [name]: "/attacker" }),
    );
    assert.equal(FIXED_BROKER_ENV[name], undefined);
  }
  assert.doesNotThrow(() => assertBrokerEnvironment(FIXED_BROKER_ENV));
});

test("App JWT uses RS256 and GitHub clock bounds", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwt = createAppJwt({
    appId: APP_ID,
    privateKey,
    nowSeconds: NOW_SECONDS,
  });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    exp: NOW_SECONDS + 9 * 60,
    iat: NOW_SECONDS - 60,
    iss: String(APP_ID),
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
});

test("Secret Manager read uses one fixed child without credential output paths", async () => {
  const pem = privateKeyFixture();
  let call;
  const key = await readPrivateKey({
    runFile: async (file, args, callOptions) => {
      call = { file, args, options: callOptions };
      return Buffer.from(pem);
    },
  });
  assert.equal(call.file, GCLOUD_PATH);
  assert(call.args.includes(`--project=${GCP_PROJECT_ID}`));
  assert(
    call.args.includes(
      `--impersonate-service-account=${GCP_BROKER_SERVICE_ACCOUNT}`,
    ),
  );
  assert(call.args.includes(`--secret=${PRIVATE_KEY_SECRET_ID}`));
  assert.deepEqual(call.options.env, FIXED_BROKER_ENV);
  assert.equal(call.options.cwd, BROKER_OPERATION_CWD);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.env.HTTPS_PROXY, undefined);
  assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.equal(call.options.env.GH_TOKEN, undefined);
  assert(!JSON.stringify(call).includes(PRIVATE_KEY_MARKER));
  key.fill(0);
  pem.fill(0);
});

test("installation exchange pins repository, profile, expiry, and request shape", async () => {
  for (const profile of TRUSTED_PROFILES) {
    const permissions = requestedPermissions(clientOptions(profile));
    const requests = [];
    const token = await exchangeInstallationToken({
      installationId: INSTALLATION_ID,
      jwt: "header.payload.signature",
      permissions,
      nowMs: NOW_SECONDS * 1000,
      fetchImpl: async (url, requestOptions) => {
        requests.push({ url, options: requestOptions });
        return requests.length === 1
          ? jsonResponse(tokenPayload(permissions), 201)
          : jsonResponse(tokenRepositoryScope(), 200);
      },
    });
    assert.equal(token, INSTALLATION_TOKEN);
    assert.equal(
      requests[0].url,
      `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    );
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      permissions,
      repositories: [REPOSITORY_NAME],
    });
    assert.equal(
      requests[1].url,
      "https://api.github.com/installation/repositories?per_page=2",
    );
    assert.equal(
      requests[1].options.headers.Authorization,
      `Bearer ${INSTALLATION_TOKEN}`,
    );
    assert.equal(requests[0].options.redirect, "error");
    assert.equal(requests[0].options.env, undefined);
    assert.equal(requests[1].options.env, undefined);
  }

  const permissions = requestedPermissions(clientOptions(PROFILE.READ));
  for (const payload of [
    tokenPayload(permissions, { permissions: { contents: "read" } }),
    tokenPayload(permissions, { repository_selection: "all" }),
    tokenPayload(permissions, {
      expires_at: new Date((NOW_SECONDS + 49 * 60) * 1000).toISOString(),
    }),
    tokenPayload(permissions, {
      expires_at: new Date((NOW_SECONDS + 62 * 60) * 1000).toISOString(),
    }),
  ]) {
    await assert.rejects(
      exchangeInstallationToken({
        installationId: INSTALLATION_ID,
        jwt: "header.payload.signature",
        permissions,
        nowMs: NOW_SECONDS * 1000,
        fetchImpl: async () => jsonResponse(payload, 201),
      }),
    );
  }

  for (const repositoryScope of [
    tokenRepositoryScope({
      repositories: [{ full_name: "other/repo" }],
    }),
    tokenRepositoryScope({
      total_count: 2,
      repositories: [
        { full_name: REPOSITORY_FULL_NAME },
        { full_name: "other/repo" },
      ],
    }),
    { total_count: 1, repositories: [] },
  ]) {
    let calls = 0;
    await assert.rejects(
      exchangeInstallationToken({
        installationId: INSTALLATION_ID,
        jwt: "header.payload.signature",
        permissions,
        nowMs: NOW_SECONDS * 1000,
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? jsonResponse(tokenPayload(permissions), 201)
            : jsonResponse(repositoryScope, 200);
        },
      }),
      /not scoped to the expected repository/u,
    );
  }
});

test("broker returns one normalized envelope and redacts all credential canaries", async () => {
  const key = privateKeyFixture();
  let mintedJwt = "";
  let operationCall;
  let stdout = "";
  const status = await runBroker(brokerArgv(PROFILE.READ, "repo-view", []), {
    env: FIXED_BROKER_ENV,
    verifyRuntime: async () => {},
    stdout: { write: (value) => (stdout += value) },
    tokenDependencies: {
      readKey: async () => key,
      sign: () => Buffer.from("signature"),
      nowSeconds: NOW_SECONDS,
      exchangeToken: async ({ jwt, permissions }) => {
        mintedJwt = jwt;
        assert.deepEqual(permissions, INSTALLATION_PERMISSIONS[PROFILE.READ]);
        return INSTALLATION_TOKEN;
      },
    },
    executeOperation: async (call) => {
      operationCall = call;
      return {
        nameWithOwner: REPOSITORY_FULL_NAME,
        defaultBranch: INSTALLATION_TOKEN,
        jwt: mintedJwt,
        pem: privateKeyFixture().toString("utf8"),
      };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(operationCall.parameters, {});
  assert.equal(operationCall.operation, "repo-view");
  assert.equal(operationCall.token, INSTALLATION_TOKEN);
  assert(key.every((byte) => byte === 0));
  assert(!stdout.includes(INSTALLATION_TOKEN));
  assert(!stdout.includes(mintedJwt));
  assert(!stdout.includes(PRIVATE_KEY_MARKER));
  const envelope = JSON.parse(stdout);
  assert.deepEqual(Object.keys(envelope), ["ok", "operation", "result"]);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.operation, "repo-view");
  assert.equal(envelope.result.defaultBranch, "[REDACTED]");
  assert.equal(envelope.result.jwt, "[REDACTED]");
  assert.equal(envelope.result.pem, "[REDACTED]");
});

test("redaction catches untracked installation-token and PEM shapes", () => {
  const pem = privateKeyFixture().toString("utf8");
  const output = redactBrokerOutput(`${TOKEN_MARKER}\n${pem}\nsecret-value`, [
    "secret-value",
  ]);
  assert.equal(output.includes(TOKEN_MARKER), false);
  assert.equal(output.includes(PRIVATE_KEY_MARKER), false);
  assert.equal(output.includes("secret-value"), false);
});

test("trusted runtime requires root-owned code and private broker state", async () => {
  const brokerUid = 991;
  const files = new Set([
    BROKER_INSTALL_PATH,
    BROKER_MODULE_INSTALL_PATH,
    BROKER_POLICY_INSTALL_PATH,
    BROKER_NODE_PATH,
    GCLOUD_PATH,
    GCLOUD_PYTHON_PATH,
  ]);
  const privateDirectories = new Set([
    FIXED_BROKER_ENV.CLOUDSDK_CONFIG,
    FIXED_BROKER_ENV.TMPDIR,
  ]);
  const inspect = async (value) => {
    if (files.has(value)) return safeFileStat();
    if (privateDirectories.has(value)) {
      return safeDirectoryStat({ mode: 0o040700, uid: brokerUid });
    }
    return safeDirectoryStat();
  };
  const listed = [];
  const list = async (value) => {
    listed.push(value);
    return [];
  };
  await assert.doesNotReject(
    verifyTrustedRuntimePaths({
      inspect,
      list,
      effectiveUid: () => brokerUid,
    }),
  );
  assert.deepEqual(listed, [
    BROKER_NODE_ROOT,
    GCLOUD_SDK_ROOT,
    GCLOUD_PYTHON_ROOT,
  ]);
  await assert.rejects(
    verifyTrustedRuntimePaths({
      inspect: async (value) =>
        value === GCLOUD_PATH ? safeFileStat({ uid: 501 }) : inspect(value),
      list,
      effectiveUid: () => brokerUid,
    }),
    /ownership\/mode/u,
  );
  await assert.rejects(
    verifyTrustedRuntimePaths({
      inspect: async (value) =>
        value === FIXED_BROKER_ENV.TMPDIR
          ? safeDirectoryStat({ mode: 0o040750, uid: brokerUid })
          : inspect(value),
      list,
      effectiveUid: () => brokerUid,
    }),
    /ownership\/mode/u,
  );
});

test("trusted runtime tree rejects nested writable, foreign, and linked code", async () => {
  const root = "/trusted-runtime";
  const list = async (value) => {
    if (value === root) return ["bin", "README"];
    if (value === `${root}/bin`) return ["tool"];
    throw new Error("unexpected directory");
  };
  const inspect = async (value) =>
    value === `${root}/bin` ? safeDirectoryStat() : safeFileStat();

  await assert.doesNotReject(
    verifyRootOwnedRuntimeTree(root, { inspect, list }),
  );
  for (const unsafeStats of [
    safeFileStat({ uid: 501 }),
    safeFileStat({ mode: 0o100575 }),
    safeFileStat({ isSymbolicLink: () => true }),
  ]) {
    await assert.rejects(
      verifyRootOwnedRuntimeTree(root, {
        inspect: async (value) =>
          value === `${root}/bin/tool` ? unsafeStats : inspect(value),
        list,
      }),
      /ownership\/mode/u,
    );
  }
  await assert.rejects(
    verifyRootOwnedRuntimeTree(root, {
      inspect,
      list: async () => ["../escape"],
    }),
    /invalid entry/u,
  );
});

test("agent client invokes only sudo and never receives a token", async () => {
  let call;
  const status = await invokeInstalledBroker(clientOptions(), {
    verifyBroker: async () => {},
    runProcess: async (file, args, callOptions) => {
      call = { file, args, options: callOptions };
      return 23;
    },
  });
  assert.equal(status, 23);
  assert.equal(call.file, "/usr/bin/sudo");
  assert.deepEqual(call.args.slice(0, 4), [
    "-n",
    "-u",
    BROKER_OS_USER,
    BROKER_INSTALL_PATH,
  ]);
  assert(call.args.includes("--profile"));
  assert(call.args.includes("pr-view"));
  assert(!JSON.stringify(call).includes(INSTALLATION_TOKEN));
  assert.equal(call.options.cwd, BROKER_OPERATION_CWD);
  assert.deepEqual(call.options.env, { LANG: "C", LC_ALL: "C" });
  assert.equal(call.options.shell, false);
  assert.equal(call.options.stdio, "inherit");

  let received;
  const clientStatus = await runClient(
    ["--profile", PROFILE.READ, "--", "pr-view", "1"],
    {
      env: BASE_ENV,
      invokeBroker: async (value) => {
        received = value;
        return 7;
      },
    },
  );
  assert.equal(clientStatus, 7);
  assert.deepEqual(received, clientOptions());
  assert.equal(received.token, undefined);
  assert.equal(received.parameters, undefined);
});

test("client refuses ambient human credential and routing surfaces", async () => {
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_CONFIG_DIR",
    "GIT_CONFIG_PARAMETERS",
    "GITHUB_OWNER",
    "GITHUB_ORGANIZATION",
    "GITHUB_BASE_URL",
    "TF_VAR_github_token",
    "TF_VAR_local_agent_github_app_private_key",
  ]) {
    assert.throws(() =>
      assertNoAmbientGithubCredential({ ...BASE_ENV, [name]: TOKEN_MARKER }),
    );
  }
  let calls = 0;
  await assert.rejects(
    runClient(["--profile", PROFILE.READ, "--", "repo-view"], {
      env: { ...BASE_ENV, GH_TOKEN: TOKEN_MARKER },
      invokeBroker: async () => {
        calls += 1;
        return 0;
      },
    }),
  );
  assert.equal(calls, 0);
});

test("client requires exact root-owned launcher, module, and policy copies", async () => {
  const reviewed = new Map([
    [BROKER_INSTALL_PATH, Buffer.from("launcher")],
    [BROKER_MODULE_INSTALL_PATH, Buffer.from("broker")],
    [BROKER_POLICY_INSTALL_PATH, Buffer.from("policy")],
  ]);
  const sourceBySuffix = new Map([
    ["local-agent-github-launcher.mjs", Buffer.from("launcher")],
    ["local-agent-github-broker.mjs", Buffer.from("broker")],
    ["local-agent-github-command-policy.mjs", Buffer.from("policy")],
  ]);
  const files = new Set([
    BROKER_INSTALL_PATH,
    BROKER_MODULE_INSTALL_PATH,
    BROKER_POLICY_INSTALL_PATH,
    BROKER_NODE_PATH,
    GCLOUD_PATH,
    GCLOUD_PYTHON_PATH,
  ]);
  const inspect = async (value) =>
    files.has(value) ? safeFileStat() : safeDirectoryStat();
  const read = async (value) => {
    if (reviewed.has(value)) return reviewed.get(value);
    for (const [suffix, bytes] of sourceBySuffix) {
      if (value.endsWith(suffix)) return bytes;
    }
    throw new Error("unexpected read");
  };
  await assert.doesNotReject(verifyInstalledBroker({ read, inspect }));
  await assert.rejects(
    verifyInstalledBroker({
      read: async (value) =>
        value === BROKER_POLICY_INSTALL_PATH
          ? Buffer.from("changed")
          : read(value),
      inspect,
    }),
    /does not match/u,
  );
  await assert.rejects(
    verifyInstalledBroker({
      read,
      inspect: async (value) =>
        value === GCLOUD_PATH ? safeFileStat({ uid: 501 }) : inspect(value),
    }),
    /ownership\/mode/u,
  );
});

test("broker and client failures do not disclose arbitrary error text", () => {
  const unsafe = new Error(`${PRIVATE_KEY_MARKER} ${TOKEN_MARKER}`);
  assert.equal(brokerFailureMessage(unsafe), "internal broker error");
  assert(!brokerFailureMessage(unsafe).includes(TOKEN_MARKER));
});

test("source contract has no token-bearing repository child or fallback lane", () => {
  const broker = readFileSync(
    new URL("./local-agent-github-broker.mjs", import.meta.url),
    "utf8",
  );
  const client = readFileSync(
    new URL("./local-agent-github-exec.mjs", import.meta.url),
    "utf8",
  );
  const launcher = readFileSync(
    new URL("./local-agent-github-launcher.mjs", import.meta.url),
    "utf8",
  );
  assert.equal((broker.match(/\bexecFile\(/gu) ?? []).length, 1);
  assert(!/\bspawn\(|\bfork\(/u.test(broker));
  assert(!/GH_TOKEN\s*:|GITHUB_TOKEN\s*:/u.test(broker));
  assert(
    !/git\s+push|\/git\/refs|\/contents\/|\/merge(?:\W|$)|\bpnpm\b/u.test(
      broker,
    ),
  );
  assert(!broker.includes('approve: "APPROVE"'));
  assert(!/writeFile|appendFile|mkdtemp|createWriteStream/u.test(broker));
  assert(
    !/requestInstallationToken|buildChildEnvironment|GH_TOKEN\s*=/u.test(
      client,
    ),
  );
  assert(
    launcher.startsWith(
      "#!/usr/bin/env -S -i /usr/local/libexec/mento-node-runtime/bin/node\n",
    ),
  );
  assert(!launcher.includes("/bin/sh"));
  assert(launcher.includes("delete process.env[name]"));
  assert(launcher.includes("Object.assign(process.env, FIXED_BROKER_ENV)"));
  assert(launcher.includes("process.chdir(BROKER_OPERATION_CWD)"));
  assert(launcher.includes("process.umask(0o077)"));
  assert(launcher.includes("process.exitCode = await runBroker"));
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import yaml from "js-yaml";

import {
  CLAUDE_APP_TOKEN_AUDIENCE,
  CLAUDE_APP_TOKEN_EXCHANGE_URL,
  CLAUDE_OIDC_ISSUER,
  MAX_REVIEW_COMMENT_BYTES,
  assertBoundedReviewCommentBody,
  buildClaudeReviewAttestationArtifactName,
  buildCleanReviewEnvelope,
  buildReviewBody,
  publishClaudeReview,
  publishClaudeReviewWithSentinel,
  readStructuredReviewFile,
  resolveReviewContext,
  serializeStructuredReview,
  validateOidcClaims,
  validateStructuredReview,
  writeReviewInputFile,
  writeStructuredReviewFile,
} from "./claude-review-workflow.mjs";
import { attachClaudeReviewAttestationProvenance } from "./pr-ready-state.mjs";

const REPOSITORY = "mento-protocol/monitoring-monorepo";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TEST_OIDC_REQUEST_CREDENTIAL = "oidc-request-token";
const TEST_APP_CREDENTIAL = "app-token";
const CLAUDE_REVIEW_PRODUCTION_MODULES = [
  "claude-review-contract.mjs",
  "claude-review-context.mjs",
  "claude-review-publisher.mjs",
  "claude-review-workflow.mjs",
];

test("Claude review production modules keep substantial file-size headroom", () => {
  for (const moduleName of CLAUDE_REVIEW_PRODUCTION_MODULES) {
    const lineCount = readFileSync(new URL(moduleName, import.meta.url), "utf8")
      .trimEnd()
      .split("\n").length;
    assert.ok(
      lineCount <= 500,
      `${moduleName} has ${lineCount} lines; expected at most 500`,
    );
  }
});

function prResponse(overrides = {}) {
  return {
    number: 1567,
    state: "open",
    draft: false,
    head: {
      sha: HEAD,
      ref: "fix/claude-review",
      repo: { full_name: REPOSITORY },
    },
    base: {
      sha: BASE,
      ref: "main",
      repo: { full_name: REPOSITORY },
    },
    user: { login: "chapati23" },
    ...overrides,
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() {
      return body;
    },
  };
}

function baseWorkflowRunEvent(overrides = {}) {
  return {
    action: "completed",
    workflow_run: {
      name: "Claude Review Request",
      path: ".github/workflows/claude-review-request.yml",
      event: "pull_request",
      conclusion: "success",
      head_sha: HEAD,
      head_branch: "fix/claude-review",
      head_repository: { full_name: REPOSITORY },
      actor: { login: "chapati23", type: "User" },
      pull_requests: [],
      ...overrides,
    },
    repository: { full_name: REPOSITORY, default_branch: "main" },
  };
}

function baseIssueCommentEvent(overrides = {}) {
  return {
    action: "created",
    comment: {
      body: "@claude review",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    issue: {
      number: 1567,
      pull_request: { url: "https://api.github.test/pr" },
    },
    repository: { full_name: REPOSITORY, default_branch: "main" },
    ...overrides,
  };
}

function baseReviewCommentEvent(overrides = {}) {
  return {
    action: "created",
    comment: {
      body: "@claude review",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    pull_request: { number: 1567 },
    repository: { full_name: REPOSITORY, default_branch: "main" },
    ...overrides,
  };
}

function baseReviewEvent(overrides = {}) {
  return {
    action: "submitted",
    review: {
      body: "@claude review",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    pull_request: { number: 1567 },
    repository: { full_name: REPOSITORY, default_branch: "main" },
    ...overrides,
  };
}

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function oidcToken(claimOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return [
    encodeBase64Url({ alg: "RS256", typ: "JWT" }),
    encodeBase64Url({
      iss: CLAUDE_OIDC_ISSUER,
      aud: CLAUDE_APP_TOKEN_AUDIENCE,
      repository: REPOSITORY,
      workflow_ref: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
      run_id: "31754675314",
      run_attempt: "2",
      iat: now - 5,
      nbf: now - 5,
      exp: now + 300,
      ...claimOverrides,
    }),
    "signature",
  ].join(".");
}

test("clean review output has one byte-exact finite envelope", () => {
  assert.equal(
    buildCleanReviewEnvelope({ prNumber: 1567, headSha: HEAD }),
    [
      "<!-- mento-claude-clean-review:v1 -->",
      "MENTO CLAUDE CLEAN REVIEW v1",
      "PR: 1567",
      `HEAD: ${HEAD}`,
      "VERDICT: CLEAN",
      "FINDINGS: 0",
      "FOLLOW-UP: NONE",
      "END MENTO CLAUDE CLEAN REVIEW v1",
    ].join("\n"),
  );
});

test("structured clean review allows no findings, follow-up, or extra keys", () => {
  assert.deepEqual(
    validateStructuredReview({
      verdict: "clean",
      findings: [],
      follow_up: null,
    }),
    { verdict: "clean", findings: [], follow_up: null },
  );
  assert.equal(
    serializeStructuredReview({
      verdict: "clean",
      findings: [],
      follow_up: null,
    }),
    '{"verdict":"clean","findings":[],"follow_up":null}\n',
  );

  for (const review of [
    {
      verdict: "clean",
      findings: [{ severity: "P2", title: "Fix this", detail: "Required" }],
      follow_up: null,
    },
    { verdict: "clean", findings: [], follow_up: "Run a test" },
    { verdict: "clean", findings: [], follow_up: null, prose: "LGTM" },
    { verdict: "mostly-clean", findings: [], follow_up: null },
  ]) {
    assert.throws(() => validateStructuredReview(review));
  }
});

test("non-clean structured reviews require bounded findings or follow-up", () => {
  const finding = {
    severity: "P1",
    title: "Reject stale heads",
    detail: "The publish path accepts a stale head.",
    path: "scripts/claude-review-workflow.mjs",
    line: 42,
  };
  assert.deepEqual(
    validateStructuredReview({
      verdict: "needs_changes",
      findings: [finding],
      follow_up: null,
    }).findings,
    [finding],
  );
  assert.throws(() =>
    validateStructuredReview({
      verdict: "needs_changes",
      findings: [],
      follow_up: null,
    }),
  );
  assert.throws(() =>
    validateStructuredReview({
      verdict: "needs_discussion",
      findings: [],
      follow_up: "x".repeat(1001),
    }),
  );
  assert.throws(() =>
    validateStructuredReview({
      verdict: "needs_discussion",
      findings: [],
      follow_up: "hidden\u0000control",
    }),
  );
});

test("every accepted structured review fits the GitHub comment body bound", () => {
  const finding = {
    severity: "P2",
    title: "t".repeat(120),
    detail: "d".repeat(400),
    path: "p".repeat(240),
    line: Number.MAX_SAFE_INTEGER,
  };
  const review = {
    verdict: "needs_changes",
    findings: Array.from({ length: 12 }, () => ({ ...finding })),
    follow_up: "f".repeat(400),
  };
  const body = buildReviewBody(validateStructuredReview(review), {
    prNumber: Number.MAX_SAFE_INTEGER,
    headSha: HEAD,
  });

  assert(Buffer.byteLength(body, "utf8") < MAX_REVIEW_COMMENT_BYTES);
  assert(Buffer.byteLength(serializeStructuredReview(review), "utf8") < 48_000);
  assert.throws(() =>
    validateStructuredReview({
      ...review,
      findings: [...review.findings, { ...finding }],
    }),
  );
  assert.equal(
    assertBoundedReviewCommentBody("x".repeat(MAX_REVIEW_COMMENT_BYTES)).length,
    MAX_REVIEW_COMMENT_BYTES,
  );
  assert.throws(
    () =>
      assertBoundedReviewCommentBody("x".repeat(MAX_REVIEW_COMMENT_BYTES + 1)),
    /GitHub body bound/,
  );
});

test("structured review artifact is canonical, bounded, and symlink-safe", (t) => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "claude-review-test-"));
  t.after(() => rmSync(runnerTemp, { force: true, recursive: true }));
  const review = { verdict: "clean", findings: [], follow_up: null };
  const reviewFile = join(runnerTemp, "valid", "review.json");
  const env = {
    RUNNER_TEMP: runnerTemp,
    CLAUDE_STRUCTURED_REVIEW_FILE: reviewFile,
  };

  writeStructuredReviewFile(review, env);
  assert.equal(statSync(reviewFile).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(reviewFile, "utf8"),
    serializeStructuredReview(review),
  );
  assert.deepEqual(readStructuredReviewFile(env), review);

  const tamperedFile = join(runnerTemp, "tampered.json");
  writeFileSync(tamperedFile, `${serializeStructuredReview(review)}\n`, "utf8");
  assert.throws(() =>
    readStructuredReviewFile({
      ...env,
      CLAUDE_STRUCTURED_REVIEW_FILE: tamperedFile,
    }),
  );

  const linkedFile = join(runnerTemp, "linked.json");
  symlinkSync(reviewFile, linkedFile);
  assert.throws(() =>
    readStructuredReviewFile({
      ...env,
      CLAUDE_STRUCTURED_REVIEW_FILE: linkedFile,
    }),
  );

  assert.throws(() =>
    writeStructuredReviewFile(review, {
      ...env,
      CLAUDE_STRUCTURED_REVIEW_FILE: join(runnerTemp, "..", "outside.json"),
    }),
  );
});

test("auto-review and on-demand events normalize to the same trusted context", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(
      200,
      String(url).includes("/pulls?") ? [prResponse()] : prResponse(),
    );
  };

  const auto = await resolveReviewContext({
    eventName: "workflow_run",
    event: baseWorkflowRunEvent(),
    repository: REPOSITORY,
    githubToken: "read-token",
    fetchImpl,
  });
  const requested = await Promise.all(
    [
      ["issue_comment", baseIssueCommentEvent()],
      ["pull_request_review_comment", baseReviewCommentEvent()],
      ["pull_request_review", baseReviewEvent()],
    ].map(([eventName, event]) =>
      resolveReviewContext({
        eventName,
        event,
        repository: REPOSITORY,
        githubToken: "read-token",
        fetchImpl,
      }),
    ),
  );

  for (const context of requested) assert.deepEqual(auto, context);
  assert.deepEqual(auto, {
    repository: REPOSITORY,
    prNumber: 1567,
    headSha: HEAD,
    headRef: "fix/claude-review",
    baseSha: BASE,
    baseRef: "main",
    workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
  });
  assert.equal(calls.length, 4);
  const automaticLookup = new URL(calls[0].url);
  assert.equal(automaticLookup.pathname, `/repos/${REPOSITORY}/pulls`);
  assert.equal(automaticLookup.searchParams.get("state"), "open");
  assert.equal(
    automaticLookup.searchParams.get("head"),
    "mento-protocol:fix/claude-review",
  );
  assert.equal(automaticLookup.searchParams.get("per_page"), "100");
});

test("event normalization fails closed before API reads", async () => {
  const rejected = [
    [
      "unauthorized association",
      "issue_comment",
      baseIssueCommentEvent({
        comment: {
          body: "@claude review",
          author_association: "CONTRIBUTOR",
          user: { login: "outsider", type: "User" },
        },
      }),
    ],
    [
      "non-PR comment",
      "issue_comment",
      baseIssueCommentEvent({ issue: { number: 1567 } }),
    ],
    [
      "missing review command",
      "issue_comment",
      baseIssueCommentEvent({
        comment: {
          body: "@claude explain",
          author_association: "MEMBER",
          user: { login: "chapati23", type: "User" },
        },
      }),
    ],
    [
      "edited review request",
      "issue_comment",
      baseIssueCommentEvent({ action: "edited" }),
    ],
    [
      "edited inline review request",
      "pull_request_review_comment",
      baseReviewCommentEvent({ action: "edited" }),
    ],
    [
      "dismissed review request",
      "pull_request_review",
      baseReviewEvent({ action: "dismissed" }),
    ],
    [
      "bot auto-review",
      "workflow_run",
      baseWorkflowRunEvent({
        actor: { login: "dependabot[bot]", type: "Bot" },
      }),
    ],
    [
      "fork event",
      "workflow_run",
      baseWorkflowRunEvent({
        head_repository: { full_name: "fork/repo" },
      }),
    ],
    [
      "wrong dispatcher",
      "workflow_run",
      baseWorkflowRunEvent({ path: ".github/workflows/other.yml" }),
    ],
  ];

  for (const [label, eventName, event] of rejected) {
    let fetched = false;
    await assert.rejects(
      resolveReviewContext({
        eventName,
        event,
        repository: REPOSITORY,
        githubToken: "read-token",
        fetchImpl: async () => {
          fetched = true;
          return response(200, prResponse());
        },
      }),
      label,
    );
    assert.equal(fetched, false, label);
  }
});

test("automatic dispatch fails closed on ambiguous or mismatched live PRs", async () => {
  const cases = [
    ["no PR", [], /exactly one open pull request/i],
    [
      "ambiguous PRs",
      [prResponse(), prResponse({ number: 1568 })],
      /exactly one open pull request/i,
    ],
    [
      "wrong head",
      [
        prResponse({
          head: {
            sha: "c".repeat(40),
            ref: "fix/claude-review",
            repo: { full_name: REPOSITORY },
          },
        }),
      ],
      /head/i,
    ],
    [
      "wrong base",
      [
        prResponse({
          base: {
            sha: BASE,
            ref: "release",
            repo: { full_name: REPOSITORY },
          },
        }),
      ],
      /default branch/i,
    ],
    [
      "wrong repository",
      [
        prResponse({
          head: {
            sha: HEAD,
            ref: "fix/claude-review",
            repo: { full_name: "fork/repo" },
          },
        }),
      ],
      /repository/i,
    ],
  ];

  for (const [label, pulls, expected] of cases) {
    await assert.rejects(
      resolveReviewContext({
        eventName: "workflow_run",
        event: baseWorkflowRunEvent(),
        repository: REPOSITORY,
        githubToken: "read-token",
        fetchImpl: async () => response(200, pulls),
      }),
      expected,
      label,
    );
  }
});

test("API normalization rejects forks, closed/draft PRs, and autofix heads", async () => {
  for (const [label, remote] of [
    [
      "fork",
      prResponse({
        head: { sha: HEAD, ref: "fix/x", repo: { full_name: "fork/repo" } },
      }),
    ],
    ["closed", prResponse({ state: "closed" })],
    ["draft", prResponse({ draft: true })],
    [
      "non-default base",
      prResponse({
        base: {
          sha: BASE,
          ref: "release",
          repo: { full_name: REPOSITORY },
        },
      }),
    ],
    [
      "autofix",
      prResponse({
        head: {
          sha: HEAD,
          ref: "sentry-autofix/untrusted",
          repo: { full_name: REPOSITORY },
        },
      }),
    ],
  ]) {
    await assert.rejects(
      resolveReviewContext({
        eventName: "issue_comment",
        event: baseIssueCommentEvent(),
        repository: REPOSITORY,
        githubToken: "read-token",
        fetchImpl: async () => response(200, remote),
      }),
      label,
    );
  }

  await assert.rejects(
    resolveReviewContext({
      eventName: "workflow_run",
      event: baseWorkflowRunEvent({ head_sha: "c".repeat(40) }),
      repository: REPOSITORY,
      githubToken: "read-token",
      fetchImpl: async () => response(200, [prResponse()]),
    }),
    /head/i,
  );
});

test("OIDC claims bind issuer, audience, repository, workflow, run attempt, and time", () => {
  const expected = {
    repository: REPOSITORY,
    workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
    runId: "31754675314",
    runAttempt: "2",
  };
  assert.equal(
    validateOidcClaims(oidcToken(), expected).repository,
    REPOSITORY,
  );

  for (const claims of [
    { iss: "https://issuer.invalid" },
    { aud: "wrong-audience" },
    { repository: "fork/repo" },
    {
      workflow_ref: `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`,
    },
    { run_id: "1" },
    { run_attempt: "1" },
    { exp: 1 },
  ]) {
    assert.throws(() => validateOidcClaims(oidcToken(claims), expected));
  }
});

test("publisher rejects a non-trusted workflow ref before requesting OIDC", async () => {
  let fetched = false;
  await assert.rejects(
    publishClaudeReview({
      review: { verdict: "clean", findings: [], follow_up: null },
      context: {
        repository: REPOSITORY,
        prNumber: 1567,
        headSha: HEAD,
        workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
      },
      env: {
        GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/claude.yml@refs/pull/1567/merge`,
      },
      fetchImpl: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    }),
    /trusted workflow ref/i,
  );
  assert.equal(fetched, false);
});

test("publisher validates, exchanges, rechecks head, persists, verifies, and revokes", async () => {
  const body = buildCleanReviewEnvelope({ prNumber: 1567, headSha: HEAD });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("https://token.actions.test")) {
      return response(200, { value: oidcToken() });
    }
    if (String(url) === CLAUDE_APP_TOKEN_EXCHANGE_URL) {
      return response(200, { token: TEST_APP_CREDENTIAL });
    }
    if (String(url).endsWith("/pulls/1567")) {
      return response(200, prResponse());
    }
    if (String(url).includes("/issues/1567/comments?")) {
      return response(200, []);
    }
    if (String(url).endsWith("/issues/1567/comments")) {
      return response(201, {
        id: 99,
        body,
        user: { login: "claude[bot]", type: "Bot" },
      });
    }
    if (String(url).endsWith("/issues/comments/99")) {
      return response(200, {
        id: 99,
        body,
        user: { login: "claude[bot]", type: "Bot" },
      });
    }
    if (String(url).endsWith("/installation/token")) {
      return response(204, {});
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await publishClaudeReview({
    review: { verdict: "clean", findings: [], follow_up: null },
    context: {
      repository: REPOSITORY,
      prNumber: 1567,
      headSha: HEAD,
      headRef: "fix/claude-review",
      baseSha: BASE,
      baseRef: "main",
      workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
    },
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test?id=1",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: TEST_OIDC_REQUEST_CREDENTIAL,
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
      GITHUB_RUN_ID: "31754675314",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_API_URL: "https://api.github.com",
    },
    fetchImpl,
  });

  assert.deepEqual(result, { commentId: 99, body });
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "https://token.actions.test/?id=1&audience=claude-code-github-action",
      CLAUDE_APP_TOKEN_EXCHANGE_URL,
      "https://api.github.com/repos/mento-protocol/monitoring-monorepo/pulls/1567",
      "https://api.github.com/repos/mento-protocol/monitoring-monorepo/issues/1567/comments?per_page=100&page=1",
      "https://api.github.com/repos/mento-protocol/monitoring-monorepo/issues/1567/comments",
      "https://api.github.com/repos/mento-protocol/monitoring-monorepo/issues/comments/99",
      "https://api.github.com/installation/token",
    ],
  );
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    permissions: {
      pull_requests: "read",
      issues: "write",
    },
  });
  assert.equal(calls[4].options.body, JSON.stringify({ body }));
  assert.equal(calls.at(-1).options.method, "DELETE");
});

test("publisher never posts a stale head and still revokes the App token", async () => {
  const calls = [];
  await assert.rejects(
    publishClaudeReview({
      review: { verdict: "clean", findings: [], follow_up: null },
      context: {
        repository: REPOSITORY,
        prNumber: 1567,
        headSha: HEAD,
        headRef: "fix/claude-review",
        baseSha: BASE,
        baseRef: "main",
        workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
      },
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: TEST_OIDC_REQUEST_CREDENTIAL,
        GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
        GITHUB_RUN_ID: "31754675314",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_API_URL: "https://api.github.com",
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url).startsWith("https://token.actions.test")) {
          return response(200, { value: oidcToken() });
        }
        if (String(url) === CLAUDE_APP_TOKEN_EXCHANGE_URL) {
          return response(200, { app_token: TEST_APP_CREDENTIAL });
        }
        if (String(url).endsWith("/pulls/1567")) {
          return response(
            200,
            prResponse({
              head: {
                sha: "c".repeat(40),
                ref: "fix/claude-review",
                repo: { full_name: REPOSITORY },
              },
            }),
          );
        }
        if (String(url).endsWith("/installation/token")) {
          return response(204, {});
        }
        throw new Error(`unexpected URL ${url}`);
      },
    }),
    /head/i,
  );
  assert.equal(
    calls.some(({ url }) => url.endsWith("/issues/1567/comments")),
    false,
  );
  assert.equal(calls.at(-1).url, "https://api.github.com/installation/token");
});

test("publisher rejects wrong author or persisted bytes and revokes", async () => {
  for (const mode of ["author", "body"]) {
    const calls = [];
    const expectedBody = buildCleanReviewEnvelope({
      prNumber: 1567,
      headSha: HEAD,
    });
    await assert.rejects(
      publishClaudeReview({
        review: { verdict: "clean", findings: [], follow_up: null },
        context: {
          repository: REPOSITORY,
          prNumber: 1567,
          headSha: HEAD,
          headRef: "fix/claude-review",
          baseSha: BASE,
          baseRef: "main",
          workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
        },
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: TEST_OIDC_REQUEST_CREDENTIAL,
          GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
          GITHUB_RUN_ID: "31754675314",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_API_URL: "https://api.github.com",
        },
        fetchImpl: async (url, options = {}) => {
          calls.push({ url: String(url), options });
          if (String(url).startsWith("https://token.actions.test")) {
            return response(200, { value: oidcToken() });
          }
          if (String(url) === CLAUDE_APP_TOKEN_EXCHANGE_URL) {
            return response(200, { token: TEST_APP_CREDENTIAL });
          }
          if (String(url).endsWith("/pulls/1567"))
            return response(200, prResponse());
          if (String(url).includes("/issues/1567/comments?")) {
            return response(200, []);
          }
          if (String(url).endsWith("/issues/1567/comments")) {
            return response(201, {
              id: 99,
              body: expectedBody,
              user:
                mode === "author"
                  ? { login: "github-actions[bot]", type: "Bot" }
                  : { login: "claude[bot]", type: "Bot" },
            });
          }
          if (String(url).endsWith("/issues/comments/99")) {
            return response(200, {
              id: 99,
              body: mode === "body" ? `${expectedBody}\n` : expectedBody,
              user: { login: "claude[bot]", type: "Bot" },
            });
          }
          if (String(url).endsWith("/installation/token"))
            return response(204, {});
          throw new Error(`unexpected URL ${url}`);
        },
      }),
    );
    assert.equal(calls.at(-1).url, "https://api.github.com/installation/token");
  }
});

test("clean-review sentinel is created only after successful token revocation", async (t) => {
  const review = { verdict: "clean", findings: [], follow_up: null };
  const body = buildCleanReviewEnvelope({ prNumber: 1567, headSha: HEAD });
  const context = {
    repository: REPOSITORY,
    prNumber: 1567,
    headSha: HEAD,
    workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
  };
  const makeEnv = (runnerTemp) => ({
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test?id=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: TEST_OIDC_REQUEST_CREDENTIAL,
    GITHUB_WORKFLOW_REF: context.workflowRef,
    GITHUB_RUN_ID: "31754675314",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_API_URL: "https://api.github.com",
    RUNNER_TEMP: runnerTemp,
    CLAUDE_REVIEW_ATTESTATION_FILE: join(
      runnerTemp,
      "claude-review",
      "attestation.json",
    ),
  });
  const makeFetch =
    (calls, revokeStatus) =>
    async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith("https://token.actions.test")) {
        return response(200, { value: oidcToken() });
      }
      if (String(url) === CLAUDE_APP_TOKEN_EXCHANGE_URL) {
        return response(200, { token: TEST_APP_CREDENTIAL });
      }
      if (String(url).endsWith("/pulls/1567")) {
        return response(200, prResponse());
      }
      if (String(url).includes("/issues/1567/comments?")) {
        return response(200, []);
      }
      if (String(url).endsWith("/issues/1567/comments")) {
        return response(201, {
          id: 99,
          body,
          user: { login: "claude[bot]", type: "Bot" },
        });
      }
      if (String(url).endsWith("/issues/comments/99")) {
        return response(200, {
          id: 99,
          body,
          user: { login: "claude[bot]", type: "Bot" },
        });
      }
      if (String(url).endsWith("/installation/token")) {
        return response(revokeStatus, {});
      }
      throw new Error(`unexpected URL ${url}`);
    };

  const successTemp = mkdtempSync(join(tmpdir(), "claude-sentinel-ok-"));
  const failureTemp = mkdtempSync(join(tmpdir(), "claude-sentinel-fail-"));
  t.after(() => rmSync(successTemp, { force: true, recursive: true }));
  t.after(() => rmSync(failureTemp, { force: true, recursive: true }));

  const successCalls = [];
  const success = await publishClaudeReviewWithSentinel({
    review,
    context,
    env: makeEnv(successTemp),
    fetchImpl: makeFetch(successCalls, 204),
  });
  assert.equal(
    successCalls.at(-1).url,
    "https://api.github.com/installation/token",
  );
  assert.equal(statSync(success.attestationFile).isFile(), true);
  const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
  assert.equal(
    success.artifactName,
    `mento-claude-clean-review-v1-1567-${HEAD}-99-${bodySha256}`,
  );
  assert.deepEqual(JSON.parse(readFileSync(success.attestationFile, "utf8")), {
    version: 1,
    repository: REPOSITORY,
    pr: 1567,
    head: HEAD,
    comment_id: 99,
    body_sha256: bodySha256,
    workflow_ref: context.workflowRef,
    run_id: "31754675314",
    run_attempt: "2",
  });

  const failureFile = join(failureTemp, "claude-review", "attestation.json");
  await assert.rejects(
    publishClaudeReviewWithSentinel({
      review,
      context,
      env: makeEnv(failureTemp),
      fetchImpl: makeFetch([], 500),
    }),
    /revocation failed/,
  );
  assert.throws(() => statSync(failureFile));
});

test("publisher retry reuses one exact comment and fails closed on duplicates", async (t) => {
  const review = { verdict: "clean", findings: [], follow_up: null };
  const body = buildCleanReviewEnvelope({ prNumber: 1567, headSha: HEAD });
  const context = {
    repository: REPOSITORY,
    prNumber: 1567,
    headSha: HEAD,
    workflowRef: `${REPOSITORY}/.github/workflows/claude.yml@refs/heads/main`,
  };
  const comment = {
    id: 99,
    body,
    user: { login: "claude[bot]", type: "Bot" },
  };
  const makeEnv = (runnerTemp, runAttempt) => ({
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test?id=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: TEST_OIDC_REQUEST_CREDENTIAL,
    GITHUB_WORKFLOW_REF: context.workflowRef,
    GITHUB_RUN_ID: "31754675314",
    GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_API_URL: "https://api.github.com",
    RUNNER_TEMP: runnerTemp,
    CLAUDE_REVIEW_ATTESTATION_FILE: join(
      runnerTemp,
      "claude-review",
      "attestation.json",
    ),
  });
  const makeFetch =
    (calls, existingComments, runAttempt) =>
    async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).startsWith("https://token.actions.test")) {
        return response(200, { value: oidcToken({ run_attempt: runAttempt }) });
      }
      if (String(url) === CLAUDE_APP_TOKEN_EXCHANGE_URL) {
        return response(200, { token: TEST_APP_CREDENTIAL });
      }
      if (String(url).endsWith("/pulls/1567")) {
        return response(200, prResponse());
      }
      if (String(url).includes("/issues/1567/comments?")) {
        return response(200, existingComments);
      }
      if (String(url).endsWith("/issues/1567/comments")) {
        return response(201, comment);
      }
      if (String(url).endsWith("/issues/comments/99")) {
        return response(200, comment);
      }
      if (String(url).endsWith("/installation/token")) {
        return response(204, {});
      }
      throw new Error(`unexpected URL ${url}`);
    };

  const firstTemp = mkdtempSync(join(tmpdir(), "claude-first-publish-"));
  const retryTemp = mkdtempSync(join(tmpdir(), "claude-retry-publish-"));
  const duplicateTemp = mkdtempSync(
    join(tmpdir(), "claude-duplicate-publish-"),
  );
  for (const path of [firstTemp, retryTemp, duplicateTemp]) {
    t.after(() => rmSync(path, { force: true, recursive: true }));
  }

  const firstCalls = [];
  const first = await publishClaudeReviewWithSentinel({
    review,
    context,
    env: makeEnv(firstTemp, "1"),
    fetchImpl: makeFetch(firstCalls, [], "1"),
  });
  assert.equal(
    firstCalls.filter(({ options }) => options.method === "POST").length,
    2,
    "OIDC exchange and comment creation are the only POST requests",
  );

  const retryCalls = [];
  const retry = await publishClaudeReviewWithSentinel({
    review,
    context,
    env: makeEnv(retryTemp, "2"),
    fetchImpl: makeFetch(retryCalls, [comment], "2"),
  });
  assert.equal(
    retryCalls.some(
      ({ url, options }) =>
        url.endsWith("/issues/1567/comments") && options.method === "POST",
    ),
    false,
  );
  assert.equal(retry.commentId, first.commentId);
  assert.equal(retry.artifactName, first.artifactName);
  assert.equal(statSync(retry.attestationFile).isFile(), true);

  const duplicateCalls = [];
  await assert.rejects(
    publishClaudeReviewWithSentinel({
      review,
      context,
      env: makeEnv(duplicateTemp, "3"),
      fetchImpl: makeFetch(
        duplicateCalls,
        [comment, { ...comment, id: 100 }],
        "3",
      ),
    }),
    /multiple exact Claude review comments/,
  );
  assert.equal(
    duplicateCalls.some(
      ({ url, options }) =>
        url.endsWith("/issues/1567/comments") && options.method === "POST",
    ),
    false,
  );
  assert.equal(
    duplicateCalls.at(-1).url,
    "https://api.github.com/installation/token",
  );
});

test("trusted review input is bounded and built without a shell", (t) => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "claude-review-input-"));
  const reviewInputFile = join(runnerTemp, "review-input", "review.txt");
  mkdirSync(join(runnerTemp, "review-target"));
  const calls = [];
  const outputs = new Map([
    ["rev-parse\u0000HEAD", `${HEAD}\n`],
    [`merge-base\u0000${BASE}\u0000${HEAD}`, `${BASE}\n`],
    ["status\u0000--porcelain=v1\u0000--untracked-files=all", ""],
    [
      `log\u0000--no-decorate\u0000--no-show-signature\u0000--format=%H%x09%P%x09%an%x09%ad%x09%s\u0000--date=iso-strict\u0000${BASE}..${HEAD}`,
      `${HEAD}\t${BASE}\tReviewer\t2026-08-14T00:00:00+00:00\tChange\n`,
    ],
    [
      `diff\u0000--no-ext-diff\u0000--no-textconv\u0000--stat\u0000${BASE}\u0000${HEAD}\u0000--`,
      " file.mjs | 1 +\n",
    ],
    [
      `diff\u0000--no-ext-diff\u0000--no-textconv\u0000--unified=80\u0000${BASE}\u0000${HEAD}\u0000--`,
      "diff --git a/file.mjs b/file.mjs\n+safe\n",
    ],
  ]);

  t.after(() => rmSync(runnerTemp, { force: true, recursive: true }));
  const result = writeReviewInputFile({
    context: {
      repository: REPOSITORY,
      prNumber: 1567,
      baseSha: BASE,
      headSha: HEAD,
    },
    env: {
      GITHUB_WORKSPACE: runnerTemp,
      CLAUDE_REVIEW_TARGET_DIR: join(runnerTemp, "review-target"),
      CLAUDE_REVIEW_INPUT_FILE: reviewInputFile,
    },
    runGitImpl: (_targetDir, args) => {
      calls.push(args);
      const output = outputs.get(args.join("\u0000"));
      if (output === undefined) throw new Error(`unexpected git call ${args}`);
      return output;
    },
  });

  assert.equal(result, reviewInputFile);
  assert.match(readFileSync(result, "utf8"), /MENTO CLAUDE REVIEW INPUT v1/);
  assert.match(readFileSync(result, "utf8"), /diff --git a\/file\.mjs/);
  assert.equal(
    calls.some((args) => args.includes("--no-ext-diff")),
    true,
  );
  assert.equal(
    calls.some((args) => args.includes("--no-textconv")),
    true,
  );

  const overflowTemp = mkdtempSync(join(tmpdir(), "claude-review-overflow-"));
  mkdirSync(join(overflowTemp, "review-target"));
  t.after(() => rmSync(overflowTemp, { force: true, recursive: true }));
  assert.throws(
    () =>
      writeReviewInputFile({
        context: {
          repository: REPOSITORY,
          prNumber: 1567,
          baseSha: BASE,
          headSha: HEAD,
        },
        env: {
          GITHUB_WORKSPACE: overflowTemp,
          CLAUDE_REVIEW_TARGET_DIR: join(overflowTemp, "review-target"),
          CLAUDE_REVIEW_INPUT_FILE: join(
            overflowTemp,
            "review-input",
            "review.txt",
          ),
        },
        runGitImpl: (_targetDir, args) => {
          if (args[0] === "rev-parse") return `${HEAD}\n`;
          if (args[0] === "merge-base") return `${BASE}\n`;
          if (args[0] === "status") return "";
          if (args[0] === "diff" && args.includes("--unified=80")) {
            return "x".repeat(750_001);
          }
          return "";
        },
      }),
    /exceeds its bound/,
  );
});

test("Claude clean-review provenance binds a nonexpired protected workflow run", async () => {
  const body = buildCleanReviewEnvelope({ prNumber: 1567, headSha: HEAD });
  const comment = {
    id: 99,
    body,
    created_at: "2026-08-14T00:00:00Z",
    user: { login: "claude[bot]", type: "Bot" },
  };
  const artifactName = buildClaudeReviewAttestationArtifactName({
    prNumber: 1567,
    headSha: HEAD,
    commentId: 99,
    body,
  });
  const artifact = {
    name: artifactName,
    expired: false,
    created_at: "2026-08-14T00:01:00Z",
    expires_at: "2026-11-12T00:01:00Z",
    workflow_run: { id: 31754675314 },
  };
  const run = {
    id: 31754675314,
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/claude.yml",
    event: "issue_comment",
    head_branch: "main",
    head_sha: BASE,
    repository: { full_name: REPOSITORY },
    actor: { login: "chapati23", type: "User" },
  };
  const common = {
    repo: {
      owner: "mento-protocol",
      name: "monitoring-monorepo",
      host: null,
    },
    pr: {
      number: 1567,
      headRefName: "fix/claude-review",
      headRefOid: HEAD,
      baseRefName: "main",
    },
    issueComments: [comment],
    now: new Date("2026-08-15T00:00:00Z"),
  };
  const attach = (overrides = {}) =>
    attachClaudeReviewAttestationProvenance({
      ...common,
      artifactLookup: async () => ({
        ok: true,
        value: { artifacts: [artifact] },
      }),
      runLookup: async () => ({ ok: true, value: run }),
      ...overrides,
    });

  const runBindings = [
    { event: "workflow_run", head_branch: "main", head_sha: BASE },
    { event: "issue_comment", head_branch: "main", head_sha: BASE },
    {
      event: "pull_request_review_comment",
      head_branch: "fix/claude-review",
      head_sha: HEAD,
    },
    {
      event: "pull_request_review",
      head_branch: "fix/claude-review",
      head_sha: HEAD,
    },
  ];
  for (const binding of runBindings) {
    const result = await attach({
      runLookup: async () => ({ ok: true, value: { ...run, ...binding } }),
    });
    assert.equal(
      result[0].claudeReviewProvenanceVerified,
      true,
      `${binding.event} accepts its protected run binding`,
    );

    const wrongBranch = await attach({
      runLookup: async () => ({
        ok: true,
        value: {
          ...run,
          ...binding,
          head_branch:
            binding.head_branch === "main" ? "fix/claude-review" : "main",
        },
      }),
    });
    assert.equal(
      wrongBranch[0].claudeReviewProvenanceVerified,
      false,
      `${binding.event} rejects a mismatched branch`,
    );

    const wrongOrMalformedSha = await attach({
      runLookup: async () => ({
        ok: true,
        value: {
          ...run,
          ...binding,
          head_sha: binding.head_sha === HEAD ? BASE : "not-a-head-sha",
        },
      }),
    });
    assert.equal(
      wrongOrMalformedSha[0].claudeReviewProvenanceVerified,
      false,
      `${binding.event} rejects a mismatched or malformed head SHA`,
    );

    for (const headSha of [undefined, "A".repeat(40)]) {
      const invalidSha = await attach({
        runLookup: async () => ({
          ok: true,
          value: { ...run, ...binding, head_sha: headSha },
        }),
      });
      assert.equal(
        invalidSha[0].claudeReviewProvenanceVerified,
        false,
        `${binding.event} rejects ${headSha ? "noncanonical" : "missing"} head SHA`,
      );
    }
  }

  await assert.rejects(
    attach({ artifactLookup: async () => ({ ok: false, error: "403" }) }),
    /artifact lookup failed/,
  );
  await assert.rejects(
    attach({ runLookup: async () => ({ ok: false, error: "502" }) }),
    /workflow run lookup failed/,
  );

  for (const [label, overrides] of [
    [
      "absent artifact",
      {
        artifactLookup: async () => ({
          ok: true,
          value: { artifacts: [] },
        }),
      },
    ],
    [
      "expired artifact",
      {
        artifactLookup: async () => ({
          ok: true,
          value: { artifacts: [{ ...artifact, expired: true }] },
        }),
      },
    ],
    [
      "wrong comment",
      {
        artifactLookup: async () => ({
          ok: true,
          value: {
            artifacts: [
              { ...artifact, name: artifactName.replace("-99-", "-100-") },
            ],
          },
        }),
      },
    ],
    [
      "wrong workflow",
      {
        runLookup: async () => ({
          ok: true,
          value: { ...run, path: ".github/workflows/other.yml" },
        }),
      },
    ],
    [
      "wrong trigger",
      {
        runLookup: async () => ({
          ok: true,
          value: { ...run, event: "workflow_dispatch" },
        }),
      },
    ],
    [
      "machine actor",
      {
        runLookup: async () => ({
          ok: true,
          value: {
            ...run,
            actor: { login: "dependabot[bot]", type: "Bot" },
          },
        }),
      },
    ],
  ]) {
    const result = await attach(overrides);
    assert.equal(result[0].claudeReviewProvenanceVerified, false, label);
  }
});

test("workflow consumes structured output and gives Claude no write transport", () => {
  const source = readFileSync(
    new URL("../.github/workflows/claude.yml", import.meta.url),
    "utf8",
  );
  const workflow = yaml.load(source);
  const requestSource = readFileSync(
    new URL("../.github/workflows/claude-review-request.yml", import.meta.url),
    "utf8",
  );
  const requestWorkflow = yaml.load(requestSource);
  const job = workflow.jobs.review;
  assert(job, "shared review job exists");
  assert.equal(workflow.jobs["auto-review"], undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.deepEqual(workflow.on.workflow_run.workflows, [
    "Claude Review Request",
  ]);
  assert(requestWorkflow.on.pull_request, "unprivileged PR dispatcher exists");
  assert.equal(requestSource.includes("secrets."), false);
  assert.equal(requestSource.includes("actions/checkout"), false);
  assert.equal(job.permissions.contents, "read");
  assert.equal(job.permissions["pull-requests"], "read");
  assert.equal(job.permissions.issues, "read");
  assert.equal(job.permissions["id-token"], undefined);
  assert.match(job.concurrency.group, /workflow_run\.head_sha/);
  assert.equal(job.concurrency["cancel-in-progress"], true);

  const reviewCheckouts = job.steps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  assert.equal(reviewCheckouts.length, 2);
  assert.equal(
    reviewCheckouts[0].with.path,
    undefined,
    "protected main is the workspace root",
  );
  assert.equal(reviewCheckouts[0].with["persist-credentials"], false);
  assert.equal(reviewCheckouts[1].with.path, "review-target");
  assert.equal(reviewCheckouts[1].with["persist-credentials"], false);
  const reviewInput = job.steps.find(
    (step) => step.name === "Prepare bounded review input",
  );
  assert(reviewInput, "trusted producer prepares the model review packet");
  assert.match(reviewInput.run, /write-input/);

  const action = job.steps.find((step) =>
    String(step.uses ?? "").startsWith("anthropics/claude-code-action@"),
  );
  assert(action?.id, "Claude step has an id for structured output");
  assert.equal(action.with.github_token, "${{ github.token }}");
  assert.match(action.with.claude_args, /--json-schema/);
  const claudeArgLines = action.with.claude_args.split("\n");
  const allowedTools = claudeArgLines.find((line) =>
    line.startsWith("--allowedTools"),
  );
  const disallowedTools = claudeArgLines.find((line) =>
    line.startsWith("--disallowedTools"),
  );
  const tools = claudeArgLines.find((line) => line.startsWith("--tools"));
  const permissionMode = claudeArgLines.find((line) =>
    line.startsWith("--permission-mode"),
  );
  const settingSources = claudeArgLines.find((line) =>
    line.startsWith("--setting-sources"),
  );
  const schemaLine = claudeArgLines.find((line) =>
    line.startsWith("--json-schema"),
  );
  assert(allowedTools, "Claude has an explicit read-only tool allowlist");
  assert(disallowedTools, "Claude has an explicit write-tool denylist");
  assert.equal(tools, '--tools "Read,Glob,Grep"');
  assert.equal(
    allowedTools,
    '--allowedTools "Read(review-target/**),Glob(review-target/**),Grep(review-target/**),Read(review-input/review.txt)"',
  );
  assert.equal(
    disallowedTools,
    '--disallowedTools "Bash,Edit,Write,MultiEdit,NotebookEdit,Agent,WebFetch,WebSearch,mcp__*"',
  );
  assert.equal(permissionMode, "--permission-mode dontAsk");
  assert.equal(settingSources, "--setting-sources user");
  const schemaMatch = schemaLine?.match(/^--json-schema '(.*)'$/);
  assert(schemaMatch, "Claude has one closed structured-output schema");
  const schema = JSON.parse(schemaMatch[1]);
  assert.equal(schema.properties.findings.maxItems, 12);
  assert.equal(
    schema.properties.findings.items.properties.title.maxLength,
    120,
  );
  assert.equal(
    schema.properties.findings.items.properties.detail.maxLength,
    400,
  );
  assert.equal(schema.properties.follow_up.maxLength, 400);
  for (const bareRule of ["Read", "Glob", "Grep", "Bash"]) {
    assert.equal(
      allowedTools
        .match(/"([^"]+)"/)?.[1]
        .split(",")
        .includes(bareRule),
      false,
      `Claude must not have bare ${bareRule} permission`,
    );
  }
  for (const scopedRule of [
    "Read(review-target/**)",
    "Glob(review-target/**)",
    "Grep(review-target/**)",
    "Read(review-input/review.txt)",
  ]) {
    assert.equal(allowedTools.includes(scopedRule), true);
  }
  for (const denied of [
    "Bash",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "Agent",
    "WebFetch",
    "WebSearch",
    "mcp__*",
  ]) {
    assert(
      disallowedTools
        .match(/"([^"]+)"/)?.[1]
        .split(",")
        .includes(denied),
      `Claude must have a bare ${denied} deny`,
    );
  }
  assert.doesNotMatch(allowedTools, /github_(?:comment|inline_comment)/i);
  assert.doesNotMatch(allowedTools, /(?:Edit|Write|MultiEdit)/);
  assert.match(disallowedTools, /mcp__\*/);

  assert.equal(
    job.steps.find((step) => step.name === "Publish deterministic review"),
    undefined,
  );
  const upload = job.steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/upload-artifact@"),
  );
  assert(upload, "validated review moves between jobs as an artifact");
  assert.equal(job.outputs.structured_review, undefined);

  const publisherJob = workflow.jobs["publish-review"];
  assert(publisherJob, "publisher runs in a separate job from the model");
  assert.equal(publisherJob.needs, "review");
  assert.match(publisherJob.if, /needs\.review\.result == 'success'/);
  assert.equal(publisherJob.permissions.contents, "read");
  assert.equal(publisherJob.permissions["pull-requests"], "read");
  assert.equal(publisherJob.permissions.issues, "read");
  assert.equal(publisherJob.permissions["id-token"], "write");
  assert.equal(
    publisherJob.concurrency.group,
    "claude-review-publish-${{ needs.review.outputs.repository }}-${{ needs.review.outputs.pr }}",
  );
  assert.equal(publisherJob.concurrency["cancel-in-progress"], false);
  const download = publisherJob.steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/download-artifact@"),
  );
  assert(download, "publisher downloads the validated review artifact");
  const publisher = publisherJob.steps.find(
    (step) => step.name === "Publish deterministic review",
  );
  const publisherCheckout = publisherJob.steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  assert.equal(publisherCheckout.with.path, undefined);
  assert.equal(publisherCheckout.with["persist-credentials"], false);
  assert.equal(publisher.env.CLAUDE_STRUCTURED_REVIEW, undefined);
  assert.match(publisher.env.CLAUDE_STRUCTURED_REVIEW_FILE, /review\.json/);
  assert.match(publisher.run, /publish/);
  const sentinelUpload = publisherJob.steps.find((step) =>
    String(step.uses ?? "").startsWith("actions/upload-artifact@"),
  );
  assert(sentinelUpload, "publisher uploads provenance sentinel");
  assert.match(sentinelUpload.if, /steps\.publish\.outcome == 'success'/);
  assert.match(sentinelUpload.with.name, /attestation_artifact/);
  assert.equal(sentinelUpload.with["retention-days"], 90);
  for (const guard of [
    "workflow_run",
    "Claude Review Request",
    "issue_comment",
    "@claude review",
    'OWNER","MEMBER',
  ]) {
    assert.match(job.if, new RegExp(guard));
    assert.match(publisherJob.if, new RegExp(guard));
  }
  assert.doesNotMatch(JSON.stringify(action), /ACTIONS_ID_TOKEN_REQUEST/);
  assert.doesNotMatch(source, /workflow_run\.pull_requests/);
  assert.match(source, /persist-credentials:\s*false/g);
  assert.match(source, /Resolve trusted review context/);
  assert.doesNotMatch(source, /show_full_output:\s*true/);
});

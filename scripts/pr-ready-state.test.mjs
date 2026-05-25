#!/usr/bin/env node
/**
 * Offline unit tests for scripts/pr-ready-state.mjs parsing helpers.
 */

import {
  classifyCheck,
  findTopLevelBotComments,
  findTopLevelBotReviewComments,
  findUnrepliedRootReviewComments,
  findUnresolvedReviewThreads,
  groupStatusChecks,
  hasCodexApprovalReaction,
  classifyCodexReviewSignal,
  isCodexReviewRequestBody,
  summarizeReadyState,
  splitRequiredAndOptionalChecks,
} from "./pr-ready-state-core.mjs";
import { formatCompact, formatHuman } from "./pr-ready-state-format.mjs";
import {
  annotateStatusCheckSources,
  parseArgs,
  renderSummary,
  repoFromPullRequestUrl,
  requiredStatusContextsFromProtection,
  requiredStatusContextsFromRules,
  requiredStatusContextsFromRulesResult,
  splitRepo,
  workflowPathsFromRules,
} from "./pr-ready-state.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${msg}\n`);
    failed += 1;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertThrows(fn, expectedMessage) {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(
      msg.includes(expectedMessage),
      `expected error to include ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(msg)}`,
    );
    return;
  }
  throw new Error("expected function to throw");
}

const basePr = {
  number: 123,
  url: "https://github.com/mento-protocol/monitoring-monorepo/pull/123",
  title: "Tighten PR readiness checks",
  author: { login: "chapati23" },
  isDraft: false,
  headRefName: "chore/pr-ready-state",
  headRefOid: "abc123",
  headUpdatedAt: "2026-05-21T13:22:23Z",
  commits: [
    {
      oid: "abc123",
      committedDate: "2026-05-21T13:22:23Z",
    },
  ],
  baseRefName: "main",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
    { name: "test", conclusion: "FAILURE", status: "COMPLETED" },
    { name: "build", status: "IN_PROGRESS", conclusion: null },
    { name: "optional", conclusion: "SKIPPED", status: "COMPLETED" },
  ],
};

test("classifies checks by GitHub status and conclusion", () => {
  assertEqual(classifyCheck({ conclusion: "SUCCESS" }), "pass");
  assertEqual(classifyCheck({ conclusion: "FAILURE" }), "fail");
  assertEqual(classifyCheck({ status: "QUEUED", conclusion: null }), "pending");
  assertEqual(classifyCheck({ conclusion: "NEUTRAL" }), "skipped");
  assertEqual(classifyCheck({ conclusion: "STALE" }), "fail");
  assertEqual(classifyCheck({}), "pending");
});

test("parses host-qualified repo arguments from the rightmost owner and name", () => {
  assertDeepEqual(splitRepo("mento-protocol/monitoring-monorepo"), {
    owner: "mento-protocol",
    name: "monitoring-monorepo",
    host: null,
  });
  assertDeepEqual(splitRepo("github.example.com/org/repo"), {
    owner: "org",
    name: "repo",
    host: "github.example.com",
  });
});

test("resolves API repo identity from pull request URL", () => {
  assertDeepEqual(
    repoFromPullRequestUrl("https://github.example.com/org/repo/pull/123"),
    {
      owner: "org",
      name: "repo",
      host: "github.example.com",
    },
  );
});

test("parses explicit help without requiring a PR argument", () => {
  assertDeepEqual(parseArgs(["--help"]), {
    help: true,
    json: false,
    compact: false,
    watch: false,
    prArg: null,
    repoArg: null,
  });
});

test("rejects missing flag values at the CLI boundary", () => {
  assertThrows(
    () => parseArgs(["--repo", "--pr", "123"]),
    "--repo requires a value",
  );
  assertThrows(() => parseArgs(["--pr"]), "--pr requires a value");
});

test("extracts required status contexts from branch rulesets", () => {
  assertDeepEqual(
    requiredStatusContextsFromRules([
      { type: "deletion" },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "ci" },
            { context: "Vercel" },
            { context: "ci" },
          ],
        },
      },
    ]),
    [
      { context: "ci", integrationId: null },
      { context: "Vercel", integrationId: null },
    ],
  );
});

test("extracts required status contexts from nested branch rulesets", () => {
  const rulesets = [
    {
      id: 1,
      name: "required checks",
      rules: [
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "ci", integration_id: 15368 },
              { context: "Vercel", integration_id: 8329 },
            ],
          },
        },
      ],
    },
  ];

  assertDeepEqual(requiredStatusContextsFromRules(rulesets), [
    { context: "ci", integrationId: 15368 },
    { context: "Vercel", integrationId: 8329 },
  ]);
});

test("extracts app-bound required status contexts from branch protection details", () => {
  assertDeepEqual(
    requiredStatusContextsFromProtection({
      contexts: ["ci", "Code Quality"],
      checks: [
        { context: "ci", app_id: 15368 },
        { context: "Code Quality", app_id: 15368 },
      ],
    }),
    [
      { context: "ci", integrationId: 15368 },
      { context: "Code Quality", integrationId: 15368 },
    ],
  );
});

test("falls back to bare branch protection contexts when check details are absent", () => {
  assertDeepEqual(
    requiredStatusContextsFromProtection({ contexts: ["ci", "Vercel"] }),
    [
      { context: "ci", integrationId: null },
      { context: "Vercel", integrationId: null },
    ],
  );
});

test("extracts required workflow contexts from branch rulesets", () => {
  const rules = [
    {
      type: "workflows",
      parameters: {
        workflows: [
          { path: ".github/workflows/ci.yml" },
          { path: ".github/workflows/quality.yml", name: "Code Quality" },
        ],
      },
    },
  ];
  const workflowNameByPath = new Map([[".github/workflows/ci.yml", "ci"]]);

  assertDeepEqual(workflowPathsFromRules(rules), [
    ".github/workflows/ci.yml",
    ".github/workflows/quality.yml",
  ]);
  assertDeepEqual(
    requiredStatusContextsFromRules(rules, { workflowNameByPath }),
    [
      { context: "ci", integrationId: null },
      { context: "Code Quality", integrationId: null },
    ],
  );
});

test("extracts required workflow contexts from nested branch rulesets", () => {
  const rulesets = [
    {
      id: 1,
      rules: [
        {
          type: "workflows",
          parameters: {
            workflows: [{ path: ".github/workflows/ci.yml" }],
          },
        },
      ],
    },
  ];
  const workflowNameByPath = new Map([[".github/workflows/ci.yml", "ci"]]);

  assertDeepEqual(workflowPathsFromRules(rulesets), [
    ".github/workflows/ci.yml",
  ]);
  assertDeepEqual(
    requiredStatusContextsFromRules(rulesets, { workflowNameByPath }),
    [{ context: "ci", integrationId: null }],
  );
});

test("resolves required workflow contexts from the ruleset source repo", () => {
  const rulesets = [
    {
      ruleset_source: "mento-protocol/shared-workflows",
      ruleset_source_type: "Repository",
      rules: [
        {
          type: "workflows",
          parameters: {
            workflows: [{ path: ".github/workflows/ci.yml" }],
          },
        },
      ],
    },
  ];
  const workflowNameByPath = new Map([
    ["mento-protocol/shared-workflows\0.github/workflows/ci.yml", "ci"],
  ]);

  assertDeepEqual(
    requiredStatusContextsFromRules(rulesets, {
      workflowNameByPath,
      fallbackRepoPath: "mento-protocol/monitoring-monorepo",
    }),
    [{ context: "ci", integrationId: null }],
  );
});

test("derives required workflow contexts from emitted job check names", () => {
  const rulesets = [
    {
      ruleset_source: "mento-protocol/shared-workflows",
      ruleset_source_type: "Repository",
      rules: [
        {
          type: "workflows",
          parameters: {
            workflows: [{ path: ".github/workflows/ci.yml" }],
          },
        },
      ],
    },
  ];
  const workflowNameByPath = new Map([
    ["mento-protocol/shared-workflows\0.github/workflows/ci.yml", "CI"],
  ]);

  assertDeepEqual(
    requiredStatusContextsFromRules(rulesets, {
      workflowNameByPath,
      fallbackRepoPath: "mento-protocol/monitoring-monorepo",
      statusCheckRollup: [
        { name: "lint", workflowName: "CI" },
        { name: "test", workflowName: "CI" },
        { name: "docs", workflowName: "Docs" },
      ],
    }),
    [
      { context: "lint", integrationId: null },
      { context: "test", integrationId: null },
    ],
  );
});

test("fails closed when a required workflow source repository is unresolved", () => {
  const result = requiredStatusContextsFromRulesResult(
    [
      {
        ruleset_source: "mento-protocol",
        ruleset_source_type: "Organization",
        rules: [
          {
            type: "workflows",
            parameters: {
              workflows: [{ path: ".github/workflows/ci.yml" }],
            },
          },
        ],
      },
    ],
    { fallbackRepoPath: "mento-protocol/monitoring-monorepo" },
  );

  assertEqual(
    result.error,
    "Unable to resolve source repository for required workflow(s): .github/workflows/ci.yml",
  );
  assertDeepEqual(result.contexts, []);
});

test("fails closed when workflow-name lookup fails for workflow rules", () => {
  const result = requiredStatusContextsFromRulesResult(
    [
      {
        type: "workflows",
        parameters: {
          workflows: [{ path: ".github/workflows/ci.yml" }],
        },
      },
    ],
    { workflowNameLookupError: "HTTP 403" },
  );

  assertDeepEqual(result, { contexts: [], error: "HTTP 403" });
});

test("skips workflow rules when no workflow check name can be resolved", () => {
  assertDeepEqual(
    requiredStatusContextsFromRules([
      {
        type: "workflows",
        parameters: {
          workflows: [{ path: ".github/workflows/unknown.yml" }],
        },
      },
    ]),
    [],
  );
});

test("does not overwrite check-run app identity with status source annotation", () => {
  const checks = [
    {
      name: "ci",
      app: { id: 15368 },
      conclusion: "SUCCESS",
      status: "COMPLETED",
    },
    { context: "ci", state: "SUCCESS" },
  ];
  const annotated = annotateStatusCheckSources(
    checks,
    new Map([["ci", { appId: 8329 }]]),
  );

  assertEqual(annotated[0].app.id, 15368);
  assertEqual(annotated[0].appId, undefined);
  assertEqual(annotated[1].appId, 8329);
});

test("groups status check rollup into stable pass/fail/pending/skipped buckets", () => {
  const grouped = groupStatusChecks(basePr.statusCheckRollup);
  assertDeepEqual(
    {
      pass: grouped.pass.map((check) => check.name),
      fail: grouped.fail.map((check) => check.name),
      pending: grouped.pending.map((check) => check.name),
      skipped: grouped.skipped.map((check) => check.name),
    },
    {
      pass: ["lint"],
      fail: ["test"],
      pending: ["build"],
      skipped: ["optional"],
    },
  );
});

test("splits known advisory checks into optional lag when branch protection data is unavailable", () => {
  const split = splitRequiredAndOptionalChecks([
    { name: "Trunk Check", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Cursor Bugbot", status: "IN_PROGRESS", conclusion: null },
    { name: "GraphQL schema diff", status: "IN_PROGRESS", conclusion: null },
    { name: "jscpd", status: "IN_PROGRESS", conclusion: null },
  ]);

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["Trunk Check:pass"],
      optional: [
        "Cursor Bugbot:pending",
        "GraphQL schema diff:pending",
        "jscpd:pending",
      ],
    },
  );
});

test("honors branch-protection required status contexts when available", () => {
  const split = splitRequiredAndOptionalChecks(
    [
      { name: "Cursor Bugbot", status: "IN_PROGRESS", conclusion: null },
      { name: "advisory", status: "IN_PROGRESS", conclusion: null },
    ],
    ["Cursor Bugbot"],
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["Cursor Bugbot:pending"],
      optional: ["advisory:pending"],
    },
  );
});

test("marks missing required status contexts as pending blockers", () => {
  const split = splitRequiredAndOptionalChecks(
    [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    ["ci", "Vercel"],
  );

  assertDeepEqual(
    split.required.map((check) => `${check.name}:${check.state}`),
    ["ci:pass", "Vercel:pending"],
  );
});

test("treats an empty required status context list as authoritative when available", () => {
  const split = splitRequiredAndOptionalChecks(
    [{ name: "ci", status: "IN_PROGRESS", conclusion: null }],
    [],
    { requiredStatusContextsAvailable: true },
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => check.name),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: [],
      optional: ["ci:pending"],
    },
  );
});

test("requires matching integration id when required checks specify an app source", () => {
  const split = splitRequiredAndOptionalChecks(
    [
      {
        name: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 999,
      },
      {
        name: "Code Quality",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 15368,
      },
    ],
    [
      { context: "ci", integrationId: 15368 },
      { context: "Code Quality", integrationId: 15368 },
    ],
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["ci:pending", "Code Quality:pass"],
      optional: ["ci:pass"],
    },
  );
});

test("does not satisfy integration-bound required checks with unknown app source", () => {
  const split = splitRequiredAndOptionalChecks(
    [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    [{ context: "ci", integrationId: 15368 }],
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["ci:pending"],
      optional: ["ci:pass"],
    },
  );
});

test("does not collapse duplicate required contexts from different app sources", () => {
  const split = splitRequiredAndOptionalChecks(
    [
      {
        name: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 15368,
      },
    ],
    [
      { context: "ci", integrationId: 15368 },
      { context: "ci", integrationId: 999 },
    ],
  );

  assertDeepEqual(
    split.required.map((check) => `${check.name}:${check.state}`),
    ["ci:pass", "ci:pending"],
  );
});

test("finds unresolved review threads and keeps useful location metadata", () => {
  const unresolved = findUnresolvedReviewThreads([
    {
      id: "thread-1",
      isResolved: false,
      isOutdated: false,
      path: "scripts/pr-ready-state.mjs",
      line: 42,
      comments: {
        nodes: [
          {
            url: "https://github.com/example/thread-1",
            body: "please reply",
            author: { login: "reviewer" },
          },
        ],
      },
    },
    { id: "thread-2", isResolved: true, path: "README.md" },
  ]);

  assertDeepEqual(unresolved, [
    {
      id: "thread-1",
      path: "scripts/pr-ready-state.mjs",
      line: 42,
      isOutdated: false,
      author: "reviewer",
      url: "https://github.com/example/thread-1",
      body: "please reply",
    },
  ]);
});

test("finds root review comments with no direct replies", () => {
  const unreplied = findUnrepliedRootReviewComments([
    {
      id: 10,
      body: "root with reply",
      path: "a.ts",
      line: 1,
      user: { login: "reviewer" },
    },
    { id: 11, in_reply_to_id: 10, body: "reply", user: { login: "agent" } },
    {
      id: 12,
      body: "root without reply",
      path: "b.ts",
      original_line: 5,
      html_url: "https://github.com/example/comment-12",
      user: { login: "reviewer" },
    },
  ]);

  assertDeepEqual(unreplied, [
    {
      id: 12,
      path: "b.ts",
      line: 5,
      author: "reviewer",
      url: "https://github.com/example/comment-12",
      body: "root without reply",
    },
  ]);
});

test("ignores self-authored root review comments", () => {
  const unreplied = findUnrepliedRootReviewComments(
    [
      {
        id: 12,
        body: "author note",
        path: "b.ts",
        original_line: 5,
        user: { login: "chapati23" },
      },
      {
        id: 13,
        body: "reviewer note",
        path: "b.ts",
        original_line: 6,
        user: { login: "reviewer" },
      },
    ],
    ["chapati23"],
  );

  assertDeepEqual(
    unreplied.map((comment) => comment.id),
    [13],
  );
});

test("requires root review comment replies from an allowed agent author", () => {
  const unreplied = findUnrepliedRootReviewComments(
    [
      {
        id: 10,
        body: "root with reviewer self-reply",
        path: "a.ts",
        line: 1,
        user: { login: "reviewer" },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: "reviewer follow-up",
        user: { login: "reviewer" },
      },
      {
        id: 12,
        body: "root with author reply",
        path: "b.ts",
        line: 2,
        user: { login: "reviewer" },
      },
      {
        id: 13,
        in_reply_to_id: 12,
        body: "fixed",
        user: { login: "chapati23" },
      },
    ],
    [],
    ["chapati23"],
  );

  assertDeepEqual(
    unreplied.map((comment) => comment.id),
    [10],
  );
});

test("summarize ready state ignores self-authored roots but not reviewer self-replies", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 10,
        body: "agent note",
        path: "a.ts",
        line: 1,
        user: { login: "chapati23" },
      },
      {
        id: 11,
        body: "root with reviewer self-reply",
        path: "b.ts",
        line: 2,
        user: { login: "reviewer" },
      },
      {
        id: 12,
        in_reply_to_id: 11,
        body: "reviewer follow-up",
        user: { login: "reviewer" },
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertDeepEqual(
    summary.unrepliedRootReviewComments.map((comment) => comment.id),
    [11],
  );
});

test("filters top-level issue comments down to bots", () => {
  const bots = findTopLevelBotComments([
    { id: 1, body: "human", user: { login: "alice", type: "User" } },
    {
      id: 2,
      body: "automated review",
      html_url: "https://github.com/example/comment-2",
      user: { login: "cursor[bot]", type: "Bot" },
    },
  ]);

  assertEqual(bots.length, 1);
  assertEqual(bots[0].author, "cursor[bot]");
});

test("filters top-level review bodies down to bots with body text", () => {
  const bots = findTopLevelBotReviewComments([
    {
      id: "review-1",
      body: "automated review body",
      url: "https://github.com/example/review-1",
      state: "COMMENTED",
      author: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    },
    {
      id: "review-2",
      body: "",
      state: "APPROVED",
      author: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    },
    {
      id: "review-3",
      body: "human review",
      author: { login: "alice", type: "User" },
    },
  ]);

  assertEqual(bots.length, 1);
  assertEqual(bots[0].author, "chatgpt-codex-connector[bot]");
  assertEqual(bots[0].state, "COMMENTED");
});

test("requires chatgpt-codex-connector +1 reaction exactly", () => {
  assert(
    hasCodexApprovalReaction(
      [
        {
          content: "+1",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      Date.parse("2026-05-21T13:22:23Z"),
    ),
    "expected codex bot +1 to pass",
  );
  assert(
    !hasCodexApprovalReaction([
      { content: "heart", user: { login: "chatgpt-codex-connector[bot]" } },
      { content: "+1", user: { login: "other[bot]" } },
    ]),
    "expected wrong reaction or wrong bot to fail",
  );
  assert(
    hasCodexApprovalReaction(
      [
        {
          content: "+1",
          user: { login: "chatgpt-codex-connector" },
          created_at: "2026-05-21T13:23:00Z",
        },
      ],
      Date.parse("2026-05-21T13:22:23Z"),
    ),
    "expected app slug login to pass",
  );
});

test("classifies Codex review signal as missing, requested, in flight, stale, or approved", () => {
  const headUpdatedAt = Date.parse("2026-05-21T13:22:23Z");

  assertEqual(classifyCodexReviewSignal({ headUpdatedAt }), "missing");
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "requested",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chapati23" },
          reactions: [
            {
              content: "eyes",
              user: { login: "chatgpt-codex-connector[bot]" },
            },
          ],
        },
      ],
    }),
    "in_flight",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "stale",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      codexApprovalReaction: true,
    }),
    "approved",
  );
});

test("treats Codex review requests as current when no head timestamp is available", () => {
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt: null,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "requested",
  );
});

test("does not revive stale Codex review requests from comment edits", () => {
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt: Date.parse("2026-05-21T13:22:23Z"),
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          updated_at: "2026-05-21T13:23:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "stale",
  );
});

test("uses Codex eyes reaction timestamps to detect current in-flight reviews", () => {
  const headUpdatedAt = Date.parse("2026-05-21T13:22:23Z");

  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chapati23" },
          reactions: [
            {
              content: "eyes",
              created_at: "2026-05-21T13:23:00Z",
              user: { login: "chatgpt-codex-connector[bot]" },
            },
          ],
        },
      ],
    }),
    "in_flight",
  );
});

test("uses a shared matcher for Codex review request comments", () => {
  assert(isCodexReviewRequestBody("@codex review"));
  assert(isCodexReviewRequestBody("please @codex review this"));
  assert(!isCodexReviewRequestBody("@codex summarize"));
});

test("classifies stale vs current Codex review submissions", () => {
  const headUpdatedAt = Date.parse("2026-05-21T13:22:23Z");

  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      reviews: [
        {
          submittedAt: "2026-05-21T13:21:00Z",
          author: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
    }),
    "stale",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      reviews: [
        {
          submittedAt: "2026-05-21T13:21:00Z",
          author: { login: "chatgpt-codex-connector[bot]" },
        },
        {
          submittedAt: "2026-05-21T13:23:00Z",
          author: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
    }),
    "in_flight",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      reviews: [
        {
          submittedAt: "2026-05-21T13:23:00Z",
          author: { login: "chatgpt-codex-connector" },
        },
      ],
    }),
    "in_flight",
  );
});

test("duplicate-review prevention fixture waits on current-head Codex request in flight", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    issueComments: [
      {
        id: 1,
        body: "@codex review",
        created_at: "2026-05-21T12:00:00Z",
        user: { login: "chapati23" },
      },
      {
        id: 2,
        body: "@codex review",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chapati23" },
        reactions: [
          {
            content: "eyes",
            user: { login: "chatgpt-codex-connector[bot]" },
          },
        ],
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.codexReviewSignal, "in_flight");
  assertEqual(summary.gates.codexReviewSignal.fallbackAction, "wait");
  assert(
    summary.required.blockers.some(
      (blocker) => blocker.name === "Codex PR-description approval",
    ),
    "expected missing final approval gate to keep PR not ready",
  );
});

test("watch JSON output is one compact JSON object per line", () => {
  const summary = {
    ready: false,
    number: 123,
    blockers: [{ name: "ci", state: "pending" }],
  };
  const output = renderSummary(summary, {
    json: true,
    compact: false,
    watch: true,
  });

  assertEqual(output.split("\n").length, 2);
  assertDeepEqual(JSON.parse(output), summary);
});

test("rejects stale chatgpt-codex-connector reaction from before the head update", () => {
  assert(
    !hasCodexApprovalReaction(
      [
        {
          content: "+1",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      Date.parse("2026-05-21T13:22:23Z"),
    ),
    "expected stale codex bot +1 to fail",
  );
});

test("does not use pull request updatedAt as head freshness fallback", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      headUpdatedAt: null,
      headPushedAt: null,
      updatedAt: "2026-05-21T13:25:00Z",
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:25:01Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });

  assertEqual(summary.codexApprovalReaction, false);
  assertEqual(summary.pr.headUpdatedAt, null);
});

test("still fails closed when no head freshness timestamp is available", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      headUpdatedAt: null,
      headPushedAt: null,
      updatedAt: null,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:25:01Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });

  assertEqual(summary.codexApprovalReaction, false);
  assertEqual(summary.pr.headUpdatedAt, null);
});

test("blocks ready state when required review is still pending", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });

  assertEqual(summary.ready, false);
  assert(
    summary.required.blockers.some(
      (blocker) =>
        blocker.kind === "review" && blocker.state === "REVIEW_REQUIRED",
    ),
    "expected REVIEW_REQUIRED blocker",
  );
});

test("fails closed when required status contexts cannot be fetched", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    requiredStatusContextsError: "HTTP 403: Resource not accessible",
  });

  assertEqual(summary.ready, false);
  assert(
    summary.required.blockers.some(
      (blocker) => blocker.kind === "branch-protection",
    ),
    "expected branch-protection blocker",
  );
});

test("summarizes not-ready state when blockers remain", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      reviews: [
        {
          body: "review body",
          author: { login: "cursor[bot]", type: "Bot" },
        },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 12,
        body: "root without reply",
        path: "b.ts",
        line: 5,
        user: { login: "reviewer" },
      },
    ],
    reviewThreads: [{ id: "thread-1", isResolved: false }],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.statusChecks.fail.length, 1);
  assertEqual(summary.statusChecks.pending.length, 1);
  assertEqual(summary.unresolvedReviewThreads.length, 1);
  assertEqual(summary.unrepliedRootReviewComments.length, 1);
  assertEqual(summary.topLevelBotComments.length, 1);
  assert(
    summary.codexApprovalReaction,
    "expected codex reaction to be present",
  );
});

test("summarizes ready state when all blocking surfaces are clean", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
        { name: "Cursor Bugbot", conclusion: null, status: "IN_PROGRESS" },
        { name: "optional", conclusion: "SKIPPED", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 10,
        body: "root",
        path: "a.ts",
        line: 1,
        user: { login: "reviewer" },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: "reply",
        user: { login: "chapati23" },
      },
    ],
    reviewThreads: [{ id: "thread-1", isResolved: true }],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.required.ready, true);
  assertEqual(summary.optional.ready, false);
  assertEqual(summary.optional.items[0].name, "Cursor Bugbot");
  assertEqual(summary.statusChecks.skipped.length, 1);
});

test("human output names the readiness verdict and codex reaction gate", () => {
  const output = formatHuman(
    summarizeReadyState({
      pr: { ...basePr, statusCheckRollup: [] },
      reactions: [],
    }),
  );

  assert(output.includes("PR #123: NOT READY"), output);
  assert(
    output.includes(
      "chatgpt-codex-connector[bot] +1 reaction on PR description: no",
    ),
    output,
  );
  assert(output.includes("Codex review signal: missing"), output);
});

test("compact output includes only readiness counters and Codex signal state", () => {
  const output = formatCompact(
    summarizeReadyState({
      pr: { ...basePr, statusCheckRollup: [] },
      reactions: [],
    }),
  );

  assert(output.includes("PR #123 BLOCKED"), output);
  assert(output.includes("required_blockers=1"), output);
  assert(output.includes("codex_approval=missing"), output);
  assert(output.includes("codex_signal=missing"), output);
});

if (failed > 0) {
  process.stderr.write(`\n${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

process.stdout.write(`\n${passed} passed\n`);

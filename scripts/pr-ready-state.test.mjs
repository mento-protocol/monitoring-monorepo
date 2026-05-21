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
  summarizeReadyState,
  splitRequiredAndOptionalChecks,
} from "./pr-ready-state-core.mjs";
import { formatHuman } from "./pr-ready-state-format.mjs";
import { repoFromPullRequestUrl, splitRepo } from "./pr-ready-state.mjs";

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

const basePr = {
  number: 123,
  url: "https://github.com/mento-protocol/monitoring-monorepo/pull/123",
  title: "Tighten PR readiness checks",
  author: { login: "chapati23" },
  isDraft: false,
  headRefName: "chore/pr-ready-state",
  headRefOid: "abc123",
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
});

test("rejects stale chatgpt-codex-connector reaction from before the head commit", () => {
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
      { id: 10, body: "root", path: "a.ts", line: 1 },
      { id: 11, in_reply_to_id: 10, body: "reply" },
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
});

if (failed > 0) {
  process.stderr.write(`\n${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

process.stdout.write(`\n${passed} passed\n`);

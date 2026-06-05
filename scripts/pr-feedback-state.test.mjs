#!/usr/bin/env node
import { summarizeFeedbackState } from "./pr-feedback-state-core.mjs";
import {
  parseFeedbackArgs,
  renderFeedbackState,
} from "./pr-feedback-state.mjs";

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

const readyState = {
  ready: false,
  pr: {
    number: 791,
    url: "https://github.com/mento-protocol/monitoring-monorepo/pull/791",
    title: "chore: speed up agent commands",
    headRefOid: "b".repeat(40),
  },
  required: {
    ready: false,
    blockers: [
      {
        kind: "review-thread",
        name: "scripts/example.mjs",
        state: "unresolved",
        required: true,
        url: "https://github.example/thread",
      },
      {
        kind: "check",
        name: "ci",
        state: "pending",
        required: true,
        url: "https://github.example/check",
      },
      {
        kind: "gate",
        name: "Codex PR-description approval",
        state: "missing",
        required: true,
        url: "https://github.example/pr",
      },
      {
        kind: "gate",
        name: "Deployment freeze",
        state: "active",
        required: true,
        url: "https://github.example/freeze",
      },
    ],
  },
  gates: {
    codexDescriptionApproval: {
      ready: false,
      required: true,
      state: "missing",
    },
    codexReviewSignal: {
      ready: true,
      required: false,
      state: "in_flight",
      fallbackAction: "wait",
    },
    reviewCommentReplies: {
      ready: false,
      required: true,
      unrepliedCount: 1,
    },
    reviewThreads: {
      ready: false,
      required: true,
      unresolvedCount: 1,
    },
  },
  unresolvedReviewThreads: [{ id: "thread-1" }],
  unrepliedRootReviewComments: [{ id: 123 }],
  topLevelBotComments: [{ id: 456 }],
};

test("summarizes only feedback blockers and counts", () => {
  const summary = summarizeFeedbackState(readyState);

  assertEqual(summary.ready, false);
  assertEqual(summary.summary, "Feedback surfaces need attention.");
  assertDeepEqual(
    summary.requiredFeedbackBlockers.map((blocker) => blocker.kind),
    ["review-thread", "gate"],
  );
  assertDeepEqual(summary.counts, {
    requiredFeedbackBlockers: 2,
    unresolvedReviewThreads: 1,
    unrepliedRootReviewComments: 1,
    blockingTopLevelBotComments: 0,
    topLevelBotComments: 1,
  });
});

test("includes requested-change review blockers in feedback blockers", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    required: {
      ready: false,
      blockers: [
        {
          kind: "review",
          name: "Review required",
          state: "CHANGES_REQUESTED",
          required: true,
        },
      ],
    },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [],
  });

  assertEqual(summary.ready, false);
  assertDeepEqual(
    summary.requiredFeedbackBlockers.map((blocker) => blocker.kind),
    ["review"],
  );
});

test("does not treat missing review approval as feedback cleanup", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    required: {
      ready: false,
      blockers: [
        {
          kind: "review",
          name: "Review required",
          state: "REVIEW_REQUIRED",
          required: true,
        },
      ],
    },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [],
  });

  assertEqual(summary.ready, true);
  assertDeepEqual(summary.requiredFeedbackBlockers, []);
});

test("does not treat unrelated gate blockers as feedback blockers", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    required: {
      ready: false,
      blockers: [
        {
          kind: "gate",
          name: "Deployment freeze",
          state: "active",
          required: true,
        },
      ],
    },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [],
  });

  assertEqual(summary.ready, true);
  assertDeepEqual(summary.requiredFeedbackBlockers, []);
});

test("does not block feedback on a non-required unready feedback gate", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    required: { ready: false, blockers: [] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: false, required: false },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [],
  });

  assertEqual(summary.ready, true);
  assertDeepEqual(summary.requiredFeedbackBlockers, []);
});

test("defaults missing gates to clear when feedback surfaces are empty", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    required: { ready: false, blockers: [] },
    gates: undefined,
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.gates.codexDescriptionApproval, null);
  assertEqual(summary.gates.reviewCommentReplies, null);
  assertEqual(summary.gates.reviewThreads, null);
});

test("marks feedback clear when feedback gates are clear", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.summary, "Feedback gates are clear.");
});

test("does not mark feedback clear while current-head review bot feedback remains", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "cursor[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "Medium Severity\n<!-- BUGBOT_BUG_ID: example -->",
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.summary, "Feedback surfaces need attention.");
  assertEqual(summary.counts.blockingTopLevelBotComments, 1);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("does not block on stale top-level bot review comments", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "claude[bot]",
        updatedAt: "2026-06-05T16:15:00Z",
        body: "Findings: stale review summary",
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.counts.blockingTopLevelBotComments, 0);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("does not block on bot comments tied to another head commit", () => {
  const currentHead = "b".repeat(40);
  const oldHead = "a".repeat(40);
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headRefOid: currentHead,
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "cursor[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: `High Severity\n<!-- BUGBOT_BUG_ID: example -->\nReviewed for commit ${oldHead}.`,
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.counts.blockingTopLevelBotComments, 0);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("does not treat contract-shaped hex tokens as commit references", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headRefOid: "b".repeat(40),
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "cursor[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: `High Severity\n<!-- BUGBOT_BUG_ID: example -->\nContract ${"a".repeat(40)} is affected.`,
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.counts.blockingTopLevelBotComments, 1);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("does not block on actionable bot comments when head freshness is unknown", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headRefOid: "b".repeat(40),
      headUpdatedAt: null,
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "cursor[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "High Severity\n<!-- BUGBOT_BUG_ID: example -->",
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.counts.blockingTopLevelBotComments, 0);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("blocks on actionable bot comments that name the current head without a freshness timestamp", () => {
  const currentHead = "b".repeat(40);
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headRefOid: currentHead,
      headUpdatedAt: null,
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "cursor[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: `High Severity\n<!-- BUGBOT_BUG_ID: example -->\nReviewed for commit ${currentHead}.`,
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.counts.blockingTopLevelBotComments, 1);
});

test("does not block on current-head informational bot comments", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "vercel[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "The latest updates on your projects.",
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.counts.blockingTopLevelBotComments, 0);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("does not block on current-head clean review bot summaries", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "chatgpt-codex-connector[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "No findings. Patch is correct.",
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.counts.blockingTopLevelBotComments, 0);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("does not block on current-head clean summaries that mention absent findings", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "chatgpt-codex-connector[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "No P1 issues, no errors, and 0 failures.",
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.counts.blockingTopLevelBotComments, 0);
  assertEqual(summary.counts.topLevelBotComments, 1);
});

test("blocks on current-head priority review bot summaries", () => {
  const summary = summarizeFeedbackState({
    ...readyState,
    pr: {
      ...readyState.pr,
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
    required: { ready: false, blockers: [{ kind: "check", name: "ci" }] },
    gates: {
      ...readyState.gates,
      codexDescriptionApproval: { ready: true },
      reviewCommentReplies: { ready: true, unrepliedCount: 0 },
      reviewThreads: { ready: true, unresolvedCount: 0 },
    },
    unresolvedReviewThreads: [],
    unrepliedRootReviewComments: [],
    topLevelBotComments: [
      {
        id: 456,
        author: "claude[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "| # | Severity | Issue |\n| 1 | [P2] | Fix this |",
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.counts.blockingTopLevelBotComments, 1);
});

test("parses pr arguments through the shared ready-state parser", () => {
  assertDeepEqual(parseFeedbackArgs(["--pr", "791", "--json"]), {
    help: false,
    watch: false,
    prArg: "791",
    repoArg: null,
  });
  assertDeepEqual(parseFeedbackArgs(["791", "--watch"]), {
    help: false,
    watch: true,
    prArg: "791",
    repoArg: null,
  });
});

test("rejects compact output because feedback state is JSON-only", () => {
  assertThrows(() => parseFeedbackArgs(["791", "--compact"]), "not supported");
});

test("shows feedback-state usage for invalid arguments", () => {
  assertThrows(
    () => parseFeedbackArgs(["791", "--unknown"]),
    "Usage: pnpm --silent pr:feedback-state",
  );
});

test("renders compact JSON for watch mode", () => {
  const output = renderFeedbackState({ ready: true }, { watch: true });
  assertEqual(output, '{"ready":true}\n');
});

if (failed > 0) {
  process.stderr.write(`${failed} pr-feedback-state test(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`${passed} pr-feedback-state test(s) passed\n`);

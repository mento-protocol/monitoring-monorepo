#!/usr/bin/env node
import {
  buildFeedbackFindings,
  summarizeFeedbackState,
} from "./pr-feedback-state-core.mjs";
import {
  parseFeedbackArgs,
  renderFeedbackState,
} from "./pr-feedback-state.mjs";
import { summarizeReadyState } from "./pr-ready-state-core.mjs";

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

const PR_1431_HEAD = "278eb7c96526f2b6c63b7dda92ca4da1ebac51a9";
// Captures the structure of PR #1431 issuecomment-5043637970: an LGTM
// verdict, explanatory [P3] findings, and an all-No-action roll-up.
const PR_1431_CLEAN_CLAUDE_REVIEW = {
  id: 5043637970,
  html_url:
    "https://github.com/mento-protocol/monitoring-monorepo/pull/1431#issuecomment-5043637970",
  created_at: "2026-07-22T08:30:32Z",
  updated_at: "2026-07-22T08:30:32Z",
  user: { login: "claude", type: "Bot" },
  body: `**Claude finished @chapati23's task in 3m 59s**

---
### Review: fix(deps): upgrade sharp past vulnerable libvips

**Verdict: LGTM**

#### What I checked
- [x] \`pnpm-workspace.yaml\` override syntax/scope
- [x] \`pnpm-lock.yaml\` regeneration for unrelated drift
- [x] Supply-chain/lockfile-lint compliance and CI status
- [x] Other standalone lockfiles for leftover vulnerable \`sharp@0.34.5\`

#### Findings

1. **[P3] None blocking — clean, well-scoped fix.** The bounded selector matches the repo's established override pattern.
2. **[P3] Good hygiene:** the inline comment documents the advisory and exact removal condition.
3. **[P3] Lockfile diff is fully mechanical.** No unrelated version bumps.
4. Confirmed no leftover \`sharp@0.34.5\` anywhere.
5. Supply Chain CI already passed on this PR.

No inline comments filed — nothing rose to an actionable, line-specific issue.

#### Roll-up
1. [P3] No-action: override selector is correctly bounded and matches repo convention.
2. [P3] No-action: removal-condition comment satisfies the temporary-override documentation expectation.
3. [P3] No-action: lockfile churn beyond sharp itself is confirmed mechanical, not scope creep.
4. [P3] No-action: no vulnerable \`sharp@0.34.5\` remains anywhere in the repo's lockfiles.`,
};

const ACTIONABLE_CLAUDE_REVIEW_LOOKALIKE = {
  ...PR_1431_CLEAN_CLAUDE_REVIEW,
  id: 5043637971,
  html_url:
    "https://github.com/mento-protocol/monitoring-monorepo/pull/1431#issuecomment-5043637971",
  body: PR_1431_CLEAN_CLAUDE_REVIEW.body.replace(
    "4. [P3] No-action: no vulnerable `sharp@0.34.5` remains anywhere in the repo's lockfiles.",
    "4. [P2] Action required: remove the remaining vulnerable `sharp@0.34.5` lockfile entry.",
  ),
};
function normalizedReadyStateForClaudeReview(
  comment,
  { title = "fix(deps): upgrade sharp past vulnerable libvips" } = {},
) {
  return summarizeReadyState({
    pr: {
      number: 1431,
      url: "https://github.com/mento-protocol/monitoring-monorepo/pull/1431",
      title,
      state: "OPEN",
      author: { login: "chapati23" },
      isDraft: false,
      headRefName: "fix/1420-sharp-035",
      headRefOid: PR_1431_HEAD,
      headUpdatedAt: "2026-07-22T08:29:00Z",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      statusCheckRollup: [],
      reviews: [],
    },
    issueComments: [comment],
    reactions: [
      {
        content: "+1",
        created_at: "2026-07-22T08:31:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });
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
    findings: 2,
    blockingFindings: 2,
  });
});

test("normalizes feedback surfaces into findings with state flags", () => {
  const currentHead = "b".repeat(40);
  const findings = buildFeedbackFindings(
    {
      pr: {
        headRefOid: currentHead,
        headUpdatedAt: "2026-06-05T16:30:00Z",
      },
      reviewThreads: [
        {
          id: "thread-1",
          path: "scripts/example.mjs",
          line: 12,
          isResolved: false,
          isOutdated: true,
          author: "cursor[bot]",
          url: "https://github.example/thread-1",
          body: "[P2] Fix stale thread",
        },
        {
          id: "thread-2",
          path: "scripts/example.mjs",
          line: 20,
          isResolved: true,
          isOutdated: false,
          author: "alice",
          url: "https://github.example/thread-2",
          body: "Resolved already",
        },
      ],
      rootReviewComments: [
        {
          id: 111,
          path: "scripts/example.mjs",
          line: 30,
          replied: false,
          author: "claude[bot]",
          url: "https://github.example/comment-111",
          body: "Please reply to this.",
        },
        {
          id: 112,
          path: "scripts/example.mjs",
          line: 31,
          replied: true,
          author: "claude[bot]",
          url: "https://github.example/comment-112",
          body: "Already handled.",
        },
      ],
      topLevelBotComments: [
        {
          id: 456,
          author: "chatgpt-codex-connector[bot]",
          updatedAt: "2026-06-05T16:31:00Z",
          body: "| # | Severity | Issue |\n| 1 | [P1] | Fix one |\n| 2 | [P2] | Fix two |",
        },
      ],
    },
    [
      {
        id: 456,
        author: "chatgpt-codex-connector[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "| # | Severity | Issue |\n| 1 | [P1] | Fix one |\n| 2 | [P2] | Fix two |",
      },
    ],
  );

  assertEqual(findings.length, 6);
  assertDeepEqual(
    findings.map((finding) => finding.state),
    [
      "unresolved-outdated",
      "resolved",
      "unreplied",
      "replied",
      "blocking-current-head",
      "blocking-current-head",
    ],
  );
  assertEqual(findings[0].blocking, true);
  assertEqual(findings[0].currentHead, false);
  assertEqual(findings[2].replied, false);
  assertEqual(findings[3].blocking, false);
  assertEqual(findings[4].blocking, true);
  assertEqual(findings[5].blocking, true);
  assertEqual(findings[4].sourceId, "456#1");
  assertEqual(findings[5].title, "[P2] Fix two");
});

test("keeps top-level bot finding fingerprints stable across repeated comments", () => {
  const base = {
    pr: {
      headRefOid: "b".repeat(40),
      headUpdatedAt: "2026-06-05T16:30:00Z",
    },
  };
  const first = buildFeedbackFindings({
    ...base,
    topLevelBotComments: [
      {
        id: 456,
        author: "cursor[bot]",
        updatedAt: "2026-06-05T16:31:00Z",
        body: "**High Severity**\nFix the parser branch.",
      },
    ],
  });
  const repeated = buildFeedbackFindings({
    ...base,
    topLevelBotComments: [
      {
        id: 789,
        author: "cursor[bot]",
        updatedAt: "2026-06-05T16:45:00Z",
        body: "**High Severity**\nFix the parser branch.",
      },
    ],
  });

  assertEqual(first.length, 1);
  assertEqual(repeated.length, 1);
  assertEqual(first[0].fingerprint, repeated[0].fingerprint);
  assertEqual(first[0].sourceId, "456#1");
  assertEqual(repeated[0].sourceId, "789#1");
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

test("does not block on bot review bodies tied to an older commit", () => {
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
        id: "review-1",
        author: "chatgpt-codex-connector[bot]",
        commitOid: oldHead,
        createdAt: "2026-06-05T16:31:00Z",
        body: "| # | Severity | Issue |\n| 1 | [P2] | Fix this |",
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.counts.blockingTopLevelBotComments, 0);
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
        body: "No P3 issues. No **High Severity** findings. Patch is correct.",
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

test("agrees with ready-state on the normalized PR #1431 clean Claude review", () => {
  const normalizedReadyState = normalizedReadyStateForClaudeReview(
    PR_1431_CLEAN_CLAUDE_REVIEW,
  );
  const feedbackState = summarizeFeedbackState(normalizedReadyState);

  assertEqual(normalizedReadyState.ready, true);
  assertEqual(feedbackState.ready, normalizedReadyState.required.ready);
  assertEqual(feedbackState.counts.topLevelBotComments, 1);
  assertEqual(feedbackState.counts.blockingTopLevelBotComments, 0);
  assertEqual(feedbackState.counts.blockingFindings, 0);
});

function structuredClaudeReview({
  title,
  checklist = ["Parser structure and unit-test coverage", "Runtime behavior"],
  findings = [
    "1. [P3] No action: tests cover the changed paths.",
    "2. [P3] No action: fix is correct and covered.",
  ],
  rollup = ["1. [P3] No-action: fix is correct."],
}) {
  return `### Review: ${title}

**Verdict: LGTM**

#### What I checked
${checklist.map((subject) => `- [x] ${subject}`).join("\n")}

#### Findings
${findings.join("\n")}

#### Roll-up
${rollup.join("\n")}`;
}

test("accepts bounded clean Claude reviews for unrelated ordinary PR titles", () => {
  const cleanReviews = [
    {
      title: "feat(auth): add secure session refresh",
      checklist: [
        "Authentication boundary and session lifecycle",
        "Unit tests and operator documentation",
      ],
    },
    {
      title: "fix(api): handle failed request errors",
      checklist: ["Request-path coverage", "Schema compatibility"],
    },
    {
      title: "docs(agent): explain Roll-up handling #1476",
      checklist: [
        "Review title and checklist routing",
        "Documentation examples and unit tests",
      ],
    },
  ];

  let fixtureId = 5043638300;
  for (const fixture of cleanReviews) {
    const normalizedReadyState = normalizedReadyStateForClaudeReview(
      {
        ...PR_1431_CLEAN_CLAUDE_REVIEW,
        id: fixtureId++,
        body: structuredClaudeReview(fixture),
      },
      { title: fixture.title },
    );
    const feedbackState = summarizeFeedbackState(normalizedReadyState);
    assertEqual(normalizedReadyState.ready, true);
    assertEqual(feedbackState.ready, normalizedReadyState.required.ready);
    assertEqual(feedbackState.counts.blockingTopLevelBotComments, 0);
    assertEqual(feedbackState.counts.blockingFindings, 0);
  }
});

test("accepts CommonMark punctuation escapes in exact Claude review titles", () => {
  const escapedTitles = [
    [
      "docs(parser): explain pipe | handling",
      "docs(parser): explain pipe \\| handling",
    ],
    [
      "docs(parser): explain colon : handling",
      "docs(parser)\\: explain colon \\: handling",
    ],
    [
      "docs(parser): explain tilde ~ handling",
      "docs(parser): explain tilde \\~ handling",
    ],
  ];

  let fixtureId = 5043638350;
  for (const [title, reviewTitle] of escapedTitles) {
    const normalizedReadyState = normalizedReadyStateForClaudeReview(
      {
        ...PR_1431_CLEAN_CLAUDE_REVIEW,
        id: fixtureId++,
        body: structuredClaudeReview({ title: reviewTitle }),
      },
      { title },
    );
    const feedbackState = summarizeFeedbackState(normalizedReadyState);
    assertEqual(normalizedReadyState.ready, true);
    assertEqual(feedbackState.ready, normalizedReadyState.required.ready);
    assertEqual(feedbackState.counts.blockingTopLevelBotComments, 0);
  }
});

test("fails closed on adversarial Claude review protocol variants", () => {
  const title = "feat(auth): add secure session refresh";
  const clean = structuredClaudeReview({ title });
  const replaceChecklist = (entry) =>
    clean.replace("- [x] Parser structure and unit-test coverage", entry);
  const replaceFinding = (entry) =>
    clean.replace("1. [P3] No action: tests cover the changed paths.", entry);
  const replaceRollup = (entry) =>
    clean.replace("1. [P3] No-action: fix is correct.", entry);
  const blockingReviews = [
    ["mismatched title", clean, "fix(auth): different change"],
    [
      "oversized title",
      structuredClaudeReview({ title: "x".repeat(201) }),
      "x".repeat(201),
    ],
    [
      "escaped punctuation still requires exact title equality",
      structuredClaudeReview({
        title: "feat(auth)\\: add secure session refresh \\| changed",
      }),
      title,
    ],
    ["unchecked checklist", replaceChecklist("- [ ] Unit tests"), title],
    ["malformed checklist", replaceChecklist("- [yes] Unit tests"), title],
    [
      "empty checklist",
      clean.replace(
        "- [x] Parser structure and unit-test coverage\n- [x] Runtime behavior",
        "",
      ),
      title,
    ],
    [
      "actionable checklist suffix",
      replaceChecklist("- [x] Unit tests — but please restore validation"),
      title,
    ],
    [
      "negated checklist",
      replaceChecklist("- [x] Authorization coverage does not include writes"),
      title,
    ],
    [
      "hedged checklist",
      replaceChecklist("- [x] Session-boundary coverage might be complete"),
      title,
    ],
    [
      "semantically actionable checklist",
      replaceChecklist(
        "- [x] Tests confirm the fallback allows unauthenticated writes",
      ),
      title,
    ],
    [
      "unknown plaintext-secret claim",
      replaceChecklist("- [x] API logs private keys in plaintext"),
      title,
    ],
    [
      "unknown credential-storage claim",
      replaceChecklist(
        "- [x] Telemetry stores authentication tokens without encryption",
      ),
      title,
    ],
    [
      "unknown credential-tracing claim",
      replaceChecklist("- [x] Request traces contain signing credentials"),
      title,
    ],
    [
      "unknown declarative checklist",
      replaceChecklist("- [x] The implementation matches the specification"),
      title,
    ],
    [
      "unknown code-label injection",
      replaceChecklist("- [x] `API logs private keys in plaintext` behavior"),
      title,
    ],
    [
      "hyphenated code-label injection",
      replaceChecklist("- [x] `API-logs-private-keys-in-plaintext` behavior"),
      title,
    ],
    [
      "underscored code-label injection",
      replaceChecklist("- [x] `P1_action_required` behavior"),
      title,
    ],
    [
      "malformed Findings heading",
      clean.replace("#### Findings", "#### Findings:"),
      title,
    ],
    [
      "malformed Roll-up heading",
      clean.replace("#### Roll-up", "#### Roll_up"),
      title,
    ],
    [
      "four-space-indented review heading",
      clean.replace(`### Review: ${title}`, `    ### Review: ${title}`),
      title,
    ],
    [
      "tab-indented checklist entry",
      clean.replace("- [x] Runtime behavior", "\t- [x] Runtime behavior"),
      title,
    ],
    [
      "one-space-tab-indented verdict",
      clean.replace("**Verdict: LGTM**", " \t**Verdict: LGTM**"),
      title,
    ],
    [
      "four-space-indented Findings heading",
      clean.replace("#### Findings", "    #### Findings"),
      title,
    ],
    [
      "tab-indented finding",
      replaceFinding("\t1. [P3] No action: tests cover the changed paths."),
      title,
    ],
    [
      "two-space-tab-indented finding",
      replaceFinding("  \t1. [P3] No action: tests cover the changed paths."),
      title,
    ],
    [
      "four-space-indented Roll-up heading",
      clean.replace("#### Roll-up", "    #### Roll-up"),
      title,
    ],
    [
      "tab-indented roll-up",
      replaceRollup("\t1. [P3] No-action: fix is correct."),
      title,
    ],
    [
      "three-space-tab-indented roll-up",
      replaceRollup("   \t1. [P3] No-action: fix is correct."),
      title,
    ],
    [
      "actionable finding suffix",
      replaceFinding(
        "1. [P3] No action: tests cover the changed paths. Remove the fallback.",
      ),
      title,
    ],
    ["marker-only finding", replaceFinding("1. [P3] No action:"), title],
    [
      "delimiter-only finding",
      replaceFinding("1. [P3] No action: .; !"),
      title,
    ],
    [
      "backtick finding label",
      replaceFinding("1. [P3] No action: `clean`."),
      title,
    ],
    [
      "Markdown-link finding target",
      replaceFinding(
        "1. [P3] No action: [clean](https://example.invalid/audit).",
      ),
      title,
    ],
    [
      "HTML-comment finding",
      replaceFinding("1. [P3] No action: clean. <!-- metadata -->"),
      title,
    ],
    [
      "Markdown-link roll-up target",
      replaceRollup(
        "1. [P3] No-action: [clean](https://example.invalid/audit).",
      ),
      title,
    ],
    [
      "negated finding",
      replaceFinding("1. [P3] No action: fix is not correct."),
      title,
    ],
    [
      "hedged finding",
      replaceFinding("1. [P3] No action: fix is probably correct."),
      title,
    ],
    [
      "unknown finding prose",
      replaceFinding("1. [P3] No action: authentication looks fine."),
      title,
    ],
    [
      "unknown roll-up prose",
      replaceRollup("1. [P3] No-action: authentication looks fine."),
      title,
    ],
    [
      "mixed clean and actionable findings",
      replaceFinding(
        "1. [P3] No action: tests cover the changed paths.\n2. [P2] Restore validation.",
      ),
      title,
    ],
    [
      "mixed clean and actionable roll-up",
      replaceRollup(
        "1. [P3] No-action: fix is correct.\n2. [P3] No-action: clean but please remove the fallback.",
      ),
      title,
    ],
  ];

  let fixtureId = 5043638400;
  for (const [label, body, prTitle] of blockingReviews) {
    const normalizedReadyState = normalizedReadyStateForClaudeReview(
      {
        ...PR_1431_CLEAN_CLAUDE_REVIEW,
        id: fixtureId++,
        body,
      },
      { title: prTitle },
    );
    const feedbackState = summarizeFeedbackState(normalizedReadyState);
    assertEqual(normalizedReadyState.required.ready, true);
    assert(
      feedbackState.ready === false,
      `${label}: expected feedback-state to fail closed`,
    );
    assertEqual(feedbackState.counts.blockingTopLevelBotComments, 1);
    assertEqual(feedbackState.counts.blockingFindings > 0, true);
  }
});

test("classifies clean and actionable Claude review variants", () => {
  const before = (heading, text) =>
    PR_1431_CLEAN_CLAUDE_REVIEW.body.replace(
      `\n#### ${heading}`,
      `\n${text}\n\n#### ${heading}`,
    );
  const finding = (text) => before("Roll-up", `6. ${text}`);
  const preface = (text) => before("Findings", text);
  const cleanBodies = [
    "Verdict: lgtm\n\n### Findings\n1. [P3] No action: tests cover the changed paths.\n2. [P3] No action: fix is correct and covered.\n\n### Roll up\n1. [P3] No-action: tests cover the changed paths.",
    "Verdict: LGTM\n\n### Findings\n1. [P3] No action: clean. No errors or failures were observed.\n\n### Roll-up\n1. [P3] No-action: clean.",
    ...[
      "[P3] No action: parser should continue rejecting malformed input.",
      "[P3] None blocking: fallback should stay.",
    ].map(finding),
  ];
  const blockingBodies = [
    ACTIONABLE_CLAUDE_REVIEW_LOOKALIKE.body,
    "Verdict: LGTM\n\n### Findings\n1. [P3] No action: tests confirm the fallback allows unauthenticated writes.\n\n### Roll-up\n1. [P3] No-action: tests confirm the fallback allows unauthenticated writes.",
    "Verdict: LGTM\n\n### Findings\n1. [P3] No action: tests cover the changed paths while exposing that the fallback allows unauthenticated writes.\n\n### Roll-up\n1. [P3] No-action: tests cover the changed paths while exposing that the fallback allows unauthenticated writes.",
    ...[
      "[P3] Regression: malformed input reaches the parser and crashes requests.",
      "[P3] None blocking — but please remove the unsafe fallback before merge.",
      "[P3] No action: fix is correct but malformed input still crashes requests.",
      "Regression: malformed input reaches the parser and crashes requests.",
      "P0:",
      "**P1**",
      "P2 Badge",
      "[P3] No action: the missing authorization check is verified.",
      "Supply Chain CI already passed on this PR; blocker remains.",
      "[P3] No action: override selector does not match repo convention.",
    ].map(finding),
    ...[
      "Restore bounds validation before merge.",
      "Malformed input causes request failures.",
      "No errors or failure blocks release.",
      "| Severity | Finding |\n| --- | --- |\n| Medium Severity | Input crash |",
      "> Low Severity:\n> Malformed input crashes requests.",
      "- [x] Tests confirm the fallback allows unauthenticated writes.",
    ].map(preface),
    preface("### High Severity Notes\nMalformed input crashes requests."),
    ...["**Severity:** High", "**Severity**: High"].map((label) =>
      preface(`${label}\nMalformed input crashes requests.`),
    ),
    before("Roll-up", "Action items: restore validation."),
    before("Roll-up", "<!-- BUGBOT_BUG_ID: malformed-input -->"),
    PR_1431_CLEAN_CLAUDE_REVIEW.body.replace(
      "1. [P3] No-action: override selector is correctly bounded and matches repo convention.",
      "1. [P3] None blocking — please remove the unsafe fallback before merge.",
    ),
    "Verdict: LGTM\n\n### Findings\n1. Regression: malformed input crashes requests.\n\n### Roll-up\n1. No-action: clean.",
    PR_1431_CLEAN_CLAUDE_REVIEW.body.replace(
      "#### Roll-up",
      "#### Findings\n\n#### Roll-up",
    ),
    "Verdict: LGTM\n\n### Roll-up\n1. [P3] No-action: clean.\n\n### Findings\n1. [P3] No action: clean.",
  ];

  let fixtureId = 5043638100;
  for (const [expectedReady, bodies] of [
    [true, cleanBodies],
    [false, blockingBodies],
  ]) {
    for (const body of bodies) {
      const readyStateSummary = normalizedReadyStateForClaudeReview({
        ...PR_1431_CLEAN_CLAUDE_REVIEW,
        id: fixtureId++,
        body,
      });
      const feedbackState = summarizeFeedbackState(readyStateSummary);
      assert(
        feedbackState.ready === expectedReady,
        `${body.slice(0, 60)}: expected ready=${expectedReady}`,
      );
      assertEqual(
        feedbackState.counts.blockingTopLevelBotComments,
        expectedReady ? 0 : 1,
      );
    }
  }
});

test("blocks on current-head priority review bot summaries", () => {
  const readyStateSummary = normalizedReadyStateForClaudeReview({
    ...PR_1431_CLEAN_CLAUDE_REVIEW,
    id: 5043638200,
    body: "P3 - finding\nP3 — finding\n| P3 | finding |",
  });
  const summary = summarizeFeedbackState(readyStateSummary);

  assertEqual(summary.ready, false);
  assertEqual(summary.counts.blockingTopLevelBotComments, 1);
});

test("blocks on bot review bodies tied to the current commit", () => {
  const currentHead = "b".repeat(40);
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
        id: "review-1",
        author: "cursor[bot]",
        commitOid: currentHead,
        createdAt: "2026-06-05T16:31:00Z",
        body: "Failure handling is correct only for reads; writes remain unauthenticated.",
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

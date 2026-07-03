#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  aggregateMetrics,
  isFindingLikeText,
  isReviewBotLogin,
  selectMergedAfter,
  selectMergedBefore,
  summarizePullRequestMetrics,
} from "./review-process-metrics.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("selects merged PRs before the boundary by mergedAt descending", () => {
  const selected = selectMergedBefore(
    [
      { number: 1, mergedAt: "2026-07-03T10:00:00Z" },
      { number: 2, mergedAt: "2026-07-03T12:00:00Z" },
      { number: 3, mergedAt: "2026-07-03T15:00:00Z" },
      { number: 4, mergedAt: "2026-07-03T11:00:00Z" },
    ],
    "2026-07-03T13:00:00Z",
    2,
  );

  assert.deepEqual(
    selected.map((pr) => pr.number),
    [2, 4],
  );
});

test("selects merged PRs after the boundary by mergedAt ascending", () => {
  const selected = selectMergedAfter(
    [
      { number: 1, mergedAt: "2026-07-03T10:00:00Z" },
      { number: 2, mergedAt: "2026-07-03T12:00:00Z" },
      { number: 3, mergedAt: "2026-07-03T15:00:00Z" },
      { number: 4, mergedAt: "2026-07-03T14:00:00Z" },
    ],
    "2026-07-03T11:00:00Z",
    2,
  );

  assert.deepEqual(
    selected.map((pr) => pr.number),
    [2, 4],
  );
});

test("identifies review bots and finding-like review text", () => {
  assert.equal(isReviewBotLogin("claude[bot]"), true);
  assert.equal(isReviewBotLogin("chatgpt-codex-connector"), true);
  assert.equal(isReviewBotLogin("chapati23"), false);
  assert.equal(isFindingLikeText("[P2] Missing branch coverage"), true);
  assert.equal(isFindingLikeText("Codex Review: no major issues"), false);
});

test("summarizes PR review metrics from GitHub-shaped fixtures", () => {
  const summary = summarizePullRequestMetrics({
    collectedAt: "2026-07-04T00:00:00Z",
    pr: {
      number: 42,
      title: "Test PR",
      url: "https://github.com/example/repo/pull/42",
      createdAt: "2026-07-03T10:00:00Z",
      mergedAt: "2026-07-03T12:00:00Z",
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      commits: [
        { committedDate: "2026-07-03T10:05:00Z" },
        { committedDate: "2026-07-03T11:30:00Z" },
      ],
      comments: [
        {
          author: { login: "claude" },
          body: "**Claude finished**\n\n[P2] Fix parser edge case",
          createdAt: "2026-07-03T10:30:00Z",
        },
        {
          author: { login: "chatgpt-codex-connector" },
          body: "Codex usage limits have been reached for code reviews.",
          createdAt: "2026-07-03T10:35:00Z",
        },
        {
          author: { login: "chapati23" },
          body: "@codex review",
          createdAt: "2026-07-03T11:00:00Z",
        },
      ],
      reviews: [
        {
          author: { login: "claude" },
          submittedAt: "2026-07-03T10:45:00Z",
        },
      ],
    },
    reviewComments: [
      {
        id: 1,
        user: { login: "claude" },
        body: "[P2] Inline finding",
        created_at: "2026-07-03T10:40:00Z",
      },
      {
        id: 2,
        in_reply_to_id: 1,
        user: { login: "chapati23" },
        body: "Fixed",
        created_at: "2026-07-03T11:20:00Z",
      },
      {
        id: 3,
        user: { login: "cursor" },
        body: "Looks good",
        created_at: "2026-07-03T10:50:00Z",
      },
    ],
  });

  assert.equal(summary.durationHours, 2);
  assert.equal(summary.commitsAfterFirstReview, 1);
  assert.equal(summary.comments.topLevel, 3);
  assert.equal(summary.comments.reviewInlineRoots, 2);
  assert.equal(summary.comments.reviewInlineReplies, 1);
  assert.equal(summary.comments.reviewInlineRootsWithoutReplies, 1);
  assert.equal(summary.comments.humanReviewRequests, 1);
  assert.equal(summary.botReviewSignals.findingLikeTopLevel, 1);
  assert.equal(summary.botReviewSignals.findingLikeInline, 1);
  assert.equal(summary.botReviewSignals.candidateFindings, 2);
  assert.equal(summary.botReviewSignals.codexUsageLimitComments, 1);
  assert.equal(summary.botReviewSignals.claudeSummaryComments, 1);
});

test("aggregates cohort summary metrics", () => {
  const aggregate = aggregateMetrics([
    {
      durationHours: 1,
      commitsAfterFirstReview: 0,
      comments: {
        topLevel: 1,
        reviewInlineRoots: 2,
        reviewInlineReplies: 3,
        reviewInlineRootsWithoutReplies: 1,
        humanReviewRequests: 0,
      },
      botReviewSignals: {
        candidateFindings: 2,
        codexUsageLimitComments: 1,
        codexApprovalComments: 0,
        claudeSummaryComments: 1,
      },
    },
    {
      durationHours: 3,
      commitsAfterFirstReview: 2,
      comments: {
        topLevel: 4,
        reviewInlineRoots: 5,
        reviewInlineReplies: 6,
        reviewInlineRootsWithoutReplies: 0,
        humanReviewRequests: 1,
      },
      botReviewSignals: {
        candidateFindings: 7,
        codexUsageLimitComments: 0,
        codexApprovalComments: 1,
        claudeSummaryComments: 1,
      },
    },
  ]);

  assert.equal(aggregate.pullRequests, 2);
  assert.equal(aggregate.medianDurationHours, 2);
  assert.equal(aggregate.medianCommitsAfterFirstReview, 1);
  assert.equal(aggregate.totals.candidateFindings, 9);
  assert.equal(aggregate.totals.inlineRootsWithoutReplies, 1);
});

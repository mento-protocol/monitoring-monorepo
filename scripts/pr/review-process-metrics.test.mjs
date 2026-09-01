#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateMetrics,
  aggregateMetricsV2,
  assertCompleteCohort,
  assertCompleteForcePushGraphqlPages,
  assertCompletePaginatedSurface,
  buildReport,
  enrichTimelineForcePushes,
  isClaudeSummary,
  isCodexApprovalComment,
  isCodexUsageLimit,
  isFindingLikeText,
  isCodexBotLogin,
  isClaudeBotLogin,
  isReviewBotLogin,
  parseArgs,
  parseForcePushGraphqlPage,
  parseUtcTimestamp,
  selectMergedAfter,
  selectMergedBefore,
  selectMergedInUtcWindow,
  summarizePullRequestMetrics,
  summarizePullRequestMetricsV2,
  timelineItemIdentity,
  writeReportFile,
} from "./review-process-metrics.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(SCRIPT_DIRECTORY, "fixtures/review-process-metrics-coderabbit.json"),
    "utf8",
  ),
);

function summarizeFixture(value = fixture) {
  return summarizePullRequestMetricsV2({
    ...value,
    pagination: {
      issueComments: { complete: true },
      reviewSubmissions: { complete: true },
      reviewComments: { complete: true },
      timeline: {
        complete: true,
        forcePushGraphql: { complete: true },
      },
      commits: { complete: true },
    },
    collectedAt: "2026-08-01T12:01:00Z",
  });
}

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
  assert.equal(isClaudeBotLogin("claude[bot]"), true);
  assert.equal(isCodexBotLogin("chatgpt-codex-connector[bot]"), true);
  assert.equal(isReviewBotLogin("chapati23"), false);
  assert.equal(isFindingLikeText("[P2] Missing branch coverage"), true);
  assert.equal(isFindingLikeText("Codex Review: no major issues"), false);
});

test("counts CodeRabbit as a review bot without moving the other bots", () => {
  // ADR 0066. The OLD path is asserted in the same test so a roster edit that
  // displaced Cursor, Codex, or Claude would fail here.
  assert.equal(isReviewBotLogin("coderabbitai[bot]"), true);
  assert.equal(isReviewBotLogin("coderabbitai"), true);
  assert.equal(isReviewBotLogin("cursor[bot]"), true);
  assert.equal(isReviewBotLogin("claude[bot]"), true);
  assert.equal(isReviewBotLogin("chatgpt-codex-connector[bot]"), true);
  assert.equal(isReviewBotLogin("chapati23"), false);
  // CodeRabbit is not Codex and not Claude; the per-bot detectors stay narrow.
  assert.equal(isCodexBotLogin("coderabbitai[bot]"), false);
  assert.equal(isClaudeBotLogin("coderabbitai[bot]"), false);
});

test("counts CodeRabbit findings as finding-like text", () => {
  assert.equal(
    isFindingLikeText("<!-- cr-indicator-types:potential_issue -->"),
    true,
  );
  assert.equal(
    isFindingLikeText(
      "_🎯 Functional Correctness_ | _🟠 Major_ | _🏗️ Heavy lift_",
    ),
    true,
  );
  assert.equal(isFindingLikeText("_🟡 Minor_"), true);
  // Negative control: CodeRabbit machinery carries neither marker.
  assert.equal(isFindingLikeText("## Review limit reached"), false);
  // OLD path: the Cursor marker and priority badges still count.
  assert.equal(isFindingLikeText("<!-- BUGBOT_BUG_ID: example -->"), true);
  assert.equal(isFindingLikeText("[P2] Missing branch coverage"), true);
});

test("identifies review-summary detector text", () => {
  assert.equal(isClaudeSummary("Claude finished @chapati23's task"), true);
  assert.equal(isClaudeSummary("### PR Review — LGTM"), true);
  assert.equal(isCodexUsageLimit("Codex usage limits have been reached"), true);
  assert.equal(
    isCodexApprovalComment("Codex Review: didn't find any major issues"),
    true,
  );
  assert.equal(isCodexApprovalComment("Codex Review: needs changes"), false);
});

test("rejects incomplete boundary cohorts instead of reporting partial data", () => {
  assert.throws(
    () =>
      assertCompleteCohort([{ number: 2 }], {
        direction: "after",
        limit: 2,
        boundary: { number: 1 },
      }),
    /only found 1 merged PR\(s\) after PR #1; requested 2/,
  );
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
          author: { login: "claude[bot]" },
          body: "**Claude finished**\n\n[P2] Fix parser edge case",
          createdAt: "2026-07-03T10:30:00Z",
        },
        {
          author: { login: "chatgpt-codex-connector[bot]" },
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
          author: { login: "claude[bot]" },
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
  assert.equal(summary.botReviewSignals.codexComments, 1);
  assert.equal(summary.botReviewSignals.codexUsageLimitComments, 1);
  assert.equal(summary.botReviewSignals.claudeSummaryComments, 1);
});

test("preserves schema-v1 review-request matching", () => {
  const summary = summarizePullRequestMetrics({
    collectedAt: "2026-07-03T12:01:00Z",
    pr: {
      number: 43,
      title: "Legacy request matching",
      url: "https://example.invalid/pull/43",
      createdAt: "2026-07-03T10:00:00Z",
      mergedAt: "2026-07-03T12:00:00Z",
      comments: [
        {
          author: { login: "maintainer" },
          body: "@coderabbitai review",
          createdAt: "2026-07-03T10:10:00Z",
        },
        {
          author: { login: "maintainer" },
          body: "bugbot run",
          createdAt: "2026-07-03T10:15:00Z",
        },
        {
          author: { login: "maintainer" },
          body: "Please run @codex review when ready.",
          createdAt: "2026-07-03T10:30:00Z",
        },
      ],
      reviews: [],
      commits: [
        { committedDate: "2026-07-03T10:20:00Z" },
        { committedDate: "2026-07-03T10:40:00Z" },
      ],
    },
    reviewComments: [],
  });

  assert.equal(summary.comments.humanReviewRequests, 1);
  assert.equal(summary.commitsAfterFirstReview, 1);
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

test("parses one half-open UTC cohort and rejects ambiguous selectors", () => {
  const args = parseArgs([
    "--since",
    "2026-08-01T00:00:00Z",
    "--until",
    "2026-09-01T00:00:00Z",
  ]);
  assert.equal(args.since, "2026-08-01T00:00:00.000Z");
  assert.equal(args.until, "2026-09-01T00:00:00.000Z");
  assert.throws(
    () => parseArgs(["--since", "2026-08-01T00:00:00Z"]),
    /must be supplied together/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--prs",
        "1",
        "--since",
        "2026-08-01T00:00:00Z",
        "--until",
        "2026-09-01T00:00:00Z",
      ]),
    /exactly one/,
  );
  assert.throws(
    () => parseUtcTimestamp("2026-08-01T02:00:00+02:00", "--since"),
    /ending in Z/,
  );
  assert.throws(
    () => parseUtcTimestamp("2026-02-31T00:00:00Z", "--since"),
    /not a valid timestamp/,
  );
  assert.equal(
    parseArgs(["--repo", "owner-name/repo.name_2", "--prs", "42"]).repo,
    "owner-name/repo.name_2",
  );
  for (const repo of [
    "owner/repo?per_page=1",
    "owner/repo#fragment",
    "owner/repo%2Fother",
  ]) {
    assert.throws(
      () => parseArgs(["--repo", repo, "--prs", "42"]),
      /requires owner\/repo/,
    );
  }
});

test("selects merged PRs in the half-open UTC interval", () => {
  const selected = selectMergedInUtcWindow(
    [
      { number: 1, mergedAt: "2026-07-31T23:59:59Z" },
      { number: 2, mergedAt: "2026-08-01T00:00:00Z" },
      { number: 3, mergedAt: "2026-08-31T23:59:59Z" },
      { number: 4, mergedAt: "2026-09-01T00:00:00Z" },
    ],
    "2026-08-01T00:00:00Z",
    "2026-09-01T00:00:00Z",
  );
  assert.deepEqual(
    selected.map(({ number }) => number),
    [2, 3],
  );
});

test("fails closed on incomplete, malformed, or duplicated pagination", () => {
  const complete = assertCompletePaginatedSurface(
    [[{ id: 1 }, { id: 2 }], [{ id: 3 }]],
    { surface: "fixture", expectedCount: 3 },
  );
  assert.equal(complete.pagination.complete, true);
  assert.equal(complete.pagination.pages, 2);
  assert.throws(
    () =>
      assertCompletePaginatedSurface([[{ id: 1 }]], {
        surface: "fixture",
        expectedCount: 2,
      }),
    /incomplete/,
  );
  assert.throws(
    () =>
      assertCompletePaginatedSurface([[{ id: 1 }]], {
        surface: "PR #42 commits",
        expectedCount: 251,
        sourceLimit: 250,
      }),
    /GitHub endpoint caps this surface at 250 items/,
  );
  assert.throws(
    () =>
      assertCompletePaginatedSurface([[{ id: 1 }], [{ id: 1 }]], {
        surface: "fixture",
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      assertCompletePaginatedSurface([], {
        surface: "fixture",
      }),
    /no page envelope/,
  );
});

test("uses stable timeline identities for node and cross-reference events", () => {
  assert.equal(
    timelineItemIdentity({ node_id: "IC_fixture" }),
    JSON.stringify(["node", "IC_fixture"]),
  );
  const referenceEvent = {
    event: "cross-referenced",
    created_at: "2026-08-19T16:03:23Z",
    source: { issue: { node_id: "PR_fixture_source" } },
  };
  assert.equal(
    timelineItemIdentity(referenceEvent),
    JSON.stringify([
      "cross-referenced",
      "PR_fixture_source",
      "2026-08-19T16:03:23Z",
    ]),
  );
  assert.equal(
    timelineItemIdentity({
      event: "cross-referenced",
      created_at: referenceEvent.created_at,
      source: { issue: {} },
    }),
    null,
  );
  assert.throws(
    () =>
      assertCompletePaginatedSurface(
        [[referenceEvent], [structuredClone(referenceEvent)]],
        { surface: "timeline", id: timelineItemIdentity },
      ),
    /duplicate/,
  );
});

function forcePushGraphqlPayload({
  nodes,
  totalCount = nodes.length,
  hasNextPage = false,
  endCursor = null,
}) {
  return {
    data: {
      repository: {
        pullRequest: {
          timelineItems: {
            totalCount,
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  };
}

function forcePushGraphqlNode(id, createdAt, beforeHead, afterHead) {
  return {
    id,
    createdAt,
    beforeCommit: { oid: beforeHead },
    afterCommit: { oid: afterHead },
  };
}

test("parses complete GraphQL force-push pages without trusting totalCount", () => {
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const headC = "c".repeat(40);
  const first = parseForcePushGraphqlPage(
    forcePushGraphqlPayload({
      nodes: [
        forcePushGraphqlNode(
          "FP_graphql_a",
          "2026-08-01T10:10:00Z",
          headA,
          headB,
        ),
      ],
      totalCount: 99,
      hasNextPage: true,
      endCursor: "cursor-1",
    }),
  );
  const second = parseForcePushGraphqlPage(
    forcePushGraphqlPayload({
      nodes: [
        forcePushGraphqlNode(
          "FP_graphql_b",
          "2026-08-01T10:20:00Z",
          headB,
          headC,
        ),
      ],
      totalCount: 99,
    }),
    "cursor-1",
  );
  const complete = assertCompleteForcePushGraphqlPages(
    [first, second],
    "fixture force pushes",
  );
  assert.equal(complete.items.length, 2);
  assert.equal(complete.pagination.complete, true);
  assert.equal(complete.pagination.reportedUnfilteredTimelineItemCount, 99);
  const emptyFilteredPage = parseForcePushGraphqlPage(
    forcePushGraphqlPayload({ nodes: [], totalCount: 9 }),
  );
  assert.equal(
    assertCompleteForcePushGraphqlPages(
      [emptyFilteredPage],
      "empty fixture force pushes",
    ).items.length,
    0,
  );

  assert.throws(
    () =>
      parseForcePushGraphqlPage(
        forcePushGraphqlPayload({
          nodes: [
            {
              id: "FP_incomplete",
              createdAt: "2026-08-01T10:30:00Z",
              beforeCommit: { oid: headA },
              afterCommit: null,
            },
          ],
        }),
      ),
    /incomplete event evidence/,
  );
  assert.throws(
    () =>
      parseForcePushGraphqlPage({
        ...forcePushGraphqlPayload({ nodes: [] }),
        errors: [{ message: "partial result" }],
      }),
    /invalid page envelope/,
  );
  assert.throws(
    () => assertCompleteForcePushGraphqlPages([first], "fixture force pushes"),
    /incomplete page chain/,
  );
  assert.throws(
    () =>
      assertCompleteForcePushGraphqlPages(
        [first, { ...second, requestCursor: "wrong-cursor" }],
        "fixture force pushes",
      ),
    /conflicting cursor chain/,
  );
  assert.throws(
    () =>
      assertCompleteForcePushGraphqlPages(
        [first, { ...second, totalCount: 100 }],
        "fixture force pushes",
      ),
    /conflicting total counts/,
  );
  assert.throws(
    () =>
      assertCompleteForcePushGraphqlPages(
        [first, { ...second, items: first.items }],
        "fixture force pushes",
      ),
    /duplicate events/,
  );
});

test("binds GraphQL proof to REST force-push events with omitted commits", () => {
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const createdAt = "2026-08-01T10:10:00Z";
  const proof = {
    nodeId: "FP_live_rest_shape",
    createdAt,
    beforeHead: headA,
    afterHead: headB,
  };
  const enriched = enrichTimelineForcePushes(
    [
      {
        event: "head_ref_force_pushed",
        node_id: proof.nodeId,
        created_at: createdAt,
      },
    ],
    [proof],
  );
  assert.equal(enriched.complete, true);
  assert.deepEqual(enriched.items[0].force_push_proof, {
    kind: "graphql",
    ...proof,
  });

  const timestampConflict = enrichTimelineForcePushes(
    [
      {
        event: "head_ref_force_pushed",
        node_id: proof.nodeId,
        created_at: "2026-08-01T10:11:00Z",
      },
    ],
    [proof],
  );
  assert.equal(timestampConflict.complete, false);
  assert.equal(
    timestampConflict.conflicts[0].reason,
    "force_push_enrichment_timestamp_conflict",
  );

  const commitConflict = enrichTimelineForcePushes(
    [
      {
        event: "head_ref_force_pushed",
        node_id: proof.nodeId,
        created_at: createdAt,
        commit_id: "c".repeat(40),
      },
    ],
    [proof],
  );
  assert.equal(commitConflict.complete, false);
  assert.equal(
    commitConflict.conflicts[0].reason,
    "force_push_enrichment_commit_conflict",
  );
  const missingRestEvent = enrichTimelineForcePushes([], [proof]);
  assert.equal(missingRestEvent.complete, false);
  assert.equal(
    missingRestEvent.conflicts[0].reason,
    "force_push_rest_timeline_event_not_found",
  );
});

test("classifies sanitized per-bot evidence and observed CodeRabbit signals", () => {
  const summary = summarizeFixture();
  assert.deepEqual(summary.evidence.byBot.coderabbit.dispositions, {
    fixed: 1,
    wont_fix: 1,
    bot_conceded: 1,
    unclassified: 1,
    unknown: 0,
  });
  assert.deepEqual(summary.evidence.byBot.cursor.dispositions, {
    fixed: 0,
    wont_fix: 0,
    bot_conceded: 0,
    unclassified: 0,
    unknown: 1,
  });
  assert.equal(summary.evidence.signals.reviewRuns.count, 1);
  assert.deepEqual(summary.evidence.signals.reviewRuns.byBot, {
    coderabbit: 1,
    codex: 0,
    claude: 0,
    cursor: 0,
  });
  assert.equal(summary.evidence.signals.pauses.count, 1);
  assert.equal(summary.evidence.signals.rateLimits.count, 1);
  assert.equal(summary.evidence.signals.pathFilterSkips.count, 1);
  assert.equal(summary.evidence.signals.freeTierNotices.count, 1);
  assert.equal(summary.evidence.signals.manualRequests.count, 2);
  assert.equal(summary.evidence.signals.manualRequests.markedExactHead, 1);
  assert.equal(summary.evidence.signals.manualRequests.bare, 1);
  assert.equal(summary.evidence.signals.manualRequests.uniqueExactHeads, 1);

  const crossBotReplyFixture = structuredClone(fixture);
  crossBotReplyFixture.reviewComments.push({
    id: 311,
    in_reply_to_id: 308,
    html_url: "https://github.com/example/repo/pull/42#discussion_r311",
    created_at: "2026-08-01T10:45:00Z",
    path: "src/unclassified.ts",
    user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    body: "This is a false positive.",
  });
  const crossBotSummary = summarizeFixture(crossBotReplyFixture);
  assert.equal(
    crossBotSummary.evidence.byBot.coderabbit.dispositions.unclassified,
    1,
  );

  const negatedConcessionFixture = structuredClone(fixture);
  negatedConcessionFixture.reviewComments.push({
    id: 312,
    in_reply_to_id: 308,
    html_url: "https://github.com/example/repo/pull/42#discussion_r312",
    created_at: "2026-08-01T10:46:00Z",
    path: "src/unclassified.ts",
    user: { login: "coderabbitai[bot]", type: "Bot" },
    body: "This is not a false positive.",
  });
  const negatedConcessionSummary = summarizeFixture(negatedConcessionFixture);
  assert.equal(
    negatedConcessionSummary.evidence.byBot.coderabbit.dispositions
      .unclassified,
    1,
  );

  const hedgedConcessionFixture = structuredClone(fixture);
  hedgedConcessionFixture.reviewComments.push({
    id: 313,
    in_reply_to_id: 308,
    user: { login: "coderabbitai[bot]", type: "Bot" },
    body: "I don't think this is a false positive.",
  });
  assert.equal(
    summarizeFixture(hedgedConcessionFixture).evidence.byBot.coderabbit
      .dispositions.unclassified,
    1,
  );

  const affirmativeConcessionFixture = structuredClone(fixture);
  affirmativeConcessionFixture.reviewComments.push({
    id: 315,
    in_reply_to_id: 308,
    user: { login: "coderabbitai[bot]", type: "Bot" },
    body: "You're right — this is a false positive.",
  });
  assert.equal(
    summarizeFixture(affirmativeConcessionFixture).evidence.byBot.coderabbit
      .dispositions.bot_conceded,
    2,
  );

  for (const body of [
    "This is a false positive?",
    "I withdraw this finding?",
    "> This is a false positive.\n\nI disagree; the finding still applies.",
  ]) {
    const questionFixture = structuredClone(fixture);
    questionFixture.reviewComments.push({
      id: 316,
      in_reply_to_id: 308,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body,
    });
    assert.equal(
      summarizeFixture(questionFixture).evidence.byBot.coderabbit.dispositions
        .unclassified,
      1,
    );
  }

  const outsiderFixture = structuredClone(fixture);
  outsiderFixture.reviewComments.push({
    id: 314,
    in_reply_to_id: 308,
    author_association: "NONE",
    user: { login: "outsider", type: "User" },
    body: "Fixed in `deadbee` — untrusted claim.",
  });
  const outsiderSummary = summarizeFixture(outsiderFixture);
  assert.equal(outsiderSummary.evidence.byBot.coderabbit.dispositions.fixed, 1);
  assert.equal(
    outsiderSummary.evidence.byBot.coderabbit.dispositions.unknown,
    1,
  );
  assert.equal(
    outsiderSummary.evidence.byBot.coderabbit.surfaces.review_comments.evidence.find(
      ({ id }) => id === "308",
    ).untrustedReplyEvidence.length,
    1,
  );
});

test("preserves the matched signal outside the bounded evidence excerpt", () => {
  const value = structuredClone(fixture);
  value.reviewComments.push({
    id: 400,
    html_url: "https://github.com/example/repo/pull/42#discussion_r400",
    created_at: "2026-08-01T10:50:00Z",
    path: "src/long-finding.ts",
    user: { login: "coderabbitai[bot]", type: "Bot" },
    body: `${"Long review context. ".repeat(20)}<!-- cr-indicator-types:potential_issue -->`,
  });

  const record = summarizeFixture(
    value,
  ).evidence.byBot.coderabbit.surfaces.review_comments.evidence.find(
    ({ id }) => id === "400",
  );
  assert.equal(record.finding, true);
  assert.equal(
    record.findingSignal,
    "<!-- cr-indicator-types:potential_issue -->",
  );
  assert.equal(record.excerpt.includes("cr-indicator-types"), false);
});

test("attributes CodeRabbit run IDs only to CodeRabbit-authored records", () => {
  const value = structuredClone(fixture);
  value.reviews.push({
    id: 206,
    state: "COMMENTED",
    user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    body: "Quoted fixture marker: **Run ID**: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`",
  });

  const reviewRuns = summarizeFixture(value).evidence.signals.reviewRuns;
  assert.equal(reviewRuns.count, 1);
  assert.equal(reviewRuns.byBot.coderabbit, 1);
  assert.equal(reviewRuns.byBot.codex, 0);
});

test("counts review runs only from canonical CodeRabbit completion evidence", () => {
  const value = structuredClone(fixture);
  const completedBody = (
    wrapper,
    runId,
    outerLines = [],
    completionSuffix = "",
  ) =>
    [
      `<!-- This is an auto-generated comment: ${wrapper} by coderabbit.ai -->`,
      ...outerLines,
      "<!-- recent_review_start -->",
      `No actionable comments were generated in the recent review.${completionSuffix}`,
      `**Run ID**: \`${runId}\``,
      "<!-- recent_review_end -->",
    ].join("\n");
  value.issueComments.push(
    {
      id: 410,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: completedBody("summarize", "22222222-2222-2222-2222-222222222222"),
    },
    {
      id: 411,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: completedBody(
        "skip review",
        "33333333-3333-3333-3333-333333333333",
        ["> ## Review skipped", "> Review was skipped due to path filters"],
      ),
    },
    {
      id: 412,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: [
        "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
        "**Run ID**: `44444444-4444-4444-4444-444444444444`",
        "<!-- recent_review_start -->",
        "No actionable comments were generated in the recent review.",
        "<!-- recent_review_end -->",
      ].join("\n"),
    },
    {
      id: 413,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "<!-- This is an auto-generated comment: review paused by coderabbit.ai -->\n> ## Reviews paused\n> Reviews paused due to new commits.\n**Run ID**: `55555555-5555-5555-5555-555555555555`",
    },
    {
      id: 414,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached\n**Run ID**: `66666666-6666-6666-6666-666666666666`",
    },
    {
      id: 415,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: [
        "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
        "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->",
        "> ## Review skipped",
        "> Review was skipped due to path filters",
        "> **Run ID**: `77777777-7777-7777-7777-777777777777`",
        "<!-- end of auto-generated comment: skip review by coderabbit.ai -->",
      ].join("\n"),
    },
    {
      id: 416,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n> This repository does not receive automatic reviews because it has fewer than 10 stars.\n**Run ID**: `88888888-8888-8888-8888-888888888888`",
    },
    {
      id: 417,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "Diagnostic context only.\n**Run ID**: `99999999-9999-9999-9999-999999999999`",
    },
    {
      id: 418,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: [
        "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
        "No actionable comments were generated in the recent review.",
        "<!-- recent_review_start -->",
        "**Run ID**: `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`",
        "<!-- recent_review_end -->",
      ].join("\n"),
    },
    {
      id: 419,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: completedBody(
        "summarize",
        "abababab-abab-abab-abab-abababababab",
        [],
        " 🎉",
      ),
    },
    {
      id: 420,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: completedBody(
        "summarize",
        "bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc",
        [],
        " 🚀",
      ),
    },
    {
      id: 421,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: completedBody(
        "summarize",
        "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd",
        [],
        " Review complete.",
      ),
    },
  );

  const signals = summarizeFixture(value).evidence.signals;
  assert.equal(signals.reviewRuns.count, 4);
  assert.deepEqual(
    signals.reviewRuns.evidence.map(({ id }) => id),
    ["101", "410", "411", "419"],
  );
  assert.equal(signals.pauses.count, 2);
  assert.equal(signals.rateLimits.count, 2);
  assert.equal(signals.pathFilterSkips.count, 3);
  assert.equal(signals.freeTierNotices.count, 2);
  assert.deepEqual(
    signals.pathFilterSkips.evidence.map(({ id }) => id),
    ["104", "411", "415"],
  );
});

test("extracts one unambiguous Run ID from CodeRabbit review submissions", () => {
  const value = structuredClone(fixture);
  value.issueComments = [];
  value.reviews = [
    {
      id: 501,
      state: "COMMENTED",
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "Completed review without a Run ID.",
    },
    {
      id: 502,
      state: "COMMENTED",
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "**Run ID**: `bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`",
    },
    {
      id: 503,
      state: "COMMENTED",
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "**Run ID**: `cccccccc-cccc-cccc-cccc-cccccccccccc`\n**Run ID**: `dddddddd-dddd-dddd-dddd-dddddddddddd`",
    },
  ];

  const reviewRuns = summarizeFixture(value).evidence.signals.reviewRuns;
  assert.equal(reviewRuns.count, 1);
  assert.deepEqual(reviewRuns.evidence, [
    {
      id: "502",
      url: "https://github.com/example/repo/pull/42",
      author: "coderabbitai[bot]",
      authorAssociation: null,
      surface: "review_submissions",
      createdAt: null,
      updatedAt: null,
      path: null,
      finding: false,
      excerpt: "**Run ID**: `bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`",
      type: "review_run",
      bot: "coderabbit",
      runId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    },
  ]);
});

test("uses the latest explicit same-bot stance without weakening human authority", () => {
  const botReply = (id, createdAt, body) => ({
    id,
    in_reply_to_id: 308,
    created_at: createdAt,
    user: { login: "coderabbitai[bot]", type: "Bot" },
    body,
  });
  const summarizeRoot = (...replies) => {
    const value = structuredClone(fixture);
    value.reviewComments.push(...replies);
    return summarizeFixture(
      value,
    ).evidence.byBot.coderabbit.surfaces.review_comments.evidence.find(
      ({ id }) => id === "308",
    );
  };

  const humanWontFix = {
    id: 317,
    in_reply_to_id: 308,
    created_at: "2026-08-01T10:41:00Z",
    author_association: "OWNER",
    user: { login: "reviewer", type: "User" },
    body: "Won't fix: the finding conflicts with the verified contract.",
  };
  const restoredAfterConcession = summarizeRoot(
    humanWontFix,
    botReply(319, "2026-08-01T10:43:00Z", "The finding still applies."),
    botReply(318, "2026-08-01T10:42:00Z", "I withdraw this finding."),
  );
  assert.equal(restoredAfterConcession.disposition, "wont_fix");
  assert.deepEqual(
    restoredAfterConcession.botConcessionEvidence.map(({ id }) => id),
    ["318"],
  );
  assert.deepEqual(
    restoredAfterConcession.botRestorationEvidence.map(({ id }) => id),
    ["319"],
  );

  const restoredWithoutHuman = summarizeRoot(
    botReply(320, "2026-08-01T10:42:00Z", "This is a false positive."),
    botReply(321, "2026-08-01T10:43:00Z", "I stand by this finding."),
  );
  assert.equal(restoredWithoutHuman.disposition, "unknown");
  assert.equal(
    restoredWithoutHuman.reason,
    "bot_restored_finding_without_human_classification",
  );
  assert.equal(restoredWithoutHuman.botConcessionEvidence.length, 1);
  assert.equal(restoredWithoutHuman.botRestorationEvidence.length, 1);

  const concededAfterRestoration = summarizeRoot(
    botReply(322, "2026-08-01T10:42:00Z", "This is not a false positive."),
    botReply(323, "2026-08-01T10:43:00Z", "This is a false positive."),
  );
  assert.equal(concededAfterRestoration.disposition, "bot_conceded");
  assert.equal(concededAfterRestoration.botRestorationEvidence.length, 1);
  assert.equal(concededAfterRestoration.botConcessionEvidence.length, 1);

  const neutralAfterConcession = summarizeRoot(
    botReply(324, "2026-08-01T10:42:00Z", "This is a false positive."),
    botReply(325, "2026-08-01T10:43:00Z", "Thanks for the context."),
  );
  assert.equal(neutralAfterConcession.disposition, "bot_conceded");
  assert.equal(neutralAfterConcession.botConcessionEvidence.length, 1);
  assert.equal(neutralAfterConcession.botRestorationEvidence.length, 0);
});

test("preserves disposition signals outside bounded reply excerpts", () => {
  const longPrefix = `${"Long reply context. ".repeat(20)}\n`;
  const summarizeRoot = (...replies) => {
    const value = structuredClone(fixture);
    value.reviewComments.push(...replies);
    return summarizeFixture(
      value,
    ).evidence.byBot.coderabbit.surfaces.review_comments.evidence.find(
      ({ id }) => id === "308",
    );
  };
  const humanReply = (id, body) => ({
    id,
    in_reply_to_id: 308,
    created_at: `2026-08-01T10:${id - 370}:00Z`,
    user: { login: "maintainer", type: "User" },
    body,
  });
  const botReply = (id, body) => ({
    id,
    in_reply_to_id: 308,
    created_at: `2026-08-01T10:${id - 370}:00Z`,
    user: { login: "coderabbitai[bot]", type: "Bot" },
    body,
  });

  const fixed = summarizeRoot(
    humanReply(
      420,
      `${longPrefix}Fixed in \`deadbee\` — added the missing guard.`,
    ),
  );
  assert.equal(fixed.disposition, "fixed");
  assert.equal(
    fixed.humanClassificationEvidence[0].dispositionSignal,
    "Fixed in `deadbee` —",
  );
  assert.equal(
    fixed.humanClassificationEvidence[0].excerpt.includes("Fixed in"),
    false,
  );

  const wontFix = summarizeRoot(
    humanReply(
      421,
      `${longPrefix}Won't fix: the verified contract requires this behavior.`,
    ),
  );
  assert.equal(wontFix.disposition, "wont_fix");
  assert.equal(
    wontFix.humanClassificationEvidence[0].dispositionSignal,
    "Won't fix:",
  );
  assert.equal(
    wontFix.humanClassificationEvidence[0].excerpt.includes("Won't fix"),
    false,
  );

  const conceded = summarizeRoot(
    botReply(422, `${longPrefix}I withdraw this finding.`),
  );
  assert.equal(conceded.disposition, "bot_conceded");
  assert.equal(
    conceded.botConcessionEvidence[0].dispositionSignal,
    "I withdraw this finding",
  );
  assert.equal(
    conceded.botConcessionEvidence[0].excerpt.includes("withdraw"),
    false,
  );

  const restored = summarizeRoot(
    botReply(423, "I withdraw this finding."),
    botReply(424, `${longPrefix}I stand by this finding.`),
  );
  assert.equal(restored.disposition, "unknown");
  assert.equal(
    restored.botRestorationEvidence[0].dispositionSignal,
    "I stand by this finding",
  );
  assert.equal(
    restored.botRestorationEvidence[0].excerpt.includes("stand by"),
    false,
  );
});

test("uses review state and negation-safe text for submission findings", () => {
  const value = structuredClone(fixture);
  value.reviews.push(
    {
      id: 202,
      state: "CHANGES_REQUESTED",
      user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
      body: "",
    },
    {
      id: 203,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No changes requested.",
    },
    {
      id: 204,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No high severity findings.",
    },
    {
      id: 205,
      state: "COMMENTED",
      user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
      body: "No changes requested. Changes requested for the parser.",
    },
  );
  const summary = summarizeFixture(value);
  assert.equal(
    summary.evidence.byBot.codex.surfaces.review_submissions.findings,
    2,
  );
  assert.equal(summary.evidence.byBot.codex.dispositions.unknown, 2);
  assert.equal(
    summary.evidence.byBot.claude.surfaces.review_submissions.findings,
    0,
  );
});

test("keeps coordinated severity negations scoped to their clause", () => {
  const value = structuredClone(fixture);
  value.reviews.push(
    {
      id: 207,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No critical, high, or medium severity findings.",
    },
    {
      id: 208,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No high severity finding, but a medium severity finding remains.",
    },
  );

  const records = summarizeFixture(
    value,
  ).evidence.byBot.claude.surfaces.review_submissions.evidence.filter(
    ({ id }) => id === "207" || id === "208",
  );
  assert.deepEqual(
    records.map(({ id, finding, findingSignal }) => ({
      id,
      finding,
      findingSignal: findingSignal ?? null,
    })),
    [
      { id: "207", finding: false, findingSignal: null },
      { id: "208", finding: true, findingSignal: "medium severity" },
    ],
  );
});

test("recognizes contracted and equivalent clause negations", () => {
  const value = structuredClone(fixture);
  value.reviews.push(
    {
      id: 209,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Didn't find any high severity findings.",
    },
    {
      id: 210,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Never found changes requested in this review.",
    },
    {
      id: 211,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None were medium severity findings.",
    },
    {
      id: 212,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Neither critical nor low severity findings remain.",
    },
    {
      id: 213,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Didn't find high severity findings, but a medium severity finding remains.",
    },
    {
      id: 214,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None were high severity findings. Changes requested for the parser.",
    },
    {
      id: 215,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "There aren’t any low severity findings.",
    },
  );

  const records = summarizeFixture(
    value,
  ).evidence.byBot.claude.surfaces.review_submissions.evidence.filter(
    ({ id }) => Number(id) >= 209 && Number(id) <= 215,
  );
  assert.deepEqual(
    records.map(({ id, finding, findingSignal }) => ({
      id,
      finding,
      findingSignal: findingSignal ?? null,
    })),
    [
      { id: "209", finding: false, findingSignal: null },
      { id: "210", finding: false, findingSignal: null },
      { id: "211", finding: false, findingSignal: null },
      { id: "212", finding: false, findingSignal: null },
      { id: "213", finding: true, findingSignal: "medium severity" },
      { id: "214", finding: true, findingSignal: "Changes requested" },
      { id: "215", finding: false, findingSignal: null },
    ],
  );
});

test("uses complete clauses for suffix negation and although contrasts", () => {
  const value = structuredClone(fixture);
  value.reviews.push(
    {
      id: 216,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity findings: none.",
    },
    {
      id: 217,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No high severity finding, although a medium severity finding remains.",
    },
    {
      id: 218,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: no bounds check exists.",
    },
  );

  const records = summarizeFixture(
    value,
  ).evidence.byBot.claude.surfaces.review_submissions.evidence.filter(
    ({ id }) => id === "216" || id === "217" || id === "218",
  );
  assert.deepEqual(
    records.map(({ id, finding, findingSignal }) => ({
      id,
      finding,
      findingSignal: findingSignal ?? null,
    })),
    [
      { id: "216", finding: false, findingSignal: null },
      { id: "217", finding: true, findingSignal: "medium severity" },
      { id: "218", finding: true, findingSignal: "High severity" },
    ],
  );
});

test("applies clause-aware negation to priority badges", () => {
  const value = structuredClone(fixture);
  value.reviews.push(
    {
      id: 220,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None — no [P1]/[P2]/[P3] findings.",
    },
    {
      id: 221,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None — no [P1]/[P2]/[P3] findings. [P1] The parser still drops a valid record.",
    },
    {
      id: 222,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "[P1] No validation is performed before parsing.",
    },
    {
      id: 223,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P2 Badge: The parser still drops a valid record.",
    },
    {
      id: 224,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No P2 Badge findings.",
    },
    {
      id: 225,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P3 Badge findings: none.",
    },
  );

  const records = summarizeFixture(
    value,
  ).evidence.byBot.claude.surfaces.review_submissions.evidence.filter(
    ({ id }) => Number(id) >= 220 && Number(id) <= 225,
  );
  assert.deepEqual(
    records.map(({ id, finding, findingSignal }) => ({
      id,
      finding,
      findingSignal: findingSignal ?? null,
    })),
    [
      { id: "220", finding: false, findingSignal: null },
      { id: "221", finding: true, findingSignal: "[P1]" },
      { id: "222", finding: true, findingSignal: "[P1]" },
      { id: "223", finding: true, findingSignal: "P2 Badge" },
      { id: "224", finding: false, findingSignal: null },
      { id: "225", finding: false, findingSignal: null },
    ],
  );
});

test("treats numeric zero summaries as empty without hiding defect prose", () => {
  const value = structuredClone(fixture);
  value.reviews.push(
    {
      id: 226,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 high severity findings.",
    },
    {
      id: 227,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P2 Badge findings: 0.",
    },
    {
      id: 228,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: value 0 is rejected before validation.",
    },
    {
      id: 229,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: The parser rejects 0 as a valid value.",
    },
    {
      id: 230,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0: high severity findings.",
    },
    {
      id: 231,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 — [P1] findings.",
    },
    {
      id: 232,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 findings.",
    },
    {
      id: 233,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P2 Badge: 0 findings.",
    },
    {
      id: 234,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 [P1]/[P2]/[P3] findings.",
    },
    {
      id: 235,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "[P1]/[P2]/[P3]: 0 findings.",
    },
    {
      id: 236,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 changes requested.",
    },
    {
      id: 237,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Changes requested: 0.",
    },
    {
      id: 238,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Changes requested: field 0 is rejected.",
    },
    {
      id: 239,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "- High severity: 0 findings.",
    },
    {
      id: 240,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 [P1], [P2], and [P3] findings.",
    },
    {
      id: 241,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "[P1], [P2], and [P3]: 0 findings.",
    },
    {
      id: 242,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 high severity findings, but no medium severity findings.",
    },
    {
      id: 243,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 changes requested, but [P1] validation still fails.",
    },
    {
      id: 244,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "- **High severity:** 0 findings.",
    },
    {
      id: 245,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**P2 Badge findings: 0**.",
    },
    {
      id: 246,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0, Medium severity: 0.",
    },
    {
      id: 247,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 high severity, 0 medium severity findings.",
    },
    {
      id: 248,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 high severity findings — no changes requested.",
    },
    {
      id: 249,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: field 0 is invalid, Medium severity: 0.",
    },
    {
      id: 250,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**High severity:** value 0 is rejected.",
    },
    {
      id: 251,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "### High severity: 0 findings.",
    },
    {
      id: 252,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "> P2 Badge findings: 0.",
    },
    {
      id: 253,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 and Medium severity: 0.",
    },
    {
      id: 254,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 |",
    },
    {
      id: 255,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| 0 | P2 Badge findings |",
    },
    {
      id: 256,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | value 0 is rejected |",
    },
    {
      id: 257,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity | 0",
    },
    {
      id: 258,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 / Medium severity: 0.",
    },
    {
      id: 259,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity (0 findings).",
    },
    {
      id: 260,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: none — [P1] the parser drops valid rows.",
    },
    {
      id: 261,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Field 0 has no bounds check, causing a high severity crash.",
    },
    {
      id: 262,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 high severity findings — but no medium severity findings.",
    },
    {
      id: 263,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0, Medium severity: 1.",
    },
    {
      id: 264,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "[P1]: 0, [P2]: 1.",
    },
    {
      id: 265,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "10 high severity findings.",
    },
    {
      id: 266,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 10 findings.",
    },
    {
      id: 267,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "(0) high severity findings.",
    },
    {
      id: 268,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Finding 0: high severity parser crash.",
    },
    {
      id: 269,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 is rejected before validation.",
    },
    {
      id: 270,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: 0-byte values are rejected.",
    },
    {
      id: 271,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: none of the malformed inputs are rejected.",
    },
    {
      id: 272,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: zero records are validated.",
    },
    {
      id: 273,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 critical, high, or medium severity findings.",
    },
    {
      id: 274,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 | none |",
    },
    {
      id: 275,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No findings were high severity.",
    },
    {
      id: 276,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No findings were rated high severity.",
    },
    {
      id: 277,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None of the findings were medium severity.",
    },
    {
      id: 278,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Neither finding was low severity.",
    },
    {
      id: 279,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No critical/high/medium severity findings.",
    },
    {
      id: 280,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Neither critical/high nor medium severity findings.",
    },
    {
      id: 281,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No high severity findings, one medium severity finding.",
    },
    {
      id: 282,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity parser crash | 0 |",
    },
    {
      id: 283,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| 0 | P1 Badge parser drops rows |",
    },
    {
      id: 284,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0, parser crashes.",
    },
    {
      id: 285,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 high severity, parser crashes.",
    },
    {
      id: 286,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 — parser crashes.",
    },
    {
      id: 287,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: 0 / parser drops rows.",
    },
    {
      id: 288,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 findings |",
    },
    {
      id: 289,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| P1 Badge | zero findings |",
    },
    {
      id: 290,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0.5% of requests crash.",
    },
    {
      id: 291,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: 0, 0 critical/high/medium severity findings.",
    },
    {
      id: 292,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: 0, zero critical/high/medium severity findings.",
    },
    {
      id: 293,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 | Medium severity | 0 |",
    },
    {
      id: 294,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 | P1 Badge | 0 |",
    },
    {
      id: 295,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No issues were high severity.",
    },
    {
      id: 296,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None of the issues were medium severity.",
    },
    {
      id: 297,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No findings are of high severity.",
    },
    {
      id: 298,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No findings were considered high severity.",
    },
    {
      id: 299,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No high severity limit exists, so malformed inputs pass.",
    },
    {
      id: 300,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Zero high severity records are validated.",
    },
    {
      id: 301,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 10 |",
    },
    {
      id: 302,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Critical/high/medium severity: 0 findings.",
    },
    {
      id: 303,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: 0, one critical/high/medium severity finding.",
    },
    {
      id: 304,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "There are no high severity findings.",
    },
    {
      id: 305,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "We found no high severity issues.",
    },
    {
      id: 306,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The review found zero medium severity findings.",
    },
    {
      id: 307,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The report contains no P1 Badge findings.",
    },
    {
      id: 308,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "This has no changes requested.",
    },
    {
      id: 309,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Summary: High severity: 0 findings.",
    },
    {
      id: 310,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Findings: 0 high severity findings.",
    },
    {
      id: 311,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "We found no high severity limit, so malformed inputs pass.",
    },
    {
      id: 312,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Summary: Finding 0: high severity parser crash.",
    },
    {
      id: 313,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No P1 or P2 Badge findings.",
    },
    {
      id: 314,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Neither P1 nor P2 Badge findings remain.",
    },
    {
      id: 315,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 P1/P2/P3 Badge findings.",
    },
    {
      id: 316,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: 0, 0 P2/P3 Badge findings.",
    },
    {
      id: 317,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 | Medium severity | 1 |",
    },
    {
      id: 318,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| P1 Badge | 0 | High severity | 2 |",
    },
    {
      id: 319,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The parser cannot report a high severity error.",
    },
    {
      id: 320,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The API does not show a high severity failure.",
    },
    {
      id: 321,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The monitor does not detect a high severity crash.",
    },
    {
      id: 322,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The result does not contain a P1 Badge field.",
    },
    {
      id: 323,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The review did not find any high severity findings.",
    },
    {
      id: 324,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: no findings were found.",
    },
    {
      id: 325,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "P1 Badge: zero findings were reported.",
    },
    {
      id: 326,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity findings: none remain.",
    },
    {
      id: 327,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No high severity findings were found.",
    },
    {
      id: 328,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Zero medium severity findings were reported.",
    },
    {
      id: 329,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 issues |",
    },
    {
      id: 330,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | no issues |",
    },
    {
      id: 331,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 10 issues |",
    },
    {
      id: 332,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0, and a medium severity finding remains.",
    },
    {
      id: 333,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0 high severity findings and a medium severity finding remains.",
    },
    {
      id: 334,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | 0 | Value is rejected before validation |",
    },
    {
      id: 335,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The parser cannot report a high severity finding.",
    },
    {
      id: 336,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 — no issues found.",
    },
    {
      id: 337,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No additional high severity findings.",
    },
    {
      id: 338,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No high severity issue exists.",
    },
    {
      id: 339,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No findings rated as high severity.",
    },
    {
      id: 340,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No critical & medium severity findings.",
    },
    {
      id: 341,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity count: 0.",
    },
    {
      id: 342,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Total: 0 high severity findings.",
    },
    {
      id: 343,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 | Medium severity: 0",
    },
    {
      id: 344,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Do not report high severity findings in this review.",
    },
    {
      id: 345,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Don't flag P1 Badge findings in this report.",
    },
    {
      id: 346,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| Index | Severity | Findings |\n| 0 | High severity | 1 |",
    },
    {
      id: 347,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| Component | Severity | Findings |\n| parser | High severity | 0 |",
    },
    {
      id: 348,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| Severity | Findings | Notes |\n| High severity | 0 | parser crashes |",
    },
    {
      id: 349,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "0.0 high severity findings.",
    },
    {
      id: 350,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0.00 findings.",
    },
    {
      id: 351,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "There were no findings of high severity.",
    },
    {
      id: 352,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity findings = 0.",
    },
    {
      id: 353,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity findings totaled 0.",
    },
    {
      id: 354,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity findings count: 0.",
    },
    {
      id: 355,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "1 critical, 0 high, 0 medium severity findings.",
    },
    {
      id: 356,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "1 P1, 0 P2, 0 P3 Badge findings.",
    },
    {
      id: 357,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "This is not high severity at all.",
    },
    {
      id: 358,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No findings were high severity in this release.",
    },
    {
      id: 359,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None of the high severity findings remain.",
    },
    {
      id: 360,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The monitor does not detect a high severity defect.",
    },
    {
      id: 361,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0.01 findings.",
    },
    {
      id: 362,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "one critical, zero high, zero medium severity finding.",
    },
    {
      id: 363,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "one P1, zero P2, zero P3 Badge finding.",
    },
    {
      id: 364,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Overall, we did not find any high severity findings.",
    },
    {
      id: 365,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The issue isn’t high severity.",
    },
    {
      id: 366,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No findings have high severity.",
    },
    {
      id: 367,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Review summary: High severity: 0 findings.",
    },
    {
      id: 368,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "Counts: High severity: 0.",
    },
    {
      id: 369,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| Description | ID | Severity |\n| Parser crashes | 0 | High severity |",
    },
    {
      id: 370,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| Findings | Severity | Component |\n| 0 | High severity | parser |",
    },
    {
      id: 371,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | Medium severity |\n| 0 | 0 |",
    },
    {
      id: 372,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | Medium severity |\n| 0 | 1 |",
    },
    {
      id: 373,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: `${Array(50).fill("High severity: 0").join(", and ")} X`,
    },
    {
      id: 374,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: Array(50).fill("High severity: 0").join(", and "),
    },
    {
      id: 375,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The review did not find any of the 1 critical, 0 high, and 0 medium severity findings claimed by the analyzer.",
    },
    {
      id: 376,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "One critical, zero high, zero medium severity findings.",
    },
    {
      id: 377,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "1 critical finding, 0 high severity findings.",
    },
    {
      id: 378,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "One P1, zero P2, zero P3 Badge findings.",
    },
    {
      id: 379,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| 0 | High severity | 0 | Medium severity |",
    },
    {
      id: 380,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "- The review did not find any high severity findings.",
    },
    {
      id: 381,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "I couldn’t find any high severity findings.",
    },
    {
      id: 382,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "This is not a high severity finding.",
    },
    {
      id: 383,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No unresolved high severity findings.",
    },
    {
      id: 384,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: 0 — no action required.",
    },
    {
      id: 385,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity total: 0.",
    },
    {
      id: 386,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| Notes | Severity | Findings |\n| parser crashes | High severity | 0 |",
    },
    {
      id: 387,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | Notes |\n| --- | --- |\n| 0 | parser crashes |",
    },
    {
      id: 388,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The issues are not high severity.",
    },
    {
      id: 389,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "There are not any high severity findings.",
    },
    {
      id: 390,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "In this review, we did not find any high severity findings.",
    },
    {
      id: 391,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "one critical finding, no high severity findings.",
    },
    {
      id: 392,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "A critical finding, zero high severity findings.",
    },
    {
      id: 393,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**Findings:** 1 critical — 0 high — 0 medium severity.",
    },
    {
      id: 394,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "High severity: no `errors` are reported.",
    },
    {
      id: 395,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "`High severity`: 0 findings.",
    },
    {
      id: 396,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "The review did not find the following findings claimed by the analyzer: 1 critical, 0 high, and 0 medium severity findings.",
    },
    {
      id: 397,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "1 P1 — 0 P2 — 0 P3 Badge findings.",
    },
    {
      id: 398,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| High severity | Notes |\n| --- | --- |\n| 0 | none |",
    },
    {
      id: 399,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "| Severity | Findings | Notes |\n| --- | --- | --- |\n| High severity | 0 | none |",
    },
    {
      id: 400,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "We cannot find any high severity findings.",
    },
  );

  const records = summarizeFixture(
    value,
  ).evidence.byBot.claude.surfaces.review_submissions.evidence.filter(
    ({ id }) => Number(id) >= 226 && Number(id) <= 400,
  );
  assert.deepEqual(
    records.map(({ id, finding, findingSignal }) => ({
      id,
      finding,
      findingSignal: findingSignal ?? null,
    })),
    [
      { id: "226", finding: false, findingSignal: null },
      { id: "227", finding: false, findingSignal: null },
      { id: "228", finding: true, findingSignal: "High severity" },
      { id: "229", finding: true, findingSignal: "P1 Badge" },
      { id: "230", finding: false, findingSignal: null },
      { id: "231", finding: false, findingSignal: null },
      { id: "232", finding: false, findingSignal: null },
      { id: "233", finding: false, findingSignal: null },
      { id: "234", finding: false, findingSignal: null },
      { id: "235", finding: false, findingSignal: null },
      { id: "236", finding: false, findingSignal: null },
      { id: "237", finding: false, findingSignal: null },
      { id: "238", finding: true, findingSignal: "Changes requested" },
      { id: "239", finding: false, findingSignal: null },
      { id: "240", finding: false, findingSignal: null },
      { id: "241", finding: false, findingSignal: null },
      { id: "242", finding: false, findingSignal: null },
      { id: "243", finding: true, findingSignal: "[P1]" },
      { id: "244", finding: false, findingSignal: null },
      { id: "245", finding: false, findingSignal: null },
      { id: "246", finding: false, findingSignal: null },
      { id: "247", finding: false, findingSignal: null },
      { id: "248", finding: false, findingSignal: null },
      { id: "249", finding: true, findingSignal: "High severity" },
      { id: "250", finding: true, findingSignal: "High severity" },
      { id: "251", finding: false, findingSignal: null },
      { id: "252", finding: false, findingSignal: null },
      { id: "253", finding: false, findingSignal: null },
      { id: "254", finding: false, findingSignal: null },
      { id: "255", finding: false, findingSignal: null },
      { id: "256", finding: true, findingSignal: "High severity" },
      { id: "257", finding: false, findingSignal: null },
      { id: "258", finding: false, findingSignal: null },
      { id: "259", finding: false, findingSignal: null },
      { id: "260", finding: true, findingSignal: "[P1]" },
      { id: "261", finding: true, findingSignal: "high severity" },
      { id: "262", finding: false, findingSignal: null },
      { id: "263", finding: true, findingSignal: "Medium severity" },
      { id: "264", finding: true, findingSignal: "[P2]" },
      { id: "265", finding: true, findingSignal: "high severity" },
      { id: "266", finding: true, findingSignal: "High severity" },
      { id: "267", finding: false, findingSignal: null },
      { id: "268", finding: true, findingSignal: "high severity" },
      { id: "269", finding: true, findingSignal: "High severity" },
      { id: "270", finding: true, findingSignal: "P1 Badge" },
      { id: "271", finding: true, findingSignal: "High severity" },
      { id: "272", finding: true, findingSignal: "High severity" },
      { id: "273", finding: false, findingSignal: null },
      { id: "274", finding: false, findingSignal: null },
      { id: "275", finding: false, findingSignal: null },
      { id: "276", finding: false, findingSignal: null },
      { id: "277", finding: false, findingSignal: null },
      { id: "278", finding: false, findingSignal: null },
      { id: "279", finding: false, findingSignal: null },
      { id: "280", finding: false, findingSignal: null },
      { id: "281", finding: true, findingSignal: "medium severity" },
      { id: "282", finding: true, findingSignal: "High severity" },
      { id: "283", finding: true, findingSignal: "P1 Badge" },
      { id: "284", finding: true, findingSignal: "High severity" },
      { id: "285", finding: true, findingSignal: "high severity" },
      { id: "286", finding: true, findingSignal: "High severity" },
      { id: "287", finding: true, findingSignal: "P1 Badge" },
      { id: "288", finding: false, findingSignal: null },
      { id: "289", finding: false, findingSignal: null },
      { id: "290", finding: true, findingSignal: "High severity" },
      { id: "291", finding: false, findingSignal: null },
      { id: "292", finding: false, findingSignal: null },
      { id: "293", finding: false, findingSignal: null },
      { id: "294", finding: false, findingSignal: null },
      { id: "295", finding: false, findingSignal: null },
      { id: "296", finding: false, findingSignal: null },
      { id: "297", finding: false, findingSignal: null },
      { id: "298", finding: false, findingSignal: null },
      { id: "299", finding: true, findingSignal: "high severity" },
      { id: "300", finding: true, findingSignal: "high severity" },
      { id: "301", finding: true, findingSignal: "High severity" },
      { id: "302", finding: false, findingSignal: null },
      { id: "303", finding: true, findingSignal: "medium severity" },
      { id: "304", finding: false, findingSignal: null },
      { id: "305", finding: false, findingSignal: null },
      { id: "306", finding: false, findingSignal: null },
      { id: "307", finding: false, findingSignal: null },
      { id: "308", finding: false, findingSignal: null },
      { id: "309", finding: false, findingSignal: null },
      { id: "310", finding: false, findingSignal: null },
      { id: "311", finding: true, findingSignal: "high severity" },
      { id: "312", finding: true, findingSignal: "high severity" },
      { id: "313", finding: false, findingSignal: null },
      { id: "314", finding: false, findingSignal: null },
      { id: "315", finding: false, findingSignal: null },
      { id: "316", finding: false, findingSignal: null },
      { id: "317", finding: true, findingSignal: "Medium severity" },
      { id: "318", finding: true, findingSignal: "High severity" },
      { id: "319", finding: true, findingSignal: "high severity" },
      { id: "320", finding: true, findingSignal: "high severity" },
      { id: "321", finding: true, findingSignal: "high severity" },
      { id: "322", finding: true, findingSignal: "P1 Badge" },
      { id: "323", finding: false, findingSignal: null },
      { id: "324", finding: false, findingSignal: null },
      { id: "325", finding: false, findingSignal: null },
      { id: "326", finding: false, findingSignal: null },
      { id: "327", finding: false, findingSignal: null },
      { id: "328", finding: false, findingSignal: null },
      { id: "329", finding: false, findingSignal: null },
      { id: "330", finding: false, findingSignal: null },
      { id: "331", finding: true, findingSignal: "High severity" },
      { id: "332", finding: true, findingSignal: "medium severity" },
      { id: "333", finding: true, findingSignal: "medium severity" },
      { id: "334", finding: true, findingSignal: "High severity" },
      { id: "335", finding: true, findingSignal: "high severity" },
      { id: "336", finding: false, findingSignal: null },
      { id: "337", finding: false, findingSignal: null },
      { id: "338", finding: false, findingSignal: null },
      { id: "339", finding: false, findingSignal: null },
      { id: "340", finding: false, findingSignal: null },
      { id: "341", finding: false, findingSignal: null },
      { id: "342", finding: false, findingSignal: null },
      { id: "343", finding: false, findingSignal: null },
      { id: "344", finding: true, findingSignal: "high severity" },
      { id: "345", finding: true, findingSignal: "P1 Badge" },
      { id: "346", finding: true, findingSignal: "High severity" },
      { id: "347", finding: false, findingSignal: null },
      { id: "348", finding: true, findingSignal: "High severity" },
      { id: "349", finding: false, findingSignal: null },
      { id: "350", finding: false, findingSignal: null },
      { id: "351", finding: false, findingSignal: null },
      { id: "352", finding: false, findingSignal: null },
      { id: "353", finding: false, findingSignal: null },
      { id: "354", finding: false, findingSignal: null },
      { id: "355", finding: true, findingSignal: "critical" },
      { id: "356", finding: true, findingSignal: "P1" },
      { id: "357", finding: false, findingSignal: null },
      { id: "358", finding: false, findingSignal: null },
      { id: "359", finding: false, findingSignal: null },
      { id: "360", finding: true, findingSignal: "high severity" },
      { id: "361", finding: true, findingSignal: "High severity" },
      { id: "362", finding: true, findingSignal: "critical" },
      { id: "363", finding: true, findingSignal: "P1" },
      { id: "364", finding: false, findingSignal: null },
      { id: "365", finding: false, findingSignal: null },
      { id: "366", finding: false, findingSignal: null },
      { id: "367", finding: false, findingSignal: null },
      { id: "368", finding: false, findingSignal: null },
      { id: "369", finding: true, findingSignal: "High severity" },
      { id: "370", finding: false, findingSignal: null },
      { id: "371", finding: false, findingSignal: null },
      { id: "372", finding: true, findingSignal: "Medium severity" },
      { id: "373", finding: true, findingSignal: "High severity" },
      { id: "374", finding: false, findingSignal: null },
      { id: "375", finding: false, findingSignal: null },
      { id: "376", finding: true, findingSignal: "critical" },
      { id: "377", finding: true, findingSignal: "critical" },
      { id: "378", finding: true, findingSignal: "P1" },
      { id: "379", finding: false, findingSignal: null },
      { id: "380", finding: false, findingSignal: null },
      { id: "381", finding: false, findingSignal: null },
      { id: "382", finding: false, findingSignal: null },
      { id: "383", finding: false, findingSignal: null },
      { id: "384", finding: false, findingSignal: null },
      { id: "385", finding: false, findingSignal: null },
      { id: "386", finding: true, findingSignal: "High severity" },
      { id: "387", finding: true, findingSignal: "High severity" },
      { id: "388", finding: false, findingSignal: null },
      { id: "389", finding: false, findingSignal: null },
      { id: "390", finding: false, findingSignal: null },
      { id: "391", finding: true, findingSignal: "critical" },
      { id: "392", finding: true, findingSignal: "critical" },
      { id: "393", finding: true, findingSignal: "critical" },
      { id: "394", finding: true, findingSignal: "High severity" },
      { id: "395", finding: false, findingSignal: null },
      { id: "396", finding: false, findingSignal: null },
      { id: "397", finding: true, findingSignal: "P1" },
      { id: "398", finding: false, findingSignal: null },
      { id: "399", finding: false, findingSignal: null },
      { id: "400", finding: false, findingSignal: null },
    ],
  );
});

test("classifies observed coordinated priority negations", () => {
  const value = structuredClone(fixture);
  value.reviews = [
    {
      id: 401,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No inline findings — nothing rose to [P1]/[P2]/[P3].",
    },
    {
      id: 402,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "No inline comments were posted — I did not find any concrete correctness, security, or convention findings tied to a specific line worth flagging at [P1]/[P2].",
    },
    {
      id: 403,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "None at [P1] or [P2]. One [P3] observation.",
    },
    {
      id: 404,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "1. **[P3]** None.",
    },
    {
      id: 405,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**[P3] No issues found — verified correctness.**",
    },
    {
      id: 406,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "`[P3]` None.",
    },
    {
      id: 407,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**None at [P1]/[P2]. One [P3] observation.**",
    },
    {
      id: 408,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**[P1] The parser still drops a valid record.**",
    },
    {
      id: 409,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**[P3] None of the inputs are validated.**",
    },
    {
      id: 410,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: [
        "### Findings",
        "1. **[P3] No issues found — verified correctness of the argv construction.**",
        "2. **[P3] Comment/prose update in `review-eval-score.mjs:257-260` is accurate.**",
        "3. **No drift found.**",
      ].join("\n\n"),
    },
    {
      id: 411,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**[P3] Comment/prose update in `review-eval-score.mjs:257-260` is inaccurate.**",
    },
    {
      id: 412,
      state: "COMMENTED",
      user: { login: "claude[bot]", type: "Bot" },
      body: "**[P3] Documentation update omits the fallback when TMPDIR is correct.**",
    },
  ];

  const records =
    summarizeFixture(value).evidence.byBot.claude.surfaces.review_submissions
      .evidence;
  assert.deepEqual(
    records.map(({ id, finding, findingSignal }) => ({
      id,
      finding,
      findingSignal: findingSignal ?? null,
    })),
    [
      { id: "401", finding: false, findingSignal: null },
      { id: "402", finding: false, findingSignal: null },
      { id: "403", finding: true, findingSignal: "[P3]" },
      { id: "404", finding: false, findingSignal: null },
      { id: "405", finding: false, findingSignal: null },
      { id: "406", finding: false, findingSignal: null },
      { id: "407", finding: true, findingSignal: "[P3]" },
      { id: "408", finding: true, findingSignal: "[P1]" },
      { id: "409", finding: true, findingSignal: "[P3]" },
      { id: "410", finding: false, findingSignal: null },
      { id: "411", finding: true, findingSignal: "[P3]" },
      { id: "412", finding: true, findingSignal: "[P3]" },
    ],
  );
});

test("attributes only canonical Claude GitHub Actions reviews", () => {
  const value = structuredClone(fixture);
  value.issueComments = [
    {
      id: 404,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: [
        "**Claude finished @maintainer's task in 2m 0s** —— [View job](https://github.com/example/repo/actions/runs/123456)",
        "### Claude finished the review",
        "[P2] Preserve the exact-head boundary.",
      ].join("\n\n"),
    },
    {
      id: 405,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: "### Claude finished the review\n[P1] Unrelated workflow output.",
    },
    {
      id: 406,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: "**Claude finished @maintainer's task**\n[P1] Missing the action run link.",
    },
    {
      id: 407,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: [
        "**Claude finished @maintainer's task in 2m 0s** —— [View job](https://github.com/other/repository/actions/runs/123456)",
        "### Review: completed",
        "[P1] This run belongs to another repository.",
      ].join("\n\n"),
    },
  ];

  const summary = summarizeFixture(value);
  assert.deepEqual(
    summary.evidence.byBot.claude.surfaces.issue_comments.evidence.map(
      ({ id, finding, findingSignal }) => ({ id, finding, findingSignal }),
    ),
    [{ id: "404", finding: true, findingSignal: "[P2]" }],
  );
  assert.equal(summary.botReviewSignals.claudeSummaryComments, 1);
  assert.equal(summary.botReviewSignals.topLevelReviewBotComments, 1);
});

test("trusts request authors and proves exact-head markers from the timeline", () => {
  const value = structuredClone(fixture);
  const request = (id, login, head, authorAssociation = "NONE") => {
    const timestamp = `2026-08-01T10:${id - 81}:00Z`;
    return {
      id,
      node_id: `IC_fixture_${id}`,
      created_at: timestamp,
      updated_at: timestamp,
      author_association: authorAssociation,
      user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
      body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${head} -->`,
    };
  };
  const requests = [
    request(108, "outsider", "a".repeat(40)),
    request(109, "maintainer", "c".repeat(40), "OWNER"),
    request(110, "claude[bot]", "a".repeat(40)),
    request(111, "unknown-automation[bot]", "a".repeat(40)),
    request(112, "outside-pr-author", "a".repeat(40)),
  ];
  value.issueComments.push(...requests);
  value.timeline.push(
    ...requests.map((comment) => ({
      event: "commented",
      id: comment.id,
      node_id: comment.node_id,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    })),
  );
  value.pr.user.login = "outside-pr-author";
  const manual = summarizeFixture(value).evidence.signals.manualRequests;
  assert.equal(manual.count, 4);
  assert.equal(manual.markedExactHead, 2);
  assert.equal(manual.bare, 1);
  assert.equal(manual.unknown, 1);
  assert.equal(manual.rejectedCount, 3);
  assert.deepEqual(
    manual.rejectedEvidence.map(({ author, rejectedReason }) => ({
      author,
      rejectedReason,
    })),
    ["outsider", "unknown-automation[bot]", "outside-pr-author"].map(
      (author) => ({
        author,
        rejectedReason: "request_author_is_not_trusted",
      }),
    ),
  );
});

test("binds exact-head markers to the effective head at comment time", () => {
  const value = structuredClone(fixture);
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const headC = "c".repeat(40);
  const request = (id, head, createdAt, updatedAt = createdAt) => ({
    id,
    node_id: `IC_timeline_${id}`,
    created_at: createdAt,
    updated_at: updatedAt,
    author_association: "OWNER",
    user: { login: "maintainer", type: "User" },
    body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${head} -->`,
  });
  const intermediate = request(130, headA, "2026-08-01T10:10:00Z");
  const stale = request(131, headA, "2026-08-01T10:20:00Z");
  const forcePushed = request(132, headC, "2026-08-01T10:22:00Z");
  const edited = request(
    133,
    headB,
    "2026-08-01T10:30:00Z",
    "2026-08-01T10:31:00Z",
  );
  const absent = request(134, headB, "2026-08-01T10:32:00Z");
  value.pr.head.sha = headB;
  value.commits = [headA, headB, headC].map((sha) => ({ sha }));
  value.issueComments = [intermediate, stale, forcePushed, edited, absent];
  value.timeline = [
    { event: "committed", node_id: "C_timeline_a", sha: headA },
    {
      event: "commented",
      id: intermediate.id,
      node_id: intermediate.node_id,
      created_at: intermediate.created_at,
      updated_at: intermediate.updated_at,
    },
    { event: "committed", node_id: "C_timeline_b1", sha: headB },
    {
      event: "commented",
      id: stale.id,
      node_id: stale.node_id,
      created_at: stale.created_at,
      updated_at: stale.updated_at,
    },
    {
      event: "head_ref_force_pushed",
      node_id: "FP_timeline_c",
      commit_id: headC,
      created_at: "2026-08-01T10:21:00Z",
      force_push_proof: {
        kind: "graphql",
        nodeId: "FP_timeline_c",
        createdAt: "2026-08-01T10:21:00Z",
        beforeHead: headB,
        afterHead: headC,
      },
    },
    {
      event: "commented",
      id: forcePushed.id,
      node_id: forcePushed.node_id,
      created_at: forcePushed.created_at,
      updated_at: forcePushed.updated_at,
    },
    { event: "committed", node_id: "C_timeline_b2", sha: headB },
    {
      event: "commented",
      id: edited.id,
      node_id: edited.node_id,
      created_at: edited.created_at,
      updated_at: edited.updated_at,
    },
  ];

  const manual = summarizeFixture(value).evidence.signals.manualRequests;
  assert.equal(manual.markedExactHead, 2);
  assert.equal(manual.unknown, 3);
  assert.deepEqual(
    manual.evidence.map(
      ({
        marker,
        markerReason,
        head,
        effectiveHead,
        timelineCommentIndex,
      }) => ({
        marker,
        markerReason,
        head,
        effectiveHead,
        timelineCommentIndex,
      }),
    ),
    [
      {
        marker: "marked_exact_head",
        markerReason: null,
        head: headA,
        effectiveHead: headA,
        timelineCommentIndex: 1,
      },
      {
        marker: "unknown",
        markerReason: "marker_was_not_effective_head_at_request",
        head: headA,
        effectiveHead: headB,
        timelineCommentIndex: 3,
      },
      {
        marker: "marked_exact_head",
        markerReason: null,
        head: headC,
        effectiveHead: headC,
        timelineCommentIndex: 5,
      },
      {
        marker: "unknown",
        markerReason: "request_comment_was_edited",
        head: headB,
        effectiveHead: null,
        timelineCommentIndex: 7,
      },
      {
        marker: "unknown",
        markerReason: "timeline_comment_not_found",
        head: headB,
        effectiveHead: null,
        timelineCommentIndex: null,
      },
    ],
  );
});

test("proves exact heads before and after an enriched force push", () => {
  const value = structuredClone(fixture);
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const request = (id, head, createdAt) => ({
    id,
    node_id: `IC_force_${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: "OWNER",
    user: { login: "maintainer", type: "User" },
    body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${head} -->`,
  });
  const before = request(140, headA, "2026-08-01T10:10:00Z");
  const after = request(141, headB, "2026-08-01T10:12:00Z");
  const forcePush = enrichTimelineForcePushes(
    [
      {
        event: "head_ref_force_pushed",
        node_id: "FP_between_requests",
        created_at: "2026-08-01T10:11:00Z",
      },
    ],
    [
      {
        nodeId: "FP_between_requests",
        createdAt: "2026-08-01T10:11:00Z",
        beforeHead: headA,
        afterHead: headB,
      },
    ],
  ).items[0];
  value.pr.head.sha = headB;
  value.commits = [{ sha: headB }];
  value.issueComments = [before, after];
  value.timeline = [
    { event: "committed", node_id: "C_before_force", sha: headA },
    {
      event: "commented",
      id: before.id,
      node_id: before.node_id,
      created_at: before.created_at,
      updated_at: before.updated_at,
    },
    { event: "committed", node_id: "C_after_force", sha: headB },
    forcePush,
    {
      event: "commented",
      id: after.id,
      node_id: after.node_id,
      created_at: after.created_at,
      updated_at: after.updated_at,
    },
  ];

  const manual = summarizeFixture(value).evidence.signals.manualRequests;
  assert.equal(manual.markedExactHead, 2);
  assert.deepEqual(
    manual.evidence.map(({ head, effectiveHead, markerReason }) => ({
      head,
      effectiveHead,
      markerReason,
    })),
    [
      { head: headA, effectiveHead: headA, markerReason: null },
      { head: headB, effectiveHead: headB, markerReason: null },
    ],
  );
});

test("restores the last proven head after head ref deletion", () => {
  const value = structuredClone(fixture);
  const head = "a".repeat(40);
  const request = (id, createdAt) => ({
    id,
    node_id: `IC_restore_${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: "OWNER",
    user: { login: "maintainer", type: "User" },
    body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${head} -->`,
  });
  const whileDeleted = request(142, "2026-08-01T10:12:00Z");
  const afterRestore = request(143, "2026-08-01T10:14:00Z");
  value.issueComments = [whileDeleted, afterRestore];
  value.timeline = [
    { event: "committed", node_id: "C_restore", sha: head },
    {
      event: "head_ref_deleted",
      node_id: "HD_restore",
      created_at: "2026-08-01T10:11:00Z",
    },
    {
      event: "commented",
      id: whileDeleted.id,
      node_id: whileDeleted.node_id,
      created_at: whileDeleted.created_at,
      updated_at: whileDeleted.updated_at,
    },
    {
      event: "head_ref_restored",
      node_id: "HR_restore",
      created_at: "2026-08-01T10:13:00Z",
    },
    {
      event: "commented",
      id: afterRestore.id,
      node_id: afterRestore.node_id,
      created_at: afterRestore.created_at,
      updated_at: afterRestore.updated_at,
    },
  ];

  const manual = summarizeFixture(value).evidence.signals.manualRequests;
  assert.deepEqual(
    manual.evidence.map(({ marker, markerReason, effectiveHead }) => ({
      marker,
      markerReason,
      effectiveHead,
    })),
    [
      {
        marker: "unknown",
        markerReason: "timeline_head_ref_is_deleted",
        effectiveHead: null,
      },
      {
        marker: "marked_exact_head",
        markerReason: null,
        effectiveHead: head,
      },
    ],
  );
});

test("fails exact-head proof closed on missing or conflicting enrichment", () => {
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const summarize = (forcePush) => {
    const value = structuredClone(fixture);
    const request = {
      id: 144,
      node_id: "IC_unproven_force",
      created_at: "2026-08-01T10:12:00Z",
      updated_at: "2026-08-01T10:12:00Z",
      author_association: "OWNER",
      user: { login: "maintainer", type: "User" },
      body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${headB} -->`,
    };
    value.pr.head.sha = headB;
    value.commits = [{ sha: headA }, { sha: headB }];
    value.issueComments = [request];
    value.timeline = [
      forcePush,
      {
        event: "commented",
        id: request.id,
        node_id: request.node_id,
        created_at: request.created_at,
        updated_at: request.updated_at,
      },
    ];
    return summarizeFixture(value).evidence.signals.manualRequests.evidence[0];
  };
  const base = {
    event: "head_ref_force_pushed",
    node_id: "FP_unproven",
    created_at: "2026-08-01T10:11:00Z",
  };
  assert.deepEqual(
    {
      marker: summarize(base).marker,
      reason: summarize(base).markerReason,
    },
    {
      marker: "unknown",
      reason: "timeline_force_push_enrichment_missing",
    },
  );
  const conflicting = {
    ...base,
    force_push_proof: {
      kind: "graphql",
      nodeId: "FP_different",
      createdAt: base.created_at,
      beforeHead: headA,
      afterHead: headB,
    },
  };
  const conflictResult = summarize(conflicting);
  assert.equal(conflictResult.marker, "unknown");
  assert.equal(
    conflictResult.markerReason,
    "timeline_force_push_enrichment_conflicts",
  );
});

test("fails closed when a later timeline item predates the marker comment", () => {
  const value = structuredClone(fixture);
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const request = {
    id: 145,
    node_id: "IC_force_order_conflict",
    created_at: "2026-08-01T10:12:00Z",
    updated_at: "2026-08-01T10:12:00Z",
    author_association: "OWNER",
    user: { login: "maintainer", type: "User" },
    body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${headA} -->`,
  };
  value.pr.head.sha = headB;
  value.commits = [{ sha: headA }, { sha: headB }];
  value.issueComments = [request];
  value.timeline = [
    {
      event: "commented",
      id: request.id,
      node_id: request.node_id,
      created_at: request.created_at,
      updated_at: request.updated_at,
    },
    {
      event: "head_ref_force_pushed",
      node_id: "FP_force_order_conflict",
      created_at: "2026-08-01T10:11:00Z",
      force_push_proof: {
        kind: "graphql",
        nodeId: "FP_force_order_conflict",
        createdAt: "2026-08-01T10:11:00Z",
        beforeHead: headA,
        afterHead: headB,
      },
    },
  ];

  const evidence =
    summarizeFixture(value).evidence.signals.manualRequests.evidence[0];
  assert.equal(evidence.marker, "unknown");
  assert.equal(
    evidence.markerReason,
    "timeline_order_conflicts_with_force_push_timestamp",
  );
  assert.equal(evidence.effectiveHead, null);
});

test("does not infer a marker head from a later force push", () => {
  const value = structuredClone(fixture);
  const headA = "a".repeat(40);
  const headB = "b".repeat(40);
  const request = {
    id: 146,
    node_id: "IC_before_future_force",
    created_at: "2026-08-01T10:10:00Z",
    updated_at: "2026-08-01T10:10:00Z",
    author_association: "OWNER",
    user: { login: "maintainer", type: "User" },
    body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${headA} -->`,
  };
  value.pr.head.sha = headB;
  value.commits = [{ sha: headA }, { sha: headB }];
  value.issueComments = [request];
  value.timeline = [
    {
      event: "commented",
      id: request.id,
      node_id: request.node_id,
      created_at: request.created_at,
      updated_at: request.updated_at,
    },
    {
      event: "head_ref_force_pushed",
      node_id: "FP_after_marker",
      created_at: "2026-08-01T10:12:00Z",
      force_push_proof: {
        kind: "graphql",
        nodeId: "FP_after_marker",
        createdAt: "2026-08-01T10:12:00Z",
        beforeHead: headA,
        afterHead: headB,
      },
    },
  ];

  const evidence =
    summarizeFixture(value).evidence.signals.manualRequests.evidence[0];
  assert.equal(evidence.marker, "unknown");
  assert.equal(evidence.markerReason, "timeline_head_not_established");
  assert.equal(evidence.effectiveHead, null);
});

test("counts each distinct review target requested by one trusted comment", () => {
  const value = structuredClone(fixture);
  value.issueComments = [
    {
      id: 113,
      author_association: "OWNER",
      user: { login: "maintainer", type: "User" },
      body: "@coderabbitai review\n@codex review\n@codex review",
    },
  ];

  const manual = summarizeFixture(value).evidence.signals.manualRequests;
  assert.equal(manual.count, 2);
  assert.deepEqual(
    manual.evidence.map(({ target }) => target),
    ["coderabbit", "codex"],
  );
  assert.equal(manual.bare, 2);
});

test("rejects mixed, duplicate, and distinct exact-head markers", () => {
  const value = structuredClone(fixture);
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const marker = (head) => `<!-- coderabbit-final-head-review:${head} -->`;
  value.issueComments = [
    `${marker(a)}\n<!-- coderabbit-final-head-review:deadbee -->`,
    `${marker(a)}\n${marker(a)}`,
    `${marker(a)}\n${marker(b)}`,
  ].map((markers, index) => ({
    id: 120 + index,
    author_association: "OWNER",
    user: { login: "maintainer", type: "User" },
    body: `@coderabbitai review\n\n${markers}`,
  }));
  const manual = summarizeFixture(value).evidence.signals.manualRequests;
  assert.equal(manual.count, 3);
  assert.equal(manual.unknown, 3);
  assert.ok(
    manual.evidence.every(
      ({ markerReason }) => markerReason === "malformed_head_marker",
    ),
  );
});

test("rejects schema-v2 summaries without complete pagination evidence", () => {
  assert.throws(
    () =>
      summarizePullRequestMetricsV2({
        ...fixture,
        pagination: {
          issueComments: { complete: true },
          reviewSubmissions: { complete: true },
          reviewComments: { complete: true },
          timeline: { complete: false },
          commits: { complete: true },
        },
      }),
    /require complete pagination evidence/,
  );
  assert.throws(
    () =>
      summarizePullRequestMetricsV2({
        ...fixture,
        pagination: {
          issueComments: { complete: true },
          reviewSubmissions: { complete: true },
          reviewComments: { complete: true },
          timeline: {
            complete: true,
            forcePushGraphql: { complete: false },
          },
          commits: { complete: true },
        },
      }),
    /require complete pagination evidence/,
  );
});

test("emits schema v2 without rewriting schema-v1 inputs", () => {
  const pullRequest = summarizeFixture();
  const args = parseArgs(["--prs", "42"]);
  const report = buildReport({
    args,
    cohort: { mode: "explicit" },
    pullRequests: [pullRequest],
    collectedAt: "2026-08-01T12:01:00Z",
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.collection.complete, true);
  assert.deepEqual(report.classification.categories, [
    "fixed",
    "wont_fix",
    "bot_conceded",
    "unclassified",
    "unknown",
  ]);
  assert.equal(aggregateMetricsV2([pullRequest]).pullRequests, 1);
});

test("scopes exact-head request deduplication to each pull request", () => {
  const first = summarizeFixture();
  const secondValue = structuredClone(fixture);
  secondValue.pr.number = 43;
  secondValue.pr.html_url = "https://github.com/example/repo/pull/43";
  const second = summarizeFixture(secondValue);

  const acrossPullRequests = aggregateMetricsV2([first, second]).evidence
    .signals.manualRequests;
  assert.equal(acrossPullRequests.markedExactHead, 2);
  assert.equal(acrossPullRequests.uniqueExactHeads, 2);
  assert.equal(acrossPullRequests.duplicateExactHeadRequests, 0);

  const duplicateValue = structuredClone(fixture);
  const duplicateRequest = {
    ...structuredClone(duplicateValue.issueComments[5]),
    id: 108,
    node_id: "IC_fixture_108",
    created_at: "2026-08-01T10:27:00Z",
    updated_at: "2026-08-01T10:27:00Z",
  };
  duplicateValue.issueComments.push(duplicateRequest);
  duplicateValue.timeline.push({
    event: "commented",
    id: duplicateRequest.id,
    node_id: duplicateRequest.node_id,
    created_at: duplicateRequest.created_at,
    updated_at: duplicateRequest.updated_at,
  });
  const withinOnePullRequest = aggregateMetricsV2([
    summarizeFixture(duplicateValue),
  ]).evidence.signals.manualRequests;
  assert.equal(withinOnePullRequest.markedExactHead, 2);
  assert.equal(withinOnePullRequest.uniqueExactHeads, 1);
  assert.equal(withinOnePullRequest.duplicateExactHeadRequests, 1);
});

test("keeps every review-metrics source module under 600 physical lines", () => {
  const modules = [
    "review-process-metrics.mjs",
    "review-process-metrics-core.mjs",
    "review-process-metrics-finding-classifier.mjs",
    "review-process-metrics-legacy.mjs",
    "review-process-metrics-report.mjs",
    "review-process-metrics-signals.mjs",
    "review-process-metrics-timeline.mjs",
  ];
  for (const module of modules) {
    const source = readFileSync(join(SCRIPT_DIRECTORY, module), "utf8");
    const lines =
      source.split(/\r?\n/u).length - (source.endsWith("\n") ? 1 : 0);
    assert.ok(lines <= 600, `${module} has ${lines} physical lines`);
  }
});

test("creates report files exclusively with private permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-metrics-test-"));
  try {
    const existing = join(directory, "existing.json");
    writeFileSync(existing, "old\n", { mode: 0o644 });
    assert.throws(() => writeReportFile(existing, "new\n"), /EEXIST/);
    assert.equal(readFileSync(existing, "utf8"), "old\n");

    const fresh = join(directory, "fresh.json");
    writeReportFile(fresh, "{}\n");
    assert.equal(statSync(fresh).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

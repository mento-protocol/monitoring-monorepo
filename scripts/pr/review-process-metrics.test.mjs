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
  assertCompletePaginatedSurface,
  buildReport,
  isClaudeSummary,
  isCodexApprovalComment,
  isCodexUsageLimit,
  isFindingLikeText,
  isCodexBotLogin,
  isClaudeBotLogin,
  isReviewBotLogin,
  parseArgs,
  parseUtcTimestamp,
  selectMergedAfter,
  selectMergedBefore,
  selectMergedInUtcWindow,
  summarizePullRequestMetrics,
  summarizePullRequestMetricsV2,
  writeReportFile,
} from "./review-process-metrics.mjs";

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/review-process-metrics-coderabbit.json",
    ),
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
  value.issueComments.push(
    {
      id: 410,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "<!-- This is an auto-generated comment: review paused by coderabbit.ai -->\n> ## Reviews paused\n> Reviews paused due to new commits.\n**Run ID**: `22222222-2222-2222-2222-222222222222`",
    },
    {
      id: 411,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached\n**Run ID**: `33333333-3333-3333-3333-333333333333`",
    },
    {
      id: 412,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: [
        "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
        "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->",
        "",
        "> [!IMPORTANT]",
        "> ## Review skipped",
        ">",
        "> Review was skipped due to path filters",
        ">",
        "> <details>",
        "> <summary>:no_entry: Files ignored due to path filters (1)</summary>",
        ">",
        "> * `docs/evals/example.jsonl` is excluded by `!docs/evals/**`",
        ">",
        "> </details>",
        ">",
        "> <details>",
        "> <summary>Run configuration</summary>",
        ">",
        "> **Run ID**: `44444444-4444-4444-4444-444444444444`",
        ">",
        "> </details>",
        "",
        "<!-- end of auto-generated comment: skip review by coderabbit.ai -->",
      ].join("\n"),
    },
    {
      id: 413,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n> This repository does not receive automatic reviews because it has fewer than 10 stars.\n**Run ID**: `55555555-5555-5555-5555-555555555555`",
    },
    {
      id: 414,
      user: { login: "coderabbitai[bot]", type: "Bot" },
      body: "Diagnostic context only.\n**Run ID**: `66666666-6666-6666-6666-666666666666`",
    },
  );

  const signals = summarizeFixture(value).evidence.signals;
  assert.equal(signals.reviewRuns.count, 1);
  assert.deepEqual(
    signals.reviewRuns.evidence.map(({ id }) => id),
    ["101"],
  );
  assert.equal(signals.pauses.count, 2);
  assert.equal(signals.rateLimits.count, 2);
  assert.equal(signals.pathFilterSkips.count, 2);
  assert.equal(signals.freeTierNotices.count, 2);
  assert.deepEqual(
    signals.pathFilterSkips.evidence.map(({ id }) => id),
    ["104", "412"],
  );
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

test("trusts request authors and proves exact-head markers from PR history", () => {
  const value = structuredClone(fixture);
  const request = (id, login, head, authorAssociation = "NONE") => ({
    id,
    author_association: authorAssociation,
    user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
    body: `@coderabbitai review\n\n<!-- coderabbit-final-head-review:${head} -->`,
  });
  value.issueComments.push(
    request(108, "outsider", "a".repeat(40)),
    request(109, "maintainer", "c".repeat(40), "OWNER"),
    request(110, "claude[bot]", "a".repeat(40)),
    request(111, "unknown-automation[bot]", "a".repeat(40)),
    request(112, "outside-pr-author", "a".repeat(40)),
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
          reviewSubmissions: { complete: false },
          reviewComments: { complete: true },
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
  duplicateValue.issueComments.push({
    ...structuredClone(duplicateValue.issueComments[5]),
    id: 108,
  });
  const withinOnePullRequest = aggregateMetricsV2([
    summarizeFixture(duplicateValue),
  ]).evidence.signals.manualRequests;
  assert.equal(withinOnePullRequest.markedExactHead, 2);
  assert.equal(withinOnePullRequest.uniqueExactHeads, 1);
  assert.equal(withinOnePullRequest.duplicateExactHeadRequests, 1);
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

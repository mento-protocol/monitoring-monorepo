#!/usr/bin/env node
import { createHash } from "node:crypto";
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

const PR_1544_HEAD = "aab83bc74ae0585147a058d92f1f13afac7be109";
// Verbatim REST issuecomment 5060594122 from PR #1544. Keep the complete body
// frozen: the parser trusts this protocol only when every structural field
// remains valid.
const PR_1544_CLEAN_CLAUDE_REVIEW = {
  id: 5060594122,
  html_url:
    "https://github.com/mento-protocol/monitoring-monorepo/pull/1544#issuecomment-5060594122",
  created_at: "2026-07-23T16:00:49Z",
  updated_at: "2026-07-23T16:03:25Z",
  user: { login: "claude[bot]", type: "Bot" },
  body: [
    "**Claude finished @chapati23's task in 2m 19s** —— [View job](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/30023164230)",
    "",
    "---",
    "### Code Review — PR #1544",
    "",
    "- [x] Gather context (read changed files, diff)",
    "- [x] Understand the request (code review)",
    "- [x] Review `scripts/agent-quality-gate.sh` changes",
    "- [x] Review `scripts/agent-quality-gate.test.sh` changes",
    "- [x] Review `scripts/docs-navigation-eval.test.mjs` changes",
    "- [x] Review `docs/notes/agent-quality-gate-mechanics.md` changes",
    "- [x] Post findings",
    "",
    "**Overall verdict: LGTM**",
    "",
    "### Summary",
    "",
    "This closes the gap where routing-sensitive changes (any `AGENTS.md`, `README.md`, `package.json`, `docs/`, skill/command files, or workflow files) could skip the local `--check-fixtures` gate but still get caught by hosted CI. The fix reuses the existing `isRoutingSensitivePath` classifier from `scripts/docs-navigation-eval-helpers.mjs` (`scripts/agent-quality-gate.sh:429-458`) rather than re-implementing routing rules in Bash, which keeps the two systems from drifting.",
    "",
    "### Verification notes (no issues found)",
    "",
    "1. **Fail-closed behavior is correct.** The `node --input-type=module -` invocation (`scripts/agent-quality-gate.sh:430-447`) captures only stdout for the `true`/`false` result; any Node error (missing helper, import failure, thrown exception) makes the command substitution fail, hitting the `if !` branch and exiting 2 with `error: failed to classify routing-sensitive changed paths`. Node's own stderr (e.g., stack trace) still passes through for debugging since only stdout is captured. The `--input-type=module -` heredoc is single-quoted (`<<'NODE'`), so there's no shell-injection risk from changed path contents.",
    '2. **Output-contract validation is real, not decorative.** The `case ... true|false) ;; *) exit 2 ;;` guard (`scripts/agent-quality-gate.sh:452-458`) is exercised by the "missing helper" test (`scripts/agent-quality-gate.test.sh:379-394`), which copies only the `.sh` file to an isolated dir (no sibling `docs-navigation-eval-helpers.mjs`) and asserts exit code 2 + the friendly error message.',
    '3. **First-wins dedup claim checks out.** `add_command` (`scripts/agent-quality-gate.sh:562-568`) is a no-op if the command string is already queued. Since the routing-sensitive block runs *after* the per-path loop, any specialized mapping (e.g., for `scripts/docs-navigation-eval.mjs` itself, which adds `--check-fixtures` with a more specific reason) wins and the generic "routing-sensitive source changed" reason is only used when no specialized mapping already added the same command. Confirmed by `assert_occurrences 1 "- pnpm docs:navigation-eval -- --check-fixtures"` across every combination in the test file, including the new `docs/notes/agent-quality-gate-mechanics.md` case (which only has the generic reason) and the `ui-dashboard/src/app/page.tsx` negative case.',
    "4. **Freshness invalidation is wired correctly.** `scripts/docs-navigation-eval-helpers.mjs` was added to `implementation_signature()`'s hashed file list (`scripts/agent-quality-gate.sh:2474`), and the new fixture test at `scripts/agent-quality-gate.test.sh:3201-3210` confirms a change to that file busts the fresh-run stamp (trunk-count goes 4→5).",
    '5. **Test infra fix is justified, not a red herring.** The `PATH="$node_executable_dir:$PATH"` additions (`scripts/agent-quality-gate.test.sh:724-728, 772`) are necessary because those two subtests override `HOME` to an isolated tmp dir — if `node` is resolved via a version-manager shim that reads `$HOME` (nvm/volta/asdf), overriding `HOME` would break `node` resolution now that the classifier unconditionally shells out to `node` on every gate run (dry-run included). Prepending the real resolved node dir sidesteps that. The `bin/node` stub update (`scripts/agent-quality-gate.test.sh:2954-2960` and similar) correctly special-cases `--input-type=module` to exec the real node while still no-op\'ing other stubbed invocations.',
    "6. **Docs update is accurate** and matches the implemented behavior (offline, no model invocation, added once per routing-sensitive change).",
    "",
    "No P1/P2/P3 findings — implementation, tests, and docs are internally consistent and the claims in the PR description are verifiable in the diff.",
  ].join("\n"),
};

const PR_1595_HEAD = "d4bb77845e635c72b61fa56b375ec3f44b05702e";
// Verbatim REST issuecomment 5069799124 from PR #1595. This free-form LGTM
// shape is trusted only through the exact body, comment, PR, author, and head
// compatibility record; the general parser remains fail closed.
const PR_1595_CLEAN_CLAUDE_REVIEW = {
  id: 5069799124,
  html_url:
    "https://github.com/mento-protocol/monitoring-monorepo/pull/1595#issuecomment-5069799124",
  created_at: "2026-07-24T12:22:40Z",
  updated_at: "2026-07-24T12:25:30Z",
  user: { login: "claude[bot]", type: "Bot" },
  body: [
    "**Claude finished @chapati23's task in 2m 38s** —— [View job](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/30092850046)",
    "",
    "---",
    "### Claude's Review",
    "",
    "**Verdict: LGTM**",
    "",
    'Careful, well-evidenced documentation pruning. I cross-checked every disposition in the "Details" table against the repo, and each claim holds up:',
    "",
    "- Deletions of `docs/BACKLOG.md`, `docs/CODE-REVIEW-UI-DASHBOARD.md`, `docs/monad-launch-plan.md`, `docs/multichain-indexer-analysis.md`, `docs/notes/review-process-metrics.md` all had prior `archived_reason` frontmatter already marking them superseded/complete; a repo-wide grep found no dangling references left behind except the intentional tombstone.",
    "- ADR 0006 and ADR 0012 exist and back the claimed decision-preservation rationale for the two deleted analysis docs.",
    "- The `RETIRED_VERIFICATION_SOURCE_TOMBSTONES` addition in `scripts/docs-navigation-eval-helpers.mjs:40` mirrors the existing pattern for the prior `docs/PLAN-celo-mainnet-indexer.md` tombstone exactly, and the navigation fixture's two `sources_requiring_verification` entries pointing at `docs/CODE-REVIEW-UI-DASHBOARD.md` are the ones it covers.",
    '- `docs/notes/indexer-spec-followups.md`: the removed "stability-pool floor" item is legitimately shipped — `minBoldInSp`/`spHeadroom` exist across indexer handlers and dashboard code. The "ChainStat/GlobalStat" rewording to "indexer-side chain/global totals" is accurate — no such server-side entity exists; the dashboard aggregates totals client-side (`ui-dashboard/src/lib/homepage-og.ts`).',
    '- `docs/notes/file-size-watch.md`: regenerated table has 34 data rows as claimed, and `scripts/file-size-watchlist.test.mjs` has 8 tests, matching the "8/8 passed" validation line.',
    "- `docs/notes/review-process-metrics.md` deletion: the one useful standing guardrail (start a newly scoped evaluation rather than treating completed cohorts as recurring) survives in `docs/notes/quick-commands.md`; the completed-cohort evidence stays in the kept `docs/metrics/review-process-after-1045-comparison-2026-07-07.md`.",
    "- `docs/README.md` catalog table edits are consistent with all deletions/updates and stay alphabetized within `notes-plans-archive`.",
    "- `BACKLOG.md` frontmatter addition matches this repo's `AGENTS.md` rule that GitHub Issues are canonical and `BACKLOG.md` is transition storage only.",
    "",
    "**Findings roll-up**",
    "",
    "1. [P3] `docs/notes/file-size-watch.md:19-20` — the regeneration reflowed `` `node scripts/file-size-watchlist.mjs` `` across a hard line break inside the inline-code span. Renders fine, just a slightly unusual wrap; not worth a fix.",
    '2. [P3] `docs/notes/file-size-watch.md:25-26` — the removed sentence explaining what the `Delta` column means (previously: "`Delta` compares raw lines with the previous report") was' +
      "n't replaced; the column header alone is reasonably self-explanatory, so this is a very minor loss of context, not an error.",
    "",
    "No P1/P2 findings. I could not execute `node` scripts directly in this sandboxed environment (write/exec approval required beyond what's granted here), so I verified the regenerated content by static diff/grep inspection and cross-referencing source rather than re-running `file-size-watchlist.mjs`/`review-process-metrics.mjs` myself; the PR's own validation log already covers that.",
  ].join("\n"),
};

const PR_1600_HEAD = "0ff2700ecbec8d2877caeeaa91bf423cf8fdc2f0";
// Verbatim REST issuecomment 5073384440 from PR #1600. Keep this second
// free-form shape bound to its exact body, comment, PR, author, and head.
const PR_1600_CLEAN_CLAUDE_REVIEW = {
  id: 5073384440,
  html_url:
    "https://github.com/mento-protocol/monitoring-monorepo/pull/1600#issuecomment-5073384440",
  created_at: "2026-07-24T18:49:50Z",
  updated_at: "2026-07-24T18:52:25Z",
  user: { login: "claude[bot]", type: "Bot" },
  body: [
    "**Claude finished @chapati23's task in 2m 23s** —— [View job](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/30118424736)",
    "",
    "---",
    "### Review: fix(deps): patch PostCSS source-map disclosure",
    "",
    "- [x] Gather context (diff, changed files)",
    "- [x] Review lockfile/workspace overrides for correctness",
    "- [x] Check consistency across all 4 dependency roots",
    "- [x] Check for AGENTS.md / supply-chain convention compliance",
    "- [x] Post findings",
    "",
    "**Verdict: LGTM**",
    "",
    "### Summary",
    "",
    "Clean, minimal, well-scoped security patch. I verified the change across all four dependency roots (`pnpm-workspace.yaml` + `pnpm-lock.yaml` at repo root, `governance-watchdog/`, `alerts/infra/oncall-announcer/`, `alerts/infra/onchain-event-handler/`):",
    "",
    "1. Every lockfile's `postcss@` resolution now points only to `8.5.18` — grepped all four lockfiles, no `8.5.1[0-7]` or earlier entries remain (confirms the PR's claim in \"Validation\").",
    "2. The `postcss@<8.5.18: 8.5.18` override is present and correctly quoted/unquoted per each file's existing YAML convention (root quotes ranges containing `<`; the alerts roots leave them bare — pre-existing style, not introduced here).",
    "3. The `minimumReleaseAgeExclude: postcss@8.5.18` addition follows the repo's established pattern for same-day security releases that predate the 3-day (`minimumReleaseAge: 4320`) gate — same shape as the existing `next@16.2.11` / `next-auth@5.0.0-beta.32` entries added for the July 2026 Next.js patch.",
    "4. `governance-watchdog` and the two alerts functions have no `overrides` block in their own `package.json` (only in `pnpm-workspace.yaml`), so no package.json mirror was needed there — consistent with the changed-files list. `oncall-announcer` and `onchain-event-handler` correctly got the matching `package.json` override entries since those do mirror their standalone workspace config.",
    "5. No other package.json in the monorepo declares `postcss` directly — all resolutions are transitive (tailwindcss/next/vite), so 4 lockfiles is the complete surface. No ADR needed (dependency version bump, not an architecture decision); no docs/runbook drift since no command/script/env var/workflow changed.",
    "6. CI on this PR is green where completed (Supply Chain, Alerts Infra, Governance Watchdog Infra, Infra, Trunk, Bundle Size, Code Health all passed); `CI` and `Lighthouse CI` were still in progress at review time.",
    "",
    "### Findings",
    "",
    "No inline findings — nothing to flag at [P1]/[P2]/[P3].",
    "",
    "Note: automated Codex review was unavailable on this PR (usage limits reached per the bot comment above), so this pass is the only structured code review currently on the PR.",
    " ([branch](https://github.com/mento-protocol/monitoring-monorepo/tree/fix/postcss-8.5.18))",
  ].join("\n"),
};

function normalizedReadyStateForClaudeReview(
  comment,
  {
    number = 1431,
    title = "fix(deps): upgrade sharp past vulnerable libvips",
    headRefOid = PR_1431_HEAD,
    headUpdatedAt = "2026-07-22T08:29:00Z",
    reactionCreatedAt = "2026-07-22T08:31:00Z",
  } = {},
) {
  return summarizeReadyState({
    pr: {
      number,
      url: `https://github.com/mento-protocol/monitoring-monorepo/pull/${number}`,
      title,
      state: "OPEN",
      author: { login: "chapati23" },
      isDraft: false,
      headRefName: "fix/1420-sharp-035",
      headRefOid,
      headUpdatedAt,
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
        created_at: reactionCreatedAt,
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

test("accepts the frozen PR #1544 Overall-verdict Claude review", () => {
  assertEqual(PR_1544_CLEAN_CLAUDE_REVIEW.body.length, 4244);
  assertEqual(
    createHash("sha256")
      .update(PR_1544_CLEAN_CLAUDE_REVIEW.body, "utf8")
      .digest("hex"),
    "039923882eee9f880165543ef85e1ca251d84b995a78647b41c2b788d02a4885",
  );
  const normalizedReadyState = normalizedReadyStateForClaudeReview(
    PR_1544_CLEAN_CLAUDE_REVIEW,
    {
      number: 1544,
      title: "fix(tooling): validate navigation fixtures in local gate",
      headRefOid: PR_1544_HEAD,
      headUpdatedAt: "2026-07-23T15:52:22Z",
      reactionCreatedAt: "2026-07-23T16:05:00Z",
    },
  );
  const feedbackState = summarizeFeedbackState(normalizedReadyState);

  assertEqual(normalizedReadyState.ready, true);
  assertEqual(feedbackState.ready, normalizedReadyState.required.ready);
  assertEqual(feedbackState.counts.topLevelBotComments, 1);
  assertEqual(feedbackState.counts.blockingTopLevelBotComments, 0);
  assertEqual(feedbackState.counts.blockingFindings, 0);
});

test("accepts only the exact frozen PR #1595 free-form LGTM review", () => {
  assertEqual(PR_1595_CLEAN_CLAUDE_REVIEW.body.length, 3293);
  assertEqual(
    createHash("sha256")
      .update(PR_1595_CLEAN_CLAUDE_REVIEW.body, "utf8")
      .digest("hex"),
    "5d4832d96803f81363bc0842a4c1aed89e8fb526cb83834d3373aacd30c5be34",
  );
  const options = {
    number: 1595,
    title: "docs: garden notes and archive shard 1",
    headRefOid: PR_1595_HEAD,
    headUpdatedAt: "2026-07-24T12:22:17Z",
    reactionCreatedAt: "2026-07-24T12:26:00Z",
  };
  const normalizedReadyState = normalizedReadyStateForClaudeReview(
    PR_1595_CLEAN_CLAUDE_REVIEW,
    options,
  );
  const feedbackState = summarizeFeedbackState(normalizedReadyState);

  assertEqual(normalizedReadyState.ready, true);
  assertEqual(feedbackState.ready, normalizedReadyState.required.ready);
  assertEqual(feedbackState.counts.blockingTopLevelBotComments, 0);
  assertEqual(feedbackState.counts.blockingFindings, 0);

  for (const mutation of [
    {
      ...PR_1595_CLEAN_CLAUDE_REVIEW,
      id: PR_1595_CLEAN_CLAUDE_REVIEW.id + 1,
    },
    {
      ...PR_1595_CLEAN_CLAUDE_REVIEW,
      body: `${PR_1595_CLEAN_CLAUDE_REVIEW.body}\n`,
    },
  ]) {
    const mutatedReadyState = normalizedReadyStateForClaudeReview(
      mutation,
      options,
    );
    const mutatedFeedbackState = summarizeFeedbackState(mutatedReadyState);
    assertEqual(mutatedFeedbackState.ready, false);
    assertEqual(mutatedFeedbackState.counts.blockingTopLevelBotComments, 1);
  }

  const wrongHeadReadyState = normalizedReadyStateForClaudeReview(
    PR_1595_CLEAN_CLAUDE_REVIEW,
    { ...options, headRefOid: "b".repeat(40) },
  );
  const wrongHeadFeedbackState = summarizeFeedbackState(wrongHeadReadyState);
  assertEqual(wrongHeadFeedbackState.ready, false);
  assertEqual(wrongHeadFeedbackState.counts.blockingTopLevelBotComments, 1);
});

test("accepts only the exact frozen PR #1600 free-form LGTM review", () => {
  assertEqual(
    createHash("sha256")
      .update(PR_1600_CLEAN_CLAUDE_REVIEW.body, "utf8")
      .digest("hex"),
    "e0394033c85a77330e2ee53cab690a2069263c7e792ab3e443c17949bb728db4",
  );
  const options = {
    number: 1600,
    title: "fix(deps): patch PostCSS source-map disclosure",
    headRefOid: PR_1600_HEAD,
    headUpdatedAt: "2026-07-24T18:49:35Z",
    reactionCreatedAt: "2026-07-24T18:53:00Z",
  };
  const normalizedReadyState = normalizedReadyStateForClaudeReview(
    PR_1600_CLEAN_CLAUDE_REVIEW,
    options,
  );
  const feedbackState = summarizeFeedbackState(normalizedReadyState);

  assertEqual(normalizedReadyState.ready, true);
  assertEqual(feedbackState.ready, normalizedReadyState.required.ready);
  assertEqual(feedbackState.counts.blockingTopLevelBotComments, 0);
  assertEqual(feedbackState.counts.blockingFindings, 0);

  for (const mutation of [
    {
      ...PR_1600_CLEAN_CLAUDE_REVIEW,
      id: PR_1600_CLEAN_CLAUDE_REVIEW.id + 1,
    },
    {
      ...PR_1600_CLEAN_CLAUDE_REVIEW,
      body: `${PR_1600_CLEAN_CLAUDE_REVIEW.body}\n`,
    },
  ]) {
    const mutatedReadyState = normalizedReadyStateForClaudeReview(
      mutation,
      options,
    );
    const mutatedFeedbackState = summarizeFeedbackState(mutatedReadyState);
    assertEqual(mutatedFeedbackState.ready, false);
    assertEqual(mutatedFeedbackState.counts.blockingTopLevelBotComments, 1);
  }

  const wrongHeadReadyState = normalizedReadyStateForClaudeReview(
    PR_1600_CLEAN_CLAUDE_REVIEW,
    { ...options, headRefOid: "b".repeat(40) },
  );
  const wrongHeadFeedbackState = summarizeFeedbackState(wrongHeadReadyState);
  assertEqual(wrongHeadFeedbackState.ready, false);
  assertEqual(wrongHeadFeedbackState.counts.blockingTopLevelBotComments, 1);
});

test("fails closed on single-field PR #1544 Overall-verdict mutations", () => {
  const clean = PR_1544_CLEAN_CLAUDE_REVIEW.body;
  const reviewHeading = "### Code Review — PR #1544";
  const verificationHeading = "### Verification notes (no issues found)";
  const terminal =
    "No P1/P2/P3 findings — implementation, tests, and docs are internally consistent and the claims in the PR description are verifiable in the diff.";
  const replaceFirstVerificationNote = (body) =>
    clean.replace(/^1\. \*\*Fail-closed behavior is correct\.\*\*.*$/m, body);
  const options = {
    number: 1544,
    title: "fix(tooling): validate navigation fixtures in local gate",
    headRefOid: PR_1544_HEAD,
    headUpdatedAt: "2026-07-23T15:52:22Z",
    reactionCreatedAt: "2026-07-23T16:05:00Z",
  };
  const mutations = [
    ["wrong comment ID", { id: 5060594123, body: clean }],
    ["wrong author", { user: { login: "claude", type: "Bot" }, body: clean }],
    [
      "wrong PR number",
      { body: clean.replace(reviewHeading, `${reviewHeading}5`) },
    ],
    [
      "zero-padded PR number",
      { body: clean.replace(reviewHeading, "### Code Review — PR #01544") },
    ],
    [
      "changes-requested verdict",
      {
        body: clean.replace(
          "**Overall verdict: LGTM**",
          "**Overall verdict: CHANGES REQUESTED**",
        ),
      },
    ],
    [
      "mostly-LGTM verdict",
      {
        body: clean.replace(
          "**Overall verdict: LGTM**",
          "**Overall verdict: mostly LGTM**",
        ),
      },
    ],
    [
      "missing Overall-verdict marker",
      { body: clean.replace("\n**Overall verdict: LGTM**\n", "\n") },
    ],
    ["CRLF body", { body: clean.replaceAll("\n", "\r\n") }],
    [
      "missing Verification marker",
      { body: clean.replace(`\n${verificationHeading}\n`, "\n") },
    ],
    [
      "renamed Verification marker",
      {
        body: clean.replace(
          verificationHeading,
          "### Verification details (no issues found)",
        ),
      },
    ],
    ["missing terminal marker", { body: clean.replace(`\n\n${terminal}`, "") }],
    [
      "hedged terminal marker",
      { body: clean.replace(terminal, `Probably ${terminal.toLowerCase()}`) },
    ],
    [
      "hedged positive terminal evidence",
      {
        body: clean.replace(
          terminal,
          "No P1/P2/P3 findings — the implementation could be complete.",
        ),
      },
    ],
    [
      "likely terminal evidence",
      {
        body: clean.replace(
          terminal,
          "No P1/P2/P3 findings — the implementation is likely complete.",
        ),
      },
    ],
    [
      "unchecked task",
      {
        body: clean.replace(
          "- [x] Gather context (read changed files, diff)",
          "- [ ] Gather context (read changed files, diff)",
        ),
      },
    ],
    [
      "missing View-job suffix",
      {
        body: clean.replace(
          " —— [View job](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/30023164230)",
          "",
        ),
      },
    ],
    [
      "path traversal review target",
      {
        body: clean.replace(
          "Review `scripts/agent-quality-gate.sh` changes",
          "Review `../agent-quality-gate.sh` changes",
        ),
      },
    ],
    [
      "reordered checklist",
      {
        body: clean.replace(
          "- [x] Gather context (read changed files, diff)\n- [x] Understand the request (code review)",
          "- [x] Understand the request (code review)\n- [x] Gather context (read changed files, diff)",
        ),
      },
    ],
    [
      "appended actionable request",
      { body: `${clean}\n\nPlease fix the parser before merge.` },
    ],
    [
      "actionable request inside a verification note",
      {
        body: clean.replace(
          "6. **Docs update is accurate** and matches the implemented behavior (offline, no model invocation, added once per routing-sensitive change).",
          "6. **Docs update is accurate** but please fix the stale runbook before merge.",
        ),
      },
    ],
    [
      "credential leak with a positive-looking label",
      {
        body: replaceFirstVerificationNote(
          "1. **A credential leak is real.** Private signing keys are exposed.",
        ),
      },
    ],
    [
      "plaintext key logging behind a positive label",
      {
        body: replaceFirstVerificationNote(
          "1. **Authentication is correct.** Private signing keys are logged in plaintext.",
        ),
      },
    ],
    [
      "request crashes behind a positive label",
      {
        body: replaceFirstVerificationNote(
          "1. **Error handling is correct.** Every malformed request crashes the service.",
        ),
      },
    ],
    [
      "positive evidence cue cannot launder exposed keys",
      {
        body: replaceFirstVerificationNote(
          "1. **Authentication is correct.** The test confirms private signing keys are exposed.",
        ),
      },
    ],
    [
      "arbitrary unevidenced note body",
      {
        body: replaceFirstVerificationNote(
          "1. **Validation is correct.** The fallback silently drops every authorization check.",
        ),
      },
    ],
    [
      "contradictory issue remains inside a verification note",
      {
        body: clean.replace(
          "6. **Docs update is accurate** and matches the implemented behavior (offline, no model invocation, added once per routing-sensitive change).",
          "6. **Docs update is accurate** but one routing issue remains.",
        ),
      },
    ],
    [
      "identified issue inside a verification note",
      {
        body: clean.replace(
          "6. **Docs update is accurate** and matches the implemented behavior (offline, no model invocation, added once per routing-sensitive change).",
          "6. **Docs update is accurate** but I identified an issue in the runbook.",
        ),
      },
    ],
    [
      "negated positive note label",
      {
        body: clean.replace(
          "**Fail-closed behavior is correct.**",
          "**Fail-closed behavior is not correct.**",
        ),
      },
    ],
    [
      "hedged positive note label",
      {
        body: clean.replace(
          "**Fail-closed behavior is correct.**",
          "**Fail-closed behavior is likely correct.**",
        ),
      },
    ],
    [
      "injected P2 note",
      {
        body: clean.replace(
          `\n\n${terminal}`,
          `\n7. **[P2] Action required.** Restore the unsafe fallback.\n\n${terminal}`,
        ),
      },
    ],
    [
      "duplicate Summary marker",
      { body: clean.replace("### Summary", "### Summary\n\n### Summary") },
    ],
    [
      "fenced Summary prose",
      {
        body: clean.replace(
          "This closes the gap where routing-sensitive changes",
          "```text This closes the gap where routing-sensitive changes",
        ),
      },
    ],
    [
      "structural Markdown in note evidence",
      {
        body: clean.replace(
          "6. **Docs update is accurate** and matches the implemented behavior (offline, no model invocation, added once per routing-sensitive change).",
          "6. **Docs update is accurate** - The test confirms the implemented behavior.",
        ),
      },
    ],
    [
      "reordered Summary and Verification markers",
      {
        body: clean
          .replace("### Summary", "### __TEMP_HEADING__")
          .replace(verificationHeading, "### Summary")
          .replace("### __TEMP_HEADING__", verificationHeading),
      },
    ],
  ];

  for (const [label, mutation] of mutations) {
    const normalizedReadyState = normalizedReadyStateForClaudeReview(
      {
        ...PR_1544_CLEAN_CLAUDE_REVIEW,
        ...mutation,
      },
      options,
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

  const wrongHeadReadyState = normalizedReadyStateForClaudeReview(
    PR_1544_CLEAN_CLAUDE_REVIEW,
    {
      ...options,
      headRefOid: "b".repeat(40),
    },
  );
  const wrongHeadFeedbackState = summarizeFeedbackState(wrongHeadReadyState);
  assertEqual(wrongHeadReadyState.required.ready, true);
  assertEqual(wrongHeadFeedbackState.ready, false);
  assertEqual(wrongHeadFeedbackState.counts.blockingTopLevelBotComments, 1);
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
    {
      title: "docs(parser): explain Overall verdict: compatibility",
      checklist: ["Parser behavior", "Unit-test coverage"],
    },
    {
      title: "docs(parser): explain Verification notes compatibility",
      checklist: ["Parser structure", "Documentation examples"],
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

test("accepts only the bounded Claude completion View-job wrapper", () => {
  const title = "feat(auth): add secure session refresh";
  const review = structuredClaudeReview({ title });
  const completion =
    "**Claude finished @chapati23's task in 5m 0s** —— [View job](https://github.com/mento-protocol/monitoring-monorepo/actions/runs/29940793241)";
  const wrappedReview = `${completion}\n\n---\n${review}`;
  const normalizedReadyState = normalizedReadyStateForClaudeReview(
    {
      ...PR_1431_CLEAN_CLAUDE_REVIEW,
      id: 5043638390,
      body: wrappedReview,
    },
    { title },
  );
  const feedbackState = summarizeFeedbackState(normalizedReadyState);
  assertEqual(normalizedReadyState.ready, true);
  assertEqual(feedbackState.counts.blockingTopLevelBotComments, 0);

  const malformedWrappers = [
    completion.replace("https://github.com/", "https://example.invalid/"),
    completion.replace("29940793241", "not-a-run"),
    `${completion} trailing text`,
  ];
  for (const [index, malformed] of malformedWrappers.entries()) {
    const blockedReadyState = normalizedReadyStateForClaudeReview(
      {
        ...PR_1431_CLEAN_CLAUDE_REVIEW,
        id: 5043638391 + index,
        body: `${malformed}\n\n---\n${review}`,
      },
      { title },
    );
    const blockedFeedbackState = summarizeFeedbackState(blockedReadyState);
    assertEqual(blockedReadyState.required.ready, true);
    assertEqual(blockedFeedbackState.ready, false);
    assertEqual(blockedFeedbackState.counts.blockingTopLevelBotComments, 1);
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

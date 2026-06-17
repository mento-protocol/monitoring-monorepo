#!/usr/bin/env node
import {
  buildClaimComment,
  chooseUntriedCandidate,
  isClaimable,
  isReleasable,
  isRecoverableClaimRaceError,
  isReviewable,
  labelsForState,
  parseArgs,
  parseIssueNumbers,
  projectDateFieldValue,
  projectPrFieldValue,
  selectStatusOption,
  shouldRollbackFailedTransition,
  stateFromLabels,
  validateOpenPr,
} from "./agent-issue-board.mjs";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, pattern) {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!pattern.test(message)) {
      throw new Error(`expected ${message} to match ${pattern}`, {
        cause: err,
      });
    }
    return;
  }
  throw new Error("expected function to throw");
}

test("parses repeated, comma-separated, and URL issue references", () => {
  assertDeepEqual(
    parseIssueNumbers([
      "901,902",
      "#903",
      "https://github.com/mento-protocol/monitoring-monorepo/issues/904",
    ]),
    [901, 902, 903, 904],
  );
});

test("rejects issue URLs from another repository", () => {
  assertThrows(
    () =>
      parseIssueNumbers(
        ["https://github.com/other/repo/issues/904"],
        "mento-protocol/monitoring-monorepo",
      ),
    /does not match selected repo/,
  );
});

test("parses claim options for the monitoring workboard", () => {
  const args = parseArgs([
    "claim",
    "--count",
    "3",
    "--agent",
    "codex",
    "--branch",
    "agent/issues",
    "--dry-run",
  ]);

  assertEqual(args.command, "claim");
  assertEqual(args.count, 3);
  assertEqual(args.agent, "codex");
  assertEqual(args.branch, "agent/issues");
  assertEqual(args.projectOwner, "mento-protocol");
  assertEqual(args.projectNumber, 12);
  assertEqual(args.dryRun, true);
});

test("review PR guard requires an open PR", () => {
  assertEqual(
    validateOpenPr(
      { id: "PR_123", state: "OPEN" },
      { pr: 984, repo: "mento-protocol/monitoring-monorepo" },
    ).id,
    "PR_123",
  );
  assertThrows(
    () =>
      validateOpenPr(null, {
        pr: 984,
        repo: "mento-protocol/monitoring-monorepo",
      }),
    /was not found/,
  );
  assertThrows(
    () =>
      validateOpenPr(
        { id: "PR_123", state: "CLOSED" },
        { pr: 984, repo: "mento-protocol/monitoring-monorepo" },
      ),
    /requires an open PR/,
  );
});

test("review falls back to In Progress when In Review is absent", () => {
  const option = selectStatusOption(
    [
      { id: "todo", name: "Todo" },
      { id: "progress", name: "In Progress" },
      { id: "done", name: "Done" },
    ],
    "review",
  );

  assertEqual(option.id, "progress");
});

test("review prefers In Review when it is available", () => {
  const option = selectStatusOption(
    [
      { id: "todo", name: "Todo" },
      { id: "review", name: "In Review" },
      { id: "progress", name: "In Progress" },
    ],
    "review",
  );

  assertEqual(option.id, "review");
});

test("grooming prefers Needs Grooming over Blocked", () => {
  const option = selectStatusOption(
    [
      { id: "todo", name: "Todo" },
      { id: "blocked", name: "Blocked" },
      { id: "grooming", name: "Needs Grooming" },
    ],
    "grooming",
  );

  assertEqual(option.id, "grooming");
});

test("claim candidate selector skips already tried issues", () => {
  const option = chooseUntriedCandidate(
    [{ number: 901 }, { number: 902 }],
    new Set([901]),
  );

  assertEqual(option.number, 902);
  assertEqual(chooseUntriedCandidate([{ number: 901 }], new Set([901])), null);
});

test("active label transition claims the issue and removes stale state", () => {
  assertDeepEqual(labelsForState("active"), {
    addLabels: ["agent-active"],
    removeLabels: ["agent-ready", "in-pr", "needs-grooming"],
    statusOptions: ["In Progress"],
  });
});

test("closed in-pr issues sync to done and clear state labels", () => {
  assertEqual(
    stateFromLabels({
      state: "CLOSED",
      labels: [{ name: "in-pr" }],
    }),
    "done",
  );
  assertDeepEqual(labelsForState("done"), {
    addLabels: [],
    removeLabels: ["agent-ready", "agent-active", "in-pr", "needs-grooming"],
    statusOptions: ["Done"],
  });
});

test("claim guard only accepts open agent-ready issues", () => {
  assertEqual(
    isClaimable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    true,
  );
  assertEqual(
    isClaimable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }, { name: "agent-active" }],
    }),
    false,
  );
  assertEqual(
    isClaimable({
      state: "CLOSED",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
});

test("review guard only accepts open agent-active issues", () => {
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    }),
    true,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "in-pr" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "needs-grooming" }],
    }),
    false,
  );
  assertEqual(
    isReviewable({
      state: "CLOSED",
      labels: [{ name: "agent-active" }],
    }),
    false,
  );
});

test("release guard only accepts open active or review queue issues", () => {
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-active" }],
    }),
    true,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "in-pr" }],
    }),
    true,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-ready" }],
    }),
    false,
  );
  assertEqual(
    isReleasable({
      state: "OPEN",
      labels: [{ name: "agent-active" }, { name: "in-pr" }],
    }),
    false,
  );
  assertEqual(
    isReleasable({
      state: "CLOSED",
      labels: [{ name: "in-pr" }],
    }),
    false,
  );
});

test("PR project field formatting clears null releases", () => {
  assertEqual(projectPrFieldValue(984), "#984");
  assertEqual(projectPrFieldValue(null), null);
  assertEqual(projectPrFieldValue(undefined), null);
});

test("Claimed At project field formatting clears null releases", () => {
  assertEqual(projectDateFieldValue("2026-06-17T10:00:00.000Z"), "2026-06-17");
  assertEqual(projectDateFieldValue(null), null);
  assertEqual(projectDateFieldValue(undefined), null);
});

test("failed claim setup rolls back unless another claim is observed", () => {
  assertEqual(shouldRollbackFailedTransition("active", "ready"), true);
  assertEqual(shouldRollbackFailedTransition("active", "ready", true), false);
  assertEqual(shouldRollbackFailedTransition("review", "active"), true);
  assertEqual(shouldRollbackFailedTransition("ready", null), false);
});

test("claim queue treats stale claim races as recoverable", () => {
  assertEqual(
    isRecoverableClaimRaceError(
      new Error("Issue #901 claim was overwritten; project Claim ID is other"),
    ),
    true,
  );
  assertEqual(
    isRecoverableClaimRaceError(new Error("gh api graphql failed")),
    false,
  );
});

test("claim comment records agent, issue, claim id, and branch", () => {
  const comment = buildClaimComment(
    {
      agent: "codex",
      branch: "agent/issue-901",
      claimId: "codex-20260617T100000",
      claimedAt: "2026-06-17T10:00:00.000Z",
    },
    { number: 901 },
  );

  assert(comment.includes("codex claimed #901"), "missing agent claim line");
  assert(comment.includes("Claim ID: codex-20260617T100000"), "missing claim");
  assert(comment.includes("Branch: agent/issue-901"), "missing branch");
});

if (failed > 0) {
  process.stderr.write(`${failed} failed, ${passed} passed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed\n`);
}

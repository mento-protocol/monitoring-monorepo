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
    topLevelBotComments: 1,
  });
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

test("does not mark feedback clear while top-level bot comments remain", () => {
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
    topLevelBotComments: [{ id: 456 }],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.summary, "Feedback surfaces need attention.");
  assertEqual(summary.counts.topLevelBotComments, 1);
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

test("renders compact JSON for watch mode", () => {
  const output = renderFeedbackState({ ready: true }, { watch: true });
  assertEqual(output, '{"ready":true}\n');
});

if (failed > 0) {
  process.stderr.write(`${failed} pr-feedback-state test(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`${passed} pr-feedback-state test(s) passed\n`);

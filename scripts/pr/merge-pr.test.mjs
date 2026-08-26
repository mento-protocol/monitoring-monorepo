#!/usr/bin/env node
/**
 * Offline unit tests for scripts/pr/merge-pr.mjs.
 *
 * Every GitHub boundary is injected, so this suite never reaches the network
 * and never merges anything. The refusal paths matter most: each one asserts
 * that no consent was recorded and no merge command ran, because a refusal that
 * still wrote or still merged would be worse than no wrapper at all.
 */

import {
  AUTOMATION_ENV_MARKERS,
  MergeRefusal,
  NON_INTERACTIVE_REFUSAL,
  buildConsentRecord,
  formatBriefing,
  interactiveSessionRefusal,
  mergePullRequest,
  parseArgs,
} from "./merge-pr.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message ?? "value mismatch"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function assertRefuses(promise, expectedSubstring) {
  let error = null;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  assert(
    error !== null,
    `expected a refusal mentioning "${expectedSubstring}"`,
  );
  assert(
    error instanceof MergeRefusal,
    `expected a MergeRefusal, got ${error?.name}: ${error?.message}`,
  );
  assert(
    String(error.message).includes(expectedSubstring),
    `expected refusal to mention "${expectedSubstring}", got: ${error.message}`,
  );
  return error;
}

const HEAD_OID = "a".repeat(40);

function readySummary(overrides = {}) {
  return {
    ready: true,
    summary: "Ready.",
    required: { ready: true, blockers: [] },
    statusChecks: {
      pass: [{ name: "ci", state: "pass", required: true }],
      fail: [],
      pending: [],
      skipped: [],
    },
    pr: {
      number: 2071,
      title: "feat(pr): sanctioned merge wrapper",
      state: "OPEN",
      headRefName: "feat/pr-merge-wrapper",
      headRefOid: HEAD_OID,
      baseRefName: "main",
      url: "https://github.com/mento-protocol/monitoring-monorepo/pull/2071",
    },
    ...overrides,
  };
}

function notReadySummary() {
  const summary = readySummary();
  return {
    ...summary,
    ready: false,
    summary: "1 required check is failing.",
    required: {
      ready: false,
      blockers: [{ kind: "check", name: "ci", state: "fail", required: true }],
    },
    statusChecks: {
      ...summary.statusChecks,
      pass: [],
      fail: [{ name: "ci", state: "fail", required: true }],
    },
  };
}

/**
 * A harness whose defaults describe the happy path: an interactive terminal, a
 * non-fork checkout, one open pull request, and a matching confirmation. Each
 * test perturbs exactly one of those.
 */
function harness({
  argv = ["--pr", "2071"],
  summary = readySummary(),
  answer = "2071",
  env = {},
  stdinTTY = true,
  stdoutTTY = true,
  readyStateError = null,
  // The second element, when present, is what the post-confirmation re-read
  // returns; without it both reads see the same state.
  summaryAfterConfirmation = null,
} = {}) {
  const calls = {
    gh: [],
    git: [],
    merges: [],
    consents: [],
    prompts: [],
    readyStateReads: 0,
  };
  let output = "";

  const gh = async (args) => {
    calls.gh.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      return JSON.stringify({
        nameWithOwner: "mento-protocol/monitoring-monorepo",
        parent: null,
      });
    }
    if (args[0] === "api" && args[1] === "user") return "chapati23\n";
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([
        {
          number: 2071,
          headRepositoryOwner: { login: "mento-protocol" },
        },
      ]);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  const git = async (args) => {
    calls.git.push(args);
    if (args[1] === "--abbrev-ref") return "feat/pr-merge-wrapper\n";
    if (args[1] === "--show-toplevel") return "/repo\n";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };

  const run = () =>
    mergePullRequest({
      argv,
      stdin: { isTTY: stdinTTY },
      stdout: {
        isTTY: stdoutTTY,
        write: (chunk) => {
          output += chunk;
        },
      },
      env,
      deps: {
        gh,
        git,
        fetchReadyState: async () => {
          if (readyStateError) throw new Error(readyStateError);
          calls.readyStateReads += 1;
          if (calls.readyStateReads > 1 && summaryAfterConfirmation) {
            return summaryAfterConfirmation;
          }
          return summary;
        },
        merge: async (args) => {
          calls.merges.push(args);
        },
        prompt: async ({ question }) => {
          calls.prompts.push(question);
          return answer;
        },
        appendConsent: async ({ record }) => {
          calls.consents.push(record);
          return "/repo/.merge-consents.jsonl";
        },
        now: () => new Date("2026-08-26T12:00:00.000Z"),
      },
    });

  return { run, calls, output: () => output };
}

function assertNothingHappened(calls) {
  assertEqual(calls.consents.length, 0, "consent must not be recorded");
  assertEqual(calls.merges.length, 0, "merge must not run");
}

// --- Refusal: non-TTY ------------------------------------------------------

await test("refuses when stdin is not a TTY", async () => {
  const { run, calls } = harness({ stdinTTY: false });
  const error = await assertRefuses(run(), NON_INTERACTIVE_REFUSAL);
  assert(
    error.message.includes("stdin is not a terminal"),
    "refusal should name stdin",
  );
  assertNothingHappened(calls);
  assertEqual(calls.gh.length, 0, "refusal must precede every GitHub call");
});

await test("refuses when stdout is not a TTY", async () => {
  const { run, calls } = harness({ stdoutTTY: false });
  await assertRefuses(run(), NON_INTERACTIVE_REFUSAL);
  assertNothingHappened(calls);
});

await test("refuses under every automation environment marker", async () => {
  for (const marker of AUTOMATION_ENV_MARKERS) {
    const { run, calls } = harness({ env: { [marker]: "1" } });
    const error = await assertRefuses(run(), NON_INTERACTIVE_REFUSAL);
    assert(
      error.message.includes(marker),
      `refusal should name the ${marker} marker`,
    );
    assertNothingHappened(calls);
  }
});

await test("an empty automation marker does not refuse a real terminal", () => {
  assertEqual(
    interactiveSessionRefusal({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      env: { CI: "" },
    }),
    null,
  );
});

await test("a missing stdin object refuses rather than throwing", () => {
  const refusal = interactiveSessionRefusal({
    stdin: undefined,
    stdout: undefined,
    env: {},
  });
  assert(
    refusal !== null && refusal.includes(NON_INTERACTIVE_REFUSAL),
    "an absent stream must refuse",
  );
});

// --- Refusal: not ready without a reason -----------------------------------

await test("refuses a not-ready pull request without --not-ready-reason", async () => {
  const { run, calls } = harness({ summary: notReadySummary() });
  await assertRefuses(run(), "is not ready");
  assertNothingHappened(calls);
  assertEqual(calls.prompts.length, 0, "must refuse before prompting");
});

await test("merges a not-ready pull request when a reason is recorded", async () => {
  const { run, calls } = harness({
    summary: notReadySummary(),
    argv: ["--pr", "2071", "--not-ready-reason", "docs-only follow-up"],
  });
  const result = await run();

  assertEqual(result.merged, true);
  assertEqual(calls.consents.length, 1);
  assertEqual(calls.consents[0].notReadyReason, "docs-only follow-up");
  assertEqual(calls.merges.length, 1);
});

// --- Refusal: wrong confirmation -------------------------------------------

await test("refuses when the typed confirmation does not match", async () => {
  const { run, calls } = harness({ answer: "2072" });
  await assertRefuses(run(), "confirmation did not match");
  assertNothingHappened(calls);
});

await test("refuses an empty confirmation", async () => {
  const { run, calls } = harness({ answer: "" });
  await assertRefuses(run(), "confirmation did not match");
  assertNothingHappened(calls);
});

await test("refuses a decorated confirmation such as #2071", async () => {
  const { run, calls } = harness({ answer: "#2071" });
  await assertRefuses(run(), "confirmation did not match");
  assertNothingHappened(calls);
});

await test("accepts a confirmation with surrounding whitespace", async () => {
  const { run, calls } = harness({ answer: "  2071\n" });
  const result = await run();
  assertEqual(result.merged, true);
  assertEqual(calls.merges.length, 1);
});

// --- Refusal: ambiguous or terminal state ----------------------------------

await test("refuses a pull request that is already merged", async () => {
  const summary = readySummary();
  const { run, calls } = harness({
    summary: { ...summary, pr: { ...summary.pr, state: "MERGED" } },
  });
  await assertRefuses(run(), "only an open pull request can be merged");
  assertNothingHappened(calls);
});

await test("refuses when the head commit is unreadable", async () => {
  const summary = readySummary();
  const { run, calls } = harness({
    summary: { ...summary, pr: { ...summary.pr, headRefOid: null } },
  });
  await assertRefuses(run(), "no usable head commit");
  assertNothingHappened(calls);
});

await test("refuses when the ready-state oracle errors", async () => {
  const { run, calls } = harness({ readyStateError: "gh exited 1" });
  await assertRefuses(run(), "unable to read the ready state");
  assertNothingHappened(calls);
});

await test("refuses when the branch has several open pull requests", async () => {
  const merges = [];
  const consents = [];
  const promise = mergePullRequest({
    argv: [],
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => {} },
    env: {},
    deps: {
      gh: async (args) => {
        if (args[0] === "repo") {
          return JSON.stringify({
            nameWithOwner: "mento-protocol/monitoring-monorepo",
            parent: null,
          });
        }
        if (args[0] === "api") return "chapati23\n";
        return JSON.stringify([
          { number: 2071, headRepositoryOwner: { login: "mento-protocol" } },
          { number: 2072, headRepositoryOwner: { login: "mento-protocol" } },
        ]);
      },
      git: async () => "feat/pr-merge-wrapper\n",
      fetchReadyState: async () => readySummary(),
      merge: async (args) => merges.push(args),
      prompt: async () => "2071",
      appendConsent: async ({ record }) => consents.push(record),
      now: () => new Date(),
    },
  });

  await assertRefuses(promise, "several open pull requests");
  assertEqual(merges.length, 0, "merge must not run");
  assertEqual(consents.length, 0, "consent must not be recorded");
});

await test("refuses when no open pull request matches the branch", async () => {
  const merges = [];
  const promise = mergePullRequest({
    argv: [],
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => {} },
    env: {},
    deps: {
      gh: async (args) => {
        if (args[0] === "repo") {
          return JSON.stringify({
            nameWithOwner: "mento-protocol/monitoring-monorepo",
            parent: null,
          });
        }
        if (args[0] === "api") return "chapati23\n";
        return JSON.stringify([]);
      },
      git: async () => "feat/pr-merge-wrapper\n",
      fetchReadyState: async () => readySummary(),
      merge: async (args) => merges.push(args),
      prompt: async () => "2071",
      appendConsent: async () => "/repo/.merge-consents.jsonl",
      now: () => new Date(),
    },
  });

  await assertRefuses(promise, "no open pull request");
  assertEqual(merges.length, 0, "merge must not run");
});

await test("ignores a same-named branch owned by a fork", async () => {
  const merges = [];
  const promise = mergePullRequest({
    argv: [],
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => {} },
    env: {},
    deps: {
      gh: async (args) => {
        if (args[0] === "repo") {
          return JSON.stringify({
            nameWithOwner: "mento-protocol/monitoring-monorepo",
            parent: null,
          });
        }
        if (args[0] === "api") return "chapati23\n";
        return JSON.stringify([
          { number: 9999, headRepositoryOwner: { login: "someone-else" } },
        ]);
      },
      git: async () => "feat/pr-merge-wrapper\n",
      fetchReadyState: async () => readySummary(),
      merge: async (args) => merges.push(args),
      prompt: async () => "9999",
      appendConsent: async () => "/repo/.merge-consents.jsonl",
      now: () => new Date(),
    },
  });

  await assertRefuses(promise, "no open pull request");
  assertEqual(merges.length, 0, "merge must not run");
});

await test("refuses when the checkout repository cannot be resolved", async () => {
  const merges = [];
  const promise = mergePullRequest({
    argv: ["--pr", "2071"],
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => {} },
    env: {},
    deps: {
      gh: async () => {
        throw new Error("gh: not authenticated");
      },
      git: async () => "/repo\n",
      fetchReadyState: async () => readySummary(),
      merge: async (args) => merges.push(args),
      prompt: async () => "2071",
      appendConsent: async () => "/repo/.merge-consents.jsonl",
      now: () => new Date(),
    },
  });

  await assertRefuses(promise, "unable to resolve the checkout repository");
  assertEqual(merges.length, 0, "merge must not run");
});

await test("refuses when the active GitHub login is unreadable", async () => {
  const merges = [];
  const promise = mergePullRequest({
    argv: ["--pr", "2071"],
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => {} },
    env: {},
    deps: {
      gh: async (args) => {
        if (args[0] === "repo") {
          return JSON.stringify({
            nameWithOwner: "mento-protocol/monitoring-monorepo",
            parent: null,
          });
        }
        return "\n";
      },
      git: async () => "/repo\n",
      fetchReadyState: async () => readySummary(),
      merge: async (args) => merges.push(args),
      prompt: async () => "2071",
      appendConsent: async () => "/repo/.merge-consents.jsonl",
      now: () => new Date(),
    },
  });

  await assertRefuses(promise, "unable to establish the active GitHub login");
  assertEqual(merges.length, 0, "merge must not run");
});

// --- Refusal: readiness changed during the confirmation prompt --------------

await test("refuses when readiness is lost while the operator confirms", async () => {
  const { run, calls } = harness({
    summaryAfterConfirmation: notReadySummary(),
  });
  await assertRefuses(run(), "is not ready");
  assertNothingHappened(calls);
  assertEqual(calls.readyStateReads, 2, "the oracle is read again after input");
});

await test("refuses when the head moves while the operator confirms", async () => {
  const moved = readySummary();
  const { run, calls } = harness({
    summaryAfterConfirmation: {
      ...moved,
      pr: { ...moved.pr, headRefOid: "b".repeat(40) },
    },
  });
  await assertRefuses(run(), "while you were confirming");
  assertNothingHappened(calls);
});

await test("refuses when the pull request is merged while the operator confirms", async () => {
  const merged = readySummary();
  const { run, calls } = harness({
    summaryAfterConfirmation: {
      ...merged,
      pr: { ...merged.pr, state: "MERGED" },
    },
  });
  await assertRefuses(run(), "only an open pull request can be merged");
  assertNothingHappened(calls);
});

await test("an override reason still refuses a head that moved mid-confirmation", async () => {
  const moved = notReadySummary();
  const { run, calls } = harness({
    summary: notReadySummary(),
    argv: ["--pr", "2071", "--not-ready-reason", "release train"],
    summaryAfterConfirmation: {
      ...moved,
      pr: { ...moved.pr, headRefOid: "c".repeat(40) },
    },
  });
  await assertRefuses(run(), "while you were confirming");
  assertNothingHappened(calls);
});

// --- The approved path ------------------------------------------------------

await test("records consent before merging, and binds the merge to the head", async () => {
  const { run, calls, output } = harness();
  const result = await run();

  assertEqual(result.merged, true);
  assertEqual(calls.consents.length, 1);
  assertEqual(calls.merges.length, 1);
  assertEqual(calls.consents[0].pr, 2071);
  assertEqual(calls.consents[0].login, "chapati23");
  assertEqual(calls.consents[0].headOid, HEAD_OID);
  assertEqual(calls.consents[0].repo, "mento-protocol/monitoring-monorepo");
  assertEqual(calls.consents[0].timestamp, "2026-08-26T12:00:00.000Z");
  assert(
    !("notReadyReason" in calls.consents[0]),
    "a ready merge records no override reason",
  );

  const mergeArgs = calls.merges[0];
  assertEqual(mergeArgs[0], "pr");
  assertEqual(mergeArgs[1], "merge");
  assertEqual(mergeArgs[2], "2071");
  assert(mergeArgs.includes("--squash"), "merge must be a squash");
  assert(
    mergeArgs.includes("--match-head-commit"),
    "merge must be bound to the reviewed head",
  );
  assertEqual(
    mergeArgs[mergeArgs.indexOf("--match-head-commit") + 1],
    HEAD_OID,
  );
  assert(
    mergeArgs.includes("mento-protocol/monitoring-monorepo"),
    "merge must name the base repository explicitly",
  );

  const briefing = output();
  assert(briefing.includes("2071"), "briefing shows the pull-request number");
  assert(briefing.includes(HEAD_OID), "briefing shows the head SHA");
  assert(briefing.includes("main"), "briefing shows the base branch");
  assert(briefing.includes("READY"), "briefing shows the ready state");
});

await test("the operator is prompted after the briefing is printed", async () => {
  const { run, calls } = harness();
  await run();
  assertEqual(calls.prompts.length, 1);
  assert(
    calls.prompts[0].includes("2071"),
    "the prompt names the number to type",
  );
});

// --- Argument parsing -------------------------------------------------------

await test("parseArgs rejects a positional argument", () => {
  let error = null;
  try {
    parseArgs(["2071"]);
  } catch (err) {
    error = err;
  }
  assert(error instanceof MergeRefusal, "expected a refusal");
  assert(String(error.message).includes("unexpected argument"), error?.message);
});

await test("parseArgs rejects a pull-request URL", () => {
  let error = null;
  try {
    parseArgs([
      "--pr",
      "https://github.com/mento-protocol/monitoring-monorepo/pull/2071",
    ]);
  } catch (err) {
    error = err;
  }
  assert(error instanceof MergeRefusal, "expected a refusal");
  assert(
    String(error.message).includes("takes a pull-request number"),
    error?.message,
  );
});

await test("parseArgs rejects an empty override reason", () => {
  let error = null;
  try {
    parseArgs(["--pr", "2071", "--not-ready-reason", "   "]);
  } catch (err) {
    error = err;
  }
  assert(error instanceof MergeRefusal, "expected a refusal");
  assert(String(error.message).includes("must not be empty"), error?.message);
});

await test("parseArgs rejects a flag with no value", () => {
  let error = null;
  try {
    parseArgs(["--pr", "--not-ready-reason", "why"]);
  } catch (err) {
    error = err;
  }
  assert(error instanceof MergeRefusal, "expected a refusal");
  assert(String(error.message).includes("requires a value"), error?.message);
});

await test("parseArgs rejects a control character in the override reason", () => {
  let error = null;
  try {
    parseArgs(["--pr", "2071", "--not-ready-reason", "line one\nline two"]);
  } catch (err) {
    error = err;
  }
  assert(error instanceof MergeRefusal, "expected a refusal");
  assert(String(error.message).includes("control characters"), error?.message);
});

await test("parseArgs accepts the reviewed flag set", () => {
  const parsed = parseArgs([
    "--pr",
    "2071",
    "--repo",
    "mento-protocol/monitoring-monorepo",
    "--not-ready-reason",
    " release train ",
  ]);
  assertEqual(parsed.prArg, 2071);
  assertEqual(parsed.repoArg, "mento-protocol/monitoring-monorepo");
  assertEqual(parsed.notReadyReason, "release train");
});

// --- Record and briefing shape ---------------------------------------------

await test("the consent record is one JSON line", () => {
  const record = buildConsentRecord({
    login: "chapati23",
    repo: "mento-protocol/monitoring-monorepo",
    number: 2071,
    headOid: HEAD_OID,
    notReadyReason: "override",
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  const line = JSON.stringify(record);
  assert(!line.includes("\n"), "a record must never span lines");
  assertEqual(JSON.parse(line).notReadyReason, "override");
});

await test("the briefing lists required-check counts and blockers", () => {
  const briefing = formatBriefing({
    summary: notReadySummary(),
    repo: "mento-protocol/monitoring-monorepo",
    notReadyReason: "hotfix",
  });
  assert(briefing.includes("0 passing, 1 failing, 0 pending"), briefing);
  assert(briefing.includes("NOT READY"), briefing);
  assert(briefing.includes("- ci (fail)"), briefing);
  assert(briefing.includes("hotfix"), briefing);
});

if (failed > 0) {
  process.stderr.write(`\n${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

process.stdout.write(`\n${passed} passed\n`);

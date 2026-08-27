#!/usr/bin/env node
/**
 * Offline unit tests for scripts/pr/merge-pr.mjs.
 *
 * Every GitHub boundary is injected, so this suite never reaches the network
 * and never merges anything. The refusal paths matter most: each one asserts
 * that no consent was recorded and no merge command ran, because a refusal that
 * still wrote or still merged would be worse than no wrapper at all.
 */

import * as fs from "node:fs";
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTOMATION_ENV_MARKERS,
  CONSENT_LOG_BASENAME,
  MergeRefusal,
  NON_INTERACTIVE_REFUSAL,
  buildConsentRecord,
  countRequiredCheckStates,
  formatBriefing,
  interactiveSessionRefusal,
  exitCodeForResult,
  gateSignature,
  mergePullRequest,
  parseArgs,
  sanitizeTerminalText,
} from "./merge-pr.mjs";
import { appendConsentRecord } from "./merge-pr-io.mjs";
import {
  groupStatusChecks,
  splitRequiredAndOptionalChecks,
} from "./pr-ready-state-core.mjs";
import { summarizeFeedbackState } from "./pr-feedback-state-core.mjs";

/** The repository's file-size soft cap (docs/adr/0065-...). */
const SOFT_CAP = 600;

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

const REQUIRED_STATUS_CONTEXTS = ["ci", "Code Quality"];

function checkRun(name, conclusion) {
  return {
    __typename: "CheckRun",
    name,
    status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
    conclusion,
  };
}

/**
 * Build the check-shaped half of a summary through the ready-state oracle's own
 * functions rather than by hand. A hand-written fixture can invent a field the
 * oracle never emits, and then the suite validates a contract that does not
 * exist — which is exactly how the briefing shipped counting a `required` flag
 * `groupStatusChecks()` has never set.
 */
function summaryChecks(statusCheckRollup) {
  return {
    statusChecks: groupStatusChecks(statusCheckRollup),
    requiredChecks: splitRequiredAndOptionalChecks(
      statusCheckRollup,
      REQUIRED_STATUS_CONTEXTS,
    ).required,
  };
}

function requiredBlockersFrom(requiredChecks) {
  return requiredChecks.filter((check) =>
    ["fail", "pending"].includes(check.state),
  );
}

const PASSING_ROLLUP = [
  checkRun("ci", "SUCCESS"),
  checkRun("Code Quality", "SUCCESS"),
];

const FAILING_ROLLUP = [
  checkRun("ci", "FAILURE"),
  checkRun("Code Quality", "SUCCESS"),
];

function readySummary(overrides = {}) {
  return {
    ready: true,
    summary: "Ready.",
    required: { ready: true, blockers: [] },
    ...summaryChecks(PASSING_ROLLUP),
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
  const checks = summaryChecks(FAILING_ROLLUP);
  return {
    ...readySummary(),
    ...checks,
    ready: false,
    summary: "1 required blocker(s) remain.",
    required: {
      ready: false,
      blockers: requiredBlockersFrom(checks.requiredChecks),
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
  // What the post-merge confirmation read reports. A merge-queue base leaves
  // the pull request OPEN even though `gh pr merge` exited 0.
  mergedState = "MERGED",
  mergeOutcomeError = null,
  disableAutoError = null,
  mergeCommandError = null,
  // The base the pull request reports AFTER the merge. A retarget between the
  // final gate read and GitHub processing the merge shows up only here.
  mergedBaseRefName = null,
  // Logins returned by successive `gh api user` calls; the second models a
  // `gh auth switch` during the confirmation prompt.
  logins = null,
  // The repository URL `gh repo view` reports, which carries the host.
  repoUrl = "https://github.com/mento-protocol/monitoring-monorepo",
  parent = null,
} = {}) {
  const calls = {
    gh: [],
    git: [],
    merges: [],
    consents: [],
    prompts: [],
    readyStateReads: 0,
    logins: 0,
  };
  let output = "";

  const gh = async (args) => {
    calls.gh.push(args);
    if (args[0] === "repo" && args[1] === "view") {
      return JSON.stringify({
        nameWithOwner: "mento-protocol/monitoring-monorepo",
        parent,
        url: repoUrl,
      });
    }
    if (args[0] === "api" && args.includes("user")) {
      if (logins)
        return `${logins[calls.logins++] ?? logins[logins.length - 1]}\n`;
      return "chapati23\n";
    }
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify([
        {
          number: 2071,
          headRepositoryOwner: { login: "mento-protocol" },
        },
      ]);
    }
    if (
      args[0] === "pr" &&
      args[1] === "merge" &&
      args.includes("--disable-auto")
    ) {
      if (disableAutoError) throw new Error(disableAutoError);
      return "";
    }
    if (args[0] === "pr" && args[1] === "view") {
      if (mergeOutcomeError) throw new Error(mergeOutcomeError);
      return JSON.stringify({
        state: mergedState,
        mergeCommit: mergedState === "MERGED" ? { oid: "b".repeat(40) } : null,
        baseRefName: mergedBaseRefName ?? "main",
      });
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
          if (mergeCommandError) throw new Error(mergeCommandError);
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
  assert(
    briefing.includes("1 passing, 1 failing, 0 pending (of 2 required)"),
    briefing,
  );
  assert(briefing.includes("NOT READY"), briefing);
  assert(briefing.includes("- ci (fail)"), briefing);
  assert(briefing.includes("hotfix"), briefing);
});

await test("the briefing counts real oracle output, not a zero", () => {
  // Every state at once, plus an optional check, all shaped by the oracle. The
  // briefing must count the three required ones and ignore the optional one.
  const rollup = [
    checkRun("ci", "SUCCESS"),
    checkRun("Code Quality", "FAILURE"),
    checkRun("Vercel", null),
    checkRun("CodeRabbit", "SUCCESS"),
  ];
  const checks = summaryChecks(rollup);
  const counts = countRequiredCheckStates({
    ...checks,
    requiredChecks: splitRequiredAndOptionalChecks(rollup, [
      ...REQUIRED_STATUS_CONTEXTS,
      "Vercel",
    ]).required,
  });
  assertEqual(counts.pass, 1, "one required check passes");
  assertEqual(counts.fail, 1, "one required check fails");
  assertEqual(counts.pending, 1, "one required check is pending");
  assertEqual(counts.total, 3, "the optional check is not required");

  // The grouped list the briefing used to read carries no `required` flag at
  // all, so counting it would have reported zero of everything.
  assert(
    checks.statusChecks.pass.every((check) => check.required === undefined),
    "groupStatusChecks() must not be assumed to flag required checks",
  );
});

await test("the briefing says so when no required-check list exists", () => {
  const summary = notReadySummary();
  delete summary.requiredChecks;
  const briefing = formatBriefing({
    summary,
    repo: "mento-protocol/monitoring-monorepo",
    notReadyReason: null,
  });
  assertEqual(countRequiredCheckStates(summary), null);
  assert(briefing.includes("Required checks: unavailable"), briefing);
  assert(!briefing.includes("0 passing"), briefing);
});

await test("the consent ledger refuses a planted symlink", async () => {
  // The ledger is gitignored, so the agent this wrapper constrains can create
  // the path first. Following a symlink there would append to a file outside
  // the repository that the operator's own account can write.
  const root = mkdtempSync(path.join(tmpdir(), "merge-consent-"));
  try {
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "original\n", "utf8");
    const checkout = path.join(root, "checkout");
    mkdirSync(checkout);
    symlinkSync(outside, path.join(checkout, CONSENT_LOG_BASENAME));

    const record = buildConsentRecord({
      login: "chapati23",
      repo: "mento-protocol/monitoring-monorepo",
      number: 2071,
      headOid: HEAD_OID,
      notReadyReason: null,
      now: new Date("2026-08-26T12:00:00.000Z"),
    });

    await assertRefuses(
      appendConsentRecord({ record, git: async () => `${checkout}\n` }),
      "unable to record consent",
    );
    assertEqual(
      readFileSync(outside, "utf8"),
      "original\n",
      "the symlink target must be untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("the consent ledger appends to a regular file", async () => {
  // Negative control: the refusal above must come from the symlink, not from
  // the new open flags rejecting the ordinary case.
  const checkout = mkdtempSync(path.join(tmpdir(), "merge-consent-ok-"));
  try {
    const record = buildConsentRecord({
      login: "chapati23",
      repo: "mento-protocol/monitoring-monorepo",
      number: 2071,
      headOid: HEAD_OID,
      notReadyReason: null,
      now: new Date("2026-08-26T12:00:00.000Z"),
    });
    const target = await appendConsentRecord({
      record,
      git: async () => `${checkout}\n`,
    });
    assertEqual(target, path.join(checkout, CONSENT_LOG_BASENAME));
    await appendConsentRecord({ record, git: async () => `${checkout}\n` });
    // Records are separated by blank lines, since each one opens with a
    // newline rather than reading the previous byte to decide.
    const lines = readFileSync(target, "utf8").split("\n").filter(Boolean);
    assertEqual(lines.length, 2, "appends must accumulate");
    assertEqual(JSON.parse(lines[0]).pr, 2071);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

await test("the automation markers cover every Codex marker autoreview checks", () => {
  // `running_inside_codex_sandbox()` in agent-autoreview.sh is this repository's
  // established Codex-session detector. The two must not drift: a marker it
  // knows and this list does not is a merge gate a Codex agent walks through.
  const autoreview = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "agent-autoreview.sh",
    ),
    "utf8",
  );
  // The body ends at a line that is exactly `}`; a `}` inside `${VAR:-}` is not
  // the closing brace.
  const body = /running_inside_codex_sandbox\(\) \{\n([\s\S]*?)\n\}\n/.exec(
    autoreview,
  );
  assert(body !== null, "running_inside_codex_sandbox() was not found");

  const markers = [...body[1].matchAll(/\$\{([A-Z0-9_]+):-\}/g)].map(
    (match) => match[1],
  );
  assert(markers.length > 0, "no environment markers parsed from the detector");
  for (const marker of markers) {
    assert(
      AUTOMATION_ENV_MARKERS.includes(marker),
      `AUTOMATION_ENV_MARKERS is missing ${marker}, which agent-autoreview.sh treats as a Codex session`,
    );
  }
});

await test("the briefing neutralizes terminal control sequences in the title", () => {
  // A pull-request title is contributor-controlled. Printed verbatim it can
  // erase the head, base and readiness lines directly above it and forge new
  // ones, so the operator would confirm against text the author composed.
  const hostile = readySummary();
  // Written as escapes: a literal control byte would make this file binary
  // to Git and to every reviewer's diff.
  hostile.pr.title =
    "\u001b[2Ktidy\rAbout to merge safe/repo#1\u202e evil \u200b";
  const briefing = formatBriefing({
    summary: hostile,
    feedback: { ready: true, counts: {} },
    repo: "mento-protocol/monitoring-monorepo",
    notReadyReason: null,
  });

  for (const forbidden of ["\u001b", "\r", "\u202e", "\u200b"]) {
    assert(
      !briefing.includes(forbidden),
      `the briefing still carries ${JSON.stringify(forbidden)}`,
    );
  }
  assert(
    briefing.includes("\ufffd"),
    "the stripped characters should stay visible as replacement characters",
  );
  // The trusted lines must survive intact.
  assert(briefing.includes(`  Head:  ${HEAD_OID}`), "the head line was lost");
  assert(briefing.includes("  Base:  main"), "the base line was lost");
});

await test("sanitizeTerminalText keeps ordinary text and reports empty values", () => {
  assertEqual(sanitizeTerminalText("feat: add a thing"), "feat: add a thing");
  assertEqual(sanitizeTerminalText(""), "(unknown)");
  assertEqual(sanitizeTerminalText(null), "(unknown)");
  assertEqual(sanitizeTerminalText(undefined), "(unknown)");
});

await test("refuses when the base branch is retargeted mid-confirmation", async () => {
  // `--match-head-commit` binds the head only, so a retarget keeps the same
  // SHA and would merge into a branch the operator was never shown.
  const retargeted = readySummary();
  retargeted.pr = { ...retargeted.pr, baseRefName: "release/v2" };
  const h = harness({ summaryAfterConfirmation: retargeted });

  await assertRefuses(h.run(), "was retargeted from main to release/v2");
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
});

await test("an override reason does not carry through a newly failing check", async () => {
  // The reason was entered for the state in the briefing. A blocker that
  // appears while the operator is at the prompt is not covered by it.
  const worsened = notReadySummary();
  worsened.required = {
    ready: false,
    blockers: [
      ...worsened.required.blockers,
      { kind: "review", name: "Codex review", state: "CHANGES_REQUESTED" },
    ],
  };
  const h = harness({
    argv: ["--pr", "2071", "--not-ready-reason", "docs-only follow-up"],
    summary: notReadySummary(),
    summaryAfterConfirmation: worsened,
  });

  await assertRefuses(
    h.run(),
    "changed its readiness or feedback state while you were confirming",
  );
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
});

await test("an unchanged not-ready state still merges under one override", async () => {
  // The guard above must not break the documented override path.
  const h = harness({
    argv: ["--pr", "2071", "--not-ready-reason", "docs-only follow-up"],
    summary: notReadySummary(),
  });

  const result = await h.run();
  assertEqual(result.merged, true, "the override should still merge");
});

await test("refuses a pull request whose feedback ledger is not clean", async () => {
  // `pr:ready-state` does not project actionable review feedback into its
  // blockers; `pr:feedback-state` owns that ledger. Reading only the oracle
  // would merge a pull request the repository's own all-clear refuses.
  const withFeedback = readySummary();
  withFeedback.unresolvedReviewThreads = [
    {
      id: "PRRT_1",
      path: "scripts/pr/merge-pr.mjs",
      line: 10,
      isResolved: false,
      comments: [{ author: { login: "coderabbitai" }, body: "a finding" }],
    },
  ];
  const h = harness({ summary: withFeedback });

  await assertRefuses(h.run(), "is not ready");
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
});

await test("the feedback ledger blocks even when the oracle reports ready", async () => {
  // Proves the two projections are read independently: `ready` is true here.
  const withFeedback = readySummary();
  withFeedback.unrepliedRootReviewComments = [
    { id: "IC_1", author: { login: "coderabbitai" }, body: "a finding" },
  ];
  assertEqual(withFeedback.ready, true, "the oracle should still report ready");

  const h = harness({ summary: withFeedback });
  const error = await assertRefuses(h.run(), "is not ready");
  assert(
    /feedback/i.test(error.message),
    `the refusal should name the feedback ledger, got: ${error.message}`,
  );
});

await test("a recorded reason overrides an unclean feedback ledger", async () => {
  const withFeedback = readySummary();
  withFeedback.unresolvedReviewThreads = [
    {
      id: "PRRT_1",
      path: "scripts/pr/merge-pr.mjs",
      line: 10,
      isResolved: false,
      comments: [{ author: { login: "coderabbitai" }, body: "a finding" }],
    },
  ];
  const h = harness({
    argv: ["--pr", "2071", "--not-ready-reason", "threads answered inline"],
    summary: withFeedback,
  });

  const result = await h.run();
  assertEqual(result.merged, true, "the override should merge");
  assertEqual(
    result.record.notReadyReason,
    "threads answered inline",
    "the reason belongs in the consent record",
  );
});

await test("the briefing reports the feedback ledger", async () => {
  const withFeedback = readySummary();
  withFeedback.unresolvedReviewThreads = [
    {
      id: "PRRT_1",
      path: "scripts/pr/merge-pr.mjs",
      line: 10,
      isResolved: false,
      comments: [{ author: { login: "coderabbitai" }, body: "a finding" }],
    },
  ];
  const h = harness({
    argv: ["--pr", "2071", "--not-ready-reason", "threads answered inline"],
    summary: withFeedback,
  });
  await h.run();

  assert(
    h.output().includes("Feedback ledger: NEEDS ATTENTION"),
    `the briefing should report the ledger, got:\n${h.output()}`,
  );
  assert(
    h.output().includes("1 unresolved threads"),
    `the briefing should count the threads, got:\n${h.output()}`,
  );
});

await test("a clean ledger is reported as clear", async () => {
  const h = harness();
  await h.run();
  assert(
    h.output().includes("Feedback ledger: CLEAR"),
    `the briefing should report a clear ledger, got:\n${h.output()}`,
  );
});

await test("the consent ledger refuses a hard-linked file", async () => {
  // `O_NOFOLLOW` rejects a symlink, but a hard link is the same inode under a
  // second name and passes every other check, so `ln` would work where
  // `ln -s` does not.
  const checkout = mkdtempSync(path.join(tmpdir(), "merge-consent-hard-"));
  try {
    const victim = path.join(checkout, "victim.txt");
    writeFileSync(victim, "important\n");
    linkSync(victim, path.join(checkout, CONSENT_LOG_BASENAME));

    const record = buildConsentRecord({
      login: "chapati23",
      repo: "mento-protocol/monitoring-monorepo",
      number: 2071,
      headOid: HEAD_OID,
      notReadyReason: null,
      now: new Date("2026-08-26T00:00:00.000Z"),
    });

    await assertRefuses(
      appendConsentRecord({ record, git: async () => `${checkout}\n` }),
      "hard links",
    );
    assertEqual(
      readFileSync(victim, "utf8"),
      "important\n",
      "the linked file must be untouched",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

await test("a short consent write refuses instead of reporting success", async () => {
  // A quota or a full filesystem can make `writeSync` return a short count
  // rather than throw, leaving a truncated record behind a reported success.
  const checkout = mkdtempSync(path.join(tmpdir(), "merge-consent-short-"));
  try {
    const record = buildConsentRecord({
      login: "chapati23",
      repo: "mento-protocol/monitoring-monorepo",
      number: 2071,
      headOid: HEAD_OID,
      notReadyReason: null,
      now: new Date("2026-08-26T00:00:00.000Z"),
    });

    await assertRefuses(
      appendConsentRecord({
        record,
        git: async () => `${checkout}\n`,
        // Accept only the first five bytes, as a full filesystem would.
        write: (fd, payload) => fs.writeSync(fd, payload.subarray(0, 5)),
      }),
      "the consent record is incomplete",
    );

    const ledger = readFileSync(
      path.join(checkout, CONSENT_LOG_BASENAME),
      "utf8",
    );
    // The bytes remain by design; what must not exist is a line that reads as
    // a consent record.
    const parseable = ledger
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });
    assertEqual(
      parseable.length,
      0,
      `a truncated record must not parse as a consent record, got: ${JSON.stringify(ledger)}`,
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

await test("a short consent write never truncates the shared ledger", async () => {
  // Truncating back would race another pr:merge appending a complete record
  // and delete their consent. The partial bytes stay; nothing else is lost.
  const checkout = mkdtempSync(path.join(tmpdir(), "merge-consent-short-"));
  try {
    const ledger = path.join(checkout, CONSENT_LOG_BASENAME);
    const existing = '{"timestamp":"2026-08-01T00:00:00.000Z","pr":1}\n';
    writeFileSync(ledger, existing);

    const record = buildConsentRecord({
      login: "chapati23",
      repo: "mento-protocol/monitoring-monorepo",
      number: 2071,
      headOid: HEAD_OID,
      notReadyReason: null,
      now: new Date("2026-08-26T00:00:00.000Z"),
    });

    const error = await assertRefuses(
      appendConsentRecord({
        record,
        git: async () => `${checkout}\n`,
        write: (fd, payload) => fs.writeSync(fd, payload.subarray(0, 5)),
      }),
      "the consent record is incomplete",
    );
    assert(
      error.message.includes("left in place"),
      `the refusal should say the bytes stay, got: ${error.message}`,
    );

    const after = readFileSync(ledger, "utf8");
    assert(
      after.startsWith(existing),
      "the pre-existing record must be untouched",
    );
    assert(
      after.length > existing.length,
      "the partial bytes should still be there, not truncated away",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

await test("a later append steps over an unterminated partial record", async () => {
  // The reason truncation is not needed: a record with no trailing newline
  // cannot swallow the next one, because the next append starts its own line.
  const checkout = mkdtempSync(path.join(tmpdir(), "merge-consent-partial-"));
  try {
    const ledger = path.join(checkout, CONSENT_LOG_BASENAME);
    const good = '{"timestamp":"2026-08-01T00:00:00.000Z","pr":1}\n';
    const partial = '{"timestamp":"2026-08-02T00:00';
    writeFileSync(ledger, good + partial);

    const record = buildConsentRecord({
      login: "chapati23",
      repo: "mento-protocol/monitoring-monorepo",
      number: 2071,
      headOid: HEAD_OID,
      notReadyReason: null,
      now: new Date("2026-08-26T00:00:00.000Z"),
    });
    await appendConsentRecord({ record, git: async () => `${checkout}\n` });

    const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    assertEqual(lines.length, 3, "the partial record must stay its own line");
    assertEqual(
      lines[1],
      partial,
      "the broken line is left visible, not merged",
    );
    const parsed = JSON.parse(lines[2]);
    assertEqual(parsed.pr, 2071, "the new record must be intact and parseable");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

await test("every record lands on its own line, blank lines and all", async () => {
  // The leading newline is unconditional: deciding it from the last byte would
  // race another run short-writing between the read and the write.
  const checkout = mkdtempSync(path.join(tmpdir(), "merge-consent-clean-"));
  try {
    const ledger = path.join(checkout, CONSENT_LOG_BASENAME);
    writeFileSync(ledger, '{"pr":1}\n');

    const record = buildConsentRecord({
      login: "chapati23",
      repo: "mento-protocol/monitoring-monorepo",
      number: 2071,
      headOid: HEAD_OID,
      notReadyReason: null,
      now: new Date("2026-08-26T00:00:00.000Z"),
    });
    await appendConsentRecord({ record, git: async () => `${checkout}\n` });
    await appendConsentRecord({ record, git: async () => `${checkout}\n` });

    const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    assertEqual(lines.length, 3, "three records, blank lines skipped");
    for (const line of lines) JSON.parse(line);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

await test("an enqueued pull request is not reported as merged", async () => {
  // `gh pr merge` exits 0 after enqueueing on a merge-queue base. Reporting
  // that as merged would let callers run post-merge closeout while the pull
  // request is still open and the queue is still retesting it.
  const h = harness({ mergedState: "OPEN" });

  const result = await h.run();
  assertEqual(result.merged, false, "an enqueued request is not merged");
  assertEqual(result.queued, true, "it should be reported as queued");
  assertEqual(result.verified, true, "the state was read successfully");
  assert(
    h.output().includes("not merged"),
    `the operator should be told, got:\n${h.output()}`,
  );
});

await test("an unreadable post-merge state is reported as unverified", async () => {
  const h = harness({ mergeOutcomeError: "gh exploded" });

  const result = await h.run();
  assertEqual(result.merged, false, "an unconfirmed merge is not merged");
  assertEqual(result.verified, false, "the state could not be read");
  assert(
    h.output().includes("Could not confirm the merge landed"),
    `the operator should be told, got:\n${h.output()}`,
  );
});

await test("a confirmed merge reports the merge commit", async () => {
  const h = harness();
  const result = await h.run();
  assertEqual(result.merged, true);
  assertEqual(result.verified, true);
  assertEqual(result.mergeCommit, "b".repeat(40));
});

await test("an Enterprise checkout keeps its host on every call", async () => {
  // `gh repo view --json nameWithOwner` returns a bare owner/name even on an
  // Enterprise host, and `gh` defaults a bare `--repo` to github.com — so
  // losing the host would inspect and merge an unrelated public repository.
  const h = harness({
    argv: [],
    repoUrl: "https://ghe.example.com/mento-protocol/monitoring-monorepo",
  });
  await h.run();

  const merged = h.calls.merges[0];
  assertEqual(
    merged[merged.indexOf("--repo") + 1],
    "ghe.example.com/mento-protocol/monitoring-monorepo",
    "the merge must target the Enterprise host",
  );

  const login = h.calls.gh.find(
    (args) => args[0] === "api" && args.includes("user"),
  );
  assertEqual(
    login[login.indexOf("--hostname") + 1],
    "ghe.example.com",
    "the login must be read from the Enterprise host",
  );
});

await test("a github.com checkout still names github.com explicitly", async () => {
  // The host is always named, so GH_HOST cannot redirect the login read.
  const h = harness({ argv: [] });
  await h.run();

  const login = h.calls.gh.find(
    (args) => args[0] === "api" && args.includes("user"),
  );
  assertEqual(login[login.indexOf("--hostname") + 1], "github.com");
  const merged = h.calls.merges[0];
  assertEqual(
    merged[merged.indexOf("--repo") + 1],
    "mento-protocol/monitoring-monorepo",
  );
});

await test("an explicit host-qualified --repo reaches gh verbatim", async () => {
  const h = harness({
    argv: ["--pr", "2071", "--repo", "ghe.example.com/acme/widgets"],
  });
  await h.run();

  const merged = h.calls.merges[0];
  assertEqual(
    merged[merged.indexOf("--repo") + 1],
    "ghe.example.com/acme/widgets",
  );
  const login = h.calls.gh.find(
    (args) => args[0] === "api" && args.includes("user"),
  );
  assertEqual(login[login.indexOf("--hostname") + 1], "ghe.example.com");
});

await test("a swapped feedback item refuses even though the counts match", async () => {
  // One thread resolved while a different one appears leaves every count
  // identical. A count-only signature would call that unchanged and merge it
  // under a reason the operator entered for the previous feedback set.
  const before = readySummary();
  before.unresolvedReviewThreads = [
    {
      id: "PRRT_before",
      path: "scripts/pr/merge-pr.mjs",
      line: 10,
      isResolved: false,
      comments: [{ author: { login: "coderabbitai" }, body: "a finding" }],
    },
  ];

  const after = readySummary();
  after.unresolvedReviewThreads = [
    {
      id: "PRRT_after",
      path: "scripts/pr/merge-pr-io.mjs",
      line: 10,
      isResolved: false,
      comments: [{ author: { login: "coderabbitai" }, body: "a finding" }],
    },
  ];

  const beforeFeedback = summarizeFeedbackState(before);
  const afterFeedback = summarizeFeedbackState(after);
  assertEqual(
    JSON.stringify(beforeFeedback.counts),
    JSON.stringify(afterFeedback.counts),
    "the fixtures must have identical counts or this proves nothing",
  );
  assert(
    gateSignature({ summary: before, feedback: beforeFeedback }) !==
      gateSignature({ summary: after, feedback: afterFeedback }),
    "the signature must distinguish a swapped feedback item",
  );

  const h = harness({
    argv: [
      "--pr",
      "2071",
      "--not-ready-reason",
      "the first thread is answered",
    ],
    summary: before,
    summaryAfterConfirmation: after,
  });
  await assertRefuses(
    h.run(),
    "changed its readiness or feedback state while you were confirming",
  );
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
});

await test("a required check that changes to skipped refuses", async () => {
  // Both pass and skipped are non-blocking, so the blocker list does not move.
  // The briefing showed the operator the first state, so the confirmation has
  // to bind it.
  const after = readySummary();
  after.requiredChecks = after.requiredChecks.map((check, index) =>
    index === 0 ? { ...check, state: "skipped" } : check,
  );

  assertEqual(
    JSON.stringify(readySummary().required.blockers),
    JSON.stringify(after.required.blockers),
    "the blocker lists must match or this proves nothing",
  );
  assert(
    gateSignature({ summary: readySummary(), feedback: null }) !==
      gateSignature({ summary: after, feedback: null }),
    "the signature must notice a required check changing state",
  );

  const h = harness({ summaryAfterConfirmation: after });
  await assertRefuses(
    h.run(),
    "changed its readiness or feedback state while you were confirming",
  );
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
});

await test("the gate signature cannot be spoofed through a blocker name", () => {
  // Every field is GitHub-controlled text. With a delimiter-joined encoding a
  // check whose name contains that delimiter can spell a different set's
  // signature, and the confirmation comparison then treats two genuinely
  // different states as equal.
  // Crafted to be an exact forgery under the old encoding: the name supplies
  // the trailing ":fail" of the first record, a record separator, and a whole
  // second record. The probe in the negative control proves it really collided.
  const withDelimiters = {
    ready: false,
    required: {
      blockers: [
        { kind: "check", name: "ci:fail\nblocker:check:x", state: "fail" },
      ],
    },
  };
  const plain = {
    ready: false,
    required: {
      blockers: [
        { kind: "check", name: "ci", state: "fail" },
        { kind: "check", name: "x", state: "fail" },
      ],
    },
  };
  assert(
    gateSignature({ summary: withDelimiters, feedback: null }) !==
      gateSignature({ summary: plain, feedback: null }),
    "a blocker name must not be able to spell another blocker set",
  );

  // Order must still not matter, or an unchanged state would refuse.
  const reordered = {
    ready: false,
    required: { blockers: [...plain.required.blockers].reverse() },
  };
  assertEqual(
    gateSignature({ summary: reordered, feedback: null }),
    gateSignature({ summary: plain, feedback: null }),
    "the signature must be order-independent",
  );
});

await test("refuses an implicit target while GH_REPO is set", async () => {
  // GH_REPO redirects every gh command that would otherwise read the local
  // repository. Which one wins here depends on gh's precedence rules, and this
  // command decides what gets merged, so an unnamed target refuses.
  const h = harness({ argv: [], env: { GH_REPO: "cli/cli" } });
  await assertRefuses(h.run(), "GH_REPO is set");
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
  assertEqual(
    h.calls.gh.length,
    0,
    "the refusal must precede every GitHub call",
  );
});

await test("an explicit --repo is allowed even with GH_REPO set", async () => {
  // The explicit flag beats the environment in gh, so naming the target
  // resolves the ambiguity rather than needing the variable cleared.
  const h = harness({
    argv: ["--pr", "2071", "--repo", "mento-protocol/monitoring-monorepo"],
    env: { GH_REPO: "cli/cli" },
  });
  const result = await h.run();
  assertEqual(result.merged, true, "an explicitly named target should merge");
});

await test("the login is always read from a named host", async () => {
  // Without --hostname, gh api defaults to github.com — but that default is
  // itself overridable through GH_HOST, which would record the wrong operator
  // in the consent ledger.
  const h = harness({ argv: ["--pr", "2071"] });
  await h.run();
  const login = h.calls.gh.find(
    (args) => args[0] === "api" && args.includes("user"),
  );
  assert(
    login.includes("--hostname"),
    `the login call must name its host, got: ${login.join(" ")}`,
  );
  assertEqual(login[login.indexOf("--hostname") + 1], "github.com");
});

await test("a base retargeted during the merge itself is reported", async () => {
  // `--match-head-commit` pins the head, and GitHub's merge API has no
  // parameter that pins the base — its only matching field is `sha`. So this
  // race cannot be prevented in the wrapper; it must be detected and said
  // plainly rather than reported as a clean merge.
  const h = harness({ mergedBaseRefName: "release/v2" });

  const result = await h.run();
  assertEqual(result.merged, true, "GitHub did merge it");
  assertEqual(result.baseMismatch, true, "the base was not the approved one");
  assertEqual(result.baseRefName, "release/v2");
  assertEqual(
    exitCodeForResult(result),
    1,
    "the shell must not chain past an unapproved base",
  );
  assert(
    h.output().includes("not the main you approved"),
    `the operator must be told, got:\n${h.output()}`,
  );
});

await test("a MERGED state with no base is not a confirmed merge", async () => {
  // GitHub said MERGED but named no destination. Treating that as success
  // would chain post-merge steps on an outcome this run never confirmed.
  const h = harness({ mergedBaseRefName: "" });

  const result = await h.run();
  assertEqual(result.verified, false, "the base was never confirmed");
  assertEqual(
    exitCodeForResult(result),
    1,
    "an unconfirmed base must not exit zero",
  );
  assert(
    h.output().includes("names no base branch"),
    `the operator must be told, got:\n${h.output()}`,
  );
});

await test("an unchanged base reports no mismatch", async () => {
  const result = await harness().run();
  assertEqual(result.baseMismatch, false);
  assertEqual(result.baseRefName, "main");
  assertEqual(exitCodeForResult(result), 0);
});

await test("a login switched during confirmation refuses", async () => {
  // The merge starts a fresh gh, which reads whatever credentials are active
  // then. Recording one login and merging as another would break exactly the
  // attribution the ledger exists to provide.
  const h = harness({ logins: ["chapati23", "someone-else"] });

  await assertRefuses(h.run(), "login changed from chapati23 to someone-else");
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
});

await test("an unchanged login still merges", async () => {
  const h = harness({ logins: ["chapati23", "chapati23"] });
  const result = await h.run();
  assertEqual(result.merged, true);
  assertEqual(result.record.login, "chapati23");
});

await test("refuses a bare target while GH_HOST is set", async () => {
  // GH_HOST picks the host when one was not provided, so a bare owner/name
  // target would read and merge on an Enterprise host while the login call
  // names github.com outright and the briefing shows neither.
  const h = harness({
    argv: ["--pr", "2071"],
    env: { GH_HOST: "ghe.example.com" },
  });
  await assertRefuses(h.run(), "GH_HOST is set");
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
  assertEqual(h.calls.consents.length, 0, "no consent should be recorded");
});

await test("a host-qualified target is allowed with GH_HOST set", async () => {
  // The host was provided, so GH_HOST does not choose it.
  const h = harness({
    argv: ["--pr", "2071", "--repo", "ghe.example.com/acme/widgets"],
    env: { GH_HOST: "ghe.example.com" },
  });
  const result = await h.run();
  assertEqual(result.merged, true);
});

await test("a title edited during confirmation refuses", async () => {
  // The title is on the briefing, and on a repository that derives squash
  // subjects from it the title is what the merge commit ends up saying.
  const renamed = readySummary();
  renamed.pr = { ...renamed.pr, title: "feat: something else entirely" };

  const h = harness({ summaryAfterConfirmation: renamed });
  await assertRefuses(
    h.run(),
    "changed its readiness or feedback state while you were confirming",
  );
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
});

await test("an Enterprise Managed User login is accepted", async () => {
  // EMU logins carry the enterprise shortcode after an underscore. Rejecting
  // them would stop every merge on such an account before the briefing.
  const h = harness({ logins: ["octocat_fabrikam", "octocat_fabrikam"] });
  const result = await h.run();
  assertEqual(result.merged, true);
  assertEqual(result.record.login, "octocat_fabrikam");
});

await test("a login with unsafe characters still refuses", async () => {
  // The value is written into the ledger, so the pattern stays narrow.
  const h = harness({ logins: ["not a login", "not a login"] });
  await assertRefuses(h.run(), "unable to establish the active GitHub login");
  assertEqual(h.calls.merges.length, 0, "nothing should have merged");
});

await test("an enqueued merge has its pending request cancelled", async () => {
  // gh enqueues when required checks pass and enables auto-merge when they do
  // not. Either leaves a standing request GitHub can complete later, with none
  // of the gates — the merge nobody approved.
  const h = harness({ mergedState: "OPEN" });
  const result = await h.run();

  assertEqual(result.merged, false);
  const cancel = h.calls.gh.find(
    (args) =>
      args[0] === "pr" &&
      args[1] === "merge" &&
      args.includes("--disable-auto"),
  );
  assert(cancel !== undefined, "the pending merge request must be cancelled");
  assertEqual(
    cancel[cancel.indexOf("--repo") + 1],
    "mento-protocol/monitoring-monorepo",
  );
  assert(
    h.output().includes("has been cancelled"),
    `the operator should be told, got:\n${h.output()}`,
  );
});

await test("a failed cancellation is reported, not swallowed", async () => {
  const h = harness({ mergedState: "OPEN", disableAutoError: "gh refused" });
  const result = await h.run();

  assertEqual(result.merged, false);
  assert(
    h.output().includes("could NOT be cancelled"),
    `the operator must be warned, got:\n${h.output()}`,
  );
  assert(
    h.output().includes("without any of the gates"),
    "the warning should say what the risk is",
  );
});

await test("a failing merge command still reconciles the pull request", async () => {
  // The request may have reached GitHub before the command failed, so its
  // failure is ambiguous rather than a clean abort.
  const h = harness({
    mergeCommandError: "connection reset",
    mergedState: "OPEN",
  });
  const result = await h.run();

  assertEqual(result.merged, false);
  const cancel = h.calls.gh.find(
    (args) =>
      args[0] === "pr" &&
      args[1] === "merge" &&
      args.includes("--disable-auto"),
  );
  assert(cancel !== undefined, "a pending request must still be cancelled");
  assert(
    h.output().includes("connection reset"),
    `the command failure must be surfaced, got:\n${h.output()}`,
  );
});

await test("a failing merge command on an already-merged PR reports the merge", async () => {
  // GitHub says MERGED, so the command failure was a reporting failure.
  const h = harness({ mergeCommandError: "connection reset" });
  const result = await h.run();

  assertEqual(result.merged, true, "the merge did land");
  assert(
    h.output().includes("the merge itself landed"),
    `the operator should be told, got:\n${h.output()}`,
  );
});

await test("an unreadable outcome cancels any pending request", async () => {
  // Neither confirmed nor refuted: cancel first, report second.
  const h = harness({ mergeOutcomeError: "gh exploded" });
  const result = await h.run();

  assertEqual(result.merged, false);
  assertEqual(result.verified, false);
  const cancel = h.calls.gh.find(
    (args) =>
      args[0] === "pr" &&
      args[1] === "merge" &&
      args.includes("--disable-auto"),
  );
  assert(cancel !== undefined, "an unreadable outcome must still cancel");
});

await test("only a confirmed merge exits zero", async () => {
  // The CLI's exit status is what `pnpm pr:merge && <post-merge closeout>`
  // branches on. Reporting success for a queued or unverified merge would run
  // the closeout on exactly the states this wrapper refused to call a merge.
  assertEqual(exitCodeForResult({ merged: true, verified: true }), 0);
  assertEqual(exitCodeForResult({ merged: false, queued: true }), 1);
  assertEqual(exitCodeForResult({ merged: false, verified: false }), 1);
  assertEqual(exitCodeForResult(undefined), 1);
  // `--help` is not a merge and must not read as a failure.
  assertEqual(exitCodeForResult({ merged: false, help: true }), 0);

  // Bound to the real results the wrapper returns, so the two cannot drift.
  const queued = await harness({ mergedState: "OPEN" }).run();
  assertEqual(exitCodeForResult(queued), 1, "a queued merge must exit nonzero");
  const unverified = await harness({ mergeOutcomeError: "gh exploded" }).run();
  assertEqual(
    exitCodeForResult(unverified),
    1,
    "an unverified merge must exit nonzero",
  );
  const merged = await harness().run();
  assertEqual(exitCodeForResult(merged), 0, "a confirmed merge must exit zero");
});

await test("the wrapper's own modules stay under the 600-line soft cap", () => {
  // `scripts/` has no `max-lines` lint rule and the file-size watchlist only
  // reports, monthly, against `main` (ADR 0065) — so without this assertion a
  // follow-up can regrow the wrapper past the cap with every per-PR check
  // green. The wrapper was split at 638 lines for exactly that reason.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // ADR 0065 scopes the cap to source, not suites, so the suite is not listed.
  const files = [
    "merge-pr.mjs",
    "merge-pr-core.mjs",
    "merge-pr-io.mjs",
    "merge-pr-github.mjs",
  ];
  const over = files
    .map((file) => ({
      file,
      lines: readFileSync(path.join(here, file), "utf8").split("\n").length,
    }))
    .filter(({ lines }) => lines > SOFT_CAP);
  assertEqual(
    JSON.stringify(over),
    "[]",
    `these files crossed the ${SOFT_CAP}-line soft cap; move code into a focused sibling module`,
  );
});

if (failed > 0) {
  process.stderr.write(`\n${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

process.stdout.write(`\n${passed} passed\n`);

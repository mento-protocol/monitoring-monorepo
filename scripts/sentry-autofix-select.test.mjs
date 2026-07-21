#!/usr/bin/env node
import {
  AUTOFIX_SELECT_LABEL,
  DEFAULT_CAP,
  emitVerdict,
  parseArgs,
  selectAutofixCandidates,
} from "./sentry-autofix-select.mjs";
import { VERDICT_MARKER } from "./sentry-triage-project-core.mjs";
import {
  FIX_PR_OPENED_LABEL,
  FIX_REFUSED_LABEL,
} from "./sentry-triage-ingest.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`not ok ${name}\n  ${message}\n`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertDeepEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

const BOT = { login: "github-actions" };

/** Build a bot-authored verdict comment for a code-fix stub. */
function verdictComment({
  affectedRepo = "mento-protocol/monitoring-monorepo",
  verdict = "code-fix",
  createdAt = "2026-07-18T00:00:00Z",
} = {}) {
  const body = [
    VERDICT_MARKER,
    "",
    "```yaml",
    `verdict: ${verdict}`,
    "confidence: medium",
    `affected_repo: ${affectedRepo}`,
    "summary: A scoped bug",
    "root_cause: |",
    "  Abstract root cause.",
    "proposed_action: |",
    "  Abstract action.",
    "duplicate_of: []",
    "```",
    "",
    "Diagnosis prose.",
  ].join("\n");
  return { author: BOT, body, createdAt };
}

/** Stub fixture: title carries the SHORT-ID (queue contract v2). */
function stub({
  number,
  shortId,
  labels = [AUTOFIX_SELECT_LABEL, "sentry-triage"],
  createdAt = "2026-07-18T00:00:00Z",
  comments = [verdictComment()],
} = {}) {
  return {
    number,
    shortId,
    title: `[sentry] ${shortId} (analytics-mento-org, error)`,
    labels,
    createdAt,
    comments,
  };
}

/**
 * Mock `gh`:
 *  - issue list -> the stub summaries (number/title/labels/createdAt)
 *  - issue view -> the full stub (with comments)
 *  - pr list    -> [] unless the searched SHORT-ID is in `prShortIds` (the
 *                  fixture models an OPEN-PR reference; the selector passes
 *                  `--state open` and a quoted term, which the mock unwraps)
 */
function makeRunGh({ stubs = [], prShortIds = [] } = {}) {
  const calls = [];
  const byNumber = new Map(stubs.map((s) => [String(s.number), s]));
  const runGh = async (args) => {
    calls.push(args);
    const [a0, a1] = args;
    if (a0 === "issue" && a1 === "list") {
      return JSON.stringify(
        stubs.map((s) => ({
          number: s.number,
          title: s.title,
          createdAt: s.createdAt,
          labels: s.labels.map((name) => ({ name })),
        })),
      );
    }
    if (a0 === "issue" && a1 === "view") {
      const s = byNumber.get(String(args[2]));
      return JSON.stringify({
        number: s.number,
        title: s.title,
        body: "",
        labels: s.labels.map((name) => ({ name })),
        comments: s.comments,
      });
    }
    if (a0 === "pr" && a1 === "list") {
      const searched = args[args.indexOf("--search") + 1];
      // The selector quotes the SHORT-ID for exact-phrase matching; unwrap the
      // surrounding quotes so the fixture keys stay the bare SHORT-ID.
      const term = searched.replace(/^"|"$/g, "");
      return JSON.stringify(prShortIds.includes(term) ? [{ number: 1 }] : []);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { runGh, calls };
}

await test("selects oldest local code-fix stubs, capped", async () => {
  const stubs = [
    stub({
      number: 10,
      shortId: "APP-MENTO-ORG-2S",
      createdAt: "2026-07-10T00:00:00Z",
    }),
    stub({
      number: 11,
      shortId: "APP-MENTO-ORG-3T",
      createdAt: "2026-07-11T00:00:00Z",
    }),
    stub({
      number: 12,
      shortId: "APP-MENTO-ORG-4U",
      createdAt: "2026-07-12T00:00:00Z",
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", cap: 2 },
    { runGh },
  );
  assertDeepEqual(selected, [
    { issue: 10, shortId: "APP-MENTO-ORG-2S" },
    { issue: 11, shortId: "APP-MENTO-ORG-3T" },
  ]);
});

await test("batch list excludes handled AND projected stubs server-side", async () => {
  const stubs = [stub({ number: 30, shortId: "APP-MENTO-ORG-6W" })];
  const { runGh, calls } = makeRunGh({ stubs });
  await selectAutofixCandidates({ repo: "o/r", cap: 2 }, { runGh });
  const listCall = calls.find((c) => c[0] === "issue" && c[1] === "list");
  const search = listCall[listCall.indexOf("--search") + 1];
  // The window cap (--limit) applies BEFORE any client-side filter, so every
  // terminal/external state must be excluded in the server-side query or an
  // accumulating backlog would starve newer local candidates out of the window.
  for (const excluded of [
    '-label:"sentry:fix-pr-opened"',
    '-label:"sentry:fix-refused"',
    '-label:"sentry:projected"',
  ]) {
    assert(search.includes(excluded), `search must contain ${excluded}`);
  }
});

await test("skips a stub already labeled sentry:fix-pr-opened", async () => {
  const stubs = [
    stub({
      number: 20,
      shortId: "APP-MENTO-ORG-5V",
      labels: [AUTOFIX_SELECT_LABEL, FIX_PR_OPENED_LABEL],
    }),
    stub({
      number: 21,
      shortId: "APP-MENTO-ORG-6W",
      createdAt: "2026-07-19T00:00:00Z",
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 21, shortId: "APP-MENTO-ORG-6W" }]);
});

await test("emits a RECONCILE entry when an OPEN PR references the SHORT-ID but the stub lacks its marker", async () => {
  // Orphan: the stub reaches the PR check without either terminal marker (they
  // are filtered earlier), so an open PR here means a prior run opened the PR
  // but its queue comment/label write did not land. The selector must route it
  // to no-agent reconciliation, NOT silently drop it (which would leave the
  // queue side-effects permanently unrepaired).
  const stubs = [stub({ number: 30, shortId: "APP-MENTO-ORG-7X" })];
  const { runGh, calls } = makeRunGh({
    stubs,
    prShortIds: ["APP-MENTO-ORG-7X"],
  });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [
    { issue: 30, shortId: "APP-MENTO-ORG-7X", reconcile: true },
  ]);
  // The dedup PR search must be scoped to OPEN PRs (a merged/closed PR must not
  // strand a regressed stub) and must quote the SHORT-ID (exact phrase, not a
  // tokenized substring match).
  const prCall = calls.find((c) => c[0] === "pr" && c[1] === "list");
  assert(prCall, "pr list was queried");
  const state = prCall[prCall.indexOf("--state") + 1];
  const searched = prCall[prCall.indexOf("--search") + 1];
  assert(state === "open", `pr search must be open-only, got ${state}`);
  assert(
    searched === '"APP-MENTO-ORG-7X"',
    `pr search term must be quoted, got ${searched}`,
  );
});

await test("a normal (non-orphan) selection carries no reconcile flag", async () => {
  const stubs = [stub({ number: 31, shortId: "APP-MENTO-ORG-8Y" })];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 31, shortId: "APP-MENTO-ORG-8Y" }]);
  assert(
    !("reconcile" in selected[0]),
    "a real fix entry must not carry a reconcile flag",
  );
});

await test("skips a stub already labeled sentry:fix-refused (retry needs a human)", async () => {
  const stubs = [
    stub({
      number: 32,
      shortId: "APP-MENTO-ORG-7Y",
      labels: [AUTOFIX_SELECT_LABEL, FIX_REFUSED_LABEL],
    }),
    stub({
      number: 33,
      shortId: "APP-MENTO-ORG-7Z",
      createdAt: "2026-07-22T00:00:00Z",
    }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 33, shortId: "APP-MENTO-ORG-7Z" }]);
  // Deduped by label before any PR query for the refused stub.
  assert(
    !calls.some(
      (c) => c[0] === "issue" && c[1] === "view" && String(c[2]) === "32",
    ),
    "refused stub should never be view-read",
  );
});

await test("skips a stub whose verdict targets an external owning repo", async () => {
  const stubs = [
    stub({
      number: 40,
      shortId: "APP-MENTO-ORG-8Y",
      comments: [
        verdictComment({ affectedRepo: "mento-protocol/frontend-monorepo" }),
      ],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
});

await test("skips a stub with an unrecognized affected_repo (not confidently local)", async () => {
  const stubs = [
    stub({
      number: 45,
      shortId: "APP-MENTO-ORG-9Z",
      comments: [verdictComment({ affectedRepo: "totally/unknown" })],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
});

await test("skips a stub whose verdict comment is missing/invalid (fail-soft, no throw)", async () => {
  const stubs = [
    stub({ number: 50, shortId: "APP-MENTO-ORG-AA", comments: [] }),
    stub({
      number: 51,
      shortId: "APP-MENTO-ORG-BB",
      createdAt: "2026-07-20T00:00:00Z",
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 51, shortId: "APP-MENTO-ORG-BB" }]);
});

await test("skips a stub whose title has no parseable SHORT-ID", async () => {
  const bad = stub({ number: 60, shortId: "IGNORED" });
  bad.title = "not a queue title";
  const { runGh } = makeRunGh({ stubs: [bad] });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, []);
});

await test("only queries PRs after cheaper checks pass (no wasted pr list)", async () => {
  const stubs = [
    stub({
      number: 70,
      shortId: "APP-MENTO-ORG-CC",
      labels: [AUTOFIX_SELECT_LABEL, FIX_PR_OPENED_LABEL],
    }),
  ];
  const { runGh, calls } = makeRunGh({ stubs });
  await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assert(
    !calls.some((c) => c[0] === "pr" && c[1] === "list"),
    "should not query PRs for a stub already deduped by label",
  );
});

await test("batch list pre-filters out non-local Sentry projects by title", async () => {
  const external = stub({ number: 82, shortId: "APP-MENTO-ORG-GG" });
  external.title = "[sentry] APP-MENTO-ORG-GG (app-mento-org, error)";
  const local = stub({
    number: 83,
    shortId: "ANALYTICS-MENTO-ORG-HH",
    createdAt: "2026-07-21T00:00:00Z",
  });
  const { runGh, calls } = makeRunGh({ stubs: [external, local] });
  const selected = await selectAutofixCandidates({ repo: "o/r" }, { runGh });
  assertDeepEqual(selected, [{ issue: 83, shortId: "ANALYTICS-MENTO-ORG-HH" }]);
  // The external stub was dropped before any per-candidate verdict read.
  assert(
    !calls.some(
      (c) => c[0] === "issue" && c[1] === "view" && String(c[2]) === "82",
    ),
    "external-project stub should never be view-read",
  );
});

await test("single-issue live run evaluates only that issue through the filters", async () => {
  const stubs = [
    stub({ number: 80, shortId: "APP-MENTO-ORG-DD" }),
    stub({ number: 81, shortId: "APP-MENTO-ORG-EE" }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", issue: 81 },
    { runGh },
  );
  assertDeepEqual(selected, [{ issue: 81, shortId: "APP-MENTO-ORG-EE" }]);
});

await test("single-issue live run rejects an ineligible issue (external repo)", async () => {
  const stubs = [
    stub({
      number: 90,
      shortId: "APP-MENTO-ORG-FF",
      comments: [
        verdictComment({ affectedRepo: "mento-protocol/minipay-dapp" }),
      ],
    }),
  ];
  const { runGh } = makeRunGh({ stubs });
  const selected = await selectAutofixCandidates(
    { repo: "o/r", issue: 90 },
    { runGh },
  );
  assertDeepEqual(selected, []);
});

await test("emitVerdict returns the trusted fence-selected verdict body", async () => {
  const s = stub({ number: 95, shortId: "APP-MENTO-ORG-KK" });
  const { runGh } = makeRunGh({ stubs: [s] });
  const body = await emitVerdict({ repo: "o/r", issue: 95 }, { runGh });
  assert(
    body.includes("affected_repo: mento-protocol/monitoring-monorepo"),
    "verdict body emitted",
  );
});

await test("emitVerdict throws when no trusted verdict comment exists", async () => {
  const s = stub({ number: 96, shortId: "APP-MENTO-ORG-LL", comments: [] });
  const { runGh } = makeRunGh({ stubs: [s] });
  let threw = false;
  try {
    await emitVerdict({ repo: "o/r", issue: 96 }, { runGh });
  } catch {
    threw = true;
  }
  assert(threw, "no-verdict throws");
});

await test("parseArgs defaults and validation", () => {
  const defaults = parseArgs([]);
  assert(defaults.cap === DEFAULT_CAP, "cap defaults");
  const custom = parseArgs(["--repo", "o/r", "--cap", "5"]);
  assert(custom.repo === "o/r" && custom.cap === 5, "custom args parse");
  let threw = false;
  try {
    parseArgs(["--cap", "0"]);
  } catch {
    threw = true;
  }
  assert(threw, "--cap 0 rejected");
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;

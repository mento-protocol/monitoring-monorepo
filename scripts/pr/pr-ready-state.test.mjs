#!/usr/bin/env node
/**
 * Offline unit tests for scripts/pr/pr-ready-state.mjs parsing helpers.
 */

import { readFileSync } from "node:fs";
import "./pr-stack-ready-state.test.mjs";
import "./pr-ready-state-classic-protection.test.mjs";
import "./pr-stack-recover.test.mjs";

import {
  classifyCheck,
  findTopLevelBotComments,
  findTopLevelBotReviewComments,
  findUnrepliedRootReviewComments,
  findUnresolvedReviewThreads,
  groupStatusChecks,
  hasCodexApprovalReaction,
  hasCodexInFlightReaction,
  classifyCodexReviewSignal,
  isCodexReviewRequestBody,
  parseReadinessOverrideComment,
  summarizeReadyState,
  summarizeTerminalReadyState,
  splitRequiredAndOptionalChecks,
} from "./pr-ready-state-core.mjs";
import { formatCompact, formatHuman } from "./pr-ready-state-format.mjs";
import { verifyReadinessSnapshot } from "./pr-ready-state-stack.mjs";
import { latestSettledChecksByIdentity } from "./pr-ready-state-base-health.mjs";
import {
  annotateStatusCheckSources,
  fetchBaseBranchHealth,
  fetchRequiredStatusContexts,
  fetchReadinessBases,
  fetchHeadUpdatedAt,
  headUpdatedAtFromTimeline,
  parseArgs,
  renderSummary,
  repoFromPullRequestUrl,
  requiredStatusContextsFromProtection,
  requiredStatusContextsFromRules,
  requiredStatusContextsFromRulesResult,
  strictRequiredStatusChecksPolicyFromRules,
  splitRepo,
  watchLoopExitCode,
  workflowPathsFromRules,
} from "./pr-ready-state.mjs";

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTest(name, fn) {
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
    // The message is what says WHICH property was being asserted; call sites
    // already pass one, and dropping it left a bare value mismatch to read.
    throw new Error(
      `${message ? `${message}: ` : ""}expected ${JSON.stringify(
        expected,
      )}, got ${JSON.stringify(actual)}`,
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

const basePr = {
  number: 123,
  url: "https://github.com/mento-protocol/monitoring-monorepo/pull/123",
  title: "Tighten PR readiness checks",
  author: { login: "chapati23" },
  isDraft: false,
  headRefName: "chore/pr-ready-state",
  headRefOid: "abc123",
  headUpdatedAt: "2026-05-21T13:22:23Z",
  commits: [
    {
      oid: "abc123",
      committedDate: "2026-05-21T13:22:23Z",
    },
  ],
  baseRefName: "main",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
    { name: "test", conclusion: "FAILURE", status: "COMPLETED" },
    { name: "build", status: "IN_PROGRESS", conclusion: null },
    { name: "optional", conclusion: "SKIPPED", status: "COMPLETED" },
  ],
};

test("assertEqual reports the message its call site passed", () => {
  let thrown = null;
  try {
    assertEqual(3, 10, "the count is the signal; the list is an affordance");
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  assert(thrown !== null, "a mismatch must throw");
  assert(
    thrown.includes("the count is the signal; the list is an affordance"),
    `the failure output must name what was asserted; got: ${thrown}`,
  );
  assert(thrown.includes("expected 10, got 3"), `values kept: ${thrown}`);
});

test("classifies checks by GitHub status and conclusion", () => {
  assertEqual(classifyCheck({ conclusion: "SUCCESS" }), "pass");
  assertEqual(classifyCheck({ conclusion: "FAILURE" }), "fail");
  assertEqual(classifyCheck({ status: "QUEUED", conclusion: null }), "pending");
  assertEqual(classifyCheck({ conclusion: "NEUTRAL" }), "skipped");
  assertEqual(classifyCheck({ conclusion: "STALE" }), "fail");
  assertEqual(classifyCheck({}), "pending");
});

test("parses host-qualified repo arguments from the rightmost owner and name", () => {
  assertDeepEqual(splitRepo("mento-protocol/monitoring-monorepo"), {
    owner: "mento-protocol",
    name: "monitoring-monorepo",
    host: null,
  });
  assertDeepEqual(splitRepo("github.example.com/org/repo"), {
    owner: "org",
    name: "repo",
    host: "github.example.com",
  });
});

test("resolves API repo identity from pull request URL", () => {
  assertDeepEqual(
    repoFromPullRequestUrl("https://github.example.com/org/repo/pull/123"),
    {
      owner: "org",
      name: "repo",
      host: "github.example.com",
    },
  );
});

test("parses explicit help without requiring a PR argument", () => {
  assertDeepEqual(parseArgs(["--help"]), {
    help: true,
    json: false,
    compact: false,
    watch: false,
    untilReady: false,
    prArg: null,
    repoArg: null,
  });
});

test("parses watch until-ready mode without changing other flags", () => {
  assertDeepEqual(parseArgs(["123", "--watch", "--compact", "--until-ready"]), {
    json: false,
    compact: true,
    watch: true,
    untilReady: true,
    prArg: "123",
    repoArg: undefined,
  });
});

test("rejects until-ready outside watch mode", () => {
  assertThrows(
    () => parseArgs(["123", "--until-ready"]),
    "--until-ready requires --watch",
  );
});

test("rejects missing flag values at the CLI boundary", () => {
  assertThrows(
    () => parseArgs(["--repo", "--pr", "123"]),
    "--repo requires a value",
  );
  assertThrows(() => parseArgs(["--pr"]), "--pr requires a value");
});

test("extracts required status contexts from branch rulesets", () => {
  assertDeepEqual(
    requiredStatusContextsFromRules([
      { type: "deletion" },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "ci" },
            { context: "Vercel" },
            { context: "ci" },
          ],
        },
      },
    ]),
    [
      { context: "ci", integrationId: null },
      { context: "Vercel", integrationId: null },
    ],
  );
});

test("extracts required status contexts from nested branch rulesets", () => {
  const rulesets = [
    {
      id: 1,
      name: "required checks",
      rules: [
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "ci", integration_id: 15368 },
              { context: "Vercel", integration_id: 8329 },
            ],
          },
        },
      ],
    },
  ];

  assertDeepEqual(requiredStatusContextsFromRules(rulesets), [
    { context: "ci", integrationId: 15368 },
    { context: "Vercel", integrationId: 8329 },
  ]);
});

test("reads strict_required_status_checks_policy off a required_status_checks rule", () => {
  for (const strict of [true, false]) {
    assertEqual(
      strictRequiredStatusChecksPolicyFromRules([
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "ci" }],
            strict_required_status_checks_policy: strict,
          },
        },
      ]),
      strict,
    );
  }
  assertEqual(
    strictRequiredStatusChecksPolicyFromRules([
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci" }] },
      },
    ]),
    null,
    "a rule with no strict field is unknown, not false",
  );
  assertEqual(
    strictRequiredStatusChecksPolicyFromRules([{ type: "deletion" }]),
    null,
    "no required_status_checks rule is unknown",
  );

  // A base can carry more than one applicable `required_status_checks` rule
  // (e.g. an org ruleset layered with a repo ruleset). GitHub enforces the
  // most restrictive, so any confirmed `true` wins regardless of order.
  const strictRule = {
    type: "required_status_checks",
    parameters: {
      required_status_checks: [{ context: "ci" }],
      strict_required_status_checks_policy: true,
    },
  };
  const nonStrictRule = {
    type: "required_status_checks",
    parameters: {
      required_status_checks: [{ context: "Vercel" }],
      strict_required_status_checks_policy: false,
    },
  };
  const unstatedRule = {
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "Code Quality" }] },
  };
  assertEqual(
    strictRequiredStatusChecksPolicyFromRules([nonStrictRule, strictRule]),
    true,
    "a stricter later rule must still win",
  );
  assertEqual(
    strictRequiredStatusChecksPolicyFromRules([strictRule, nonStrictRule]),
    true,
    "a stricter earlier rule must win",
  );
  assertEqual(
    strictRequiredStatusChecksPolicyFromRules([nonStrictRule, nonStrictRule]),
    false,
    "false only when every matching rule explicitly disables strict mode",
  );
  assertEqual(
    strictRequiredStatusChecksPolicyFromRules([nonStrictRule, unstatedRule]),
    null,
    "an unstated rule keeps the aggregate unknown, never false",
  );
});

test("extracts app-bound required status contexts from branch protection details", () => {
  assertDeepEqual(
    requiredStatusContextsFromProtection({
      contexts: ["ci", "Code Quality"],
      checks: [
        { context: "ci", app_id: 15368 },
        { context: "Code Quality", app_id: 15368 },
      ],
    }),
    [
      { context: "ci", integrationId: 15368 },
      { context: "Code Quality", integrationId: 15368 },
    ],
  );
});

test("falls back to bare branch protection contexts when check details are absent", () => {
  assertDeepEqual(
    requiredStatusContextsFromProtection({ contexts: ["ci", "Vercel"] }),
    [
      { context: "ci", integrationId: null },
      { context: "Vercel", integrationId: null },
    ],
  );
});

test("uses classic branch protection required status contexts when available", async () => {
  let rulesCalls = 0;
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: true,
      value: { contexts: ["ci", "Vercel"] },
    }),
    fetchRules: async () => {
      rulesCalls += 1;
      return { ok: true, value: [] };
    },
  });

  assertDeepEqual(result, {
    contexts: [
      { context: "ci", integrationId: null },
      { context: "Vercel", integrationId: null },
    ],
    error: null,
    strict: null,
  });
  assertEqual(
    rulesCalls,
    1,
    "an unconfirmed classic strict reading must also consult rulesets",
  );
});

test("reads the strict policy straight off classic protection when no ruleset applies", async () => {
  for (const strict of [true, false]) {
    let rulesCalls = 0;
    const result = await fetchRequiredStatusContexts({
      repo: {
        owner: "mento-protocol",
        name: "monitoring-monorepo",
        host: null,
      },
      baseRef: "main",
      fetchProtection: async () => ({
        ok: true,
        value: { contexts: ["ci"], strict },
      }),
      fetchRules: async () => {
        rulesCalls += 1;
        return { ok: true, value: [] };
      },
    });
    assertEqual(result.strict, strict);
    assertEqual(
      rulesCalls,
      1,
      "rulesets are always consulted for ruleset-only required contexts, even once classic already confirms strict",
    );
  }
});

test("unions ruleset-only required contexts with classic protection's contexts", async () => {
  for (const strict of [true, false]) {
    const result = await fetchRequiredStatusContexts({
      repo: {
        owner: "mento-protocol",
        name: "monitoring-monorepo",
        host: null,
      },
      baseRef: "main",
      fetchProtection: async () => ({
        ok: true,
        value: { contexts: ["ci"], strict },
      }),
      fetchRules: async () => ({
        ok: true,
        value: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "Ruleset Only Check" }],
              strict_required_status_checks_policy: strict,
            },
          },
        ],
      }),
    });

    assertDeepEqual(
      result.contexts,
      [
        { context: "ci", integrationId: null },
        { context: "Ruleset Only Check", integrationId: null },
      ],
      "a ruleset-only required check must not be dropped when classic protection also applies",
    );
  }
});

test("aggregates a stricter ruleset over classic protection's confirmed non-strict flag", async () => {
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: true,
      value: { contexts: ["ci"], strict: false },
    }),
    fetchRules: async () => ({
      ok: true,
      value: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "ci" }],
            strict_required_status_checks_policy: true,
          },
        },
      ],
    }),
  });

  assertEqual(
    result.strict,
    true,
    "a ruleset confirming strict must not be shadowed by classic protection's false",
  );
});

test("fails closed when a ruleset reports false but classic protection's strict is unknown", async () => {
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: true,
      value: { contexts: ["ci"] },
    }),
    fetchRules: async () => ({
      ok: true,
      value: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "ci" }],
            strict_required_status_checks_policy: false,
          },
        },
      ],
    }),
  });

  assertEqual(
    result.strict,
    null,
    "an unknown classic reading could still mean strict mode is on; a ruleset's false alone cannot demote it",
  );
});

test("fails closed when rulesets cannot be read after classic protection reports non-strict", async () => {
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: true,
      value: { contexts: ["ci"], strict: false },
    }),
    fetchRules: async () => ({
      ok: false,
      error: "gh: Resource not accessible by integration (HTTP 403)",
    }),
  });

  assertEqual(
    result.strict,
    null,
    "an unreadable ruleset means a stricter override cannot be ruled out",
  );
});

test("fails closed on required-status-context error when the ruleset read fails after classic protection succeeds", async () => {
  // Classic protection succeeding no longer means requiredStatusContexts is
  // complete: a ruleset can add required contexts classic protection does
  // not know about, so a failed ruleset read must not be swallowed as
  // `error: null` — that would let `fetchReadyState` treat classicContexts
  // as the full set and misclassify a missing ruleset-only check as
  // optional (see "fails closed when required status contexts cannot be
  // fetched" for the resulting `summarizeReadyState` blocker).
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: true,
      value: { contexts: ["ci"] },
    }),
    fetchRules: async () => ({
      ok: false,
      error: "gh: Resource not accessible by integration (HTTP 403)",
    }),
  });

  assertEqual(
    result.error,
    "gh: Resource not accessible by integration (HTTP 403)",
    "a failed ruleset read must propagate as a required-status-context error, not be swallowed",
  );
});

test("falls back to rulesets for the current gh branch-protection 404", async () => {
  // The same two-signal proof gates the context list, not just strictness. A
  // permission-masked 404 could be hiding a classic-only required check, so the
  // ruleset list cannot be called complete and the caller must fail closed.
  const rules = async () => ({
    ok: true,
    value: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [
            { context: "ci" },
            { context: "Code Quality" },
          ],
        },
      },
    ],
  });
  const expectedContexts = [
    { context: "ci", integrationId: null },
    { context: "Code Quality", integrationId: null },
  ];

  const masked = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: false,
      error:
        "gh api repos/mento-protocol/monitoring-monorepo/branches/main/protection/required_status_checks failed with exit 1:\ngh: Not Found (HTTP 404)\n",
    }),
    fetchRules: rules,
    fetchBranch: async () => rulesetOnlyBranch,
    fetchClassicProtection: async () => ({
      ok: false,
      error: "unreadable GraphQL",
    }),
  });
  assertDeepEqual(masked.contexts, expectedContexts);
  assert(
    masked.error?.includes("without proving absence"),
    "an unproven 404 must propagate an error, not report the list complete",
  );
  assert(
    !masked.error.includes("\n"),
    "the blocker text must stay on one line",
  );
  assertEqual(masked.strict, null);

  // Proven absence is what makes the ruleset list authoritative.
  const proven = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: false,
      error: "gh: Branch not protected (HTTP 404)",
    }),
    fetchRules: rules,
    fetchBranch: async () => rulesetOnlyBranch,
    fetchClassicProtection: async () => ({
      ok: false,
      error: "unreadable GraphQL",
    }),
  });
  assertDeepEqual(proven, {
    contexts: expectedContexts,
    error: null,
    strict: null,
  });
});

test("a permission-masked classic 404 blocks readiness end to end", async () => {
  // The whole point of propagating the error: a hidden classic-only required
  // check must not be classified as optional. Drive the real probe output, not
  // just the fetch helper.
  const contexts = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: false,
      error: "gh: Not Found (HTTP 404)",
    }),
    fetchRules: async () => ({
      ok: true,
      value: [
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci" }] },
        },
      ],
    }),
    fetchBranch: async () => rulesetOnlyBranch,
    fetchClassicProtection: async () => ({
      ok: false,
      error: "unreadable GraphQL",
    }),
  });

  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    requiredStatusContexts: contexts.contexts,
    requiredStatusContextsError: contexts.error,
    requiredStatusContextsAvailable: contexts.error === null,
    requiredStatusChecksStrict: contexts.strict,
    baseHealthOid: "a".repeat(40),
    baseStatusCheckRollup: [
      { name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
    ],
  });

  assertEqual(
    summary.ready,
    false,
    "an unproven classic 404 must not report ready",
  );
  assertEqual(
    summary.required.blockers.filter(
      (item) => item.kind === "branch-protection",
    ).length,
    1,
    "the caller must raise its branch-protection blocker",
  );
});

test("treats an unconfigured required-status-checks 404 as proven absence", async () => {
  // A base can carry classic protection for reviews or restrictions while
  // having no required-status-checks configuration. GitHub answers this only
  // after reading that protection, so there is no classic context or `strict`
  // flag to miss — and blocking it would strand a valid setup forever.
  let branchReads = 0;
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: false,
      error: "gh: Required status checks not enabled (HTTP 404)",
    }),
    fetchRules: async () => ({
      ok: true,
      value: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "ci" }],
            strict_required_status_checks_policy: false,
          },
        },
      ],
    }),
    fetchBranch: async () => {
      branchReads += 1;
      // Classic protection is enabled here; only the status-check block is
      // missing, so the branch object must not be what decides this.
      return { ok: true, value: { protection: { enabled: true } } };
    },
  });

  assertDeepEqual(result.contexts, [{ context: "ci", integrationId: null }]);
  assertEqual(result.error, null, "the ruleset list is complete here");
  assertEqual(result.strict, false, "there is no classic strict flag to miss");
  assertEqual(
    branchReads,
    0,
    "the message is conclusive; no branch read is needed",
  );
});

test("fails closed on the context list for every unproven classic 404", async () => {
  const rules = async () => ({
    ok: true,
    value: [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci" }] },
      },
    ],
  });

  for (const [label, protectionError, branchResult] of [
    [
      "a permission-masking 404",
      "gh: Not Found (HTTP 404)",
      { ok: true, value: rulesetOnlyBranch.value },
    ],
    [
      "classic protection still enabled",
      "gh: Branch not protected (HTTP 404)",
      { ok: true, value: { protection: { enabled: true } } },
    ],
    [
      "an unreadable branch object",
      "gh: Branch not protected (HTTP 404)",
      { ok: false, error: "gh: Resource not accessible by integration" },
    ],
  ]) {
    const result = await fetchRequiredStatusContexts({
      repo: {
        owner: "mento-protocol",
        name: "monitoring-monorepo",
        host: null,
      },
      baseRef: "main",
      fetchProtection: async () => ({ ok: false, error: protectionError }),
      fetchRules: rules,
      fetchBranch: async () => branchResult,
      fetchClassicProtection: async () => ({
        ok: false,
        error: "unreadable GraphQL",
      }),
    });

    assert(
      result.error !== null,
      `${label} must leave the context list unavailable`,
    );
    assertEqual(result.strict, null, `${label} must leave strictness unknown`);
  }
});

// A classic-protection 404 alone cannot license a ruleset's non-strict value:
// GitHub returns 404 both when classic protection is absent and when the token
// may not read it. Probed against this repository on 2026-09-15:
// `branches/main/protection/required_status_checks` answers "Branch not
// protected (HTTP 404)", while `branches/main` answers `protected: true`
// (rulesets set that flag) with `protection.enabled: false`. So absence needs
// the exact 404 message *and* `protection.enabled === false`; the top-level
// `protected` flag is useless here.
function nonStrictRulesetFetchers(protectionError, branchResult) {
  return {
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({ ok: false, error: protectionError }),
    fetchRules: async () => ({
      ok: true,
      value: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "ci" }],
            strict_required_status_checks_policy: false,
          },
        },
      ],
    }),
    fetchBranch: async () => branchResult,
    fetchClassicProtection: async () => ({
      ok: false,
      error: "unreadable GraphQL",
    }),
  };
}

const rulesetOnlyBranch = {
  ok: true,
  value: {
    name: "main",
    protected: true,
    protection: { enabled: false, required_status_checks: { contexts: [] } },
  },
};

test("trusts a ruleset's non-strict policy once classic protection is proven absent", async () => {
  const result = await fetchRequiredStatusContexts(
    nonStrictRulesetFetchers(
      "gh api repos/mento-protocol/monitoring-monorepo/branches/main/protection/required_status_checks failed with exit 1:\ngh: Branch not protected (HTTP 404)\n",
      rulesetOnlyBranch,
    ),
  );

  assertEqual(
    result.strict,
    false,
    "the live ruleset-only shape must let the ruleset's false stand",
  );
});

test("fails closed when a classic-protection 404 could be a permission gap", async () => {
  const result = await fetchRequiredStatusContexts(
    nonStrictRulesetFetchers(
      "gh api repos/mento-protocol/monitoring-monorepo/branches/main/protection/required_status_checks failed with exit 1:\ngh: Not Found (HTTP 404)\n",
      rulesetOnlyBranch,
    ),
  );

  assertEqual(
    result.strict,
    null,
    "a bare Not Found may mask an unreadable classic strict: true",
  );
});

test("fails closed when classic protection is enabled despite a 404", async () => {
  const result = await fetchRequiredStatusContexts(
    nonStrictRulesetFetchers("gh: Branch not protected (HTTP 404)", {
      ok: true,
      value: { protected: true, protection: { enabled: true } },
    }),
  );

  assertEqual(
    result.strict,
    null,
    "an enabled classic protection contradicts the 404 and must not be trusted",
  );
});

test("fails closed when the base branch read fails", async () => {
  const result = await fetchRequiredStatusContexts(
    nonStrictRulesetFetchers("gh: Branch not protected (HTTP 404)", {
      ok: false,
      error: "gh: Resource not accessible by integration (HTTP 403)",
    }),
  );

  assertEqual(
    result.strict,
    null,
    "classic absence cannot be established without the branch read",
  );
});

test("proves classic absence on every 404, whatever the ruleset says", async () => {
  // The branch read is no longer skipped for strict or unknown rulesets: the
  // context list needs the same proof, so one read serves both decisions.
  for (const [strictPolicy, expected] of [
    [true, true],
    [undefined, null],
  ]) {
    let branchReads = 0;
    const result = await fetchRequiredStatusContexts({
      repo: {
        owner: "mento-protocol",
        name: "monitoring-monorepo",
        host: null,
      },
      baseRef: "main",
      fetchProtection: async () => ({
        ok: false,
        error: "gh: Branch not protected (HTTP 404)",
      }),
      fetchRules: async () => ({
        ok: true,
        value: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "ci" }],
              ...(strictPolicy === undefined
                ? {}
                : { strict_required_status_checks_policy: strictPolicy }),
            },
          },
        ],
      }),
      fetchBranch: async () => {
        branchReads += 1;
        return rulesetOnlyBranch;
      },
    });

    assertEqual(result.strict, expected);
    assertEqual(
      branchReads,
      1,
      "classic absence is established once and reused by both decisions",
    );
    assertEqual(
      result.error,
      null,
      "proven absence makes the ruleset context list authoritative",
    );
  }
});

test("fails closed when branch protection is absent and rulesets are unavailable", async () => {
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: false,
      error: "gh: Not Found (HTTP 404)",
    }),
    fetchRules: async () => ({
      ok: false,
      error: "gh: Resource not accessible by integration (HTTP 403)",
    }),
  });

  assertDeepEqual(result, {
    contexts: [],
    error: "gh: Resource not accessible by integration (HTTP 403)",
    strict: null,
  });
});

test("fails closed when a protection 404 yields no ruleset-required contexts", async () => {
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: false,
      error: "gh: Not Found (HTTP 404)",
    }),
    fetchRules: async () => ({ ok: true, value: [{ type: "deletion" }] }),
    fetchBranch: async () => ({ ok: false, error: "unreadable branch" }),
    fetchClassicProtection: async () => ({
      ok: false,
      error: "unreadable GraphQL",
    }),
  });

  assertDeepEqual(result, {
    contexts: [],
    error:
      "Required status contexts unavailable: classic branch protection returned HTTP 404 and branch rulesets did not define required status checks or workflows",
    strict: null,
  });
});

test("fails closed without reading rulesets for non-404 protection errors", async () => {
  let rulesCalls = 0;
  const result = await fetchRequiredStatusContexts({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchProtection: async () => ({
      ok: false,
      error: "gh: Resource not accessible by integration (HTTP 403)",
    }),
    fetchRules: async () => {
      rulesCalls += 1;
      return { ok: true, value: [] };
    },
  });

  assertDeepEqual(result, {
    contexts: [],
    error: "gh: Resource not accessible by integration (HTTP 403)",
    strict: null,
  });
  assertEqual(rulesCalls, 0, "non-404 errors must not trigger a fallback");
});

test("extracts required workflow contexts from branch rulesets", () => {
  const rules = [
    {
      type: "workflows",
      parameters: {
        workflows: [
          { path: ".github/workflows/ci.yml" },
          { path: ".github/workflows/quality.yml", name: "Code Quality" },
        ],
      },
    },
  ];
  const workflowNameByPath = new Map([[".github/workflows/ci.yml", "ci"]]);

  assertDeepEqual(workflowPathsFromRules(rules), [
    ".github/workflows/ci.yml",
    ".github/workflows/quality.yml",
  ]);
  assertDeepEqual(
    requiredStatusContextsFromRules(rules, { workflowNameByPath }),
    [
      { context: "ci", integrationId: null },
      { context: "Code Quality", integrationId: null },
    ],
  );
});

test("extracts required workflow contexts from nested branch rulesets", () => {
  const rulesets = [
    {
      id: 1,
      rules: [
        {
          type: "workflows",
          parameters: {
            workflows: [{ path: ".github/workflows/ci.yml" }],
          },
        },
      ],
    },
  ];
  const workflowNameByPath = new Map([[".github/workflows/ci.yml", "ci"]]);

  assertDeepEqual(workflowPathsFromRules(rulesets), [
    ".github/workflows/ci.yml",
  ]);
  assertDeepEqual(
    requiredStatusContextsFromRules(rulesets, { workflowNameByPath }),
    [{ context: "ci", integrationId: null }],
  );
});

test("resolves required workflow contexts from the ruleset source repo", () => {
  const rulesets = [
    {
      ruleset_source: "mento-protocol/shared-workflows",
      ruleset_source_type: "Repository",
      rules: [
        {
          type: "workflows",
          parameters: {
            workflows: [{ path: ".github/workflows/ci.yml" }],
          },
        },
      ],
    },
  ];
  const workflowNameByPath = new Map([
    ["mento-protocol/shared-workflows\0.github/workflows/ci.yml", "ci"],
  ]);

  assertDeepEqual(
    requiredStatusContextsFromRules(rulesets, {
      workflowNameByPath,
      fallbackRepoPath: "mento-protocol/monitoring-monorepo",
    }),
    [{ context: "ci", integrationId: null }],
  );
});

test("derives required workflow contexts from emitted job check names", () => {
  const rulesets = [
    {
      ruleset_source: "mento-protocol/shared-workflows",
      ruleset_source_type: "Repository",
      rules: [
        {
          type: "workflows",
          parameters: {
            workflows: [{ path: ".github/workflows/ci.yml" }],
          },
        },
      ],
    },
  ];
  const workflowNameByPath = new Map([
    ["mento-protocol/shared-workflows\0.github/workflows/ci.yml", "CI"],
  ]);

  assertDeepEqual(
    requiredStatusContextsFromRules(rulesets, {
      workflowNameByPath,
      fallbackRepoPath: "mento-protocol/monitoring-monorepo",
      statusCheckRollup: [
        { name: "lint", workflowName: "CI" },
        { name: "test", workflowName: "CI" },
        { name: "docs", workflowName: "Docs" },
      ],
    }),
    [
      { context: "lint", integrationId: null },
      { context: "test", integrationId: null },
    ],
  );
});

test("fails closed when a required workflow source repository is unresolved", () => {
  const result = requiredStatusContextsFromRulesResult(
    [
      {
        ruleset_source: "mento-protocol",
        ruleset_source_type: "Organization",
        rules: [
          {
            type: "workflows",
            parameters: {
              workflows: [{ path: ".github/workflows/ci.yml" }],
            },
          },
        ],
      },
    ],
    { fallbackRepoPath: "mento-protocol/monitoring-monorepo" },
  );

  assertEqual(
    result.error,
    "Unable to resolve source repository for required workflow(s): .github/workflows/ci.yml",
  );
  assertDeepEqual(result.contexts, []);
});

test("fails closed when workflow-name lookup fails for workflow rules", () => {
  const result = requiredStatusContextsFromRulesResult(
    [
      {
        type: "workflows",
        parameters: {
          workflows: [{ path: ".github/workflows/ci.yml" }],
        },
      },
    ],
    { workflowNameLookupError: "HTTP 403" },
  );

  assertDeepEqual(result, { contexts: [], error: "HTTP 403" });
});

test("skips workflow rules when no workflow check name can be resolved", () => {
  assertDeepEqual(
    requiredStatusContextsFromRules([
      {
        type: "workflows",
        parameters: {
          workflows: [{ path: ".github/workflows/unknown.yml" }],
        },
      },
    ]),
    [],
  );
});

test("does not overwrite check-run app identity with status source annotation", () => {
  const checks = [
    {
      name: "ci",
      app: { id: 15368 },
      conclusion: "SUCCESS",
      status: "COMPLETED",
    },
    { context: "ci", state: "SUCCESS" },
  ];
  const annotated = annotateStatusCheckSources(
    checks,
    new Map([["ci", { appId: 8329 }]]),
  );

  assertEqual(annotated[0].app.id, 15368);
  assertEqual(annotated[0].appId, undefined);
  assertEqual(annotated[1].appId, 8329);
});

test("groups status check rollup into stable pass/fail/pending/skipped buckets", () => {
  const grouped = groupStatusChecks(basePr.statusCheckRollup);
  assertDeepEqual(
    {
      pass: grouped.pass.map((check) => check.name),
      fail: grouped.fail.map((check) => check.name),
      pending: grouped.pending.map((check) => check.name),
      skipped: grouped.skipped.map((check) => check.name),
    },
    {
      pass: ["lint"],
      fail: ["test"],
      pending: ["build"],
      skipped: ["optional"],
    },
  );
});

test("hides cancelled check runs superseded by a newer passing run", () => {
  const checks = [
    {
      name: "PR description format",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "CANCELLED",
      startedAt: "2026-07-06T15:32:37Z",
      completedAt: "2026-07-06T15:32:43Z",
    },
    {
      name: "PR description format",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "CANCELLED",
      startedAt: "2026-07-06T15:32:52Z",
      completedAt: "2026-07-06T15:33:10Z",
    },
    {
      name: "PR description format",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-07-06T15:32:57Z",
      completedAt: "2026-07-06T15:33:09Z",
    },
  ];

  const grouped = groupStatusChecks(checks);
  const split = splitRequiredAndOptionalChecks(checks, [], {
    requiredStatusContextsAvailable: true,
  });

  assertDeepEqual(
    {
      pass: grouped.pass.map((check) => check.name),
      fail: grouped.fail.map((check) => check.name),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      pass: ["PR description format"],
      fail: [],
      optional: ["PR description format:pass"],
    },
  );
});

test("keeps cancelled check runs without a newer passing replacement", () => {
  const checks = [
    {
      name: "PR description format",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-07-06T15:32:37Z",
      completedAt: "2026-07-06T15:32:43Z",
    },
    {
      name: "PR description format",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "CANCELLED",
      startedAt: "2026-07-06T15:32:52Z",
      completedAt: "2026-07-06T15:32:55Z",
    },
  ];

  const grouped = groupStatusChecks(checks);
  const split = splitRequiredAndOptionalChecks(checks, [], {
    requiredStatusContextsAvailable: true,
  });

  assertDeepEqual(
    {
      pass: grouped.pass.map((check) => check.name),
      fail: grouped.fail.map((check) => check.name),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      pass: ["PR description format"],
      fail: ["PR description format"],
      optional: ["PR description format:pass", "PR description format:fail"],
    },
  );
});

test("keeps cancelled check runs when run timestamps are unavailable", () => {
  const checks = [
    {
      name: "cancel-without-time",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "CANCELLED",
    },
    {
      name: "cancel-without-time",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-07-06T15:33:09Z",
    },
    {
      name: "pass-without-time",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
    {
      name: "pass-without-time",
      workflowName: "PR Description",
      status: "COMPLETED",
      conclusion: "CANCELLED",
      startedAt: "2026-07-06T15:32:52Z",
    },
  ];

  const grouped = groupStatusChecks(checks);

  assertDeepEqual(
    {
      pass: grouped.pass.map((check) => check.name),
      fail: grouped.fail.map((check) => check.name),
    },
    {
      pass: ["cancel-without-time", "pass-without-time"],
      fail: ["cancel-without-time", "pass-without-time"],
    },
  );
});

test("splits known advisory checks into optional lag when branch protection data is unavailable", () => {
  const split = splitRequiredAndOptionalChecks([
    { name: "Code Quality", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "GraphQL schema diff", status: "IN_PROGRESS", conclusion: null },
    { name: "jscpd", status: "IN_PROGRESS", conclusion: null },
  ]);

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["Code Quality:pass"],
      optional: ["GraphQL schema diff:pending", "jscpd:pending"],
    },
  );
});

test("honors branch-protection required status contexts when available", () => {
  const split = splitRequiredAndOptionalChecks(
    [
      { name: "jscpd", status: "IN_PROGRESS", conclusion: null },
      { name: "advisory", status: "IN_PROGRESS", conclusion: null },
    ],
    ["jscpd"],
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["jscpd:pending"],
      optional: ["advisory:pending"],
    },
  );
});

test("marks missing required status contexts as pending blockers", () => {
  const split = splitRequiredAndOptionalChecks(
    [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    ["ci", "Vercel"],
  );

  assertDeepEqual(
    split.required.map((check) => `${check.name}:${check.state}`),
    ["ci:pass", "Vercel:pending"],
  );
});

test("treats an empty required status context list as authoritative when available", () => {
  const split = splitRequiredAndOptionalChecks(
    [{ name: "ci", status: "IN_PROGRESS", conclusion: null }],
    [],
    { requiredStatusContextsAvailable: true },
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => check.name),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: [],
      optional: ["ci:pending"],
    },
  );
});

test("requires matching integration id when required checks specify an app source", () => {
  const split = splitRequiredAndOptionalChecks(
    [
      {
        name: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 999,
      },
      {
        name: "Code Quality",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 15368,
      },
    ],
    [
      { context: "ci", integrationId: 15368 },
      { context: "Code Quality", integrationId: 15368 },
    ],
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["ci:pending", "Code Quality:pass"],
      optional: ["ci:pass"],
    },
  );
});

test("does not satisfy integration-bound required checks with unknown app source", () => {
  const split = splitRequiredAndOptionalChecks(
    [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    [{ context: "ci", integrationId: 15368 }],
  );

  assertDeepEqual(
    {
      required: split.required.map((check) => `${check.name}:${check.state}`),
      optional: split.optional.map((check) => `${check.name}:${check.state}`),
    },
    {
      required: ["ci:pending"],
      optional: ["ci:pass"],
    },
  );
});

test("does not collapse duplicate required contexts from different app sources", () => {
  const split = splitRequiredAndOptionalChecks(
    [
      {
        name: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 15368,
      },
    ],
    [
      { context: "ci", integrationId: 15368 },
      { context: "ci", integrationId: 999 },
    ],
  );

  assertDeepEqual(
    split.required.map((check) => `${check.name}:${check.state}`),
    ["ci:pass", "ci:pending"],
  );
});

test("one check satisfies both an unbound and an app-bound required context of the same name", () => {
  // Classic protection can require a bare "ci" (no app) while a ruleset also
  // requires "ci" from a specific app — fetchRequiredStatusContexts unions
  // both into requiredStatusContexts. The single "ci" check GitHub reports
  // for that app satisfies both entries; crediting only the first (the
  // unbound one, since it matches unconditionally) left the app-bound entry
  // permanently "pending" even though nothing further could ever satisfy it.
  const split = splitRequiredAndOptionalChecks(
    [
      {
        name: "ci",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        appId: 15368,
      },
    ],
    [
      { context: "ci", integrationId: null },
      { context: "ci", integrationId: 15368 },
    ],
  );

  assertDeepEqual(
    split.required.map((check) => `${check.name}:${check.state}`),
    ["ci:pass"],
  );
});

test("finds unresolved review threads and keeps useful location metadata", () => {
  const unresolved = findUnresolvedReviewThreads([
    {
      id: "thread-1",
      isResolved: false,
      isOutdated: false,
      path: "scripts/pr-ready-state.mjs",
      line: 42,
      comments: {
        nodes: [
          {
            url: "https://github.com/example/thread-1",
            body: "please reply",
            author: { login: "reviewer" },
          },
        ],
      },
    },
    { id: "thread-2", isResolved: true, path: "README.md" },
  ]);

  assertDeepEqual(unresolved, [
    {
      id: "thread-1",
      path: "scripts/pr-ready-state.mjs",
      line: 42,
      isOutdated: false,
      author: "reviewer",
      url: "https://github.com/example/thread-1",
      body: "please reply",
    },
  ]);
});

test("finds root review comments with no direct replies", () => {
  const unreplied = findUnrepliedRootReviewComments([
    {
      id: 10,
      body: "root with reply",
      path: "a.ts",
      line: 1,
      user: { login: "reviewer" },
    },
    { id: 11, in_reply_to_id: 10, body: "reply", user: { login: "agent" } },
    {
      id: 12,
      body: "root without reply",
      path: "b.ts",
      original_line: 5,
      html_url: "https://github.com/example/comment-12",
      user: { login: "reviewer" },
    },
  ]);

  assertDeepEqual(unreplied, [
    {
      id: 12,
      path: "b.ts",
      line: 5,
      author: "reviewer",
      url: "https://github.com/example/comment-12",
      body: "root without reply",
    },
  ]);
});

test("ignores self-authored root review comments", () => {
  const unreplied = findUnrepliedRootReviewComments(
    [
      {
        id: 12,
        body: "author note",
        path: "b.ts",
        original_line: 5,
        user: { login: "chapati23" },
      },
      {
        id: 13,
        body: "reviewer note",
        path: "b.ts",
        original_line: 6,
        user: { login: "reviewer" },
      },
    ],
    ["chapati23"],
  );

  assertDeepEqual(
    unreplied.map((comment) => comment.id),
    [13],
  );
});

test("requires root review comment replies from an allowed agent author", () => {
  const unreplied = findUnrepliedRootReviewComments(
    [
      {
        id: 10,
        body: "root with reviewer self-reply",
        path: "a.ts",
        line: 1,
        user: { login: "reviewer" },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: "reviewer follow-up",
        user: { login: "reviewer" },
      },
      {
        id: 12,
        body: "root with author reply",
        path: "b.ts",
        line: 2,
        user: { login: "reviewer" },
      },
      {
        id: 13,
        in_reply_to_id: 12,
        body: "fixed",
        user: { login: "chapati23" },
      },
    ],
    [],
    ["chapati23"],
  );

  assertDeepEqual(
    unreplied.map((comment) => comment.id),
    [10],
  );
});

test("accepts trusted maintainer takeover replies without accepting self-replies or contributors", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      author: { login: "nvtaveras" },
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 10,
        body: "root with maintainer takeover reply",
        path: "a.ts",
        line: 1,
        user: { login: "reviewer" },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: "fixed",
        author_association: "MEMBER",
        user: { login: "chapati23", type: "User" },
      },
      {
        id: 12,
        body: "root with owner takeover reply",
        path: "a.ts",
        line: 2,
        user: { login: "reviewer" },
      },
      {
        id: 13,
        in_reply_to_id: 12,
        body: "fixed by owner",
        authorAssociation: "OWNER",
        user: { login: "owner", type: "User" },
      },
      {
        id: 14,
        body: "root with collaborator takeover reply",
        path: "a.ts",
        line: 3,
        user: { login: "reviewer" },
      },
      {
        id: 15,
        in_reply_to_id: 14,
        body: "fixed by collaborator",
        author_association: "COLLABORATOR",
        user: { login: "collaborator", type: "User" },
      },
      {
        id: 16,
        body: "root with original PR author reply",
        path: "a.ts",
        line: 4,
        user: { login: "reviewer" },
      },
      {
        id: 17,
        in_reply_to_id: 16,
        body: "fixed by author",
        user: { login: "nvtaveras", type: "User" },
      },
      {
        id: 18,
        body: "root with exact Codex bot reply",
        path: "a.ts",
        line: 5,
        user: { login: "reviewer" },
      },
      {
        id: 19,
        in_reply_to_id: 18,
        body: "fixed by Codex",
        user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
      },
      {
        id: 20,
        body: "root with trusted reviewer self-reply",
        path: "b.ts",
        line: 2,
        user: { login: "reviewer" },
      },
      {
        id: 21,
        in_reply_to_id: 20,
        body: "reviewer follow-up",
        authorAssociation: "OWNER",
        user: { login: "reviewer", type: "User" },
      },
      {
        id: 30,
        body: "root with contributor reply",
        path: "c.ts",
        line: 3,
        user: { login: "reviewer" },
      },
      {
        id: 31,
        in_reply_to_id: 30,
        body: "drive-by reply",
        author_association: "CONTRIBUTOR",
        user: { login: "contributor", type: "User" },
      },
      {
        id: 40,
        body: "root with bot claiming a trusted association",
        path: "d.ts",
        line: 4,
        user: { login: "reviewer" },
      },
      {
        id: 41,
        in_reply_to_id: 40,
        body: "bot reply",
        author_association: "COLLABORATOR",
        user: { login: "untrusted[bot]", type: "Bot" },
      },
    ],
  });

  assertDeepEqual(
    summary.unrepliedRootReviewComments.map((comment) => comment.id),
    [20, 30, 40],
  );
  assertEqual(summary.gates.reviewCommentReplies.unrepliedCount, 3);
});

test("clears the reply gate when a member takes over a teammate's PR", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      author: { login: "nvtaveras" },
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 10,
        body: "please fix",
        path: "a.ts",
        line: 1,
        user: { login: "reviewer" },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: "Fixed in abc123",
        author_association: "MEMBER",
        user: { login: "chapati23", type: "User" },
      },
    ],
    includeFeedbackDetails: true,
  });

  assertEqual(summary.gates.reviewCommentReplies.ready, true);
  assertEqual(summary.gates.reviewCommentReplies.unrepliedCount, 0);
  assertDeepEqual(summary.unrepliedRootReviewComments, []);
  assertEqual(summary.rootReviewComments[0].replied, true);
});

test("summarize ready state ignores self-authored roots but not reviewer self-replies", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 10,
        body: "agent note",
        path: "a.ts",
        line: 1,
        user: { login: "chapati23" },
      },
      {
        id: 11,
        body: "root with reviewer self-reply",
        path: "b.ts",
        line: 2,
        user: { login: "reviewer" },
      },
      {
        id: 12,
        in_reply_to_id: 11,
        body: "reviewer follow-up",
        user: { login: "reviewer" },
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertDeepEqual(
    summary.unrepliedRootReviewComments.map((comment) => comment.id),
    [11],
  );
});

test("feedback detail summaries are opt-in for ready-state output", () => {
  const input = {
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 11,
        body: "root with author reply",
        path: "b.ts",
        line: 2,
        user: { login: "reviewer" },
      },
      {
        id: 12,
        in_reply_to_id: 11,
        body: "fixed",
        user: { login: "chapati23" },
      },
    ],
    reviewThreads: [
      {
        id: "thread-1",
        path: "b.ts",
        line: 2,
        isResolved: true,
        comments: [{ author: { login: "reviewer" }, body: "handled" }],
      },
    ],
  };

  const defaultSummary = summarizeReadyState(input);
  assertEqual(Object.hasOwn(defaultSummary, "reviewThreads"), false);
  assertEqual(Object.hasOwn(defaultSummary, "rootReviewComments"), false);

  const detailedSummary = summarizeReadyState({
    ...input,
    includeFeedbackDetails: true,
  });
  assertEqual(detailedSummary.reviewThreads.length, 1);
  assertEqual(detailedSummary.rootReviewComments.length, 1);
  assertEqual(detailedSummary.rootReviewComments[0].replied, true);
});

test("filters top-level issue comments down to bots", () => {
  const bots = findTopLevelBotComments([
    { id: 1, body: "human", user: { login: "alice", type: "User" } },
    {
      id: 2,
      body: "automated review",
      html_url: "https://github.com/example/comment-2",
      user: { login: "claude[bot]", type: "Bot" },
    },
  ]);

  assertEqual(bots.length, 1);
  assertEqual(bots[0].author, "claude[bot]");
});

test("filters top-level review bodies down to bots with body text", () => {
  const bots = findTopLevelBotReviewComments([
    {
      id: "review-1",
      body: "automated review body",
      url: "https://github.com/example/review-1",
      state: "COMMENTED",
      commit: { oid: "head-sha" },
      author: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    },
    {
      id: "review-2",
      body: "",
      state: "APPROVED",
      author: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    },
    {
      id: "review-3",
      body: "human review",
      author: { login: "alice", type: "User" },
    },
  ]);

  assertEqual(bots.length, 1);
  assertEqual(bots[0].author, "chatgpt-codex-connector[bot]");
  assertEqual(bots[0].state, "COMMENTED");
  assertEqual(bots[0].commitOid, "head-sha");
});

test("requires chatgpt-codex-connector +1 reaction exactly", () => {
  assert(
    hasCodexApprovalReaction(
      [
        {
          content: "+1",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      Date.parse("2026-05-21T13:22:23Z"),
    ),
    "expected codex bot +1 to pass",
  );
  assert(
    !hasCodexApprovalReaction([
      { content: "heart", user: { login: "chatgpt-codex-connector[bot]" } },
      { content: "+1", user: { login: "other[bot]" } },
    ]),
    "expected wrong reaction or wrong bot to fail",
  );
  assert(
    hasCodexApprovalReaction(
      [
        {
          content: "+1",
          user: { login: "chatgpt-codex-connector" },
          created_at: "2026-05-21T13:23:00Z",
        },
      ],
      Date.parse("2026-05-21T13:22:23Z"),
    ),
    "expected app slug login to pass",
  );
});

test("parses only human current-head readiness override comments", () => {
  const active = parseReadinessOverrideComment(
    {
      body: "/pr-ready-override gate=codex-description-approval head=abc123 reason=Codex review quota exhausted after clean checks",
      author_association: "MEMBER",
      html_url: "https://github.com/example/comment",
      user: { login: "chapati23", type: "User" },
      created_at: "2026-05-21T13:24:00Z",
    },
    "abc123",
  );

  assertEqual(active.state, "active");
  assertEqual(active.gate, "codex-description-approval");
  assertEqual(active.head, "abc123");
  assertEqual(active.reason, "Codex review quota exhausted after clean checks");

  const multiline = parseReadinessOverrideComment(
    {
      body: "/pr-ready-override gate=codex-description-approval head=abc123 reason=Codex review quota exhausted after clean checks\n\nAdditional maintainer context.",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    "abc123",
  );
  assertEqual(multiline.state, "active");
  assertEqual(
    multiline.reason,
    "Codex review quota exhausted after clean checks",
  );

  const mentionedCommand = parseReadinessOverrideComment(
    {
      body: "Please use /pr-ready-override gate=codex-description-approval head=abc123 reason=quoted example",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    "abc123",
  );
  assertEqual(mentionedCommand, null);

  const stale = parseReadinessOverrideComment(
    {
      body: "/pr-ready-override gate=codex-description-approval head=old123 reason=old head",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    "abc123",
  );
  assertEqual(stale.state, "ignored");
  assertEqual(stale.reasonIgnored, "head_mismatch");

  const unsupportedGate = parseReadinessOverrideComment(
    {
      body: "/pr-ready-override gate=some-other-gate head=abc123 reason=workaround",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    "abc123",
  );
  assertEqual(unsupportedGate.state, "ignored");
  assertEqual(unsupportedGate.reasonIgnored, "unsupported_gate");

  const bot = parseReadinessOverrideComment(
    {
      body: "/pr-ready-override gate=codex-description-approval head=abc123 reason=nope",
      author_association: "MEMBER",
      user: { login: "automation[bot]", type: "Bot" },
    },
    "abc123",
  );
  assertEqual(bot.state, "ignored");
  assertEqual(bot.reasonIgnored, "author_not_allowed");

  const missingReason = parseReadinessOverrideComment(
    {
      body: "/pr-ready-override gate=codex-description-approval head=abc123",
      author_association: "MEMBER",
      user: { login: "chapati23", type: "User" },
    },
    "abc123",
  );
  assertEqual(missingReason.state, "ignored");
  assertEqual(missingReason.reasonIgnored, "missing_reason");
});

test("readiness override clears only the Codex approval gate for the current head", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    issueComments: [
      {
        body: "/pr-ready-override gate=codex-description-approval head=abc123 reason=Codex review quota exhausted after clean checks",
        author_association: "MEMBER",
        html_url: "https://github.com/example/comment",
        user: { login: "chapati23", type: "User" },
        created_at: "2026-05-21T13:24:00Z",
      },
    ],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.codexApprovalReaction, false);
  assertEqual(summary.gates.codexDescriptionApproval.ready, true);
  assertEqual(summary.gates.codexDescriptionApproval.state, "overridden");
  assertEqual(summary.readinessOverrides.length, 1);
  assertEqual(
    summary.required.blockers.some(
      (blocker) => blocker.name === "Codex PR-description approval",
    ),
    false,
  );
});

test("readiness override does not clear other required blockers", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "test", conclusion: "FAILURE", status: "COMPLETED" },
      ],
    },
    issueComments: [
      {
        body: "/pr-ready-override gate=codex-description-approval head=abc123 reason=Codex unavailable",
        author_association: "MEMBER",
        user: { login: "chapati23", type: "User" },
        created_at: "2026-05-21T13:24:00Z",
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.gates.codexDescriptionApproval.state, "overridden");
  assert(
    summary.required.blockers.some(
      (blocker) => blocker.kind === "check" && blocker.name === "test",
    ),
    "expected failed required check to remain blocking",
  );
});

test("classifies Codex review signal as missing, requested, in flight, stale, or approved", () => {
  const headUpdatedAt = Date.parse("2026-05-21T13:22:23Z");

  assertEqual(classifyCodexReviewSignal({ headUpdatedAt }), "missing");
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "requested",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chapati23" },
          reactions: [
            {
              content: "eyes",
              user: { login: "chatgpt-codex-connector[bot]" },
            },
          ],
        },
      ],
    }),
    "in_flight",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "stale",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      codexApprovalReaction: true,
    }),
    "approved",
  );
});

test("treats Codex review requests as current when no head timestamp is available", () => {
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt: null,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "requested",
  );
});

test("does not revive stale Codex review requests from comment edits", () => {
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt: Date.parse("2026-05-21T13:22:23Z"),
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          updated_at: "2026-05-21T13:23:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "stale",
  );
});

test("uses Codex eyes reaction timestamps to detect current in-flight reviews", () => {
  const headUpdatedAt = Date.parse("2026-05-21T13:22:23Z");

  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chapati23" },
          reactions: [
            {
              content: "eyes",
              created_at: "2026-05-21T13:23:00Z",
              user: { login: "chatgpt-codex-connector[bot]" },
            },
          ],
        },
      ],
    }),
    "in_flight",
  );
});

test("uses PR description Codex eyes reaction as current in-flight signal", () => {
  const headUpdatedAt = Date.parse("2026-05-21T13:22:23Z");

  assert(
    hasCodexInFlightReaction(
      [
        {
          content: "eyes",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      headUpdatedAt,
    ),
    "expected current PR description eyes reaction to count as in-flight",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      codexInFlightReaction: true,
    }),
    "in_flight",
  );
});

test("uses a shared matcher for Codex review request comments", () => {
  assert(isCodexReviewRequestBody("@codex review"));
  assert(isCodexReviewRequestBody("please @codex review this"));
  assert(!isCodexReviewRequestBody("@codex summarize"));
});

test("classifies stale vs current Codex review submissions", () => {
  const headUpdatedAt = Date.parse("2026-05-21T13:22:23Z");
  const currentHeadOid = "head-sha";

  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      currentHeadOid,
      reviews: [
        {
          commit: { oid: "old-sha" },
          submittedAt: "2026-05-21T13:23:00Z",
          author: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
    }),
    "stale",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      currentHeadOid,
      reviews: [
        {
          commit: { oid: "old-sha" },
          author: { login: "chatgpt-codex-connector[bot]" },
        },
        {
          commit: { oid: currentHeadOid },
          submittedAt: "2026-05-21T13:21:00Z",
          author: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
    }),
    "in_flight",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt,
      currentHeadOid,
      reviews: [
        {
          commit_id: currentHeadOid,
          submittedAt: "2026-05-21T13:23:00Z",
          author: { login: "chatgpt-codex-connector" },
        },
      ],
    }),
    "in_flight",
  );
});

test("duplicate-review prevention fixture waits on current-head Codex request in flight", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    issueComments: [
      {
        id: 1,
        body: "@codex review",
        created_at: "2026-05-21T12:00:00Z",
        user: { login: "chapati23" },
      },
      {
        id: 2,
        body: "@codex review",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chapati23" },
        reactions: [
          {
            content: "eyes",
            user: { login: "chatgpt-codex-connector[bot]" },
          },
        ],
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.codexReviewSignal, "in_flight");
  assertEqual(summary.gates.codexReviewSignal.fallbackAction, "wait");
  assert(
    summary.required.blockers.some(
      (blocker) => blocker.name === "Codex PR-description approval",
    ),
    "expected missing final approval gate to keep PR not ready",
  );
});

test("duplicate-review prevention fixture waits on PR description eyes reaction", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "eyes",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.codexApprovalReaction, false);
  assertEqual(summary.codexReviewSignal, "in_flight");
  assertEqual(summary.gates.codexReviewSignal.fallbackAction, "wait");
  assert(
    summary.required.blockers.some(
      (blocker) => blocker.name === "Codex PR-description approval",
    ),
    "expected eyes reaction to wait without satisfying approval",
  );
});

test("watch JSON output is one compact JSON object per line", () => {
  const summary = {
    ready: false,
    number: 123,
    blockers: [{ name: "ci", state: "pending" }],
  };
  const output = renderSummary(summary, {
    json: true,
    compact: false,
    watch: true,
  });

  assertEqual(output.split("\n").length, 2);
  assertDeepEqual(JSON.parse(output), summary);
});

test("until-ready watch decision preserves default watch polling", () => {
  assertEqual(
    watchLoopExitCode(
      {
        ready: true,
        pr: { state: "OPEN" },
      },
      { untilReady: false },
    ),
    null,
  );
});

test("until-ready watch decision exits on ready, merged, or closed-unmerged states", () => {
  assertEqual(
    watchLoopExitCode(
      {
        ready: false,
        pr: { state: "OPEN" },
      },
      { untilReady: true },
    ),
    null,
  );
  assertEqual(
    watchLoopExitCode(
      {
        ready: true,
        pr: { state: "OPEN" },
      },
      { untilReady: true },
    ),
    0,
  );
  assertEqual(
    watchLoopExitCode(
      {
        ready: false,
        pr: { state: "MERGED" },
      },
      { untilReady: true },
    ),
    0,
  );
  assertEqual(
    watchLoopExitCode(
      {
        ready: false,
        pr: { state: "CLOSED" },
      },
      { untilReady: true },
    ),
    1,
  );
});

test("uses first timestamped timeline item after current head commit for freshness", () => {
  assertEqual(
    fetchHeadUpdatedAt({
      headSha: "new-head",
      timelineItems: [
        {
          event: "commented",
          created_at: "2026-05-21T13:20:00Z",
        },
        {
          event: "committed",
          sha: "old-head",
        },
        {
          event: "commented",
          created_at: "2026-05-21T13:21:00Z",
        },
        {
          event: "committed",
          sha: "new-head",
        },
        {
          event: "reviewed",
          submitted_at: "2026-05-21T13:22:30Z",
        },
        {
          event: "commented",
          created_at: "2026-05-21T13:23:00Z",
        },
      ],
      observedAt: "2026-05-21T13:24:00Z",
    }),
    "2026-05-21T13:22:30Z",
  );
});

test("uses current head commit timeline timestamp when available", () => {
  assertEqual(
    fetchHeadUpdatedAt({
      headSha: "new-head",
      timelineItems: [
        {
          event: "committed",
          sha: "new-head",
          created_at: "2026-05-21T13:22:00Z",
        },
        {
          event: "commented",
          created_at: "2026-05-21T13:23:00Z",
        },
      ],
      observedAt: "2026-05-21T13:24:00Z",
    }),
    "2026-05-21T13:22:00Z",
  );
});

test("uses earlier head status observation when timeline timestamp is later", () => {
  assertEqual(
    fetchHeadUpdatedAt({
      headSha: "new-head",
      timelineItems: [
        {
          event: "committed",
          sha: "new-head",
          created_at: "2026-05-21T13:25:00Z",
        },
      ],
      observedAt: "2026-05-21T13:23:00Z",
    }),
    "2026-05-21T13:23:00Z",
  );
});

test("falls back to check observation time when timeline has no post-head timestamp", () => {
  assertEqual(
    fetchHeadUpdatedAt({
      headSha: "new-head",
      timelineItems: [
        {
          event: "committed",
          sha: "new-head",
        },
      ],
      observedAt: "2026-05-21T13:23:00Z",
    }),
    "2026-05-21T13:23:00Z",
  );
});

test("does not derive head freshness from commit metadata", () => {
  assertEqual(
    fetchHeadUpdatedAt({
      headSha: "new-head",
      timelineItems: [
        {
          event: "committed",
          sha: "new-head",
          committed_at: "2026-05-21T13:22:00Z",
        },
      ],
      observedAt: null,
    }),
    null,
  );
});

test("returns null when the current head is absent from the timeline", () => {
  assertEqual(
    headUpdatedAtFromTimeline(
      [
        {
          event: "committed",
          sha: "old-head",
        },
        {
          event: "commented",
          created_at: "2026-05-21T13:23:00Z",
        },
      ],
      "new-head",
    ),
    null,
  );
});

test("treats review requests before head freshness as stale", () => {
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt: Date.parse("2026-05-21T13:23:00Z"),
      issueComments: [
        {
          body: "@codex review",
          created_at: "2026-05-21T13:22:00Z",
          user: { login: "chapati23" },
        },
      ],
    }),
    "stale",
  );
  assertEqual(
    classifyCodexReviewSignal({
      headUpdatedAt: Date.parse("2026-05-21T13:23:00Z"),
      currentHeadOid: "head-sha",
      reviews: [
        {
          commit: { oid: "old-sha" },
          submittedAt: "2026-05-21T13:22:00Z",
          author: { login: "chatgpt-codex-connector" },
        },
      ],
    }),
    "stale",
  );
});

test("rejects stale chatgpt-codex-connector reaction from before the head update", () => {
  assert(
    !hasCodexApprovalReaction(
      [
        {
          content: "+1",
          created_at: "2026-05-21T13:21:00Z",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      Date.parse("2026-05-21T13:22:23Z"),
    ),
    "expected stale codex bot +1 to fail",
  );
});

test("does not use pull request updatedAt as head freshness fallback", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      headUpdatedAt: null,
      headPushedAt: null,
      updatedAt: "2026-05-21T13:25:00Z",
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:25:01Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });

  assertEqual(summary.codexApprovalReaction, false);
  assertEqual(summary.pr.headUpdatedAt, null);
});

test("still fails closed when no head freshness timestamp is available", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      headUpdatedAt: null,
      headPushedAt: null,
      updatedAt: null,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:25:01Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });

  assertEqual(summary.codexApprovalReaction, false);
  assertEqual(summary.pr.headUpdatedAt, null);
});

test("blocks ready state when required review is still pending", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
  });

  assertEqual(summary.ready, false);
  assert(
    summary.required.blockers.some(
      (blocker) =>
        blocker.kind === "review" && blocker.state === "REVIEW_REQUIRED",
    ),
    "expected REVIEW_REQUIRED blocker",
  );
});

test("fails closed when required status contexts cannot be fetched", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    requiredStatusContextsError: "HTTP 403: Resource not accessible",
  });

  assertEqual(summary.ready, false);
  assert(
    summary.required.blockers.some(
      (blocker) => blocker.kind === "branch-protection",
    ),
    "expected branch-protection blocker",
  );
});

test("summarizes not-ready state when blockers remain", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      reviews: [
        {
          body: "review body",
          author: { login: "claude[bot]", type: "Bot" },
        },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 12,
        body: "root without reply",
        path: "b.ts",
        line: 5,
        user: { login: "reviewer" },
      },
    ],
    reviewThreads: [{ id: "thread-1", isResolved: false }],
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.statusChecks.fail.length, 1);
  assertEqual(summary.statusChecks.pending.length, 1);
  assertEqual(summary.unresolvedReviewThreads.length, 1);
  assertEqual(summary.unrepliedRootReviewComments.length, 1);
  assertEqual(summary.topLevelBotComments.length, 1);
  assert(
    summary.codexApprovalReaction,
    "expected codex reaction to be present",
  );
});

test("keeps the documented one-blocker summary aligned with readiness output", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "trunk", status: "IN_PROGRESS", conclusion: null },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    requiredStatusContexts: [{ context: "trunk", integrationId: null }],
    requiredStatusContextsAvailable: true,
  });
  const readinessDoc = readFileSync(
    new URL("../../docs/notes/pr-ready-state.md", import.meta.url),
    "utf8",
  );

  assertEqual(summary.required.blockers.length, 1);
  assertEqual(summary.summary, "1 required blocker(s) remain.");
  assert(
    readinessDoc.includes(`"summary": ${JSON.stringify(summary.summary)}`),
    "expected the documented JSON example to use the one-blocker summary",
  );
});

test("summarizes ready state when all blocking surfaces are clean", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
        { name: "jscpd", conclusion: null, status: "IN_PROGRESS" },
        { name: "optional", conclusion: "SKIPPED", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    reviewComments: [
      {
        id: 10,
        body: "root",
        path: "a.ts",
        line: 1,
        user: { login: "reviewer" },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: "reply",
        user: { login: "chapati23" },
      },
    ],
    reviewThreads: [{ id: "thread-1", isResolved: true }],
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.required.ready, true);
  assertEqual(summary.optional.ready, false);
  assertEqual(summary.optional.items[0].name, "jscpd");
  assertEqual(summary.statusChecks.skipped.length, 1);
});

test("reports confirmed BEHIND as an informational note only once strict is confirmed off", () => {
  // Non-strict policy (operator decision 2026-09-15, ADR 0104): a merely
  // BEHIND head is ready when everything else is clear, but only once the
  // base's ruleset confirms `requiredStatusChecksStrict: false`. Unknown
  // (`null`, the default) or confirmed strict (`true`) both fail closed and
  // keep blocking, exactly like GitHub's own strict mode does.
  for (const requiredStatusChecksStrict of [undefined, null, true]) {
    for (const mergeStateStatus of [
      "BEHIND",
      "CLEAN",
      "BLOCKED",
      "UNKNOWN",
      undefined,
    ]) {
      const summary = summarizeReadyState({
        pr: {
          ...basePr,
          mergeStateStatus,
          statusCheckRollup: [
            { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
          ],
        },
        reactions: [
          {
            content: "+1",
            created_at: "2026-05-21T13:23:00Z",
            user: { login: "chatgpt-codex-connector[bot]" },
          },
        ],
        requiredStatusChecksStrict,
      });
      assertEqual(summary.ready, mergeStateStatus !== "BEHIND");
      assertEqual(
        summary.required.blockers.some((item) => item.kind === "base-update"),
        mergeStateStatus === "BEHIND",
      );
      assertEqual(
        summary.notes.some((item) => item.kind === "base-update"),
        false,
      );
      // The documented contract field (docs/notes/pr-ready-state.md) must be
      // on the summary itself, not just steer the internal note/blocker
      // decision.
      assertEqual(
        summary.requiredStatusChecksStrict,
        requiredStatusChecksStrict ?? null,
      );
    }
  }

  for (const mergeStateStatus of [
    "BEHIND",
    "CLEAN",
    "BLOCKED",
    "UNKNOWN",
    undefined,
  ]) {
    const summary = summarizeReadyState({
      pr: {
        ...basePr,
        mergeStateStatus,
        autoMergeRequest: { enabledAt: "2026-05-21T13:24:00Z" },
        statusCheckRollup: [
          { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
        ],
      },
      reactions: [
        {
          content: "+1",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      requiredStatusChecksStrict: false,
    });
    assertEqual(summary.ready, true);
    assertEqual(summary.pr.mergeStateStatus, mergeStateStatus ?? null);
    assertEqual(summary.pr.autoMergeEnabledAt, "2026-05-21T13:24:00Z");
    assertEqual(
      summary.required.blockers.some((item) => item.kind === "base-update"),
      false,
    );
    assertEqual(
      summary.notes.some((item) => item.kind === "base-update"),
      mergeStateStatus === "BEHIND",
    );
    assertEqual(summary.requiredStatusChecksStrict, false);
  }
});

test("blocks on a red base and fails closed when base health is unreadable", () => {
  // ADR 0104 stopped GitHub re-running a PR's required checks against the
  // current base, so "nobody merges while main is red" is enforced here
  // instead of left as a rule of thumb.
  const readyPr = {
    ...basePr,
    statusCheckRollup: [
      { name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
    ],
  };
  const codexReaction = [
    {
      content: "+1",
      created_at: "2026-05-21T13:23:00Z",
      user: { login: "chatgpt-codex-connector[bot]" },
    },
  ];
  const summarize = (extra) =>
    summarizeReadyState({
      pr: readyPr,
      reactions: codexReaction,
      requiredStatusContexts: [{ context: "ci", integrationId: null }],
      ...extra,
    });

  const green = summarize({
    baseStatusCheckRollup: [
      { name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
    ],
    baseHealthOid: "597b71081aaad0212977dc4e090c2952e063fac9",
  });
  assertEqual(green.ready, true, "a green base must not block");

  for (const conclusion of [
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
  ]) {
    const red = summarize({
      baseStatusCheckRollup: [{ name: "ci", conclusion, status: "COMPLETED" }],
      baseHealthOid: "597b71081aaad0212977dc4e090c2952e063fac9",
    });
    const blockers = red.required.blockers.filter(
      (item) => item.kind === "base-red",
    );
    assertEqual(red.ready, false, `a ${conclusion} base check must block`);
    assertEqual(blockers.length, 1);
    assertEqual(blockers[0].state, "red");
    assert(
      blockers[0].name.includes("ci") &&
        blockers[0].name.includes("597b71081aaad0212977dc4e090c2952e063fac9"),
      "the blocker must name the failing context and the base commit",
    );
  }

  for (const status of ["IN_PROGRESS", "QUEUED"]) {
    const pending = summarize({
      baseStatusCheckRollup: [{ name: "ci", status }],
      baseHealthOid: "597b71081aaad0212977dc4e090c2952e063fac9",
    });
    assertEqual(
      pending.ready,
      true,
      `a base check still ${status} is not red and must not block`,
    );
  }

  // A base that has not reported the required context at all is pending, not
  // red: the required-context list is the PR's, and a path-filtered job that
  // never runs on the base must not manufacture a blocker.
  assertEqual(
    summarize({ baseStatusCheckRollup: [] }).ready,
    true,
    "an absent base check is pending, not red",
  );

  // A skipped base check is skipped, exactly as it is on the PR's own head.
  assertEqual(
    summarize({
      baseStatusCheckRollup: [
        { name: "ci", conclusion: "SKIPPED", status: "COMPLETED" },
      ],
    }).ready,
    true,
    "a skipped base check must not block",
  );

  const unreadable = summarize({
    baseHealthError: "gh: Resource not accessible by integration (HTTP 403)",
  });
  const unknownBlockers = unreadable.required.blockers.filter(
    (item) => item.kind === "base-red",
  );
  assertEqual(
    unreadable.ready,
    false,
    "an unreadable base must fail closed, not pass",
  );
  assertEqual(unknownBlockers.length, 1);
  assertEqual(unknownBlockers[0].name, "Base branch health unavailable");
  assertEqual(
    unknownBlockers[0].state,
    "unknown: gh: Resource not accessible by integration (HTTP 403)",
  );

  // A transport error carries the whole multiline GraphQL query. The blocker
  // must stay one bounded line, or it breaks the compact/watch stream that
  // callers quote verbatim.
  const noisy = summarize({
    baseHealthError: `gh api graphql -f query=\n  query($owner: String!) {\n    repository {\n      object\n    }\n  }\n failed with exit 1:\ngh: Bad credentials`,
  });
  const noisyBlocker = noisy.required.blockers.find(
    (item) => item.kind === "base-red",
  );
  assert(
    !noisyBlocker.state.includes("\n") && !noisyBlocker.name.includes("\n"),
    "a base-health blocker must never carry a newline",
  );
  assert(
    noisyBlocker.state.length <= 210,
    "a base-health diagnostic must stay bounded",
  );
  assert(
    formatCompact(noisy).split("\n").length === 1,
    "compact output must stay one physical line",
  );
});

test("reduces a base rollup to the latest settled run of each check", () => {
  // A rerun leaves the old FAILURE next to the new SUCCESS. Judging the whole
  // rollup would keep every open PR blocked on a base someone already fixed.
  const run = (conclusion, startedAt) => ({
    name: "ci",
    status: "COMPLETED",
    conclusion,
    ...(startedAt ? { startedAt } : {}),
  });
  const pendingRun = (status, startedAt) => ({
    name: "ci",
    status,
    ...(startedAt ? { startedAt } : {}),
  });

  assertDeepEqual(
    latestSettledChecksByIdentity([
      run("FAILURE", "2026-09-15T10:00:00Z"),
      run("SUCCESS", "2026-09-15T11:00:00Z"),
    ]).map((check) => check.conclusion),
    ["SUCCESS"],
    "a passing rerun must supersede the earlier failure",
  );
  assertDeepEqual(
    latestSettledChecksByIdentity([
      run("SUCCESS", "2026-09-15T10:00:00Z"),
      run("FAILURE", "2026-09-15T11:00:00Z"),
    ]).map((check) => check.conclusion),
    ["FAILURE"],
    "a failing rerun must supersede the earlier success",
  );

  // Ties and missing timestamps cannot order the runs. Fail closed on the
  // failure in both directions, so ordering within the payload cannot decide
  // whether a red base looks ready.
  for (const pair of [
    [
      run("SUCCESS", "2026-09-15T10:00:00Z"),
      run("FAILURE", "2026-09-15T10:00:00Z"),
    ],
    [
      run("FAILURE", "2026-09-15T10:00:00Z"),
      run("SUCCESS", "2026-09-15T10:00:00Z"),
    ],
    [run("SUCCESS"), run("FAILURE")],
    [run("FAILURE"), run("SUCCESS")],
  ]) {
    assertDeepEqual(
      latestSettledChecksByIdentity(pair).map((check) => check.conclusion),
      ["FAILURE"],
      "unorderable duplicate runs must keep the failure",
    );
  }

  // A rerun in flight proves nothing yet. Dropping the known failure for it
  // would clear `base-red` on a base that is still broken, because a pending
  // base check does not block — every open PR would look mergeable again.
  for (const status of ["IN_PROGRESS", "QUEUED"]) {
    assertDeepEqual(
      latestSettledChecksByIdentity([
        run("FAILURE", "2026-09-15T10:00:00Z"),
        pendingRun(status, "2026-09-15T11:00:00Z"),
      ]).map((check) => check.conclusion),
      ["FAILURE"],
      `a ${status} rerun must not supersede a known base failure`,
    );
  }

  // Only once the rerun settles green does the failure clear.
  assertDeepEqual(
    latestSettledChecksByIdentity([
      run("FAILURE", "2026-09-15T10:00:00Z"),
      pendingRun("IN_PROGRESS", "2026-09-15T11:00:00Z"),
      run("SUCCESS", "2026-09-15T12:00:00Z"),
    ]).map((check) => check.conclusion),
    ["SUCCESS"],
    "a settled passing rerun must supersede the failure",
  );

  // A check that has never settled is unproven, not red, and must still be
  // reported so the required context does not vanish from the split.
  const onlyPending = latestSettledChecksByIdentity([
    pendingRun("QUEUED", "2026-09-15T10:00:00Z"),
  ]);
  assertEqual(onlyPending.length, 1);
  assertEqual(onlyPending[0].status, "QUEUED");

  // Different checks are different identities and must all survive.
  assertEqual(
    latestSettledChecksByIdentity([
      { name: "ci", conclusion: "SUCCESS" },
      { name: "Code Quality", conclusion: "SUCCESS" },
    ]).length,
    2,
  );
});

test("an operator override clears base-red, and only base-red", () => {
  // `base-red` deadlocks its own recovery: the fix or revert PR that turns
  // `main` green is blocked by the red `main` it exists to repair. The break
  // glass carries the same conditions as the Codex gate — operator author,
  // stated reason, bound to this head.
  const head = "c".repeat(40);
  const redBase = "a".repeat(40);
  const overrideComment = (overrides = {}) => ({
    body: `/pr-ready-override gate=base-red head=${head} base=${redBase} reason=reverting the bad merge`,
    author_association: "OWNER",
    user: { login: "chapati23", type: "User" },
    created_at: "2026-09-15T12:00:00Z",
    ...overrides,
  });
  const summarize = (issueComments) =>
    summarizeReadyState({
      pr: {
        ...basePr,
        headRefOid: head,
        statusCheckRollup: [
          { name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
        ],
      },
      issueComments,
      reactions: [
        {
          content: "+1",
          created_at: "2026-05-21T13:23:00Z",
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      requiredStatusContexts: [{ context: "ci", integrationId: null }],
      baseHealthOid: redBase,
      baseStatusCheckRollup: [
        {
          name: "ci",
          conclusion: "FAILURE",
          status: "COMPLETED",
          completedAt: "2026-09-15T09:00:00Z",
        },
      ],
    });
  const baseRedBlockers = (summary) =>
    summary.required.blockers.filter((item) => item.kind === "base-red");

  assertEqual(
    baseRedBlockers(summarize([])).length,
    1,
    "a red base blocks without an override",
  );

  const overridden = summarize([overrideComment()]);
  assertEqual(baseRedBlockers(overridden).length, 0);
  const note = overridden.notes.find((item) => item.kind === "base-red");
  assertEqual(note.state, "overridden");
  assertEqual(note.override.author, "chapati23");
  assertEqual(note.override.reason, "reverting the bad merge");
  assert(
    note.name.includes("@chapati23") &&
      note.name.includes("reverting the bad merge"),
    "human output must carry the operator and the reason",
  );
  assertEqual(overridden.ready, true, "the override clears the blocker");
  assertEqual(
    overridden.readinessOverrides.length,
    1,
    "an applied override is reported as active",
  );

  // Any push expires it.
  assertEqual(
    baseRedBlockers(
      summarize([
        overrideComment({
          body: `/pr-ready-override gate=base-red head=${"d".repeat(40)} base=${redBase} reason=stale`,
        }),
      ]),
    ).length,
    1,
    "an override bound to a superseded head must not apply",
  );

  // The operator judged one specific red base. `main` advancing to a different
  // red commit, or an override that names no base at all, needs a new decision.
  for (const [label, body] of [
    [
      "another base commit",
      `/pr-ready-override gate=base-red head=${head} base=${"e".repeat(40)} reason=stale`,
    ],
    [
      "no base at all",
      `/pr-ready-override gate=base-red head=${head} reason=stale`,
    ],
  ]) {
    assertEqual(
      baseRedBlockers(summarize([overrideComment({ body })])).length,
      1,
      `an override naming ${label} must not apply`,
    );
  }

  // A rerun that newly fails after the operator decided is a red result they
  // never approved, even with the head and base commit unchanged.
  const rerunAfterOverride = summarizeReadyState({
    pr: {
      ...basePr,
      headRefOid: head,
      statusCheckRollup: [
        { name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    issueComments: [overrideComment()],
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    requiredStatusContexts: [{ context: "ci", integrationId: null }],
    baseHealthOid: redBase,
    baseStatusCheckRollup: [
      {
        name: "ci",
        conclusion: "FAILURE",
        status: "COMPLETED",
        completedAt: "2026-09-15T18:00:00Z",
      },
    ],
  });
  assertEqual(
    rerunAfterOverride.required.blockers.filter(
      (item) => item.kind === "base-red",
    ).length,
    1,
    "a base failure newer than the override must not be suppressed",
  );
  // GitHub timestamps are second-precision, so a tie is a result the operator
  // could not have read. Require strictly newer.
  assertEqual(
    baseRedBlockers(
      summarizeReadyState({
        pr: { ...basePr, headRefOid: head },
        issueComments: [overrideComment()],
        requiredStatusContexts: [{ context: "ci", integrationId: null }],
        baseHealthOid: redBase,
        baseStatusCheckRollup: [
          {
            name: "ci",
            conclusion: "FAILURE",
            status: "COMPLETED",
            completedAt: "2026-09-15T12:00:00Z",
          },
        ],
      }),
    ).length,
    1,
    "a failure tied with the override timestamp must not be suppressed",
  );
  assertDeepEqual(
    rerunAfterOverride.readinessOverrides,
    [],
    "a declined base-red override must not be reported as active",
  );

  // An unreadable base is a state nobody observed: never overridable.
  const unreadable = summarizeReadyState({
    pr: { ...basePr, headRefOid: head },
    issueComments: [overrideComment()],
    requiredStatusContexts: [{ context: "ci", integrationId: null }],
    baseHealthError: "gh: Bad credentials",
  });
  assertEqual(
    unreadable.required.blockers.filter((item) => item.kind === "base-red")
      .length,
    1,
    "an unknown base must stay blocking even with an override",
  );

  // Only an operator may post it.
  for (const author of [
    { author_association: "CONTRIBUTOR" },
    { author_association: "NONE" },
    { user: { login: "some-bot[bot]", type: "Bot" } },
  ]) {
    assertEqual(
      baseRedBlockers(summarize([overrideComment(author)])).length,
      1,
      "a non-operator override must not apply",
    );
  }

  // It covers base-red and nothing else: a failing required check on this PR
  // still blocks with the same override in place.
  const stillBlocked = summarizeReadyState({
    pr: {
      ...basePr,
      headRefOid: head,
      statusCheckRollup: [
        { name: "ci", conclusion: "FAILURE", status: "COMPLETED" },
      ],
    },
    issueComments: [overrideComment()],
    requiredStatusContexts: [{ context: "ci", integrationId: null }],
    baseHealthOid: redBase,
    baseStatusCheckRollup: [
      { name: "ci", conclusion: "FAILURE", status: "COMPLETED" },
    ],
  });
  assertEqual(stillBlocked.ready, false);
  assert(
    stillBlocked.required.blockers.some(
      (item) => item.kind === "check" && item.state === "fail",
    ),
    "the override must not reach this PR's own failing check",
  );
});

test("a base rerun in flight keeps the base-red blocker", () => {
  const summary = summarizeReadyState({
    pr: {
      ...basePr,
      statusCheckRollup: [
        { name: "ci", conclusion: "SUCCESS", status: "COMPLETED" },
      ],
    },
    reactions: [
      {
        content: "+1",
        created_at: "2026-05-21T13:23:00Z",
        user: { login: "chatgpt-codex-connector[bot]" },
      },
    ],
    requiredStatusContexts: [{ context: "ci", integrationId: null }],
    baseHealthOid: "a".repeat(40),
    // What `fetchBaseBranchHealth` hands over once the rerun is in flight: the
    // failure is still the latest settled run.
    baseStatusCheckRollup: [
      {
        name: "ci",
        conclusion: "FAILURE",
        status: "COMPLETED",
        startedAt: "2026-09-15T10:00:00Z",
      },
    ],
  });

  assertEqual(
    summary.ready,
    false,
    "a rerun in flight must not clear a red base",
  );
  assertEqual(
    summary.required.blockers.filter((item) => item.kind === "base-red").length,
    1,
  );
});

test("reads base branch health from one rollup query", async () => {
  const calls = [];
  const health = await fetchBaseBranchHealth({
    repo: { owner: "mento-protocol", name: "monitoring-monorepo", host: null },
    baseRef: "main",
    fetchJson: async (_repo, args) => {
      calls.push(args);
      return {
        ok: true,
        value: {
          data: {
            repository: {
              object: {
                oid: "597b71081aaad0212977dc4e090c2952e063fac9",
                statusCheckRollup: {
                  contexts: {
                    totalCount: 2,
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "ci",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        startedAt: "2026-09-15T15:10:33Z",
                        detailsUrl: "https://github.com/run/1",
                        checkSuite: { app: { databaseId: 15368 } },
                      },
                      {
                        __typename: "StatusContext",
                        context: "Vercel",
                        state: "SUCCESS",
                        createdAt: "2026-09-15T15:08:07Z",
                        targetUrl: "https://vercel.com/x",
                        avatarUrl:
                          "https://avatars.githubusercontent.com/in/8329?s=40&v=4",
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      };
    },
  });

  assertEqual(calls.length, 1, "base health must cost exactly one read");
  assertEqual(health.oid, "597b71081aaad0212977dc4e090c2952e063fac9");
  assertEqual(health.error, null);
  // App identity must survive for both node shapes, or an app-bound required
  // context (this repo pins integration ids 15368 and 8329) cannot match.
  assertEqual(health.rollup[0].appId, 15368);
  assertEqual(health.rollup[1].appId, 8329);
  assertEqual(health.rollup[1].startedAt, "2026-09-15T15:08:07Z");
});

test("fails closed when base branch health cannot be read", async () => {
  const repo = {
    owner: "mento-protocol",
    name: "monitoring-monorepo",
    host: null,
  };
  const transportFailure = await fetchBaseBranchHealth({
    repo,
    baseRef: "main",
    fetchJson: async () => ({ ok: false, error: "gh: Bad credentials" }),
  });
  assertEqual(transportFailure.error, "gh: Bad credentials");
  assertDeepEqual(transportFailure.rollup, []);

  const graphqlErrors = await fetchBaseBranchHealth({
    repo,
    baseRef: "main",
    fetchJson: async () => ({
      ok: true,
      value: { errors: [{ message: "Could not resolve to a Repository" }] },
    }),
  });
  assert(
    graphqlErrors.error?.includes("Could not resolve to a Repository"),
    "a GraphQL error payload must surface as a base-health error",
  );

  const missingCommit = await fetchBaseBranchHealth({
    repo,
    baseRef: "main",
    fetchJson: async () => ({
      ok: true,
      value: { data: { repository: { object: null } } },
    }),
  });
  assert(
    missingCommit.error?.includes("did not resolve to a commit"),
    "an unresolvable base ref must surface as a base-health error",
  );

  // A truncated rollup is the dangerous case: an omitted required context
  // reads as pending, and pending does not block, so a red base would look
  // ready. Fail closed instead of paginating — this read must stay one
  // request.
  const truncated = await fetchBaseBranchHealth({
    repo,
    baseRef: "main",
    fetchJson: async () => ({
      ok: true,
      value: {
        data: {
          repository: {
            object: {
              oid: "597b71081aaad0212977dc4e090c2952e063fac9",
              statusCheckRollup: {
                contexts: {
                  totalCount: 137,
                  pageInfo: { hasNextPage: true },
                  nodes: [],
                },
              },
            },
          },
        },
      },
    }),
  });
  assert(
    truncated.error?.includes("more than one page"),
    "a rollup wider than one page must fail closed, not report an empty base",
  );
  assertDeepEqual(truncated.rollup, []);
});

test("blocks a textual conflict (mergeable: CONFLICTING or mergeStateStatus: DIRTY)", () => {
  const greenChecksPr = {
    ...basePr,
    autoMergeRequest: { enabledAt: "2026-05-21T13:24:00Z" },
    statusCheckRollup: [
      { name: "lint", conclusion: "SUCCESS", status: "COMPLETED" },
    ],
  };
  const codexReaction = [
    {
      content: "+1",
      created_at: "2026-05-21T13:23:00Z",
      user: { login: "chatgpt-codex-connector[bot]" },
    },
  ];

  const conflicting = summarizeReadyState({
    pr: {
      ...greenChecksPr,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    },
    reactions: codexReaction,
  });
  assertEqual(conflicting.ready, false);
  assertEqual(
    conflicting.required.blockers.some((item) => item.kind === "mergeability"),
    true,
  );
  assertEqual(
    conflicting.notes.some((item) => item.kind === "base-update"),
    false,
  );

  // Defense in depth: DIRTY blocks even if `mergeable` reports stale.
  const staleDirty = summarizeReadyState({
    pr: { ...greenChecksPr, mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" },
    reactions: codexReaction,
  });
  assertEqual(staleDirty.ready, false);
  assertEqual(
    staleDirty.required.blockers.some(
      (item) => item.kind === "mergeability" && item.state === "DIRTY",
    ),
    true,
  );
});

test("summarizes merged pull requests as terminal ready", () => {
  const summary = summarizeTerminalReadyState({
    ...basePr,
    state: "MERGED",
    mergeable: "UNKNOWN",
    mergedAt: "2026-06-05T11:08:01Z",
  });

  assertEqual(summary.ready, true);
  assertEqual(summary.required.ready, true);
  assertEqual(summary.required.blockers.length, 0);
  assertEqual(summary.summary, "Pull request is already merged.");
  assertEqual(summary.pr.state, "MERGED");
  assertEqual(summary.pr.mergedAt, "2026-06-05T11:08:01Z");
  assertEqual(summary.gates.codexDescriptionApproval.required, true);
  assertEqual(summary.gates.codexDescriptionApproval.state, "present");
  assertEqual(summary.gates.codexReviewSignal.fallbackAction, "wait");
  assertEqual(summary.requiredStatusChecksStrict, null);
  assert(!formatCompact(summary).includes("undefined"));
  assert(!formatHuman(summary).includes("undefined"));
});

test("summarizes closed unmerged pull requests as terminal blocked", () => {
  const summary = summarizeTerminalReadyState({
    ...basePr,
    state: "CLOSED",
    closedAt: "2026-06-05T11:08:01Z",
  });

  assertEqual(summary.ready, false);
  assertEqual(summary.required.ready, false);
  assertEqual(summary.required.blockers[0].kind, "state");
  assertEqual(summary.required.blockers[0].state, "CLOSED");
  assertEqual(summary.summary, "Pull request is closed without merging.");
  assertEqual(summary.pr.closedAt, "2026-06-05T11:08:01Z");
  assertEqual(summary.gates.codexDescriptionApproval.ready, true);
  assertEqual(summary.gates.codexDescriptionApproval.required, false);
  assertEqual(summary.gates.codexDescriptionApproval.state, "not_applicable");
  assertEqual(summary.gates.codexReviewSignal.fallbackAction, "wait");
  assertEqual(summary.gates.reviewCommentReplies.required, false);
});

test("human output names the readiness verdict and codex reaction gate", () => {
  const output = formatHuman(
    summarizeReadyState({
      pr: { ...basePr, statusCheckRollup: [] },
      reactions: [],
    }),
  );

  assert(output.includes("PR #123: NOT READY"), output);
  assert(
    output.includes(
      "chatgpt-codex-connector[bot] +1 reaction on PR description: no",
    ),
    output,
  );
  assert(output.includes("Codex review signal: missing"), output);
});

test("human and compact output report active readiness overrides", () => {
  const summary = summarizeReadyState({
    pr: { ...basePr, statusCheckRollup: [] },
    issueComments: [
      {
        body: "/pr-ready-override gate=codex-description-approval head=abc123 reason=Codex quota exhausted",
        author_association: "MEMBER",
        html_url: "https://github.com/example/comment",
        user: { login: "chapati23", type: "User" },
        created_at: "2026-05-21T13:24:00Z",
      },
    ],
  });
  const human = formatHuman(summary);
  const compact = formatCompact(summary);

  assert(human.includes("Readiness overrides active: 1"), human);
  assert(
    human.includes(
      "codex-description-approval by chapati23 for abc123: Codex quota exhausted",
    ),
    human,
  );
  assert(compact.includes("codex_approval=overridden"), compact);
  assert(compact.includes("overrides=1"), compact);
});

test("compact output includes readiness counters and Codex signal state", () => {
  const output = formatCompact(
    summarizeReadyState({
      pr: { ...basePr, statusCheckRollup: [] },
      reactions: [],
    }),
  );

  assert(output.includes("PR #123 BLOCKED"), output);
  assert(output.includes("state=UNKNOWN"), output);
  assert(output.includes("required_blockers=1"), output);
  assert(output.includes("codex_approval=missing"), output);
  assert(output.includes("codex_signal=missing"), output);
  assert(output.includes("overrides=0"), output);
});

test("no longer classifies a stray Cursor Bugbot check as a known optional check", () => {
  // ADR 0066 step 4: the live Cursor compatibility path retired on
  // 2026-09-02. Without branch-protection data the splitter falls back to
  // the advisory allowlist, and an unrecognized context now reads as
  // required — the fail-closed direction for a check nobody classified.
  const fallback = splitRequiredAndOptionalChecks([
    { name: "Cursor Bugbot", status: "IN_PROGRESS", conclusion: null },
    { name: "jscpd", status: "IN_PROGRESS", conclusion: null },
  ]);

  assertDeepEqual(
    {
      required: fallback.required.map(
        (check) => `${check.name}:${check.state}`,
      ),
      optional: fallback.optional.map(
        (check) => `${check.name}:${check.state}`,
      ),
    },
    {
      required: ["Cursor Bugbot:pending"],
      optional: ["jscpd:pending"],
    },
  );

  // With branch-protection data it stays optional, because a retired context
  // never appears in the required-context list.
  const protectedSplit = splitRequiredAndOptionalChecks(
    [
      { name: "Cursor Bugbot", status: "IN_PROGRESS", conclusion: null },
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    ["ci"],
  );

  assertDeepEqual(
    {
      required: protectedSplit.required.map(
        (check) => `${check.name}:${check.state}`,
      ),
      optional: protectedSplit.optional.map(
        (check) => `${check.name}:${check.state}`,
      ),
    },
    {
      required: ["ci:pass"],
      optional: ["Cursor Bugbot:pending"],
    },
  );
});

function stackFixture() {
  const repo = { owner: "owner", name: "repo" };
  const repository = { url: "https://api.github.com/repos/owner/repo" };
  const layer = (number, base, head, sha) => ({
    number,
    state: "open",
    draft: false,
    merged_at: null,
    base: { ref: base, repo: repository },
    head: { ref: head, sha: sha.repeat(40), repo: repository },
  });
  const stack = {
    number: 7,
    open: true,
    base: { ref: "main" },
    pull_requests: [
      layer(10, "main", "parent", "a"),
      layer(11, "parent", "child", "b"),
    ],
  };
  const pr = {
    number: 11,
    headRefName: "child",
    headRefOid: "b".repeat(40),
    baseRefName: "parent",
    isDraft: false,
  };
  return { repo, pr, stack };
}

function ancestryResult(path) {
  const parentSha = path.split("/compare/")[1].split("...")[0];
  return {
    status: "ahead",
    behind_by: 0,
    base_commit: { sha: parentSha },
    merge_base_commit: { sha: parentSha },
  };
}

async function stackBases(
  fixture,
  transformList = (stack) => [stack],
  compare = (path) => ({ ok: true, value: ancestryResult(path) }),
) {
  const requests = [];
  const result = await fetchReadinessBases({
    ...fixture,
    fetchJson: async (_repo, args) => {
      requests.push(args[0]);
      if (args[0].includes("/compare/")) return compare(args[0]);
      return {
        ok: true,
        value: args[0].includes("?")
          ? transformList(structuredClone(fixture.stack))
          : fixture.stack,
      };
    },
    fetchContexts: async (args) => {
      requests.push(`protection:${args.baseRef}`);
      return { contexts: [{ context: "ci" }], error: null };
    },
  });
  return { ...result, requests };
}

async function rejectsStack(fixture, transformList) {
  try {
    await stackBases(fixture, transformList);
  } catch (error) {
    assert(
      error.message.startsWith("Stack metadata unavailable:"),
      error.message,
    );
    return;
  }
  throw new Error("expected stack metadata rejection");
}

test("native stacks fetch protection at stack base and report unmerged dependencies", async () => {
  const result = await stackBases(stackFixture());
  assertEqual(
    result.requests.join("|"),
    // The trailing `graphql` is the base-health read. Readiness costs exactly
    // one extra request, and it goes to the protection base, not the PR base.
    `repos/owner/repo/stacks?pull_request=11&per_page=100|repos/owner/repo/stacks/7|repos/owner/repo/compare/${"a".repeat(40)}...${"b".repeat(40)}?per_page=1|protection:main|graphql`,
  );
  assertEqual(result.stack.diffBaseRef, "parent");
  assertEqual(result.stack.protectionBaseRef, "main");
  assertEqual(result.stack.dependencyPrNumbers.join(","), "10");
  assertEqual(result.stack.ready, null);
});

test("native stack ancestry fails closed on stale children and unavailable comparisons", async () => {
  for (const mutate of [
    (value) => ({ ...value, status: "behind", behind_by: 1 }),
    (value) => ({ ...value, status: "diverged", behind_by: 1 }),
    (value) => ({ ...value, status: "unknown" }),
    (value) => ({ ...value, behind_by: undefined }),
    (value) => ({ ...value, base_commit: { sha: "c".repeat(40) } }),
    (value) => ({ ...value, merge_base_commit: { sha: "c".repeat(40) } }),
    () => null,
  ]) {
    let rejected = false;
    try {
      await stackBases(stackFixture(), undefined, (path) => ({
        ok: true,
        value: mutate(ancestryResult(path)),
      }));
    } catch (error) {
      rejected = error.message.includes("does not verifiably include parent");
    }
    assert(rejected, "ancestry uncertainty must block readiness");
  }
  let rejected = false;
  try {
    await stackBases(stackFixture(), undefined, () => ({
      ok: false,
      error: "HTTP 403",
    }));
  } catch (error) {
    rejected = error.message.includes("HTTP 403");
  }
  assert(rejected, "comparison API failure must block readiness");
});

test("identical native heads satisfy ancestry without requiring a new child commit", async () => {
  const fixture = stackFixture();
  fixture.stack.pull_requests[1].head.sha = fixture.pr.headRefOid = "a".repeat(
    40,
  );
  const result = await stackBases(fixture, undefined, (path) => ({
    ok: true,
    value: { ...ancestryResult(path), status: "identical" },
  }));
  assertEqual(result.stack.layers.length, 2);
});

test("native ancestry verifies each adjacent open layer including descendants of the selected PR", async () => {
  const fixture = stackFixture();
  const third = structuredClone(fixture.stack.pull_requests[1]);
  third.number = 12;
  third.base.ref = "child";
  third.head.ref = "grandchild";
  third.head.sha = "c".repeat(40);
  fixture.stack.pull_requests.push(third);
  const result = await stackBases(fixture);
  const comparisons = result.requests.filter((path) =>
    path.includes("/compare/"),
  );
  assertEqual(comparisons.length, 2);
  assert(
    comparisons[1].includes(`${"b".repeat(40)}...${"c".repeat(40)}`),
    "second pair must compare child to grandchild",
  );
});

test("verified standalone PRs use the immediate base without stack output", async () => {
  const result = await stackBases(stackFixture(), () => []);
  assertEqual(result.stack, null);
  // Protection and base health both read the PR's immediate base; the
  // base-health `graphql` read is the last of the two.
  assert(
    result.requests.includes("protection:parent"),
    "a standalone PR reads protection at its immediate base",
  );
  assertEqual(result.requests.at(-1), "graphql");
  assert(
    !result.requests.some((path) => path.includes("/compare/")),
    "standalone PRs need no ancestry request",
  );
});

test("partial stack merge checks remaining layer against stack base", async () => {
  const fixture = stackFixture();
  fixture.stack.pull_requests[0].state = "closed";
  fixture.stack.pull_requests[0].merged_at = "2026-09-09T10:00:00Z";
  fixture.stack.pull_requests[1].base.ref = "main";
  fixture.pr.baseRefName = "main";
  const result = await stackBases(fixture);
  assertEqual(result.stack.dependencyPrNumbers.length, 0);
  assertEqual(result.stack.layers[0].state, "MERGED");
  assert(
    !result.requests.some((path) => path.includes("/compare/")),
    "merged parents must not be compared after squash and retarget",
  );
});

test("stack membership failure never fetches weaker branch protection", async () => {
  for (const result of [
    { ok: false, error: "HTTP 403" },
    { ok: false, error: "HTTP 404" },
    { ok: true, value: null },
  ]) {
    let fetchedProtection = false;
    let rejected = false;
    try {
      await fetchReadinessBases({
        ...stackFixture(),
        fetchJson: async () => result,
        fetchContexts: async () => {
          fetchedProtection = true;
        },
      });
    } catch {
      rejected = true;
    }
    assert(
      rejected && !fetchedProtection,
      "must fail before protection lookup",
    );
  }
});

test("stack metadata rejects missing membership, ambiguity, changed parent and protection base", async () => {
  for (const mutate of [
    () => null,
    (stack) => [stack, stack],
    (stack) => {
      stack.pull_requests[0].head.sha = "c".repeat(40);
      return [stack];
    },
    (stack) => {
      stack.base.ref = "other";
      return [stack];
    },
    (stack) => {
      stack.pull_requests.pop();
      return [stack];
    },
  ])
    await rejectsStack(stackFixture(), mutate);
});

test("stack metadata rejects malformed topology, fork, closed dependency and stale PR snapshot", async () => {
  for (const mutate of [
    (f) => {
      f.stack.pull_requests[1].base.ref = "other";
    },
    (f) => {
      f.stack.pull_requests[0].head.repo = {
        url: "https://api.github.com/repos/outsider/repo",
      };
    },
    (f) => {
      f.stack.pull_requests[0].state = "closed";
    },
    (f) => {
      f.pr.headRefOid = "c".repeat(40);
    },
    (f) => {
      f.pr.baseRefName = "new-parent";
    },
    (f) => {
      f.stack.pull_requests[0].number = 11;
    },
    (f) => {
      f.pr.number = 99;
    },
    (f) => {
      f.stack.pull_requests[0].head.sha = null;
    },
  ]) {
    const fixture = stackFixture();
    mutate(fixture);
    await rejectsStack(fixture);
  }
});

async function finalSnapshot(
  fixture,
  originalStack,
  mutate = () => {},
  standalone = false,
  baseHealthOid = standalone
    ? fixture.pr.baseRefOid
    : (originalStack?.protectionBaseOid ?? null),
  baseHealthError = null,
  resolvedBase = originalStack?.protectionBaseOid ?? fixture.pr.baseRefOid,
) {
  const currentPr = {
    number: fixture.pr.number,
    state: "open",
    draft: fixture.pr.isDraft,
    head: { sha: fixture.pr.headRefOid, ref: fixture.pr.headRefName },
    base: { ref: fixture.pr.baseRefName, sha: fixture.pr.baseRefOid },
  };
  const next = {
    currentPr,
    stack: structuredClone(fixture.stack),
    standalone,
    resolvedBase,
  };
  mutate(next);
  await verifyReadinessSnapshot({
    ...fixture,
    stack: originalStack,
    baseHealthOid,
    baseHealthError,
    fetchJson: async (_repo, [path]) => {
      if (/\/commits\/[^/]+$/u.test(path)) {
        return next.resolvedBase === null
          ? { ok: false, error: "HTTP 404" }
          : { ok: true, value: { sha: next.resolvedBase } };
      }
      return {
        ok: true,
        value: path.includes("/compare/")
          ? ancestryResult(path)
          : path.includes("/pulls/")
            ? next.currentPr
            : path.includes("?")
              ? next.standalone
                ? []
                : [next.stack]
              : next.stack,
      };
    },
  });
}

test("final snapshot accepts stable native and standalone PRs after readiness reads", async () => {
  const fixture = stackFixture();
  fixture.pr.baseRefOid = "a".repeat(40);
  // Keep both the stack snapshot and the live protection branch stable.
  fixture.stack.base.sha = "e".repeat(40);
  const { stack } = await stackBases(fixture);
  await finalSnapshot(fixture, stack);
  await finalSnapshot(fixture, null, () => {}, true);
});

test("final snapshot accepts an older PR or stack base when the live base is stable", async () => {
  const fixture = stackFixture();
  fixture.pr.baseRefOid = "a".repeat(40);
  fixture.stack.base.sha = "e".repeat(40);
  const { stack } = await stackBases(fixture);
  const liveBase = "b".repeat(40);
  for (const standalone of [true, false]) {
    await finalSnapshot(
      fixture,
      standalone ? null : stack,
      () => {},
      standalone,
      liveBase,
      null,
      liveBase,
    );
    const summary = summarizeReadyState({
      pr: fixture.pr,
      baseHealthOid: liveBase,
      baseStatusCheckRollup: [
        { name: "Code Quality", status: "COMPLETED", conclusion: "FAILURE" },
      ],
      requiredStatusContexts: [
        { context: "Code Quality", integrationId: null },
      ],
      includeFeedbackDetails: true,
    });
    assertEqual(summary.ready, false, "a real audit failure must still block");
    assert(
      summary.required.blockers.some(
        (b) => b.kind === "base-red" && b.name.includes(liveBase),
      ),
      "red live-base health must remain structured",
    );
    assert(
      JSON.parse(JSON.stringify(summary)).required.blockers.some(
        (b) => b.kind === "base-red" && b.name.includes(liveBase),
      ),
      "the audit blocker must survive JSON serialization",
    );
  }
});

test("final snapshot rejects base health read from a different base commit", async () => {
  // Base health resolves a mutable ref. If `main` advances to a red commit
  // after that query, every other snapshot field can still match, so without
  // this binding the gate would pass on a base whose health it never read.
  const fixture = stackFixture();
  fixture.pr.baseRefOid = "a".repeat(40);
  fixture.stack.base.sha = "e".repeat(40);
  const { stack } = await stackBases(fixture);

  for (const [label, standalone, oid] of [
    ["a standalone PR", true, "b".repeat(40)],
    ["a native stack layer", false, "b".repeat(40)],
    ["an unreadable base", true, null],
  ]) {
    let rejected = false;
    try {
      await finalSnapshot(
        fixture,
        standalone ? null : stack,
        () => {},
        standalone,
        oid,
      );
    } catch (error) {
      rejected = error.message.includes("base advanced while gathering");
    }
    assert(rejected, `${label} must reject base health from another commit`);
  }
});

test("final snapshot resolves the live protection branch with or without a stack base SHA", async () => {
  // `fetchStackContext` accepts a stacks response without `base.sha`, leaving
  // `protectionBaseOid` null. Refusing those layers would make their readiness
  // permanently unavailable, so the protection ref is resolved here instead —
  // and because that read happens after the health query, a base that moved in
  // between still fails closed.
  const fixture = stackFixture();
  fixture.pr.baseRefOid = "a".repeat(40);
  for (const stackBase of [undefined, "d".repeat(40)]) {
    fixture.stack.base.sha = stackBase;
    const { stack } = await stackBases(fixture);
    assertEqual(stack.protectionBaseOid, stackBase ?? null);

    // Resolved ref matches the commit base health judged: the layer stays usable.
    await finalSnapshot(
      fixture,
      stack,
      () => {},
      false,
      "e".repeat(40),
      null,
      "e".repeat(40),
    );

    for (const [label, resolved, expected] of [
      ["a base that moved", "f".repeat(40), "base advanced"],
      ["an unreadable base ref", null, "HTTP 404"],
      [
        "a malformed base commit",
        "not-a-sha",
        "protection base commit is unreadable",
      ],
    ]) {
      let rejected = false;
      try {
        await finalSnapshot(
          fixture,
          stack,
          () => {},
          false,
          "e".repeat(40),
          null,
          resolved,
        );
      } catch (error) {
        rejected = error.message.includes(expected);
      }
      assert(rejected, `${label} must fail closed`);
    }
  }
});

test("final snapshot leaves an unreadable base to its structured blocker", async () => {
  // A failed health read already becomes a required `base-red` blocker with an
  // unknown state. Throwing here instead would crash the probe and leave watch
  // mode with no JSON, so the binding check must stand down for that case.
  const fixture = stackFixture();
  fixture.pr.baseRefOid = "a".repeat(40);
  fixture.stack.base.sha = "e".repeat(40);
  const { stack } = await stackBases(fixture);

  await finalSnapshot(
    fixture,
    stack,
    () => {},
    false,
    null,
    "Base branch health unreadable: gh: Bad credentials",
  );
  await finalSnapshot(
    fixture,
    null,
    () => {},
    true,
    null,
    "Base branch health unreadable: gh: Bad credentials",
  );
});

test("final snapshot rejects parent or membership changes after protection lookup", async () => {
  const fixture = stackFixture();
  fixture.pr.baseRefOid = "a".repeat(40);
  fixture.stack.pull_requests[0].base.sha = "d".repeat(40);
  fixture.stack.base.sha = "d".repeat(40);
  const { stack } = await stackBases(fixture);
  const mutations = [
    (next) => {
      next.currentPr.number = 12;
    },
    (next) => {
      next.currentPr.head.ref = "other-child";
    },
    (next) => {
      next.currentPr.head.sha = "c".repeat(40);
    },
    (next) => {
      next.currentPr.base.ref = "other-parent";
    },
    (next) => {
      next.currentPr.base.sha = "c".repeat(40);
    },
    (next) => {
      next.currentPr.draft = true;
    },
    (next) => {
      next.currentPr.state = "closed";
    },
    (next) => {
      next.stack.pull_requests[0].head.sha = "c".repeat(40);
    },
    (next) => {
      next.stack.pull_requests[0].base.sha = "c".repeat(40);
    },
    (next) => {
      next.stack.base.sha = "c".repeat(40);
    },
    (next) => {
      next.standalone = true;
    },
    (next) => {
      next.stack.number = 8;
    },
  ];
  for (const mutate of mutations) {
    let rejected = false;
    try {
      await finalSnapshot(fixture, stack, mutate);
    } catch (error) {
      rejected = String(error.message).startsWith(
        "Stack metadata unavailable:",
      );
    }
    assert(rejected, "changed snapshot must not emit readiness");
  }
  let rejected = false;
  try {
    // Supply a base-health OID that matches, so the new base-binding guard
    // cannot be what rejects this: the transition itself must.
    await finalSnapshot(fixture, null, () => {}, false, fixture.pr.baseRefOid);
  } catch (error) {
    rejected =
      String(error.message).startsWith("Stack metadata unavailable:") &&
      !error.message.includes("base advanced") &&
      !error.message.includes("no verified base commit");
  }
  assert(rejected, "standalone to native transition must not emit readiness");
});

test("final snapshot rejects failed or missing current PR fetch", async () => {
  for (const result of [
    { ok: false, error: "HTTP 403" },
    { ok: true, value: null },
  ]) {
    const fixture = stackFixture();
    fixture.pr.baseRefOid = "a".repeat(40);
    let fetched = false;
    let rejected = false;
    try {
      await verifyReadinessSnapshot({
        ...fixture,
        stack: null,
        // Clear the base-binding guard, or this would reject before the fetch
        // and still pass while the PR-response validation below was gone.
        baseHealthOid: fixture.pr.baseRefOid,
        fetchJson: async (_repo, [path]) => {
          if (path.includes("/commits/"))
            return { ok: true, value: { sha: fixture.pr.baseRefOid } };
          fetched = true;
          return result;
        },
      });
    } catch (error) {
      rejected = String(error.message).startsWith(
        "Stack metadata unavailable:",
      );
    }
    assert(fetched, "the final lookup must actually run");
    assert(rejected, "final lookup must succeed before readiness");
  }
});

for (const { name, fn } of tests) {
  await runTest(name, fn);
}

if (failed > 0) {
  process.stderr.write(`\n${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

process.stdout.write(`\n${passed} passed\n`);

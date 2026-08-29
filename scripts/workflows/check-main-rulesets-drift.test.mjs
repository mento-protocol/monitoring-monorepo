#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CORE_RULESET_ID,
  LIFECYCLE_RULESET_NAME,
  SOURCE_HUMAN_MERGE_BOUNDARY_POLICY,
  evaluateMainRulesets,
  runCli,
} from "./check-main-rulesets-drift.mjs";

const TEAM_ID = 424242;
const MANAGED_RULESET_ID = 24680;
const TEST_POLICY = Object.freeze({
  repository: "mento-protocol/monitoring-monorepo",
  human_merge_operator_team_id: TEAM_ID,
  human_main_lifecycle_ruleset_id: MANAGED_RULESET_ID,
  human_main_lifecycle_ruleset_enforcement: "active",
  ruleset_audit_active: true,
  local_agent_github_broker_scaffold_enabled: true,
  local_agent_github_broker_partial_recovery_enabled: false,
  local_agent_github_broker_impersonator:
    "serviceAccount:local-agent-broker@mento-monitoring.iam.gserviceaccount.com",
});

function coreRuleset() {
  return {
    id: CORE_RULESET_ID,
    name: "main",
    target: "branch",
    source_type: "Repository",
    source: "mento-protocol/monitoring-monorepo",
    enforcement: "active",
    bypass_actors: [
      {
        actor_id: null,
        actor_type: "OrganizationAdmin",
        bypass_mode: "always",
      },
    ],
    conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: false,
          dismissal_restriction: { allowed_actors: [], enabled: false },
          require_code_owner_review: false,
          require_extra_approval_for_unattributed_changes: true,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
          required_reviewers: [],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: "Vercel", integration_id: 8329 },
            { context: "Vercel Preview Comments", integration_id: 8329 },
            { context: "Code Quality", integration_id: 15368 },
            { context: "ci", integration_id: 15368 },
            { context: "Sentry suites", integration_id: 15368 },
          ],
        },
      },
    ],
  };
}

function lifecycleRuleset(policy = TEST_POLICY) {
  return {
    id: policy.human_main_lifecycle_ruleset_id,
    name: LIFECYCLE_RULESET_NAME,
    target: "branch",
    source_type: "Repository",
    source: "mento-protocol/monitoring-monorepo",
    enforcement: policy.human_main_lifecycle_ruleset_enforcement,
    bypass_actors: [
      {
        actor_id: policy.human_merge_operator_team_id,
        actor_type: "Team",
        bypass_mode: "pull_request",
      },
    ],
    conditions: { ref_name: { exclude: [], include: ["refs/heads/main"] } },
    rules: [{ type: "creation" }, { type: "deletion" }, { type: "update" }],
  };
}

function fixture(policy = TEST_POLICY) {
  return {
    rulesets: [coreRuleset(), lifecycleRuleset(policy)],
  };
}

function expectPass(candidate) {
  assert.deepEqual(evaluateMainRulesets(candidate, { policy: TEST_POLICY }), {
    status: "ok",
    violations: [],
  });
}

function expectDrift(candidate, expected, policy = TEST_POLICY) {
  const verdict = evaluateMainRulesets(candidate, { policy });
  assert.equal(verdict.status, "drift");
  assert(
    verdict.violations.some((violation) => violation.includes(expected)),
    `expected ${JSON.stringify(verdict.violations)} to include ${JSON.stringify(expected)}`,
  );
}

expectPass(fixture());
const parametersFixture = fixture();
parametersFixture.rulesets[1].rules[2].parameters = {
  update_allows_fetch_and_merge: false,
};
expectPass(parametersFixture);

const reordered = fixture();
reordered.rulesets.reverse();
reordered.rulesets[0].bypass_actors.reverse();
reordered.rulesets[0].rules.reverse();
reordered.rulesets[1].rules.reverse();
reordered.rulesets[1].rules
  .find((rule) => rule.type === "required_status_checks")
  .parameters.required_status_checks.reverse();
expectPass(reordered);

for (const [mutate, expected] of [
  [(value) => value.rulesets.pop(), "exactly two rulesets"],
  [
    (value) => value.rulesets.push({ ...lifecycleRuleset(), id: 999 }),
    "exactly two rulesets",
  ],
  [
    (value) => (value.rulesets[0].bypass_actors = []),
    "core ruleset bypass actors changed",
  ],
  [
    (value) =>
      (value.rulesets[0].rules[3].parameters.require_extra_approval_for_unattributed_changes = false),
    "unattributed-change approval",
  ],
  [
    (value) =>
      (value.rulesets[0].rules[3].parameters.required_review_thread_resolution = false),
    "thread-resolution requirement",
  ],
  [
    (value) =>
      value.rulesets[0].rules[4].parameters.required_status_checks.pop(),
    "required status checks changed",
  ],
  [
    (value) => (value.rulesets[1].bypass_actors[0].bypass_mode = "always"),
    "pull_request mode",
  ],
  [
    (value) =>
      value.rulesets[1].bypass_actors.push({
        actor_id: 15368,
        actor_type: "Integration",
        bypass_mode: "pull_request",
      }),
    "only the source-pinned Team",
  ],
  [
    (value) => (value.rulesets[1].rules = [{ type: "update" }]),
    "exactly creation, deletion, and update",
  ],
  [
    (value) => value.rulesets[1].rules.push({ type: "pull_request" }),
    "exactly creation, deletion, and update",
  ],
  [
    (value) =>
      (value.rulesets[1].rules[2].parameters = {
        update_allows_fetch_and_merge: true,
      }),
    "unexpected parameters",
  ],
  [(value) => (value.rulesets[1].id = 999), "source-pinned ID"],
  [(value) => (value.rulesets[1].id = CORE_RULESET_ID), "source-pinned ID"],
  [(value) => (value.rulesets[1].enforcement = "disabled"), "enforcement"],
]) {
  const candidate = fixture();
  mutate(candidate);
  expectDrift(candidate, expected);
}

assert.equal(
  evaluateMainRulesets(null, { policy: TEST_POLICY }).status,
  "malformed",
);
assert.equal(
  evaluateMainRulesets({ rulesets: [null] }, { policy: TEST_POLICY }).status,
  "malformed",
);
expectDrift(fixture(), "Team ID is missing", {
  ...TEST_POLICY,
  human_merge_operator_team_id: 0,
});
expectDrift(fixture(), "managed lifecycle ruleset ID is missing", {
  ...TEST_POLICY,
  human_main_lifecycle_ruleset_id: 0,
});
expectDrift(fixture(), "managed lifecycle ruleset ID is missing", {
  ...TEST_POLICY,
  human_main_lifecycle_ruleset_id: CORE_RULESET_ID,
});
expectDrift(fixture(), "completed audit activation", {
  ...TEST_POLICY,
  ruleset_audit_active: false,
});
assert.equal(
  evaluateMainRulesets(fixture(), {
    policy: { ...TEST_POLICY, repository: "attacker/repo" },
  }).status,
  "malformed",
);

function capture(raw, policy = TEST_POLICY) {
  let output = "";
  const code = runCli(raw, {
    stdout: { write: (value) => (output += value) },
    policy,
  });
  return { code, output };
}

let result = capture(JSON.stringify(fixture()));
assert.equal(result.code, 0);
assert.match(result.output, /^OK: state=ok;/u);

const driftFixture = fixture();
driftFixture.rulesets.pop();
result = capture(JSON.stringify(driftFixture));
assert.equal(result.code, 2);
assert.match(result.output, /^DRIFT:/u);

result = capture("not json");
assert.equal(result.code, 3);
assert.match(result.output, /^MALFORMED:/u);

const sourcePolicy = SOURCE_HUMAN_MERGE_BOUNDARY_POLICY;
const sourceCanDescribeLiveRuleset =
  Number.isSafeInteger(sourcePolicy.human_merge_operator_team_id) &&
  sourcePolicy.human_merge_operator_team_id > 0 &&
  Number.isSafeInteger(sourcePolicy.human_main_lifecycle_ruleset_id) &&
  sourcePolicy.human_main_lifecycle_ruleset_id > 0 &&
  sourcePolicy.human_main_lifecycle_ruleset_id !== CORE_RULESET_ID;
const sourceAuditShouldPass =
  sourceCanDescribeLiveRuleset &&
  sourcePolicy.ruleset_audit_active &&
  sourcePolicy.human_main_lifecycle_ruleset_enforcement === "active";
const sourceVerdict = evaluateMainRulesets(fixture(sourcePolicy), {
  policy: sourcePolicy,
});
assert.equal(
  sourceVerdict.status,
  sourceAuditShouldPass ? "ok" : "drift",
  "the current source-policy phase must have the corresponding live-audit fixture",
);
if (sourcePolicy.ruleset_audit_active) {
  assert.equal(
    sourcePolicy.human_main_lifecycle_ruleset_enforcement,
    "active",
    "an active source audit must require active lifecycle enforcement",
  );
  assert.equal(
    sourceVerdict.status,
    "ok",
    "an active source audit must have a source-coupled success fixture",
  );
}

const workflow = readFileSync(
  new URL(
    "../../.github/workflows/platform-settings-drift.yml",
    import.meta.url,
  ),
  "utf8",
);
assert.match(workflow, /human-merge-boundary-policy\.json/u);
assert.match(
  workflow,
  /ruleset audit is active but PLATFORM_SETTINGS_AUDIT_TOKEN is absent/iu,
);
assert.match(workflow, /main-ruleset-audit state=ok/u);
assert.match(workflow, /human-only-main-lifecycle/u);
assert.match(workflow, /scripts\/workflows\/read-main-rulesets\.mjs/u);
assert.match(
  workflow,
  /audit_active[\s\S]*?= "false"[\s\S]*?state=inert/u,
  "the audit may be inert only while reviewed source keeps activation false",
);
assert.doesNotMatch(
  workflow,
  /vars\.HUMAN_MERGE_OPERATOR_TEAM_ID/u,
  "the live audit must not trust a mutable repository variable for the Team actor",
);
assert.doesNotMatch(
  workflow,
  /;;\s*;;/u,
  "the workflow case statement must not contain a duplicate terminator",
);

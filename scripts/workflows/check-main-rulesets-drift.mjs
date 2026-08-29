#!/usr/bin/env node
/**
 * Evaluate the live repository rulesets that protect main.
 *
 * The platform-settings workflow owns authentication and read-only GitHub API
 * calls. This module accepts only captured JSON and returns:
 *
 *   0  ok         both rulesets match the reviewed source policy
 *   2  drift      a valid live response violates the pinned boundary
 *   3  malformed  the input or API response shape cannot be evaluated safely
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CORE_RULESET_ID = 13494367;
export const LIFECYCLE_RULESET_NAME = "human-only-main-lifecycle";
export const SOURCE_HUMAN_MERGE_BOUNDARY_POLICY = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL(
        "../../terraform/human-merge-boundary-policy.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

const EXPECTED_CHECKS = Object.freeze([
  Object.freeze({ context: "Code Quality", integration_id: 15368 }),
  Object.freeze({ context: "Sentry suites", integration_id: 15368 }),
  Object.freeze({ context: "Vercel", integration_id: 8329 }),
  Object.freeze({
    context: "Vercel Preview Comments",
    integration_id: 8329,
  }),
  Object.freeze({ context: "ci", integration_id: 15368 }),
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortChecks(checks) {
  if (!Array.isArray(checks)) return undefined;
  return checks
    .map((check) => ({
      context: check?.context,
      integration_id: check?.integration_id,
    }))
    .sort((left, right) =>
      `${left.context}:${left.integration_id}`.localeCompare(
        `${right.context}:${right.integration_id}`,
      ),
    );
}

function sortByType(values) {
  if (!Array.isArray(values)) return undefined;
  return [...values].sort((left, right) =>
    String(left?.type).localeCompare(String(right?.type)),
  );
}

function sortByActor(values) {
  if (!Array.isArray(values)) return undefined;
  return [...values].sort((left, right) =>
    `${left?.actor_type}:${left?.actor_id}`.localeCompare(
      `${right?.actor_type}:${right?.actor_id}`,
    ),
  );
}

function exactRepositoryEnvelope(ruleset, { enforcement, id, name }) {
  return (
    ruleset?.id === id &&
    ruleset?.name === name &&
    ruleset?.target === "branch" &&
    ruleset?.source_type === "Repository" &&
    ruleset?.source === "mento-protocol/monitoring-monorepo" &&
    ruleset?.enforcement === enforcement &&
    isDeepStrictEqual(ruleset?.conditions, {
      ref_name: { exclude: [], include: ["refs/heads/main"] },
    })
  );
}

function validateCoreRuleset(ruleset, violations) {
  if (
    !exactRepositoryEnvelope(ruleset, {
      enforcement: "active",
      id: CORE_RULESET_ID,
      name: "main",
    })
  ) {
    violations.push(
      "core ruleset 13494367 must stay active on only refs/heads/main",
    );
  }
  if (
    !isDeepStrictEqual(ruleset?.bypass_actors, [
      {
        actor_id: null,
        actor_type: "OrganizationAdmin",
        bypass_mode: "always",
      },
    ])
  ) {
    violations.push(
      "core ruleset bypass actors changed before safe Terraform adoption",
    );
  }

  const rules = sortByType(ruleset?.rules);
  if (!rules || rules.length !== 5) {
    violations.push("core ruleset must contain exactly its five live rules");
    return;
  }
  const byType = new Map(rules.map((rule) => [rule?.type, rule]));
  const expectedTypes = [
    "deletion",
    "non_fast_forward",
    "pull_request",
    "required_linear_history",
    "required_status_checks",
  ];
  if (!isDeepStrictEqual([...byType.keys()].sort(), expectedTypes.sort())) {
    violations.push("core ruleset rule types changed");
  }
  for (const type of [
    "deletion",
    "non_fast_forward",
    "required_linear_history",
  ]) {
    const rule = byType.get(type);
    if (!isObject(rule) || Object.keys(rule).length !== 1) {
      violations.push(`core ${type} rule has unexpected parameters`);
    }
  }

  const pullRequest = byType.get("pull_request")?.parameters;
  const expectedPullRequest = {
    allowed_merge_methods: ["squash"],
    dismiss_stale_reviews_on_push: false,
    dismissal_restriction: { allowed_actors: [], enabled: false },
    require_code_owner_review: false,
    require_extra_approval_for_unattributed_changes: true,
    require_last_push_approval: false,
    required_approving_review_count: 0,
    required_review_thread_resolution: true,
    required_reviewers: [],
  };
  if (!isDeepStrictEqual(pullRequest, expectedPullRequest)) {
    violations.push(
      "core pull-request controls changed, including the unattributed-change approval or thread-resolution requirement",
    );
  }

  const status = byType.get("required_status_checks")?.parameters;
  if (
    !isObject(status) ||
    status.strict_required_status_checks_policy !== false ||
    status.do_not_enforce_on_create !== false ||
    Object.keys(status).some(
      (key) =>
        ![
          "strict_required_status_checks_policy",
          "do_not_enforce_on_create",
          "required_status_checks",
        ].includes(key),
    ) ||
    !isDeepStrictEqual(
      sortChecks(status.required_status_checks),
      sortChecks(EXPECTED_CHECKS),
    )
  ) {
    violations.push("core required status checks changed");
  }
}

function validateLifecycleRuleset(ruleset, expected, violations) {
  if (
    !exactRepositoryEnvelope(ruleset, {
      enforcement: expected.enforcement,
      id: expected.rulesetId,
      name: LIFECYCLE_RULESET_NAME,
    })
  ) {
    violations.push(
      "human lifecycle ruleset must match its source-pinned ID and enforcement on only refs/heads/main",
    );
  }
  const expectedBypasses = sortByActor([
    {
      actor_id: expected.teamId,
      actor_type: "Team",
      bypass_mode: "pull_request",
    },
  ]);
  if (
    !isDeepStrictEqual(sortByActor(ruleset?.bypass_actors), expectedBypasses)
  ) {
    violations.push(
      "human lifecycle ruleset must have only the source-pinned Team in pull_request mode",
    );
  }

  const rules = sortByType(ruleset?.rules);
  if (!rules || rules.length !== 3) {
    violations.push(
      "human lifecycle ruleset must contain exactly creation, deletion, and update rules",
    );
    return;
  }
  const byType = new Map(rules.map((rule) => [rule?.type, rule]));
  if (
    !isDeepStrictEqual([...byType.keys()].sort(), [
      "creation",
      "deletion",
      "update",
    ]) ||
    Object.keys(byType.get("creation") ?? {}).length !== 1 ||
    Object.keys(byType.get("deletion") ?? {}).length !== 1
  ) {
    violations.push(
      "human lifecycle ruleset must contain only creation, deletion, and update rules",
    );
    return;
  }
  const update = byType.get("update");
  if (
    !isObject(update) ||
    !(
      Object.keys(update).length === 1 ||
      (Object.keys(update).length === 2 &&
        isDeepStrictEqual(update.parameters, {
          update_allows_fetch_and_merge: false,
        }))
    )
  ) {
    violations.push("human lifecycle update rule has unexpected parameters");
  }
}

function parsePositiveInteger(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function parsePolicy(policy) {
  if (
    !isObject(policy) ||
    policy.repository !== "mento-protocol/monitoring-monorepo" ||
    typeof policy.ruleset_audit_active !== "boolean" ||
    !["disabled", "active"].includes(
      policy.human_main_lifecycle_ruleset_enforcement,
    )
  ) {
    return undefined;
  }
  return {
    auditActive: policy.ruleset_audit_active,
    enforcement: policy.human_main_lifecycle_ruleset_enforcement,
    rulesetId: parsePositiveInteger(policy.human_main_lifecycle_ruleset_id),
    teamId: parsePositiveInteger(policy.human_merge_operator_team_id),
  };
}

export function evaluateMainRulesets(
  api,
  { policy = SOURCE_HUMAN_MERGE_BOUNDARY_POLICY } = {},
) {
  if (!isObject(api) || !Array.isArray(api.rulesets)) {
    return {
      status: "malformed",
      violations: ["API input must contain a rulesets array."],
    };
  }
  if (api.rulesets.some((ruleset) => !isObject(ruleset))) {
    return {
      status: "malformed",
      violations: ["Every rulesets entry must be a JSON object."],
    };
  }

  const expected = parsePolicy(policy);
  if (!expected) {
    return {
      status: "malformed",
      violations: [
        "source policy must pin the repository, lifecycle enforcement, and boolean audit activation state.",
      ],
    };
  }

  const violations = [];
  if (expected.teamId === undefined) {
    violations.push(
      "source-pinned merge-operator Team ID is missing or is not a positive integer",
    );
  }
  if (
    expected.rulesetId === undefined ||
    expected.rulesetId === CORE_RULESET_ID
  ) {
    violations.push(
      "source-pinned managed lifecycle ruleset ID is missing, invalid, or names core ruleset 13494367",
    );
  }
  if (!expected.auditActive || expected.enforcement !== "active") {
    violations.push(
      "live ruleset audit requires source-pinned active enforcement and completed audit activation",
    );
  }
  if (api.rulesets.length !== 2) {
    violations.push(
      `repository must expose exactly two rulesets after cutover; found ${api.rulesets.length}`,
    );
  }

  const core = api.rulesets.filter((ruleset) => ruleset.id === CORE_RULESET_ID);
  if (core.length !== 1) {
    violations.push("core ruleset 13494367 is missing or duplicated");
  } else {
    validateCoreRuleset(core[0], violations);
  }

  const lifecycle = api.rulesets.filter(
    (ruleset) => ruleset.name === LIFECYCLE_RULESET_NAME,
  );
  if (lifecycle.length !== 1) {
    violations.push(
      "human-only-main-lifecycle ruleset is missing or duplicated",
    );
  } else {
    validateLifecycleRuleset(lifecycle[0], expected, violations);
  }

  return {
    status: violations.length > 0 ? "drift" : "ok",
    violations,
  };
}

const EXIT = Object.freeze({ ok: 0, drift: 2, malformed: 3 });

export function runCli(
  raw,
  { policy = SOURCE_HUMAN_MERGE_BOUNDARY_POLICY, stdout = process.stdout } = {},
) {
  let api;
  try {
    api = JSON.parse(raw);
  } catch {
    stdout.write("MALFORMED: stdin was not valid JSON.\n");
    return EXIT.malformed;
  }
  const verdict = evaluateMainRulesets(api, { policy });
  if (verdict.status === "ok") {
    stdout.write(
      "OK: state=ok; core controls are unchanged and the human-only main lifecycle ruleset matches reviewed source.\n",
    );
    return EXIT.ok;
  }
  if (verdict.status === "malformed") {
    stdout.write(`MALFORMED: ${verdict.violations.join(" ")}\n`);
    return EXIT.malformed;
  }
  stdout.write(
    "DRIFT: the main ruleset boundary differs from its pinned shape:\n" +
      verdict.violations.map((violation) => `  - ${violation}`).join("\n") +
      "\n",
  );
  return EXIT.drift;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  readStdin().then((raw) => {
    process.exitCode = runCli(raw);
  });
}

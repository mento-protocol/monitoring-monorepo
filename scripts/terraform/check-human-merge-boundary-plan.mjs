#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export const CORE_RULESET_ID = 13494367;
export const HUMAN_LIFECYCLE_RULESET_ADDRESS =
  "github_repository_ruleset.human_only_main_lifecycle";
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameActions(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function containsTrue(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsTrue);
  if (isObject(value)) return Object.values(value).some(containsTrue);
  return false;
}

function nonEmpty(value) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function relatedRulesetEntry(resourceChange) {
  return (
    resourceChange?.type === "github_repository_ruleset" ||
    resourceChange?.address === HUMAN_LIFECYCLE_RULESET_ADDRESS ||
    resourceChange?.previous_address === HUMAN_LIFECYCLE_RULESET_ADDRESS
  );
}

function exactIdentity(entry) {
  return (
    entry?.address === HUMAN_LIFECYCLE_RULESET_ADDRESS &&
    entry?.mode === "managed" &&
    entry?.type === "github_repository_ruleset" &&
    entry?.name === "human_only_main_lifecycle" &&
    entry?.module_address === undefined &&
    entry?.index === undefined &&
    entry?.deposed === undefined &&
    entry?.previous_address === undefined
  );
}

function validateSourcePolicy(policy, errors) {
  if (
    !isObject(policy) ||
    policy.repository !== "mento-protocol/monitoring-monorepo" ||
    !Number.isSafeInteger(policy.human_merge_operator_team_id) ||
    policy.human_merge_operator_team_id <= 0 ||
    !Number.isSafeInteger(policy.human_main_lifecycle_ruleset_id) ||
    policy.human_main_lifecycle_ruleset_id < 0 ||
    !["disabled", "active"].includes(
      policy.human_main_lifecycle_ruleset_enforcement,
    ) ||
    typeof policy.ruleset_audit_active !== "boolean" ||
    typeof policy.local_agent_github_broker_impersonator !== "string" ||
    (policy.local_agent_github_broker_impersonator !== "" &&
      !/^serviceAccount:[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/u.test(
        policy.local_agent_github_broker_impersonator,
      ))
  ) {
    errors.push(
      "source policy must pin the repository, approved positive Team ID, non-negative managed lifecycle ruleset ID, valid enforcement state, boolean audit state, and zero or one broker service-account principal; replace the zero Team sentinel first",
    );
    return undefined;
  }

  const rulesetId = policy.human_main_lifecycle_ruleset_id;
  const enforcement = policy.human_main_lifecycle_ruleset_enforcement;
  const auditActive = policy.ruleset_audit_active;
  if (rulesetId === CORE_RULESET_ID) {
    errors.push("source policy must never adopt core ruleset 13494367");
  }
  if (rulesetId === 0 && (enforcement !== "disabled" || auditActive)) {
    errors.push(
      "initial lifecycle ruleset creation requires managed ID 0, disabled enforcement, and an inactive audit",
    );
  }
  if (auditActive && (rulesetId <= 0 || enforcement !== "active")) {
    errors.push(
      "ruleset audit activation requires a source-pinned non-core managed ID and active enforcement",
    );
  }
  return {
    auditActive,
    enforcement,
    rulesetId,
    teamId: policy.human_merge_operator_team_id,
  };
}

function validateRulesetShape(after, expected, errors) {
  if (!isObject(after)) {
    errors.push("human lifecycle ruleset must have a known after value");
    return;
  }
  if (
    after.name !== "human-only-main-lifecycle" ||
    after.repository !== "monitoring-monorepo" ||
    after.target !== "branch" ||
    after.enforcement !== expected?.enforcement
  ) {
    errors.push(
      "human lifecycle ruleset must match the source-pinned enforcement on monitoring-monorepo branches",
    );
  }

  if (after.ruleset_id === CORE_RULESET_ID) {
    errors.push("human lifecycle ruleset must never use core ruleset 13494367");
  }
  if (expected?.rulesetId > 0) {
    if (after.ruleset_id !== expected.rulesetId) {
      errors.push(
        "human lifecycle ruleset after ID must match the source-pinned managed ID",
      );
    }
  } else if (
    after.ruleset_id !== undefined &&
    after.ruleset_id !== null &&
    after.ruleset_id !== 0
  ) {
    errors.push(
      "initial lifecycle ruleset creation must not carry an existing ruleset ID",
    );
  }

  if (
    !Array.isArray(after.conditions) ||
    after.conditions.length !== 1 ||
    !isObject(after.conditions[0]) ||
    !Array.isArray(after.conditions[0].ref_name) ||
    after.conditions[0].ref_name.length !== 1 ||
    !exactStringArray(after.conditions[0].ref_name[0]?.include, [
      "refs/heads/main",
    ]) ||
    !exactStringArray(after.conditions[0].ref_name[0]?.exclude, [])
  ) {
    errors.push("human lifecycle ruleset must target only refs/heads/main");
  }

  const bypasses = after.bypass_actors;
  if (!Array.isArray(bypasses) || bypasses.length !== 1) {
    errors.push("human lifecycle ruleset must have exactly one Team bypass");
  } else {
    const team = bypasses[0];
    if (
      team?.actor_type !== "Team" ||
      !Number.isSafeInteger(team?.actor_id) ||
      team.actor_id <= 0 ||
      team.bypass_mode !== "pull_request"
    ) {
      errors.push(
        "human lifecycle ruleset Team bypass must be one positive ID in pull_request mode",
      );
    } else if (team.actor_id !== expected?.teamId) {
      errors.push(
        "human lifecycle ruleset Team actor must match the source-pinned approved Team ID",
      );
    }
  }

  if (
    !Array.isArray(after.rules) ||
    after.rules.length !== 1 ||
    !isObject(after.rules[0]) ||
    after.rules[0].creation !== true ||
    after.rules[0].update !== true ||
    after.rules[0].deletion !== true
  ) {
    errors.push(
      "human lifecycle ruleset must contain creation, update, and deletion rules",
    );
  } else {
    const extraRules = Object.entries(after.rules[0]).filter(
      ([name, value]) =>
        !["creation", "update", "deletion"].includes(name) && nonEmpty(value),
    );
    if (extraRules.length > 0) {
      errors.push(
        "human lifecycle ruleset must contain only creation, update, and deletion rules",
      );
    }
  }
}

function validateExistingIdentity(before, expected, errors) {
  if (!isObject(before)) {
    errors.push(
      "an existing human lifecycle ruleset must have a known before value",
    );
    return;
  }
  if (before.ruleset_id === CORE_RULESET_ID) {
    errors.push(
      "human lifecycle ruleset must never adopt core ruleset 13494367",
    );
  }
  if (before.ruleset_id !== expected?.rulesetId) {
    errors.push(
      "human lifecycle ruleset before ID must match the source-pinned managed ID",
    );
  }
  if (
    before.name !== "human-only-main-lifecycle" ||
    before.repository !== "monitoring-monorepo" ||
    before.target !== "branch" ||
    !["disabled", "active"].includes(before.enforcement)
  ) {
    errors.push(
      "human lifecycle ruleset before value must identify the expected managed ruleset",
    );
  }
}

function normalizedManagedRulesetState(value) {
  if (!isObject(value)) return value;
  const normalized = structuredClone(value);
  delete normalized.enforcement;
  delete normalized.etag;
  delete normalized.node_id;
  return normalized;
}

function validateRulesetEntry(entry, expected, errors) {
  if (!exactIdentity(entry)) {
    errors.push("human lifecycle ruleset has an unexpected resource identity");
  }
  const actions = entry?.change?.actions;
  const isCreate = sameActions(actions, ["create"]);
  const isNoOp = sameActions(actions, ["no-op"]);
  const isUpdate = sameActions(actions, ["update"]);
  if (!isCreate && !isNoOp && !isUpdate) {
    errors.push(
      "human lifecycle ruleset may only be created, unchanged, or updated in place",
    );
  }

  const unknown = structuredClone(entry?.change?.after_unknown ?? {});
  if (isObject(unknown)) {
    delete unknown.etag;
    delete unknown.node_id;
    if (isCreate && expected?.rulesetId === 0) delete unknown.ruleset_id;
  }
  if (containsTrue(unknown)) {
    errors.push(
      "human lifecycle ruleset managed fields must be known before apply",
    );
  }

  if (expected?.rulesetId === 0) {
    if (!isCreate || entry?.change?.before !== null) {
      errors.push(
        "managed lifecycle ruleset ID 0 permits only an initial create with no before value",
      );
    }
  } else if (expected?.rulesetId > 0) {
    if (isCreate) {
      errors.push(
        "a source-pinned managed lifecycle ruleset ID forbids another create",
      );
    }
    validateExistingIdentity(entry?.change?.before, expected, errors);
  }

  const beforeEnforcement = entry?.change?.before?.enforcement;
  if (expected?.enforcement === "disabled" && beforeEnforcement === "active") {
    errors.push("human lifecycle ruleset enforcement must not move backward");
  }
  if (isNoOp && beforeEnforcement !== expected?.enforcement) {
    errors.push(
      "a no-op human lifecycle ruleset must already match source-pinned enforcement",
    );
  }
  if (isNoOp) {
    validateRulesetShape(entry?.change?.before, expected, errors);
  }
  if (isUpdate) {
    if (
      beforeEnforcement !== "disabled" ||
      expected?.enforcement !== "active" ||
      entry?.change?.after?.enforcement !== "active"
    ) {
      errors.push(
        "a human lifecycle ruleset update may only activate disabled enforcement",
      );
    }
    if (
      !isDeepStrictEqual(
        normalizedManagedRulesetState(entry?.change?.before),
        normalizedManagedRulesetState(entry?.change?.after),
      )
    ) {
      errors.push(
        "a human lifecycle ruleset update must change only enforcement",
      );
    }
    validateRulesetShape(
      entry?.change?.before,
      { ...expected, enforcement: beforeEnforcement },
      errors,
    );
  }
  if (expected?.auditActive) {
    if (!isNoOp || beforeEnforcement !== "active") {
      errors.push(
        "ruleset audit activation requires a separate no-op plan after active enforcement receives live proof",
      );
    }
  }

  validateRulesetShape(entry?.change?.after, expected, errors);
}

function validateGithubProvider(plan, errors) {
  if (Object.hasOwn(plan.variables ?? {}, "github_owner")) {
    errors.push(
      "platform plan must not expose an overridable github_owner variable",
    );
  }
  const providerConfigurations = plan.configuration?.provider_config ?? {};
  const githubProviders = Object.entries(providerConfigurations).filter(
    ([, configuration]) =>
      configuration?.full_name === "registry.terraform.io/integrations/github",
  );
  const provider = providerConfigurations.github;
  const tokenExpression = provider?.expressions?.token;
  if (
    githubProviders.length !== 1 ||
    githubProviders[0]?.[0] !== "github" ||
    !isObject(provider) ||
    provider.full_name !== "registry.terraform.io/integrations/github" ||
    provider.expressions?.owner?.constant_value !== "mento-protocol" ||
    provider.expressions?.base_url?.constant_value !==
      "https://api.github.com/" ||
    !isObject(tokenExpression) ||
    Object.keys(tokenExpression).length !== 1 ||
    !exactStringArray(tokenExpression.references, ["var.github_token"])
  ) {
    errors.push(
      "the only GitHub provider must be unaliased, use only var.github_token, and pin mento-protocol plus https://api.github.com/ in reviewed source",
    );
  }
}

function rejectMutableTeamMirror(plan, errors) {
  const mirror = plan.resource_changes.filter(
    (entry) =>
      entry?.address ===
        "github_actions_variable.human_merge_operator_team_id" ||
      entry?.previous_address ===
        "github_actions_variable.human_merge_operator_team_id" ||
      entry?.change?.after?.variable_name === "HUMAN_MERGE_OPERATOR_TEAM_ID",
  );
  if (mirror.length > 0) {
    errors.push(
      "mutable HUMAN_MERGE_OPERATOR_TEAM_ID repository-variable authority is forbidden",
    );
  }
}

export function validateHumanMergeBoundaryPlan(
  plan,
  {
    policy = SOURCE_HUMAN_MERGE_BOUNDARY_POLICY,
    recoveryTargetOnly = false,
  } = {},
) {
  const errors = [];
  if (recoveryTargetOnly) return errors;
  if (!isObject(plan) || !Array.isArray(plan.resource_changes)) {
    return ["Terraform plan JSON must include resource_changes"];
  }
  const expected = validateSourcePolicy(policy, errors);
  validateGithubProvider(plan, errors);
  rejectMutableTeamMirror(plan, errors);
  const related = plan.resource_changes.filter(relatedRulesetEntry);
  if (related.length !== 1) {
    errors.push(
      "Terraform plan must contain one canonical human lifecycle ruleset and no other first-class repository rulesets",
    );
    return errors;
  }
  validateRulesetEntry(related[0], expected, errors);
  return errors;
}

export function assertHumanMergeBoundaryPlan(plan, options) {
  const errors = validateHumanMergeBoundaryPlan(plan, options);
  if (errors.length > 0) {
    throw new Error(
      `Human merge boundary plan policy failed: ${errors.join("; ")}`,
    );
  }
}

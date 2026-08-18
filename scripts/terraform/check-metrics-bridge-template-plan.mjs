#!/usr/bin/env node

import { isDeepStrictEqual } from "node:util";

import { attributeExpression, terraformTopLevelBlocks } from "../lib/hcl.mjs";

export const METRICS_BRIDGE_SERVICE_ADDRESS =
  "google_cloud_run_v2_service.metrics_bridge";
export const PEG_POLICY_BUCKET_CONTROLLER_ADDRESS =
  "google_project_iam_custom_role.peg_policy_bucket_controller";

const ROLLOUT_MARKER = "metrics_bridge_template_rollout_active";

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

function cloneWithoutRevision(template) {
  if (!Array.isArray(template) || template.length !== 1) return undefined;
  if (!isObject(template[0])) return undefined;
  const clone = structuredClone(template);
  delete clone[0].revision;
  return clone;
}

function templateRevision(template) {
  if (!Array.isArray(template) || template.length !== 1) return undefined;
  if (!isObject(template[0])) return undefined;
  return template[0].revision;
}

function containsTrue(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsTrue);
  if (isObject(value)) return Object.values(value).some(containsTrue);
  return false;
}

function containsString(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsString(entry, expected));
  }
  if (isObject(value)) {
    return Object.values(value).some((entry) =>
      containsString(entry, expected),
    );
  }
  return false;
}

function serviceIdentityErrors(change) {
  const errors = [];
  if (change.mode !== "managed") {
    errors.push("Metrics Bridge plan entry must be a managed resource");
  }
  if (
    change.address !== METRICS_BRIDGE_SERVICE_ADDRESS ||
    change.type !== "google_cloud_run_v2_service" ||
    change.name !== "metrics_bridge" ||
    change.module_address !== undefined ||
    change.index !== undefined ||
    change.deposed !== undefined ||
    change.previous_address !== undefined
  ) {
    errors.push(
      "Metrics Bridge plan entry has an unexpected resource identity",
    );
  }
  return errors;
}

function relatedServiceEntry(change) {
  const address = change?.address;
  const previousAddress = change?.previous_address;
  return (
    address === METRICS_BRIDGE_SERVICE_ADDRESS ||
    previousAddress === METRICS_BRIDGE_SERVICE_ADDRESS ||
    (typeof address === "string" &&
      address.includes("google_cloud_run_v2_service.metrics_bridge"))
  );
}

function validateEnvelope(plan, errors, recoveryTargetOnly) {
  if (!isObject(plan)) {
    errors.push("Terraform plan JSON must be an object");
    return false;
  }
  const formatMajor =
    typeof plan.format_version === "string"
      ? Number.parseInt(plan.format_version.split(".")[0], 10)
      : Number.NaN;
  if (formatMajor !== 1) {
    errors.push("Terraform plan JSON must use supported format major 1");
  }
  if (
    plan.complete !== true &&
    !(recoveryTargetOnly === true && plan.complete === false)
  ) {
    errors.push("Terraform plan must be complete");
  }
  if (plan.errored !== false) {
    errors.push("Terraform plan must not be errored");
  }
  if (typeof plan.applyable !== "boolean") {
    errors.push("Terraform plan must declare whether it is applyable");
  }
  if (!Array.isArray(plan.resource_changes)) {
    errors.push("Terraform plan JSON must include resource_changes");
    return false;
  }
  if (
    plan.deferred_changes !== undefined &&
    (!Array.isArray(plan.deferred_changes) || plan.deferred_changes.length > 0)
  ) {
    errors.push("Terraform plan must not contain deferred changes");
  }
  if (
    plan.action_invocations !== undefined &&
    (!Array.isArray(plan.action_invocations) ||
      plan.action_invocations.length > 0)
  ) {
    errors.push("Terraform plan must not contain action invocations");
  }
  return true;
}

function validateRecoveryPlan(plan, rolloutActive, errors) {
  if (rolloutActive) {
    errors.push(
      "Metrics Bridge rollout mode forbids targeted platform recovery",
    );
  }
  const mutations = plan.resource_changes.filter((resourceChange) => {
    if (resourceChange?.mode !== "managed") return false;
    const actions = resourceChange?.change?.actions;
    return !sameActions(actions, ["no-op"]);
  });
  if (
    mutations.length !== 1 ||
    mutations[0]?.address !== PEG_POLICY_BUCKET_CONTROLLER_ADDRESS ||
    mutations[0]?.mode !== "managed" ||
    mutations[0]?.type !== "google_project_iam_custom_role" ||
    mutations[0]?.name !== "peg_policy_bucket_controller" ||
    mutations[0]?.module_address !== undefined ||
    mutations[0]?.index !== undefined ||
    mutations[0]?.deposed !== undefined ||
    mutations[0]?.previous_address !== undefined ||
    !sameActions(mutations[0]?.change?.actions, ["create"])
  ) {
    errors.push(
      "Targeted platform recovery may only create the Peg policy bucket controller role",
    );
  }
}

function validateStableService(change, errors) {
  const actions = change?.change?.actions;
  if (!sameActions(actions, ["no-op"]) && !sameActions(actions, ["update"])) {
    errors.push(
      "Stable Metrics Bridge plan must be a no-op or in-place update",
    );
    return;
  }

  const beforeTemplate = change?.change?.before?.template;
  const afterTemplate = change?.change?.after?.template;
  const beforeComparable = cloneWithoutRevision(beforeTemplate);
  const afterComparable = cloneWithoutRevision(afterTemplate);
  const beforeRevision = templateRevision(beforeTemplate);
  const afterRevision = templateRevision(afterTemplate);
  const templateUnknown = change?.change?.after_unknown?.template;
  if (
    beforeComparable === undefined ||
    afterComparable === undefined ||
    containsTrue(templateUnknown) ||
    !isDeepStrictEqual(beforeComparable, afterComparable) ||
    beforeRevision !== afterRevision
  ) {
    errors.push(
      "Stable Metrics Bridge plan must not change or obscure the service template",
    );
  }
}

function validateRolloutService(change, errors) {
  if (!sameActions(change?.change?.actions, ["update"])) {
    errors.push("Metrics Bridge rollout must be exactly one in-place update");
    return;
  }

  const beforeTemplate = change?.change?.before?.template;
  const afterTemplate = change?.change?.after?.template;
  const beforeComparable = cloneWithoutRevision(beforeTemplate);
  const afterComparable = cloneWithoutRevision(afterTemplate);
  const beforeRevision = templateRevision(beforeTemplate);
  const afterRevision = templateRevision(afterTemplate);
  const unknownTemplate = change?.change?.after_unknown?.template;
  const unknownRevision = Array.isArray(unknownTemplate)
    ? unknownTemplate[0]?.revision
    : undefined;

  if (typeof beforeRevision !== "string" || beforeRevision.length === 0) {
    errors.push(
      "Metrics Bridge rollout requires a named live revision before apply",
    );
  }
  if (afterRevision !== null && afterRevision !== undefined) {
    errors.push(
      "Metrics Bridge rollout must clear the generated revision name",
    );
  }
  if (unknownRevision === true || containsTrue(unknownRevision)) {
    errors.push("Metrics Bridge rollout revision must be known before apply");
  }
  if (
    beforeComparable === undefined ||
    afterComparable === undefined ||
    containsTrue(unknownTemplate) ||
    isDeepStrictEqual(beforeComparable, afterComparable)
  ) {
    errors.push(
      "Metrics Bridge rollout requires a known managed template change",
    );
  }
  if (
    typeof beforeRevision === "string" &&
    containsString(afterTemplate, beforeRevision)
  ) {
    errors.push("Metrics Bridge rollout must not retain the old revision name");
  }
}

export function parseMetricsBridgeTemplateRolloutActive(source) {
  if (typeof source !== "string") {
    throw new Error("Metrics Bridge Terraform source must be text");
  }
  const parserErrors = [];
  const blocks = terraformTopLevelBlocks(
    { "terraform/metrics-bridge.tf": source },
    parserErrors,
  );
  if (parserErrors.length > 0) {
    throw new Error(
      `Invalid Metrics Bridge Terraform source: ${parserErrors[0]}`,
    );
  }
  const markerBlocks = blocks.filter(
    (block) =>
      block.kind === "locals" &&
      attributeExpression(block, ROLLOUT_MARKER) !== undefined,
  );
  if (markerBlocks.length !== 1) {
    throw new Error(
      "Metrics Bridge Terraform source must declare one rollout marker in locals",
    );
  }
  const expression = attributeExpression(markerBlocks[0], ROLLOUT_MARKER);
  const occurrences = [
    ...markerBlocks[0].code.matchAll(
      /^\s*metrics_bridge_template_rollout_active\s*=/gmu,
    ),
  ].length;
  if (occurrences !== 1 || !["true", "false"].includes(expression)) {
    throw new Error(
      "Metrics Bridge rollout marker must be one literal boolean",
    );
  }
  return expression === "true";
}

export function validateMetricsBridgeTemplatePlan(
  plan,
  { rolloutActive, requireService = true, recoveryTargetOnly = false } = {},
) {
  const errors = [];
  if (typeof rolloutActive !== "boolean") {
    errors.push("Metrics Bridge rollout mode must be a boolean");
  }
  if (!validateEnvelope(plan, errors, recoveryTargetOnly)) return errors;

  const relatedEntries = plan.resource_changes.filter(relatedServiceEntry);
  if (relatedEntries.length > 1) {
    errors.push(
      "Terraform plan must contain one canonical Metrics Bridge entry",
    );
  }
  const service = relatedEntries[0];
  if (service) errors.push(...serviceIdentityErrors(service));
  if (requireService && !service) {
    errors.push("Terraform plan must contain the Metrics Bridge service");
  }

  if (recoveryTargetOnly) {
    validateRecoveryPlan(plan, rolloutActive, errors);
  } else if (rolloutActive) {
    if (!service) {
      errors.push("Metrics Bridge rollout plan must update the service");
    } else {
      validateRolloutService(service, errors);
    }
  } else if (service) {
    validateStableService(service, errors);
  }
  const hasManagedMutation = plan.resource_changes.some(
    (resourceChange) =>
      resourceChange?.mode === "managed" &&
      !sameActions(resourceChange?.change?.actions, ["no-op"]),
  );
  if (hasManagedMutation && plan.applyable !== true) {
    errors.push("Terraform plan mutations must be applyable");
  }
  return errors;
}

export function assertMetricsBridgeTemplatePlan(plan, options) {
  const errors = validateMetricsBridgeTemplatePlan(plan, options);
  if (errors.length > 0) {
    throw new Error(
      `Unsafe Metrics Bridge platform plan:\n- ${errors.join("\n- ")}`,
    );
  }
}

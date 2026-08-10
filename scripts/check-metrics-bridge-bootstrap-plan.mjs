#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const METRICS_BRIDGE_SERVICE_ADDRESS =
  "google_cloud_run_v2_service.metrics_bridge";
export const METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS =
  "google_cloud_run_v2_service_iam_member.metrics_bridge_public";

const PHASE_RULES = {
  service: {
    address: METRICS_BRIDGE_SERVICE_ADDRESS,
    requireCreate: true,
  },
  "public-binding": {
    address: METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS,
    requireCreate: false,
  },
};

function sameActions(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((action, index) => action === expected[index])
  );
}

export function validateMetricsBridgeBootstrapPlan(plan, phase) {
  const rule = PHASE_RULES[phase];
  if (!rule) {
    return [`unknown Metrics Bridge bootstrap phase: ${String(phase)}`];
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return ["Terraform plan JSON must be an object"];
  }
  if (!Array.isArray(plan.resource_changes)) {
    return ["Terraform plan JSON must include resource_changes"];
  }

  const errors = [];
  if (Array.isArray(plan.resource_drift) && plan.resource_drift.length > 0) {
    errors.push("bootstrap plan must not contain refreshed resource drift");
  }
  if (
    Array.isArray(plan.deferred_changes) &&
    plan.deferred_changes.length > 0
  ) {
    errors.push("bootstrap plan must not contain deferred changes");
  }

  let allowedCreates = 0;
  for (const resourceChange of plan.resource_changes) {
    const actions = resourceChange?.change?.actions;
    if (sameActions(actions, ["no-op"]) || sameActions(actions, ["read"])) {
      continue;
    }
    if (
      resourceChange?.mode === "managed" &&
      resourceChange?.address === rule.address &&
      sameActions(actions, ["create"])
    ) {
      allowedCreates += 1;
      continue;
    }
    errors.push(
      `${resourceChange?.address ?? "unknown resource"}: forbidden bootstrap plan actions ${JSON.stringify(actions)}`,
    );
  }

  if (allowedCreates > 1) {
    errors.push(
      `${phase} bootstrap plan must create its resource at most once`,
    );
  }
  if (rule.requireCreate && allowedCreates !== 1) {
    errors.push(
      `${phase} bootstrap plan must create its resource exactly once`,
    );
  }
  return errors;
}

export function assertMetricsBridgeBootstrapPlan(plan, phase) {
  const errors = validateMetricsBridgeBootstrapPlan(plan, phase);
  if (errors.length > 0) {
    throw new Error(
      `Unsafe Metrics Bridge ${String(phase)} bootstrap plan:\n- ${errors.join("\n- ")}`,
    );
  }
}

function main() {
  const phase = process.argv[2];
  let plan;
  try {
    plan = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse Terraform plan JSON: ${message}`, {
      cause: error,
    });
  }
  assertMetricsBridgeBootstrapPlan(plan, phase);
  process.stdout.write(`Metrics Bridge ${phase} bootstrap plan is safe.\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

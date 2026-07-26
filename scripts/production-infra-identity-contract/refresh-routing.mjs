import {
  APPLY_WORKFLOWS,
  DRIFT_REFRESH_CONDITION,
  GOOGLE_AUTH_ACTION,
  GOOGLE_PROVIDER_REFRESH_WORKFLOWS,
  PLAN_JOB_CONDITION,
  PLAN_PROVIDER_TARGET,
  PLAN_TARGET_EMAIL,
  PR_PLAN_CONDITION,
  PR_PLAN_TARGETS,
  PRODUCTION_PROVIDER_VARIABLE,
  PRODUCTION_SERVICE_ACCOUNT_VARIABLE,
  REFRESH_PROVIDER_VARIABLE,
  REFRESH_SERVICE_ACCOUNT_VARIABLE,
  REFRESH_TARGET_EMAIL,
  TRUSTED_REFRESH_CONDITION,
  WRITE_TERRAFORM_IDENTITIES,
} from "./constants.mjs";
import {
  isMapping,
  normalizeWorkflowScalar,
  stripShellComment,
  terraformPlanCommands,
  terraformPlanFlagsMatch,
  workflowJobSteps,
} from "./workflow-inventory.mjs";

const DRIFT_WORKFLOW = ".github/workflows/terraform-drift.yml";
const REFRESH_WORKFLOWS = new Set([...APPLY_WORKFLOWS, DRIFT_WORKFLOW]);

function authMatches(step, provider, serviceAccount, condition) {
  return (
    step.uses === GOOGLE_AUTH_ACTION &&
    isMapping(step.with) &&
    step.with.workload_identity_provider === provider &&
    step.with.service_account === serviceAccount &&
    !Object.hasOwn(step.with, "credentials_json") &&
    normalizeWorkflowScalar(step.if) === normalizeWorkflowScalar(condition)
  );
}

function initMatches(step, email, condition) {
  return (
    typeof step.run === "string" &&
    step.run.includes("terraform init") &&
    step.run.includes(`impersonate_service_account=${email}`) &&
    normalizeWorkflowScalar(step.if) === normalizeWorkflowScalar(condition)
  );
}

function referencesTerraformCliNamespace(value) {
  if (typeof value === "string") {
    return value.includes("TF_CLI_");
  }
  if (Array.isArray(value)) return value.some(referencesTerraformCliNamespace);
  return (
    isMapping(value) &&
    Object.entries(value).some(
      ([key, entry]) =>
        referencesTerraformCliNamespace(key) ||
        (key === "run" && typeof entry === "string"
          ? entry
              .split(/\r?\n/u)
              .some((line) => stripShellComment(line).includes("TF_CLI_"))
          : referencesTerraformCliNamespace(entry)),
    )
  );
}

function selectorsAreScoped(workflowPath, counts, errors) {
  const uses = [
    counts.sourceProvider,
    counts.sourceServiceAccount,
    counts.decodedProvider,
    counts.decodedServiceAccount,
  ];
  if (!REFRESH_WORKFLOWS.has(workflowPath)) {
    if (uses.some(Boolean)) {
      errors.push(
        `${workflowPath}: refresh identity variables are allowed only in exact trusted-main refresh routes`,
      );
    }
    return false;
  }
  if (uses.some((count) => count !== 1)) {
    errors.push(
      `${workflowPath}: both refresh identity variables must appear exactly once in the registered refresh auth step`,
    );
  }
  return true;
}

function usesWriteIdentity(job, count) {
  return (
    count(job, "secrets", "GCP_SERVICE_ACCOUNT") > 0 ||
    count(job, "vars", PRODUCTION_PROVIDER_VARIABLE) > 0 ||
    count(job, "vars", PRODUCTION_SERVICE_ACCOUNT_VARIABLE) > 0 ||
    WRITE_TERRAFORM_IDENTITIES.some((identity) =>
      JSON.stringify(job).includes(identity),
    )
  );
}

function validatePlan(workflowPath, workflow, counts, errors) {
  const plan = workflow.jobs?.plan;
  if (!isMapping(plan)) {
    errors.push(`${workflowPath}: plan job is missing`);
    return;
  }
  if (
    normalizeWorkflowScalar(plan.if) !==
    normalizeWorkflowScalar(PLAN_JOB_CONDITION)
  ) {
    errors.push(
      `${workflowPath}: plan job must use the exact eligible-PR and trusted-main guard`,
    );
  }
  if (
    referencesTerraformCliNamespace(workflow.env) ||
    referencesTerraformCliNamespace(plan)
  ) {
    errors.push(
      `${workflowPath}: plan job must not reference the TF_CLI_ control namespace`,
    );
  }
  const planSteps = workflowJobSteps(plan);
  const authSteps = planSteps.filter(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("google-github-actions/auth@"),
  );
  const prAuth = planSteps.filter((step) =>
    authMatches(
      step,
      "${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}",
      "${{ secrets.GCP_SERVICE_ACCOUNT_PLAN }}",
      PR_PLAN_CONDITION,
    ),
  );
  const refreshAuth = planSteps.filter((step) =>
    authMatches(
      step,
      `\${{ vars.${REFRESH_PROVIDER_VARIABLE} }}`,
      `\${{ vars.${REFRESH_SERVICE_ACCOUNT_VARIABLE} }}`,
      TRUSTED_REFRESH_CONDITION,
    ),
  );
  if (authSteps.length !== 2 || prAuth.length !== 1) {
    errors.push(
      `${workflowPath}: PR plan auth must use the generic provider and state-only account`,
    );
  }
  if (refreshAuth.length !== 1) {
    errors.push(
      `${workflowPath}: trusted-main auth must use the refresh variables`,
    );
  }
  if (
    counts.selectorCount(plan, "secrets", "GCP_WORKLOAD_IDENTITY_PROVIDER") !==
      1 ||
    counts.selectorCount(plan, "secrets", "GCP_SERVICE_ACCOUNT_PLAN") !== 1 ||
    usesWriteIdentity(plan, counts.selectorCount)
  ) {
    errors.push(`${workflowPath}: plan paths must not use a write identity`);
  }
  for (const [email, condition, label] of [
    [PLAN_TARGET_EMAIL, PR_PLAN_CONDITION, "PR"],
    [REFRESH_TARGET_EMAIL, TRUSTED_REFRESH_CONDITION, "trusted-main"],
  ]) {
    if (
      planSteps.filter((step) => initMatches(step, email, condition)).length !==
      1
    ) {
      errors.push(
        `${workflowPath}: ${label} init must use its read-only backend identity`,
      );
    }
  }
  if (
    planSteps.filter(
      (step) =>
        typeof step.run === "string" && step.run.includes("terraform init"),
    ).length !== 2
  ) {
    errors.push(
      `${workflowPath}: plan paths must have only the two read-only init routes`,
    );
  }
  if (
    GOOGLE_PROVIDER_REFRESH_WORKFLOWS.has(workflowPath) &&
    plan.env?.TF_VAR_terraform_service_account !== PLAN_PROVIDER_TARGET
  ) {
    errors.push(
      `${workflowPath}: Google provider plans must select the PR or refresh identity`,
    );
  }

  const commandSteps = planSteps.filter(
    (step) => terraformPlanCommands(step.run).length,
  );
  const commands =
    commandSteps.length === 1 ? terraformPlanCommands(commandSteps[0].run) : [];
  if (
    commandSteps[0]?.env?.EVENT_NAME !== "${{ github.event_name }}" ||
    !commandSteps[0]?.run.includes(
      'if [ "$EVENT_NAME" = "pull_request" ]; then',
    ) ||
    commands.length !== 2 ||
    !terraformPlanFlagsMatch(
      commands[0],
      PR_PLAN_TARGETS.get(workflowPath),
      true,
    ) ||
    !terraformPlanFlagsMatch(commands[1], [], false)
  ) {
    errors.push(
      `${workflowPath}: PR plans must keep targets with -refresh=false/-lock=false and trusted-main must full-refresh with -lock=false`,
    );
  }
}

function validateDrift(workflowPath, workflow, counts, errors) {
  const drift = workflow.jobs?.["drift-check"];
  if (!isMapping(drift)) {
    errors.push(`${workflowPath}: drift-check job is missing`);
    return;
  }
  if (
    normalizeWorkflowScalar(drift.if) !==
    normalizeWorkflowScalar(DRIFT_REFRESH_CONDITION)
  ) {
    errors.push(`${workflowPath}: drift-check must be restricted to main`);
  }
  if (
    referencesTerraformCliNamespace(workflow.env) ||
    referencesTerraformCliNamespace(drift)
  ) {
    errors.push(
      `${workflowPath}: drift-check must not reference the TF_CLI_ control namespace`,
    );
  }
  const driftSteps = workflowJobSteps(drift);
  const authSteps = driftSteps.filter(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("google-github-actions/auth@"),
  );
  const auth = driftSteps.filter((step) =>
    authMatches(
      step,
      `\${{ vars.${REFRESH_PROVIDER_VARIABLE} }}`,
      `\${{ vars.${REFRESH_SERVICE_ACCOUNT_VARIABLE} }}`,
      undefined,
    ),
  );
  const init = driftSteps.filter((step) =>
    initMatches(step, REFRESH_TARGET_EMAIL, undefined),
  );
  if (authSteps.length !== 1 || auth.length !== 1) {
    errors.push(`${workflowPath}: drift auth must use the refresh variables`);
  }
  if (
    init.length !== 1 ||
    driftSteps.filter(
      (step) =>
        typeof step.run === "string" && step.run.includes("terraform init"),
    ).length !== 1 ||
    drift.env?.TF_VAR_terraform_service_account !== REFRESH_TARGET_EMAIL
  ) {
    errors.push(
      `${workflowPath}: drift must use the refresh backend and provider identity`,
    );
  }
  const commandSteps = driftSteps.filter(
    (step) => terraformPlanCommands(step.run).length,
  );
  const commands =
    commandSteps.length === 1 ? terraformPlanCommands(commandSteps[0].run) : [];
  if (
    commands.length !== 1 ||
    !terraformPlanFlagsMatch(commands[0], [], false) ||
    JSON.stringify(workflow).includes("planSa") ||
    usesWriteIdentity(drift, counts.selectorCount)
  ) {
    errors.push(
      `${workflowPath}: drift must full-refresh every stack with -lock=false and no write branch`,
    );
  }
}

export function validateRefreshRouting(
  workflowPath,
  parsedWorkflow,
  counts,
  errors,
) {
  if (!selectorsAreScoped(workflowPath, counts, errors)) return;
  if (!isMapping(parsedWorkflow.jobs)) {
    errors.push(`${workflowPath}: workflow jobs must be a mapping`);
  } else if (workflowPath === DRIFT_WORKFLOW) {
    validateDrift(workflowPath, parsedWorkflow, counts, errors);
  } else {
    validatePlan(workflowPath, parsedWorkflow, counts, errors);
  }
}

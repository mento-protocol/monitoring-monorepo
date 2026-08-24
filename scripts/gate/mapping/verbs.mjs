/**
 * The 29 effect verbs, as the gate defines them.
 *
 * Each function here is the Node twin of one `add_*` helper in
 * `scripts/agent-quality-gate.sh`. The bodies are transcriptions, not
 * re-designs: the command strings, their order, the reason suffixes in
 * parentheses, and which bucket each lands in are all contract. The parity
 * harness compares this engine's plan against the live gate's, so a paraphrase
 * shows up as a difference rather than as a nicer implementation.
 *
 * Two things are easy to get wrong and are called out where they happen:
 * several bundles schedule a CODEGEN preflight before their quality commands,
 * and several append a parenthesised suffix to the caller's reason. Both are
 * load-bearing — the suffix reaches `routing.test.mjs`, and the codegen order
 * reaches `sort_codegen_commands`.
 */

import { shellQuote } from "./shell-quote.mjs";

/** `pnpm exec turbo run <task> --filter=<pkg> --cache=local:rw` */
export const turboLocalCacheCommand = (packageName, taskName) =>
  `pnpm exec turbo run ${taskName} --filter=${packageName} --cache=local:rw`;

const addTurboPackageTask = (plan, packageName, taskName, reason) => {
  plan.addCommand(turboLocalCacheCommand(packageName, taskName), reason);
};

const addTurboDashboardTask = (plan, taskName, reason) => {
  addTurboPackageTask(plan, "@mento-protocol/ui-dashboard", taskName, reason);
};

// ── codegen ────────────────────────────────────────────────────────────────

const addIndexerPostCodegenInstall = (plan) => {
  plan.addPostCodegen(
    "pnpm install --frozen-lockfile",
    "link generated package after indexer codegen",
  );
};

const addDashboardCodegenCommitCheck = (plan) => {
  // Built by string concatenation in the gate; reproduced byte for byte,
  // including the escaped inner quotes, because this whole thing is one
  // command string the stamp hashes.
  const command =
    'if [[ -n "$(git status --porcelain -- ui-dashboard/src/lib/__generated__/graphql.ts)" ]]; then' +
    " git status --short -- ui-dashboard/src/lib/__generated__/graphql.ts;" +
    ' echo "Generated dashboard GraphQL types are not committed. Run pnpm dashboard:codegen and commit the result." >&2;' +
    " exit 1; fi";
  plan.addPostCodegen(
    command,
    "verify dashboard GraphQL generated output is committed",
  );
};

export const addDashboardCodegen = (plan, reason) => {
  plan.addCodegen("pnpm dashboard:codegen", reason);
  addDashboardCodegenCommitCheck(plan);
};

export const addIndexerMainnetCodegen = (plan, reason) => {
  plan.addCodegen("pnpm indexer:codegen", reason);
  addIndexerPostCodegenInstall(plan);
};

export const addIndexerTestnetCodegen = (plan, reason) => {
  plan.addCodegen("pnpm indexer:testnet:codegen", reason);
  addIndexerPostCodegenInstall(plan);
};

export const addIndexerBridgeCodegen = (plan, reason) => {
  plan.addCodegen(
    "pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen",
    reason,
  );
  addIndexerPostCodegenInstall(plan);
};

export const addAllIndexerCodegen = (plan, reason) => {
  addIndexerBridgeCodegen(plan, reason);
  addIndexerTestnetCodegen(plan, reason);
  addIndexerMainnetCodegen(plan, reason);
};

export const addBridgeCodegenThenRestoreMainnet = (plan, bridgeReason) => {
  addIndexerBridgeCodegen(plan, bridgeReason);
  addIndexerMainnetCodegen(
    plan,
    "restore full multichain generated package after non-mainnet codegen",
  );
};

export const addReserveYieldCodegenThenRestoreMainnet = (plan, reason) => {
  // Despite the name, this schedules no mainnet restore — the gate's own body
  // does not either. Transcribed as it is, not as the name suggests.
  plan.addCodegen(
    "pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test",
    reason,
  );
  addIndexerPostCodegenInstall(plan);
};

// ── package quality bundles ────────────────────────────────────────────────

export const addPackageQualityCommands = (plan, packageName, reason) => {
  // Both `tsc --noEmit` and the type-aware ESLint rules need the generated
  // Envio types, so codegen is forced as a preflight for these two packages.
  if (packageName === "@mento-protocol/indexer-envio") {
    addIndexerMainnetCodegen(
      plan,
      `${reason} (codegen needed before indexer typecheck/lint)`,
    );
  } else if (packageName === "@mento-protocol/ui-dashboard") {
    addDashboardCodegen(
      plan,
      `${reason} (codegen needed before dashboard typecheck/lint)`,
    );
  }
  addTurboPackageTask(plan, packageName, "lint", reason);
  addTurboPackageTask(plan, packageName, "typecheck", reason);
  if (packageName === "@mento-protocol/metrics-bridge") {
    plan.addCommand(`pnpm --filter ${packageName} build`, reason);
  }
  plan.addCommand(
    `pnpm --filter ${packageName} test:coverage`,
    `${reason} (coverage floor)`,
  );
  addTurboPackageTask(
    plan,
    packageName,
    "knip",
    `${reason} (knip: unused files/deps/exports)`,
  );
  plan.addCommand(
    "pnpm code-health:deps",
    `${reason} (dep-cruiser: cross-package boundaries + cycles)`,
  );
  plan.addChecklist(
    "docs/pr-checklists/code-health.md",
    `${reason} (code-health gates fire on this change)`,
  );
};

export const addPackageVitestTypecheckCommands = (
  plan,
  packageName,
  reason,
) => {
  if (packageName === "@mento-protocol/indexer-envio") {
    addIndexerMainnetCodegen(
      plan,
      `${reason} (codegen needed before indexer typecheck)`,
    );
  }
  addTurboPackageTask(plan, packageName, "typecheck", reason);
  plan.addCommand(
    `pnpm --filter ${packageName} test:coverage`,
    `${reason} (coverage floor)`,
  );
};

export const addDashboardQualityCommands = (plan, reason) => {
  addPackageQualityCommands(plan, "@mento-protocol/ui-dashboard", reason);
  plan.addCommand(
    "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium",
    reason,
  );
  addTurboDashboardTask(plan, "test:browser", reason);
};

export const addAegisQualityCommands = (plan, reason) => {
  addTurboPackageTask(plan, "@mento-protocol/aegis", "typecheck", reason);
  plan.addCommand("pnpm --filter @mento-protocol/aegis build", reason);
  addTurboPackageTask(plan, "@mento-protocol/aegis", "lint", reason);
  addTurboPackageTask(
    plan,
    "@mento-protocol/aegis",
    "knip",
    `${reason} (knip: unused files/deps/exports)`,
  );
  plan.addCommand("pnpm --filter @mento-protocol/aegis test:cov", reason);
  plan.addCommand("cd aegis && forge test", reason);
  plan.addCommand(
    "pnpm code-health:deps",
    `${reason} (dep-cruiser: cross-package boundaries + cycles)`,
  );
  plan.addChecklist(
    "docs/pr-checklists/code-health.md",
    `${reason} (code-health gates fire on this change)`,
  );
};

export const addAlertsOncallQualityCommands = (plan, reason) => {
  const pkg = "@mento-protocol/alerts-oncall-announcer";
  addTurboPackageTask(plan, pkg, "lint", reason);
  addTurboPackageTask(plan, pkg, "typecheck", reason);
  plan.addCommand(
    `pnpm --filter ${pkg} test:coverage`,
    `${reason} (coverage floor)`,
  );
  addTurboPackageTask(
    plan,
    pkg,
    "knip",
    `${reason} (knip: unused files/deps/exports)`,
  );
};

// ── dashboard extras ───────────────────────────────────────────────────────

export const addUiReactDoctorFullScore = (plan, reason) => {
  addTurboDashboardTask(plan, "react-doctor:score", reason);
};

export const addUiReactDoctorDiff = (plan, reason, facts) => {
  // Carries the base ref AND its resolved OID, both `%q`-quoted, so the Turbo
  // cache key moves when the base moves.
  const command =
    `REACT_DOCTOR_BASE_REF=${shellQuote(facts.baseRef)}` +
    ` REACT_DOCTOR_BASE_CACHE_KEY=${shellQuote(facts.baseOid)}` +
    ` ${turboLocalCacheCommand("@mento-protocol/ui-dashboard", "react-doctor:diff")}`;
  plan.addCommand(command, reason);
};

export const addUiMutationBaseline = (plan, reason) => {
  plan.addCommand("pnpm dashboard:mutation", reason);
};

export const addUiSizeLimit = (plan, reason) => {
  // The pinned deployment identity keeps the command hermetic under Trunk's
  // stripped environment; it is part of the command string, not the env.
  plan.addCommand(
    `VERCEL_DEPLOYMENT_ID=local-quality-gate ${turboLocalCacheCommand("@mento-protocol/ui-dashboard", "size-limit")}`,
    reason,
  );
};

export const addBridgeMutationBaseline = (plan, reason) => {
  plan.addCommand("pnpm bridge:mutation", reason);
};

export const addIndexerMutationBaseline = (plan, reason) => {
  plan.addCommand("pnpm indexer:mutation", reason);
};

// ── workspace escalation ───────────────────────────────────────────────────

export const addWorkspaceQualityCommands = (plan, reason) => {
  // The flag is the point: it disables scoped tests for the whole run.
  plan.sawWorkspaceEscalation = true;
  plan.addCommand("pnpm skew:check", reason);
  addAllIndexerCodegen(plan, reason);
  // Deliberately the lightweight dashboard bundle, not the full one: the
  // browser suite is high-cost and flaky under the sandbox, and CI runs it in
  // its own job. A direct ui-dashboard/* change still gets the full bundle.
  addPackageQualityCommands(plan, "@mento-protocol/ui-dashboard", reason);
  addUiReactDoctorFullScore(plan, reason);
  addUiSizeLimit(plan, reason);
  addPackageQualityCommands(plan, "@mento-protocol/indexer-envio", reason);
  addPackageQualityCommands(plan, "@mento-protocol/metrics-bridge", reason);
  addPackageQualityCommands(plan, "@mento-protocol/integration-probes", reason);
  addPackageQualityCommands(plan, "@mento-protocol/config", reason);
  addPackageQualityCommands(
    plan,
    "@mento-protocol/governance-watchdog",
    reason,
  );
  addAegisQualityCommands(plan, reason);
};

// ── terraform ──────────────────────────────────────────────────────────────

export const addTerraformValidateCommands = (plan, module, reason) => {
  const dataDir = `${module}/.terraform-agent-gate`;
  plan.addCommand(
    `TF_DATA_DIR=${dataDir} node scripts/terraform/terraform-fmt-check.mjs ${shellQuote(module)}`,
    reason,
  );
  plan.addCommand(
    `TF_DATA_DIR=${dataDir} terraform -chdir=${module} init -backend=false -input=false`,
    reason,
  );
  plan.addCommand(
    `TF_DATA_DIR=${dataDir} terraform -chdir=${module} validate -no-color`,
    reason,
  );
};

export const addRegisteredTerraformValidateCommands = (plan, reason, facts) => {
  for (const stackPath of facts.terraformStackPaths) {
    addTerraformValidateCommands(plan, stackPath, reason);
  }
};

// ── misc ───────────────────────────────────────────────────────────────────

export const addAdrReminder = (plan, reason, facts) => {
  const command =
    "node scripts/pr/check-adr-reminder.mjs" +
    ` --base ${shellQuote(facts.baseRef)} --head ${shellQuote(facts.headRef)}` +
    ` --include-untracked --changed-paths-file ${shellQuote(facts.changedPathsFile)}`;
  plan.addCommand(command, reason);
};

export const addSentrySuiteGateCommands = (plan, reason) => {
  plan.addCommand(
    "/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry/gate/sentry-suite-gate.test.mjs",
    reason,
  );
  plan.addCommand(
    "/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node scripts/sentry/gate/sentry-suite-gate.mjs",
    `${reason} (validate the committed manifest against the real suites)`,
  );
};

/** The suites a root tooling-script change re-runs, in the gate's order. */
const ROOT_TOOLING_SCRIPT_COMMANDS = [
  "node scripts/check-agent-quality-gate-package-scripts.mjs",
  "bash scripts/agent-quality-gate.test.sh",
  "node scripts/gate/agent-prewarm.test.mjs",
  "node scripts/pr/review-materiality.test.mjs",
  "node scripts/pr/agent-issue-board.test.mjs",
  "pnpm sentry:ingest:test",
  "pnpm sentry:digest:test",
  "pnpm sentry:project:test",
  "pnpm sentry:brief:test",
  "pnpm sentry:autofix:select:test",
  "pnpm sentry:autofix:finalize:test",
  "pnpm sentry:archive:test",
  "pnpm sentry:broker:test",
  "pnpm sentry:requeue:test",
  "node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs",
  "node scripts/pr/pr-feedback-state.test.mjs",
  "node scripts/pr/pr-ready-state.test.mjs",
  "node scripts/coderabbit-config.test.mjs",
  "node scripts/terraform/terraform-fmt-check.test.mjs",
  "node scripts/tf-stacks.test.mjs",
  "node scripts/supply-chain/lockfile-lint.test.mjs",
  "node scripts/supply-chain/version-skew-check.test.mjs",
  "node scripts/supply-chain/override-prune-report.test.mjs",
  "node scripts/pr/check-adr-reminder.test.mjs",
  "node scripts/context/docs-index.test.mjs",
  "node scripts/docs/docs-audit.test.mjs",
  "node scripts/docs/docs-garden-issue.test.mjs",
  "node scripts/docs/docs-navigation-eval.test.mjs",
  "node scripts/context/agent-context-budget.test.mjs",
];

export const addRootToolingPackageScriptChecks = (plan, reason) => {
  for (const command of ROOT_TOOLING_SCRIPT_COMMANDS) {
    plan.addCommand(command, reason);
  }
};

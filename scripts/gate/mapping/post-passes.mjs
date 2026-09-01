/**
 * The five whole-set passes that run AFTER every changed path has been routed.
 *
 * They are separate from the verbs because they cannot be decided per path:
 * each reads the complete changed set or the complete command list. Their order
 * is fixed and is itself contract — Trunk is prepended first so it lands at the
 * head, codegen is sorted before the plan is written, workspace dependency
 * setup is added from the complete command list, Turbo compaction rewrites the
 * quality bucket, and scoped tests rewrite it again afterwards.
 *
 *   addTrunkCheckCommand → sortCodegenCommands → addWorkspaceConfigBuild →
 *   compactTurbo → applyScopedTests
 */

import { shellQuote } from "./shell-quote.mjs";

// ── 1. Trunk ───────────────────────────────────────────────────────────────

/**
 * Patterns that force a full-repo Trunk scan. A changed path that no longer
 * exists forces one too: a targeted invocation naming a deleted file fails, so
 * the whole-repo scan is the fail-safe answer.
 */
const TRUNK_FULL_SCAN = [
  /^\.trunk\//,
  /^tools\/trunk$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^patches\//,
  /^\.npmrc$/,
  /\/\.npmrc$/,
  /^pnpmfile\.cjs$/,
  /^\.pnpmfile\.cjs$/,
  /^\.node-version$/,
  /\/package\.json$/,
];

export function addTrunkCheckCommand(plan, changedPaths, facts) {
  const missing = changedPaths.some(
    (path) => !facts.pathExistsInWorktree(path),
  );
  const forcesFull =
    missing ||
    changedPaths.some((path) => TRUNK_FULL_SCAN.some((r) => r.test(path)));

  if (forcesFull) {
    plan.prependCommand(
      "./tools/trunk check --ci --all",
      "changed paths require full-repo Trunk checks",
    );
  } else if (changedPaths.length > 0) {
    plan.prependCommand(
      `./tools/trunk check --ci ${changedPaths.map(shellQuote).join(" ")}`,
      "changed existing paths should pass targeted Trunk checks",
    );
  } else {
    plan.prependCommand(
      "./tools/trunk check --ci --all",
      "changed paths could not be mapped to targeted Trunk checks",
    );
  }

  // A .shellcheckrc edit only lints itself under a targeted run, so force a
  // repo-wide ShellCheck-only pass. Prepended after the scan above, so it ends
  // up ahead of it.
  if (changedPaths.includes(".shellcheckrc")) {
    plan.prependCommand(
      "./tools/trunk check --ci --all --filter=shellcheck",
      "ShellCheck config changed; re-validate every script it governs",
    );
  }
}

// ── 2. Codegen order ───────────────────────────────────────────────────────

/**
 * Every Envio codegen variant overwrites the same generated package, so when
 * several are scheduled mainnet must run LAST — the package checks that follow
 * validate the normally-linked package. Known commands come first in this
 * order; anything unrecognised keeps its relative position after them.
 */
const KNOWN_CODEGEN_ORDER = [
  "pnpm dashboard:codegen",
  "pnpm --filter @mento-protocol/indexer-envio indexer:bridge-only:codegen",
  "pnpm --filter @mento-protocol/indexer-envio indexer:reserve-yield:test",
  "pnpm indexer:testnet:codegen",
  "pnpm indexer:codegen",
];

export function sortCodegenCommands(plan) {
  const entries = plan.codegen;
  const sorted = [];
  for (const known of KNOWN_CODEGEN_ORDER) {
    const found = entries.find((entry) => entry.command === known);
    if (found !== undefined) sorted.push(found);
  }
  for (const entry of entries) {
    if (!KNOWN_CODEGEN_ORDER.includes(entry.command)) sorted.push(entry);
  }
  plan.codegen = sorted;
}

// ── 3. Workspace dependency setup ─────────────────────────────────────────

const WORKSPACE_CONFIG_BUILD = "pnpm --filter @mento-protocol/config build";
const WORKSPACE_CONFIG_CONSUMERS = [
  "@mento-protocol/ui-dashboard",
  "@mento-protocol/metrics-bridge",
  "@mento-protocol/integration-probes",
];
const WORKSPACE_CONFIG_ALIASES = [
  "pnpm dashboard:",
  "pnpm bridge:",
  "pnpm integrations:",
];
const WORKSPACE_CONFIG_SCRIPTS = [
  "node scripts/alerts/check-peg-registry-integrity.mjs",
  "node scripts/alerts/check-peg-registry-integrity.test.mjs",
];

function commandConsumesWorkspaceConfig(command) {
  return (
    WORKSPACE_CONFIG_CONSUMERS.some((name) => command.includes(name)) ||
    WORKSPACE_CONFIG_ALIASES.some((prefix) => command.startsWith(prefix)) ||
    WORKSPACE_CONFIG_SCRIPTS.some(
      (script) => command === script || command.startsWith(`${script} `),
    )
  );
}

/**
 * Build ignored shared-config output before any mapped command can load it.
 *
 * Workspace links are source-bound in the coordinator fingerprint because a
 * build can rewrite their ignored `dist/` output during the run. Every plan
 * that consumes this package must normalize that output as a non-reusable
 * setup command instead of binding its pre-setup bytes.
 */
export function addWorkspaceConfigBuild(plan) {
  const consumesConfig = [...plan.buckets.values()].some((entries) =>
    entries.some((entry) => commandConsumesWorkspaceConfig(entry.command)),
  );
  if (!consumesConfig) return;
  plan.addCommand(
    WORKSPACE_CONFIG_BUILD,
    "mapped consumer requires current shared-config output",
  );
}

// ── 4. Turbo compaction ────────────────────────────────────────────────────

const TURBO_COMMAND =
  /^pnpm exec turbo run (\S+) --filter=(@mento-protocol\/\S+) --cache=local:rw$/;

/**
 * Coalesce same-task Turbo invocations into one command with several filters.
 *
 * The compacted command takes the POSITION of the first invocation of that
 * task, and its reason is the `; `-joined list of the distinct reasons that
 * contributed, in first-seen order. Both are what the gate produces and what
 * the suite asserts on.
 */
export function compactTurboQualityCommands(plan) {
  /** @type {Map<string, {packages: string[], reasons: string[]}>} */
  const groups = new Map();
  const slots = [];

  for (const entry of plan.quality) {
    const match = TURBO_COMMAND.exec(entry.command);
    if (match === null) {
      slots.push({ kind: "plain", entry });
      continue;
    }
    const [, task, packageName] = match;
    if (groups.has(task)) {
      const group = groups.get(task);
      if (!group.packages.includes(packageName))
        group.packages.push(packageName);
      if (!group.reasons.includes(entry.reason))
        group.reasons.push(entry.reason);
      continue;
    }
    groups.set(task, { packages: [packageName], reasons: [entry.reason] });
    slots.push({ kind: "turbo", task });
  }

  plan.quality = slots.map((slot) => {
    if (slot.kind === "plain") return slot.entry;
    const group = groups.get(slot.task);
    const filters = group.packages.map((name) => ` --filter=${name}`).join("");
    return {
      command: `pnpm exec turbo run ${slot.task}${filters} --cache=local:rw`,
      reason: group.reasons.join("; "),
    };
  });
}

// ── 5. Scoped tests ────────────────────────────────────────────────────────

/** Package → importer directory. An unmapped package can never be scoped. */
const SCOPED_PACKAGE_DIR = new Map([
  ["@mento-protocol/ui-dashboard", "ui-dashboard"],
  ["@mento-protocol/indexer-envio", "indexer-envio"],
  ["@mento-protocol/metrics-bridge", "metrics-bridge"],
  ["@mento-protocol/integration-probes", "integration-probes"],
  ["@mento-protocol/governance-watchdog", "governance-watchdog"],
  [
    "@mento-protocol/alerts-onchain-event-handler",
    "alerts/infra/onchain-event-handler",
  ],
  ["@mento-protocol/alerts-oncall-announcer", "alerts/infra/oncall-announcer"],
]);

/**
 * True when a package-relative path is NOT production source.
 *
 * Every ambiguity answers "not source", which disqualifies the package and
 * leaves its full coverage floor in place. `vitest related` follows the import
 * graph, so anything a test might read through the filesystem instead — YAML,
 * JSON, CSS, assets — has to fail toward the full suite.
 */
export function scopedIsNonSourcePath(path) {
  const patterns = [
    /\.test\./,
    /\.spec\./,
    /^__tests__\//,
    /\/__tests__\//,
    /^tests?\//,
    /\/tests?\//,
    /^vitest\.config\./,
    /\/vitest\.config\./,
    /^vitest\..*\.config\./,
    /\/vitest\..*\.config\./,
    /^vitest\.hermetic-setup\.ts$/,
    /\/vitest\.hermetic-setup\.ts$/,
    /^tsconfig/,
    /\/tsconfig/,
    /^package\.json$/,
    /\/package\.json$/,
    /\.graphql$/,
    /^__generated__\//,
    /\/__generated__\//,
    /^generated\//,
    /\/generated\//,
    /\.gen\.ts$/,
    /^fixtures\//,
    /\/fixtures\//,
    /^__fixtures__\//,
    /\/__fixtures__\//,
  ];
  if (patterns.some((pattern) => pattern.test(path))) return true;
  return !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path);
}

/**
 * True when any changed path anywhere disables scoping for the whole run.
 *
 * Test infrastructure changes which tests run for unrelated source, and
 * `shared-config/**` can regress any consumer through the dependency graph that
 * `vitest related` does not follow from the changed file.
 */
export function scopedTestInfraChanged(changedPaths) {
  const patterns = [
    /^scripts\/envio-schema-stubs\.graphql$/,
    /^shared-config\//,
    /^vitest\.hermetic-setup\.ts$/,
    /\/vitest\.hermetic-setup\.ts$/,
    /^vitest\.config\./,
    /\/vitest\.config\./,
    /^vitest\..*\.config\./,
    /\/vitest\..*\.config\./,
    /\/tests?\/setup\//,
  ];
  return changedPaths.some((path) => patterns.some((r) => r.test(path)));
}

const SCOPED_TARGET =
  /^pnpm --filter (@mento-protocol\/[a-z-]+) test:coverage$/;

export function applyScopedTestCommands(plan, changedPaths, facts) {
  if (facts.fullLocalTests) return;
  if (plan.sawWorkspaceEscalation) return;
  if (changedPaths.length > 15) return;
  if (scopedTestInfraChanged(changedPaths)) return;

  plan.quality = plan.quality.map((entry) => {
    const match = SCOPED_TARGET.exec(entry.command);
    if (match === null) return entry;
    const packageName = match[1];

    // shared-config's blast radius is the reason it keeps its full suite.
    if (packageName === "@mento-protocol/config") return entry;
    // A lockfile importer bump means the coverage floor is standing in for the
    // dependency-bump regression check; an unrelated small edit must not narrow
    // it to that edit's related tests.
    if (plan.isLockfileScopedPackage(packageName)) return entry;

    const packageDir = SCOPED_PACKAGE_DIR.get(packageName);
    if (packageDir === undefined) return entry;

    const files = [];
    for (const path of changedPaths) {
      if (!path.startsWith(`${packageDir}/`)) continue;
      const relative = path.slice(packageDir.length + 1);
      if (scopedIsNonSourcePath(relative)) return entry;
      // A deleted path, or the old side of a rename, makes `vitest related`
      // find zero tests silently — which would skip the coverage floor rather
      // than fail toward it.
      if (!facts.pathExistsAtHead(path)) return entry;
      files.push(relative);
    }
    if (files.length === 0) return entry;

    return {
      command: `pnpm --filter ${packageName} exec vitest related --run ${files.map(shellQuote).join(" ")}`,
      reason: `${entry.reason} (scoped-tests)`,
    };
  });
}

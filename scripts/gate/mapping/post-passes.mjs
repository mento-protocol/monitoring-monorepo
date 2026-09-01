/**
 * The six whole-set passes that run AFTER every changed path has been routed.
 *
 * They are separate from the verbs because they cannot be decided per path:
 * each reads the complete changed set or the complete command list. Their order
 * is fixed and is itself contract — Trunk is prepended first so it lands at the
 * head, codegen is sorted before the plan is written, workspace dependency
 * setup is added from the complete command list, Turbo compaction rewrites the
 * quality bucket, scoped tests rewrite it again afterwards, and the dep-cruiser
 * narrowing runs last on the finished quality bucket.
 *
 *   addTrunkCheckCommand → sortCodegenCommands → addWorkspaceConfigBuild →
 *   compactTurbo → applyScopedTests → narrowCodeHealthDepsCommand
 */

import { shellQuote } from "./shell-quote.mjs";

// ── 1. Trunk ───────────────────────────────────────────────────────────────

/**
 * Patterns that force a full-repo Trunk scan, whether or not the path survives.
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

/**
 * Deleted paths whose absence changes what a linter reports about files that
 * did NOT change, so a targeted run over the survivors cannot see the damage.
 *
 * actionlint resolves `uses: ./.github/actions/<name>` and `uses:
 * ./.github/workflows/<file>` against the working tree. Deleting one of those
 * makes every surviving caller newly invalid — and no surviving caller is in
 * the changed set, so nothing would name it. `.github/actions/pnpm-install` is
 * referenced by most workflows in this repo, which is the measured case.
 *
 * ShellCheck runs with external sources enabled, and a `# shellcheck
 * source=<repo-relative path>` directive resolves against the real tree even
 * under Trunk's one-file-at-a-time `copy_targets` sandbox. Deleting a sourced
 * helper therefore raises a NEW SC1091 on every surviving caller that names it
 * — measured on `scripts/bootstrap/codex-cloud-git-helpers.sh`, whose two
 * callers go from clean to SC1091 the moment it is gone. Callers that source
 * only through a runtime `${DIR}/…` path are the separate, already-suppressed
 * false positive `.shellcheckrc` documents; the rule below does not try to tell
 * the two apart, because any sourced-by analysis would rot the first time a
 * caller changed how it spells the path.
 *
 * The remaining enabled Trunk linters (prettier, markdownlint, codespell,
 * yamllint, trufflehog, git-diff-check) judge each file on its own bytes, so an
 * ordinary source or docs deletion cannot invalidate a survivor. checkov would
 * belong here for local `module { source = "./…" }` references; this repo has
 * none today, and `.tf` deletions stay covered by the whole-repo branches.
 */
const TRUNK_DELETION_FULL_SCAN = [/^\.github\//, /\.sh$/];

export function addTrunkCheckCommand(plan, changedPaths, facts) {
  const present = [];
  const missing = [];
  for (const path of changedPaths) {
    (facts.pathExistsInWorktree(path) ? present : missing).push(path);
  }

  // A deleted path cannot be named on a targeted command line — Trunk fails on
  // an argument that is not there. Dropping it from the argument list is the
  // narrow fix; the two branches below cover the cases where dropping it would
  // also drop coverage.
  const forcesFull =
    changedPaths.some((path) => TRUNK_FULL_SCAN.some((r) => r.test(path))) ||
    missing.some((path) => TRUNK_DELETION_FULL_SCAN.some((r) => r.test(path)));

  if (forcesFull) {
    plan.prependCommand(
      "./tools/trunk check --ci --all",
      "changed paths require full-repo Trunk checks",
    );
  } else if (present.length > 0) {
    plan.prependCommand(
      `./tools/trunk check --ci ${present.map(shellQuote).join(" ")}`,
      "changed existing paths should pass targeted Trunk checks",
    );
  } else if (changedPaths.length > 0) {
    // Every changed path was deleted. There is no survivor to target, and a
    // deletion-only change set is exactly where a cross-file linter has the
    // most to say, so keep the whole-repo scan.
    plan.prependCommand(
      "./tools/trunk check --ci --all",
      "every changed path was deleted; full-repo Trunk checks",
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

// ── 6. dep-cruiser scope ───────────────────────────────────────────────────

/** The command this pass narrows. */
export const CODE_HEALTH_DEPS_COMMAND = "pnpm code-health:deps";

/**
 * The roots `pnpm code-health:deps` actually scans.
 *
 * Two sources agree on this list and both are pinned by
 * `engine.test.mjs`, set-equal in both directions: the positional arguments of
 * the root `package.json` `code-health:deps` script, and the `includeOnly.path`
 * alternation in `.dependency-cruiser.cjs`. The arguments decide what
 * dependency-cruiser walks; `includeOnly` decides what it reports. A module
 * outside both is neither walked nor reported, so a change to it cannot change
 * the command's verdict.
 *
 * Duplicated here rather than derived at run time on purpose: routing is
 * reviewable data, and a routing constant parsed out of a shell string at gate
 * time would be neither. The staleness test is what keeps the copy honest —
 * adding a seventh root turns into a red test, not a silently under-routed
 * gate.
 */
export const DEPCRUISE_ROOTS = Object.freeze([
  "shared-config",
  "ui-dashboard",
  "indexer-envio",
  "metrics-bridge",
  "integration-probes",
  "aegis",
]);

/**
 * Workspace manifests that decide how a bare specifier resolves.
 *
 * A scanned root reaches another scanned root by package name, not by relative
 * path: `ui-dashboard/package.json` declares
 * `"@mento-protocol/config": "workspace:*"`, and 47 imports of that specifier
 * resolve into `shared-config/`. Which directories are workspace packages, and
 * what each specifier resolves to, is decided by these three files. Editing one
 * can therefore add or remove an edge between two scanned roots while no file
 * inside any root changes — so a change set holding only a manifest still has
 * something dependency-cruiser can read.
 *
 * A root's own `package.json` needs no entry here: it already matches the root
 * prefix below.
 */
const WORKSPACE_RESOLUTION_MANIFESTS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
];

/**
 * Triggers this pass schedules itself, rather than leaving to an arm.
 *
 * No arm routes a bare `pnpm-lock.yaml` or this module, so for these paths
 * declining to remove the command is not enough — there would be nothing in the
 * plan to decline to remove, and the guarantee they exist for would never fire.
 * `.dependency-cruiser.cjs` and the other two manifests do have arms; they stay
 * in this list so the guarantee holds on the pass's own terms rather than on an
 * arm that could be re-scoped later. `plan.addCommand` dedupes, so naming a
 * command an arm already scheduled keeps the arm's reason.
 *
 * The scanned roots are deliberately NOT here. Their arms already decide, and
 * they decide better: a root's `README.md` matches the root prefix but cannot
 * change a dependency-cruiser verdict, so scheduling on the prefix alone would
 * add work the arms correctly leave out.
 */
const CODE_HEALTH_DEPS_SELF_SCHEDULED = [
  ...WORKSPACE_RESOLUTION_MANIFESTS,
  /^\.dependency-cruiser\.cjs$/,
  /^scripts\/gate\/mapping\/post-passes\.mjs$/,
];

/**
 * Changed paths that keep `pnpm code-health:deps` in the plan.
 *
 * The roots are the reason the command exists. The manifests decide what the
 * roots resolve to. `.dependency-cruiser.cjs` is the config whose rules the
 * command enforces, and this module is where the narrowing itself lives, so an
 * edit to either has to run the command it governs rather than be judged by it.
 */
const CODE_HEALTH_DEPS_TRIGGERS = [
  new RegExp(`^(${DEPCRUISE_ROOTS.join("|")})/`),
  ...CODE_HEALTH_DEPS_SELF_SCHEDULED,
];

export function codeHealthDepsTriggered(changedPaths) {
  return changedPaths.some((path) =>
    CODE_HEALTH_DEPS_TRIGGERS.some((r) => r.test(path)),
  );
}

export function codeHealthDepsSelfScheduled(changedPaths) {
  return changedPaths.some((path) =>
    CODE_HEALTH_DEPS_SELF_SCHEDULED.some((r) => r.test(path)),
  );
}

/**
 * Drop `pnpm code-health:deps` when nothing it can see changed.
 *
 * Several arms reach it as part of a package quality bundle — a
 * `governance-watchdog/**` edit, an `alerts/infra/**` edit, a
 * `.github/workflows/**` edit that routes a package's bundle — and none of
 * those paths is inside a scanned root, so the command re-proves the same
 * verdict on an unchanged graph. This is the one pass that makes the plan
 * smaller, which is the direction the rest of the engine refuses to go, so its
 * condition is deliberately about what dependency-cruiser can read rather than
 * about which package was routed. The `docs/pr-checklists/code-health.md`
 * checklist stays either way: knip is the other half of that checklist and it
 * still runs per package.
 */
export function narrowCodeHealthDepsCommand(plan, changedPaths) {
  if (!codeHealthDepsTriggered(changedPaths)) {
    plan.quality = plan.quality.filter(
      (entry) => entry.command !== CODE_HEALTH_DEPS_COMMAND,
    );
    return;
  }
  // Removing is only half the pass. For the self-scheduled triggers no arm adds
  // the command at all, so a pass that could only decline to remove it would
  // leave the plan without the check those triggers exist to guarantee.
  if (codeHealthDepsSelfScheduled(changedPaths)) {
    plan.addCommand(
      CODE_HEALTH_DEPS_COMMAND,
      "dep-cruiser config, a workspace manifest, or the scope pass changed",
    );
  }
}

#!/usr/bin/env node
/**
 * The mapping engine's own unit tests.
 *
 * WHY THESE EXIST. Until D5c the engine had an oracle: the parity corpora and
 * the in-gate guard compared it against the bash `case` arms, which answered
 * "do the two agree" and nothing else. D5c deleted the arms, so the behaviours
 * below — which reason survives a dedupe, where a compacted Turbo command
 * lands, which of four disqualifiers switched scoped tests off — are pinned
 * here or nowhere. These tests are what survived that deletion.
 *
 * They test BEHAVIOUR, not transcription: each one asserts a rule the runbook
 * states, and each was checked to fail under the mutation that breaks that rule
 * (recorded in the D5b part 2 PR).
 *
 * Run: node --test scripts/gate/mapping/engine.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bashFunctionSource } from "../../sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs";

import { ROUTING_PLAN } from "../routing-table/index.mjs";
import { Facts } from "./facts.mjs";
import { BUCKETS, Plan, commandDedupeKey } from "./plan.mjs";
import {
  CODE_HEALTH_DEPS_COMMAND,
  DEPCRUISE_ROOTS,
  addTrunkCheckCommand,
  addWorkspaceConfigBuild,
  applyScopedTestCommands,
  compactTurboQualityCommands,
  narrowCodeHealthDepsCommand,
  scopedIsNonSourcePath,
  scopedTestInfraChanged,
  sortCodegenCommands,
} from "./post-passes.mjs";
import { routeChangedPaths } from "./route.mjs";
import * as verbs from "./verbs.mjs";

/** The subset of Facts the post-passes and verbs actually consult. */
function stubFacts(overrides = {}) {
  const present = new Set(overrides.presentPaths ?? []);
  return {
    isRealTree: true,
    fullLocalTests: false,
    baseRef: "origin/main",
    baseOid: "0123456789abcdef0123456789abcdef01234567",
    headRef: "HEAD",
    changedPathsFile: "/tmp/changed-paths",
    repoRoot: "/repo",
    pathExistsInWorktree: (path) => present.has(path),
    pathIsFile: (path) => present.has(path),
    pathExistsAtHead: (path) => present.has(path),
    terraformStackPaths: [],
    ...overrides,
  };
}

const commandsOf = (plan, bucket = "quality") =>
  plan.buckets.get(bucket).map((entry) => entry.command);
const reasonOf = (plan, command, bucket = "quality") =>
  plan.buckets.get(bucket).find((entry) => entry.command === command)?.reason;

// ── Plan: dedupe, reasons, order ───────────────────────────────────────────

test("dedupe keeps the FIRST reason, not the last", () => {
  const plan = new Plan();
  plan.addCommand("pnpm lint", "first reason");
  plan.addCommand("pnpm lint", "second reason");
  assert.deepEqual(commandsOf(plan), ["pnpm lint"]);
  // routing.test.mjs asserts on reason strings, so "first wins" is contract.
  assert.equal(reasonOf(plan, "pnpm lint"), "first reason");
});

test("the alias pairs share one dedupe key", () => {
  for (const [alias, direct] of [
    ["pnpm agent:quality-gate:test", "bash scripts/agent-quality-gate.test.sh"],
    ["pnpm agent:autoreview:test", "bash scripts/agent-autoreview.test.sh"],
    ["pnpm tf:test", "node scripts/tf-stacks.test.mjs"],
  ]) {
    assert.equal(
      commandDedupeKey(alias),
      commandDedupeKey(direct),
      `${alias} and ${direct} must dedupe together`,
    );
    const plan = new Plan();
    plan.addCommand(alias, "alias first");
    plan.addCommand(direct, "direct second");
    assert.deepEqual(
      commandsOf(plan),
      [alias],
      "the same suite reached two ways must schedule once",
    );
  }
});

test("an unrelated command is not deduped away", () => {
  const plan = new Plan();
  plan.addCommand("pnpm lint", "a");
  plan.addCommand("pnpm typecheck", "b");
  assert.deepEqual(commandsOf(plan), ["pnpm lint", "pnpm typecheck"]);
});

test("dedupe is per bucket, not global", () => {
  const plan = new Plan();
  plan.addPreflight("pnpm install --frozen-lockfile", "preflight");
  plan.addCommand("pnpm install --frozen-lockfile", "quality");
  assert.deepEqual(commandsOf(plan, "preflight"), [
    "pnpm install --frozen-lockfile",
  ]);
  assert.deepEqual(commandsOf(plan, "quality"), [
    "pnpm install --frozen-lockfile",
  ]);
});

test("prepend puts a command at the head, and re-prepending is a no-op", () => {
  const plan = new Plan();
  plan.addCommand("second", "b");
  plan.prependCommand("first", "a");
  assert.deepEqual(commandsOf(plan), ["first", "second"]);
  plan.prependCommand("second", "moved?");
  assert.deepEqual(
    commandsOf(plan),
    ["first", "second"],
    "prepending an existing command must not move it",
  );
});

test("checklists dedupe on the path alone, first reason wins", () => {
  const plan = new Plan();
  plan.addChecklist("docs/pr-checklists/code-health.md", "first");
  plan.addChecklist("docs/pr-checklists/code-health.md", "second");
  assert.deepEqual(plan.checklists, [
    { checklist: "docs/pr-checklists/code-health.md", reason: "first" },
  ]);
});

test("surfaces dedupe and keep insertion order", () => {
  const plan = new Plan();
  plan.addSurface("scripts");
  plan.addSurface("ui-dashboard");
  plan.addSurface("scripts");
  assert.deepEqual(plan.surfaces, ["scripts", "ui-dashboard"]);
});

test("the bucket order is preflight, codegen, post-codegen, quality", () => {
  // The gate prints and the freshness stamp hashes in this order.
  assert.deepEqual(BUCKETS, [
    "preflight",
    "codegen",
    "post-codegen",
    "quality",
  ]);
});

test("an unknown bucket throws rather than being dropped", () => {
  const plan = new Plan();
  assert.throws(
    () => plan.add("nonsense", "cmd", "reason"),
    /unknown command bucket/,
  );
});

// ── Verbs ──────────────────────────────────────────────────────────────────

test("a Turbo package task carries the local cache flag", () => {
  assert.equal(
    verbs.turboLocalCacheCommand("@mento-protocol/ui-dashboard", "lint"),
    "pnpm exec turbo run lint --filter=@mento-protocol/ui-dashboard --cache=local:rw",
  );
});

test("the package quality bundle keeps its command set and order", () => {
  const plan = new Plan();
  verbs.addPackageQualityCommands(plan, "@mento-protocol/metrics-bridge", "r");
  assert.deepEqual(commandsOf(plan), [
    "pnpm exec turbo run lint --filter=@mento-protocol/metrics-bridge --cache=local:rw",
    "pnpm exec turbo run typecheck --filter=@mento-protocol/metrics-bridge --cache=local:rw",
    "pnpm --filter @mento-protocol/metrics-bridge build",
    "pnpm --filter @mento-protocol/metrics-bridge test:coverage",
    "pnpm exec turbo run knip --filter=@mento-protocol/metrics-bridge --cache=local:rw",
    "pnpm code-health:deps",
  ]);
  assert.equal(
    reasonOf(
      plan,
      "pnpm --filter @mento-protocol/metrics-bridge test:coverage",
    ),
    "r (coverage floor)",
    "the coverage floor carries its own reason suffix",
  );
});

test("the indexer bundle forces mainnet codegen as a preflight", () => {
  const plan = new Plan();
  verbs.addPackageQualityCommands(plan, "@mento-protocol/indexer-envio", "r");
  assert.ok(
    commandsOf(plan, "codegen").includes("pnpm indexer:codegen"),
    "typecheck and lint both need .envio/types.d.ts to exist first",
  );
});

test("react-doctor:diff carries the base ref AND its resolved oid", () => {
  const plan = new Plan();
  const facts = stubFacts();
  verbs.addUiReactDoctorDiff(plan, "r", facts);
  const [command] = commandsOf(plan);
  assert.match(command, /^REACT_DOCTOR_BASE_REF=origin\/main /);
  assert.ok(
    command.includes(`REACT_DOCTOR_BASE_CACHE_KEY=${facts.baseOid}`),
    "the Turbo cache key must move when the base moves",
  );
});

// The gate's freshness stamp binds the merge-base rather than the base tip, so
// the plan text is what keeps a tip-reading command honest across an advance of
// the base. Assert the text really does move with the OID: were it to carry
// only the ref NAME, the command-plan hash would be identical on both sides of
// a fetch and a warm stamp would hide a stale react-doctor answer.
test("react-doctor:diff command text moves when the base OID moves", () => {
  const commandFor = (baseOid) => {
    const plan = new Plan();
    verbs.addUiReactDoctorDiff(plan, "r", stubFacts({ baseOid }));
    return commandsOf(plan)[0];
  };
  const before = commandFor("1111111111111111111111111111111111111111");
  const after = commandFor("2222222222222222222222222222222222222222");
  assert.notEqual(before, after);
});

test("the ADR reminder is fed the gate's own base, head and path set", () => {
  const plan = new Plan();
  verbs.addAdrReminder(plan, "r", stubFacts());
  const [command] = commandsOf(plan);
  assert.ok(command.startsWith("node scripts/pr/check-adr-reminder.mjs"));
  assert.ok(command.includes("--base origin/main --head HEAD"));
  assert.ok(command.includes("--include-untracked --changed-paths-file"));
});

// The peg validator reads the previous policy from the base ref's TIP, so it
// is a tip reader in the same class as react-doctor and the ADR reminder. The
// stamp's tip-reader predicate is textual, so the base has to appear in the
// command or a merge-base-bound stamp could skip a check whose answer moved.
// It is fed the RESOLVED OID, not the ref: the validator's `validateGitRef`
// admits only [A-Za-z0-9._/-]+, so a ref spelling the gate accepts but that
// allowlist rejects would fail the whole plan. Hex always passes.
test("the peg registry check is fed the gate's resolved base OID", () => {
  const plan = new Plan();
  const facts = stubFacts();
  verbs.addPegRegistryIntegrityCheck(plan, "r", facts);
  const [command] = commandsOf(plan);
  assert.ok(
    command.startsWith("node scripts/alerts/check-peg-registry-integrity.mjs"),
  );
  assert.ok(command.includes(`--base-ref ${facts.baseOid}`));
  assert.match(facts.baseOid, /^[a-f0-9]{40}$/);
});

// Only the sentinel falls back to the ref. That path is fail-closed downstream:
// an unresolvable ref makes readPolicyFromGit throw rather than report "no
// baseline", which it reserves for a ref that resolves without the policy file.
test("an unresolved base OID falls back to the ref spelling", () => {
  const plan = new Plan();
  verbs.addPegRegistryIntegrityCheck(
    plan,
    "r",
    stubFacts({ baseOid: "__unresolved__:origin/main" }),
  );
  assert.ok(commandsOf(plan)[0].includes("--base-ref origin/main"));
});

// The emitted text must move with the base, or a plan hash identical on both
// sides of a fetch would hide a stale peg answer.
test("the peg check's command text moves when the base OID moves", () => {
  const commandFor = (baseOid) => {
    const plan = new Plan();
    verbs.addPegRegistryIntegrityCheck(plan, "r", stubFacts({ baseOid }));
    return commandsOf(plan)[0];
  };
  assert.notEqual(
    commandFor("1111111111111111111111111111111111111111"),
    commandFor("2222222222222222222222222222222222222222"),
  );
});

// A future arm spelling this check as a bare `command:` string would read the
// base tip while the plan text stayed silent about it, reopening the hole the
// verb closes. Every emission has to route through the verb.
test("no routing-table arm emits the peg registry check without its base", () => {
  const bare = "node scripts/alerts/check-peg-registry-integrity.mjs";
  const offenders = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "command" && value === bare) offenders.push(path);
      walk(value, `${path}.${key}`);
    }
  };
  walk(ROUTING_PLAN, "ROUTING_PLAN");
  assert.deepEqual(
    offenders,
    [],
    "route these through add_peg_registry_integrity_check instead",
  );
});

test("the Sentry suite gate schedules BOTH commands, neither substituting", () => {
  const plan = new Plan();
  verbs.addSentrySuiteGateCommands(plan, "r");
  const commands = commandsOf(plan);
  assert.equal(commands.length, 2);
  assert.ok(
    commands.every((command) => command.includes("env -u NODE_OPTIONS")),
  );
  assert.ok(
    commands.some((command) => command.endsWith("sentry-suite-gate.test.mjs")),
  );
  assert.ok(
    commands.some((command) => command.endsWith("sentry-suite-gate.mjs")),
  );
});

test("registered Terraform stacks route from the registry, not from paths", () => {
  const plan = new Plan();
  const facts = stubFacts({
    terraformStackPaths: ["terraform", "alerts/rules"],
  });
  verbs.addRegisteredTerraformValidateCommands(plan, "r", facts);
  const commands = commandsOf(plan);
  assert.ok(commands.some((command) => command.includes("terraform")));
  assert.ok(commands.some((command) => command.includes("alerts/rules")));
});

test("workspace escalation sets the flag that disables scoped tests", () => {
  const plan = new Plan();
  assert.equal(plan.sawWorkspaceEscalation, false);
  verbs.addWorkspaceQualityCommands(plan, "workspace changed");
  assert.equal(
    plan.sawWorkspaceEscalation,
    true,
    "the flag is the point: it is a property of the run, not of one arm",
  );
});

test("the root tooling bundle schedules the whole suite list", () => {
  const plan = new Plan();
  verbs.addRootToolingPackageScriptChecks(plan, "r");
  const commands = commandsOf(plan);
  assert.ok(
    commands.length > 20,
    `expected the full list, got ${commands.length}`,
  );
  assert.ok(commands.includes("bash scripts/agent-quality-gate.test.sh"));
  assert.ok(commands.includes("node scripts/pr/pr-ready-state.test.mjs"));
});

test("Darwin runtime files shared with autoreview route both regression suites", () => {
  const sharedRuntimePaths = [
    "scripts/gate/darwin-process-identity.c",
    "scripts/gate/darwin-process-identity-runtime.inc.c",
    "scripts/gate/darwin-process-identity-helper.mjs",
    "scripts/gate/darwin-process-lineage-model.mjs",
    "scripts/gate/darwin-process-lineage-state.mjs",
    "scripts/gate/darwin-process-lineage.mjs",
  ];

  for (const changedPath of sharedRuntimePaths) {
    const plan = new Plan();
    routeChangedPaths(
      ROUTING_PLAN,
      [changedPath],
      stubFacts({ isRealTree: false, presentPaths: [changedPath] }),
      {
        plan,
        routeLockfileChange: () => {
          throw new Error("unexpected lockfile route");
        },
      },
    );
    const commands = commandsOf(plan);
    for (const expected of [
      "pnpm agent:quality-gate:test",
      "pnpm agent:autoreview:test",
    ]) {
      assert.ok(
        commands.includes(expected),
        `${changedPath} does not route ${expected}: ${JSON.stringify(commands)}`,
      );
    }
  }
});

// ── Post-pass 1: Trunk ─────────────────────────────────────────────────────

test("a change set of nothing but deletions forces a full-repo Trunk scan", () => {
  const plan = new Plan();
  addTrunkCheckCommand(
    plan,
    ["deleted/one.ts", "deleted/two.ts"],
    stubFacts({ presentPaths: [] }),
  );
  assert.deepEqual(
    commandsOf(plan),
    ["./tools/trunk check --ci --all"],
    "there is no survivor to name on a targeted command line",
  );
  assert.equal(
    reasonOf(plan, "./tools/trunk check --ci --all"),
    "every changed path was deleted; full-repo Trunk checks",
  );
});

test("a deleted path is dropped from the targeted Trunk argument list", () => {
  const plan = new Plan();
  addTrunkCheckCommand(
    plan,
    ["a/kept.ts", "a/deleted.ts", "b/kept.ts"],
    stubFacts({ presentPaths: ["a/kept.ts", "b/kept.ts"] }),
  );
  assert.deepEqual(
    commandsOf(plan),
    ["./tools/trunk check --ci a/kept.ts b/kept.ts"],
    "Trunk fails on an argument that is not there; the survivors still lint",
  );
});

test("a deleted .github path forces full, because actionlint reads across files", () => {
  for (const deleted of [
    ".github/actions/pnpm-install/action.yml",
    ".github/workflows/reusable.yml",
  ]) {
    const plan = new Plan();
    addTrunkCheckCommand(
      plan,
      [deleted, "docs/note.md"],
      stubFacts({ presentPaths: ["docs/note.md"] }),
    );
    assert.deepEqual(
      commandsOf(plan),
      ["./tools/trunk check --ci --all"],
      `${deleted} is referenced by surviving workflows that are not in the change set`,
    );
  }
});

test("an ordinary deletion beside a survivor does NOT force full", () => {
  // The standing invariant the narrowing rests on: every enabled Trunk linter
  // except actionlint judges a file on its own bytes, so a deleted source file
  // cannot invalidate a file nobody touched.
  const plan = new Plan();
  addTrunkCheckCommand(
    plan,
    ["ui-dashboard/src/gone.tsx", "ui-dashboard/src/kept.tsx"],
    stubFacts({ presentPaths: ["ui-dashboard/src/kept.tsx"] }),
  );
  assert.deepEqual(commandsOf(plan), [
    "./tools/trunk check --ci ui-dashboard/src/kept.tsx",
  ]);
});

test("a deleted sourced shell helper forces full, because ShellCheck follows sources", () => {
  // Measured: deleting scripts/bootstrap/codex-cloud-git-helpers.sh takes its
  // two surviving callers from clean to SC1091, because each names it in a
  // `# shellcheck source=` directive that resolves against the real tree. No
  // survivor naming it is in the change set, so a targeted run never sees it.
  const plan = new Plan();
  addTrunkCheckCommand(
    plan,
    ["scripts/bootstrap/codex-cloud-git-helpers.sh", "docs/note.md"],
    stubFacts({ presentPaths: ["docs/note.md"] }),
  );
  assert.deepEqual(
    commandsOf(plan),
    ["./tools/trunk check --ci --all"],
    "surviving callers source the deleted helper and are not in the change set",
  );
});

test("a deleted repo-root dotfile forces full, because linters read it repo-wide", () => {
  // Measured: with `.codespellrc` gone, the unchanged
  // scripts/terraform/tf-platform-plan-guard.mjs goes from clean to one
  // codespell hit on `applyable`, an ignore-word that config carries. The
  // targeted run over survivors still exits 0, so this passes locally and only
  // the required full scan catches it.
  for (const deleted of [
    ".codespellrc",
    ".shellcheckrc",
    ".osv-scanner.toml",
    ".gitignore",
  ]) {
    const plan = new Plan();
    addTrunkCheckCommand(
      plan,
      [deleted, "docs/note.md"],
      stubFacts({ presentPaths: ["docs/note.md"] }),
    );
    assert.deepEqual(
      commandsOf(plan).filter((c) => !c.includes("--filter=shellcheck")),
      ["./tools/trunk check --ci --all"],
      `${deleted} configures a linter across files that did not change`,
    );
  }
});

test("a deleted NESTED dotfile forces full, because linter configs cascade", () => {
  // Measured: prettier, markdownlint and yamllint take the nearest config, so a
  // package can carry its own. With `aegis/.prettierrc` deleted, the untouched
  // `aegis/src/app.module.ts` starts failing prettier — its `singleQuote`
  // setting went with the file — while a targeted run over survivors exits 0.
  for (const deleted of [
    "aegis/.prettierrc",
    "ui-dashboard/.prettierrc.json",
    "metrics-bridge/.markdownlint.yaml",
    "alerts/infra/.prettierignore",
  ]) {
    const plan = new Plan();
    addTrunkCheckCommand(
      plan,
      [deleted, "docs/note.md"],
      stubFacts({ presentPaths: ["docs/note.md"] }),
    );
    assert.deepEqual(
      commandsOf(plan).filter((c) => !c.includes("--filter=shellcheck")),
      ["./tools/trunk check --ci --all"],
      `${deleted} configures a linter for files that did not change`,
    );
  }
});

test("a deleted NON-dotfile stays an ordinary deletion at any depth", () => {
  // The other direction: the rule keys on the leading dot, not on depth, so an
  // ordinary nested source or docs deletion still targets the survivors.
  for (const deleted of [
    "ui-dashboard/src/gone.tsx",
    "docs/notes/gone.md",
    "aegis/config/gone.json",
  ]) {
    const plan = new Plan();
    addTrunkCheckCommand(
      plan,
      [deleted, "docs/note.md"],
      stubFacts({ presentPaths: ["docs/note.md"] }),
    );
    assert.deepEqual(
      commandsOf(plan),
      ["./tools/trunk check --ci docs/note.md"],
      `${deleted} carries no configuration for files that did not change`,
    );
  }
});

test("a deleted path still in the full-scan list forces full", () => {
  const plan = new Plan();
  addTrunkCheckCommand(
    plan,
    ["ui-dashboard/package.json", "ui-dashboard/src/kept.tsx"],
    stubFacts({ presentPaths: ["ui-dashboard/src/kept.tsx"] }),
  );
  assert.deepEqual(
    commandsOf(plan),
    ["./tools/trunk check --ci --all"],
    "the whole-repo list is matched against every changed path, deleted or not",
  );
});

test("existing ordinary paths get a targeted Trunk scan", () => {
  const plan = new Plan();
  const paths = ["a/one.ts", "b/two.ts"];
  addTrunkCheckCommand(plan, paths, stubFacts({ presentPaths: paths }));
  assert.deepEqual(commandsOf(plan), [
    "./tools/trunk check --ci a/one.ts b/two.ts",
  ]);
});

test("a config path in the full-scan list forces full even when it exists", () => {
  for (const path of [
    ".trunk/trunk.yaml",
    "tools/trunk",
    "package.json",
    "pnpm-lock.yaml",
    "ui-dashboard/package.json",
    ".npmrc",
    ".node-version",
  ]) {
    const plan = new Plan();
    addTrunkCheckCommand(plan, [path], stubFacts({ presentPaths: [path] }));
    assert.deepEqual(
      commandsOf(plan),
      ["./tools/trunk check --ci --all"],
      `${path} governs the whole repo, so a targeted scan would lint only itself`,
    );
  }
});

test("a .shellcheckrc edit adds a repo-wide ShellCheck-only pass, ahead of the rest", () => {
  const plan = new Plan();
  const paths = [".shellcheckrc", "scripts/a.sh"];
  addTrunkCheckCommand(plan, paths, stubFacts({ presentPaths: paths }));
  assert.equal(
    commandsOf(plan)[0],
    "./tools/trunk check --ci --all --filter=shellcheck",
    "prepended last, so it must end up first",
  );
});

test("Trunk is prepended, so it runs before commands added earlier", () => {
  const plan = new Plan();
  plan.addCommand("pnpm lint", "earlier");
  const paths = ["a/one.ts"];
  addTrunkCheckCommand(plan, paths, stubFacts({ presentPaths: paths }));
  assert.deepEqual(commandsOf(plan), [
    "./tools/trunk check --ci a/one.ts",
    "pnpm lint",
  ]);
});

// ── Post-pass 2: codegen order ─────────────────────────────────────────────

test("mainnet codegen sorts LAST, because every variant overwrites the same package", () => {
  const plan = new Plan();
  verbs.addIndexerMainnetCodegen(plan, "mainnet");
  verbs.addIndexerTestnetCodegen(plan, "testnet");
  verbs.addDashboardCodegen(plan, "dashboard");
  sortCodegenCommands(plan);
  const order = commandsOf(plan, "codegen");
  assert.equal(
    order[order.length - 1],
    "pnpm indexer:codegen",
    "the package checks that follow validate the normally-linked package",
  );
  assert.ok(
    order.indexOf("pnpm dashboard:codegen") <
      order.indexOf("pnpm indexer:testnet:codegen"),
    "known commands keep the fixed relative order",
  );
});

test("an unrecognised codegen command keeps its position after the known ones", () => {
  const plan = new Plan();
  plan.addCodegen("pnpm indexer:codegen", "mainnet");
  plan.addCodegen("pnpm something:new", "unknown");
  sortCodegenCommands(plan);
  assert.deepEqual(commandsOf(plan, "codegen"), [
    "pnpm indexer:codegen",
    "pnpm something:new",
  ]);
});

// ── Post-pass 3: workspace dependency setup ────────────────────────────────

test("full and reduced config-consumer plans build shared-config exactly once", () => {
  const consumers = [
    "@mento-protocol/ui-dashboard",
    "@mento-protocol/metrics-bridge",
    "@mento-protocol/integration-probes",
  ];
  const builders = [
    verbs.addPackageQualityCommands,
    verbs.addPackageVitestTypecheckCommands,
  ];
  for (const packageName of consumers) {
    for (const buildPlan of builders) {
      const plan = new Plan();
      buildPlan(plan, packageName, "consumer changed");
      addWorkspaceConfigBuild(plan);
      addWorkspaceConfigBuild(plan);
      assert.equal(
        commandsOf(plan).filter(
          (command) => command === "pnpm --filter @mento-protocol/config build",
        ).length,
        1,
        `${buildPlan.name} for ${packageName} must schedule one config build`,
      );
    }
  }
});

test("peg registry checks build shared-config before loading its exports", () => {
  for (const command of [
    "node scripts/alerts/check-peg-registry-integrity.mjs",
    // The form the verb actually emits. `commandConsumesWorkspaceConfig`
    // matches it through its `startsWith(script + " ")` branch; without that
    // the based check would run before shared-config was built.
    "node scripts/alerts/check-peg-registry-integrity.mjs --base-ref 0123456789abcdef0123456789abcdef01234567",
    "node scripts/alerts/check-peg-registry-integrity.test.mjs",
  ]) {
    const plan = new Plan();
    plan.addCommand(command, "registry changed");
    addWorkspaceConfigBuild(plan);
    assert.ok(
      commandsOf(plan).includes("pnpm --filter @mento-protocol/config build"),
      `${command} must receive the config setup prerequisite`,
    );
  }
});

test("a plan with no config consumer does not build shared-config", () => {
  const plan = new Plan();
  verbs.addAegisQualityCommands(plan, "aegis changed");
  addWorkspaceConfigBuild(plan);
  assert.ok(
    !commandsOf(plan).includes("pnpm --filter @mento-protocol/config build"),
  );
});

// ── Post-pass 4: Turbo compaction ──────────────────────────────────────────

test("same-task Turbo commands coalesce into one invocation", () => {
  const plan = new Plan();
  plan.addCommand(
    verbs.turboLocalCacheCommand("@mento-protocol/a", "lint"),
    "a changed",
  );
  plan.addCommand("pnpm middle", "unrelated");
  plan.addCommand(
    verbs.turboLocalCacheCommand("@mento-protocol/b", "lint"),
    "b changed",
  );
  compactTurboQualityCommands(plan);
  assert.deepEqual(commandsOf(plan), [
    "pnpm exec turbo run lint --filter=@mento-protocol/a --filter=@mento-protocol/b --cache=local:rw",
    "pnpm middle",
  ]);
  assert.equal(
    reasonOf(
      plan,
      "pnpm exec turbo run lint --filter=@mento-protocol/a --filter=@mento-protocol/b --cache=local:rw",
    ),
    "a changed; b changed",
    "the reasons join in first-seen order",
  );
});

test("compaction takes the position of the FIRST invocation of that task", () => {
  const plan = new Plan();
  plan.addCommand(
    verbs.turboLocalCacheCommand("@mento-protocol/a", "lint"),
    "a",
  );
  plan.addCommand(
    verbs.turboLocalCacheCommand("@mento-protocol/a", "typecheck"),
    "a",
  );
  plan.addCommand(
    verbs.turboLocalCacheCommand("@mento-protocol/b", "lint"),
    "b",
  );
  compactTurboQualityCommands(plan);
  assert.match(commandsOf(plan)[0], /turbo run lint /);
  assert.match(commandsOf(plan)[1], /turbo run typecheck /);
});

test("a repeated package on one task is listed once", () => {
  const plan = new Plan();
  plan.addCommand(
    verbs.turboLocalCacheCommand("@mento-protocol/a", "lint"),
    "first",
  );
  plan.quality.push({
    command: verbs.turboLocalCacheCommand("@mento-protocol/a", "lint"),
    reason: "duplicate slipped past dedupe",
  });
  compactTurboQualityCommands(plan);
  assert.deepEqual(commandsOf(plan), [
    "pnpm exec turbo run lint --filter=@mento-protocol/a --cache=local:rw",
  ]);
});

test("a non-Turbo command is left exactly as it was", () => {
  const plan = new Plan();
  plan.addCommand("pnpm code-health:deps", "r");
  compactTurboQualityCommands(plan);
  assert.deepEqual(commandsOf(plan), ["pnpm code-health:deps"]);
});

// ── Post-pass 5: scoped tests ──────────────────────────────────────────────

const COVERAGE = "pnpm --filter @mento-protocol/ui-dashboard test:coverage";
const scopedPlan = () => {
  const plan = new Plan();
  plan.addCommand(COVERAGE, "ui-dashboard changed (coverage floor)");
  return plan;
};

test("a small production-source change narrows to vitest related", () => {
  const plan = scopedPlan();
  const paths = ["ui-dashboard/src/lib/utils.ts"];
  applyScopedTestCommands(plan, paths, stubFacts({ presentPaths: paths }));
  assert.deepEqual(commandsOf(plan), [
    "pnpm --filter @mento-protocol/ui-dashboard exec vitest related --run src/lib/utils.ts",
  ]);
  assert.match(commandsOf(plan)[0], /vitest related/);
});

test("the threshold is 15 paths: 15 scopes, 16 does not", () => {
  for (const [count, expectScoped] of [
    [15, true],
    [16, false],
  ]) {
    const plan = scopedPlan();
    const paths = Array.from(
      { length: count },
      (_, index) => `ui-dashboard/src/lib/f${index}.ts`,
    );
    applyScopedTestCommands(plan, paths, stubFacts({ presentPaths: paths }));
    const scoped = commandsOf(plan)[0].includes("vitest related");
    assert.equal(
      scoped,
      expectScoped,
      `${count} changed paths should ${expectScoped ? "" : "not "}scope`,
    );
  }
});

test("each disqualifier switches scoping off for the whole run", () => {
  const base = ["ui-dashboard/src/lib/utils.ts"];
  const disqualifiers = {
    "shared-config blast radius": "shared-config/src/index.ts",
    "hermetic test setup": "ui-dashboard/vitest.hermetic-setup.ts",
    "vitest config": "ui-dashboard/vitest.config.ts",
    "schema stub": "scripts/envio-schema-stubs.graphql",
    "test setup dir": "ui-dashboard/test/setup/globals.ts",
  };
  for (const [name, extra] of Object.entries(disqualifiers)) {
    const plan = scopedPlan();
    const paths = [...base, extra];
    applyScopedTestCommands(plan, paths, stubFacts({ presentPaths: paths }));
    assert.deepEqual(
      commandsOf(plan),
      [COVERAGE],
      `${name} must leave the full coverage floor in place`,
    );
  }
});

test("a workspace escalation anywhere in the run disables scoping", () => {
  const plan = scopedPlan();
  plan.sawWorkspaceEscalation = true;
  const paths = ["ui-dashboard/src/lib/utils.ts"];
  applyScopedTestCommands(plan, paths, stubFacts({ presentPaths: paths }));
  assert.deepEqual(commandsOf(plan), [COVERAGE]);
});

test("a lockfile-scoped package keeps its full coverage floor", () => {
  const plan = scopedPlan();
  plan.markLockfileScopedPackage("@mento-protocol/ui-dashboard");
  const paths = ["ui-dashboard/src/lib/utils.ts"];
  applyScopedTestCommands(plan, paths, stubFacts({ presentPaths: paths }));
  assert.deepEqual(
    commandsOf(plan),
    [COVERAGE],
    "the floor is standing in for the dependency-bump regression check",
  );
});

test("--full-local-tests forces the full suite", () => {
  const plan = scopedPlan();
  const paths = ["ui-dashboard/src/lib/utils.ts"];
  applyScopedTestCommands(
    plan,
    paths,
    stubFacts({ presentPaths: paths, fullLocalTests: true }),
  );
  assert.deepEqual(commandsOf(plan), [COVERAGE]);
});

test("a deleted path in the package leaves the floor, because vitest related finds nothing", () => {
  const plan = scopedPlan();
  const paths = [
    "ui-dashboard/src/lib/utils.ts",
    "ui-dashboard/src/lib/gone.ts",
  ];
  applyScopedTestCommands(
    plan,
    paths,
    // Present in the worktree listing but absent at head: a deletion, or the
    // old side of a rename.
    stubFacts({ presentPaths: ["ui-dashboard/src/lib/utils.ts"] }),
  );
  assert.deepEqual(commandsOf(plan), [COVERAGE]);
});

test("shared-config never scopes even when it is the only change", () => {
  const plan = new Plan();
  const command = "pnpm --filter @mento-protocol/config test:coverage";
  plan.addCommand(command, "shared-config changed (coverage floor)");
  const paths = ["shared-config/src/index.ts"];
  applyScopedTestCommands(plan, paths, stubFacts({ presentPaths: paths }));
  assert.deepEqual(commandsOf(plan), [command]);
});

test("a non-source path inside the package disqualifies it", () => {
  const plan = scopedPlan();
  const paths = [
    "ui-dashboard/src/lib/utils.ts",
    "ui-dashboard/src/lib/data.json",
  ];
  applyScopedTestCommands(plan, paths, stubFacts({ presentPaths: paths }));
  assert.deepEqual(
    commandsOf(plan),
    [COVERAGE],
    "a test may read it through the filesystem, which vitest related cannot follow",
  );
});

test("scopedIsNonSourcePath answers for the shapes the runbook lists", () => {
  for (const path of [
    "src/a.test.ts",
    "src/a.spec.tsx",
    "__tests__/a.ts",
    "test/a.ts",
    "vitest.config.ts",
    "tsconfig.json",
    "package.json",
    "schema.graphql",
    "__generated__/graphql.ts",
    "src/a.gen.ts",
    "fixtures/a.ts",
    "src/styles.css",
    "src/data.yaml",
  ]) {
    assert.equal(
      scopedIsNonSourcePath(path),
      true,
      `${path} is not production source`,
    );
  }
  for (const path of ["src/a.ts", "src/a.tsx", "src/a.mjs", "lib/b.cjs"]) {
    assert.equal(
      scopedIsNonSourcePath(path),
      false,
      `${path} IS production source`,
    );
  }
});

test("scopedTestInfraChanged sees infra anywhere in the set", () => {
  assert.equal(scopedTestInfraChanged(["ui-dashboard/src/a.ts"]), false);
  assert.equal(
    scopedTestInfraChanged(["ui-dashboard/src/a.ts", "shared-config/src/b.ts"]),
    true,
  );
});

// ── Post-pass 6: dep-cruiser scope ─────────────────────────────────────────

/** A plan holding only the command the pass may remove. */
function depsPlan() {
  const plan = new Plan();
  plan.addCommand("pnpm exec turbo run lint --filter=x --cache=local:rw", "a");
  plan.addCommand(CODE_HEALTH_DEPS_COMMAND, "package bundle");
  plan.addCommand("pnpm --filter x test:coverage", "b");
  return plan;
}

const depsSurvives = (changedPaths) => {
  const plan = depsPlan();
  narrowCodeHealthDepsCommand(plan, changedPaths);
  return commandsOf(plan).includes(CODE_HEALTH_DEPS_COMMAND);
};

test("every scanned root keeps pnpm code-health:deps", () => {
  // The standing invariant: a change dependency-cruiser can read must still be
  // judged by it. Asserted for all six roots, not just the motivating one.
  // This iterates the same constant the pass compiles its trigger from, so it
  // proves the trigger is built correctly and NOT that the list is right — the
  // staleness test below is what pins the list against its two sources.
  for (const root of DEPCRUISE_ROOTS) {
    assert.equal(
      depsSurvives([`${root}/src/thing.ts`]),
      true,
      `${root} is a scanned root; narrowing it away would weaken the check`,
    );
  }
});

test("ANY path inside a scanned root keeps the command, whatever its type", () => {
  // Reverted narrowing, kept as a regression test. Extension lists cannot
  // decide graph membership: resolution can reach any file an import names
  // with its extension, so `.md`, `.svg`, `.css`, `.json` and `.sol` are all
  // possible edge targets. See the note on DEPCRUISE_ROOT_PREFIX.
  for (const path of [
    "ui-dashboard/AGENTS.md",
    "ui-dashboard/README.md",
    "ui-dashboard/public/logo.svg",
    "ui-dashboard/src/app/globals.css",
    "ui-dashboard/src/thing.ts",
    "aegis/src/Thing.sol",
    "indexer-envio/config/celo.yaml",
    "indexer-envio/config/nttAddresses.json",
    "ui-dashboard/package.json",
  ]) {
    assert.equal(
      depsSurvives([path]),
      true,
      `${path} is inside a scanned root, so dependency-cruiser may report it`,
    );
  }
});

test("the in-root asset imports these cases stand for are still real", () => {
  // Two real imports, kept from the reverted extension pins. They are why an
  // in-root non-source change can move an edge: if either stops existing, the
  // reasoning above needs re-checking rather than quiet trust.
  const repoRoot = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../..",
  );
  const read = (relative) => readFileSync(join(repoRoot, relative), "utf8");
  assert.match(
    read("indexer-envio/src/handlers/stables/config.ts"),
    /import\s+\w+\s+from\s+"[^"]*config\/nttAddresses\.json"/,
    "indexer source must still statically import a config JSON",
  );
  assert.match(
    read("ui-dashboard/src/app/layout.tsx"),
    /import\s+"\.\/globals\.css"/,
    "dashboard source must still statically import a stylesheet",
  );
});

test("a change outside every scanned root drops pnpm code-health:deps", () => {
  for (const path of [
    "governance-watchdog/src/index.ts",
    "alerts/infra/onchain-event-handler/src/index.ts",
    "alerts/infra/oncall-announcer/src/main.ts",
    ".github/workflows/ci.yml",
    "docs/notes/quick-commands.md",
    "terraform/platform/main.tf",
  ]) {
    assert.equal(
      depsSurvives([path]),
      false,
      `${path} is neither walked nor reported by dependency-cruiser`,
    );
  }
});

test("a workspace manifest keeps pnpm code-health:deps", () => {
  // A scanned root reaches another scanned root by package name
  // (`@mento-protocol/config` → `shared-config/`), so these three files can add
  // or remove an edge between two roots with no file inside a root changing.
  // Narrowing them away would hide exactly that class of graph change.
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]) {
    assert.equal(
      depsSurvives([path]),
      true,
      `${path} decides what a bare specifier inside a scanned root resolves to`,
    );
  }
});

test("a non-root package manifest does not keep the command", () => {
  // The manifest triggers are anchored, so a manifest belonging to a package
  // dependency-cruiser never scans stays narrowed away.
  assert.equal(depsSurvives(["governance-watchdog/package.json"]), false);
});

test("one in-root path anywhere in the set keeps the command", () => {
  assert.equal(
    depsSurvives(["governance-watchdog/src/index.ts", "aegis/src/Thing.ts"]),
    true,
    "the pass asks what changed, not which package the arms routed",
  );
});

test("the dep-cruiser config and this pass keep the command", () => {
  // Fail-closed: an edit to the rules, or to the narrowing itself, runs the
  // command rather than being judged by it.
  assert.equal(depsSurvives([".dependency-cruiser.cjs"]), true);
  assert.equal(
    depsSurvives([
      "scripts/gate/mapping/post-passes.mjs",
      "governance-watchdog/src/index.ts",
    ]),
    true,
  );
});

/** A plan as an arm that never schedules dep-cruiser would leave it. */
const depsAddedTo = (changedPaths) => {
  const plan = new Plan();
  plan.addCommand("pnpm exec turbo run lint --filter=x --cache=local:rw", "a");
  narrowCodeHealthDepsCommand(plan, changedPaths);
  return commandsOf(plan).filter((c) => c === CODE_HEALTH_DEPS_COMMAND).length;
};

test("the pass schedules the command when no arm did", () => {
  // The defect this closes: declining to remove a command nothing added leaves
  // the plan without it. Measured against the real gate, `post-passes.mjs` and
  // `pnpm-lock.yaml` reach no arm that schedules dep-cruiser, so for those two
  // the guarantee only exists if this pass adds the command itself.
  for (const path of [
    "scripts/gate/mapping/post-passes.mjs",
    "pnpm-lock.yaml",
    "package.json",
    "pnpm-workspace.yaml",
    ".dependency-cruiser.cjs",
  ]) {
    assert.equal(
      depsAddedTo([path]),
      1,
      `${path} must schedule dep-cruiser even when no arm does`,
    );
  }
});

test("the pass does not schedule dep-cruiser for a scanned root alone", () => {
  // The arms own the roots, and they decide better: a root's README matches the
  // root prefix but cannot change a verdict. Scheduling here would add work the
  // arms correctly leave out.
  assert.equal(depsAddedTo(["shared-config/README.md"]), 0);
  assert.equal(depsAddedTo(["ui-dashboard/src/thing.ts"]), 0);
});

test("the pass does not duplicate a command an arm already scheduled", () => {
  const plan = depsPlan();
  narrowCodeHealthDepsCommand(plan, [".dependency-cruiser.cjs"]);
  assert.equal(
    commandsOf(plan).filter((c) => c === CODE_HEALTH_DEPS_COMMAND).length,
    1,
    "addCommand dedupes, so the arm's entry and reason survive",
  );
  assert.equal(reasonOf(plan, CODE_HEALTH_DEPS_COMMAND), "package bundle");
});

test("the pass removes only its own command", () => {
  const plan = depsPlan();
  narrowCodeHealthDepsCommand(plan, ["docs/note.md"]);
  assert.deepEqual(commandsOf(plan), [
    "pnpm exec turbo run lint --filter=x --cache=local:rw",
    "pnpm --filter x test:coverage",
  ]);
});

test("the pinned roots match both sources that define them", () => {
  // Staleness, both directions. Adding a seventh root to either source without
  // updating DEPCRUISE_ROOTS would otherwise leave the gate quietly
  // under-routing every change beneath it.
  const repoRoot = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../..",
  );
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const script = manifest.scripts["code-health:deps"];
  assert.ok(script.startsWith("depcruise --config .dependency-cruiser.cjs "));
  const scriptRoots = script
    .slice("depcruise --config .dependency-cruiser.cjs ".length)
    .split(" ")
    .filter((token) => token !== "");

  const config = createRequire(import.meta.url)(
    join(repoRoot, ".dependency-cruiser.cjs"),
  );
  const includeOnly = config.options.includeOnly.path;
  const match = /^\^\(([^)]+)\)\/$/.exec(includeOnly);
  assert.ok(
    match !== null,
    `includeOnly.path is no longer a root alternation: ${includeOnly}`,
  );
  const configRoots = match[1].split("|");

  const sorted = (values) => [...values].sort();
  assert.deepEqual(
    sorted(scriptRoots),
    sorted(DEPCRUISE_ROOTS),
    "the code-health:deps arguments and the gate's pinned roots must agree",
  );
  assert.deepEqual(
    sorted(configRoots),
    sorted(DEPCRUISE_ROOTS),
    "the dependency-cruiser includeOnly roots and the gate's pinned roots must agree",
  );
});

// ── Facts: the root-manifest classifier ────────────────────────────────────

/** A throwaway repo whose HEAD package.json differs from its worktree copy. */
function manifestRepo(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "engine-facts-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const manifest = {
    name: "fixture",
    private: true,
    description: "fixture",
    scripts: { "docs:index": "node a.mjs", build: "true" },
    dependencies: { left: "1.0.0" },
    devDependencies: { right: "1.0.0" },
  };
  mkdirSync(join(dir, "empty-hooks"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  git("init", "-q");
  git("config", "user.email", "engine-test@example.invalid");
  git("config", "user.name", "engine test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(dir, "empty-hooks"));
  git("add", "-A");
  git("commit", "-qm", "fixture");
  mutate(manifest);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return dir;
}

// The freshness stamp binds the merge-base; `facts.baseOid` deliberately does
// not. It is the base ref's TIP, and the gate keeps tip binding for any plan
// whose text carries it. Pin that difference: if this ever became the
// merge-base, react-doctor's Turbo cache key would stop moving when the base
// moved and a stale diff answer could survive a fetch.
test("facts.baseOid resolves the base ref's tip, not the merge-base", () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-base-oid-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  mkdirSync(join(dir, "empty-hooks"), { recursive: true });
  writeFileSync(join(dir, "fixture.txt"), "fixture\n");
  git("init", "-q");
  git("config", "user.email", "engine-test@example.invalid");
  git("config", "user.name", "engine test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(dir, "empty-hooks"));
  git("add", "-A");
  git("commit", "-qm", "fixture");
  // A same-tree child of HEAD that HEAD itself does not contain: the base tip
  // advances while the merge-base stays where it was.
  const mergeBase = git("rev-parse", "--verify", "HEAD");
  const tip = git(
    "commit-tree",
    git("rev-parse", "--verify", "HEAD^{tree}"),
    "-p",
    mergeBase,
    "-m",
    "base advance",
  );
  git("update-ref", "refs/remotes/origin/main", tip);
  assert.equal(git("merge-base", "origin/main", "HEAD"), mergeBase);
  assert.notEqual(tip, mergeBase);

  const facts = new Facts({
    repoRoot: dir,
    baseRef: "origin/main",
    headRef: "HEAD",
    changedPathsFile: join(dir, "paths"),
    isRealTree: false,
    scriptSourceDir: join(dir, "scripts"),
  });
  assert.equal(facts.baseOid, tip);
});

const classOf = (dir) =>
  new Facts({
    repoRoot: dir,
    baseRef: "HEAD",
    headRef: "HEAD",
    changedPathsFile: join(dir, "paths"),
    isRealTree: false,
    scriptSourceDir: join(dir, "scripts"),
  }).rootPackageJsonClass();

test("the root manifest classifies into its four closed classes", () => {
  const cases = [
    // A tooling script pointer and nothing else.
    [(m) => (m.scripts["docs:index"] = "node b.mjs"), "root-tooling-scripts"],
    // A script that is not on the tooling list.
    [(m) => (m.scripts.build = "false"), "package-scripts"],
    // Descriptive metadata only.
    [(m) => (m.description = "changed"), "workspace-dev-metadata"],
    [(m) => (m.devDependencies.right = "2.0.0"), "workspace-dev-metadata"],
    // Anything else is the full workspace suite.
    [(m) => (m.dependencies.left = "2.0.0"), "workspace"],
    // No change at all is also the widest answer.
    [() => {}, "workspace"],
  ];
  for (const [mutate, expected] of cases) {
    const dir = manifestRepo(mutate);
    try {
      assert.equal(classOf(dir), expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a tooling script plus anything else is no longer tooling-only", () => {
  const dir = manifestRepo((m) => {
    m.scripts["docs:index"] = "node b.mjs";
    m.dependencies.left = "2.0.0";
  });
  try {
    assert.equal(classOf(dir), "package-scripts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The CLI seam ───────────────────────────────────────────────────────────

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** Run the mapper the way the gate does, from `entry`. */
function runMapper(entry, scriptSourceDir) {
  const dir = mkdtempSync(join(tmpdir(), "engine-cli-"));
  const pathsFile = join(dir, "paths");
  writeFileSync(pathsFile, "ui-dashboard/src/lib/utils.ts\n");
  try {
    return execFileSync(
      "node",
      [
        entry,
        "--repo-root",
        REPO,
        "--changed-paths-file",
        pathsFile,
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--script-source-dir",
        scriptSourceDir,
        "--real-tree",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the mapper runs when reached through a SYMLINK, not only by its real path", () => {
  // `process.argv[1] === fileURLToPath(import.meta.url)` is false for every
  // symlinked invocation, because Node realpaths the entry for `import.meta.url`
  // and leaves argv alone. The module then imports, runs nothing, exits 0 with
  // no output — and the gate refuses every run with "produced an empty plan".
  // The gate's own suite builds `scripts/` mirrors out of symlinks, and macOS
  // `/tmp` is one, so this is the ordinary case rather than an exotic one.
  const real = fileURLToPath(new URL("../mapping.mjs", import.meta.url));
  const direct = runMapper(real, join(REPO, "scripts"));
  assert.ok(direct.includes("\tpnpm "), "the control run produced no plan");

  const mirror = mkdtempSync(join(tmpdir(), "engine-mirror-"));
  try {
    mkdirSync(join(mirror, "gate"));
    for (const entry of readdirSync(join(REPO, "scripts"))) {
      if (entry === "gate") continue;
      symlinkSync(join(REPO, "scripts", entry), join(mirror, entry));
    }
    for (const entry of readdirSync(join(REPO, "scripts/gate"))) {
      symlinkSync(
        join(REPO, "scripts/gate", entry),
        join(mirror, "gate", entry),
      );
    }
    const throughLink = runMapper(join(mirror, "gate/mapping.mjs"), mirror);
    assert.equal(
      throughLink,
      direct,
      "a symlinked invocation must produce the same plan, not an empty one",
    );
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
});

// ── The signature pin, enumerated ──────────────────────────────────────────

const SIGNATURE_ENTRIES = (() => {
  const source = bashFunctionSource(
    readFileSync(join(REPO, "scripts/agent-quality-gate.sh"), "utf8"),
    "implementation_signature",
    "scripts/agent-quality-gate.sh",
  );
  const listEnd = source.indexOf("; do");
  assert.ok(
    listEnd > 0,
    "implementation_signature() has no bounded for-path list",
  );
  const entries = source
    .slice(0, listEnd)
    .split(/\s+/)
    .filter((word) => word.startsWith("scripts/") || word.endsWith(".json"));
  // Sanity: if the span parsed wrongly every assertion below is vacuous.
  assert.ok(
    entries.includes("scripts/agent-quality-gate.sh"),
    `parsed ${entries.length} signature entries without the gate itself; the span was read wrongly`,
  );
  return entries;
})();

const ENGINE_MODULES = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
  .filter((name) => name.endsWith(".mjs"))
  .sort();

test("implementation_signature() lists every mapping-engine module", () => {
  // The same load-bearing pin the routing table has, and it matters more here:
  // an entry the signature cannot `stat` hashes as `__missing__` and FREEZES
  // the signature, so `--skip-if-fresh` reuses a stale stamp — for the code
  // that now decides which commands run at all.
  assert.ok(ENGINE_MODULES.length > 0, "found no engine modules to check");
  for (const module of ENGINE_MODULES) {
    assert.ok(
      SIGNATURE_ENTRIES.includes(`scripts/gate/mapping/${module}`),
      `implementation_signature() does not list scripts/gate/mapping/${module}; a missing entry freezes the freshness signature`,
    );
  }
});

test("implementation_signature() lists no mapping-engine module that is gone", () => {
  const prefix = "scripts/gate/mapping/";
  for (const entry of SIGNATURE_ENTRIES.filter((path) =>
    path.startsWith(prefix),
  )) {
    assert.ok(
      ENGINE_MODULES.includes(entry.slice(prefix.length)),
      `implementation_signature() still lists ${entry}, which no longer exists; a stale entry hashes as __missing__ forever`,
    );
  }
});

test("an unparsable manifest widens to the full workspace suite", () => {
  const dir = manifestRepo(() => {});
  try {
    writeFileSync(join(dir, "package.json"), "{ not json");
    assert.equal(
      classOf(dir),
      "workspace",
      "an ambiguous fact resolves toward MORE work",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

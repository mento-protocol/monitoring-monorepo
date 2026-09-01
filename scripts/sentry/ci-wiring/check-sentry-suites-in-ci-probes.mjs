/**
 * The file reads, external-process probes, repo-specific constants, and
 * filesystem walkers behind scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs.
 *
 * Split out of the test file to keep both under the repo's 1,000-line cap. The
 * pure predicates live in check-sentry-suites-in-ci-core.mjs; the gate-routing
 * probe lives in check-sentry-suites-in-ci-gate-probe.mjs and is re-exported
 * here, so the tests still import every probe from one façade; the `test()`
 * blocks stay in the test file next door, which runs them. Nothing here is a
 * test — this module gathers the structures those tests judge, plus the
 * fixtures and mutation specs (`compositeFixture`, `SENTINEL_MUTATIONS`) heavy
 * enough that keeping them here holds the entry point under the cap. A mutation
 * spec only rewrites a `structuredClone` of the real workflow, so the test can
 * run a real predicate against a broken clone rather than a drifting fixture.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, dump, load } from "js-yaml";
import { isPlainObject } from "./check-sentry-suites-in-ci-core.mjs";
// One implementation of "what does this module import", shared with the
// sentry-suite gate; see scripts/lib/static-imports.mjs for why it is not a regex.
import { staticImports } from "../../lib/static-imports.mjs";

export { staticImports };

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const SCRIPTS_DIR = join(ROOT, "scripts");
export const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
export const CI_PATH = join(WORKFLOWS_DIR, "ci.yml");
export const VALIDATOR_PATH = join(
  SCRIPTS_DIR,
  "check-agent-quality-gate-package-scripts.mjs",
);

/** The pin validator invocation the `scripts` job must run before install and any alias. */
export const PIN_VALIDATOR_COMMAND = [
  "node",
  "scripts/check-agent-quality-gate-package-scripts.mjs",
];

/** The local install action the `scripts` job must run AFTER the pin validator. */
export const INSTALL_ACTION = "$/.github/actions/pnpm-install";

/** The test file, so the check can assert its own CI step still exists. */
export const SELF =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs";

/** The sibling test module holding the execution-surface invariants. */
export const LIFECYCLE =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-lifecycle.test.mjs";

/** The module holding every predicate the check asserts with. */
export const CORE =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core.mjs";

/** The sibling module the core re-exports the command-grammar predicates from. */
export const CORE_COMMANDS =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-core-commands.mjs";

/** This module: the file reads and probes the check runs. */
export const PROBES =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-probes.mjs";

/** The shared V8 import parser both this check and the gate ask for imports. */
export const STATIC_IMPORTS = "scripts/lib/static-imports.mjs";

/** The sibling module that asks the mapping engine how the gate classifies a manifest change. */
export const GATE_PROBE =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-probe.mjs";

/** The sibling test module holding that probe's own invariants. */
export const GATE_PROBE_TESTS =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-probe.test.mjs";

/** The module that lifts a bash function out of a script, and runs the shells. */
export const GATE_EXTRACT =
  "scripts/sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs";

// Re-exported here so the tests keep importing every probe from one façade.
export { bashFunctionSource } from "./check-sentry-suites-in-ci-gate-extract.mjs";
export {
  GATE_CLASSIFIER,
  GATE_CLASSIFIER_PATH,
  gateClassifications,
  GATE_ROOT_PACKAGE_JSON_CLASSES,
} from "./check-sentry-suites-in-ci-gate-probe.mjs";

// A throw here is the intended failure mode for a malformed workflow.
export const CI = load(readFileSync(CI_PATH, "utf8"), { schema: CORE_SCHEMA });
export const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
export const PKG_SCRIPTS = PKG.scripts ?? {};

/**
 * Every workflow under .github/workflows, parsed. The `ci` check-run name must
 * be unique across all of them, so this check reads the whole directory rather
 * than ci.yml alone.
 */
export const WORKFLOWS = readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")),
  )
  .map((entry) => ({
    path: `.github/workflows/${entry.name}`,
    workflow: load(readFileSync(join(WORKFLOWS_DIR, entry.name), "utf8"), {
      schema: CORE_SCHEMA,
    }),
  }));

/**
 * The composite-action steps a job pulls in through `uses: ./…`, followed
 * transitively. A trusted job's environment is set by its own steps AND by any
 * local composite it runs — and a composite may itself `uses:` another local
 * composite, so an env write hiding two levels down reaches the runner just the
 * same. This opens each `action.yml`, records its steps, and recurses into any
 * nested `$/` or `./` action until a fixpoint, with a visited set on the resolved
 * `action.yml` path so a diamond is walked once and a cycle terminates instead
 * of looping. Third-party `uses:` (SHA-pinned, covered by
 * check-github-action-pins.mjs) are out of scope.
 *
 * Returns the flattened composite steps, the repo-relative `action.yml` files
 * opened, and blockers for any local action this scan cannot soundly analyze,
 * so a caller can scan the steps for env writes, prove every file it read is
 * routed back into CI and the local gate, and fail closed on the rest.
 *
 * Only a `composite` action is analyzable: its `runs.steps` are plain `run:`
 * lines the env scan can read. A JavaScript (`using: node*`) or Docker
 * (`using: docker`) action has no `runs.steps` — its entrypoint code can
 * `core.exportVariable` / write `$GITHUB_ENV` for every later suite, invisibly
 * to this static scan — so a non-composite local action in a trusted job's
 * chain is a blocker, not a silent accept. Third-party `uses:` (SHA-pinned,
 * covered by check-github-action-pins.mjs) are out of scope and not descended.
 *
 * @param {Record<string, any>} job
 * @param {string} [root] the repo root the self-action paths resolve against;
 *   overridable so a synthetic tree can exercise the recursion without adding a
 *   real nested action to the repo.
 * @returns {{ steps: Record<string, any>[], files: string[], blockers: string[] }}
 */
export function collectCompositeActions(job, root = ROOT) {
  const steps = [];
  const files = [];
  const blockers = [];
  const visited = new Set();

  const selfActionDirectory = (usesPath) =>
    usesPath.startsWith("$/") || usesPath.startsWith("./")
      ? usesPath.slice(2)
      : null;

  const readAction = (usesPath) => {
    const dir = selfActionDirectory(usesPath);
    if (dir === null) return null;
    for (const file of ["action.yml", "action.yaml"]) {
      const full = join(root, dir, file);
      let source;
      try {
        source = readFileSync(full, "utf8");
      } catch {
        continue; // try the other extension
      }
      return {
        source,
        relative: `${dir}/${file}`,
        resolved: realpathSync(full),
      };
    }
    return null;
  };

  const descend = (usesPath) => {
    const found = readAction(usesPath);
    assert.ok(
      found !== null,
      `local action \`${usesPath}\` has no action.yml/action.yaml — the env scan cannot read it`,
    );
    if (visited.has(found.resolved)) return; // diamond or cycle: walked already
    visited.add(found.resolved);
    files.push(found.relative);
    const action = load(found.source, { schema: CORE_SCHEMA });
    const using = action?.runs?.using;
    if (using !== "composite") {
      blockers.push(
        `local action \`${usesPath}\` runs \`using: ${using ?? "(unset)"}\`, not \`composite\` — its ` +
          "JavaScript/Docker entrypoint can write `$GITHUB_ENV`/`$GITHUB_PATH` for every later step, " +
          "which this static scan cannot read; only a composite of analyzable steps is accepted",
      );
      return; // a non-composite action has no `runs.steps` to walk
    }
    for (const step of action?.runs?.steps ?? []) {
      if (!isPlainObject(step)) continue;
      steps.push(step);
      if (typeof step.uses === "string" && selfActionDirectory(step.uses)) {
        descend(step.uses);
      }
    }
  };

  for (const step of job?.steps ?? []) {
    if (!isPlainObject(step) || typeof step.uses !== "string") continue;
    if (!selfActionDirectory(step.uses)) continue;
    descend(step.uses);
  }
  return { steps, files, blockers };
}

/**
 * A two-level composite fixture (job → level1 → level2) under a fresh temp dir,
 * returned as `{ base, job, write, cleanup }`. `write(rel, doc)` writes an
 * `action.yml` (object dumped to YAML, or a raw string), so a test can set
 * level2's `runs` to exercise the recursive env scan and the non-composite
 * rejection without giving a real repo action a nested child to protect.
 */
export function compositeFixture() {
  const base = mkdtempSync(join(tmpdir(), "sentry-action-fixture-"));
  const write = (rel, doc) => {
    const full = join(base, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof doc === "string" ? doc : dump(doc));
  };
  write(".github/actions/level1/action.yml", {
    name: "level1",
    runs: { using: "composite", steps: [{ uses: "./.github/actions/level2" }] },
  });
  return {
    base,
    job: { steps: [{ uses: "./.github/actions/level1" }] },
    write,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** The alls-green step of a (cloned) workflow's `ci` sentinel. */
export function allsGreenStep(workflow) {
  return workflow.jobs.ci.steps.find((step) =>
    String(step.uses ?? "").startsWith("re-actors/alls-green@"),
  );
}

/**
 * Ways to break the `ci` sentinel so it no longer turns a red trusted job into
 * a red required check. Each `[label, mutate]` runs against a `structuredClone`
 * of the real workflow in the test next door: `sentinelBlockers` must reject
 * every one, or a later edit that weakens the check goes uncaught. The specs
 * are data (they only rewrite a cloned workflow through `allsGreenStep`); the
 * test file owns the `test()`/`assert` that runs them. Kept here so the entry
 * point stays under the 1,000-line cap.
 */
export const SENTINEL_MUTATIONS = [
  ["`if: false`", (w) => (w.jobs.ci.if = "false")],
  ["a dropped `if: always()`", (w) => delete w.jobs.ci.if],
  [
    "a `needs` without `production-infra-contract`",
    (w) =>
      (w.jobs.ci.needs = w.jobs.ci.needs.filter(
        (n) => n !== "production-infra-contract",
      )),
  ],
  ["`continue-on-error`", (w) => (w.jobs.ci["continue-on-error"] = true)],
  [
    "`production-infra-contract` under `allowed-failures`",
    (w) => {
      allsGreenStep(w).with["allowed-failures"] = "production-infra-contract";
    },
  ],
  [
    "a JSON-encoded `allowed-failures` the comma split cannot read",
    // The alls-green action `json.loads()` this first, so it is a real
    // one-element allowlist to the runner; a comma-only reader sees one opaque
    // token and tolerates nothing. This is the merge-gate hole.
    (w) => {
      allsGreenStep(w).with["allowed-failures"] = '["scripts"]';
    },
  ],
  [
    "`production-infra-contract` under a JSON `allowed-failures`",
    (w) => {
      allsGreenStep(w).with["allowed-failures"] =
        '["production-infra-contract"]';
    },
  ],
  [
    "`changes` tolerated as a failure",
    // `changes` decides whether every path-gated job runs; tolerating its
    // failure turns a red detector into silent skips of every Sentry suite.
    (w) => {
      allsGreenStep(w).with["allowed-failures"] = "changes";
    },
  ],
  [
    "a case-variant `JOBS` overriding `jobs`",
    // The runner matches `with:` keys case-insensitively and the last wins, so
    // `jobs` still literally reads `${{ toJSON(needs) }}` while `JOBS` feeds the
    // action a hand-picked all-green matrix.
    (w) => {
      allsGreenStep(w).with.JOBS = '{"changes":{"result":"success"}}';
    },
  ],
  [
    "a renamed sentinel job",
    // The required context is matched by check-run name; renaming it leaves
    // `jobs.ci` keyed the same while it publishes a different context.
    (w) => (w.jobs.ci.name = "ci-aggregate"),
  ],
  [
    "a case-variant `ALLOWED-SKIPS` overriding `allowed-skips`",
    // The runner matches `with:` keys case-insensitively and the last wins, so
    // a decoy key makes `sentry-suites` skippable while the real `allowed-skips`
    // still reads clean — and `gateJobBlockers` reads only the lowercase key.
    // The collision check here is what stops that reaching the merge gate.
    (w) => {
      allsGreenStep(w).with["ALLOWED-SKIPS"] = "sentry-suites";
    },
  ],
  [
    "a sentinel converted to a reusable-workflow call",
    // `jobs.ci.uses:` moves the aggregation into a file this scan cannot read,
    // so its alls-green step is gone — the one step that reds `ci` on a red job.
    // No inline step means no proof it still gates.
    (w) => {
      w.jobs.ci.uses = "org/aggregate/.github/workflows/ci.yml@main";
      delete w.jobs.ci.steps;
    },
  ],
];

/**
 * Every `sentry-*.test.mjs` under scripts/, at any depth, as a repo-relative
 * path. Recursive so a suite cannot hide from invariant 1 by moving into a
 * subdirectory.
 *
 * A Dirent from `readdirSync(withFileTypes)` comes from `lstat`, so a symlink to
 * a directory reports `isDirectory() === false` and would be neither recursed
 * into nor recorded — a suite behind `scripts/<symlink>/` would silently drop
 * out of enumeration and never be required in CI. So a symlink is resolved with
 * `statSync` (which follows it) and walked when it points to a directory; a
 * `realpathSync` visited-set fails closed on a cycle rather than looping.
 *
 * @param {string} dir
 * @param {string} prefix
 * @param {Set<string>} ancestors resolved directories on the path to `dir`
 */
export function findSentrySuites(
  dir,
  prefix = "scripts",
  ancestors = new Set(),
) {
  const realDir = realpathSync(dir);
  // Only a directory that is its own ancestor is a cycle. A symlink to an
  // already-enumerated sibling is a diamond, not a loop, and must still be
  // walked — tracking the path to here rather than every dir seen keeps the
  // first without looping on the second.
  assert.ok(
    !ancestors.has(realDir),
    `symlink cycle under scripts/ at ${prefix} — resolve it; the suite enumeration cannot walk a cycle`,
  );
  const nextAncestors = new Set(ancestors).add(realDir);
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    // A broken symlink throws here, which is the intended failure mode: an
    // unresolvable entry under scripts/ must fail the enumeration, not vanish.
    const isDirectory = entry.isSymbolicLink()
      ? statSync(full).isDirectory()
      : entry.isDirectory();
    if (isDirectory) {
      found.push(...findSentrySuites(full, relative, nextAncestors));
    } else if (
      entry.name.startsWith("sentry-") &&
      entry.name.endsWith(".test.mjs")
    ) {
      found.push(relative);
    }
  }
  return found.sort();
}

export const SENTRY_SUITES = findSentrySuites(SCRIPTS_DIR);

/**
 * Run check-agent-quality-gate-package-scripts.mjs against a synthetic
 * package.json and report whether it accepted. Lets the lifecycle invariants
 * prove the validator rejects an unsanctioned lifecycle hook (and accepts the
 * real, clean manifest) without running the whole gate.
 *
 * @param {Record<string, unknown>} pkg
 * @returns {{ ok: boolean, output: string }}
 */
export function runPackageScriptValidator(pkg) {
  const dir = mkdtempSync(join(tmpdir(), "pkg-script-validator-"));
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg)}\n`);
    try {
      const stdout = execFileSync(process.execPath, [VALIDATOR_PATH], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output: stdout };
    } catch (error) {
      return {
        ok: false,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sentry-named suites that another CI job owns. The value names the route;
 * `the exemption for sentry-provider-contract still holds` re-proves it. An
 * exemption whose route disappeared is a hole, not an exemption.
 */
export const RUN_BY_ANOTHER_JOB = new Map([
  [
    "scripts/sentry/gate/sentry-provider-contract.test.mjs",
    "imported by scripts/tf-stacks.test.mjs, which `pnpm tf:test` runs in the " +
      "unconditional `Production infrastructure contract` job",
  ],
]);

/**
 * The jobs this file trusts to run its assertions, and the ONLY `if:` each may
 * carry. `null` means the job must be unconditional.
 *
 * One entry, and the narrowing is the point (issue #1779, PR C).
 * `production-infra-contract` is here because it runs the one suite the runtime
 * gate does not — `sentry-provider-contract.test.mjs`, via `pnpm tf:test` — so
 * the exemption is only as good as that job's trustworthiness.
 *
 * `scripts` left when the Sentry suites and this checker did: that job no
 * longer runs a line of Sentry code, so asserting its shape here asserted
 * nothing about the Sentry legs.
 *
 * `sentry-suites` is deliberately NOT here. Its whole structure is pinned by
 * exact equality against `CANONICAL_JOB`
 * (check-sentry-suites-in-ci-gate-job.test.mjs), which rejects every construct
 * `jobBlockers` looks for — `uses:`, `container`, `strategy`, `environment`,
 * `continue-on-error`, an `if:`, an `env:` at either level — plus everything it
 * does not, since anything outside the canonical shape is rejected whatever it
 * is called. Its only self-repository composite is `$/.github/actions/pnpm-install`,
 * which this map already routes through `production-infra-contract`, and
 * `gateJobBlockers` separately requires the sentinel to need it and to tolerate
 * neither its skip nor its failure. Listing it twice would add a weaker copy.
 */
export const TRUSTED_JOBS = new Map([["production-infra-contract", null]]);

// The `rootScripts` paths-filter reachability proof lived here until issue
// #1779 PR C. It existed because this checker ran in the path-gated `scripts`
// job: every file it read had to be routed by the filter, or an edit to that
// file skipped the whole job and the `ci` sentinel tolerated the skip. The
// checker now runs in the unconditional `sentry-suites` job, which has no
// filter and no `if:` to narrow, so there is no longer a set of paths that must
// reach it — a dashboard-only or indexer-only diff runs it like any other.

/**
 * The exact commands check-agent-quality-gate-package-scripts.mjs pins, read
 * from the validator itself: it is run against a package.json with no scripts,
 * so it reports every pin it enforces, with the command it demands.
 *
 * This reads enforcement, not declaration. A commented-out pin produces no
 * line — and neither would a pin the validator declared but never checked.
 *
 * @returns {Map<string, string>}
 */
export function validatorPins() {
  const dir = mkdtempSync(join(tmpdir(), "sentry-pin-probe-"));
  let output;
  try {
    writeFileSync(join(dir, "package.json"), '{"scripts":{}}\n');
    try {
      execFileSync(process.execPath, [VALIDATOR_PATH], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      output = "";
    } catch (error) {
      // A pin that is not satisfied is reported and exits non-zero, which is
      // the whole point of the probe.
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const pins = new Map();
  for (const line of output.split("\n")) {
    const match = /^package\.json scripts\.(\S+) must be (.+)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    pins.set(match[1], JSON.parse(match[2]));
  }
  return pins;
}

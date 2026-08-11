#!/usr/bin/env node
/**
 * Structural assertion: every Sentry suite is reachable from CI, not only from
 * the local pre-push gate.
 *
 * Issue #1721: eight `sentry:*:test` scripts — roughly 400 assertions — were
 * enforced by the pre-push hook alone. `.github/workflows/ci.yml` invoked none
 * of them, so a contributor who bypassed the hook could merge a regression in
 * the triage or autofix leg against a fully green required check. Wiring the
 * suites fixed that instance. This file stops it recurring: the next suite
 * that lands without a CI step fails here, on the `scripts` job that is
 * already required.
 *
 * EVERY assertion reads a parsed structure. Six review rounds against the
 * text-matching version of this file found the same defect in a new place each
 * time — a commented-out step, a commented-out import, a commented-out filter
 * path, an `echo` naming a suite, an `if: false`, a `|| true`. Each is
 * invisible to a parser and each defeated a substring search. So:
 *
 *   ci.yml               js-yaml, then walked as objects
 *   the paths filter     js-yaml again, on the inner YAML document that lives
 *                        inside the filter step's string value
 *   `run:` commands      tokenized against a plain-word grammar and matched
 *                        whole, never by prefix
 *   tf-stacks.test.mjs   V8's own parser (vm.SourceTextModule) reports the
 *                        static import list, with nothing executed
 *   the gate allowlist   bash evaluates its own `case` statement
 *   the validator pins   the validator reports them itself
 *
 * An unparsable ci.yml throws here, and that is correct: this same job runs
 * scripts/check-autofix-ci-trust.mjs, which already fails closed on one.
 *
 * The predicates live in scripts/check-sentry-suites-in-ci-core.mjs and take
 * the structure they judge as an argument rather than reading a module-level
 * constant, so each one is exercised twice: once against the real ci.yml, and
 * once against a `structuredClone` of it with a single field broken. A check
 * that passes on the real workflow has proven only that it accepts; the
 * mutation probes are what prove it rejects. This file owns the file reads, the
 * external-process probes, the repo-specific constants, and every `test()`.
 *
 * Three invariants, each guarding a different way the wiring rots:
 *
 *   1. Every `scripts/sentry-*.test.mjs` is invoked by the `scripts` job as a
 *      DIRECT `node scripts/<file>` command (never a `pnpm <alias>`). The
 *      pnpm-run path carries two config-level fail-opens a parser cannot see —
 *      a `scriptShell: /bin/true` false-greens the alias (Codex 3754704267),
 *      and a `presentry:*:test` lifecycle hook runs before it and can empty the
 *      suite (Codex 3754704278) — so the check rejects the alias form and
 *      requires the direct one. A suite may be exempted only by naming the CI
 *      job that does run it, and the exemption is re-proven below.
 *   2. Every `sentry:*:test` package script resolves to a file this check
 *      enumerates, so a stray alias cannot point at a non-suite file.
 *   3. The local gate's tooling allowlist in scripts/agent-quality-gate.sh
 *      lists every `sentry:*` script, and every listed script is pinned to an
 *      exact command by check-agent-quality-gate-package-scripts.sh. The local
 *      gate still runs the `pnpm sentry:*:test` aliases (developer
 *      convenience, with CI's direct invocation as the backstop); the
 *      allowlist grants that trust and the pin is what makes it safe.
 *
 * Run: `node scripts/check-sentry-suites-in-ci.test.mjs`
 * CI:  .github/workflows/ci.yml  (scripts job)
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { CORE_SCHEMA, dump, load } from "js-yaml";
import {
  aliasesFor,
  commandRunsOnly,
  contextOwnershipBlockers,
  envMutationBlockers,
  globToRegExp,
  invocationsOf,
  jobBlockers,
  nearMisses,
  provenCommands,
  requiredPathsMissing,
  runsCommand,
  sentinelBlockers,
  suiteTargets,
  triggerBlockers,
  workflowBlockers,
} from "./check-sentry-suites-in-ci-core.mjs";
import { countLines, HARD_CAP } from "./file-size-watchlist.mjs";
import {
  CI,
  collectCompositeActions,
  compositeFixture,
  CORE,
  dropFilterPath,
  findSentrySuites,
  gateClassifications,
  PKG_SCRIPTS,
  PROBE_INPUTS,
  REQUIRED_ROOT_SCRIPT_PATHS,
  ROOT,
  RUN_BY_ANOTHER_JOB,
  SCRIPTS_DIR,
  SELF,
  SENTINEL_MUTATIONS,
  SENTRY_SUITES,
  staticImports,
  TRUSTED_JOBS,
  VALIDATOR_PATH,
  validatorPins,
  WORKFLOWS,
} from "./check-sentry-suites-in-ci-probes.mjs";

// The file reads, external-process probes, and repo-specific constants live in
// check-sentry-suites-in-ci-probes.mjs; the predicates live in
// check-sentry-suites-in-ci-core.mjs (with the command grammar re-exported from
// -core-commands.mjs). This file owns every `test()` and the `structuredClone`
// mutation probes that prove each predicate rejects, not only accepts.

// ── invariants ───────────────────────────────────────────────────────────────

/**
 * Is `file` run by the `scripts` job as a whole-command DIRECT node invocation
 * (`node <file>` or `node --test <file>`)? Shared by invariant 1 and its
 * rejection probe so both exercise the same rule: coverage is proven by the CI
 * command alone and never by a `pnpm <alias>`, the path a `scriptShell`
 * override or a `presentry:*:test` lifecycle hook subverts. It reads no
 * package.json alias, so neither knob can change the verdict.
 *
 * @param {Record<string, any>} workflow
 * @param {string} file
 */
function suiteRunDirectly(workflow, file) {
  const commands = provenCommands(workflow, "scripts");
  return suiteTargets(file).some((target) => runsCommand(commands, target));
}

test("this file still imports the predicates it asserts with", () => {
  // Deleting the import throws, which is already fail-closed. The case this
  // guards is the quiet one: a refactor that keeps every test name while
  // redefining the predicates locally, weaker. V8's parser reports the
  // specifier list, so a commented-out import reads as absent — the same
  // discipline every other check here follows.
  const specifier = `./${basename(CORE)}`;
  const imports = staticImports(join(ROOT, SELF));
  assert.ok(
    imports.includes(specifier),
    `${SELF} no longer imports ${specifier}; its static imports are ${JSON.stringify(imports)}`,
  );
});

test("the enumeration found the Sentry suites at all", () => {
  // A rename or a moved directory must fail loudly rather than vacuously pass
  // every assertion below.
  assert.ok(
    SENTRY_SUITES.length >= 8,
    `expected at least 8 scripts/sentry-*.test.mjs suites, found ${SENTRY_SUITES.length}`,
  );
});

test("the ci.yml jobs this file trusts still run and still fail on failure", () => {
  assert.deepEqual(
    workflowBlockers(CI),
    [],
    "ci.yml's workflow-scope settings changed",
  );
  for (const name of TRUSTED_JOBS.keys()) {
    assert.deepEqual(
      jobBlockers(CI, name, TRUSTED_JOBS),
      [],
      `the \`${name}\` job can no longer be trusted to run its steps and fail the workflow`,
    );
  }
});

test("the trust check rejects a trusted job that stops running its own steps", () => {
  // A trusted job feeding the sentinel must run its steps on this runner and red
  // the job on failure. Converting it to a reusable-workflow call or a container
  // job moves or changes the runtime the suites see; a matrix can expand to zero
  // jobs (a skip); an environment gate can hold or reject the run. Each must
  // block — these are the constructs a later round would otherwise slip in.
  const mutations = [
    [
      "a reusable-workflow call",
      (j) => (j.uses = "org/wf/.github/workflows/x.yml@main"),
    ],
    ["a container", (j) => (j.container = "node:20")],
    ["a matrix strategy", (j) => (j.strategy = { matrix: { shard: [1, 2] } })],
    ["an environment gate", (j) => (j.environment = "production")],
  ];
  for (const [label, mutate] of mutations) {
    for (const name of TRUSTED_JOBS.keys()) {
      const workflow = structuredClone(CI);
      mutate(workflow.jobs[name]);
      assert.notDeepEqual(
        jobBlockers(workflow, name, TRUSTED_JOBS),
        [],
        `jobBlockers accepts a \`${name}\` job with ${label}`,
      );
    }
  }
});

test("the `ci` sentinel still requires those jobs", () => {
  assert.deepEqual(
    sentinelBlockers(CI, TRUSTED_JOBS),
    [],
    "the `ci` sentinel would no longer turn a red trusted job into a red required check",
  );
});

test("the sentinel check rejects a workflow whose `ci` job stops gating", () => {
  // Mutation probes: the assertion above passes on the real workflow, which
  // proves nothing about what it REJECTS. Each clone in SENTINEL_MUTATIONS (in
  // the probes module, to keep this file under the line cap) breaks the sentinel
  // one way and must be caught, so a later edit that weakens the check fails.
  for (const [label, mutate] of SENTINEL_MUTATIONS) {
    const workflow = structuredClone(CI);
    mutate(workflow);
    assert.notDeepEqual(
      sentinelBlockers(workflow, TRUSTED_JOBS),
      [],
      `the sentinel check accepts a \`ci\` job with ${label}`,
    );
  }
});

test("ci.yml still runs on pull requests to main", () => {
  assert.deepEqual(
    triggerBlockers(CI),
    [],
    "ci.yml no longer runs on every pull request to main, so these jobs may not gate a merge",
  );
});

test("the trigger check rejects a `pull_request` trigger that can miss main", () => {
  const mutations = [
    [
      "`branches-ignore: [main]` in place of `branches: [main]`",
      (w) => {
        delete w.on.pull_request.branches;
        w.on.pull_request["branches-ignore"] = ["main"];
      },
    ],
    [
      "a `branches` list without main",
      (w) => (w.on.pull_request.branches = ["release/**"]),
    ],
    [
      "a negated `branches` entry that still lists main",
      (w) => (w.on.pull_request.branches = ["main", "!main"]),
    ],
    ["a path-scoped trigger", (w) => (w.on.pull_request.paths = ["src/**"])],
    [
      "`types` narrowed to `opened`",
      (w) => (w.on.pull_request.types = ["opened"]),
    ],
    ["no `pull_request` trigger at all", (w) => delete w.on.pull_request],
  ];
  for (const [label, mutate] of mutations) {
    const workflow = structuredClone(CI);
    mutate(workflow);
    assert.notDeepEqual(
      triggerBlockers(workflow),
      [],
      `the trigger check accepts ${label}`,
    );
  }
});

test("every Sentry suite is invoked directly by the ci.yml `scripts` job", () => {
  // Direct `node scripts/<suite>` (or `node --test …`), never `pnpm <alias>`.
  // The pnpm-run path is the one a `scriptShell` override or a `presentry:*:test`
  // lifecycle hook subvert (Codex 3754704267, 3754704278); a direct node command
  // is on neither knob's path, so requiring it closes both fail-opens.
  const missing = SENTRY_SUITES.filter(
    (file) => !RUN_BY_ANOTHER_JOB.has(file) && !suiteRunDirectly(CI, file),
  );
  const detail = missing
    .flatMap((file) =>
      nearMisses(CI, "scripts", suiteTargets(file)).map(
        (note) => `  ${file}: ${note}`,
      ),
    )
    .join("\n");
  assert.deepEqual(
    missing,
    [],
    `these Sentry suites are not invoked directly in CI: ${missing.join(", ")}.\n${detail}\n` +
      "Add a step to the `scripts` job in .github/workflows/ci.yml that runs " +
      "`node <suite>` as its whole command (not a pnpm alias), or add an entry " +
      "to RUN_BY_ANOTHER_JOB naming the job that does run it.",
  );
});

test("the checker rejects a Sentry step that reverts to a pnpm alias", () => {
  // A `scriptShell: /bin/true` (pnpm-workspace.yaml) makes `pnpm <alias>` exit 0
  // without running the suite; a `presentry:*:test` hook empties it before it
  // runs. Both act ONLY on the `pnpm run` path. So the coverage proof must
  // reject a step that runs a suite via its pnpm alias and accept only the
  // direct node command. Swap each suite's real step for its alias and assert
  // the suite reads as uncovered — the same predicate invariant 1 uses.
  let proven = 0;
  for (const file of SENTRY_SUITES) {
    if (RUN_BY_ANOTHER_JOB.has(file)) continue;
    const aliases = aliasesFor(PKG_SCRIPTS, file);
    if (aliases.length === 0) continue; // no alias form to revert to
    const directRuns = suiteTargets(file).map((target) => target.join(" "));
    const workflow = structuredClone(CI);
    const step = workflow.jobs.scripts.steps.find(
      (candidate) =>
        typeof candidate?.run === "string" &&
        directRuns.includes(candidate.run.trim()),
    );
    assert.ok(step, `no direct step found for ${file} to mutate`);
    step.run = `pnpm ${aliases[0]}`;
    assert.equal(
      suiteRunDirectly(workflow, file),
      false,
      `the checker still counts ${file} as covered after its step reverted to \`pnpm ${aliases[0]}\``,
    );
    proven += 1;
  }
  assert.ok(proven > 0, "no Sentry suite with an alias was available to probe");
});

test("a presentry lifecycle hook cannot empty a directly-invoked Sentry suite", () => {
  // `pnpm run sentry:ingest:test` fires `presentry:ingest:test` first, which a
  // malicious PR can point at `cp /dev/null <suite>` (Codex 3754704278). Because
  // the CI step runs `node scripts/sentry-triage-ingest.test.mjs` directly, no
  // lifecycle hook is on its path — and suiteRunDirectly reads that CI command,
  // never a package.json alias, so no `presentry:*:test` hook can change the
  // verdict. Prove the representative suite is covered by the direct command.
  const file = "scripts/sentry-triage-ingest.test.mjs";
  assert.ok(
    SENTRY_SUITES.includes(file),
    `${file} is gone — pick another representative suite`,
  );
  assert.ok(
    suiteRunDirectly(CI, file),
    `${file} is not invoked as a direct node command in the scripts job, so a ` +
      "presentry:*:test lifecycle hook could still empty it",
  );
});

test("the exemption for sentry-provider-contract still holds", () => {
  for (const [file, route] of RUN_BY_ANOTHER_JOB) {
    assert.ok(
      SENTRY_SUITES.includes(file),
      `RUN_BY_ANOTHER_JOB names ${file}, which no longer exists — drop the entry`,
    );
    assert.equal(
      file,
      "scripts/sentry-provider-contract.test.mjs",
      `unproven exemption for ${file} (${route}) — extend this test to re-prove its route`,
    );

    // Half one: tf-stacks.test.mjs really imports it.
    const imports = staticImports(join(SCRIPTS_DIR, "tf-stacks.test.mjs"));
    assert.ok(
      imports.includes("./sentry-provider-contract.test.mjs"),
      `${file} is exempted because tf-stacks.test.mjs imports it, but its static ` +
        `imports are ${JSON.stringify(imports)}`,
    );

    // Half two: an unconditional job really runs tf-stacks.test.mjs.
    const owner = "production-infra-contract";
    const targets = invocationsOf(PKG_SCRIPTS, "scripts/tf-stacks.test.mjs");
    assert.ok(
      targets.length > 2,
      "no package.json alias resolves to scripts/tf-stacks.test.mjs, so `pnpm tf:test` proves nothing",
    );
    const commands = provenCommands(CI, owner);
    assert.ok(
      targets.some((target) => runsCommand(commands, target)),
      `${file} is exempted because the \`${owner}\` job runs tf-stacks.test.mjs, but no ` +
        `step there does: ${nearMisses(CI, owner, targets).join("; ") || "no step mentions it"}`,
    );
  }
});

test("every sentry:*:test script resolves to an enumerated suite", () => {
  const aliases = Object.keys(PKG_SCRIPTS).filter(
    (name) => name.startsWith("sentry:") && name.endsWith(":test"),
  );
  assert.ok(
    aliases.length > 0,
    "no sentry:*:test scripts found in package.json",
  );

  const unresolved = aliases.filter(
    (alias) =>
      !SENTRY_SUITES.some((file) =>
        aliasesFor(PKG_SCRIPTS, file).includes(alias),
      ),
  );
  assert.deepEqual(
    unresolved,
    [],
    "these sentry:*:test scripts do not run a scripts/sentry-*.test.mjs file as " +
      `their whole command, so the CI-coverage assertion above cannot see them: ${unresolved.join(", ")}`,
  );
});

test("the local gate's tooling allowlist trusts every sentry:* script", () => {
  const sentryScripts = Object.keys(PKG_SCRIPTS)
    .filter((name) => name.startsWith("sentry:"))
    .sort();

  // Two controls prove the probe is live before its verdicts are believed. A
  // silent probe would pass this test by classifying nothing.
  const trustedControl = "/scripts/tf:test";
  const untrustedControl = "/scripts/__not_an_allowlisted_alias__";
  const verdicts = gateClassifications([
    trustedControl,
    untrustedControl,
    ...sentryScripts.map((name) => `/scripts/${name}`),
  ]);
  assert.equal(
    verdicts.get(trustedControl),
    "root-tooling-scripts",
    "the allowlist probe cannot reproduce a known-trusted alias — the probe is broken, not the allowlist",
  );
  assert.equal(
    verdicts.get(untrustedControl),
    "package-scripts",
    "the allowlist probe trusts an alias that is not listed — it is matching the wrong `case` arm",
  );

  const missing = sentryScripts.filter(
    (name) => verdicts.get(`/scripts/${name}`) !== "root-tooling-scripts",
  );
  assert.deepEqual(
    missing,
    [],
    "classify_root_package_json_changes in scripts/agent-quality-gate.sh does " +
      `not list: ${missing.join(", ")}. Without the entry, a package.json edit ` +
      "touching only that script classifies as `package-scripts` instead of " +
      "`root-tooling-scripts` — conservative, but drift.",
  );
});

test("every sentry:* script the gate trusts is pinned to an exact command", () => {
  // Allowlisting an alias TRUSTS it: `agent:quality-gate --run` will execute it
  // without `--allow-package-script-changes`. That trust is only safe while
  // check-agent-quality-gate-package-scripts.sh pins the alias to an exact
  // command — otherwise appending `&& <anything>` to a trusted script runs it.
  // The two lists drifted apart before this assertion existed: 13 aliases were
  // trusted and 4 pinned.
  const sentryScripts = Object.keys(PKG_SCRIPTS)
    .filter((name) => name.startsWith("sentry:"))
    .sort();
  const pins = validatorPins();

  // The probe reads the validator's own report. If its message format changed,
  // this control fails instead of every pin silently reading as absent.
  assert.equal(
    pins.get("tf:test"),
    "node scripts/tf-stacks.test.mjs",
    `the pin probe could not read ${VALIDATOR_PATH}'s report (${pins.size} pins parsed) — ` +
      "the probe is broken, not the pins",
  );

  const unpinned = sentryScripts.filter((name) => !pins.has(name));
  assert.deepEqual(
    unpinned,
    [],
    "these sentry:* scripts are trusted by classify_root_package_json_changes " +
      "but not pinned to an exact command in " +
      `check-agent-quality-gate-package-scripts.sh: ${unpinned.join(", ")}. ` +
      "A trusted alias whose command is not pinned can gain an appended " +
      "command that the gate then runs unprompted.",
  );

  // The validator itself is not wired into CI — only into the local gate — so
  // the sentry subset is re-checked here.
  const drifted = sentryScripts.filter(
    (name) => pins.get(name) !== PKG_SCRIPTS[name],
  );
  assert.deepEqual(
    drifted,
    [],
    `these sentry:* scripts no longer match their pin: ${drifted
      .map(
        (name) =>
          `${name} is ${JSON.stringify(PKG_SCRIPTS[name])}, pinned as ${JSON.stringify(pins.get(name))}`,
      )
      .join("; ")}`,
  );
});

test("the `scripts` job stays reachable from the paths its suites guard", () => {
  assert.deepEqual(
    requiredPathsMissing(
      CI,
      "scripts",
      TRUSTED_JOBS.get("scripts"),
      REQUIRED_ROOT_SCRIPT_PATHS,
    ),
    [],
    "the paths filter behind the `scripts` job no longer covers every input its " +
      "suites read, so a PR touching only those files skips the job and every " +
      "Sentry suite in it",
  );
});

test("the reachability check rejects dropping the guard producer from `needs`", () => {
  // Removing `jobs.scripts.needs: changes` while the `if:
  // needs.changes.outputs.rootScripts == 'true'` guard stays leaves the
  // `needs.changes` context empty, so the guard is never true and the job skips
  // on every PR — and the sentinel lists `scripts` under `allowed-skips`, so
  // nothing reports it. jobBlockers and sentinelBlockers stay green; only the
  // needs-edge proof catches it.
  const workflow = structuredClone(CI);
  delete workflow.jobs.scripts.needs;
  assert.notDeepEqual(
    requiredPathsMissing(
      workflow,
      "scripts",
      TRUSTED_JOBS.get("scripts"),
      REQUIRED_ROOT_SCRIPT_PATHS,
    ),
    [],
    "the reachability check accepts a `scripts` job that no longer needs `changes`",
  );
});

test("the required paths route every file this check reads", () => {
  // The gap this closes was invisible from either side alone: the check reads
  // two `.sh` files as probes, the filter routed only `.mjs`, and the `ci`
  // sentinel lists `scripts` under `allowed-skips` — so a PR editing only the
  // gate's allowlist or the pin validator skipped the job that would have
  // caught it, and no check reported a thing.
  const unrouted = [...PROBE_INPUTS].filter(
    ([path]) =>
      !REQUIRED_ROOT_SCRIPT_PATHS.some((glob) => globToRegExp(glob).test(path)),
  );
  assert.deepEqual(
    unrouted.map(([path]) => path),
    [],
    "REQUIRED_ROOT_SCRIPT_PATHS does not route " +
      unrouted.map(([path, reader]) => `${path} (${reader})`).join(", ") +
      " — an edit to one of those files would skip the `scripts` job, and the " +
      "`ci` sentinel allows that skip",
  );
});

test("the reachability check rejects a filter that drops a required path", () => {
  // Mutation probes on a cloned workflow. The first is the one that matters:
  // the gate and the pin validator are `.sh`, so without `scripts/**/*.sh` in
  // the filter a PR editing only those files skips the `scripts` job — and the
  // `ci` sentinel allows that skip, so nothing reports it.
  for (const required of REQUIRED_ROOT_SCRIPT_PATHS) {
    const workflow = structuredClone(CI);
    assert.ok(
      dropFilterPath(workflow, required) > 0,
      `no paths filter in ci.yml lists \`${required}\`, so this probe would prove nothing`,
    );
    assert.deepEqual(
      requiredPathsMissing(
        workflow,
        "scripts",
        TRUSTED_JOBS.get("scripts"),
        REQUIRED_ROOT_SCRIPT_PATHS,
      ),
      [required],
      `the reachability check accepts a filter with \`${required}\` removed`,
    );
  }

  // The chain itself must fail closed, not just the final list comparison.
  const chainMutations = [
    [
      "a filter step that can be skipped",
      (w) => {
        for (const job of Object.values(w.jobs)) {
          for (const step of job.steps ?? []) {
            if (String(step.uses ?? "").startsWith("dorny/paths-filter@")) {
              step.if = "false";
            }
          }
        }
      },
    ],
    [
      "a filter step passing `base:` alongside `filters:`",
      (w) => {
        for (const job of Object.values(w.jobs)) {
          for (const step of job.steps ?? []) {
            if (String(step.uses ?? "").startsWith("dorny/paths-filter@")) {
              step.with.base = "HEAD";
            }
          }
        }
      },
    ],
    [
      "a negated glob that cancels a required path it still lists",
      // dorny/paths-filter honours `!` negation, so `!scripts/**` cancels the
      // required `scripts/**/*.mjs`/`.sh` entries while they stay literally
      // present — a PR touching only scripts/ then skips the job.
      (w) => {
        let added = 0;
        for (const job of Object.values(w.jobs)) {
          for (const step of job.steps ?? []) {
            if (!String(step.uses ?? "").startsWith("dorny/paths-filter@")) {
              continue;
            }
            const filters = load(step.with.filters, { schema: CORE_SCHEMA });
            if (Array.isArray(filters.rootScripts)) {
              filters.rootScripts.push("!scripts/**");
              added += 1;
            }
            step.with.filters = dump(filters);
          }
        }
        assert.ok(
          added > 0,
          "no `rootScripts` filter to negate — probe is inert",
        );
      },
    ],
  ];
  for (const [label, mutate] of chainMutations) {
    const workflow = structuredClone(CI);
    mutate(workflow);
    assert.notDeepEqual(
      requiredPathsMissing(
        workflow,
        "scripts",
        TRUSTED_JOBS.get("scripts"),
        REQUIRED_ROOT_SCRIPT_PATHS,
      ),
      [],
      `the reachability check accepts ${label}`,
    );
  }
});

test("an alias resolves a suite only when it runs that suite alone", () => {
  // Synthetic input, no repo file: a package script is run WITHOUT `-e`, so
  // `node scripts/x.test.mjs\ntrue` exits 0 whatever the suite did. Accepting
  // it would let a green `pnpm <alias>` step in CI prove nothing.
  const targets = suiteTargets("scripts/x.test.mjs");
  const accepted = [
    "node scripts/x.test.mjs",
    "node --test scripts/x.test.mjs",
  ];
  const rejected = [
    "node scripts/x.test.mjs\ntrue",
    "true\nnode scripts/x.test.mjs",
    "node scripts/x.test.mjs && true",
    "node scripts/x.test.mjs || true",
    "node scripts/x.test.mjs --test-name-pattern=nothing",
    "echo scripts/x.test.mjs",
    "node scripts/y.test.mjs",
    "",
    42,
  ];
  for (const command of accepted) {
    assert.equal(
      commandRunsOnly(command, targets),
      true,
      `commandRunsOnly rejected \`${command}\`, which runs the suite as its whole script`,
    );
  }
  for (const command of rejected) {
    assert.equal(
      commandRunsOnly(command, targets),
      false,
      `commandRunsOnly accepted ${JSON.stringify(command)}, which does not run the suite as its whole script`,
    );
  }
});

test("this check itself runs in the ci.yml `scripts` job", () => {
  // Without this, the meta-check could be dropped from CI and every invariant
  // above would go quiet.
  const commands = provenCommands(CI, "scripts");
  assert.ok(
    runsCommand(commands, ["node", SELF]),
    `the \`scripts\` job must run \`node ${SELF}\` as a whole step command: ` +
      `${nearMisses(CI, "scripts", [["node", SELF]]).join("; ") || "no step mentions it"}`,
  );
});

test("a step proves a suite only when the suite is its whole command", () => {
  // provenCommands must reject a step whose body runs more than the target: a
  // sibling bare-word line can rebind it without being a shell keyword —
  // `cd <dir>` moves the working directory, `PATH=`/`hash` shadows the binary,
  // `cp /dev/null <suite>` truncates the suite file before `node` reads it — and
  // `runsCommand` would otherwise match the direct command sitting among them.
  // All are shellcheck-clean, so only the exactly-one-command rule catches them.
  const anchor = "node scripts/sentry-triage-ingest.test.mjs";
  const bodies = [
    `cd ui-dashboard\n${anchor}`,
    `hash -p /bin/true node\n${anchor}`,
    `PATH=/tmp/shim:/usr/bin\n${anchor}`,
    `cp /dev/null scripts/sentry-triage-ingest.test.mjs\n${anchor}`,
  ];
  for (const body of bodies) {
    const workflow = structuredClone(CI);
    const step = workflow.jobs.scripts.steps.find(
      (candidate) => candidate.run === anchor,
    );
    assert.ok(
      step,
      `anchor step \`${anchor}\` is gone — this probe would prove nothing`,
    );
    step.run = body;
    assert.equal(
      runsCommand(provenCommands(workflow, "scripts"), [
        "node",
        "scripts/sentry-triage-ingest.test.mjs",
      ]),
      false,
      `provenCommands accepted a step whose body is ${JSON.stringify(body)}`,
    );
  }
});

test("a trusted job may not mutate the runner environment for later steps", () => {
  // A `>> $GITHUB_ENV` / `>> $GITHUB_PATH` write reaches every later step with
  // the same force as a job-level `env:` — which this file rejects — but
  // imperative and unparsable, so the declarative `env:` checks never see it.
  // Both trusted jobs, and the local composite actions they pull in, must be
  // clean today, and the blocker must reject each vector.
  for (const name of TRUSTED_JOBS.keys()) {
    const job = CI.jobs[name];
    assert.deepEqual(
      envMutationBlockers(job.steps, `\`${name}\``),
      [],
      `the \`${name}\` job already writes the runner environment`,
    );
    const composites = collectCompositeActions(job);
    assert.deepEqual(
      envMutationBlockers(composites.steps, `\`${name}\` composite step`),
      [],
      `a local composite action used by \`${name}\` writes the runner environment`,
    );
    // Every local action the trusted job pulls in must be an analyzable
    // composite; a JS/Docker action would carry an unreadable env-write vector.
    assert.deepEqual(
      composites.blockers,
      [],
      `\`${name}\` pulls in a local action this scan cannot prove safe`,
    );
  }

  // jobBlockers folds the scan in, so a direct env-file write is caught end to
  // end, and the composite scan rejects the self-concealing variant that leaves
  // ci.yml untouched.
  const vectors = [
    {
      name: "$GITHUB_ENV NODE_OPTIONS injection",
      run: 'echo "NODE_OPTIONS=--import=./evil.mjs" >> "$GITHUB_ENV"',
    },
    {
      name: "$GITHUB_PATH shim",
      run: 'echo "$RUNNER_TEMP/shim" >> "$GITHUB_PATH"',
    },
  ];
  for (const vector of vectors) {
    const workflow = structuredClone(CI);
    workflow.jobs.scripts.steps.splice(2, 0, vector);
    assert.notDeepEqual(
      jobBlockers(workflow, "scripts", TRUSTED_JOBS),
      [],
      `jobBlockers accepts a \`scripts\` job with a ${vector.name} step`,
    );
    // The same write inside a composite action must also be caught.
    assert.notDeepEqual(
      envMutationBlockers([vector], "composite"),
      [],
      `envMutationBlockers accepts a composite ${vector.name} step`,
    );
  }
});

test("the composite scan recurses nested actions and rejects non-composite ones", () => {
  // A one-level scan is bypassed by a composite that itself `uses:` another
  // local composite (the env write hides one action deeper), and a metadata-only
  // scan is bypassed by a JavaScript/Docker action whose entrypoint code writes
  // `$GITHUB_ENV` with no `run:` for the scan to read. The fixture — job →
  // level1 → level2 — exercises both on disk without giving a real repo action a
  // nested child to protect.
  const { base, job, write, cleanup } = compositeFixture();
  try {
    // Control: a clean composite leaf yields no env write, no blocker, and both
    // action.yml files reported.
    write(".github/actions/level2/action.yml", {
      name: "level2",
      runs: {
        using: "composite",
        steps: [{ run: "echo hello", shell: "bash" }],
      },
    });
    const clean = collectCompositeActions(job, base);
    assert.deepEqual(
      envMutationBlockers(clean.steps, "nested composite"),
      [],
      "the recursion invented an env write that the clean leaf never made",
    );
    assert.deepEqual(
      clean.blockers,
      [],
      "a clean composite chain produced a blocker",
    );
    assert.deepEqual(
      clean.files.sort(),
      [
        ".github/actions/level1/action.yml",
        ".github/actions/level2/action.yml",
      ],
      "the recursion did not report every action.yml it opened",
    );

    // A `$GITHUB_ENV` write two composites deep must be caught.
    write(".github/actions/level2/action.yml", {
      name: "level2",
      runs: {
        using: "composite",
        steps: [
          {
            run: 'echo "NODE_OPTIONS=--import=./evil.mjs" >> "$GITHUB_ENV"',
            shell: "bash",
          },
        ],
      },
    });
    assert.notDeepEqual(
      envMutationBlockers(
        collectCompositeActions(job, base).steps,
        "nested composite",
      ),
      [],
      "a $GITHUB_ENV write two composites deep escaped the recursive scan",
    );

    // A non-composite leaf (JS or Docker) cannot be statically analyzed for env
    // writes, so the scan must reject it outright rather than silently accept an
    // absent `runs.steps`.
    for (const using of ["node20", "docker"]) {
      write(".github/actions/level2/action.yml", {
        name: "level2",
        runs: { using, main: "index.js" },
      });
      assert.notDeepEqual(
        collectCompositeActions(job, base).blockers,
        [],
        `the composite scan accepts a \`using: ${using}\` local action`,
      );
    }
  } finally {
    cleanup();
  }
});

test("the required `ci` check-run name is owned by exactly the sentinel", () => {
  const owner = ".github/workflows/ci.yml#ci";
  assert.deepEqual(
    contextOwnershipBlockers(WORKFLOWS, "ci", owner),
    [],
    "the `ci` check-run name is not uniquely owned by the ci.yml sentinel",
  );

  // A decoy job named `ci` in any other workflow satisfies the required context
  // with a green check while the real aggregator stops being required.
  const decoy = {
    path: ".github/workflows/decoy.yml",
    workflow: {
      on: { pull_request: { branches: ["main"] } },
      jobs: { sentinel: { name: "ci", "runs-on": "ubuntu-latest", steps: [] } },
    },
  };
  assert.notDeepEqual(
    contextOwnershipBlockers([...WORKFLOWS, decoy], "ci", owner),
    [],
    "the ownership check accepts a second job publishing the `ci` check-run name",
  );

  // A decoy whose `name:` is a `${{ }}` expression that could evaluate to `ci`
  // must fail too: this scan cannot evaluate it, so it cannot prove the job is
  // not a second owner of the required context.
  const dynamicDecoy = {
    path: ".github/workflows/dynamic.yml",
    workflow: {
      on: { pull_request: { branches: ["main"] } },
      jobs: {
        sentinel: {
          name: "${{ 'ci' }}",
          "runs-on": "ubuntu-latest",
          steps: [],
        },
      },
    },
  };
  assert.notDeepEqual(
    contextOwnershipBlockers([...WORKFLOWS, dynamicDecoy], "ci", owner),
    [],
    "the ownership check accepts a job whose `${{ }}` name could evaluate to `ci`",
  );

  // Renaming the real sentinel's key so no job owns the name must also fail.
  const orphaned = WORKFLOWS.map(({ path, workflow }) =>
    path === ".github/workflows/ci.yml"
      ? {
          path,
          workflow: {
            ...workflow,
            jobs: Object.fromEntries(
              Object.entries(workflow.jobs).map(([key, job]) =>
                key === "ci"
                  ? [key, { ...job, name: "ci-aggregate" }]
                  : [key, job],
              ),
            ),
          },
        }
      : { path, workflow },
  );
  assert.notDeepEqual(
    contextOwnershipBlockers(orphaned, "ci", owner),
    [],
    "the ownership check accepts a workflow set where no job owns the `ci` name",
  );
});

test("the suite enumeration walks symlinked directories", () => {
  // A Dirent for a symlink-to-dir reports isDirectory()===false, so a naive
  // walk would neither recurse into it nor record it, dropping any suite behind
  // it from the required set. The enumeration resolves the symlink; this proves
  // it, on a synthetic tree so no repo file is touched.
  const base = mkdtempSync(join(tmpdir(), "sentry-symlink-probe-"));
  try {
    const scripts = join(base, "scripts");
    const real = join(scripts, "real-dir");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "sentry-hidden.test.mjs"), "// suite\n");
    writeFileSync(join(scripts, "sentry-visible.test.mjs"), "// suite\n");
    symlinkSync(real, join(scripts, "linked-dir"));

    const found = findSentrySuites(scripts);
    assert.ok(
      found.includes("scripts/linked-dir/sentry-hidden.test.mjs"),
      `a suite behind a symlinked directory was not enumerated: ${JSON.stringify(found)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the checker's own files stay under the file-size hard cap", () => {
  // Round 9's split drifted back over the 1,000-line cap because nothing
  // machine-enforced it: the root ESLint config sets no `max-lines`, and the
  // file-size watchlist scopes the package `src/` trees, not scripts/. Lock the
  // checker's own modules here, reusing the watchlist's own line counter, so a
  // future round cannot quietly regrow one past the cap.
  const files = [
    CORE,
    SELF,
    "scripts/check-sentry-suites-in-ci-core-commands.mjs",
    "scripts/check-sentry-suites-in-ci-probes.mjs",
  ];
  const over = files
    .map((file) => ({
      file,
      lines: countLines(readFileSync(join(ROOT, file), "utf8")).raw,
    }))
    .filter(({ lines }) => lines >= HARD_CAP);
  assert.deepEqual(
    over,
    [],
    `these checker files crossed the ${HARD_CAP}-line hard cap; split them into ` +
      `a focused sibling module: ${JSON.stringify(over)}`,
  );
});

#!/usr/bin/env node
/**
 * Structural assertion: the machinery that runs the Sentry suites in CI is
 * still wired, and still reaches the merge gate.
 *
 * Issue #1721: eight `sentry:*:test` scripts — roughly 400 assertions — were
 * enforced by the pre-push hook alone, so a contributor who bypassed the hook
 * could merge a regression against a fully green required check. This file was
 * written to prove from configuration text that CI *would* run them.
 *
 * Issue #1779 replaced that claim with a stronger one: the unconditional
 * `sentry-suites` job RUNS the suites and proves from their own output that
 * each asserted (ADR 0062). What a runtime gate cannot prove is its own
 * existence — delete the job and every check in the repository stays green — so
 * this file now carries the three things the gate cannot see:
 *
 *   1. The `sentry-suites` job is intact, unconditional, shaped exactly as
 *      ADR 0062 requires, and its result reaches the required `ci` context
 *      (check-sentry-suites-in-ci-gate-job.test.mjs, and the sentinel, trigger
 *      and check-run-ownership assertions here).
 *   2. The one suite the gate does not run — sentry-provider-contract, reached
 *      by import from tf-stacks.test.mjs — really is run by an unconditional
 *      job, and that job is trustworthy.
 *   3. The local gate's tooling allowlist in scripts/agent-quality-gate.sh
 *      lists every `sentry:*` script, and every listed script is pinned to an
 *      exact command by check-agent-quality-gate-package-scripts.sh. The local
 *      gate runs the `pnpm sentry:*:test` aliases (developer convenience, with
 *      the CI gate as the backstop); the allowlist grants that trust and the
 *      pin is what makes it safe.
 *
 * PR C of #1779 relocated this file from the path-gated `scripts` job into
 * `sentry-suites`, which never skips — a dashboard-only, indexer-only or
 * non-Markdown doc-asset diff used to skip it entirely, measured against the
 * real filter — and retired the assertions the runtime gate subsumes: that every
 * suite has a direct `node <suite>` step, and the whole `rootScripts` filter
 * reachability proof that only mattered while this ran behind a filter.
 *
 * EVERY assertion reads a parsed structure. Six review rounds against the
 * text-matching version of this file found the same defect in a new place each
 * time — a commented-out step, a commented-out import, an `echo` naming a
 * suite, an `if: false`, a `|| true`. Each is invisible to a parser and each
 * defeated a substring search. So:
 *
 *   ci.yml               js-yaml, then walked as objects
 *   `run:` commands      tokenized against a plain-word grammar and matched
 *                        whole, never by prefix
 *   tf-stacks.test.mjs   V8's own parser (vm.SourceTextModule) reports the
 *                        static import list, with nothing executed
 *   the gate allowlist   bash evaluates its own `case` statement
 *   the validator pins   the validator reports them itself
 *
 * An unparsable ci.yml throws here, and that is correct.
 *
 * The predicates live in scripts/check-sentry-suites-in-ci-core.mjs and take
 * the structure they judge as an argument rather than reading a module-level
 * constant, so each one is exercised twice: once against the real ci.yml, and
 * once against a `structuredClone` of it with a single field broken. A check
 * that passes on the real workflow has proven only that it accepts; the
 * mutation probes are what prove it rejects. This file owns the file reads, the
 * external-process probes, the repo-specific constants, and every `test()`.
 *
 * Run: `node scripts/check-sentry-suites-in-ci.test.mjs`
 * CI:  .github/workflows/ci.yml  (sentry-suites job)
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
import {
  contextOwnershipBlockers,
  envMutationBlockers,
  jobBlockers,
  provenCommands,
  runsCommand,
  sentinelBlockers,
  triggerBlockers,
  workflowBlockers,
} from "./check-sentry-suites-in-ci-core.mjs";
import { countLines, HARD_CAP } from "./repo-health/file-size-watchlist.mjs";
// The execution-surface invariants (pin/hook ordering, lifecycle-hook rejection,
// escaping-symlink rejection) live in a sibling module to keep both files under
// the line cap. Importing it registers its `test()`s in this run, so the single
// `node scripts/check-sentry-suites-in-ci.test.mjs` CI step runs them too.
import "./check-sentry-suites-in-ci-lifecycle.test.mjs";
// The structural pin on the unconditional `sentry-suites` gate job (ADR 0062),
// for the same reason: the runtime gate cannot detect its own deletion, so the
// static checker carries it, and importing it registers those `test()`s here.
import "./check-sentry-suites-in-ci-gate-job.test.mjs";
// The suite-coverage and package-script contracts (#1803 split): every suite is
// RUN, by a direct `node <suite>` rather than a subvertible pnpm alias, plus the
// exemption route and the gate's allowlist and pins.
import "./check-sentry-suites-in-ci-coverage.test.mjs";
// The gate-routing probe's own invariants, split out for the same reason: how
// the classifier is lifted out, and how it is re-run once lifted.
import "./check-sentry-suites-in-ci-gate-extract.test.mjs";
import "./check-sentry-suites-in-ci-gate-probe.test.mjs";
import {
  CI,
  collectCompositeActions,
  compositeFixture,
  CORE,
  findSentrySuites,
  ROOT,
  SELF,
  SENTINEL_MUTATIONS,
  SENTRY_SUITES,
  staticImports,
  TRUSTED_JOBS,
  WORKFLOWS,
} from "./check-sentry-suites-in-ci-probes.mjs";

// The file reads, external-process probes, and repo-specific constants live in
// check-sentry-suites-in-ci-probes.mjs; the predicates live in
// check-sentry-suites-in-ci-core.mjs (with the command grammar re-exported from
// -core-commands.mjs). This file owns every `test()` and the `structuredClone`
// mutation probes that prove each predicate rejects, not only accepts.

// ── invariants ───────────────────────────────────────────────────────────────

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

test("a step proves a suite only when the suite is its whole command", () => {
  // `provenCommands` is what proves the exempt suite's route — that
  // `production-infra-contract` really runs tf-stacks.test.mjs — so it must
  // reject a step whose body runs more than the target: a sibling bare-word line
  // can rebind it without being a shell keyword — `cd <dir>` moves the working
  // directory, `PATH=`/`hash` shadows the binary, `cp /dev/null <file>`
  // truncates the target before `node` reads it — and `runsCommand` would
  // otherwise match the command sitting among them. All are shellcheck-clean, so
  // only the exactly-one-command rule catches them.
  const anchor = "pnpm tf:test";
  const bodies = [
    `cd ui-dashboard\n${anchor}`,
    `hash -p /bin/true pnpm\n${anchor}`,
    `PATH=/tmp/shim:/usr/bin\n${anchor}`,
    `cp /dev/null scripts/tf-stacks.test.mjs\n${anchor}`,
  ];
  for (const body of bodies) {
    const workflow = structuredClone(CI);
    const step = workflow.jobs["production-infra-contract"].steps.find(
      (candidate) => candidate.run === anchor,
    );
    assert.ok(
      step,
      `anchor step \`${anchor}\` is gone — this probe would prove nothing`,
    );
    step.run = body;
    assert.equal(
      runsCommand(provenCommands(workflow, "production-infra-contract"), [
        "pnpm",
        "tf:test",
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
  // The trusted job, and the local composite actions it pulls in, must be clean
  // today, and the blocker must reject each vector. `production-infra-contract`
  // installs before it runs the exempt suite, so a write in that composite would
  // neuter the one suite the runtime gate does not run.
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
    for (const name of TRUSTED_JOBS.keys()) {
      const workflow = structuredClone(CI);
      workflow.jobs[name].steps.splice(1, 0, vector);
      assert.notDeepEqual(
        jobBlockers(workflow, name, TRUSTED_JOBS),
        [],
        `jobBlockers accepts a \`${name}\` job with a ${vector.name} step`,
      );
    }
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
    "scripts/check-sentry-suites-in-ci-gate-probe.mjs",
    "scripts/check-sentry-suites-in-ci-gate-probe.test.mjs",
    "scripts/check-sentry-suites-in-ci-gate-extract.mjs",
    "scripts/check-sentry-suites-in-ci-gate-extract.test.mjs",
    "scripts/check-sentry-suites-in-ci-gate-fixtures.mjs",
    "scripts/check-sentry-suites-in-ci-lifecycle.test.mjs",
    "scripts/check-sentry-suites-in-ci-gate-job.test.mjs",
    "scripts/check-sentry-suites-in-ci-coverage.test.mjs",
    "scripts/static-imports.mjs",
    // The runtime gate and its suites: unwatched, they grew to 833 and 935
    // lines with the cap unenforced — this check's own drift class, at home.
    "scripts/sentry-suite-gate.mjs",
    "scripts/sentry-suite-gate.test.mjs",
    "scripts/sentry-suite-gate-integrity.test.mjs",
    "scripts/sentry-suite-gate-integrity.mjs",
    "scripts/sentry-suite-gate-isolation.test.mjs",
    "scripts/sentry-suite-gate-manifest.mjs",
    "scripts/sentry-suite-gate-fixtures.mjs",
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

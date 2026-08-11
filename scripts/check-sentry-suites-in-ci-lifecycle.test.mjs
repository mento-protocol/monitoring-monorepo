/**
 * The execution-surface invariants behind scripts/check-sentry-suites-in-ci.test.mjs.
 *
 * pnpm has two lifecycle phases that run code the coverage checker's static scan
 * of ci.yml and package.json cannot see:
 *
 *   RUN     — a trusted `pnpm <alias>` step runs whatever its package.json
 *             command expands to, so a drifted alias runs an appended command.
 *   INSTALL — `pnpm install` runs the root lifecycle hooks (postinstall and
 *             friends), and pnpm auto-runs `pre<x>`/`post<x>` around a script.
 *
 * Both are closed by the pin validator (check-agent-quality-gate-package-scripts.sh)
 * running FIRST: it pins each trusted alias to an exact command and rejects any
 * unsanctioned lifecycle hook. These tests pin that ordering, prove the validator
 * rejects a hook, and reject a committed scripts/ directory symlink whose target
 * escapes the tree the CI paths-filter routes.
 *
 * The third execution surface is the gate probe itself. `gateClassifications`
 * lifts `classify_root_package_json_changes` out of agent-quality-gate.sh and
 * re-runs it, so the probe's own reading of that file is load-bearing: a wrong
 * span, an unstubbed helper, or a misparsed verdict line makes the allowlist
 * assertion in the main check pass while proving nothing. The fixtures below are
 * synthetic gate scripts, each shaped so the OLD textual terminator gets it
 * wrong, and the tests pin every one to a loud failure or a correct verdict.
 *
 * Split out of the main check to keep both files under the repo's 1,000-line cap;
 * the main test file imports this module, so `node
 * scripts/check-sentry-suites-in-ci.test.mjs` runs these too.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinValidationOrderBlockers } from "./check-sentry-suites-in-ci-core.mjs";
import {
  bashFunctionSource,
  CI,
  escapingScriptSymlinks,
  GATE_CLASSIFIER,
  gateClassifications,
  INSTALL_ACTION,
  PIN_VALIDATOR_COMMAND,
  PKG,
  runPackageScriptValidator,
  SCRIPTS_DIR,
  validatorPins,
} from "./check-sentry-suites-in-ci-probes.mjs";

// The set of aliases the validator pins is the set it trusts; the pin-order
// check flags any of them run before the validator. `validatorPins` reads the
// validator's own report, so a rename or a dropped pin changes this set too.
const TRUSTED_ALIASES = new Set(validatorPins().keys());
const VALIDATOR_RUN = PIN_VALIDATOR_COMMAND.join(" ");

test("the `scripts` job validates pins before pnpm-install and any trusted alias", () => {
  // The validator makes two surfaces safe only by running first: before
  // pnpm-install (so a root lifecycle hook is rejected before install runs it,
  // Codex 3754887736) and before any trusted `pnpm <alias>` step (so a drifted
  // alias is rejected before it runs an appended command, Codex 3754887737).
  assert.deepEqual(
    pinValidationOrderBlockers(
      CI,
      "scripts",
      PIN_VALIDATOR_COMMAND,
      TRUSTED_ALIASES,
      INSTALL_ACTION,
    ),
    [],
    "the `scripts` job runs pnpm-install or a trusted alias before the pin validator",
  );

  // Probe 1: drop the validator step entirely.
  const withoutValidator = structuredClone(CI);
  withoutValidator.jobs.scripts.steps =
    withoutValidator.jobs.scripts.steps.filter(
      (step) => step.run !== VALIDATOR_RUN,
    );
  assert.notDeepEqual(
    pinValidationOrderBlockers(
      withoutValidator,
      "scripts",
      PIN_VALIDATOR_COMMAND,
      TRUSTED_ALIASES,
      INSTALL_ACTION,
    ),
    [],
    "the order check accepts a `scripts` job with no pin validator step",
  );

  // Probe 2: move the validator to the end, after install and the aliases.
  const reordered = structuredClone(CI);
  const steps = reordered.jobs.scripts.steps;
  const at = steps.findIndex((step) => step.run === VALIDATOR_RUN);
  assert.ok(at >= 0, "pin validator step is gone — probe would prove nothing");
  const [validator] = steps.splice(at, 1);
  steps.push(validator);
  assert.notDeepEqual(
    pinValidationOrderBlockers(
      reordered,
      "scripts",
      PIN_VALIDATOR_COMMAND,
      TRUSTED_ALIASES,
      INSTALL_ACTION,
    ),
    [],
    "the order check accepts a validator that runs after pnpm-install and the aliases",
  );
});

test("the pin validator rejects an unsanctioned install lifecycle hook", () => {
  // The real manifest — its one sanctioned `postinstall` and no other hook —
  // must pass, or a clean tree would red the job.
  assert.ok(
    runPackageScriptValidator(PKG).ok,
    "the validator rejects the real, clean package.json",
  );

  // Each mutation adds or drifts a lifecycle hook that would run trusted code
  // outside the static scan; the validator, run before install, must reject it.
  const mutations = [
    ["preinstall", { ...PKG.scripts, preinstall: "node scripts/evil.mjs" }],
    ["postinstall", { ...PKG.scripts, postinstall: "node scripts/evil.mjs" }],
    [
      "presentry:ingest:test",
      { ...PKG.scripts, "presentry:ingest:test": "node scripts/evil.mjs" },
    ],
  ];
  for (const [label, scripts] of mutations) {
    assert.ok(
      !runPackageScriptValidator({ ...PKG, scripts }).ok,
      `the validator accepted a package.json with a \`${label}\` lifecycle hook`,
    );
  }
});

test("no committed scripts/ directory symlink escapes the CI-routed tree", () => {
  // A directory symlink under scripts/ pointing outside it exposes a suite whose
  // real path the static `rootScripts` filter cannot route, so the path-gated
  // `scripts` job would skip while the checker still demands the suite (Codex
  // 3754887739). None may exist.
  assert.deepEqual(
    escapingScriptSymlinks(SCRIPTS_DIR),
    [],
    "a committed scripts/ directory symlink resolves outside scripts/",
  );

  // Mutation: a synthetic tree with `scripts/linked -> ../fixtures` is flagged,
  // while a within-scripts link is not — proving the check rejects only the
  // escaping case, on fixtures so no repo file is touched.
  const base = mkdtempSync(join(tmpdir(), "sentry-escape-probe-"));
  try {
    const scripts = join(base, "scripts");
    const inside = join(scripts, "real-dir");
    const outside = join(base, "fixtures");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentry-hidden.test.mjs"), "// suite\n");
    symlinkSync(outside, join(scripts, "escaping"));
    symlinkSync(inside, join(scripts, "contained"));

    const escaping = escapingScriptSymlinks(scripts);
    assert.equal(
      escaping.length,
      1,
      `expected only the escaping link flagged, got ${JSON.stringify(escaping)}`,
    );
    assert.equal(escaping[0][0], "scripts/escaping");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const TRUSTED_PATH = "/scripts/agent:quality-gate";
const UNTRUSTED_PATH = "/scripts/__not_an_allowlisted_alias__";

/**
 * A synthetic agent-quality-gate.sh: a `json_change_paths` the probe stubs over,
 * one classifier with the real one's shape, and slots for the variations each
 * test needs. Built from one template so the difference under test is the only
 * difference in the file.
 */
const gateFixture = ({
  prelude = "",
  header = `${GATE_CLASSIFIER}() {`,
  inner = "",
  verdict = `  if [[ "$saw_tooling" == true ]]; then
    echo "root-tooling-scripts"
  else
    echo "package-scripts"
  fi`,
  closer = "}",
  trailer = 'root_package_json_class=""',
}) => `#!/usr/bin/env bash
set -euo pipefail

json_change_paths() {
  echo "__unknown__"
}
${prelude}
${header}
  local change
  local saw_tooling=false
  while IFS= read -r change; do
    [[ -n "$change" ]] || continue
    case "$change" in
      ${TRUSTED_PATH}) saw_tooling=true ;;
    esac
  done < <(json_change_paths "package.json")
${inner}
${verdict}
${closer}

${trailer}
`;

/**
 * The terminator this probe used to use: the first line that is exactly `}` at
 * column 0. Kept here, in the test rather than the probe, so each fixture below
 * has to prove it actually discriminates — a fixture the old rule reads
 * correctly would pin nothing.
 */
const legacyFunctionSource = (script) => {
  const header = `\n${GATE_CLASSIFIER}() {\n`;
  const start = script.indexOf(header);
  if (start < 0) return null;
  const rest = script.slice(start + 1);
  const end = rest.indexOf("\n}\n");
  return end > 0 ? rest.slice(0, end + 3) : null;
};

test("the gate-function extractor ends the function where bash ends it", () => {
  // Control: on the shape the gate has today the old rule was right, so any
  // difference below comes from the fixture, not from the two rules disagreeing
  // about ordinary text.
  const clean = gateFixture({});
  assert.equal(
    bashFunctionSource(clean, GATE_CLASSIFIER, "clean"),
    legacyFunctionSource(clean),
    "the extractor disagrees with the old terminator on a gate with nothing unusual in it",
  );

  // TRUNCATION. A heredoc whose content has `}` at column 0 ends the old span
  // inside the heredoc — a prefix of the function.
  const heredoc = gateFixture({
    // `:` rather than `cat`: the probe runs the classifier with an empty PATH,
    // so a heredoc has to be consumed by a builtin.
    inner: `  : <<'NOTE'
Reviewers keep proposing this shape. It is wrong:
}
NOTE`,
  });
  const heredocSource = bashFunctionSource(heredoc, GATE_CLASSIFIER, "heredoc");
  assert.ok(
    heredocSource.includes("\nNOTE\n"),
    `the extractor stopped inside the heredoc: ${JSON.stringify(heredocSource)}`,
  );
  assert.notEqual(
    heredocSource,
    legacyFunctionSource(heredoc),
    "the old terminator read the heredoc fixture correctly, so it pins nothing",
  );

  // OVER-CAPTURE. One trailing space on the closing brace and `\n}\n` skips it,
  // locking on to the next column-0 `}` — the function plus everything between.
  const trailing = gateFixture({
    closer: "} ",
    trailer: `echo "__after_the_function__"

later_helper() {
  :
}`,
  });
  const trailingSource = bashFunctionSource(
    trailing,
    GATE_CLASSIFIER,
    "trailing",
  );
  assert.ok(
    !trailingSource.includes("__after_the_function__"),
    `the extractor swallowed code that follows the function: ${JSON.stringify(trailingSource)}`,
  );
  assert.ok(
    legacyFunctionSource(trailing).includes("__after_the_function__"),
    "the old terminator read the trailing-space fixture correctly, so it pins nothing",
  );

  // The `function` keyword is a definition the old exact-string header missed
  // entirely, which read as "the function is gone" rather than as a variant.
  const keyword = gateFixture({
    header: `function ${GATE_CLASSIFIER}() {`,
  });
  assert.ok(
    bashFunctionSource(keyword, GATE_CLASSIFIER, "keyword").startsWith(
      `function ${GATE_CLASSIFIER}() {`,
    ),
    "the extractor cannot read a `function`-keyword definition",
  );
  assert.equal(
    legacyFunctionSource(keyword),
    null,
    "the old header string read the `function`-keyword fixture, so it pins nothing",
  );
});

test("the gate probe classifies a gate the old terminator could not read", () => {
  // The point of the two fixtures above is not that they fail loudly — it is
  // that the probe keeps WORKING on them. Both classify correctly.
  for (const [label, script] of [
    [
      "heredoc",
      gateFixture({
        inner: `  : <<'NOTE'
}
NOTE`,
      }),
    ],
    [
      "function keyword",
      gateFixture({ header: `function ${GATE_CLASSIFIER} {` }),
    ],
  ]) {
    const verdicts = gateClassifications([TRUSTED_PATH, UNTRUSTED_PATH], {
      script,
      label,
    });
    assert.deepEqual(
      [...verdicts],
      [
        [TRUSTED_PATH, "root-tooling-scripts"],
        [UNTRUSTED_PATH, "package-scripts"],
      ],
      `the probe misread the ${label} gate`,
    );
  }
});

/**
 * Every distinct bash on this machine, by resolved path. macOS ships 3.2 at
 * /bin/bash and contributors usually have a newer one earlier on PATH, so this
 * finds both; a runner with one bash yields one entry and the test still runs.
 */
const installedBashes = () => {
  const found = new Map();
  for (const candidate of ["bash", "/bin/bash"]) {
    const probe = spawnSync(
      candidate,
      [
        "-c",
        'printf "%s\\t%s.%s" "$BASH" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"',
      ],
      { encoding: "utf8" },
    );
    if (probe.error || probe.status !== 0) continue;
    const [path, version] = probe.stdout.split("\t");
    if (!found.has(path)) found.set(path, { candidate, version });
  }
  return [...found.entries()];
};

test("the gate probe runs on every bash installed, not just the newest", () => {
  // The gate supports bash 3.2 (docs/notes/agent-quality-gate-mechanics.md) and
  // routes edits to these scripts into itself, so a probe that needs bash 4 —
  // by refusing to run, or by leaning on `command_not_found_handle` alone —
  // stops a stock-macOS contributor from passing the required local gate. The
  // probe takes the interpreter as an argument precisely so this can be checked
  // rather than asserted in a comment.
  const bashes = installedBashes();
  assert.ok(
    bashes.length >= 1,
    "no usable bash found — this test would prove nothing",
  );
  for (const [path, { candidate, version }] of bashes) {
    const verdicts = gateClassifications([TRUSTED_PATH, UNTRUSTED_PATH], {
      script: gateFixture({}),
      label: `bash ${version} at ${path}`,
      bash: candidate,
    });
    assert.deepEqual(
      [...verdicts],
      [
        [TRUSTED_PATH, "root-tooling-scripts"],
        [UNTRUSTED_PATH, "package-scripts"],
      ],
      `the probe cannot classify under bash ${version} (${path})`,
    );

    // And the missing-command net has to hold there too, on the case that has
    // no `command_not_found_handle` behind it: an installed binary.
    assert.throws(
      () =>
        gateClassifications([TRUSTED_PATH], {
          script: gateFixture({ inner: `  cat /no/such/file 2> /dev/null` }),
          label: `bash ${version} at ${path}`,
          bash: candidate,
        }),
      /__probe_missing_command__ cat/,
      `bash ${version} (${path}) ran an installed binary without the probe noticing`,
    );
  }
});

test("the gate probe fails closed on a body it cannot fully provide for", () => {
  // A helper the probe does not stub runs as a missing command inside `$(…)`,
  // where the non-zero exit dies with the subshell: the old probe returned
  // `package-scripts` for an allowlisted alias and exited 0.
  const unstubbed = gateFixture({
    prelude: `tooling_alias_allowlist() {
  printf '%s\\n' "${TRUSTED_PATH}"
}`,
    // The verdict depends on the helper's output, so losing it flips an
    // allowlisted alias to `package-scripts` — the shape of a silent pass.
    inner: `  local allow=""
  allow="$(tooling_alias_allowlist)"
  if [[ "$allow" != *"agent:quality-gate"* ]]; then
    saw_tooling=false
  fi`,
  });
  assert.notEqual(
    legacyFunctionSource(unstubbed),
    null,
    "the unstubbed-helper fixture no longer parses — it would prove nothing",
  );
  assert.throws(
    () =>
      gateClassifications([TRUSTED_PATH], {
        script: unstubbed,
        label: "unstubbed helper",
      }),
    /tooling_alias_allowlist/,
    "the probe ran a gate helper it does not stub",
  );

  // An INSTALLED binary is the case `command_not_found_handle` never sees, and
  // `cat` failing on a missing file with its stderr redirected leaves no trace
  // at all: no handler, and bash's own `command not found` is written by the
  // failing command, so the redirection swallows it on every bash version. The
  // probe's empty PATH plus the DEBUG-trap guard is what reports it — before the
  // command runs, so before its redirections apply.
  assert.throws(
    () =>
      gateClassifications([TRUSTED_PATH], {
        script: gateFixture({ inner: `  cat /no/such/file 2> /dev/null` }),
        label: "installed binary",
      }),
    /__probe_missing_command__ cat/,
    "the probe ran an installed binary and reported a verdict anyway",
  );

  // A command that exists nowhere is caught by the same guard, and on bash >= 4
  // by `command_not_found_handle` as well.
  assert.throws(
    () =>
      gateClassifications([TRUSTED_PATH], {
        script: gateFixture({
          inner: `  __no_such_command_anywhere__ || true`,
        }),
        label: "missing binary",
      }),
    /__probe_missing_command__/,
    "the probe ran a command that does not exist and reported a verdict anyway",
  );
});

test("the gate probe fails closed on output it cannot account for", () => {
  // An arm that prints nothing used to land in the map as `""`, and a class the
  // probe does not know used to land as itself — both read as a verdict.
  assert.throws(
    () =>
      gateClassifications([TRUSTED_PATH, UNTRUSTED_PATH], {
        script: gateFixture({
          verdict: `  if [[ "$saw_tooling" == true ]]; then
    echo "root-tooling-scripts"
  fi`,
        }),
        label: "silent arm",
      }),
    /not one of its classes/,
    "the probe accepted an empty verdict",
  );
  assert.throws(
    () =>
      gateClassifications([UNTRUSTED_PATH], {
        script: gateFixture({
          verdict: `  echo "brand-new-class"`,
        }),
        label: "new class",
      }),
    /not one of its classes/,
    "the probe accepted a class it has never been told about",
  );

  // A nested redefinition is indented, so the old column-0 header string could
  // not see the second definition it warns about.
  const nested = gateFixture({
    trailer: `wrapper() {
  ${GATE_CLASSIFIER}() {
    echo "workspace"
  }
}`,
  });
  assert.notEqual(
    legacyFunctionSource(nested),
    null,
    "the nested-redefinition fixture no longer parses — it would prove nothing",
  );
  assert.throws(
    () =>
      gateClassifications([TRUSTED_PATH], { script: nested, label: "nested" }),
    /defines `classify_root_package_json_changes` 2 times/,
    "the probe picked one of two definitions of the classifier",
  );
});

test("the gate probe rejects a request it would have to misparse", () => {
  // The wire format is one tab-separated line per path. A path carrying a tab
  // used to split into a different path and a fabricated verdict, and the path
  // actually asked about came back `undefined`.
  for (const [label, request] of [
    ["a tab", [`/scripts/a\tb`]],
    ["a newline", [`/scripts/a\nb`]],
  ]) {
    assert.throws(
      () => gateClassifications(request),
      /carries a tab or newline/,
      `the probe accepted a path containing ${label}`,
    );
  }
  assert.throws(
    () => gateClassifications([TRUSTED_PATH, TRUSTED_PATH]),
    /duplicate path/,
    "the probe accepted a duplicate path, whose verdicts would collapse",
  );
  assert.throws(
    () => gateClassifications([]),
    /at least one path/,
    "the probe accepted an empty request, which would vacuously pass its caller",
  );
  assert.throws(
    () => gateClassifications([""]),
    /empty path/,
    "the probe accepted an empty path",
  );
});

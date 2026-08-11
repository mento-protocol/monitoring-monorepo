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
  existsSync,
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
  GATE,
  GATE_CLASSIFIER,
  gateClassifications,
  GATE_PATH,
  inputRedirections,
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

test("the gate probe sees through every wrapper a command can hide behind", () => {
  // The guard reads a command word, so anything that WRAPS the real command
  // hides it. `command`, `builtin` and `exec` are the whole set of bash command
  // modifiers; the other routes to a command re-enter the DEBUG trap on their
  // own, which is why unwrapping those three is a rule rather than a list that
  // grows. Each row is asserted on every installed bash, because two of them
  // behaved differently on 3.2 and 5.3 before this: `command cat` was caught on
  // 5.3 only, by `command_not_found_handle`, which 3.2 does not have.
  const hidden = [
    ["command", `  command cat /no/such/file 2> /dev/null`],
    ["exec in a subshell", `  ( exec cat /no/such/file 2> /dev/null )`],
    ["the time keyword", `  time cat /no/such/file 2> /dev/null`],
    ["eval", `  eval "cat /no/such/file 2> /dev/null"`],
    // Not a wrapper: `hash -p` binds a name straight to a path, so it defeats
    // the empty PATH and `command -v` at once. `set +h` is what closes it.
    [
      "hash -p",
      `  hash -p /bin/cat cat 2> /dev/null
  cat /no/such/file 2> /dev/null`,
    ],
  ];
  for (const [, { candidate, version }] of installedBashes()) {
    for (const [label, inner] of hidden) {
      assert.throws(
        () =>
          gateClassifications([TRUSTED_PATH], {
            script: gateFixture({ inner }),
            label: `${label} under bash ${version}`,
            bash: candidate,
          }),
        /__probe_missing_command__ cat/,
        `bash ${version} ran \`cat\` behind ${label} without the probe noticing`,
      );
    }

    // `builtin` hides the word the same way, but what it reaches is a builtin,
    // so nothing external runs and the probe must NOT red. This is the control:
    // without it, "reject anything wrapped" would pass every row above.
    assert.deepEqual(
      [
        ...gateClassifications([TRUSTED_PATH], {
          script: gateFixture({ inner: `  builtin :` }),
          label: `builtin under bash ${version}`,
          bash: candidate,
        }),
      ],
      [[TRUSTED_PATH, "root-tooling-scripts"]],
      `bash ${version} rejected \`builtin :\`, which runs nothing external`,
    );
  }
});

test("a construct that consumes the guard's report cannot bury it", () => {
  // The classifier reads a process substitution already — `done < <(…)` is how
  // the real one gets its change paths — so a second one around an unstubbed
  // helper is an ordinary edit, not a contrived one. It used to feed the guard's
  // marker straight into the loop as input and return a clean verdict on bash 4+,
  // where `command_not_found_handle` writes to the same swallowed stream. A
  // `$(…)` captures it the same way, and a pipeline sends it down the pipe.
  //
  // Two things stop that now: fd 9 is duplicated from the real stderr before the
  // classifier can touch it, and the guard takes the shell down with `kill`
  // against `$$`, which stays the invoking shell's pid inside either construct.
  const consuming = [
    [
      "a consumed process substitution",
      `  local ignored
  while IFS= read -r ignored; do :; done < <(__probe_absent_helper__)`,
    ],
    [
      "a command substitution",
      `  local captured
  captured="$(__probe_absent_helper__)"`,
    ],
    [
      "a pipeline",
      `  __probe_absent_helper__ | while IFS= read -r piped; do :; done`,
    ],
  ];
  for (const [, { candidate, version }] of installedBashes()) {
    for (const [label, inner] of consuming) {
      let message = "";
      assert.throws(
        () =>
          gateClassifications([TRUSTED_PATH], {
            script: gateFixture({ inner }),
            label: `${label} under bash ${version}`,
            bash: candidate,
          }),
        (error) => {
          message = error.message;
          return true;
        },
        `bash ${version} let ${label} bury the guard's report`,
      );
      // The name still has to reach the reader: burying it was the bug, and a
      // bare "killed by SIGTERM" would send the next reader hunting a probe bug.
      assert.match(
        message,
        /__probe_missing_command__ __probe_absent_helper__/,
        `bash ${version} lost the command name to ${label}`,
      );
    }
  }
});

test("the gate probe rejects `command -p`, which outruns its empty PATH", () => {
  // `-p` uses a default PATH "guaranteed to find all of the standard
  // utilities", so it reaches a binary whatever the probe sets `$PATH` to.
  // There is nothing to validate behind it — the escape is the invocation — so
  // it is rejected at read time, by the line, on every bash.
  for (const inner of [
    `  command -p cat /etc/passwd > /dev/null`,
    `  command -p cat /no/such/file 2> /dev/null`,
  ]) {
    for (const [, { candidate, version }] of installedBashes()) {
      assert.throws(
        () =>
          gateClassifications([TRUSTED_PATH], {
            script: gateFixture({ inner }),
            label: `command -p under bash ${version}`,
            bash: candidate,
          }),
        /runs `command -p`/,
        `bash ${version} accepted a classifier reaching a binary through \`command -p\``,
      );
    }
  }
});

test("the gate probe refuses an executable path and a classifier that fails", () => {
  for (const [, { candidate, version }] of installedBashes()) {
    // Everything the probe provides is a function or a builtin, and neither can
    // contain a slash, so a command word with one is an executable file that
    // never had to resolve through the empty PATH.
    assert.throws(
      () =>
        gateClassifications([TRUSTED_PATH], {
          script: gateFixture({ inner: `  /bin/cat /etc/passwd` }),
          label: `absolute path under bash ${version}`,
          bash: candidate,
        }),
      /__probe_missing_command__ \/bin\/cat/,
      `bash ${version} ran a binary named by absolute path without the probe noticing`,
    );

    // `printf … "$(classifier)"` reports PRINTF's status, so a classifier that
    // echoes a real class and then fails used to read as a clean run. A
    // classifier that fails has not classified anything, whatever it echoed.
    assert.throws(
      () =>
        gateClassifications([TRUSTED_PATH], {
          script: gateFixture({
            verdict: `  echo "root-tooling-scripts"
  return 42`,
          }),
          label: `non-zero return under bash ${version}`,
          bash: candidate,
        }),
      /returned non-zero/,
      `bash ${version} accepted a class from a classifier that then failed`,
    );
  }
});

test("the gate probe rejects a classifier that reads anything it did not supply", () => {
  // The verdict has to be a function of the synthetic change paths and nothing
  // else. A `read` from a file makes it a function of the machine — the drift
  // the stubbed-helper check exists to stop, arriving through a redirection
  // rather than a command, which is why that check never saw it.
  //
  // Checked by reading, not by watching. `$BASH_COMMAND` carries the redirection
  // for a SIMPLE command on both interpreters, but a compound's redirection is
  // absent: `while IFS= read -r l; do :; done < /etc/passwd` reports only
  // `IFS= read -r l`. That missing half is the shape the classifier's own loop
  // uses, so a run-time guard would be blind to exactly the wrong case.
  for (const inner of [
    `  local value
  IFS= read -r value < /etc/passwd`,
    `  local l
  while IFS= read -r l; do :; done < /etc/passwd`,
  ]) {
    assert.throws(
      () =>
        gateClassifications([TRUSTED_PATH], {
          script: gateFixture({ inner }),
          label: "file read",
        }),
      /reads something the probe did not supply/,
      "the probe let the classifier's verdict depend on a file",
    );
  }

  // The case most likely to break: the real gate's own loop takes its input
  // from a process substitution, and heredocs read text out of the script
  // itself. Both must stay accepted, or this check reds every honest gate.
  assert.deepEqual(
    inputRedirections(bashFunctionSource(GATE, GATE_CLASSIFIER, GATE_PATH)),
    [],
    "the real gate's `done < <(json_change_paths …)` is being read as an outside read",
  );
  for (const inner of [
    `  local extra
  while IFS= read -r extra; do :; done < <(json_change_paths "package.json")`,
    `  : <<'NOTE'
inline text, read out of the script itself
NOTE`,
    `  local here
  here="$(cat <<<"inline")"`,
  ]) {
    assert.deepEqual(
      inputRedirections(`f() {\n${inner}\n}\n`),
      [],
      `a legitimate inline read was rejected: ${JSON.stringify(inner)}`,
    );
  }
});

test("a restricted-mode refusal explains itself, not just what bash said", () => {
  // `cmd > /dev/null` is the everyday idiom, and restricted mode is the probe's
  // own choice, so the person who adds one to the classifier years from now
  // meets a message they did not cause. Bash says `restricted: cannot redirect
  // output` and stops there, which reads as a broken probe and sends them to
  // the wrong file. These assertions pin the explanation so it cannot rot back
  // into the bare bash text.
  for (const [, { candidate, version }] of installedBashes()) {
    let message = "";
    assert.throws(
      () =>
        gateClassifications([TRUSTED_PATH], {
          script: gateFixture({ inner: `  builtin echo probing > /dev/null` }),
          label: `redirecting classifier under bash ${version}`,
          bash: candidate,
        }),
      (error) => {
        message = error.message;
        return true;
      },
    );

    // The raw diagnostic stays: it is the only thing that locates the line.
    assert.match(
      message,
      /restricted: cannot redirect output/,
      `bash ${version} lost the diagnostic that locates the offending line`,
    );
    // Whose choice it was, why, and what to do about it.
    assert.match(
      message,
      /deliberate, and it is this probe's doing/,
      `bash ${version} left the reader to guess whether the probe is broken`,
    );
    assert.match(
      message,
      /set -r/,
      `bash ${version} did not name the mechanism doing the refusing`,
    );
    assert.match(
      message,
      /move the redirection out of the classifier/,
      `bash ${version} did not say what to do about it`,
    );
  }
});

test("the gate probe will not carry a trailer off the closing brace", () => {
  // `}; printf owned > file` ends the function AND starts a top-level command
  // on the same line. Slicing whole lines put that command inside the extracted
  // source, where both the scan and the probe ran it. The span now ends at the
  // closing brace's column, and the scan sources its candidates restricted, so
  // the trailer neither lands in the span nor runs while the span is found.
  const owned = join(
    mkdtempSync(join(tmpdir(), "gate-probe-trailer-")),
    "owned.txt",
  );
  try {
    const script = gateFixture({ closer: `}; printf owned > ${owned}` });
    const extracted = bashFunctionSource(script, GATE_CLASSIFIER, "trailer");
    assert.ok(
      !extracted.includes("owned"),
      `the extracted span carried the trailer with it: ${JSON.stringify(extracted.split("\n").at(-2))}`,
    );
    assert.ok(
      !existsSync(owned),
      "finding the end of the function ran the trailer that followed it",
    );

    for (const [, { candidate, version }] of installedBashes()) {
      assert.deepEqual(
        [
          ...gateClassifications([TRUSTED_PATH], {
            script,
            label: `trailer under bash ${version}`,
            bash: candidate,
          }),
        ],
        [[TRUSTED_PATH, "root-tooling-scripts"]],
        `the probe misread the trailer gate under bash ${version}`,
      );
      assert.ok(
        !existsSync(owned),
        `bash ${version} ran the trailer that followed the closing brace`,
      );
    }

    // A trailer that is not a separate command changes what the function does,
    // so the span cannot simply drop it.
    assert.throws(
      () =>
        bashFunctionSource(
          gateFixture({ closer: `} > /dev/null` }),
          GATE_CLASSIFIER,
          "redirected definition",
        ),
      /neither a comment nor a separate command/,
      "the extractor silently dropped a redirection attached to the definition",
    );
  } finally {
    rmSync(join(owned, ".."), { recursive: true, force: true });
  }
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

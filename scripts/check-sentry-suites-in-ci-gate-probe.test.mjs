/**
 * The gate-routing probe invariants behind scripts/check-sentry-suites-in-ci.test.mjs.
 *
 * `gateClassifications` lifts `classify_root_package_json_changes` out of
 * agent-quality-gate.sh and re-runs it, so the probe's own reading of that file
 * is load-bearing: a wrong span, an unstubbed helper, a misparsed verdict line or
 * a verdict computed from something the probe did not supply all make the
 * allowlist assertion in the main check pass while proving nothing. The fixtures
 * below are synthetic gate scripts, each shaped so an earlier version of the
 * probe gets it wrong, and the tests pin every one to a loud failure or a correct
 * verdict. Several run against every bash installed, because 3.2 and 5.x have
 * disagreed about which of them fails.
 *
 * Split out of check-sentry-suites-in-ci-lifecycle.test.mjs to keep both under
 * the repo's 1,000-line cap; the main test file imports this module, so `node
 * scripts/check-sentry-suites-in-ci.test.mjs` runs these too.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  gateFixture,
  installedBashes,
  legacyFunctionSource,
  TRUSTED_PATH,
  UNTRUSTED_PATH,
} from "./check-sentry-suites-in-ci-gate-fixtures.mjs";
import {
  bashFunctionSource,
  GATE,
  GATE_CLASSIFIER,
  gateClassifications,
  GATE_PATH,
  inputRedirections,
} from "./check-sentry-suites-in-ci-probes.mjs";

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

  // A quoted or escaped call is an ordinary call the left-boundary match
  // missed, because the character before the name is a quote or a backslash. In
  // a branch the synthetic paths never enter, the runtime guard never fires
  // either, so nothing caught it at all.
  for (const call of [`"new_helper"`, `\\new_helper`, `'new_helper'`]) {
    assert.throws(
      () =>
        gateClassifications([TRUSTED_PATH], {
          script: gateFixture({
            prelude: `new_helper() {\n  printf 'x\\n'\n}`,
            inner: `  if [[ "$saw_tooling" == "never" ]]; then\n    ${call}\n  fi`,
          }),
          label: `quoted call ${call}`,
        }),
      /new_helper/,
      `the probe missed a helper called as ${call}`,
    );
  }

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
  // The guard reads a command word, so anything WRAPPING the real command hides
  // it. `command`, `builtin` and `exec` are the whole set of bash command
  // modifiers; every other route re-enters the DEBUG trap on its own, which
  // makes unwrapping those three a rule rather than a list that grows. Each row
  // runs on every installed bash: several were caught on 5.3 only, by
  // `command_not_found_handle`, which 3.2 does not have.
  const hidden = [
    ["command", `  command cat /no/such/file 2> /dev/null`],
    // A value with a space in it: the first space falls inside the assignment,
    // so splitting on it left a fragment and the guard stopped checking `cat`
    // entirely. Ordinary shell, and bash 3.2 proves who caught it — it has no
    // `command_not_found_handle`, so before this the marker never appeared.
    ["an assignment prefix", `  LABEL="two words" cat /missing`],
    // On 3.2 with `2>&-` this had no detector at all: no handler, no diagnostic
    // on the closed stderr, and a scanner that stopped at the escaped quote.
    ["an escaped quote", `  LABEL="x \\" : y" cat /missing 2>&-`],
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
  // The real classifier already ends its loop with `done < <(…)`, so a second
  // process substitution around an unstubbed helper is an ordinary edit. It used
  // to feed the guard's marker into that loop as input and return a clean verdict
  // on bash 4+; a `$(…)` captures it the same way and a pipeline pipes it away.
  // Two things stop that: fd 9, duplicated from the real stderr before the
  // classifier can touch it, and `kill` against `$$`, which stays the invoking
  // shell's pid inside either construct.
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
  // utilities", so it reaches a binary whatever the probe sets `$PATH` to, and
  // there is nothing to validate behind it — the escape is the invocation.
  // Quoted and escaped forms are included because this scan reads the same
  // normalized copy the helper-name search does; one seeing through quoting
  // while the other did not was an inconsistency, not a decision. The last two
  // sit in a branch no synthetic path enters, so the runtime guard never fires.
  for (const inner of [
    `  command -p cat /etc/passwd > /dev/null`,
    `  command -p cat /no/such/file 2> /dev/null`,
    `  if [[ "$saw_tooling" == "never" ]]; then\n    "command" -p cat /etc/passwd\n  fi`,
    `  if [[ "$saw_tooling" == "never" ]]; then\n    \\command -p cat /etc/passwd\n  fi`,
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
  // The verdict has to be a function of the synthetic change paths, so a `read`
  // from a file makes it a function of the machine — the drift the stubbed-helper
  // check exists to stop, arriving through a redirection rather than a command.
  //
  // Checked by reading, not watching: `$BASH_COMMAND` carries a SIMPLE command's
  // redirection on both interpreters but not a compound's —
  // `while IFS= read -r l; do :; done < /etc/passwd` reports only
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

test("the gate probe bounds a classifier that never terminates", () => {
  // Without a deadline a `while :; do :; done` hangs the routing test until
  // whatever outer limit the job has, and surfaces as a job timeout rather than
  // as a broken classifier. The bound is overridable here only so this test
  // need not wait the production 30s to prove it.
  const started = Date.now();
  assert.throws(
    () =>
      gateClassifications([TRUSTED_PATH], {
        script: gateFixture({ inner: `  while :; do :; done` }),
        label: "nonterminating classifier",
        timeoutMs: 2000,
      }),
    /did not terminate within 2000ms/,
    "the probe waited on a classifier that never finishes",
  );
  assert.ok(
    Date.now() - started < 20_000,
    "the probe did not give up anywhere near its own deadline",
  );
});

test("the gate probe's verdict does not depend on who ran it", () => {
  // Branching on an ambient variable — `CI`, `GITHUB_ACTIONS`, a tool flag — is
  // ordinary shell, and inheriting the parent's environment made the probe
  // answer one way on a laptop and another on a runner, calling both correct.
  // `HOME` and `TMPDIR` are read by NAME here because allowlisting those names
  // while passing the operator's VALUES through narrowed the surface without
  // closing it. Both flips use real directories: Node reads `TMPDIR` itself.
  const first = mkdtempSync(join(tmpdir(), "gate-probe-ambient-a-"));
  const second = mkdtempSync(join(tmpdir(), "gate-probe-ambient-b-"));
  try {
    for (const name of ["AMBIENT_CLASS", "HOME", "TMPDIR"]) {
      const script = gateFixture({
        inner: `  if [[ "\${${name}:-}" == "${first}" ]]; then
    saw_tooling=false
  fi`,
      });
      const original = process.env[name];
      const seen = [];
      try {
        for (const value of [first, second]) {
          process.env[name] = value;
          for (const [, { candidate, version }] of installedBashes()) {
            seen.push([
              version,
              [
                ...gateClassifications([TRUSTED_PATH], {
                  script,
                  label: `${name} under bash ${version}`,
                  bash: candidate,
                }),
              ],
            ]);
          }
        }
      } finally {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      }
      const half = seen.length / 2;
      assert.deepEqual(
        seen.slice(0, half),
        seen.slice(half),
        `changing \`${name}\` in the parent changed the probe's verdict`,
      );
      for (const [version, verdicts] of seen) {
        assert.deepEqual(
          verdicts,
          [[TRUSTED_PATH, "root-tooling-scripts"]],
          `bash ${version} misread the \`${name}\` fixture`,
        );
      }
    }
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }

  for (const [, { candidate, version }] of installedBashes()) {
    // The case that would break if the real classifier read an ambient
    // variable: it must still verdict correctly on the minimal environment.
    assert.deepEqual(
      [
        ...gateClassifications(
          ["/scripts/tf:test", "/scripts/__not_an_allowlisted_alias__"],
          { bash: candidate },
        ),
      ],
      [
        ["/scripts/tf:test", "root-tooling-scripts"],
        ["/scripts/__not_an_allowlisted_alias__", "package-scripts"],
      ],
      `the real gate classifier reads something outside the probe's minimal environment under bash ${version}`,
    );
  }
});

test("the gate probe pins the variables bash invents for itself", () => {
  // No environment can reach these: bash creates them after startup. `OSTYPE`
  // reads `darwin25` under 3.2, `darwin25.4.0` under 5.3 and `linux-gnu` on a
  // runner, so before they were pinned this fixture classified differently on
  // each interpreter here — the same defect a laptop-versus-runner split is.
  const script = gateFixture({
    inner: `  case "\${OSTYPE:-}" in
    darwin* | linux*) saw_tooling=false ;;
  esac`,
  });
  const verdicts = installedBashes().map(([, { candidate, version }]) => [
    version,
    [
      ...gateClassifications([TRUSTED_PATH], {
        script,
        label: `OSTYPE under bash ${version}`,
        bash: candidate,
      }),
    ],
  ]);
  for (const [version, verdict] of verdicts) {
    assert.deepEqual(
      verdict,
      [[TRUSTED_PATH, "root-tooling-scripts"]],
      `bash ${version} let the classifier read a machine-describing variable`,
    );
  }

  // And the pinned values must reach a subshell and a function, since that is
  // where the classifier's own work happens.
  const reported = gateClassifications([TRUSTED_PATH], {
    script: gateFixture({
      inner: `  local seen
  seen="$(printf '%s' "$OSTYPE")"
  if [[ "$seen" != "__probe_fixed__" ]]; then
    saw_tooling=false
  fi`,
    }),
    label: "OSTYPE inside a subshell",
  });
  assert.deepEqual(
    [...reported],
    [[TRUSTED_PATH, "root-tooling-scripts"]],
    "the pinned value did not reach a command substitution inside the classifier",
  );
});

test("the gate probe ignores bash startup hooks in its environment", () => {
  // Non-interactive bash sources $BASH_ENV and imports exported functions at
  // STARTUP — before the probe empties PATH or installs the guard. Whatever they
  // define is a shell function by then, so `command -v` reports it available and
  // the guard waves it through: the verdict starts depending on the operator's
  // shell setup. Both injections made an UNALLOWLISTED alias classify as
  // `root-tooling-scripts`.
  const ambient = mkdtempSync(join(tmpdir(), "gate-probe-ambient-"));
  const bashEnv = join(ambient, "ambient.sh");
  writeFileSync(bashEnv, "ambient_helper() { printf 'ambient\\n'; }\n");
  const script = gateFixture({
    inner: `  local amb=""
  amb="$(ambient_helper)"
  if [[ "$amb" == "ambient" ]]; then
    saw_tooling=true
  fi`,
  });
  const injections = [
    ["BASH_ENV", { BASH_ENV: bashEnv }],
    [
      "an exported bash function",
      { "BASH_FUNC_ambient_helper%%": "() { printf 'ambient\\n'; }" },
    ],
  ];
  try {
    for (const [label, vars] of injections) {
      // Snapshot and restore, rather than delete. Deleting unconditionally
      // strips a `BASH_ENV` the test process legitimately had, leaving every
      // later test in this same required suite running in an environment this
      // one changed. `undefined` means absent, and has to go back to absent.
      const before = new Map(
        Object.keys(vars).map((name) => [name, process.env[name]]),
      );
      Object.assign(process.env, vars);
      try {
        assert.throws(
          () =>
            gateClassifications([UNTRUSTED_PATH], { script, label: "ambient" }),
          /__probe_missing_command__ ambient_helper/,
          `the probe let ${label} define a helper it then accepted`,
        );
      } finally {
        for (const [name, value] of before) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  } finally {
    rmSync(ambient, { recursive: true, force: true });
  }
});

test("the gate probe cannot see the checkout it is run from", () => {
  // Enumerating the primitives that can observe the filesystem has no end —
  // `[[ -f ]]`, `test -e`, a glob, `compgen -G`. Running from a fresh empty
  // directory closes all of them at once: there is simply nothing there. An
  // ambient read used to make an unallowlisted alias classify as
  // `root-tooling-scripts`; now the same classifier answers correctly, because
  // the read observes nothing rather than being refused.
  for (const [, { candidate, version }] of installedBashes()) {
    assert.deepEqual(
      [
        ...gateClassifications([UNTRUSTED_PATH], {
          script: gateFixture({
            inner: `  if [[ -f package.json ]]; then
    saw_tooling=true
  fi`,
          }),
          label: `ambient read under bash ${version}`,
          bash: candidate,
        }),
      ],
      [[UNTRUSTED_PATH, "package-scripts"]],
      `bash ${version} let the classifier see the checkout`,
    );

    // The case that would break if the classifier legitimately needed the tree:
    // the REAL gate must still classify correctly from an empty directory.
    const verdicts = gateClassifications(
      ["/scripts/tf:test", "/scripts/__not_an_allowlisted_alias__"],
      { bash: candidate },
    );
    assert.deepEqual(
      [...verdicts],
      [
        ["/scripts/tf:test", "root-tooling-scripts"],
        ["/scripts/__not_an_allowlisted_alias__", "package-scripts"],
      ],
      `the real gate classifier depends on its working directory under bash ${version}`,
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

test("a stub is at least as strict as the helper it stands in for", () => {
  // The real `json_change_paths` opens with `local path="$1"` under `set -u`
  // and diffs THAT file. A stub that ignores its arguments accepts a classifier
  // the gate would abort on, and one that reads a different manifest — the
  // probe then reports a clean verdict for a broken gate. A stub that is more
  // permissive than its counterpart is a false-green machine for exactly the
  // contract changes this probe exists to catch.
  const callingWith = (call) => `#!/usr/bin/env bash
set -euo pipefail

json_change_paths() {
  local path="$1"
  echo "__unknown__"
}

${GATE_CLASSIFIER}() {
  local change
  local saw_tooling=false
  while IFS= read -r change; do
    [[ -n "$change" ]] || continue
    case "$change" in
      ${TRUSTED_PATH}) saw_tooling=true ;;
    esac
  done < <(${call})
  if [[ "$saw_tooling" == true ]]; then
    echo "root-tooling-scripts"
  else
    echo "package-scripts"
  fi
}

root_package_json_class=""
`;
  for (const [, { candidate, version }] of installedBashes()) {
    for (const [label, call] of [
      ["no argument at all", "json_change_paths"],
      ["a different manifest", 'json_change_paths "pnpm-lock.yaml"'],
      ["two arguments", 'json_change_paths "package.json" extra'],
    ]) {
      assert.throws(
        () =>
          gateClassifications([TRUSTED_PATH], {
            script: callingWith(call),
            label: `${label} under bash ${version}`,
            bash: candidate,
          }),
        /__probe_stub_contract__/,
        `bash ${version} accepted a classifier calling the stub with ${label}`,
      );
    }

    // The call the gate actually makes must still work, or this rejects honest
    // classifiers — the failure mode that matters more than the gap.
    assert.deepEqual(
      [
        ...gateClassifications([TRUSTED_PATH], {
          script: callingWith('json_change_paths "package.json"'),
          label: `correct call under bash ${version}`,
          bash: candidate,
        }),
      ],
      [[TRUSTED_PATH, "root-tooling-scripts"]],
      `bash ${version} rejected the call the real gate makes`,
    );
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

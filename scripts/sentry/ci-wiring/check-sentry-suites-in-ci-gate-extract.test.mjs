/**
 * How `bashFunctionSource` lifts a function out of a shell script, and how the
 * probe shells it runs are bounded.
 *
 * Split from check-sentry-suites-in-ci-gate-probe.test.mjs to keep both under
 * the repo's 1,000-line cap (GitHub issue #1803); the shared fixtures live in
 * check-sentry-suites-in-ci-gate-fixtures.mjs. The main check imports this
 * module, so `node scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs` runs it.
 *
 * The extraction machinery outlived the check it was written for. D5c retired
 * the gate's bash routing arms, so `gateClassifications` no longer lifts and
 * re-runs anything — but ADR 0069's routing-table suite reads
 * `implementation_signature()` out of the live gate with `bashFunctionSource`
 * and drives `/bin/bash` as its pattern oracle through `runProbeShell`, so
 * every defect these fixtures pin is still a defect in a live check.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bashFunctionSource,
  FIXTURE_CLASSIFIER,
  GATE,
  GATE_FUNCTION,
  GATE_PATH,
  gateFixture,
  installedBashes,
  legacyFunctionSource,
} from "./check-sentry-suites-in-ci-gate-fixtures.mjs";
import {
  probeDirs,
  runProbeShell,
} from "./check-sentry-suites-in-ci-gate-extract.mjs";

test("probe cleanup is owned by a live detached Bash group leader", () => {
  const source = readFileSync(
    join(import.meta.dirname, "check-sentry-suites-in-ci-gate-extract.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /process\.kill\s*\(/,
    "Node must not signal a reaped numeric pid or process-group id",
  );
  assert.match(source, /kill -KILL -- "-\$\$"/);
  assert.match(source, /: > "\$timeout_marker"/);
  assert.match(source, /> "\$completion_marker"/);
  assert.match(
    runProbeShell.toString(),
    /stdio:\s*inheritGateMarkerStdio\(options\.stdio\)/,
    "probe spawns must retain the quality gate marker descriptors",
  );
});

test("the gate-function extractor ends the function where bash ends it", () => {
  // Control: on the shape the gate has today the old rule was right, so any
  // difference below comes from the fixture, not from the two rules disagreeing
  // about ordinary text.
  const clean = gateFixture({});
  assert.equal(
    bashFunctionSource(clean, FIXTURE_CLASSIFIER, "clean"),
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
  const heredocSource = bashFunctionSource(
    heredoc,
    FIXTURE_CLASSIFIER,
    "heredoc",
  );
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
    FIXTURE_CLASSIFIER,
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
    header: `function ${FIXTURE_CLASSIFIER}() {`,
  });
  assert.ok(
    bashFunctionSource(keyword, FIXTURE_CLASSIFIER, "keyword").startsWith(
      `function ${FIXTURE_CLASSIFIER}() {`,
    ),
    "the extractor cannot read a `function`-keyword definition",
  );
  assert.equal(
    legacyFunctionSource(keyword),
    null,
    "the old header string read the `function`-keyword fixture, so it pins nothing",
  );
});

test("the extractor keeps working on a script the old terminator could not read", () => {
  // The point of the two fixtures above is not that they fail loudly — it is
  // that the extractor keeps WORKING on them: a whole function, opener to
  // closer, on each shape the old rule got wrong.
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
      gateFixture({ header: `function ${FIXTURE_CLASSIFIER} {` }),
    ],
    // A trailing comment on the header is ordinary style, and the matcher read
    // it as neither a definition nor an error: the extractor threw "defines it
    // 0 times" and stopped working on an honest script.
    [
      "commented header",
      gateFixture({
        header: `${FIXTURE_CLASSIFIER}() { # classify the manifest`,
      }),
    ],
  ]) {
    const extracted = bashFunctionSource(script, FIXTURE_CLASSIFIER, label);
    assert.ok(
      extracted.includes(FIXTURE_CLASSIFIER),
      `the ${label} span does not start at the definition: ${JSON.stringify(extracted.slice(0, 80))}`,
    );
    assert.ok(
      extracted.includes('echo "root-tooling-scripts"'),
      `the ${label} span stopped before the end of the function: ${JSON.stringify(extracted)}`,
    );
    assert.ok(
      !extracted.includes('root_package_json_class=""'),
      `the ${label} span ran past the closing brace: ${JSON.stringify(extracted)}`,
    );
  }
});

test("the extractor will not carry a trailer off the closing brace", () => {
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
    const extracted = bashFunctionSource(script, FIXTURE_CLASSIFIER, "trailer");
    assert.ok(
      !extracted.includes("owned"),
      `the extracted span carried the trailer with it: ${JSON.stringify(extracted.split("\n").at(-2))}`,
    );
    assert.ok(
      !existsSync(owned),
      "finding the end of the function ran the trailer that followed it",
    );

    for (const [, { candidate, version }] of installedBashes()) {
      const underBash = bashFunctionSource(
        script,
        FIXTURE_CLASSIFIER,
        `trailer under bash ${version}`,
        candidate,
      );
      assert.ok(
        !underBash.includes("owned"),
        `bash ${version} carried the trailer into the span`,
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
          FIXTURE_CLASSIFIER,
          "redirected definition",
        ),
      /neither a comment nor a separate command/,
      "the extractor silently dropped a redirection attached to the definition",
    );
  } finally {
    rmSync(join(owned, ".."), { recursive: true, force: true });
  }
});

test("a probe that outruns its deadline is killed outright, never asked to stop", () => {
  // `spawnSync` sends its `killSignal` and then keeps WAITING for the child; it
  // escalates to SIGKILL only when the signal call itself errors, which a shell
  // that traps or ignores SIGTERM does not make it do. Under the default signal
  // such a probe outlives its deadline and this call never returns — so the
  // group cleanup that follows it never runs either, because the call it follows
  // has not come back.
  //
  // The assertion is on the signal the child died of rather than on a
  // SIGTERM-ignoring fixture: that fixture is the hang itself, and a suite that
  // hangs instead of failing tells nobody anything.
  const root = mkdtempSync(join(tmpdir(), "gate-probe-deadline-"));
  try {
    const dirs = probeDirs(root);
    for (const [, { candidate, version }] of installedBashes()) {
      // A bash builtin loop: the probe's `$PATH` is an empty directory, so an
      // external `sleep` would not be found and the shell would exit at once.
      const result = runProbeShell(candidate, ["-c", "while :; do :; done"], {
        dirs,
        timeout: 500,
      });
      assert.equal(
        result.error?.code,
        "ETIMEDOUT",
        `bash ${version} did not report the deadline`,
      );
      assert.equal(
        result.signal,
        "SIGKILL",
        `bash ${version} was signalled ${result.signal}, which a probe can ignore`,
      );
      assert.equal(
        result.status,
        null,
        `bash ${version} timeout was reported as target exit ${result.status}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the deadline holds even when the probe leaves a descendant behind", () => {
  // The worry this answers: `spawnSync` captures stdout and stderr through
  // pipes, and a descendant that outlives the shell inherits those write ends —
  // so if the call waited for EOF rather than for the child, killing the shell
  // would leave it blocked on a pipe nothing will close, and the negative-pid
  // group cleanup after it could never run.
  //
  // It does not wait. Measured here on both shapes the probe can produce: a
  // backgrounded descendant, and the `$(…)` command substitution the classifier
  // actually runs in. Each returns at its deadline, which is also what the group
  // cleanup below needs in order to happen at all. Absolute paths because the
  // probe's `$PATH` is an empty directory.
  const root = mkdtempSync(join(tmpdir(), "gate-probe-descendant-"));
  try {
    const dirs = probeDirs(root);
    for (const [, { candidate, version }] of installedBashes()) {
      for (const [shape, script] of [
        ["a backgrounded descendant", "/bin/sleep 30 &\nwhile :; do :; done"],
        ["a command substitution", 'x="$(/bin/sleep 30; echo late)"'],
      ]) {
        const started = Date.now();
        const result = runProbeShell(candidate, ["-c", script], {
          dirs,
          timeout: 500,
        });
        assert.equal(
          result.error?.code,
          "ETIMEDOUT",
          `bash ${version} did not report the deadline for ${shape}`,
        );
        assert.ok(
          Date.now() - started < 15_000,
          `bash ${version} outran its 500ms deadline on ${shape} by holding a captured pipe`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live-leader deadline kills a descendant before it can act", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-probe-descendant-proof-"));
  try {
    const dirs = probeDirs(root);
    const leak = join(root, "descendant-survived");
    const result = runProbeShell(
      "/bin/bash",
      [
        "-c",
        '( /bin/sleep 2; printf survived > "$1" ) &\nwhile :; do :; done',
        "deadline-descendant",
        leak,
      ],
      { dirs, timeout: 500 },
    );
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.equal(result.signal, "SIGKILL");

    // If the background child escaped the group kill, it writes after two
    // seconds. Wait past that point and prove the side effect never happens.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200);
    assert.equal(
      existsSync(leak),
      false,
      "the timed-out probe left a descendant running after its leader died",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal probe completion settles descendants and preserves target status", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-probe-completion-proof-"));
  try {
    const dirs = probeDirs(root);
    const leak = join(root, "descendant-survived");
    const result = runProbeShell(
      "/bin/bash",
      [
        "-c",
        '( /bin/sleep 2; printf survived > "$1" ) &\nexit 7',
        "completion-descendant",
        leak,
      ],
      { dirs, timeout: 5_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.equal(result.signal, null);

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_200);
    assert.equal(
      existsSync(leak),
      false,
      "a normally completed probe left a descendant running",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probe target signals use documented Bash status semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-probe-signal-status-"));
  try {
    const result = runProbeShell("/bin/bash", ["-c", "kill -TERM $$"], {
      dirs: probeDirs(root),
      timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 143);
    assert.equal(result.signal, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the extractor refuses a function the script never defines at top level", () => {
  // Column 0 is not top level. A definition nested inside another function is
  // never reached by the script's own top-level code, so a span lifted out of
  // one describes logic the script does not have — and the check reading that
  // span would be green over the wrong text. Nothing in the toolchain prevents
  // the layout: this repo has no shell formatter, and shellcheck does not
  // object to a nested definition.
  const nested = (open, close) => `#!/usr/bin/env bash
json_change_paths() { :; }

${open}
${FIXTURE_CLASSIFIER}() {
  echo "root-tooling-scripts"
}
${close}
`;
  for (const [, { candidate, version }] of installedBashes()) {
    for (const [label, open, close] of [
      ["a function, header at column 0", "wrapper() {", "  :\n}"],
      ["an if block", "if true; then", "fi"],
      ["a while loop", "while false; do", "done"],
      // A heredoc parses fine — everything after the opener is body text — so
      // "does the prefix parse?" says top level. bash 5.3 warns about the
      // unterminated heredoc, but 3.2 exits 0 with empty stderr, so the warning
      // is not the discriminator; the swallowed syntax error is.
      ["a heredoc", ": <<'PAYLOAD'", "PAYLOAD"],
    ]) {
      assert.throws(
        () =>
          bashFunctionSource(
            nested(open, close),
            FIXTURE_CLASSIFIER,
            `${label} under bash ${version}`,
            candidate,
          ),
        /inside another construct rather than at top level/,
        `bash ${version} accepted a classifier enclosed in ${label}`,
      );
    }

    // The case that matters most: the live subject must still read as top
    // level. ADR 0069's routing-table suite extracts this exact function from
    // this exact file to prove `implementation_signature()` lists every module
    // it must hash, so a refusal here is that pin going dark.
    assert.ok(
      bashFunctionSource(GATE, GATE_FUNCTION, GATE_PATH, candidate).startsWith(
        `${GATE_FUNCTION}() {`,
      ),
      `bash ${version} no longer reads ${GATE_FUNCTION} in the real gate as top level`,
    );
  }
});

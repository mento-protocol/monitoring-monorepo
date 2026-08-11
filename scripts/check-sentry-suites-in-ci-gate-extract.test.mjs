/**
 * How the probe lifts `classify_root_package_json_changes` out of the gate.
 *
 * Split from check-sentry-suites-in-ci-gate-probe.test.mjs to keep both under
 * the repo's 1,000-line cap (GitHub issue #1803); the shared fixtures live in
 * check-sentry-suites-in-ci-gate-fixtures.mjs. The main check imports this
 * module, so `node scripts/check-sentry-suites-in-ci.test.mjs` runs it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bashFunctionSource,
  GATE_CLASSIFIER,
  gateFixture,
  installedBashes,
  legacyFunctionSource,
  TRUSTED_PATH,
  UNTRUSTED_PATH,
} from "./check-sentry-suites-in-ci-gate-fixtures.mjs";
import {
  GATE,
  gateClassifications,
  GATE_PATH,
} from "./check-sentry-suites-in-ci-probes.mjs";

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
    // A trailing comment on the header is ordinary style, and the matcher read
    // it as neither a definition nor an error: the probe threw "defines it 0
    // times" and stopped working on an honest classifier.
    [
      "commented header",
      gateFixture({ header: `${GATE_CLASSIFIER}() { # classify the manifest` }),
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

test("the extractor refuses a classifier the gate never defines at top level", () => {
  // Column 0 is not top level. A definition nested inside another function is
  // never executed by the gate, so lifting it out reports verdicts for logic
  // the gate does not have — the routing test would be green on a broken gate.
  // Nothing in the toolchain prevents the layout: this repo has no shell
  // formatter, and shellcheck does not object to a nested definition.
  const nested = (open, close) => `#!/usr/bin/env bash
json_change_paths() { :; }

${open}
${GATE_CLASSIFIER}() {
  echo "root-tooling-scripts"
}
${close}
`;
  for (const [, { candidate, version }] of installedBashes()) {
    for (const [label, open, close] of [
      ["a function, header at column 0", "wrapper() {", "  :\n}"],
      ["an if block", "if true; then", "fi"],
      ["a while loop", "while false; do", "done"],
    ]) {
      assert.throws(
        () =>
          bashFunctionSource(
            nested(open, close),
            GATE_CLASSIFIER,
            `${label} under bash ${version}`,
            candidate,
          ),
        /inside another construct rather than at top level/,
        `bash ${version} accepted a classifier enclosed in ${label}`,
      );
    }

    // The case that matters most: the real gate must still read as top level.
    assert.ok(
      bashFunctionSource(
        GATE,
        GATE_CLASSIFIER,
        GATE_PATH,
        candidate,
      ).startsWith(`${GATE_CLASSIFIER}() {`),
      `bash ${version} no longer reads the real gate's classifier as top level`,
    );
  }
});

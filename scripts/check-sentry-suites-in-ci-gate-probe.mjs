/**
 * The gate-routing probe behind scripts/check-sentry-suites-in-ci.test.mjs.
 *
 * `gateClassifications` proves scripts/agent-quality-gate.sh routes a given
 * package.json change path to the right focused-test arm, by lifting the gate's
 * own `classify_root_package_json_changes` out of the script and re-running it
 * against synthetic paths. bash does its own parsing and its own pattern
 * matching, so a commented-out entry, an entry moved to a different arm, and an
 * arm whose body changed all show up as a different classification.
 *
 * Lifting a function out of a shell script is the whole risk. The probe used to
 * cut the body at the first line that is exactly `}` at column 0, which is not
 * where a bash function ends: a heredoc or a quoted `}` cuts it short, and one
 * trailing space on the real closer runs past the end into whatever follows.
 * Neither is loud on its own — an over-captured span executes the code it
 * swallowed and still prints plausible verdicts. So the extraction here asks
 * bash where the function ends (`bashFunctionSource`), and every later step is
 * written to red the test rather than return a short or invented map.
 *
 * Split out of check-sentry-suites-in-ci-probes.mjs to keep both under the
 * repo's 1,000-line cap; that module re-exports this one, so the tests keep
 * importing from a single facade.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const GATE_PATH = fileURLToPath(
  new URL("agent-quality-gate.sh", import.meta.url),
);
export const GATE = readFileSync(GATE_PATH, "utf8");

/** The name of the gate function `gateClassifications` re-executes. */
export const GATE_CLASSIFIER = "classify_root_package_json_changes";

/**
 * Every class `classify_root_package_json_changes` may print. The probe rejects
 * anything else, so a verdict that came from a broken extraction, a missing
 * command, or an arm that fell through to no output fails the test instead of
 * being stored as a plausible-looking string. A gate that grows a class must be
 * re-read here, on purpose.
 */
export const GATE_ROOT_PACKAGE_JSON_CLASSES = new Set([
  "workspace",
  "workspace-dev-metadata",
  "root-tooling-scripts",
  "package-scripts",
]);

/** Printed by the probe shell when it runs a command that does not exist. */
const MISSING_COMMAND_MARKER = "__probe_missing_command__";

/**
 * How far past a definition the end-of-function scan will look. The gate's
 * classifier is ~50 lines and the scan rewrites a growing candidate per line, so
 * an unbounded walk over a gate whose function never closes would grind through
 * the rest of the file. Running out is reported, not absorbed.
 */
const MAX_FUNCTION_LINES = 500;

/**
 * The gate helpers the probe replaces, by name. `json_change_paths` reads git;
 * the probe feeds the classifier one synthetic change path instead. Process
 * substitution forks the shell, so the loop variable is visible inside the stub.
 * The set is asserted to be exactly what the extracted body calls, so a gate
 * edit that reaches for a second helper fails loudly here rather than running it
 * as a missing command inside a `$(…)` whose failure nothing propagates.
 */
const GATE_PROBE_STUBS = new Map([
  [
    "json_change_paths",
    `json_change_paths() { printf '%s\\n' "$__probe_path"; }`,
  ],
]);

/**
 * A bash function definition, at any indentation, in every form bash accepts:
 * `name() {`, `function name {`, and `function name() {`. Matching all three is
 * the point — an exact-string header match reads a `function`-keyword variant as
 * "the function is gone", and reads a nested, indented redefinition as absent.
 */
const BASH_DEFINITION =
  /^[ \t]*(?:function[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*\([ \t]*\))?|([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([ \t]*\))[ \t]*\{?[ \t]*$/gm;

/** The name a `BASH_DEFINITION` match defines, from whichever form matched. */
const definedName = (match) => match[1] ?? match[2];

/**
 * Ask bash where a function ends. The candidate grows one line at a time and
 * each one is sourced with a sentinel definition appended; the FIRST line count
 * at which bash defines both the target and the sentinel is the function's last
 * line.
 *
 * Both halves of that question matter. "Defines the target" rejects every cut
 * that leaves the body open — a shorter candidate ends inside the braces, so it
 * is a syntax error and defines nothing. "Defines the sentinel" rejects a cut
 * inside a heredoc or a quoted string, which swallows the sentinel line instead
 * of parsing it. Taking the FIRST success is what stops over-capture: a longer
 * candidate that also parses has pulled in top-level code that follows the
 * function.
 *
 * Nothing in the script executes before the scan stops. Every candidate shorter
 * than the true end leaves the body open, so `source` reports a syntax error and
 * runs none of it; the one that succeeds is a lone function definition, which
 * has no effect beyond defining it. That is what lets the sourcing happen in the
 * scan shell rather than a subshell per line — six times faster, and the `unset`
 * keeps a definition from one attempt out of the next. A bash that treated the
 * syntax error as fatal would exit non-zero here, which the caller reads as a
 * failed extraction; there is no path where this returns a span it did not
 * prove.
 */
const FUNCTION_END_SCAN = `
set -uo pipefail
name="$1"
tail_file="$2"
cand_file="$3"
max="$4"

body=""
n=0
while IFS= read -r line || [[ -n "$line" ]]; do
  n=$((n + 1))
  body+="$line"$'\\n'
  printf '%s__probe_sentinel__() { :; }\\n' "$body" > "$cand_file"
  unset -f "$name" __probe_sentinel__ 2> /dev/null
  # shellcheck disable=SC1090
  source "$cand_file" > /dev/null 2>&1
  if declare -F "$name" > /dev/null 2>&1 &&
    declare -F __probe_sentinel__ > /dev/null 2>&1; then
    printf '%s\\n' "$n"
    exit 0
  fi
  if ((n >= max)); then break; fi
done < "$tail_file"

printf 'no complete definition of %s in the first %s lines\\n' "$name" "$max" >&2
exit 4
`;

/**
 * The source text of a top-level bash function, from its definition line
 * through the line bash itself treats as its last.
 *
 * The end is not found by looking for a closing brace. A textual terminator
 * cannot see a heredoc, a quoted string, or a `}` that carries trailing
 * whitespace, and each of those silently returns the wrong span — a prefix of
 * the function, or the function plus whatever follows it. `FUNCTION_END_SCAN`
 * hands the question to bash and this returns the original bytes for the span
 * bash reported, then re-parses them with `bash -n` so the text actually handed
 * to a probe is proven to stand alone.
 *
 * @param {string} script the whole shell script
 * @param {string} name the function to extract
 * @param {string} label the script's path, for assertion messages
 * @returns {string}
 */
export function bashFunctionSource(script, name, label) {
  assert.match(
    name,
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    `\`${name}\` is not a bash identifier`,
  );
  const definitions = [...script.matchAll(BASH_DEFINITION)].filter(
    (match) => definedName(match) === name,
  );
  assert.equal(
    definitions.length,
    1,
    `${label} defines \`${name}\` ${definitions.length} times — this probe cannot know which one the gate runs`,
  );
  const [definition] = definitions;
  assert.equal(
    definition[0],
    definition[0].trimStart(),
    `${label} defines \`${name}\` indented, so it is nested inside another function; this probe reads top-level definitions only`,
  );

  const tail = script.slice(definition.index);
  const tailLines = tail.split("\n");
  const dir = mkdtempSync(join(tmpdir(), "bash-fn-source-"));
  try {
    const tailPath = join(dir, "tail.sh");
    writeFileSync(tailPath, tail);
    const max = Math.min(tailLines.length, MAX_FUNCTION_LINES);
    const scan = spawnSync(
      "bash",
      ["-s", "--", name, tailPath, join(dir, "candidate.sh"), String(max)],
      { input: FUNCTION_END_SCAN, encoding: "utf8" },
    );
    assert.equal(
      scan.status,
      0,
      `could not find where \`${name}\` ends in ${label}: ${`${scan.stdout ?? ""}${scan.stderr ?? ""}`.trim()}`,
    );
    const endLine = Number(scan.stdout.trim());
    assert.ok(
      Number.isInteger(endLine) && endLine >= 1 && endLine <= max,
      `the end-of-function scan of ${label} reported ${JSON.stringify(scan.stdout)}, which is not a line number in range`,
    );

    const text = `${tailLines.slice(0, endLine).join("\n")}\n`;
    const parse = spawnSync("bash", ["-n"], { input: text, encoding: "utf8" });
    assert.equal(
      parse.status,
      0,
      `the text extracted for \`${name}\` from ${label} does not parse on its own: ${parse.stderr.trim()}`,
    );
    assert.equal(
      parse.stderr.trim(),
      "",
      `bash warned while parsing the text extracted for \`${name}\` from ${label} — the span is not a whole function: ${parse.stderr.trim()}`,
    );
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the gate's own `case` statement over each path and report how it
 * classifies them. bash parses its own source and does its own pattern
 * matching, so a commented-out entry, an entry moved to a different arm, and
 * an arm whose body changed all show up as a different classification.
 *
 * Every step is fail-closed. The function body comes from `bashFunctionSource`,
 * so a wrong span is a thrown assertion rather than a plausible verdict. A
 * command the probe does not provide trips `command_not_found_handle`, whose
 * marker lands on BOTH streams — stdout so it becomes the verdict the shape
 * check rejects, stderr so it is still visible when a `$(…)` swallows the
 * subshell's exit status. And the output must be exactly one line per requested
 * path, each with a known class: a probe that classified nothing, classified
 * something twice, or invented a path now reds the test instead of returning a
 * short map whose missing keys read as `undefined`.
 *
 * @param {string[]} paths distinct, free of tabs and newlines — the wire format
 *   is tab-separated, so a path carrying either is rejected, not misparsed
 * @param {{ script?: string, label?: string }} [options] override the script to
 *   read, so the regression tests can drive this whole path with a fixture
 * @returns {Map<string, string>}
 */
export function gateClassifications(
  paths,
  { script = GATE, label = GATE_PATH } = {},
) {
  assert.ok(
    Array.isArray(paths) && paths.length > 0,
    "gateClassifications needs at least one path; an empty request would vacuously pass every caller",
  );
  for (const path of paths) {
    assert.equal(
      typeof path,
      "string",
      `gateClassifications was handed a non-string path: ${JSON.stringify(path)}`,
    );
    assert.notEqual(path, "", "gateClassifications was handed an empty path");
    assert.doesNotMatch(
      path,
      /[\t\n]/,
      `\`${JSON.stringify(path)}\` carries a tab or newline; the probe's wire format is tab-separated lines and would misread it`,
    );
  }
  assert.equal(
    new Set(paths).size,
    paths.length,
    "gateClassifications was handed a duplicate path; the verdict map would collapse them",
  );

  const fnSource = bashFunctionSource(script, GATE_CLASSIFIER, label);

  // A helper the body calls but the probe does not define runs as a missing
  // command inside `$(…)`, where the non-zero exit dies with the subshell. The
  // handler below catches that at run time; this catches it at read time, with
  // the name of the helper to stub. A gate function whose name also appears as
  // a plain word in the body is a false positive — loud, and fixed by naming it
  // here, which is the safe direction to be wrong in.
  const gateFunctions = new Set(
    [...script.matchAll(BASH_DEFINITION)].map(definedName),
  );
  gateFunctions.delete(GATE_CLASSIFIER);
  const called = [...gateFunctions]
    .filter((helper) =>
      new RegExp(`(?:^|[\\s;&|(\`])${helper}(?![A-Za-z0-9_])`, "m").test(
        fnSource,
      ),
    )
    .sort();
  assert.deepEqual(
    called,
    [...GATE_PROBE_STUBS.keys()].sort(),
    `\`${GATE_CLASSIFIER}\` in ${label} calls a different set of gate helpers than this probe stubs; ` +
      "stub the new ones in GATE_PROBE_STUBS or the probe runs them as missing commands and reports a partial verdict",
  );

  const program = `
set -uo pipefail
# \`command_not_found_handle\` is the run-time half of the missing-command net,
# and bash only honours it from 4.0. Refuse to report verdicts without it.
if ((BASH_VERSINFO[0] < 4)); then
  printf '%s bash-%s-has-no-command_not_found_handle\\n' '${MISSING_COMMAND_MARKER}' "\${BASH_VERSINFO[0]}"
  exit 96
fi
command_not_found_handle() {
  printf '%s %s\\n' '${MISSING_COMMAND_MARKER}' "$1"
  printf '%s %s\\n' '${MISSING_COMMAND_MARKER}' "$1" >&2
  exit 97
}
${fnSource}
${[...GATE_PROBE_STUBS.values()].join("\n")}
declare -F ${GATE_CLASSIFIER} > /dev/null || { printf '%s\\n' '${MISSING_COMMAND_MARKER} the-extracted-source-defined-no-${GATE_CLASSIFIER}'; exit 3; }
for __probe_path in "$@"; do
  printf '%s\\t%s\\n' "$__probe_path" "$(${GATE_CLASSIFIER})"
done
`;
  const run = spawnSync("bash", ["-s", "--", ...paths], {
    input: program,
    encoding: "utf8",
  });
  const streams = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  assert.equal(
    run.error,
    undefined,
    `the probe shell did not run: ${run.error}`,
  );
  assert.ok(
    !streams.includes(MISSING_COMMAND_MARKER),
    `\`${GATE_CLASSIFIER}\` from ${label} ran a command the probe does not provide, so its verdicts are partial: ${streams}`,
  );
  assert.equal(
    run.status,
    0,
    `the probe shell running \`${GATE_CLASSIFIER}\` from ${label} exited ${run.status}: ${streams}`,
  );

  const emitted = run.stdout.split("\n");
  assert.equal(
    emitted.pop(),
    "",
    `the probe's stdout did not end in a newline, so a verdict line was cut short: ${JSON.stringify(run.stdout)}`,
  );
  assert.equal(
    emitted.length,
    paths.length,
    `expected one verdict line per requested path (${paths.length}), got ${emitted.length}: ${JSON.stringify(run.stdout)}`,
  );

  const requested = new Set(paths);
  const classifications = new Map();
  for (const line of emitted) {
    const fields = line.split("\t");
    assert.equal(
      fields.length,
      2,
      `the probe emitted a line that is not one path and one verdict: ${JSON.stringify(line)}`,
    );
    const [path, verdict] = fields;
    assert.ok(
      requested.has(path),
      `the probe reported a path nobody asked about: ${JSON.stringify(path)}`,
    );
    assert.ok(
      !classifications.has(path),
      `the probe reported ${JSON.stringify(path)} twice`,
    );
    assert.ok(
      GATE_ROOT_PACKAGE_JSON_CLASSES.has(verdict),
      `\`${GATE_CLASSIFIER}\` classified ${JSON.stringify(path)} as ${JSON.stringify(verdict)}, which is not one of its classes ` +
        `(${[...GATE_ROOT_PACKAGE_JSON_CLASSES].join(", ")}) — the probe is reading a broken extraction, or the gate grew a class`,
    );
    classifications.set(path, verdict);
  }
  assert.equal(
    classifications.size,
    paths.length,
    `the probe classified ${classifications.size} of ${paths.length} requested paths`,
  );
  return classifications;
}

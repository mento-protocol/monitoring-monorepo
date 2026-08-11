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
 * Re-running the lifted function is the other half. It runs with `$PATH` set to
 * an empty directory, so the only things it can reach are shell builtins and the
 * stubs this module supplies, and a DEBUG trap names anything else on stderr
 * before it runs. That holds on bash 3.2, which the gate supports and which has
 * no `command_not_found_handle`, and it catches an INSTALLED binary, which that
 * handler never sees.
 *
 * Split out of check-sentry-suites-in-ci-probes.mjs to keep both under the
 * repo's 1,000-line cap; that module re-exports this one, so the tests keep
 * importing from a single facade.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** Printed by the probe shell when it is about to run a command it did not provide. */
const MISSING_COMMAND_MARKER = "__probe_missing_command__";

/** Printed in place of a verdict when the classifier returned non-zero. */
const NONZERO_EXIT_MARKER = "__probe_nonzero_exit__";

/**
 * Appended when bash refuses something because the probe restricted the shell.
 * The bash diagnostic locates the line but not the reason, and "restricted"
 * reads as a broken probe to whoever meets it years from now.
 */
const RESTRICTED_MODE_EXPLANATION =
  `\n\nThis is deliberate, and it is this probe's doing, not a bug in the gate: the probe re-runs ` +
  `\`${GATE_CLASSIFIER}\` under \`set -r\` (restricted mode) so that bash itself refuses a \`/\` in a ` +
  "command name, `command -p`, `exec`, `enable -f` and any assignment to $PATH — the ways a classifier " +
  "could otherwise reach a binary the probe never provided, and report a verdict computed by something " +
  "this check cannot see. Restricted mode also forbids output redirection, which is what the message " +
  "above is. The fix is to move the redirection out of the classifier: a function whose whole job is to " +
  "print one classification should not need to redirect anything. If it genuinely must, this probe has " +
  "to change with it — see scripts/check-sentry-suites-in-ci-gate-probe.mjs.";

/**
 * Bash sees `$PATH` set to a directory the probe creates and leaves empty, so no
 * external command resolves and the classifier can only reach what the probe
 * explicitly provides: shell builtins, keywords, and the stubs below. Two things
 * follow. The probe cannot execute a binary while re-running gate code. And
 * `command -v` becomes the test for "did the probe provide this?", which is what
 * `PROBE_COMMAND_GUARD` asks on every command.
 *
 * @param {string} dir
 */
const restrictPath = (dir) => {
  assert.doesNotMatch(
    dir,
    /'/,
    `the probe's empty PATH directory (${dir}) contains a quote and cannot be embedded in the probe shell`,
  );
  return `PATH='${dir}'\nexport PATH`;
};

/**
 * A DEBUG trap that reports any command the probe did not provide, BEFORE it
 * runs.
 *
 * This is the layer that works everywhere. `command_not_found_handle` needs bash
 * 4.0, and the gate supports bash 3.2 (docs/notes/agent-quality-gate-mechanics.md);
 * bash's own `command not found` diagnostic is written by the failing command, so
 * a `2> /dev/null` on it suppresses the message on every bash version. A DEBUG
 * trap fires before the command's redirections are applied, so its marker reaches
 * the probe's stderr either way — and it fires for an INSTALLED binary too, not
 * only a missing one, which `command_not_found_handle` never sees.
 *
 * Reporting alone is not enough, because the classifier can consume the report.
 * The real one already ends its loop with `< <(json_change_paths …)`, and a
 * second process substitution around an unstubbed helper feeds this marker
 * straight into that loop as input — an ordinary edit, not a contrived one. So
 * the trap does not rely on a channel the classifier can read: it prints, then
 * takes the whole probe shell down with `kill` against `$$`. Inside `$(…)` and
 * `<(…)` alike, `$$` stays the INVOKING shell's pid — that is precisely what
 * `BASHPID` exists to distinguish — so no construct can contain the failure, and
 * `kill` is a builtin, needing neither PATH nor a redirection under `set -r`.
 * The caller reads a signalled death as a hard failure whatever reached stdout.
 *
 * The word to check is not always the first one, so the loop strips prefixes
 * until it reaches the command actually being run:
 *
 *   - `VAR=value` is an assignment. `saw_change=true` is skipped entirely, and
 *     `IFS= read -r change` is checked as `read`.
 *   - `command`, `builtin` and `exec` are the command modifiers: they take a
 *     command word and run it, so checking THEM checks nothing. That set is
 *     closed. Every other way of reaching a command re-enters this trap on its
 *     own and is caught by the ordinary path — `eval` and `source` re-parse,
 *     a function call traces its body under `set -T`, an alias is expanded
 *     before `$BASH_COMMAND` is set, and `time`/`!` are keywords bash reports
 *     the wrapped command through. All four were checked on 3.2 and 5.3, and
 *     `compgen -b` differs between them only by `compopt`/`mapfile`/`readarray`,
 *     none of which run a command word.
 *   - `command -p` is rejected rather than unwrapped: `-p` uses a default PATH
 *     "guaranteed to find all of the standard utilities", so it reaches a binary
 *     no matter what the probe sets `$PATH` to. There is nothing to validate —
 *     the escape is the invocation.
 */
const PROBE_COMMAND_GUARD = `__probe_refuse() {
  # fd 9 is the probe's real stderr, duplicated before the classifier could
  # redirect anything, so the name reaches the caller out of any \`$(…)\` or
  # \`< <(…)\` that would otherwise consume it. A dup of an already-open fd is
  # the one output redirection restricted mode still allows.
  printf '%s %s\\n' '${MISSING_COMMAND_MARKER}' "$1" >&9
  # Then stop the shell, so a classifier that closed fd 9 cannot buy silence
  # either. SIGTERM rather than SIGKILL: bash flushes on its way out.
  kill -TERM "$$"
}

__probe_guard() {
  local __rest="$1"
  local __word
  local __modifier=""
  local __found
  while :; do
    __word="\${__rest%%[[:space:]]*}"
    case "$__word" in
      "") return 0 ;;
      # A redirection or operator is not a command word (\`exec > /dev/null\`).
      [\\<\\>\\&\\|\\;]*) return 0 ;;
      *=*) ;;
      command | builtin | exec) __modifier="$__word" ;;
      -*)
        [ -n "$__modifier" ] || break
        case "$__modifier:$__word" in
          command:-*p*)
            __probe_refuse "\\\`$__modifier $__word\\\` reaches a binary through its own default PATH"
            return 0
            ;;
        esac
        ;;
      *) break ;;
    esac
    case "$__rest" in
      *[[:space:]]*) __rest="\${__rest#*[[:space:]]}" ;;
      *) return 0 ;;
    esac
  done
  # Everything the probe provides is a function or a builtin, and neither can
  # contain a slash. So a command word with one in it is an executable file by
  # construction, named by a path that never had to resolve through PATH.
  case "$__word" in
    */*)
      __probe_refuse "$__word (an executable path, which no builtin or function can be)"
      return 0
      ;;
  esac
  if __found="$(command -v -- "$__word")"; then return 0; fi
  __probe_refuse "$__word"
}`;

/**
 * `command -p` written into the gate's classifier, found by reading rather than
 * by running. The trap above already reports it, but this names the line the way
 * the helper-set check names a helper, and it fires even for a branch the probe's
 * synthetic paths never take.
 */
const PATH_ESCAPE = /(?:^|[\s;&|(`])command[ \t]+-[A-Za-z]*p/;

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
 * A line is not a fine enough boundary, because a line can carry a trailer:
 * `}; printf owned > file` ends the function AND starts a top-level command. So
 * the scan runs twice — over lines to find the last one, then over the columns
 * of that line to find the first cut that still parses. `}` wins over
 * `}; printf …`, and the trailer stays out of the span.
 *
 * The candidate is sourced in a restricted subshell (`set -r`) with an empty
 * PATH, from a directory the scan `cd`s into first, since restricted mode also
 * forbids a `/` in a `source` argument. Every candidate shorter than the true
 * end leaves the body open, so `source` reports a syntax error and runs none of
 * it — but the one that succeeds executes whatever top-level code it caught,
 * which is exactly the trailer above. Restricted mode is what makes that
 * harmless: no output redirection, no `/` in a command name, and nothing on
 * PATH to find.
 */
const FUNCTION_END_SCAN = `
set -uo pipefail
name="$1"
tail_file="$2"
cand_dir="$3"
cand_base="$4"
max="$5"
empty="$6"

__probe_try() {
  printf '%s__probe_sentinel__() { :; }\\n' "$1" > "$cand_dir/$cand_base"
  (
    cd "$cand_dir"
    PATH="$empty"
    set -r
    # shellcheck disable=SC1090
    source "$cand_base"
    declare -F "$name" && declare -F __probe_sentinel__
  ) > /dev/null 2>&1
}

body=""
n=0
while IFS= read -r line || [[ -n "$line" ]]; do
  n=$((n + 1))
  if __probe_try "$body$line"$'\\n'; then
    k=0
    while [ "$k" -lt "\${#line}" ]; do
      k=$((k + 1))
      if __probe_try "$body\${line:0:$k}"$'\\n'; then
        printf '%s\\t%s\\n' "$n" "$k"
        exit 0
      fi
    done
    printf '%s\\t%s\\n' "$n" "\${#line}"
    exit 0
  fi
  body="$body$line"$'\\n'
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
 * @param {string} [bash] the interpreter to ask; overridable so a test can prove
 *   this works on every bash installed, not only the first one on PATH
 * @returns {string}
 */
export function bashFunctionSource(script, name, label, bash = "bash") {
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
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const max = Math.min(tailLines.length, MAX_FUNCTION_LINES);
    const scan = spawnSync(
      bash,
      ["-s", "--", name, tailPath, dir, "candidate.sh", String(max), empty],
      { input: FUNCTION_END_SCAN, encoding: "utf8" },
    );
    assert.equal(
      scan.status,
      0,
      `could not find where \`${name}\` ends in ${label}: ${`${scan.stdout ?? ""}${scan.stderr ?? ""}`.trim()}`,
    );
    const [endLine, endColumn] = scan.stdout.trim().split("\t").map(Number);
    const lastLine = tailLines[endLine - 1] ?? "";
    assert.ok(
      Number.isInteger(endLine) &&
        endLine >= 1 &&
        endLine <= max &&
        Number.isInteger(endColumn) &&
        endColumn >= 1 &&
        endColumn <= lastLine.length,
      `the end-of-function scan of ${label} reported ${JSON.stringify(scan.stdout)}, which is not a line and column in range`,
    );

    // Whatever follows the closing token on that line is the gate's business,
    // not part of the function — but it has to be something this probe can
    // safely leave behind. A `;` starts a separate command and a `#` starts a
    // comment; anything else (a redirection on the definition itself, say)
    // would change what the function does, so refuse rather than drop it.
    const trailer = lastLine.slice(endColumn).trim();
    assert.ok(
      trailer === "" || trailer.startsWith(";") || trailer.startsWith("#"),
      `\`${name}\` in ${label} ends at line ${endLine} column ${endColumn}, and the rest of that line (${JSON.stringify(trailer)}) ` +
        "is neither a comment nor a separate command, so extracting the function alone would change what it does",
    );

    const head = tailLines.slice(0, endLine - 1);
    const text = `${[...head, lastLine.slice(0, endColumn)].join("\n")}\n`;
    const parse = spawnSync(bash, ["-n"], { input: text, encoding: "utf8" });
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
 * so a wrong span is a thrown assertion rather than a plausible verdict. The
 * classifier then runs with an empty `$PATH` under a DEBUG-trap guard, so a
 * command the probe did not provide is named on stderr before it runs — an
 * installed binary as much as a missing one, and on bash 3.2 as much as 5.x.
 * And the output must be exactly one line per requested path, each with a known
 * class: a probe that classified nothing, classified something twice, or
 * invented a path now reds the test instead of returning a short map whose
 * missing keys read as `undefined`.
 *
 * @param {string[]} paths distinct, free of tabs and newlines — the wire format
 *   is tab-separated, so a path carrying either is rejected, not misparsed
 * @param {{ script?: string, label?: string, bash?: string }} [options] override
 *   the script to read, so the regression tests can drive this whole path with a
 *   fixture, and the interpreter, so they can drive it with every installed bash
 * @returns {Map<string, string>}
 */
export function gateClassifications(
  paths,
  { script = GATE, label = GATE_PATH, bash = "bash" } = {},
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

  const fnSource = bashFunctionSource(script, GATE_CLASSIFIER, label, bash);

  const escape = fnSource
    .split("\n")
    .findIndex((line) => PATH_ESCAPE.test(line));
  assert.equal(
    escape,
    -1,
    `\`${GATE_CLASSIFIER}\` in ${label} runs \`command -p\`, which uses a default PATH that finds the standard ` +
      `utilities whatever the probe sets \`$PATH\` to, so the probe cannot bound what it executes: ` +
      `line ${escape + 1} is ${JSON.stringify(fnSource.split("\n")[escape])}`,
  );

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

  const dir = mkdtempSync(join(tmpdir(), "gate-classify-"));
  let run;
  try {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const program = `
set -uo pipefail
# \`hash -p /bin/cat cat\` binds a name straight to a path, so the empty PATH
# below never sees it AND \`command -v\` reports it as found — a bypass of both
# halves at once, and not a command modifier, so unwrapping cannot reach it.
# Turning hashing off makes \`hash -p\` fail and the lookup miss, on 3.2 and 5.x.
set +h
${restrictPath(empty)}
# The guard's own channel, duplicated from the real stderr while redirections
# are still allowed and before any classifier code can touch it.
exec 9>&2
${PROBE_COMMAND_GUARD}
# From bash 4.0 this fires for a command that resolved nowhere, naming it and
# exiting non-zero. It is a second reading of what the DEBUG trap already
# reports, and defining it on bash 3.2 is inert rather than an error. Its marker
# goes to stdout only: restricted mode below forbids \`>&2\`, and a DEBUG trap and
# this handler both run before the traced command's own redirections apply, so
# stdout reaches the caller even through a \`> /dev/null\` on that command.
command_not_found_handle() {
  __probe_refuse "$1"
  exit 97
}
${fnSource}
${[...GATE_PROBE_STUBS.values()].join("\n")}
declare -F ${GATE_CLASSIFIER} > /dev/null || { printf '%s\\n' '${MISSING_COMMAND_MARKER} the-extracted-source-defined-no-${GATE_CLASSIFIER}'; exit 3; }
# \`set -T\` carries the trap into the classifier, its \`$(…)\` subshells and the
# process substitution feeding its loop — every place a stray command could run.
set -T
trap '__probe_guard "$BASH_COMMAND"' DEBUG
# Restricted mode, last, because it cannot be turned off again and it forbids
# the setup above (PATH assignment, redirections). It refuses a \`/\` in a command
# name, \`command -p\`, \`exec\`, \`enable -f\` and any change to PATH — the whole
# family of ways out of the empty PATH, closed by bash rather than by this
# probe's reading of a command word. The real classifier runs under it: its only
# redirection is the \`< <(…)\` feeding its loop, and input redirection is allowed.
set -r
for __probe_path in "$@"; do
  # Capture the status separately. \`printf … "$(f)"\` reports PRINTF's status, so
  # a classifier that echoes a valid class and then fails reads as a clean run.
  __probe_verdict="$(${GATE_CLASSIFIER})"
  __probe_status=$?
  if [ "$__probe_status" -ne 0 ]; then
    printf '%s\\t${NONZERO_EXIT_MARKER} %s\\n' "$__probe_path" "$__probe_status"
  else
    printf '%s\\t%s\\n' "$__probe_path" "$__probe_verdict"
  fi
done
`;
    run = spawnSync(bash, ["-s", "--", ...paths], {
      input: program,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(
    run.error,
    undefined,
    `the probe shell did not run: ${run.error}`,
  );
  // Whatever the guard managed to say, on fd 9 or wherever else survived.
  const refusals = [
    ...new Set(
      [
        ...`${run.stdout}${run.stderr}`.matchAll(
          new RegExp(`^${MISSING_COMMAND_MARKER} .*$`, "gm"),
        ),
      ].map((match) => match[0].trim()),
    ),
  ];

  // The signal first: it is the report of last resort, and the only one a
  // construct around the offending command cannot swallow. A signalled child
  // reports `status: null`, which the `status` assertion below catches only by
  // being strict (`null !== 0`), so it is checked here on its own terms.
  assert.ok(
    !run.signal,
    `\`${GATE_CLASSIFIER}\` from ${label} ran a command the probe does not provide, and the probe shell ` +
      `stopped itself (${run.signal}) rather than report a verdict computed by something it cannot see. ` +
      (refusals.length > 0
        ? refusals.join("; ")
        : "The command's name did not survive: the classifier ran it inside a construct that consumed the " +
          "diagnostic — a command substitution, or a process substitution whose output it reads — and fd 9, " +
          "which the guard writes to precisely because such a construct cannot capture it, did not carry it " +
          "either. Look for a command the probe does not stub inside a `$(…)` or a `< <(…)`."),
  );
  // A marker without a signal, for any path that reports without terminating.
  assert.equal(
    refusals.length,
    0,
    `\`${GATE_CLASSIFIER}\` from ${label} ran a command the probe does not provide, so its verdicts are partial: ` +
      `${refusals.join("; ")}`,
  );
  assert.ok(
    !run.stdout.includes(NONZERO_EXIT_MARKER),
    `\`${GATE_CLASSIFIER}\` from ${label} printed a class and then returned non-zero; a classifier that fails ` +
      `has not classified anything, whatever it echoed on the way out: ${run.stdout.trim()}`,
  );
  // The probe shell has nothing legitimate to say on stderr. Asserting it is
  // EMPTY rather than scanning it for a phrase catches bash's own `command not
  // found` and `restricted:` refusals, an unset variable under `set -u`, and any
  // diagnostic in a locale this check has never seen.
  assert.equal(
    run.stderr,
    "",
    `\`${GATE_CLASSIFIER}\` from ${label} wrote to stderr, so its verdicts cannot be trusted: ${run.stderr.trim()}` +
      // `restricted:` reads like a probe defect to whoever hits it, and they go
      // looking in the wrong file. Say whose choice it was and what to do.
      (run.stderr.includes("restricted:") ? RESTRICTED_MODE_EXPLANATION : ""),
  );
  assert.equal(
    run.status,
    0,
    `the probe shell running \`${GATE_CLASSIFIER}\` from ${label} exited ${run.status}: ${run.stdout.trim()}`,
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

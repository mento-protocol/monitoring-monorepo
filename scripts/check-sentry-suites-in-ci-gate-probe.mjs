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
 * Lifting the function, and the shells that do it, live in
 * check-sentry-suites-in-ci-gate-extract.mjs; what stays here is the
 * classifier-specific part built on top. Both were split out of
 * check-sentry-suites-in-ci-probes.mjs to keep each under the repo's 1,000-line
 * cap, and that module re-exports them, so the tests import one facade.
 *
 * KNOWN RESIDUALS — what this probe does not observe, and why it stops there.
 * The probe reads a first-party, code-reviewed gate script; its job is to catch
 * drift and mistake, not to withstand an author who could edit this file just as
 * easily. Each of these leaves the verdicts it reports about honest classifiers
 * correct.
 *
 *   Reading host state. The empty working directory removes the checkout from
 *   any RELATIVE read, so `[[ -f package.json ]]`, a glob and `test -e` all
 *   observe nothing. Two forms remain: an ABSOLUTE path (`[[ -f /etc/passwd ]]`),
 *   and `$(< file)` nested inside a conditional, which the coarse `[[ … ]]` strip
 *   removes before the `<` inside it is seen and which runs no command for the
 *   DEBUG guard to catch. Both observe host state no synthetic input controls.
 *   Closing them needs either filesystem isolation bash cannot provide, or
 *   `case`-aware parsing of bash source — and the second is the class of textual
 *   heuristic that produced most of the defects this module has already fixed.
 *
 *   Untaken branches. The DEBUG guard is authoritative for every branch the
 *   synthetic paths exercise: whatever runs is checked before it runs. The
 *   read-time scans are best-effort over the rest, so an external command
 *   reachable only from a branch no synthetic path enters is not detected. The
 *   verdicts stay correct — that branch never ran — what is missing is assurance
 *   about code that was not exercised. If a later synthetic path does reach it,
 *   the guard catches it then.
 *
 *   A same-line trailer on the closing brace runs once while the extractor finds
 *   the closing column, bounded by restricted mode and the empty PATH rather
 *   than prevented; see check-sentry-suites-in-ci-gate-extract.mjs.
 *
 *   The textual guard alone, on bash 3.2 with a command's stderr closed. This is
 *   the enabler behind a family of reports rather than a doorway of its own, and
 *   it is worth stating once. Three layers normally see an unprovided command:
 *   `command_not_found_handle` (bash 4.0+), bash's own `command not found` on
 *   stderr, and this module's DEBUG-trap guard. On 3.2 the first does not exist,
 *   and `2>&-` removes the second — so a `LABEL=… cat …` shape is detected only
 *   if the guard's own word splitting is right, and every mis-split there has
 *   been silent under exactly those two conditions. `trap - DEBUG` inside the
 *   classifier removes the guard as well, leaving nothing; that needs a
 *   classifier manipulating its own trap, which no honest edit does. The guard
 *   is textual because the alternative is `case`-aware parsing of bash source,
 *   which is the class of heuristic that produced most of the defects already
 *   fixed here. A backstop that does not parse at all — reporting any non-zero
 *   command exit — would close the family; see the note on `set -e`/ERR-trap
 *   semantics in the PR discussion before attempting it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASH_DEFINITION,
  bashFunctionSource,
  definedName,
  probeDirs,
  PROBE_TIMEOUT_MS,
  runProbeShell,
} from "./check-sentry-suites-in-ci-gate-extract.mjs";

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
 * Pin the variables bash invents for itself, which no environment can reach.
 *
 * `probeEnv` decides what the shell is GIVEN; bash then creates its own, and
 * several of them describe the machine. `OSTYPE` reads `darwin25.4.0` here,
 * `darwin25` under 3.2 and `linux-gnu` on a runner, so a classifier branching on
 * it — an ordinary thing to write, since macOS and GNU tooling differ — is
 * machine-specific however clean the environment is. Enumerated with `compgen -v`
 * on both interpreters rather than guessed; these are the ones that both describe
 * the machine and can be reassigned. Assigning a sentinel rather than unsetting
 * keeps a `case "$OSTYPE" in …` reaching its default arm instead of tripping
 * `set -u`, and the value says where it came from if it ever surfaces.
 *
 * `BASH_LOADABLES_PATH` is here because it points into the interpreter's install
 * tree; `enable -f` is already refused by restricted mode, so this is only tidy.
 *
 * Redirecting the group's stderr matters: the assignments run before `set -r`
 * (which forbids redirection), and a bash that treats one of these as readonly
 * should be stepped over rather than allowed to write to the stderr the caller
 * asserts is empty.
 */
const FIX_SHELL_CREATED_VARS = `{
  OSTYPE=__probe_fixed__
  HOSTTYPE=__probe_fixed__
  MACHTYPE=__probe_fixed__
  HOSTNAME=__probe_fixed__
  SHELL=__probe_fixed__
  TERM=__probe_fixed__
  BASH_LOADABLES_PATH=__probe_fixed__
} 2> /dev/null`;

/**
 * Appended when the classifier reads something the probe did not supply. Same
 * job as the restricted-mode text below: say whose rule this is and what to do,
 * so the reader does not go looking for a bug in the gate.
 */
const READ_ONLY_STUB_EXPLANATION =
  `\n\nThe probe re-runs \`${GATE_CLASSIFIER}\` against synthetic change paths, so its verdict has to be a ` +
  "function of those paths and nothing else. A redirection that reads a file makes it a function of the " +
  "machine — the same drift the stubbed-helper check exists to stop, reaching the classifier through a " +
  "redirection instead of a command. Allowed: `< <(json_change_paths …)`, heredocs and here-strings, which " +
  "read text out of the script itself. The fix is to take the input from `json_change_paths` (which the " +
  "probe stubs) rather than from the filesystem. If the classifier genuinely must read a file, this probe " +
  "has to stub that too — see scripts/check-sentry-suites-in-ci-gate-probe.mjs. Note this check is textual, " +
  "so a `<` inside a string literal is reported as well and simply needs rewording.";

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

# Split one word off "$1" into __word, leaving the remainder in __rest.
#
# Splitting on the first space is not enough, because a value can contain one:
# in \`LABEL="two words" cat …\` the first space falls INSIDE the assignment, and
# a naive split leaves \`LABEL="two\` — a fragment, from which the guard used to
# give up and stop checking \`cat\` at all. Tracking quotes and \`$( … )\` keeps a
# value whole, so \`LABEL="two words"\` is one word and \`cat\` is the next, while
# \`seen="$(printf '%s' "$x")"\` is a single word with no command after it.
#
# Only the leading words of a command are ever scanned — the loop below stops at
# the first word that is not an assignment or a modifier — so this walks a few
# characters per traced command, not the whole line.
__probe_take() {
  local __s="$1"
  local __c
  local __q=""
  local __depth=0
  __word=""
  while [ -n "$__s" ]; do
    __c="\${__s:0:1}"
    __s="\${__s:1}"
    if [ -n "$__q" ]; then
      # Inside double quotes a backslash still escapes the closing quote, so it
      # has to consume the next character or the word ends early — which is how
      # \`LABEL="x \\" : y" cat\` used to end at the escaped quote, leaving \`:\`
      # to look like the command and \`cat\` unchecked. Single quotes escape
      # nothing, so the backslash there is an ordinary character.
      if [ "$__q" = '"' ] && [ "$__c" = '\\' ] && [ -n "$__s" ]; then
        __word="$__word$__c\${__s:0:1}"
        __s="\${__s:1}"
        continue
      fi
      __word="$__word$__c"
      if [ "$__c" = "$__q" ]; then __q=""; fi
      continue
    fi
    case "$__c" in
      # Unquoted, a backslash escapes whatever follows — including a space, a
      # quote, and a \`$\` that would otherwise open a substitution.
      '\\')
        if [ -n "$__s" ]; then
          __word="$__word$__c\${__s:0:1}"
          __s="\${__s:1}"
        else
          __word="$__word$__c"
        fi
        ;;
      '"' | "'")
        __q="$__c"
        __word="$__word$__c"
        ;;
      '$')
        __word="$__word$__c"
        case "$__s" in "("*) __depth=$((__depth + 1)) ;; esac
        ;;
      ')')
        if [ "$__depth" -gt 0 ]; then __depth=$((__depth - 1)); fi
        __word="$__word$__c"
        ;;
      ' ' | '	')
        if [ "$__depth" -gt 0 ]; then __word="$__word$__c"; else break; fi
        ;;
      *) __word="$__word$__c" ;;
    esac
  done
  while [ -n "$__s" ]; do
    case "\${__s:0:1}" in
      ' ' | '	') __s="\${__s:1}" ;;
      *) break ;;
    esac
  done
  __rest="$__s"
}

__probe_guard() {
  local __rest="$1"
  local __word=""
  local __modifier=""
  local __found
  while :; do
    __probe_take "$__rest"
    case "$__word" in
      "") return 0 ;;
      # A redirection or operator is not a command word (\`exec > /dev/null\`).
      [\\<\\>\\&\\|\\;]*) return 0 ;;
      # A whole \`VAR=value\` word is a prefix; the command follows it.
      [A-Za-z_]*=*) ;;
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
    if [ -z "$__rest" ]; then return 0; fi
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
 * An input redirection that reads something other than the stub.
 *
 * The verdict is supposed to be a function of the synthetic change paths this
 * probe feeds in, and nothing else. A `read` from a file makes it a function of
 * the machine instead, which is the same drift the helper-set check exists to
 * stop — it slips that check only because a redirection is not a command, an
 * accident of where the guard looks rather than a decision.
 *
 * Read at extraction time rather than watched at run time, because
 * `$BASH_COMMAND` carries a SIMPLE command's redirection but not a compound
 * one's: `while IFS= read -r l; do :; done < /etc/passwd` reports only
 * `IFS= read -r l` on both interpreters, and that missing half is the shape the
 * classifier's own loop uses.
 *
 * What is stripped before looking for a `<` is what legitimately reads inline:
 * `[[ … ]]` and `(( … ))`, where `<` compares; here-strings and heredocs, which
 * read text out of the script; and `< <(…)`, the gate loop's own input. The
 * matching is textual, so it errs loud — a `<` in a string literal is reported.
 *
 * The boundary was measured rather than assumed: every plain `< file` an
 * ordinary classifier could write is caught — on the conditional, beside it, on
 * the enclosing loop — as is `$(< file)` OUTSIDE a conditional. Only the nested
 * form slips, which is part of the reading-host-state residual at the top of
 * this file.
 *
 * @param {string} source
 * @returns {Array<[number, string]>} [1-based line number, line]
 */
export function inputRedirections(source) {
  return source
    .split("\n")
    .map((line, index) => [index + 1, line])
    .filter(([, line]) =>
      line
        .replace(/\[\[.*?\]\]/g, "")
        .replace(/\(\(.*?\)\)/g, "")
        .replace(/<<</g, "")
        .replace(/<<-?/g, "")
        .replace(/<\s*<\(/g, "")
        .includes("<"),
    );
}

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
 * @param {{ script?: string, label?: string, bash?: string, timeoutMs?: number }}
 *   [options] override the script to read, so the regression tests can drive
 *   this whole path with a fixture; the interpreter, so they can drive it with
 *   every installed bash; and the timeout, so the test for a nonterminating
 *   classifier need not wait the full production bound to prove it
 * @returns {Map<string, string>}
 */
export function gateClassifications(
  paths,
  {
    script = GATE,
    label = GATE_PATH,
    bash = "bash",
    timeoutMs = PROBE_TIMEOUT_MS,
  } = {},
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

  // `"new_helper"` and `\new_helper` are ordinary calls that a left-boundary
  // match misses, because the character before the name is a quote or a
  // backslash. Removing those characters catches both. Line breaks survive, so
  // line numbers still line up with the original. Both read-time scans below use
  // it: they ask the same question about the same text, and one of them seeing
  // through quoting while the other did not was an inconsistency, not a policy.
  // A name inside a string is then a false positive — loud, and fixed by naming
  // the helper in GATE_PROBE_STUBS or rewording, which is the safe direction.
  const unquoted = fnSource.replace(/["'\\]/g, "");

  const escape = fnSource
    .split("\n")
    .findIndex(
      (line, index) =>
        PATH_ESCAPE.test(line) ||
        PATH_ESCAPE.test(unquoted.split("\n")[index] ?? ""),
    );
  assert.equal(
    escape,
    -1,
    `\`${GATE_CLASSIFIER}\` in ${label} runs \`command -p\`, which uses a default PATH that finds the standard ` +
      `utilities whatever the probe sets \`$PATH\` to, so the probe cannot bound what it executes: ` +
      `line ${escape + 1} is ${JSON.stringify(fnSource.split("\n")[escape])}`,
  );

  const reads = inputRedirections(fnSource);
  assert.deepEqual(
    reads,
    [],
    `\`${GATE_CLASSIFIER}\` in ${label} reads something the probe did not supply: ` +
      `${reads.map(([line, text]) => `line ${line} is ${JSON.stringify(text.trim())}`).join("; ")}.` +
      READ_ONLY_STUB_EXPLANATION,
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
    .filter((helper) => {
      const call = new RegExp(
        `(?:^|[\\s;&|(\`])${helper}(?![A-Za-z0-9_])`,
        "m",
      );
      return call.test(fnSource) || call.test(unquoted);
    })
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
    const dirs = probeDirs(dir);
    const program = `
set -uo pipefail
# \`hash -p /bin/cat cat\` binds a name straight to a path, so the empty PATH
# below never sees it AND \`command -v\` reports it as found — a bypass of both
# halves at once, and not a command modifier, so unwrapping cannot reach it.
# Turning hashing off makes \`hash -p\` fail and the lookup miss, on 3.2 and 5.x.
set +h
${FIX_SHELL_CREATED_VARS}
${restrictPath(dirs.empty)}
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
    run = runProbeShell(bash, ["-s", "--", ...paths], {
      input: program,
      // A fresh empty directory, so the checkout is not reachable at all. This
      // is what closes ambient filesystem reads without naming the primitives
      // that can make them: `[[ -f package.json ]]` is false, a glob matches
      // nothing, and `test -e` finds nothing, because there is nothing there.
      // The classifier's only legitimate input is the stubbed
      // `json_change_paths`, so it has no business reading the tree anyway.
      dirs,
      timeout: timeoutMs,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A timeout also arrives as a signal, so it is read first — otherwise a
  // classifier that never terminates would be reported as one that ran a
  // command the probe does not provide.
  assert.notEqual(
    run.error?.code,
    "ETIMEDOUT",
    `\`${GATE_CLASSIFIER}\` from ${label} did not terminate within ${timeoutMs}ms. A classifier is a \`case\` ` +
      "over the change paths and should finish in milliseconds; look for a loop in it that never ends, or a " +
      "`read` waiting on input the probe does not supply.",
  );
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

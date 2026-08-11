/**
 * Lifting a bash function out of a shell script, and the shells that do it.
 *
 * Two layers, split from check-sentry-suites-in-ci-gate-probe.mjs so both stay
 * under the repo's 1,000-line cap (GitHub issue #1803).
 *
 * The lower layer runs a probe shell at all: a fixed environment inheriting
 * nothing, directories the probe owns, a deadline that reaches the whole process
 * group, and an interpreter resolved to an absolute path so the shell can carry
 * its own `$PATH` without changing WHICH bash runs.
 *
 * The upper layer is `bashFunctionSource`, which asks bash where a function
 * ends rather than looking for a closing brace, because a textual terminator
 * cannot see a heredoc, a quoted `}`, or a trailer sharing the closing line.
 *
 * The classifier-specific probe built on top — the guard, the read-time source
 * checks and `gateClassifications` — stays next door.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How long any probe shell may run before it is killed and reported.
 *
 * The classifier is a `case` statement over a handful of synthetic paths, and
 * the extraction sources ~50 candidate prefixes. Measured against the real gate
 * they take 130ms and 75ms. 30 seconds is roughly 200x the slower of the two,
 * which a loaded CI runner cannot plausibly need and a `while :; do :; done`
 * cannot plausibly finish inside. Without a bound, such a loop hangs the routing
 * test until whatever outer limit the job has, reported as a job timeout rather
 * than as a broken classifier.
 */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * Run a probe shell with a deadline, and make the deadline reach its children.
 *
 * `spawnSync`'s own `timeout` signals the shell it started and nothing else. The
 * classifier runs inside a `$(…)`, which is a separate process: killing the
 * parent leaves it spinning, reparented to init, burning a core until someone
 * notices. Measured, not assumed — a `while :; do :; done` fixture left two such
 * processes behind at 43% CPU each.
 *
 * So the shell is started `detached`, which makes it a process-group leader, and
 * on timeout the whole group is killed by negative pid. Everything the probe
 * started is in that group; nothing else is.
 *
 * @param {string} bash
 * @param {string[]} args
 * @param {object} options
 */
export const runProbeShell = (bash, args, { dirs, ...options }) => {
  const result = spawnSync(resolveInterpreter(bash), args, {
    ...options,
    encoding: "utf8",
    cwd: dirs.empty,
    env: probeEnv(dirs),
    detached: true,
  });
  if (result.error?.code === "ETIMEDOUT" && typeof result.pid === "number") {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {
      // The group is already gone, which is the outcome this wanted.
    }
  }
  return result;
};

/**
 * A fixed environment for every probe shell, inheriting NOTHING.
 *
 * The verdict has to be a function of the classifier and the change paths the
 * probe supplies. Any inherited value makes it a function of who ran the check
 * instead: a classifier that branches on `CI`, or on `HOME`, would be read one
 * way on a laptop and another on a runner, and the probe would call both
 * correct. Allowlisting the NAMES was not enough — passing their operator values
 * through narrowed the surface without closing it.
 *
 * So every variable the shell gets is one the probe chose:
 *
 *   PATH   — the empty directory, which is what the program sets internally too.
 *   HOME   — a probe-created directory. Nothing should read it; now nothing can
 *            learn anything from it if it does.
 *   TMPDIR — a probe-created directory. bash 3.2 writes every heredoc to a temp
 *            file, so owning this isolates those files instead of scattering
 *            them through the operator's temp directory.
 *   LC_ALL — `C`, so bash's own diagnostics are in a language the assertions read.
 *
 * With this, the working directory and the timeout, the probe's inputs are the
 * classifier's text and the synthetic paths. Two things still vary by machine
 * and are named rather than left unstated. The bash BUILD is one: the probe runs
 * whichever interpreter it is pointed at, and 3.2 and 5.x have genuinely
 * disagreed about these fixtures, which is why the tests drive every bash
 * installed rather than assuming one. The other is the literal VALUE of `HOME`
 * and `TMPDIR`, which is a fresh temp path per run — a classifier reading either
 * gets a different string each time, so it can learn nothing stable from them,
 * but it would not get a constant either.
 *
 * @param {{ empty: string, home: string, temp: string }} dirs
 */
const probeEnv = ({ empty, home, temp }) => ({
  LC_ALL: "C",
  PATH: empty,
  HOME: home,
  TMPDIR: temp,
});

/**
 * The three probe-owned directories a shell runs against, created under `dir`.
 *
 * @param {string} dir
 */
export const probeDirs = (dir) => {
  const dirs = {
    empty: join(dir, "empty"),
    home: join(dir, "home"),
    temp: join(dir, "tmp"),
  };
  for (const path of Object.values(dirs)) mkdirSync(path);
  return dirs;
};

/** Resolved absolute path of each interpreter this process has been asked for. */
const resolvedInterpreters = new Map();

/**
 * The absolute path of a bash, so the probe shells can run with a `$PATH` of
 * their own without changing WHICH bash runs.
 *
 * Node resolves a bare `bash` through the CHILD's `$PATH`: give the child a
 * probe-owned one and the lookup fails with ENOENT; give it none and the lookup
 * silently falls back to the system default, which is `/bin/bash` — on macOS
 * that is 3.2, so a developer's newer bash would be swapped out from under the
 * check without a word. Resolving once against the operator's `$PATH`, and using
 * the absolute answer everywhere after, keeps the interpreter and drops the
 * variable.
 *
 * @param {string} bash
 */
const resolveInterpreter = (bash) => {
  if (!resolvedInterpreters.has(bash)) {
    const found = spawnSync(bash, ["-c", 'printf "%s" "$BASH"'], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: PROBE_TIMEOUT_MS,
    });
    assert.ok(
      !found.error && found.status === 0,
      `could not resolve the \`${bash}\` interpreter: ${found.error ?? `exit ${found.status}`}`,
    );
    const resolved = found.stdout.trim();
    assert.ok(
      resolved.startsWith("/"),
      `\`${bash}\` reported its own path as ${JSON.stringify(resolved)}, which is not absolute`,
    );
    resolvedInterpreters.set(bash, resolved);
  }
  return resolvedInterpreters.get(bash);
};

/**
 * How far past a definition the end-of-function scan will look. The gate's
 * classifier is ~50 lines and the scan rewrites a growing candidate per line, so
 * an unbounded walk over a gate whose function never closes would grind through
 * the rest of the file. Running out is reported, not absorbed.
 */
const MAX_FUNCTION_LINES = 500;

/**
 * A bash function definition, at any indentation, in every form bash accepts:
 * `name() {`, `function name {`, and `function name() {`, with or without a
 * trailing comment. Matching all of them is the point — an exact-string header
 * match reads a `function`-keyword variant as "the function is gone", reads a
 * nested indented redefinition as absent, and read `name() { # why` as neither a
 * definition nor an error, which broke the probe outright on ordinary style.
 */
export const BASH_DEFINITION =
  /^[ \t]*(?:function[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*\([ \t]*\))?|([A-Za-z_][A-Za-z0-9_]*)[ \t]*\([ \t]*\))[ \t]*\{?[ \t]*(?:#.*)?$/gm;

/** The name a `BASH_DEFINITION` match defines, from whichever form matched. */
export const definedName = (match) => match[1] ?? match[2];

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
 *
 * Named residual: a same-line trailer on the closing brace runs ONCE here, while
 * the scan determines the closing column, and restricted mode bounds it rather
 * than preventing it — `kill`, for instance, is a builtin and stays available.
 * Closing that would mean finding the column without sourcing the line at all.
 * It is accepted because reaching it needs a destructive command written onto
 * the closing-brace line of this repo's own reviewed gate script, which is the
 * threat model the PR for this probe states: drift and mistake, not an author
 * who could edit this file just as easily.
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
    const dirs = probeDirs(dir);
    const max = Math.min(tailLines.length, MAX_FUNCTION_LINES);
    const scan = runProbeShell(
      bash,
      [
        "-s",
        "--",
        name,
        tailPath,
        dir,
        "candidate.sh",
        String(max),
        dirs.empty,
      ],
      { input: FUNCTION_END_SCAN, dirs, timeout: PROBE_TIMEOUT_MS },
    );
    // The candidate that completes the definition also runs whatever top-level
    // code shared its last line, so this scan is not immune to a loop either.
    assert.notEqual(
      scan.error?.code,
      "ETIMEDOUT",
      `finding where \`${name}\` ends in ${label} did not finish within ${PROBE_TIMEOUT_MS}ms — a candidate the scan sourced did not terminate`,
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
    const parse = runProbeShell(bash, ["-n"], {
      input: text,
      dirs,
      timeout: PROBE_TIMEOUT_MS,
    });
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

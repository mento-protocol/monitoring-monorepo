/**
 * The command-grammar and package.json-alias predicates behind
 * scripts/sentry/ci-wiring/check-sentry-suites-in-ci.test.mjs.
 *
 * Split out of check-sentry-suites-in-ci-core.mjs to keep both under the repo's
 * 1,000-line cap; the core module re-exports every public name here, so no
 * importer changes. Like the core, nothing here reads a file or closes over
 * repo state: each function takes the structure it judges as an argument.
 */

// ── shell command grammar ────────────────────────────────────────────────────

/**
 * Characters a bare word may contain. Everything that can redirect, chain,
 * background, group, substitute, glob, or quote is absent, so a line built
 * only from these words is a single simple command whose exit status the
 * step's `bash -e` propagates.
 */
const BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Words that stop a line from being a simple command, or that change the
 * shell state the exit-status reasoning rests on. `set +e` is the obvious one;
 * the keywords matter because `if pnpm x` puts `pnpm x` in a condition, where
 * a failure is swallowed.
 */
const NOT_A_SIMPLE_COMMAND = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "time",
  "set",
  "shopt",
  "trap",
  "exec",
  "eval",
  "source",
  ".",
  "export",
  "declare",
  "local",
  "readonly",
  "alias",
  "unalias",
  "exit",
  "return",
  "break",
  "continue",
]);

/**
 * Split a shell script into the simple commands it runs, or explain why it
 * cannot be read that way.
 *
 * An allowlist, not a blacklist of dangerous suffixes: a line counts only when
 * every word is bare. `pnpm sentry:requeue:test || true` fails because `|` is
 * not a bare-word character, and so does `; true`, `|| :`, a trailing `&`, a
 * `$(…)`, and a redirect. Blacklisting suffixes would have to enumerate those;
 * this cannot miss one.
 *
 * @param {string} script
 * @returns {{ commands: string[][], blocker: string | null }}
 */
export function parseShellScript(script) {
  const commands = [];
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const words = trimmed.split(/[ \t]+/);
    if (!words.every((word) => BARE_WORD.test(word))) {
      return {
        commands: [],
        blocker: `\`${trimmed}\` is not a plain command — shell syntax here can mask a non-zero exit`,
      };
    }
    if (NOT_A_SIMPLE_COMMAND.has(words[0])) {
      return {
        commands: [],
        blocker: `\`${trimmed}\` starts with \`${words[0]}\`, which can change the shell state or swallow a failure`,
      };
    }
    commands.push(words);
  }
  return { commands, blocker: null };
}

/**
 * @param {string[]} command
 * @param {string[]} target
 */
export function isCommand(command, target) {
  return (
    command.length === target.length &&
    command.every((word, index) => word === target[index])
  );
}

/**
 * Does any command match `target` exactly?
 *
 * Exact, not prefix-with-extra-arguments: `node scripts/x.test.mjs
 * --test-name-pattern=nothing` runs the file and asserts nothing, and
 * `--test-only` does the same. A trailing argument is as good a bypass as a
 * trailing `|| true`, so neither is accepted.
 *
 * @param {string[][]} commands
 * @param {string[]} target
 */
export function runsCommand(commands, target) {
  return commands.some((command) => isCommand(command, target));
}

// ── package.json aliases ─────────────────────────────────────────────────────

/** The command forms that count as running `file`. @param {string} file */
export function suiteTargets(file) {
  return [
    ["node", file],
    ["node", "--test", file],
  ];
}

/**
 * Does this package-script command run one of `targets` and nothing else?
 *
 * Exactly one command, not "one of its commands": a package script is handed to
 * a shell WITHOUT `-e`, so in `"node scripts/x.test.mjs\ntrue"` the second line
 * decides the alias's exit status and the suite's failures are swallowed. The
 * invoking CI step's own `bash -e` does not reach inside the script it runs.
 *
 * @param {unknown} command
 * @param {string[][]} targets
 */
export function commandRunsOnly(command, targets) {
  if (typeof command !== "string") return false;
  const { commands } = parseShellScript(command);
  return (
    commands.length === 1 &&
    targets.some((target) => isCommand(commands[0], target))
  );
}

/**
 * The package.json aliases that actually run this suite file.
 *
 * The command is tokenized and matched whole, so
 * `"sentry:ingest:test": "echo scripts/x.mjs"`,
 * `"sentry:ingest:test": "node scripts/x.mjs || true"`, and
 * `"sentry:ingest:test": "node scripts/x.mjs\ntrue"` all fail to resolve — the
 * CI step would run, the suite would not.
 *
 * @param {Record<string, unknown>} scripts package.json's `scripts` map
 * @param {string} file repo-relative path, e.g. `scripts/sentry-x.test.mjs`
 */
export function aliasesFor(scripts, file) {
  const targets = suiteTargets(file);
  return Object.entries(scripts)
    .filter(([, command]) => commandRunsOnly(command, targets))
    .map(([name]) => name);
}

/**
 * Every way a job may invoke this suite.
 *
 * @param {Record<string, unknown>} scripts
 * @param {string} file
 */
export function invocationsOf(scripts, file) {
  const targets = suiteTargets(file);
  for (const alias of aliasesFor(scripts, file)) {
    targets.push(["pnpm", alias], ["pnpm", "run", alias]);
  }
  return targets;
}

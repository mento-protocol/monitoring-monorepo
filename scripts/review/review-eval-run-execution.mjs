// Scoring-process execution, environment scrubbing, and fixture reset.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultRunGit } from "./review-eval-fixtures.mjs";
// The parser and the envelope live in a dependency-free module of their own:
// the orchestrator's sealed source snapshot carries that file and the cell
// writer loads its parser out of the snapshot, not out of the live checkout.
import {
  claudeStreamEnvelope,
  parseClaudeStream,
  SESSION_TEXT_BUDGET_CHARS,
  sessionText,
} from "./review-eval-stream.mjs";

const CLAUDE_MAX_TURNS = 80;
const CLAUDE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "Agent",
  "TodoWrite",
];
const EXEC_TIMEOUT_MS = 3_600_000;
const EXEC_MAX_OUTPUT_CHARS = 64 * 1024 * 1024;
// The GitHub credentials a judge must never inherit. `run-eval.sh` scrubs the
// same four for a contestant cell; the scoring pass runs the novel judge with
// `Bash` inside the fixture, so it needs the same treatment.
export const SCRUBBED_ENV_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GH_ENTERPRISE_TOKEN",
];

// The path-bearing variables a judge must never inherit. `run-eval.sh` scrubs
// the same family per cell: pnpm exports `INIT_CWD`, `PNPM_SCRIPT_SRC_DIR`,
// `npm_config_local_prefix` and more into every script it runs, each naming the
// checkout the frozen answer key lives in, and the family is open-ended, so it
// is matched by name pattern rather than enumerated. `OLDPWD` and `PWD` hand
// over a directory the same way: `claude` is not a shell, so it carries the
// inherited value rather than re-deriving it from the `cwd` it was spawned in.
const SOURCE_PATH_ENV_PATTERN = /^(?:npm_|PNPM_)/;
const SOURCE_PATH_ENV_VARS = ["INIT_CWD", "NODE_PATH", "OLDPWD", "PWD"];

// This module's own checkout. Under the documented `pnpm review:eval:run` the
// scoring pass reads its harness out of the spec worktree, and that worktree
// carries `docs/evals/review-skill-truth/` — so the tree this file was loaded
// from is the first path a judge must not be handed.
const MODULE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function realOrSelf(target) {
  const resolved = path.resolve(String(target));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The checkouts a scoring subprocess must not be given a path into: this
 * module's own tree, plus whatever the pnpm variables named before they were
 * dropped. A caller that knows another root — `--root` naming a third checkout
 * — passes it as `roots`.
 */
export function sourceCheckouts({ env = process.env, roots = [] } = {}) {
  return [
    ...new Set(
      [
        MODULE_ROOT,
        env.INIT_CWD,
        env.npm_config_local_prefix,
        env.PNPM_SCRIPT_SRC_DIR,
        ...roots,
      ]
        .filter(Boolean)
        .map(realOrSelf),
    ),
  ];
}

/**
 * `PATH` minus every entry that resolves inside one of those checkouts.
 *
 * It is the last path-bearing variable, and it survives the scrub above because
 * a judge still needs node and git: under `pnpm review:eval:run` pnpm prepends
 * `<checkout>/node_modules/.bin`, which hands a `Bash`-enabled judge the
 * checkout root the variable scrub just took away. Entries are compared
 * canonically as well as literally, because a symlinked `node_modules/.bin`
 * passes a string comparison and still lands in the repository.
 */
export function scrubPath(value, checkouts = sourceCheckouts()) {
  return String(value ?? "")
    .split(path.delimiter)
    .filter((entry) => {
      if (!entry) return false;
      const real = realOrSelf(entry);
      return !checkouts.some(
        (root) =>
          real === root ||
          real.startsWith(`${root}${path.sep}`) ||
          entry === root ||
          entry.startsWith(`${root}${path.sep}`),
      );
    })
    .join(path.delimiter);
}

let scrubbedGhConfigDir = null;

/** An empty `gh` config directory, created once per process. */
function emptyGhConfigDir() {
  if (!scrubbedGhConfigDir) {
    scrubbedGhConfigDir = mkdtempSync(path.join(tmpdir(), "review-eval-gh-"));
  }
  return scrubbedGhConfigDir;
}

/**
 * The environment a scoring subprocess runs under. It mirrors the per-cell
 * `CELL_ENV` in `run-eval.sh`: no GitHub token, an empty `gh` config
 * directory, and a git with no credential helper, no prompt, no askpass and
 * no protocol but `file`. The model API stays reachable, so this is defense in
 * depth against prompt-injected fixture content, not containment.
 *
 * The same shell's source-path treatment applies here too, and for the same
 * reason: `classifyNovel` gives its judge `Bash` inside the fixture, so a
 * prompt-injected claim that follows an inherited `INIT_CWD` or a
 * `node_modules/.bin` entry on `PATH` reaches `docs/evals/review-skill-truth/`
 * and contaminates `novel_real` and `wrong_claims` — and unlike contestant
 * output, a judge's reading of the key passes through no `leakSignals()`.
 */
export function scrubbedEnv({
  env = process.env,
  ghConfigDir = emptyGhConfigDir(),
  roots = [],
} = {}) {
  const scrubbed = { ...env };
  for (const name of SCRUBBED_ENV_VARS) delete scrubbed[name];
  const checkouts = sourceCheckouts({ env, roots });
  for (const name of Object.keys(scrubbed)) {
    if (
      SOURCE_PATH_ENV_PATTERN.test(name) ||
      SOURCE_PATH_ENV_VARS.includes(name)
    ) {
      delete scrubbed[name];
    }
  }
  return {
    ...scrubbed,
    PATH: scrubPath(env.PATH, checkouts),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_ALLOW_PROTOCOL: "file",
    GH_CONFIG_DIR: ghConfigDir,
  };
}

/**
 * The default model call for `--score`: one non-interactive Claude session.
 *
 * It spawns asynchronously on purpose. `runCalibration` replays forty frozen
 * pairs through four workers, and a synchronous spawn blocks the event loop,
 * so every one of those calls would queue behind the last one and the
 * configured concurrency would buy nothing.
 */
export function claudeArgv({
  prompt,
  model,
  effort,
  allowedTools = CLAUDE_TOOLS,
  maxTurns = CLAUDE_MAX_TURNS,
}) {
  return [
    "-p",
    prompt,
    "--model",
    model,
    "--effort",
    effort,
    "--setting-sources",
    "",
    // The stream, not the single-shot envelope. `--output-format json` reports
    // only the last assistant message in its `result` field, so a reviewer that
    // files its report, runs one more tool call and then posts a short addendum
    // is scored on the addendum alone. `claudeStreamEnvelope()` rebuilds the
    // envelope the rest of the harness reads from the session.
    // `--verbose` is what the CLI requires beside `stream-json` under `-p`.
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    // `--allowed-tools` grants permission but does not limit which built-in
    // tools the model can see. `--tools` owns availability. Pass the requested
    // set through both controls. Its comma-joined value also keeps the variadic
    // options from swallowing the next flag. An empty set must use the CLI's
    // explicit `--tools ""` form, or the default tools remain available and a
    // blind judge can spend its only turn on a tool call and exit without JSON.
    ...(allowedTools.length > 0
      ? ["--tools", allowedTools.join(","), "--allowed-tools", ...allowedTools]
      : ["--tools", ""]),
    "--max-turns",
    String(maxTurns),
  ];
}

// The stream parser and the session envelope are re-exported so every existing
// importer of this module keeps its import path.
export {
  claudeStreamEnvelope,
  parseClaudeStream,
  sessionText,
  SESSION_TEXT_BUDGET_CHARS,
};

export function claudeExec({
  prompt,
  model,
  effort,
  cwd = process.cwd(),
  allowedTools = CLAUDE_TOOLS,
  maxTurns = CLAUDE_MAX_TURNS,
  env = scrubbedEnv(),
  // Every caller of this function is a judge: the scoring pass, the calibration
  // replays, and the experiment lane's extract, match and novelty calls. A
  // judge's answer is its final message, so its envelope keeps final-message
  // `result` semantics. Contestant cells run through their own lane and ask for
  // the whole session.
  resultText = "final",
}) {
  const args = claudeArgv({ prompt, model, effort, allowedTools, maxTurns });
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    // The same wall clock `spawnSync` enforced, and the same output ceiling: a
    // judge that never returns must fail its cell, not hold the run open. The
    // ceiling now bounds the whole event stream rather than one envelope, so it
    // covers the tool results the session streamed as well.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`claude did not finish within ${EXEC_TIMEOUT_MS} ms`));
    }, EXEC_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > EXEC_MAX_OUTPUT_CHARS) {
        child.kill("SIGKILL");
        finish(
          new Error(`claude wrote more than ${EXEC_MAX_OUTPUT_CHARS} chars`),
        );
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      finish(new Error(`claude could not be started: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        try {
          finish(
            null,
            JSON.stringify(
              claudeStreamEnvelope(stdout, { label: "claude", resultText }),
            ),
          );
        } catch (error) {
          finish(error);
        }
        return;
      }
      finish(
        new Error(`claude exited ${code ?? signal}: ${stderr.slice(-400)}`),
      );
    });
  });
}

/**
 * Return one fixture to the commit the contract pins, before a judge looks.
 *
 * The cells ran with `Write`, `Edit` and `Bash`, and the novel judge itself
 * runs with `Bash` inside the same checkout, so without this the judge would
 * verify a claim against the previous model's edits instead of against the
 * PR head. A fixture that cannot be reset is a scoring failure, not a number:
 * the cells stay cached, so the run resumes and re-scores.
 *
 * The reset names the pinned head rather than trusting the one `HEAD` carries
 * now, for the same reason the shell's per-cell reset does. `HEAD` is the one
 * thing a contestant can move: the last cell for a PR can commit its own edits
 * — or a commit the diff under review prompt-injected — or simply check out the
 * fixture's `base` branch, and an argument-free `git reset --hard` then makes
 * that tree the fixture. The pre-judge login snapshot and the novelty judge
 * would both run against it, so every scored claim for the PR comes from the
 * wrong tree. `HEAD` is read back afterwards so a reset that did not land fails
 * scoring instead of quietly scoring the contestant's commit.
 */
export function resetFixture({
  fixturePath,
  head,
  cellId,
  runGit = defaultRunGit,
}) {
  if (!fixturePath || !existsSync(fixturePath)) return false;
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) {
    throw new Error(
      `fixture ${fixturePath} cannot be reset before scoring ${cellId}: no pinned head`,
    );
  }
  for (const args of [
    ["checkout", "--quiet", "--force", "--detach", head],
    ["reset", "--hard", "--quiet", head],
    ["clean", "-xdffq"],
  ]) {
    const result = runGit({ args, cwd: fixturePath });
    if (result.status !== 0) {
      throw new Error(
        `fixture ${fixturePath} could not be reset before scoring ${cellId}: git ${args[0]} exited ${result.status}`,
      );
    }
  }
  const landed = runGit({
    args: ["rev-parse", "--verify", "--quiet", "HEAD"],
    cwd: fixturePath,
  });
  if (landed.status !== 0 || landed.stdout.trim() !== head) {
    throw new Error(
      `fixture ${fixturePath} is at ${landed.stdout.trim() || "an unreadable HEAD"} after the reset before scoring ${cellId}, not the pinned ${head}`,
    );
  }
  return true;
}

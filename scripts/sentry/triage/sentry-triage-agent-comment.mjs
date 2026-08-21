#!/usr/bin/env node
/**
 * The Sentry triage agent's ONLY write path (issue #1288).
 *
 * `.github/workflows/sentry-triage-agent.yml` used to grant the untrusted LLM
 * `Bash(gh issue comment <matrix.issue>:*)`. Claude Code permission rules are
 * string-prefix matches, so a grant for issue `123` also admits `1234`,
 * `12345`, … This wrapper accepts NO issue argument at all, so the remaining
 * prefix match on its own grant can only extend the ARGUMENTS.
 *
 * WHERE THE TARGET COMES FROM, and why not the environment. The first version
 * of this script read the target from the `SENTRY_TRIAGE_COMMENT_ISSUE` env
 * var. That is not a fence: bash arithmetic expansion ASSIGNS, and it happens
 * during the expansion of this script's own arguments, before node starts. A
 * body containing `$((SENTRY_TRIAGE_COMMENT_ISSUE=1234))` rewrites the
 * already-exported variable, so `process.env` holds the attacker's number by
 * the time this file runs — while the body still satisfies every content
 * check. Moving the target out of argv and into env moved it between two
 * model-controlled surfaces.
 *
 * The target is therefore read from a FILE written by a trusted workflow step
 * before the agent starts (TARGET_FILE_RELATIVE under `$RUNNER_TEMP`). The
 * agent's grant is Read/Grep/Glob, `gh issue view|list`, and this wrapper — no
 * tool that creates a file. The workflow additionally leaves the pinned file
 * mode 0444 inside a mode 0555 directory, so an `open(O_WRONLY)` redirect
 * fails EACCES for the owning user too and no directory entry can be replaced;
 * this script refuses if it ever finds that file writable, which is the
 * tamper/regression signal. The env var is kept as a CROSS-CHECK only: the two
 * must agree, and a disagreement is itself evidence the environment was
 * mutated, so it refuses loudly rather than picking a winner.
 *
 * Two further fences, both failing closed:
 *
 *   1. AUTHORSHIP MARKER. Deterministic pipeline scripts and this agent both
 *      post as `github-actions[bot]`, so the pipeline's trusted-author fence
 *      (`isTrustedComment`) cannot tell them apart — a prompt-injected agent
 *      could forge a comment that a downstream consumer reads as pipeline
 *      state. Every body posted here is stamped with AGENT_COMMENT_MARKER, and
 *      the body must START with VERDICT_MARKER. Those two together mean an
 *      agent comment can never impersonate any of the pipeline's
 *      prefix-anchored control comments (regression reopen, projection
 *      pointer, autofix pointer) and is always positively identifiable as
 *      agent-authored.
 *   2. SUBPROCESS ENV SCRUB. The `gh` child process gets a strict env
 *      ALLOWLIST — the Sentry read token, the Claude OAuth token and everything
 *      else in the agent step's environment are dropped. GH_TOKEN is the one
 *      credential re-bound deliberately: it is `gh`'s only auth channel, so it
 *      cannot be removed, but it is injected explicitly rather than inherited
 *      wholesale. This bounds what `gh` holds; it does not bound what the AGENT
 *      holds (see below).
 *
 * And one HYGIENE GUARD that is explicitly NOT a security control. A body
 * containing the verbatim value of a known secret env var is refused, naming
 * the VARIABLE and never the value. That catches the common accident — prose
 * that reproduces a credential because the agent quoted an environment value,
 * a config dump, or a failed command's output. It does NOT stop deliberate
 * exfiltration and must never be described as if it does: the agent writes the
 * shell command, and the shell expands and transforms `$VAR` BEFORE this
 * script receives argv, so `--body "…${SENTRY_TRIAGE_TOKEN:0:4}x${SENTRY_TRIAGE_TOKEN:4}"`
 * — or any substring split or substitution — arrives as a value this scan
 * cannot match. Exact-value scanning is structurally the wrong layer when the
 * adversary controls the shell. That is why the Sentry token no longer reaches
 * this process at all: issue #1711 put it behind a loopback credential broker
 * (scripts/sentry/broker/sentry-mcp-broker.mjs) and left the agent an opaque per-run handle.
 * `SENTRY_TRIAGE_TOKEN` stays in SECRET_ENV_VARS below as a regression
 * tripwire — it should now be unset here, so a body that could match it would
 * mean the workflow put the token back. The credentials that ARE still live,
 * and their bounding, are in the workflow's containment banner and in
 * docs/notes/sentry-triage-pipeline.md.
 *
 * A DEAD BROKER IS NOT A VERDICT (issue #1956). The Sentry credential broker
 * runs backgrounded in the same job, and its exit fails no step: the job must
 * END with the agent, so nothing runs afterwards to notice, and a background
 * process can neither write the job log nor fail a sibling step. A broker that
 * dies mid-run therefore leaves the agent reading ECONNREFUSED and reporting
 * `needs-human` — a verdict about the TOOLING that the deterministic `verdict`
 * job cannot tell apart from a judgement about the ISSUE, so it labels the
 * stub, strips `sentry:needs-triage` and parks work nobody can act on. The
 * prompt already tells the agent to post nothing in that state; this is the
 * structural half, because a prompt-injected agent is exactly the one that
 * ignores it. The workflow's watchdog writes BROKER_DOWN_FILE_RELATIVE when the
 * broker goes; this script refuses on that marker and prints it, and — because
 * a polled marker lags the death it reports — also probes the broker directly
 * in the instant before it posts. No comment means the `verdict` job finds no
 * verdict, fails loudly, and leaves `sentry:needs-triage` for the next run.
 *
 * THE BODY NEVER TOUCHES THE FILESYSTEM. It goes to `gh --body-file -` on the
 * child's stdin. An earlier version validated the body, wrote it to a
 * predictable path under `$RUNNER_TEMP`, and let `gh` read it back; the agent
 * can run a second permitted command concurrently (`… > that path &`) and swap
 * the content inside that window, so a body that passed every check here was
 * replaced before `gh` read it — reproduced, posting a forged
 * `Regressed in Sentry …` control comment. There is no check that closes a
 * check-then-use window on a path the attacker can write; removing the file
 * removes the window. Keep it that way: do not reintroduce an intermediate
 * file for the body.
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_COMMENT_MARKER,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";

import {
  assertBrokerAlive,
  probeBrokerByPid,
  redactSentryPaths,
} from "./sentry-triage-broker-guard.mjs";

export { AGENT_COMMENT_MARKER, VERDICT_MARKER };

/** The broker guard's surface, re-exported so the marker and pid names still
 * have ONE home from this module's point of view — the workflow's shape test
 * binds its literal file names to these constants. The mechanism itself lives
 * in `sentry-triage-broker-guard.mjs`; this file owns only "may this body be
 * posted, and to which issue". */
export {
  assertBrokerAlive,
  BROKER_DOWN_FILE_RELATIVE,
  brokerDownFilePath,
  BROKER_PID_FILE_RELATIVE,
  brokerPidFilePath,
  BrokerDownError,
  isZombieProcStatus,
  probeBrokerByPid,
  redactSentryPaths,
  REDACTED_SEGMENT,
  SENTRY_ROUTES,
} from "./sentry-triage-broker-guard.mjs";

/** The authoritative write target, written by a trusted workflow step before
 * the agent runs. Path is `$RUNNER_TEMP` + this fixed relative path — never an
 * env var of its own, so there is no string-valued path binding to repoint. */
export const TARGET_FILE_RELATIVE = "sentry-triage-target/target.json";

/** Cross-check only. The pinned file wins; a disagreement refuses. */
export const ISSUE_ENV_VAR = "SENTRY_TRIAGE_COMMENT_ISSUE";

/** Env vars whose verbatim value in a body is treated as an accident worth
 * refusing. Covers this workflow's own secrets plus the tokens
 * claude-code-action puts in the CLI subprocess env (which the agent's Bash
 * therefore inherits). Hygiene only — a deliberately transformed value passes
 * (see the header). `SENTRY_TRIAGE_TOKEN` should be unset here since #1711; it
 * is kept as a tripwire for the workflow putting it back in job env. */
export const SECRET_ENV_VARS = [
  "SENTRY_TRIAGE_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "DEFAULT_WORKFLOW_TOKEN",
  "OVERRIDE_GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

/** Values shorter than this are not credentials; matching them would refuse
 * every body over a var that happens to hold "1" or "true". Every token shape
 * in this pipeline is far longer. */
export const MIN_SECRET_LENGTH = 8;

/** The only env vars the `gh` child inherits. GH_TOKEN is added separately
 * (see buildChildEnv) because it is a credential, not ambient config. */
export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
];

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function usage() {
  return [
    "Usage: node scripts/sentry/triage/sentry-triage-agent-comment.mjs --body <markdown>",
    "",
    "Posts the triage verdict comment on the queue issue pinned by the",
    "workflow before this agent started. The issue number is NOT an argument",
    "and NOT taken from the environment.",
    "",
    `The body must start with ${VERDICT_MARKER}.`,
    "",
  ].join("\n");
}

/** Parse argv. Unknown flags and a repeated --body are refused rather than
 * ignored: an argument this script does not understand is a sign the agent is
 * probing the fence, not a harmless typo. */
export function parseArgs(argv) {
  let body = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== "--body") {
      throw new Error(`unexpected argument '${arg}'`);
    }
    if (body !== null) throw new Error("--body given more than once");
    if (i + 1 >= argv.length) throw new Error("--body needs a value");
    body = argv[i + 1];
    i += 1;
  }
  if (body === null) throw new Error("--body is required");
  if (body.trim() === "") throw new Error("--body must not be empty");
  return { body };
}

/** Where the trusted step pinned the write target. RUNNER_TEMP is the one env
 * input on this path; the agent can only break it (arithmetic assignment sets
 * integers), never repoint it at a directory it controls, and a broken value
 * means the file is not found and this script refuses. */
export function targetFilePath(env) {
  const tempDir = String(env.RUNNER_TEMP ?? "");
  if (tempDir === "") throw new Error("RUNNER_TEMP must be set");
  return join(tempDir, TARGET_FILE_RELATIVE);
}

/** Default reader: content plus mode, so the caller can reject a writable
 * (therefore tamperable) pin. */
function readPinnedTargetDefault(path) {
  return { content: readFileSync(path, "utf8"), mode: statSync(path).mode };
}

/**
 * Resolve the write target from the trusted pinned FILE, cross-checked against
 * the environment. The file is authoritative; the env var must agree.
 */
export function resolveTarget(env, readPinnedTarget = readPinnedTargetDefault) {
  const path = targetFilePath(env);

  let pinned;
  try {
    pinned = readPinnedTarget(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `cannot read the pinned write target at ${path} (${reason}); the ` +
        "workflow step that pins it must run before the agent",
      { cause: err },
    );
  }

  // A writable pin is not a pin. Either the workflow stopped locking it down or
  // something rewrote it — both are refusals, never a best-effort post.
  if ((pinned.mode & 0o222) !== 0) {
    throw new Error(
      `refusing to post: the pinned write target at ${path} is writable ` +
        `(mode ${(pinned.mode & 0o777).toString(8)}); it must be read-only`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(pinned.content));
  } catch {
    throw new Error(`the pinned write target at ${path} is not valid JSON`);
  }

  const issue = String(parsed?.issue ?? "").trim();
  if (!/^[0-9]+$/.test(issue)) {
    throw new Error(`the pinned write target at ${path} has no integer issue`);
  }
  const repo = String(parsed?.repo ?? "").trim();
  if (!REPO_PATTERN.test(repo)) {
    throw new Error(`the pinned write target at ${path} has no owner/repo`);
  }

  // Cross-check. The env values are model-reachable, so they never decide the
  // target — but a disagreement means something rewrote the environment after
  // the workflow set it, which is worth failing on rather than shrugging off.
  const envIssue = String(env[ISSUE_ENV_VAR] ?? "").trim();
  if (envIssue !== issue) {
    throw new Error(
      `refusing to post: write-target mismatch — the pinned file says ` +
        `${issue}, ${ISSUE_ENV_VAR} says ${
          envIssue === "" ? "nothing" : envIssue
        }. The environment was changed after the workflow set it.`,
    );
  }
  const envRepo = String(env.GITHUB_REPOSITORY ?? "").trim();
  if (envRepo !== repo) {
    throw new Error(
      `refusing to post: write-target mismatch — the pinned file says ` +
        `${repo}, GITHUB_REPOSITORY says ${
          envRepo === "" ? "nothing" : envRepo
        }. The environment was changed after the workflow set it.`,
    );
  }

  return { issue, repo };
}

/** The secret values present in this environment, as {name, value} pairs. Used
 * only for the verbatim-match hygiene guard. */
export function collectSecretValues(env) {
  return SECRET_ENV_VARS.filter(
    (name) =>
      typeof env[name] === "string" && env[name].length >= MIN_SECRET_LENGTH,
  ).map((name) => ({ name, value: env[name] }));
}

/** Refuse a body that forges the authorship marker or is not the verdict
 * comment this agent exists to post (both structural fences), and — as a
 * hygiene guard, NOT a containment control — a body that reproduces a
 * credential verbatim. Throws; the message never contains a secret value. */
export function assertBodyPostable(body, secrets) {
  // Hygiene only. A body assembled from shell-transformed pieces of a token
  // never matches here, and cannot be made to: the transformation happens
  // upstream of this process. See the header.
  for (const { name, value } of secrets) {
    if (body.includes(value)) {
      throw new Error(
        `refusing to post: body contains the value of ${name}. ` +
          "Verdict prose must never quote credentials or environment values.",
      );
    }
  }
  if (body.includes(AGENT_COMMENT_MARKER)) {
    throw new Error(
      `refusing to post: body contains ${AGENT_COMMENT_MARKER}, which only ` +
        "this script may add.",
    );
  }
  if (!body.startsWith(VERDICT_MARKER)) {
    throw new Error(
      `refusing to post: body must start with ${VERDICT_MARKER} — this ` +
        "script posts verdict comments and nothing else.",
    );
  }
}

/** Stamp the body as agent-authored. Appended, never prepended, so the body
 * still STARTS with VERDICT_MARKER for `selectVerdictComment`. */
export function decorateBody(body) {
  return `${body.replace(/\s+$/, "")}\n\n${AGENT_COMMENT_MARKER}\n`;
}

/** Strict allowlist env for the `gh` child. */
export function buildChildEnv(env) {
  const childEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (typeof env[name] === "string") childEnv[name] = env[name];
  }
  // gh has no non-env credential channel, so this one cannot be dropped. It is
  // re-bound explicitly here so the child's auth is a deliberate hand-off
  // rather than whatever the agent step's environment happened to contain.
  if (typeof env.GH_TOKEN === "string" && env.GH_TOKEN !== "") {
    childEnv.GH_TOKEN = env.GH_TOKEN;
  }
  return childEnv;
}

function runGhDefault(args, childEnv, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    // The body goes down the pipe and nowhere else — no path exists for a
    // concurrent command to overwrite between validation and use.
    child.stdin.on("error", (err) =>
      reject(new Error(`gh stdin failed: ${err.message}`)),
    );
    child.stdin.end(stdinText, "utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(new Error(`gh failed: ${err.message}`)));
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(`gh exited ${status}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Post the agent's verdict comment. `runGh` is injected so the tests drive the
 * whole flow without a runner, a token, or a network.
 *
 * This function writes NOTHING to disk. The validated body goes straight to
 * the child's stdin, so the bytes that were checked are the bytes that are
 * sent — there is no intermediate path for a concurrent command to swap.
 */
export async function postAgentComment({
  argv,
  env,
  runGh = runGhDefault,
  readPinnedTarget = readPinnedTargetDefault,
  // Left undefined rather than named here: the marker reader is private to
  // sentry-triage-broker-guard.mjs, so assertBrokerAlive applies its own
  // default. Tests still inject one through this seam.
  readBrokerDown = undefined,
  probeBroker = probeBrokerByPid,
}) {
  const { body } = parseArgs(argv);
  // resolveTarget first: it is what proves RUNNER_TEMP still resolves to the
  // trusted directory, and both broker files are read from that same root.
  const { issue, repo } = resolveTarget(env, readPinnedTarget);
  assertBodyPostable(body, collectSecretValues(env));
  // LAST, immediately before publication. The liveness answer is only as good
  // as it is fresh, so nothing slow may sit between deciding the broker is up
  // and handing the body to gh. The residual window is the gh call itself, and
  // a broker that dies inside it took nothing away: every read behind this
  // verdict already succeeded.
  await assertBrokerAlive(env, readBrokerDown, probeBroker);

  const stdout = await runGh(
    ["issue", "comment", issue, "--repo", repo, "--body-file", "-"],
    buildChildEnv(env),
    decorateBody(body),
  );
  return { issue, repo, stdout };
}

async function main() {
  const result = await postAgentComment({
    argv: process.argv.slice(2),
    env: process.env,
  });
  process.stdout.write(
    `Posted the verdict comment on issue #${result.issue}.\n${result.stdout}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    // ::error:: so a refusal lands as a run annotation: on this workflow the
    // agent step stays green when a tool call fails, and the run log is the
    // audit trail for an attempted exfiltration or fence probe. Annotations are
    // single-line, so the usage block follows as plain stderr the agent reads.
    //
    // Everything written here reaches the run log of a PUBLIC repository, so it
    // goes through redactSentryPaths first — see there for why the broker's own
    // log is agent-readable but must not be published verbatim.
    process.stderr.write(
      `::error::sentry-triage-agent-comment: ${redactSentryPaths(message)}\n`,
    );
    // The broker watchdog's record, log included, follows as plain stderr. This
    // is the only surface inside the agent step that reaches the job log, so a
    // refusal that withheld it would be a silent one (#1956).
    const raw = err instanceof Error ? err.detail : undefined;
    const detail = typeof raw === "string" ? redactSentryPaths(raw) : undefined;
    if (typeof detail === "string" && detail.trim() !== "") {
      process.stderr.write(detail.endsWith("\n") ? detail : `${detail}\n`);
    }
    process.stderr.write(usage());
    process.exitCode = 1;
  });
}

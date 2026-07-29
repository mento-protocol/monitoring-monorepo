#!/usr/bin/env node
/**
 * The Sentry triage agent's ONLY write path (issue #1288).
 *
 * `.github/workflows/sentry-triage-agent.yml` used to grant the untrusted LLM
 * `Bash(gh issue comment <matrix.issue>:*)`. Claude Code permission rules are
 * string-prefix matches, so a grant for issue `123` also admits `1234`,
 * `12345`, … The fix is structural rather than another validator: this wrapper
 * takes the write target from the workflow-set `SENTRY_TRIAGE_COMMENT_ISSUE`
 * env var and accepts NO issue argument at all, so no model-supplied string can
 * name a different issue. The remaining prefix match on the grant
 * (`Bash(node scripts/sentry-triage-agent-comment.mjs:*)`) can only extend the
 * ARGUMENTS, which cannot retarget the write.
 *
 * Three further fences, all failing closed:
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
 *   2. TOKEN SCRUB. The `gh` child process gets a strict env ALLOWLIST — the
 *      Sentry read token, the Claude OAuth token and everything else in the
 *      agent step's environment are dropped. GH_TOKEN is the one credential
 *      re-bound deliberately: it is `gh`'s only auth channel, so it cannot be
 *      removed, but it is injected explicitly rather than inherited wholesale.
 *   3. EXFILTRATION REFUSAL. The agent's shell expands `$VAR` before this
 *      script sees it, so `--body "$SENTRY_TRIAGE_TOKEN"` is the obvious exfil
 *      route. A body containing the value of any known secret env var is
 *      refused, and the refusal names the VARIABLE, never the value.
 *
 * The body is posted with `gh --body-file` from `$RUNNER_TEMP`, so it never
 * appears in `gh`'s argv.
 */

import { spawn } from "node:child_process";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_COMMENT_MARKER,
  VERDICT_MARKER,
} from "./sentry-triage-project-core.mjs";

export { AGENT_COMMENT_MARKER, VERDICT_MARKER };

/** Workflow-set write target. NOT settable from the command line — that is the
 * whole point of this script. */
export const ISSUE_ENV_VAR = "SENTRY_TRIAGE_COMMENT_ISSUE";

/** Env vars whose VALUES must never appear in an agent-authored body. Covers
 * this workflow's own secrets plus the tokens claude-code-action puts in the
 * CLI subprocess env (which the agent's Bash therefore inherits). */
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
    "Usage: node scripts/sentry-triage-agent-comment.mjs --body <markdown>",
    "",
    "Posts the triage verdict comment on the queue issue named by",
    `${ISSUE_ENV_VAR}. The issue number is NOT an argument.`,
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

/** Resolve the write target from the environment ONLY. */
export function resolveTarget(env) {
  const issue = String(env[ISSUE_ENV_VAR] ?? "");
  if (!/^[0-9]+$/.test(issue)) {
    throw new Error(
      `${ISSUE_ENV_VAR} must be set to a plain integer by the workflow (got ${
        issue === "" ? "an empty value" : "a non-integer value"
      })`,
    );
  }
  const repo = String(env.GITHUB_REPOSITORY ?? "");
  if (!REPO_PATTERN.test(repo)) {
    throw new Error("GITHUB_REPOSITORY must be set to owner/repo");
  }
  const tempDir = String(env.RUNNER_TEMP ?? "");
  if (tempDir === "") throw new Error("RUNNER_TEMP must be set");
  return { issue, repo, tempDir };
}

/** The secret values present in this environment, as {name, value} pairs. */
export function collectSecretValues(env) {
  return SECRET_ENV_VARS.filter(
    (name) =>
      typeof env[name] === "string" && env[name].length >= MIN_SECRET_LENGTH,
  ).map((name) => ({ name, value: env[name] }));
}

/** Refuse a body that leaks a credential, forges the authorship marker, or is
 * not the verdict comment this agent exists to post. Throws; the message never
 * contains a secret value. */
export function assertBodyPostable(body, secrets) {
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

function runGhDefault(args, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
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
 * Post the agent's verdict comment. `runGh` and `writeFile` are injected so
 * the tests drive the whole flow without a runner, a token, or a network.
 */
export async function postAgentComment({
  argv,
  env,
  runGh = runGhDefault,
  writeFile = writeFileAsync,
}) {
  const { body } = parseArgs(argv);
  const { issue, repo, tempDir } = resolveTarget(env);
  assertBodyPostable(body, collectSecretValues(env));

  const bodyFile = join(tempDir, `sentry-triage-agent-comment-${issue}.md`);
  await writeFile(bodyFile, decorateBody(body), "utf8");

  const stdout = await runGh(
    ["issue", "comment", issue, "--repo", repo, "--body-file", bodyFile],
    buildChildEnv(env),
  );
  return { issue, repo, bodyFile, stdout };
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
    process.stderr.write(`::error::sentry-triage-agent-comment: ${message}\n`);
    process.stderr.write(usage());
    process.exitCode = 1;
  });
}

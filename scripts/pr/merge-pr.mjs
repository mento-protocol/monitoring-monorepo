#!/usr/bin/env node
/**
 * The sanctioned merge path for this repository.
 *
 * Merging is a human-only action here, and `gh pr merge` reaches GitHub's write
 * API directly: no git hook, no CI job, and no branch protection sees the
 * decision to press the button. A wrapper in front of the real command is
 * therefore the only place the decision can be gated at all, which is why this
 * script runs the ordered gates itself and hands the request to `gh` last.
 *
 * The order is fixed: refuse outside an interactive human terminal, resolve the
 * repository and the target pull request unambiguously, run the ready-state
 * oracle, show the operator exactly what they are about to merge, make them
 * type the pull-request number back, append the consent record, and only then
 * merge. Every unreadable, ambiguous, or unexpected state refuses instead of
 * merging: an operator who has to re-run one command loses a minute, and a
 * merge nobody approved cannot be taken back.
 *
 * Agents must never invoke this script. The interactive-session refusal below
 * is what enforces that, and `.claude/settings.json` denies the raw
 * `gh pr merge` command so the wrapper is not simply stepped around.
 *
 * Tests: scripts/pr/merge-pr.test.mjs
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { fetchReadyState, runGh, splitRepo } from "./pr-ready-state.mjs";

/**
 * The repository allows squash merges only; `gh api repos/<owner>/<name>`
 * reports `allow_merge_commit` and `allow_rebase_merge` false. Re-check before
 * changing this, because a merge method the repository rejects fails at the
 * API rather than here, after consent is already recorded.
 */
export const MERGE_METHOD_FLAG = "--squash";

export const CONSENT_LOG_BASENAME = ".merge-consents.jsonl";

export const NON_INTERACTIVE_REFUSAL =
  "merging requires an interactive human session; agents must never merge";

/**
 * Environment markers that identify an automated session. A pseudo-terminal
 * makes `isTTY` true for a program an agent drives, so the TTY test alone is
 * not a human test; these markers close the gap for the runtimes this
 * repository actually uses. Any non-empty value refuses.
 */
export const AUTOMATION_ENV_MARKERS = [
  "AI_AGENT",
  "CI",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SANDBOX",
  "GITHUB_ACTIONS",
];

const PR_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;
const COMMIT_OID_PATTERN = /^[0-9a-f]{40}$/;
// eslint-disable-next-line no-control-regex -- a control byte would split the JSONL ledger record.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** A refusal is an expected outcome, not a crash; `main` prints it plainly. */
export class MergeRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "MergeRefusal";
  }
}

export function usage() {
  return `Usage: pnpm pr:merge [--pr <number>] [--repo <[host/]owner/name>] [--not-ready-reason "<why>"]
       pnpm pr:merge --help

Merges one pull request after an interactive human confirmation. Agents must
never run this. With no --pr, the single open pull request for the current
branch is used; zero or several refuse.
`;
}

function readFlagValue(rest, flag) {
  const flagIndex = rest.indexOf(flag);
  if (flagIndex < 0) return null;

  const value = rest[flagIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new MergeRefusal(`${flag} requires a value\n${usage()}`);
  }

  rest.splice(flagIndex, 2);
  return value;
}

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, prArg: null, repoArg: null, notReadyReason: null };
  }

  const rest = [...argv];
  const repoArg = readFlagValue(rest, "--repo");
  const prArg = readFlagValue(rest, "--pr");
  const notReadyReason = readFlagValue(rest, "--not-ready-reason");

  if (rest.length > 0) {
    throw new MergeRefusal(`unexpected argument: ${rest[0]}\n${usage()}`);
  }

  if (prArg !== null && !PR_NUMBER_PATTERN.test(prArg)) {
    throw new MergeRefusal(
      `--pr takes a pull-request number, not "${prArg}"\n${usage()}`,
    );
  }

  if (repoArg !== null) {
    // Reject a malformed value here rather than letting it reach `gh --repo`.
    splitRepo(repoArg);
  }

  if (notReadyReason !== null) {
    if (notReadyReason.trim() === "") {
      throw new MergeRefusal("--not-ready-reason must not be empty");
    }
    if (CONTROL_CHARACTER_PATTERN.test(notReadyReason)) {
      throw new MergeRefusal(
        "--not-ready-reason must not contain control characters",
      );
    }
  }

  return {
    help: false,
    prArg: prArg === null ? null : Number(prArg),
    repoArg,
    notReadyReason: notReadyReason === null ? null : notReadyReason.trim(),
  };
}

/**
 * @returns {string|null} the refusal message, or null when the session is an
 *   interactive human terminal.
 */
export function interactiveSessionRefusal({ stdin, stdout, env }) {
  if (stdin?.isTTY !== true) {
    return `${NON_INTERACTIVE_REFUSAL} (stdin is not a terminal)`;
  }
  if (stdout?.isTTY !== true) {
    return `${NON_INTERACTIVE_REFUSAL} (stdout is not a terminal)`;
  }

  const marker = AUTOMATION_ENV_MARKERS.find(
    (name) => (env?.[name] ?? "") !== "",
  );
  if (marker !== undefined) {
    return `${NON_INTERACTIVE_REFUSAL} (${marker} is set, so this is an automated session)`;
  }

  return null;
}

function runCommand(command, args, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("error", (err) => {
      reject(new Error(`${command} ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit ${code}:\n${stderr}`,
        ),
      );
    });
  });
}

const runGit = (args) => runCommand("git", args);

/** The merge itself streams to the operator's terminal instead of a buffer. */
function runGhInherit(args, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("gh", args, { stdio: "inherit" });
    child.on("error", (err) => {
      reject(new Error(`gh ${args.join(" ")} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`gh ${args.join(" ")} failed with exit ${code}`));
    });
  });
}

async function promptLine({ stdin, stdout, question }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Resolve the checkout's own repository and the repository the pull request
 * lives in. A fork checkout merges into its parent, so the two differ there and
 * a bare `origin` is never a substitute for the parent.
 */
export async function resolveRepositories({ repoArg, gh }) {
  let parsed;
  try {
    parsed = JSON.parse(
      await gh(["repo", "view", "--json", "nameWithOwner,parent"]),
    );
  } catch (err) {
    throw new MergeRefusal(
      `unable to resolve the checkout repository: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const current = parsed?.nameWithOwner ?? null;
  if (typeof current !== "string" || !current.includes("/")) {
    throw new MergeRefusal("`gh repo view` returned no repository name");
  }

  const parent = parsed?.parent?.nameWithOwner ?? null;
  const base = repoArg ?? (typeof parent === "string" ? parent : current);
  return { current, base, currentOwner: splitRepo(current).owner };
}

/**
 * Resolve the pull request to merge. An explicit number wins. Otherwise exactly
 * one open pull request must exist for the current branch in the base
 * repository, filtered to heads owned by this checkout's owner so a
 * same-named fork branch cannot match.
 */
export async function resolveTargetNumber({ prArg, repos, gh, git }) {
  if (prArg !== null) return prArg;

  let branch;
  try {
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch (err) {
    throw new MergeRefusal(
      `unable to resolve the current branch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!branch || branch === "HEAD") {
    throw new MergeRefusal(
      "the checkout is detached; pass --pr <number> to name the pull request",
    );
  }

  let listed;
  try {
    listed = JSON.parse(
      await gh([
        "pr",
        "list",
        "--repo",
        repos.base,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,headRepositoryOwner",
      ]),
    );
  } catch (err) {
    throw new MergeRefusal(
      `unable to list pull requests for ${branch}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const owned = (Array.isArray(listed) ? listed : []).filter(
    (pr) =>
      String(pr?.headRepositoryOwner?.login ?? "").toLowerCase() ===
      repos.currentOwner.toLowerCase(),
  );

  if (owned.length === 0) {
    throw new MergeRefusal(
      `no open pull request for branch ${branch} in ${repos.base}`,
    );
  }
  if (owned.length > 1) {
    const numbers = owned.map((pr) => pr.number).join(", ");
    throw new MergeRefusal(
      `branch ${branch} has several open pull requests in ${repos.base} (${numbers}); pass --pr <number>`,
    );
  }

  const number = owned[0]?.number;
  if (!PR_NUMBER_PATTERN.test(String(number))) {
    throw new MergeRefusal(
      `\`gh pr list\` returned an unusable pull-request number for ${branch}`,
    );
  }
  return Number(number);
}

function countRequired(checks = []) {
  return checks.filter((check) => check?.required === true).length;
}

export function formatBriefing({ summary, repo, notReadyReason }) {
  const pr = summary?.pr ?? {};
  const statusChecks = summary?.statusChecks ?? {};
  const blockers = summary?.required?.blockers ?? [];

  const lines = [
    "",
    `About to merge ${repo}#${pr.number} with ${MERGE_METHOD_FLAG.replace("--", "")}.`,
    "",
    `  Title: ${pr.title ?? "(unknown)"}`,
    `  Head:  ${pr.headRefOid ?? "(unknown)"} (${pr.headRefName ?? "(unknown)"})`,
    `  Base:  ${pr.baseRefName ?? "(unknown)"}`,
    `  Required checks: ${countRequired(statusChecks.pass)} passing, ${countRequired(statusChecks.fail)} failing, ${countRequired(statusChecks.pending)} pending`,
    `  Ready state: ${summary?.ready === true ? "READY" : "NOT READY"}`,
  ];

  if (blockers.length > 0) {
    lines.push("  Blockers:");
    for (const blocker of blockers) {
      lines.push(`    - ${blocker.name} (${blocker.state})`);
    }
  }

  if (notReadyReason) {
    lines.push(`  Recorded override reason: ${notReadyReason}`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function buildConsentRecord({
  login,
  repo,
  number,
  headOid,
  notReadyReason,
  now,
}) {
  const record = {
    timestamp: now.toISOString(),
    login,
    repo,
    pr: number,
    headOid,
  };
  if (notReadyReason) record.notReadyReason = notReadyReason;
  return record;
}

async function appendConsentRecord({ record, git }) {
  let repoRoot;
  try {
    repoRoot = (await git(["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    throw new MergeRefusal(
      `unable to resolve the repository root for the consent record: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!repoRoot) {
    throw new MergeRefusal(
      "unable to resolve the repository root for the consent record",
    );
  }

  const target = path.join(repoRoot, CONSENT_LOG_BASENAME);
  try {
    appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    throw new MergeRefusal(
      `unable to record consent in ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return target;
}

async function resolveLogin({ gh }) {
  let login;
  try {
    login = (await gh(["api", "user", "--jq", ".login"])).trim();
  } catch (err) {
    throw new MergeRefusal(
      `unable to establish the active GitHub login: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(login)) {
    throw new MergeRefusal("unable to establish the active GitHub login");
  }
  return login;
}

/**
 * Run the ordered gates and merge. Throws {@link MergeRefusal} for every state
 * that is not an approved merge.
 */
export async function mergePullRequest({
  argv = [],
  stdin = process.stdin,
  stdout = process.stdout,
  env = process.env,
  deps = {},
} = {}) {
  const {
    fetchReadyState: readyState = fetchReadyState,
    gh = runGh,
    git = runGit,
    merge = runGhInherit,
    prompt = promptLine,
    appendConsent = appendConsentRecord,
    now = () => new Date(),
  } = deps;

  const { help, prArg, repoArg, notReadyReason } = parseArgs(argv);
  if (help) {
    stdout.write(usage());
    return { merged: false, help: true };
  }

  const refusal = interactiveSessionRefusal({ stdin, stdout, env });
  if (refusal !== null) throw new MergeRefusal(refusal);

  const repos = await resolveRepositories({ repoArg, gh });
  const login = await resolveLogin({ gh });
  const number = await resolveTargetNumber({ prArg, repos, gh, git });

  const readGatedReadyState = async () => {
    let summary;
    try {
      summary = await readyState({
        prArg: String(number),
        repoArg: repos.base,
      });
    } catch (err) {
      throw new MergeRefusal(
        `unable to read the ready state of ${repos.base}#${number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const state = String(summary?.pr?.state ?? "").toUpperCase();
    if (state !== "OPEN") {
      throw new MergeRefusal(
        `${repos.base}#${number} is ${state || "in an unreadable state"}; only an open pull request can be merged`,
      );
    }

    const headOid = String(summary?.pr?.headRefOid ?? "").toLowerCase();
    if (!COMMIT_OID_PATTERN.test(headOid)) {
      throw new MergeRefusal(
        `${repos.base}#${number} reports no usable head commit; refusing to merge an unidentified head`,
      );
    }

    if (summary?.ready !== true && notReadyReason === null) {
      throw new MergeRefusal(
        `${repos.base}#${number} is not ready: ${summary?.summary ?? "the ready-state oracle reported blockers"}\n` +
          `Re-run with --not-ready-reason "<why this merge is safe anyway>" to record an override.`,
      );
    }

    return { summary, headOid };
  };

  const { summary, headOid } = await readGatedReadyState();

  stdout.write(formatBriefing({ summary, repo: repos.base, notReadyReason }));

  const answer = await prompt({
    stdin,
    stdout,
    question: `Type ${number} to merge this pull request, anything else aborts: `,
  });

  if (String(answer ?? "").trim() !== String(number)) {
    throw new MergeRefusal(
      "confirmation did not match the pull-request number; nothing was merged",
    );
  }

  // The prompt has no time limit, and `--match-head-commit` only notices a new
  // head commit. A dismissed review, a rerun check, or any other same-SHA
  // readiness change during the wait would otherwise merge on a briefing the
  // operator can no longer see, so the gates run once more against live state.
  const confirmed = await readGatedReadyState();
  if (confirmed.headOid !== headOid) {
    throw new MergeRefusal(
      `${repos.base}#${number} moved from ${headOid} to ${confirmed.headOid} while you were confirming; re-run to review the new head`,
    );
  }

  const record = buildConsentRecord({
    login,
    repo: repos.base,
    number,
    headOid,
    notReadyReason,
    now: now(),
  });
  const consentPath = await appendConsent({ record, git });
  stdout.write(`Recorded consent in ${consentPath}\n`);

  await merge([
    "pr",
    "merge",
    String(number),
    "--repo",
    repos.base,
    MERGE_METHOD_FLAG,
    // Bind the merge to the head the operator was shown, so a push between the
    // briefing and the confirmation cannot merge a commit nobody approved.
    "--match-head-commit",
    headOid,
  ]);

  return { merged: true, record, consentPath };
}

async function main() {
  try {
    await mergePullRequest({ argv: process.argv.slice(2) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`merge-pr: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

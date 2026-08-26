/**
 * The decision logic behind the sanctioned merge wrapper.
 *
 * Everything here is a total function over plain data: argument parsing, the
 * session test, the operator briefing, the consent record, and the gate
 * signature that decides whether the state the operator approved is still the
 * state about to be merged. Every side effect — GitHub, git, the filesystem,
 * the terminal — lives in `scripts/pr/merge-pr.mjs`, which imports this module
 * and re-exports it so callers keep one entry point.
 *
 * The split keeps both halves under the 600-line soft cap
 * (`docs/adr/0065-scripts-file-size-watchlist-scope.md`) and lets the suite
 * exercise every refusal here without a fake for anything.
 *
 * Tests: scripts/pr/merge-pr.test.mjs
 */

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
  // `CODEX_SANDBOX` alone misses a Codex session run with the sandbox
  // bypassed, so both markers are needed. Keep this pair identical to
  // `running_inside_codex_sandbox()` in scripts/agent-autoreview.sh; a Codex
  // session has no `.claude/settings.json` deny behind it, so this list is one
  // of only two gates it ever meets.
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "GITHUB_ACTIONS",
];

export const PR_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;
export const COMMIT_OID_PATTERN = /^[0-9a-f]{40}$/;
// eslint-disable-next-line no-control-regex -- a control byte would split the JSONL ledger record.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Characters that let text rewrite a terminal instead of appearing in it: the
 * C0 and C1 control ranges (escape sequences, carriage return), DEL, and the
 * zero-width and bidirectional formatting characters that reorder a rendered
 * line without changing its code points.
 */
const TERMINAL_UNSAFE_PATTERN =
  // eslint-disable-next-line no-control-regex -- these are exactly the bytes the briefing refuses to echo.
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f]/g;

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

/**
 * @param {string[]} argv
 * @param {(value: string) => unknown} validateRepo validates the `--repo`
 *   value before it can reach `gh`; injected so this module stays free of the
 *   ready-state oracle's parser.
 */
export function parseArgs(argv, { validateRepo } = {}) {
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

  if (repoArg !== null && typeof validateRepo === "function") {
    // Reject a malformed value here rather than letting it reach `gh --repo`.
    validateRepo(repoArg);
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

/**
 * Render GitHub-sourced text safely into the briefing.
 *
 * The briefing is the human approval boundary, and a pull-request title is
 * contributor-controlled. Printed verbatim, a title carrying an escape
 * sequence can erase or overwrite the head, base and readiness lines directly
 * above it, and a bidirectional override can reorder a rendered line without
 * changing a single code point — so the operator confirms a merge against text
 * the attacker composed. Every unsafe character becomes U+FFFD, which is
 * visible, so tampering shows up as replacement characters instead of
 * disappearing.
 */
export function sanitizeTerminalText(value, fallback = "(unknown)") {
  if (value === null || value === undefined) return fallback;
  const text = String(value);
  if (text === "") return fallback;
  return text.replace(TERMINAL_UNSAFE_PATTERN, "�");
}

/**
 * Count the ready-state oracle's required checks by state.
 *
 * `summary.statusChecks` groups every check the pull request has and carries no
 * `required` flag at all, so filtering it on one is a permanent zero.
 * `summary.requiredChecks` is the list the oracle derives its own blockers
 * from, which keeps this briefing and those blockers describing the same set.
 *
 * @returns {null} when the oracle produced no required-check list, so the
 *   briefing reports that rather than printing a confident zero over it.
 */
export function countRequiredCheckStates(summary) {
  const checks = summary?.requiredChecks;
  if (!Array.isArray(checks)) return null;

  const counts = { pass: 0, fail: 0, pending: 0, total: checks.length };
  for (const check of checks) {
    const state = String(check?.state ?? "");
    if (state === "pass" || state === "fail" || state === "pending") {
      counts[state] += 1;
    }
  }
  return counts;
}

function formatRequiredCheckLine(summary) {
  const counts = countRequiredCheckStates(summary);
  if (counts === null) {
    return "  Required checks: unavailable — the ready-state oracle returned no required-check list";
  }
  // The total is printed too: a required check in any other state (skipped,
  // for instance) is then visible as the gap instead of silently vanishing.
  return `  Required checks: ${counts.pass} passing, ${counts.fail} failing, ${counts.pending} pending (of ${counts.total} required)`;
}

function formatFeedbackLine(feedback) {
  if (feedback === null || feedback === undefined) {
    return "  Feedback ledger: unavailable — the feedback projection returned nothing";
  }
  if (feedback.ready === true) return "  Feedback ledger: CLEAR";

  const counts = feedback.counts ?? {};
  const parts = [
    `${counts.requiredFeedbackBlockers ?? 0} blocking`,
    `${counts.unresolvedReviewThreads ?? 0} unresolved threads`,
    `${counts.unrepliedRootReviewComments ?? 0} unreplied comments`,
    `${counts.blockingTopLevelBotComments ?? 0} actionable bot comments`,
  ];
  return `  Feedback ledger: NEEDS ATTENTION (${parts.join(", ")})`;
}

export function formatBriefing({ summary, feedback, repo, notReadyReason }) {
  const pr = summary?.pr ?? {};
  const blockers = summary?.required?.blockers ?? [];

  const lines = [
    "",
    `About to merge ${sanitizeTerminalText(repo)}#${pr.number} with ${MERGE_METHOD_FLAG.replace("--", "")}.`,
    "",
    `  Title: ${sanitizeTerminalText(pr.title)}`,
    `  Head:  ${sanitizeTerminalText(pr.headRefOid)} (${sanitizeTerminalText(pr.headRefName)})`,
    `  Base:  ${sanitizeTerminalText(pr.baseRefName)}`,
    formatRequiredCheckLine(summary),
    `  Ready state: ${summary?.ready === true ? "READY" : "NOT READY"}`,
    formatFeedbackLine(feedback),
  ];

  if (blockers.length > 0) {
    lines.push("  Blockers:");
    for (const blocker of blockers) {
      lines.push(
        `    - ${sanitizeTerminalText(blocker.name)} (${sanitizeTerminalText(blocker.state)})`,
      );
    }
  }

  if (notReadyReason) {
    lines.push(
      `  Recorded override reason: ${sanitizeTerminalText(notReadyReason)}`,
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * A stable description of every gate the operator was shown.
 *
 * `--not-ready-reason` records one operator judgement about one state, and the
 * prompt has no time limit. Without this comparison a reason entered for a
 * missing optional review would silently carry a newly failing required check,
 * a fresh `CHANGES_REQUESTED`, or new blocking review feedback through the
 * same approval. Any difference between the two reads refuses: re-running
 * costs a minute and shows the operator the state that actually exists.
 */
export function gateSignature({ summary, feedback }) {
  const blockers = (summary?.required?.blockers ?? [])
    .map(
      (blocker) =>
        `blocker:${blocker?.kind ?? "?"}:${blocker?.name ?? "?"}:${blocker?.state ?? "?"}`,
    )
    .sort();
  const counts = feedback?.counts ?? {};
  return [
    `ready:${summary?.ready === true}`,
    ...blockers,
    `feedback:ready:${feedback?.ready === true}`,
    `feedback:blockers:${counts.requiredFeedbackBlockers ?? 0}`,
    `feedback:threads:${counts.unresolvedReviewThreads ?? 0}`,
    `feedback:rootComments:${counts.unrepliedRootReviewComments ?? 0}`,
    `feedback:botComments:${counts.blockingTopLevelBotComments ?? 0}`,
  ].join("\n");
}

/**
 * The host a repository reference belongs to, or null for github.com.
 *
 * `gh` defaults every `--repo owner/name` and every `gh api` call to
 * github.com, so a GitHub Enterprise checkout that loses its host silently
 * retargets to a same-named public repository instead of failing.
 */
export function hostFromRepoUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  return host === "" || host === "github.com" ? null : host;
}

export const qualifyRepo = (nameWithOwner, host) =>
  host === null ? nameWithOwner : `${host}/${nameWithOwner}`;

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

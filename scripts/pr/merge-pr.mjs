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
 * oracle and the feedback ledger, show the operator exactly what they are about
 * to merge, make them type the pull-request number back, re-read every gate,
 * append the consent record, merge, and confirm the merge actually landed.
 * Every unreadable, ambiguous, or unexpected state refuses instead of merging:
 * an operator who has to re-run one command loses a minute, and a merge nobody
 * approved cannot be taken back.
 *
 * Agents must never invoke this script. Be honest about what makes that true.
 * The interactive-session refusal stops an agent that runs this command the
 * ordinary way, and `.claude/settings.json` denies the raw `gh pr merge`
 * command so the obvious shortcut is gone too. Neither is an unforgeable
 * boundary: a caller on this machine can allocate a pseudo-terminal and clear
 * the markers, and the deny is command-level, so it does not cover the same
 * merge issued as `gh api --method PUT repos/{owner}/{repo}/pulls/{n}/merge`.
 * A local process running as the operator can synthesize any local signal, so
 * no check in this file can be one. What the wrapper does provide is a default
 * that refuses, a briefing the operator must read, a confirmation they must
 * type, and an append-only consent record naming who approved which head. The
 * approval rule itself remains the binding control, and the only unforgeable
 * boundary would live on GitHub's side of the wire;
 * `docs/adr/0073-sanctioned-merge-wrapper.md` records that decision and its
 * residual risk.
 *
 * The pure decision logic lives in `scripts/pr/merge-pr-core.mjs` and the side
 * effects in `scripts/pr/merge-pr-io.mjs`; both are re-exported here so callers
 * keep one entry point.
 *
 * Tests: scripts/pr/merge-pr.test.mjs
 */

import { fileURLToPath } from "node:url";

import {
  COMMIT_OID_PATTERN,
  MERGE_METHOD_FLAG,
  MergeRefusal,
  PR_NUMBER_PATTERN,
  buildConsentRecord,
  exitCodeForResult,
  formatBriefing,
  gateSignature,
  hostFromRepoUrl,
  interactiveSessionRefusal,
  parseArgs as parseArgsCore,
  qualifyRepo,
  usage,
} from "./merge-pr-core.mjs";
import {
  appendConsentRecord,
  promptLine,
  runGhInherit,
  runGit,
} from "./merge-pr-io.mjs";
import { summarizeFeedbackState } from "./pr-feedback-state-core.mjs";
import { fetchReadyState, runGh, splitRepo } from "./pr-ready-state.mjs";

export {
  AUTOMATION_ENV_MARKERS,
  CONSENT_LOG_BASENAME,
  MERGE_METHOD_FLAG,
  MergeRefusal,
  NON_INTERACTIVE_REFUSAL,
  buildConsentRecord,
  countRequiredCheckStates,
  exitCodeForResult,
  formatBriefing,
  gateSignature,
  interactiveSessionRefusal,
  sanitizeTerminalText,
  usage,
} from "./merge-pr-core.mjs";
export { appendConsentRecord } from "./merge-pr-io.mjs";

/** Validate `--repo` through the ready-state oracle's own repository parser. */
export const parseArgs = (argv) =>
  parseArgsCore(argv, { validateRepo: splitRepo });

/**
 * Resolve the checkout's own repository and the repository the pull request
 * lives in. A fork checkout merges into its parent, so the two differ there and
 * a bare `origin` is never a substitute for the parent.
 *
 * `gh repo view --json nameWithOwner` returns a bare `owner/name` even on a
 * GitHub Enterprise checkout, and `gh` defaults every bare `--repo` and every
 * `gh api` call to github.com — so a lost host silently retargets the whole run
 * at a same-named public repository. The host therefore comes from the
 * repository URL and rides on every later call. An explicit `--repo` is used
 * exactly as given, including whichever host it names.
 */
export async function resolveRepositories({ repoArg, gh }) {
  let parsed;
  try {
    parsed = JSON.parse(
      await gh(["repo", "view", "--json", "nameWithOwner,parent,url"]),
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

  const checkoutHost = hostFromRepoUrl(parsed?.url);
  const parent = parsed?.parent?.nameWithOwner ?? null;
  const inferred = typeof parent === "string" ? parent : current;
  const base = repoArg ?? qualifyRepo(inferred, checkoutHost);

  return {
    current: qualifyRepo(current, checkoutHost),
    base,
    host: splitRepo(base).host,
    currentOwner: splitRepo(current).owner,
  };
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

async function resolveLogin({ gh, host }) {
  // `gh api` defaults to github.com. On an Enterprise target that would either
  // refuse an Enterprise-only account or, with both hosts authenticated, record
  // the wrong operator in the consent ledger.
  const args = ["api"];
  if (host !== null && host !== undefined) args.push("--hostname", host);
  args.push("user", "--jq", ".login");

  let login;
  try {
    login = (await gh(args)).trim();
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
 * Ask GitHub whether the pull request is actually merged.
 *
 * `gh pr merge` exits 0 on a merge-queue base after only ENQUEUEING the pull
 * request, and the queue may rebuild and retest it before any merge happens. A
 * bare success would then leave a consent record bound to the pre-queue head
 * while callers ran post-merge closeout against a pull request still open.
 */
async function readMergeOutcome({ gh, repo, number }) {
  const parsed = JSON.parse(
    await gh([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,mergeCommit",
    ]),
  );
  return {
    state: String(parsed?.state ?? "").toUpperCase(),
    mergeCommit: parsed?.mergeCommit?.oid ?? null,
  };
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
    summarizeFeedback = summarizeFeedbackState,
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
  const login = await resolveLogin({ gh, host: repos.host });
  const number = await resolveTargetNumber({ prArg, repos, gh, git });

  const readGatedReadyState = async () => {
    let summary;
    try {
      summary = await readyState({
        prArg: String(number),
        repoArg: repos.base,
        // The feedback ledger is derived from this same read; asking for the
        // detail here is what makes the feedback gate below possible at all.
        includeFeedbackDetails: true,
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

    const baseRefName = String(summary?.pr?.baseRefName ?? "");
    if (baseRefName === "") {
      throw new MergeRefusal(
        `${repos.base}#${number} reports no base branch; refusing to merge into an unidentified branch`,
      );
    }

    // `pr:ready-state` deliberately does not project actionable top-level bot
    // feedback into its required blockers — `pr:feedback-state` owns that
    // ledger (docs/notes/pr-ready-state.md). Reading only the oracle would let
    // this wrapper merge a pull request the repository's own all-clear still
    // refuses.
    let feedback;
    try {
      feedback = summarizeFeedback(summary);
    } catch (err) {
      throw new MergeRefusal(
        `unable to read the feedback ledger of ${repos.base}#${number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (
      (summary?.ready !== true || feedback?.ready !== true) &&
      notReadyReason === null
    ) {
      const reasons = [];
      if (summary?.ready !== true) {
        reasons.push(
          summary?.summary ?? "the ready-state oracle reported blockers",
        );
      }
      if (feedback?.ready !== true) {
        reasons.push(
          feedback?.summary ?? "the feedback ledger has outstanding items",
        );
      }
      throw new MergeRefusal(
        `${repos.base}#${number} is not ready: ${reasons.join(" ")}\n` +
          `Re-run with --not-ready-reason "<why this merge is safe anyway>" to record an override.`,
      );
    }

    return {
      summary,
      feedback,
      headOid,
      baseRefName,
      signature: gateSignature({ summary, feedback }),
    };
  };

  const approved = await readGatedReadyState();

  stdout.write(
    formatBriefing({
      summary: approved.summary,
      feedback: approved.feedback,
      repo: repos.base,
      notReadyReason,
    }),
  );

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
  // head commit. A dismissed review, a rerun check, a retargeted base, or new
  // blocking feedback during the wait would otherwise merge on a briefing the
  // operator can no longer see, so every gate runs once more against live
  // state and any difference refuses.
  const confirmed = await readGatedReadyState();
  if (confirmed.headOid !== approved.headOid) {
    throw new MergeRefusal(
      `${repos.base}#${number} moved from ${approved.headOid} to ${confirmed.headOid} while you were confirming; re-run to review the new head`,
    );
  }
  if (confirmed.baseRefName !== approved.baseRefName) {
    throw new MergeRefusal(
      `${repos.base}#${number} was retargeted from ${approved.baseRefName} to ${confirmed.baseRefName} while you were confirming; re-run to review the new base`,
    );
  }
  if (confirmed.signature !== approved.signature) {
    throw new MergeRefusal(
      `${repos.base}#${number} changed its readiness or feedback state while you were confirming; re-run to review it`,
    );
  }

  const record = buildConsentRecord({
    login,
    repo: repos.base,
    number,
    headOid: approved.headOid,
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
    approved.headOid,
  ]);

  let outcome;
  try {
    outcome = await readMergeOutcome({ gh, repo: repos.base, number });
  } catch (err) {
    stdout.write(
      `Could not confirm the merge landed: ${err instanceof Error ? err.message : String(err)}\n` +
        `Check ${repos.base}#${number} before running any post-merge step.\n`,
    );
    return { merged: false, verified: false, record, consentPath };
  }

  if (outcome.state !== "MERGED") {
    stdout.write(
      `${repos.base}#${number} is ${outcome.state || "in an unreadable state"}, not merged — ` +
        `a merge-queue base accepts the request without merging it. ` +
        `Do not run post-merge steps until it reports MERGED.\n`,
    );
    return {
      merged: false,
      verified: true,
      queued: true,
      state: outcome.state,
      record,
      consentPath,
    };
  }

  return {
    merged: true,
    verified: true,
    state: outcome.state,
    mergeCommit: outcome.mergeCommit,
    record,
    consentPath,
  };
}

async function main() {
  try {
    const result = await mergePullRequest({ argv: process.argv.slice(2) });
    const code = exitCodeForResult(result);
    if (code !== 0) {
      process.stderr.write(
        "merge-pr: the merge was not confirmed; not reporting success\n",
      );
      process.exitCode = code;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`merge-pr: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

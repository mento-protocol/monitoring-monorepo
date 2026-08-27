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
 * append the consent record, merge, and confirm the merge actually landed on
 * the head and base the operator approved.
 * Every unreadable, ambiguous, or unexpected state refuses instead of merging:
 * an operator who has to re-run one command loses a minute, and a merge nobody
 * approved cannot be taken back.
 *
 * A merge-queue base is refused outright, before any request is sent, and again
 * after the confirmation: `gh pr merge` enqueues such a base and returns
 * success, and nothing this wrapper can call removes a queue entry, so merging
 * first would leave a standing request it cannot take back. An unreadable
 * branch-rules answer refuses too. Those reads narrow the window but cannot
 * close it — a queue enabled between the last read and GitHub handling the
 * request still enqueues. Closing it means merging through an operation that
 * cannot enqueue at all; issue 2092 carries that change.
 *
 * Two races are detected rather than prevented. `--match-head-commit` pins the
 * head, and the merge endpoint has no base equivalent, so a retarget between
 * the final gate read and the merge request itself can still land on another
 * branch; the wrapper re-reads the base afterwards and fails loudly when it
 * moved. A title edited in that same window can likewise reach the squash
 * subject. `--subject` would pin it, but this repository sets
 * `squash_merge_commit_title=COMMIT_OR_PR_TITLE`, so GitHub uses the single
 * commit's subject when there is one and appends `(#N)` — behaviour a fixed
 * `--subject` would replace on every merge. Changing how every merge commit is
 * titled, to close a sub-second window, is the worse trade; the title is bound
 * in the confirmation signature instead.
 *
 * Agents must never invoke this script. Be honest about what makes that true.
 * The interactive-session refusal stops an agent that runs this command the
 * ordinary way, and `.claude/settings.json` denies `gh pr merge` along with the
 * repository-qualified spellings of it (`gh -R X pr merge`, `gh pr --repo X
 * merge`, and the `=` forms), so the obvious shortcuts are gone too. Neither is
 * an unforgeable boundary: a caller on this machine can allocate a
 * pseudo-terminal and clear the markers, and the deny is a command-pattern
 * list, so it covers the spellings someone thought to enumerate and not the
 * same merge issued as `gh api --method PUT repos/{owner}/{repo}/pulls/{n}/merge`,
 * through an alias, or with other global flags interleaved.
 * A local process running as the operator can synthesize any local signal, so
 * no check in this file can be one. What the wrapper does provide is a default
 * that refuses, a briefing the operator must read, a confirmation they must
 * type, and an append-only consent record naming who approved which head. The
 * approval rule itself remains the binding control, and the only unforgeable
 * boundary would live on GitHub's side of the wire;
 * `docs/adr/0075-sanctioned-merge-wrapper.md` records that decision and its
 * residual risk.
 *
 * The pure decision logic lives in `scripts/pr/merge-pr-core.mjs`, the local
 * side effects in `scripts/pr/merge-pr-io.mjs`, and the GitHub calls in
 * `scripts/pr/merge-pr-github.mjs`; this file orders them, and re-exports the
 * public surface so callers keep one entry point.
 *
 * Tests: scripts/pr/merge-pr.test.mjs
 */

import { fileURLToPath } from "node:url";

import {
  COMMIT_OID_PATTERN,
  MERGE_METHOD_FLAG,
  MergeRefusal,
  buildConsentRecord,
  exitCodeForResult,
  formatBriefing,
  gateSignature,
  interactiveSessionRefusal,
  parseArgs as parseArgsCore,
  usage,
} from "./merge-pr-core.mjs";
import {
  appendConsentRecord,
  promptLine,
  runGhInherit,
  runGit,
} from "./merge-pr-io.mjs";
import {
  readBaseBranchRuleTypes,
  readMergeOutcome,
  resolveLogin,
  resolveRepositories,
  resolveTargetNumber,
} from "./merge-pr-github.mjs";
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
export {
  resolveRepositories,
  resolveTargetNumber,
} from "./merge-pr-github.mjs";

/** Validate `--repo` through the ready-state oracle's own repository parser. */
export const parseArgs = (argv) =>
  parseArgsCore(argv, { validateRepo: splitRepo });

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

  // `GH_REPO` redirects every `gh` command that would otherwise read the local
  // repository. Measured on gh 2.96.0: an explicit `--repo` beats it, and
  // `gh repo view` ignores it outright — but the checkout identity would then
  // rest on one CLI version's precedence rules, and this command decides what
  // gets merged. Name the target explicitly or clear the variable.
  if (repoArg === null && (env?.GH_REPO ?? "") !== "") {
    throw new MergeRefusal(
      "GH_REPO is set, so which repository this resolves depends on `gh`'s own precedence; " +
        "unset it, or pass --repo <[host/]owner/name> to name the target outright",
    );
  }

  const repos = await resolveRepositories({ repoArg, gh });

  // `GH_HOST` picks the host whenever one was not provided, so a bare
  // `owner/name` target would send the readiness reads and the merge to an
  // Enterprise host while the login call, which names github.com outright,
  // read a different one — and the briefing would show neither. A target
  // carrying its own host is unaffected, because the host was provided.
  if (repos.host === null && (env?.GH_HOST ?? "") !== "") {
    throw new MergeRefusal(
      `GH_HOST is set, so ${repos.base} does not name the host this would merge on; ` +
        `unset it, or pass --repo <host/owner/name> to name the target outright`,
    );
  }
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

  // Refuse a merge-queue base before anything is sent. `gh pr merge` enqueues
  // such a base and returns success, and nothing this wrapper can call removes
  // a queue entry — so merging first would leave a standing request GitHub
  // could complete later with none of the gates above. The base is bound
  // across the confirmation below, so checking it here is checking the base
  // that gets merged. An unreadable answer refuses too: this is the last gate
  // before an irreversible action, and "probably no queue" is not a gate.
  let baseRuleTypes;
  try {
    baseRuleTypes = await readBaseBranchRuleTypes({
      gh,
      repo: repos.base,
      branch: approved.baseRefName,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to read the branch rules for ${approved.baseRefName} in ${repos.base}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because a merge-queue base would accept a request this command cannot take back.`,
    );
  }
  if (baseRuleTypes.includes("merge_queue")) {
    throw new MergeRefusal(
      `${approved.baseRefName} in ${repos.base} uses a merge queue. ` +
        `\`gh pr merge\` would enqueue this pull request and return success, and nothing ` +
        `this command can call removes a queue entry, so the merge would sit outside ` +
        `every gate above. Merge it through the queue deliberately instead.`,
    );
  }

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

  // The rules were read before an unbounded prompt, and a merge queue can be
  // switched on while the operator reads. Re-read them, like every other gate.
  let confirmedRuleTypes;
  try {
    confirmedRuleTypes = await readBaseBranchRuleTypes({
      gh,
      repo: repos.base,
      branch: confirmed.baseRefName,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to re-read the branch rules for ${confirmed.baseRefName} in ${repos.base}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because a merge-queue base would accept a request this command cannot take back.`,
    );
  }
  if (confirmedRuleTypes.includes("merge_queue")) {
    throw new MergeRefusal(
      `${confirmed.baseRefName} in ${repos.base} gained a merge queue while you were confirming; ` +
        `re-run — this command cannot take back a queued request.`,
    );
  }

  // The merge below starts a fresh `gh`, which reads whatever credentials are
  // active then — not the ones read before the prompt. A `gh auth switch` while
  // the prompt was open would otherwise record one login in the ledger and
  // merge as another, which is exactly the attribution the ledger exists to
  // make true.
  const confirmedLogin = await resolveLogin({ gh, host: repos.host });
  if (confirmedLogin !== login) {
    throw new MergeRefusal(
      `the active GitHub login changed from ${login} to ${confirmedLogin} while you were confirming; re-run so the consent record names who is merging`,
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

  // Any outcome other than a confirmed merge may have left a standing request:
  // `gh pr merge` enqueues when the required checks pass and enables auto-merge
  // when they do not, and `--not-ready-reason` reaches that second path. GitHub
  // can complete such a request minutes or hours later, with none of the gates
  // above — the merge nobody approved, arriving late. So every path from here
  // reconciles rather than just reporting.
  const cancelPendingMerge = async () => {
    try {
      await gh([
        "pr",
        "merge",
        String(number),
        "--repo",
        repos.base,
        "--disable-auto",
      ]);
      // `--disable-auto` turns off auto-merge. It does NOT remove a pull
      // request already sitting in a merge queue, so this is not proof the
      // request is gone. Report the state actually observed afterwards rather
      // than claiming success, and name the case that still needs a hand.
      return (
        `Auto-merge has been disabled for this pull request. That does not ` +
        `remove a merge-queue entry: if the base uses a merge queue, dequeue ` +
        `it by hand and confirm, because a queued entry can still merge later ` +
        `without any of the gates above.`
      );
    } catch (err) {
      return (
        `A pending merge request could NOT be cancelled: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Cancel it by hand — until you do, this pull request can still merge ` +
        `later without any of the gates above.`
      );
    }
  };

  // The merge command itself can fail after the request reached GitHub — a
  // transport error, a truncated response — so its failure is an ambiguous
  // outcome, not a clean abort. Hold it and let the read below decide.
  let mergeError = null;
  try {
    await merge([
      "pr",
      "merge",
      String(number),
      "--repo",
      repos.base,
      MERGE_METHOD_FLAG,
      // Bind the merge to the head the operator was shown, so a push between
      // the briefing and the confirmation cannot merge a commit nobody
      // approved.
      "--match-head-commit",
      approved.headOid,
    ]);
  } catch (err) {
    mergeError = err instanceof Error ? err.message : String(err);
  }

  let outcome = null;
  let outcomeError = null;
  try {
    outcome = await readMergeOutcome({ gh, repo: repos.base, number });
  } catch (err) {
    outcomeError = err instanceof Error ? err.message : String(err);
  }

  if (outcome === null) {
    // Neither confirmed nor refuted. Cancel first, report second.
    const cancellation = await cancelPendingMerge();
    stdout.write(
      `Could not confirm the merge landed: ${outcomeError}\n` +
        (mergeError ? `The merge command also failed: ${mergeError}\n` : "") +
        `${cancellation}\n` +
        `Check ${repos.base}#${number} before running any post-merge step.\n`,
    );
    return { merged: false, verified: false, record, consentPath };
  }

  if (outcome.state !== "MERGED") {
    const cancellation = await cancelPendingMerge();
    stdout.write(
      `${repos.base}#${number} is ${outcome.state || "in an unreadable state"}, not merged — ` +
        `a queued or auto-merge target accepts the request without merging it. ` +
        (mergeError ? `The merge command also failed: ${mergeError}. ` : "") +
        `${cancellation}\n` +
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

  // MERGED alone does not mean this run's merge landed. If the head moved after
  // the final gate read and something else merged the new one, our
  // `--match-head-commit` request fails while this read still says MERGED —
  // and the consent record would then name a commit GitHub never merged.
  if (outcome.headRefOid === "") {
    stdout.write(
      `${repos.base}#${number} reports MERGED but names no head commit, so this ` +
        `run cannot confirm it merged ${approved.headOid}. ` +
        `Check it before running any post-merge step.\n`,
    );
    return {
      merged: true,
      verified: false,
      state: outcome.state,
      baseRefName: outcome.baseRefName,
      record,
      consentPath,
    };
  }

  if (outcome.headRefOid !== approved.headOid.toLowerCase()) {
    stdout.write(
      `WARNING: ${repos.base}#${number} is MERGED at ${outcome.headRefOid}, not the ` +
        `${approved.headOid} you approved. Something else merged a newer head. ` +
        `The consent record names the head you saw, which is not what landed — ` +
        `review ${outcome.baseRefName} now.\n`,
    );
    return {
      merged: true,
      verified: false,
      headMismatch: true,
      state: outcome.state,
      baseRefName: outcome.baseRefName,
      mergedHeadOid: outcome.headRefOid,
      record,
      consentPath,
    };
  }

  // GitHub says MERGED, so a failing merge command was a reporting failure
  // rather than a merge failure. Say so instead of hiding it.
  if (mergeError) {
    stdout.write(
      `The merge command reported an error (${mergeError}) but ${repos.base}#${number} ` +
        `is MERGED, so the merge itself landed.\n`,
    );
  }

  // `--match-head-commit` pins the head, and the merge API offers nothing that
  // pins the base: its only matching parameter is `sha`, for the head. So a
  // retarget landing between the final gate read and GitHub processing the
  // merge cannot be prevented here — it can only be detected and said out
  // loud, which is what this does. `exitCodeForResult` fails on it.
  if (outcome.baseRefName === "") {
    stdout.write(
      `${repos.base}#${number} reports MERGED but names no base branch, so this ` +
        `run cannot confirm it landed on ${approved.baseRefName}. ` +
        `Check it before running any post-merge step.\n`,
    );
    return {
      merged: true,
      verified: false,
      baseRefName: null,
      state: outcome.state,
      mergeCommit: outcome.mergeCommit,
      record,
      consentPath,
    };
  }

  const baseMismatch = outcome.baseRefName !== approved.baseRefName;
  if (baseMismatch) {
    stdout.write(
      `WARNING: ${repos.base}#${number} merged into ${outcome.baseRefName}, ` +
        `not the ${approved.baseRefName} you approved. The pull request was ` +
        `retargeted between the final check and the merge. Review ` +
        `${outcome.baseRefName} now — this merge was not the one consented to.\n`,
    );
  }

  return {
    merged: true,
    verified: true,
    baseMismatch,
    state: outcome.state,
    baseRefName: outcome.baseRefName,
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

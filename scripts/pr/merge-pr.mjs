#!/usr/bin/env node
/**
 * The sanctioned merge path for this repository.
 *
 * Merging is a human-only action here. No git hook or CI job sees the decision
 * to press the button, so this wrapper runs the ordered gates before it calls
 * GitHub's write API.
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
 * The final write uses the synchronous REST merge endpoint with the approved
 * head in `sha` and `merge_method=squash`. That endpoint either completes the
 * merge or fails. It cannot enqueue the pull request or enable auto-merge, so
 * an interrupt or a failed response cannot leave a request that GitHub later
 * completes outside these gates. Reconciliation verifies the outcome but never
 * disables auto-merge, because any request that appears after the final read
 * belongs to another operator.
 *
 * A merge-queue base refuses before the briefing and again after confirmation.
 * `Repository.mergeQueue` detects queues from rulesets and classic branch
 * protection. The ruleset read remains as a second diagnostic signal. The REST
 * endpoint can bypass a classic queue, so an unreadable answer from either read
 * refuses.
 *
 * Two races are detected rather than prevented. The request's `sha` pins the
 * head, and the merge endpoint has no base equivalent, so a retarget between
 * the final gate read and the merge request itself can still land on another
 * branch; the wrapper re-reads the base afterwards and fails loudly when it
 * moved. A title edited in that same window can likewise reach the squash
 * subject. Supplying `commit_title` would pin it, but this repository sets
 * `squash_merge_commit_title=COMMIT_OR_PR_TITLE`, so GitHub uses the single
 * commit's subject when there is one and appends `(#N)` — behaviour a fixed
 * title would replace on every merge. The REST request omits both title and
 * message fields, which also preserves `squash_merge_commit_message=COMMIT_MESSAGES`.
 * The title is bound in the confirmation signature instead.
 *
 * Agents must never invoke this script. Be honest about what makes that true.
 * The interactive-session refusal stops an agent that runs this command the
 * ordinary way, and `.claude/settings.json` denies `gh pr merge` along with the
 * repository-qualified spellings of it (`gh -R X pr merge`, `gh pr --repo X
 * merge`, and the `=` forms), so the obvious shortcuts are gone too. Neither is
 * an unforgeable boundary: a caller on this machine can allocate a
 * pseudo-terminal and clear the markers, and the deny is a command-pattern
 * list, so it covers the spellings someone thought to enumerate and not the
 * REST call this wrapper now uses, an alias, or other global flag orderings.
 * Using the API inside this sanctioned wrapper does not widen its authority;
 * agents remain forbidden from invoking the wrapper or the raw API merge.
 * A local process running as the operator can synthesize any local signal, so
 * no check in this file can be one. What the wrapper does provide is a default
 * that refuses, a briefing the operator must read, a confirmation they must
 * type, and an append-only consent record naming the confirmed GitHub login
 * and approved head. A credential switch after the final login read can still
 * misattribute that record; the accepted residual is below and in ADR 0075.
 * The approval rule itself remains the binding control, and the only
 * unforgeable boundary would live on GitHub's side of the wire;
 * `docs/adr/0075-pr-merge.md` records that decision and its
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
  MergeRefusal,
  buildConsentRecord,
  exitCodeForResult,
  formatBriefing,
  gateSignature,
  interactiveSessionRefusal,
  parseArgs as parseArgsCore,
  sanitizeTerminalText,
  usage,
} from "./merge-pr-core.mjs";
import {
  appendConsentRecord,
  promptLine,
  runGhInherit,
  runGit,
} from "./merge-pr-io.mjs";
import {
  mergeApprovedHead,
  readAutoMergeRequest,
  readBaseMergeQueue,
  readBaseBranchRuleTypes,
  reconcileMergeOutcome,
  resolveLogin,
  resolveRepositories,
  resolveTargetNumber,
} from "./merge-pr-github.mjs";
import { summarizeFeedbackState } from "./pr-feedback-state-core.mjs";
import { fetchReadyState, runGh, splitRepo } from "./pr-ready-state.mjs";

export {
  AUTOMATION_ENV_MARKERS,
  CONSENT_LOG_BASENAME,
  MERGE_METHOD,
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

  // `GH_HOST` picks the host for every call that did not name one. Naming the
  // host in `--repo` is not enough to be safe from it: the ready-state oracle
  // normalizes github.com back to "no host" and then omits `--hostname`, so a
  // `github.com/owner/name` target reads its readiness and feedback from
  // whatever `GH_HOST` points at while the merge still goes to github.com —
  // approving one repository's gates and merging another's. The only state
  // that is coherent is `GH_HOST` naming the very host being merged on.
  const targetHost = repos.host ?? "github.com";
  const ghHost = env?.GH_HOST ?? "";
  if (ghHost !== "" && ghHost !== targetHost) {
    throw new MergeRefusal(
      `GH_HOST is ${ghHost} but this would merge on ${targetHost} (${repos.base}), ` +
        `so the readiness reads and the merge could target different hosts; ` +
        `unset GH_HOST, or point it at the host you are merging on`,
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

  // Refuse a merge-queue base before anything is sent. Repository.mergeQueue
  // covers ruleset and classic branch-protection queues. This matters because
  // the synchronous REST endpoint can bypass a classic queue and merge
  // directly. The base is bound across the confirmation below.
  let baseMergeQueue;
  try {
    baseMergeQueue = await readBaseMergeQueue({
      gh,
      repo: repos.base,
      branch: approved.baseRefName,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to read the merge-queue state for ${sanitizeTerminalText(approved.baseRefName)} in ${repos.base}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because this command must prove the base has no queue before direct merge.`,
    );
  }
  if (baseMergeQueue !== null) {
    throw new MergeRefusal(
      `${sanitizeTerminalText(approved.baseRefName)} in ${repos.base} uses a merge queue. ` +
        `This command uses the synchronous direct-merge endpoint and will not enqueue it. ` +
        `Merge it through the queue deliberately instead.`,
    );
  }

  // Keep the ruleset read as a second queue signal and a specific diagnostic.
  let baseRuleTypes;
  try {
    baseRuleTypes = await readBaseBranchRuleTypes({
      gh,
      repo: repos.base,
      branch: approved.baseRefName,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to read the branch rules for ${sanitizeTerminalText(approved.baseRefName)} in ${repos.base}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because this command does not merge through a queue.`,
    );
  }
  let standingAutoMerge;
  try {
    standingAutoMerge = await readAutoMergeRequest({
      gh,
      repo: repos.base,
      number,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to read the auto-merge state of ${repos.base}#${number}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because this command must not merge over another operator's request.`,
    );
  }
  if (standingAutoMerge !== null) {
    throw new MergeRefusal(
      `${repos.base}#${number} already has auto-merge enabled, so GitHub is already ` +
        `holding a merge for it. This command will not merge over that or cancel it — ` +
        `someone asked for that merge outside these gates. Resolve it first.`,
    );
  }

  if (baseRuleTypes.includes("merge_queue")) {
    throw new MergeRefusal(
      `${sanitizeTerminalText(approved.baseRefName)} in ${repos.base} uses a merge queue. ` +
        `This command uses the synchronous direct-merge endpoint and will not enqueue it. ` +
        `Merge it through the queue deliberately instead.`,
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

  // The prompt has no time limit, and the REST `sha` only notices a new head
  // commit. A dismissed review, a rerun check, a retargeted base, or new
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
      `${repos.base}#${number} was retargeted from ${sanitizeTerminalText(approved.baseRefName)} to ${sanitizeTerminalText(confirmed.baseRefName)} while you were confirming; re-run to review the new base`,
    );
  }
  if (confirmed.signature !== approved.signature) {
    throw new MergeRefusal(
      `${repos.base}#${number} changed its readiness or feedback state while you were confirming; re-run to review it`,
    );
  }

  // Keep the ruleset diagnosis in the repeated gate set too.
  let confirmedRuleTypes;
  try {
    confirmedRuleTypes = await readBaseBranchRuleTypes({
      gh,
      repo: repos.base,
      branch: confirmed.baseRefName,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to re-read the branch rules for ${sanitizeTerminalText(confirmed.baseRefName)} in ${repos.base}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because this command does not merge through a queue.`,
    );
  }
  if (confirmedRuleTypes.includes("merge_queue")) {
    throw new MergeRefusal(
      `${sanitizeTerminalText(confirmed.baseRefName)} in ${repos.base} gained a merge queue while you were confirming; ` +
        `re-run after choosing the queue workflow deliberately.`,
    );
  }

  // Same reasoning for auto-merge. Re-read after the unbounded prompt so this
  // command does not merge over a request another operator created while the
  // briefing was open.
  let confirmedAutoMerge;
  try {
    confirmedAutoMerge = await readAutoMergeRequest({
      gh,
      repo: repos.base,
      number,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to re-read the auto-merge state of ${repos.base}#${number}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because this command must not merge over another operator's request.`,
    );
  }
  if (confirmedAutoMerge !== null) {
    throw new MergeRefusal(
      `${repos.base}#${number} gained an auto-merge request while you were confirming; ` +
        `re-run — this command will not merge over it or cancel it.`,
    );
  }

  // The merge below starts a fresh `gh`, which reads the credential active at
  // child-process start. Re-reading here narrows the unbounded prompt window.
  // It does not bind the child: `gh auth switch` can still run during the
  // consent-ledger write and make the merge use another account. That accepted
  // residual can misattribute the ledger but cannot bypass confirmation or
  // authorize another target. Capturing and injecting a token would add a
  // larger credential-handling surface to this trust-root wrapper (issue 2099;
  // ADR 0075).
  const confirmedLogin = await resolveLogin({ gh, host: repos.host });
  if (confirmedLogin !== login) {
    throw new MergeRefusal(
      `the active GitHub login changed from ${login} to ${confirmedLogin} while you were confirming; re-run so the consent record names who is merging`,
    );
  }

  // Make the authoritative queue check the final remote read. This minimizes
  // the interval in which a classic queue could be enabled before the direct
  // REST call, which can bypass that queue instead of refusing.
  let confirmedMergeQueue;
  try {
    confirmedMergeQueue = await readBaseMergeQueue({
      gh,
      repo: repos.base,
      branch: confirmed.baseRefName,
    });
  } catch (err) {
    throw new MergeRefusal(
      `unable to re-read the merge-queue state for ${sanitizeTerminalText(confirmed.baseRefName)} in ${repos.base}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing, because this command must prove the base still has no queue before direct merge.`,
    );
  }
  if (confirmedMergeQueue !== null) {
    throw new MergeRefusal(
      `${sanitizeTerminalText(confirmed.baseRefName)} in ${repos.base} gained a merge queue while you were confirming; ` +
        `re-run after choosing the queue workflow deliberately.`,
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

  // The merge command itself can fail after GitHub completed the merge — for
  // example, when the response is lost. Hold the error and let the outcome
  // read decide. The synchronous endpoint cannot leave a queued or auto-merge
  // request behind on any failure path.
  let mergeError = null;
  try {
    await mergeApprovedHead({
      merge,
      repo: repos.base,
      number,
      headOid: approved.headOid,
    });
  } catch (err) {
    mergeError = err instanceof Error ? err.message : String(err);
  }

  return reconcileMergeOutcome({
    gh,
    repo: repos.base,
    number,
    approved,
    mergeError,
    record,
    consentPath,
    write: (text) => stdout.write(text),
  });
}

async function main() {
  try {
    const result = await mergePullRequest({ argv: process.argv.slice(2) });
    const code = exitCodeForResult(result);
    if (code !== 0) {
      // A base mismatch IS a confirmed merge — it just landed somewhere the
      // operator never approved, and `reconcileMergeOutcome` already said so
      // above. Repeating "not confirmed" here would contradict that warning.
      process.stderr.write(
        result?.merged === true
          ? "merge-pr: not reporting success; see the outcome above\n"
          : "merge-pr: the merge was not confirmed; not reporting success\n",
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

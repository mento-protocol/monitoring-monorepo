/**
 * Every call this wrapper makes to GitHub, and the resolution built on them.
 *
 * `scripts/pr/merge-pr.mjs` orders the gates, `scripts/pr/merge-pr-core.mjs`
 * decides them, and `scripts/pr/merge-pr-io.mjs` owns the local side effects;
 * this module owns the remote ones. The `gh` runner is injected by the caller,
 * so the suite drives every path here without a real `gh` and without the
 * network.
 *
 * Tests: scripts/pr/merge-pr.test.mjs
 */

import {
  MergeRefusal,
  PR_NUMBER_PATTERN,
  hostFromRepoUrl,
  qualifyRepo,
} from "./merge-pr-core.mjs";
import { splitRepo } from "./pr-ready-state.mjs";

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

export async function resolveLogin({ gh, host }) {
  // Always name the host. `gh api` defaults to github.com, but that default is
  // itself overridable through `GH_HOST`, so an unqualified call could read the
  // login from a host this merge has nothing to do with and write it into the
  // consent ledger as the approving operator. The flag beats the environment.
  const args = [
    "api",
    "--hostname",
    host ?? "github.com",
    "user",
    "--jq",
    ".login",
  ];

  let login;
  try {
    login = (await gh(args)).trim();
  } catch (err) {
    throw new MergeRefusal(
      `unable to establish the active GitHub login: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Underscores are allowed: an Enterprise Managed User's login carries the
  // enterprise shortcode after one (`octocat_fabrikam`). Rejecting it would
  // stop every merge on such an account before the briefing. The pattern still
  // has to be narrow — this value is written into the ledger — so it stays
  // ASCII, bounded, and free of whitespace, quotes and shell metacharacters.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(login)) {
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
export async function readMergeOutcome({ gh, repo, number }) {
  const parsed = JSON.parse(
    await gh([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "state,mergeCommit,baseRefName,headRefOid",
    ]),
  );
  return {
    state: String(parsed?.state ?? "").toUpperCase(),
    mergeCommit: parsed?.mergeCommit?.oid ?? null,
    baseRefName: String(parsed?.baseRefName ?? ""),
    headRefOid: String(parsed?.headRefOid ?? "").toLowerCase(),
  };
}

/**
 * The rule types GitHub applies to one branch through its rulesets.
 *
 * Ruleset-sourced only. A merge queue enabled through
 * a CLASSIC branch-protection rule does not surface here, so this narrows the
 * window rather than closing it — `reconcileMergeOutcome` still catches such an
 * enqueue afterwards, reports it and exits non-zero.
 *
 * Used to refuse a merge-queue base before the merge request exists. `gh pr
 * merge` enqueues such a base and returns success, and `--disable-auto` does
 * not remove a queue entry — so merging first would create a standing request
 * this wrapper cannot take back, which GitHub could complete later with none
 * of the gates. Checking first is the only fail-closed order.
 */
export async function readBaseBranchRuleTypes({ gh, repo, branch }) {
  const { owner, name, host } = splitRepo(repo);
  const parsed = JSON.parse(
    await gh([
      "api",
      // Same reason `resolveLogin` names its host: `splitRepo` strips the host
      // off the repository, and a bare `gh api` would then read rules from
      // whatever host is configured — an unrelated same-named repository on
      // github.com, in the Enterprise case.
      "--hostname",
      host ?? "github.com",
      // A branch can carry more rules than one page holds, and a `merge_queue`
      // rule missed on page two would permit exactly the request this refuses.
      "--paginate",
      "--slurp",
      `repos/${owner}/${name}/rules/branches/${encodeURIComponent(branch)}`,
    ]),
  );
  if (!Array.isArray(parsed)) {
    throw new Error("the branch-rules response was not a list");
  }
  // `--slurp` wraps each page in its own array; a single unpaginated page is
  // already flat. `flat()` accepts both.
  return parsed.flat().map((rule) => String(rule?.type ?? ""));
}

/**
 * Decide what actually happened after the merge command, and leave nothing
 * standing behind.
 *
 * Any outcome other than a confirmed merge may have left a standing request:
 * `gh pr merge` enqueues when the required checks pass and enables auto-merge
 * when they do not, and `--not-ready-reason` reaches that second path. GitHub
 * can complete such a request minutes or hours later, with none of the gates
 * the wrapper ran — the merge nobody approved, arriving late. So every path
 * here reconciles rather than merely reporting.
 *
 * The caller refuses a pull request that already had auto-merge enabled, so
 * any request cancelled here is one this run created rather than another
 * operator's unrelated state.
 *
 * @param write receives operator-facing lines, normally `stdout.write`.
 */
export async function reconcileMergeOutcome({
  gh,
  repo,
  number,
  approved,
  mergeError,
  record,
  consentPath,
  write,
}) {
  const cancelPendingMerge = async () => {
    try {
      await gh([
        "pr",
        "merge",
        String(number),
        "--repo",
        repo,
        "--disable-auto",
      ]);
      // `--disable-auto` turns off auto-merge. It does NOT remove a pull
      // request already sitting in a merge queue, so this is not proof the
      // request is gone. Report what the command actually does, and name the
      // case that still needs a hand.
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

  let outcome = null;
  let outcomeError = null;
  try {
    outcome = await readMergeOutcome({ gh, repo, number });
  } catch (err) {
    outcomeError = err instanceof Error ? err.message : String(err);
  }

  if (outcome === null) {
    // Neither confirmed nor refuted. Cancel first, report second.
    const cancellation = await cancelPendingMerge();
    write(
      `Could not confirm the merge landed: ${outcomeError}\n` +
        (mergeError ? `The merge command also failed: ${mergeError}\n` : "") +
        `${cancellation}\n` +
        `Check ${repo}#${number} before running any post-merge step.\n`,
    );
    return { merged: false, verified: false, record, consentPath };
  }

  // A closed pull request is not a queued one. Cancelling auto-merge on it
  // fails, and reporting that failure as "this can still merge later" would be
  // both false and alarming — GitHub will not merge a closed pull request.
  if (outcome.state === "CLOSED") {
    write(
      `${repo}#${number} is CLOSED, not merged. Nothing was merged and there is ` +
        `no pending request to cancel: GitHub does not merge a closed pull request. ` +
        (mergeError ? `The merge command also failed: ${mergeError}. ` : "") +
        `\nThe consent record stays in the ledger as evidence of what was approved.\n`,
    );
    return {
      merged: false,
      verified: true,
      closed: true,
      state: outcome.state,
      record,
      consentPath,
    };
  }

  if (outcome.state !== "MERGED") {
    const cancellation = await cancelPendingMerge();
    write(
      `${repo}#${number} is ${outcome.state || "in an unreadable state"}, not merged — ` +
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

  if (outcome.baseRefName === "") {
    write(
      `${repo}#${number} reports MERGED but names no base branch, so this run ` +
        `cannot confirm it landed on ${approved.baseRefName}. ` +
        `Check it before running any post-merge step.\n`,
    );
    return {
      merged: true,
      verified: false,
      state: outcome.state,
      baseRefName: null,
      mergeCommit: outcome.mergeCommit,
      record,
      consentPath,
    };
  }

  if (outcome.headRefOid === "") {
    write(
      `${repo}#${number} reports MERGED but names no head commit, so this run ` +
        `cannot confirm it merged ${approved.headOid}. ` +
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

  // MERGED alone does not mean this run's merge landed. If the head moved after
  // the final gate read and something else merged the new one, our
  // `--match-head-commit` request fails while this read still says MERGED —
  // and the consent record would then name a commit GitHub never merged.
  if (outcome.headRefOid !== approved.headOid.toLowerCase()) {
    write(
      `WARNING: ${repo}#${number} is MERGED at ${outcome.headRefOid}, not the ` +
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
    write(
      `The merge command reported an error (${mergeError}) but ${repo}#${number} ` +
        `is MERGED, so the merge itself landed.\n`,
    );
  }

  // `--match-head-commit` pins the head, and the merge API offers nothing that
  // pins the base: its only matching parameter is `sha`, for the head. So a
  // retarget landing between the final gate read and GitHub processing the
  // merge cannot be prevented — only detected, which is what this does.
  const baseMismatch = outcome.baseRefName !== approved.baseRefName;
  if (baseMismatch) {
    write(
      `WARNING: ${repo}#${number} merged into ${outcome.baseRefName}, ` +
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

/**
 * The auto-merge request already standing on a pull request, or null.
 *
 * A pull request someone else has already queued for automatic merge is not a
 * state this wrapper can reconcile: its own cleanup would cancel that unrelated
 * request, and it cannot tell compensation from interference. Refusing up front
 * both avoids that and makes the cleanup provably its own.
 */
export async function readAutoMergeRequest({ gh, repo, number }) {
  const parsed = JSON.parse(
    await gh([
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "autoMergeRequest",
    ]),
  );
  return parsed?.autoMergeRequest ?? null;
}

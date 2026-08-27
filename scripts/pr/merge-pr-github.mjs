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
      "state,mergeCommit,baseRefName",
    ]),
  );
  return {
    state: String(parsed?.state ?? "").toUpperCase(),
    mergeCommit: parsed?.mergeCommit?.oid ?? null,
    baseRefName: String(parsed?.baseRefName ?? ""),
  };
}

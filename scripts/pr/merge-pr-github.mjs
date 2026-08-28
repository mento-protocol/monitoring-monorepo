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
  MERGE_METHOD,
  MergeRefusal,
  PR_NUMBER_PATTERN,
  hostFromRepoUrl,
  qualifyRepo,
  sanitizeTerminalText,
} from "./merge-pr-core.mjs";
import { splitRepo } from "./pr-ready-state.mjs";

/**
 * How many open pull requests to consider when resolving an implicit target.
 * Reaching this many refuses rather than guessing: `gh pr list` truncates
 * silently, and a hidden second candidate would defeat the ambiguity gate.
 */
const PR_LIST_LIMIT = 100;

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
        // `gh pr list` defaults to 30. A candidate past that cutoff is
        // invisible, which does not merely lose a match — it can hide the
        // SECOND candidate and turn the ambiguity refusal below into a
        // confident pick of the wrong pull request.
        "--limit",
        String(PR_LIST_LIMIT),
        "--json",
        "number,headRepositoryOwner",
      ]),
    );
  } catch (err) {
    throw new MergeRefusal(
      `unable to list pull requests for ${branch}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Hitting the cap means the candidate set may be truncated, so neither a
  // single match nor the ambiguity refusal can be trusted. Name the target.
  if (Array.isArray(listed) && listed.length >= PR_LIST_LIMIT) {
    throw new MergeRefusal(
      `${repos.base} has at least ${PR_LIST_LIMIT} open pull requests, so the ` +
        `candidates for ${branch} cannot be enumerated reliably; pass --pr <number>`,
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
 * Merge the approved head through GitHub's synchronous REST endpoint.
 *
 * This endpoint either completes the merge or fails. It does not enqueue the
 * pull request and does not enable auto-merge. The request supplies only the
 * approved head and the repository's fixed merge method. It omits
 * `commit_title` and `commit_message`, so GitHub applies the repository's
 * configured squash title and message defaults.
 */
export async function mergeApprovedHead({ merge, repo, number, headOid }) {
  const { owner, name, host } = splitRepo(repo);
  await merge([
    "api",
    "--hostname",
    host ?? "github.com",
    "--method",
    "PUT",
    `repos/${owner}/${name}/pulls/${number}/merge`,
    "--raw-field",
    `sha=${headOid}`,
    "--raw-field",
    `merge_method=${MERGE_METHOD}`,
  ]);
}

/**
 * Ask GitHub whether the pull request is actually merged.
 *
 * The synchronous merge endpoint returns only after a merge or a failure, but
 * a transport failure can hide a completed merge. This read binds the outcome
 * to the approved head and base before callers run post-merge closeout.
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
 * The merge queue configured for one base branch, or null when none exists.
 *
 * `Repository.mergeQueue` covers queues enabled through either a ruleset or a
 * classic branch-protection rule. The synchronous REST merge endpoint can
 * bypass a classic queue, so callers must prove this value is null before they
 * send the merge request. A missing or malformed response is not proof and
 * therefore throws.
 */
export async function readBaseMergeQueue({ gh, repo, branch }) {
  const { owner, name, host } = splitRepo(repo);
  const parsed = JSON.parse(
    await gh([
      "api",
      "--hostname",
      host ?? "github.com",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id url}}}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-f",
      `branch=${branch}`,
    ]),
  );

  return parseMergeQueueResponse(parsed).mergeQueue;
}

function parseMergeQueueResponse(parsed) {
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new Error("the merge-queue query returned GraphQL errors");
  }
  const repository = parsed?.data?.repository;
  if (
    repository === null ||
    typeof repository !== "object" ||
    !Object.hasOwn(repository, "mergeQueue")
  ) {
    throw new Error("the merge-queue response did not identify the branch");
  }
  const queue = repository.mergeQueue;
  if (queue !== null && typeof queue !== "object") {
    throw new Error("the merge-queue response was malformed");
  }
  return { repository, mergeQueue: queue };
}

/**
 * The final base, merge-queue, and auto-merge state from one GraphQL response.
 *
 * Reading both intent gates together removes the extra remote round trip that
 * would otherwise leave one state older than the other immediately before the
 * direct merge. Returning the pull request's current base also proves that the
 * queue query still names that base. The REST request separately binds the
 * approved head through `sha`. The response is still not atomic with the later
 * REST write, so callers must keep this as their final remote read and refuse
 * every malformed or partial response.
 */
export async function readFinalMergeIntent({ gh, repo, branch, number }) {
  const { owner, name, host } = splitRepo(repo);
  const parsed = JSON.parse(
    await gh([
      "api",
      "--hostname",
      host ?? "github.com",
      "graphql",
      "-f",
      `query=query($owner:String!,$name:String!,$branch:String!,$number:Int!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id url} pullRequest(number:$number){baseRefName autoMergeRequest{enabledAt}}}}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-f",
      `branch=${branch}`,
      "-F",
      `number=${number}`,
    ]),
  );

  const { repository, mergeQueue } = parseMergeQueueResponse(parsed);
  const pullRequest = repository.pullRequest;
  if (
    pullRequest === null ||
    typeof pullRequest !== "object" ||
    !Object.hasOwn(pullRequest, "baseRefName") ||
    !Object.hasOwn(pullRequest, "autoMergeRequest")
  ) {
    throw new Error(
      "the final merge-intent response did not identify the pull request",
    );
  }
  const baseRefName = pullRequest.baseRefName;
  if (typeof baseRefName !== "string" || baseRefName === "") {
    throw new Error("the final merge-intent response named no base branch");
  }
  const autoMergeRequest = pullRequest.autoMergeRequest;
  if (autoMergeRequest !== null && typeof autoMergeRequest !== "object") {
    throw new Error("the final auto-merge response was malformed");
  }
  return { baseRefName, mergeQueue, autoMergeRequest };
}

/**
 * The rule types GitHub applies to one branch through its rulesets.
 *
 * Ruleset-sourced only. The `Repository.mergeQueue` reads are the authoritative
 * queue gate because they also detect classic branch-protection queues. This
 * read keeps the ruleset-specific diagnosis and provides a second refusal
 * signal.
 *
 * Used to refuse a merge-queue base before the briefing. Queue-managed bases
 * need a deliberate queue workflow, and this read gives the operator that
 * specific reason before consent is recorded.
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
 * Decide what actually happened after the synchronous merge request.
 *
 * The request cannot enqueue or enable auto-merge. A failed or unreadable
 * outcome therefore needs reporting and verification only. It must never call
 * `--disable-auto`, because an auto-merge request that appears after the final
 * gate read belongs to another operator.
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
  let outcome = null;
  let outcomeError = null;
  try {
    outcome = await readMergeOutcome({ gh, repo, number });
  } catch (err) {
    outcomeError = err instanceof Error ? err.message : String(err);
  }

  if (outcome === null) {
    write(
      `Could not confirm the merge landed: ${sanitizeTerminalText(outcomeError)}\n` +
        (mergeError
          ? `The merge command also failed: ${sanitizeTerminalText(mergeError)}\n`
          : "") +
        `The synchronous merge endpoint cannot queue this pull request or enable ` +
        `auto-merge, so this run created no standing merge request.\n` +
        `Check ${repo}#${number} before running any post-merge step.\n`,
    );
    return { merged: false, verified: false, record, consentPath };
  }

  if (outcome.state === "CLOSED") {
    write(
      `${repo}#${number} is CLOSED, not merged. Nothing was merged and there is ` +
        `no request from this run pending: the synchronous endpoint does not queue. ` +
        (mergeError
          ? `The merge command also failed: ${sanitizeTerminalText(mergeError)}. `
          : "") +
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
    write(
      `${repo}#${number} is ${outcome.state || "in an unreadable state"}, not merged — ` +
        `the synchronous endpoint did not complete the merge. ` +
        (mergeError
          ? `The merge command also failed: ${sanitizeTerminalText(mergeError)}. `
          : "") +
        `This run created no queued or auto-merge request.\n` +
        `Do not run post-merge steps until it reports MERGED.\n`,
    );
    return {
      merged: false,
      verified: true,
      state: outcome.state,
      record,
      consentPath,
    };
  }

  if (outcome.baseRefName === "") {
    write(
      `${repo}#${number} reports MERGED but names no base branch, so this run ` +
        `cannot confirm it landed on ${sanitizeTerminalText(approved.baseRefName)}. ` +
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
  // the final gate read and something else merged the new one, the REST
  // request's `sha` check fails while this read still says MERGED — and the
  // consent record would then name a commit GitHub never merged.
  if (outcome.headRefOid !== approved.headOid.toLowerCase()) {
    write(
      `WARNING: ${repo}#${number} is MERGED at ${outcome.headRefOid}, not the ` +
        `${approved.headOid} you approved. Something else merged a newer head. ` +
        `The consent record names the head you saw, which is not what landed — ` +
        `review ${sanitizeTerminalText(outcome.baseRefName)} now.\n`,
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
      `The merge command reported an error (${sanitizeTerminalText(mergeError)}) but ${repo}#${number} ` +
        `is MERGED, so the merge itself landed.\n`,
    );
  }

  // The request's `sha` pins the head, and the merge API offers nothing that
  // pins the base. So a
  // retarget landing between the final gate read and GitHub processing the
  // merge cannot be prevented — only detected, which is what this does.
  const baseMismatch = outcome.baseRefName !== approved.baseRefName;
  if (baseMismatch) {
    write(
      `WARNING: ${repo}#${number} merged into ${sanitizeTerminalText(outcome.baseRefName)}, ` +
        `not the ${sanitizeTerminalText(approved.baseRefName)} you approved. The pull request was ` +
        `retargeted between the final check and the merge. Review ` +
        `${sanitizeTerminalText(outcome.baseRefName)} now — this merge was not the one consented to.\n`,
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
 * state this wrapper should merge over. Refusing up front preserves the other
 * operator's request and makes them resolve that intent explicitly.
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

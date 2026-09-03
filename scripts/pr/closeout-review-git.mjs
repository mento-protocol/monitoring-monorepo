/**
 * Closeout review: base resolution and target fingerprints. The review is only
 * as trustworthy as the range it names, so the base comes from the remote that
 * actually holds the repository `gh` resolved, and the fingerprint records the
 * bytes codex read. `scripts/pr/closeout-review.mjs` owns the flow; this
 * module owns the range.
 */
import { createHash } from "node:crypto";

import { fail, run } from "./closeout-review-exec.mjs";

/**
 * `owner/name` for a remote URL, or null when the URL does not name a
 * repository on `github.com`. The host is part of the identity: a mirror at
 * `https://mirror.example/<owner>/<name>.git` carries the same last two path
 * segments as the GitHub repository `gh` resolved, and accepting it would let
 * a stale or third-party copy supply the base the review diffs against.
 */
function repoFromRemoteUrl(url) {
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  let host;
  let repoPath;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
  } else if (scp) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    return null;
  }
  if (host.toLowerCase() !== "github.com") return null;
  const match = repoPath.match(/^\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The one configured remote serving `repo`. More than one is a stop. Only the
 * `(fetch)` URL counts: a remote can carry a separate push URL, and the fetch
 * side is the one the base is read through.
 */
function remoteForRepo(repoRoot, repo) {
  const remotes = run("git", ["remote", "-v"], repoRoot);
  if (!remotes.ok) fail("cannot read the configured remotes");
  const names = new Set();
  for (const line of remotes.stdout.split("\n")) {
    const parsed = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!parsed || parsed[3] !== "fetch") continue;
    const [, name, url] = parsed;
    if (repoFromRemoteUrl(url)?.toLowerCase() === repo.toLowerCase()) {
      names.add(name);
    }
  }
  if (names.size !== 1) {
    fail(
      `cannot resolve base: ${names.size} remotes serve ${repo}; pass --base`,
    );
  }
  return [...names][0];
}

/**
 * Mirror operating-card step 5: resolve the base repository from evidence, then
 * the remote serving it, then this branch's open PR on that repository. A
 * failed query is never read as "no PR"; it is a stop.
 */
export function resolveBase(repoRoot) {
  const view = run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,parent,defaultBranchRef"],
    repoRoot,
  );
  if (!view.ok) fail("cannot resolve base: gh repo view failed; pass --base");
  let repoInfo;
  try {
    repoInfo = JSON.parse(view.stdout);
  } catch {
    fail("cannot resolve base: gh repo view returned no JSON; pass --base");
  }
  const currentRepo = repoInfo.nameWithOwner;
  const baseRepo = repoInfo.parent?.nameWithOwner ?? currentRepo;
  if (!currentRepo || !baseRepo) {
    fail("cannot resolve base: gh named no repository; pass --base");
  }
  const baseRemote = remoteForRepo(repoRoot, baseRepo);

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (!branch.ok || branch.stdout === "HEAD") {
    fail("cannot resolve base: HEAD is detached; pass --base");
  }
  const list = run(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      baseRepo,
      "--head",
      branch.stdout,
      "--state",
      "open",
      "--limit",
      // `gh pr list` pages at 30 by default. A branch name shared across forks
      // could push this repository's own PR off that page and read as "no PR",
      // so ask for more than any real branch attracts and refuse a full page.
      "100",
      "--json",
      "baseRefName,headRepositoryOwner",
    ],
    repoRoot,
  );
  if (!list.ok) fail("cannot resolve base: gh pr list failed; pass --base");
  let pulls;
  try {
    pulls = JSON.parse(list.stdout);
  } catch {
    fail("cannot resolve base: gh pr list returned no JSON; pass --base");
  }
  if (pulls.length >= 100) {
    fail(
      `cannot resolve base: ${pulls.length} open PRs match ${branch.stdout}; pass --base`,
    );
  }
  const headOwner = currentRepo.split("/")[0].toLowerCase();
  const mine = pulls.filter(
    (pull) => pull.headRepositoryOwner?.login?.toLowerCase() === headOwner,
  );
  if (mine.length > 1) {
    fail(
      `cannot resolve base: ${mine.length} open PRs match ${branch.stdout}; pass --base`,
    );
  }
  const baseRef =
    mine.length === 1
      ? mine[0].baseRefName
      : defaultBranchOf(repoRoot, baseRepo, currentRepo, repoInfo);
  return `${baseRemote}/${baseRef}`;
}

/**
 * The base repository's default branch. Card step 4 runs before the PR exists,
 * so zero open PRs is the normal first pass, not an error; the branch it falls
 * back to is read from the repository rather than assumed to be `main`.
 */
function defaultBranchOf(repoRoot, baseRepo, currentRepo, repoInfo) {
  let branch;
  if (baseRepo === currentRepo) {
    branch = repoInfo.defaultBranchRef?.name ?? null;
  } else {
    const view = run(
      "gh",
      ["repo", "view", baseRepo, "--json", "defaultBranchRef"],
      repoRoot,
    );
    if (!view.ok) {
      fail(`cannot resolve base: gh repo view ${baseRepo} failed; pass --base`);
    }
    try {
      branch = JSON.parse(view.stdout).defaultBranchRef?.name ?? null;
    } catch {
      branch = null;
    }
  }
  if (!branch) {
    fail(
      `cannot resolve base: no open PR for this branch and ${baseRepo} names ` +
        "no default branch; pass --base",
    );
  }
  return branch;
}

/**
 * Fetch the base when it is a remote-tracking ref, then verify it resolves. A
 * failed fetch is fatal: a stale tracking ref still resolves, so continuing
 * would review the wrong base without saying so.
 */
export function verifyBase(repoRoot, base, shouldFetch) {
  if (shouldFetch) {
    const remotes = run("git", ["remote"], repoRoot);
    // A remote name may itself hold slashes, so take the longest configured
    // name the base starts with rather than splitting on the first one.
    let remote = null;
    if (remotes.ok) {
      for (const name of remotes.stdout.split("\n")) {
        if (!name || !base.startsWith(`${name}/`)) continue;
        if (remote === null || name.length > remote.length) remote = name;
      }
    }
    if (remote !== null) {
      const branch = base.slice(remote.length + 1);
      // An explicit refspec, because a bare `git fetch <remote> <branch>` can
      // exit 0 having updated only FETCH_HEAD — a single-branch clone whose
      // configured mapping does not cover this branch leaves the
      // remote-tracking ref stale, and the review would run on the old base.
      const fetched = run(
        "git",
        [
          "fetch",
          "--quiet",
          remote,
          `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        ],
        repoRoot,
      );
      if (!fetched.ok) {
        fail(`cannot fetch ${base}: ${fetched.stderr || "git fetch failed"}`);
      }
    }
  }
  const sha = run(
    "git",
    ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
    repoRoot,
  );
  if (!sha.ok || !sha.stdout) fail(`base ${base} does not resolve to a commit`);
  return sha.stdout;
}

/**
 * The commit codex reviews from. Its own report summaries say "against the
 * specified merge base", so a base holding commits HEAD does not have — a base
 * that moved after the last merge forward — must not be diffed directly: the
 * two-dot form would count those base-only changes in reverse and overstate
 * the branch. No merge base is a stop: a shallow or single-branch checkout can
 * resolve the base ref and still hold no common ancestry, and the header hands
 * `merge_base_sha` to the reviewer as a commit naming the reviewed range.
 */
export function mergeBase(repoRoot, base) {
  const found = run("git", ["merge-base", "HEAD", base], repoRoot);
  if (!found.ok || !/^[0-9a-f]{40}$/.test(found.stdout)) {
    fail(
      `no merge base between HEAD and ${base}; deepen the checkout ` +
        "(git fetch --unshallow) or pass a --base that shares history",
    );
  }
  return found.stdout;
}

/**
 * The size codex will see. It diffs the working tree against the merge base,
 * not `base...HEAD`, so this uses the two-dot form against that commit.
 * Untracked files appear in neither; the `dirty` header field is the flag for
 * uncommitted work.
 */
export function shortstat(repoRoot, from) {
  const stat = run(
    "git",
    ["diff", "--no-ext-diff", "--shortstat", from],
    repoRoot,
  );
  return stat.ok && stat.stdout ? stat.stdout : "0 files changed";
}

/**
 * What the reviewer is reading: HEAD, the index and working-tree state, and the
 * tracked content that differs from HEAD. It is taken before the run and again
 * after it, so a target that shifts under the reviewer is caught instead of
 * being reported as reviewed. `dirty` alone cannot do this: an edit to an
 * already-modified file leaves the flag and the status lines unchanged.
 * Untracked content is outside the fingerprint exactly as it is outside
 * `--base`; the status listing still names those paths.
 *
 * `--submodule=diff` is what makes this true inside a submodule too. codex
 * reads those files like any others, but to the parent repository every edit
 * under a checked-out submodule is the same ` M <path>` status line and the
 * same `Subproject commit <sha>-dirty` diff marker, so without the nested diff
 * the two fingerprints would agree over bytes that changed.
 */
export function treeFingerprint(repoRoot) {
  const parts = [
    run("git", ["rev-parse", "HEAD"], repoRoot),
    run("git", ["status", "--porcelain"], repoRoot),
    run("git", ["diff", "--no-ext-diff", "--submodule=diff", "HEAD"], repoRoot),
  ];
  if (parts.some((part) => !part.ok)) return null;
  return (
    createHash("sha256")
      // Raw, not trimmed: a trailing space gained or lost on the last changed
      // line is a byte codex reads, and trimming would hide that edit.
      .update(parts.map((part) => part.raw).join("\0"))
      .digest("hex")
  );
}

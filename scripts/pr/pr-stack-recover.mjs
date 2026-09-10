#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const HELP = `Usage: node scripts/pr/pr-stack-recover.mjs
  --old-parent FULL_SHA --old-head FULL_SHA --new-base FULL_SHA
  --worktree NEW_ABSOLUTE_PATH --branch NEW_BRANCH [--repo PATH]

Local-only candidate preparation. Fetch and verify remote ownership separately.
Preserves pinned commits in new backup refs and creates an isolated worktree.
Replays a linear child-only range, recording git cherry proof for skipped patches.
Writes review receipts to NEW_ABSOLUTE_PATH.receipt (must not exist).
Its comparison.git reads source objects through alternates without source config.
Conflicts leave the candidate and cherry-pick state intact for inspection.
After --continue, explicitly replay remaining after its first (failed) commit.
--continue completes one commit here, not the unattempted suffix.
Never publishes, merges, resets, aborts, deletes, or changes pre-existing refs.
Review both axes and validate the candidate before a separately authorized push.
`;

function git(
  repo,
  args,
  { allowFailure = false, input, isolatedConfig = false } = {},
) {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
  ])
    delete env[key];
  if (isolatedConfig) {
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("GIT_CONFIG") ||
        ["GIT_TEMPLATE_DIR", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS"].includes(key)
      )
        delete env[key];
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_SYSTEM = "/dev/null";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_ATTR_NOSYSTEM = "1";
  }
  const result = spawnSync("git", args, {
    env,
    cwd: repo,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result;
}
const output = (repo, args) => git(repo, args).stdout.trim();
const ancestor = (repo, older, newer) => {
  const result = git(repo, ["merge-base", "--is-ancestor", older, newer], {
    allowFailure: true,
  });
  if (result.status > 1) throw new Error(result.stderr);
  return result.status === 0;
};

export function parseRecoveryArgs(args) {
  const names = new Map([
    ["--old-parent", "oldParent"],
    ["--old-head", "oldHead"],
    ["--new-base", "newBase"],
    ["--worktree", "worktree"],
    ["--branch", "branch"],
    ["--repo", "repo"],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--") || key in options)
      throw new Error(`Invalid or duplicate argument: ${args[index]}`);
    options[key] = value;
  }
  return options;
}

function newPath(path, roots) {
  if (!path || !isAbsolute(path))
    throw new Error("Worktree path must be absolute");
  const normalized = resolve(path);
  const resolved = join(
    realpathSync(dirname(normalized)),
    basename(normalized),
  );
  for (const root of roots) {
    const inside = relative(root, resolved);
    if (!inside || (!inside.startsWith("../") && !isAbsolute(inside)))
      throw new Error("Destination must be outside existing worktrees");
  }
  try {
    lstatSync(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return resolved;
    throw error;
  }
  throw new Error(`Destination already exists: ${resolved}`);
}

function validate(options) {
  const repo = realpathSync(
    output(resolve(options.repo ?? "."), ["rev-parse", "--show-toplevel"]),
  );
  for (const key of ["oldParent", "oldHead", "newBase"]) {
    const sha = options[key];
    if (
      !/^[0-9a-f]{40}$/.test(sha ?? "") ||
      output(repo, ["cat-file", "-t", sha]) !== "commit"
    )
      throw new Error(`${key} must be a full commit SHA`);
  }
  if (!ancestor(repo, options.oldParent, options.oldHead))
    throw new Error("Old parent must be an ancestor of old head");
  if (ancestor(repo, options.oldHead, options.newBase))
    throw new Error("New base already contains the old child head");
  if (
    ancestor(repo, options.newBase, options.oldHead) &&
    !ancestor(repo, options.newBase, options.oldParent)
  )
    throw new Error("New base lies inside the child range");
  output(repo, ["merge-base", options.oldParent, options.newBase]);
  const range = `${options.oldParent}..${options.oldHead}`;
  const commits = output(repo, ["rev-list", "--reverse", range])
    .split("\n")
    .filter(Boolean);
  if (
    !commits.length ||
    commits.length > 100 ||
    output(repo, ["rev-list", "--merges", range])
  )
    throw new Error(
      "Require a nonempty linear child range of at most 100 commits",
    );
  if (
    !options.branch ||
    options.branch.startsWith("-") ||
    git(repo, ["check-ref-format", `refs/heads/${options.branch}`], {
      allowFailure: true,
    }).status !== 0
  )
    throw new Error("Require a valid new branch name");
  if (
    git(repo, ["show-ref", "--verify", `refs/heads/${options.branch}`], {
      allowFailure: true,
    }).status === 0
  )
    throw new Error("Candidate branch already exists");
  const roots = git(repo, ["worktree", "list", "--porcelain", "-z"])
    .stdout.split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => realpathSync(field.slice(9)));
  const worktree = newPath(options.worktree, roots);
  const receiptDir = newPath(`${worktree}.receipt`, roots);
  const cherryProof = output(repo, [
    "cherry",
    options.newBase,
    options.oldHead,
    options.oldParent,
  ]);
  const equivalent = new Set(
    cherryProof
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2)),
  );
  if (
    commits.every(
      (commit) =>
        equivalent.has(commit) || ancestor(repo, commit, options.newBase),
    )
  )
    throw new Error("All child commits are already represented in new base");
  return {
    ...options,
    repo,
    worktree,
    receiptDir,
    commits,
    cherryProof,
    equivalent,
  };
}

function comparisonRepository(plan) {
  // range-diff invokes log internally without forwarding --no-textconv.
  // A bare reader with no source config prevents drivers from executing there.
  const repo = join(plan.receiptDir, "comparison.git");
  git(plan.receiptDir, ["init", "--bare", "--template=", repo], {
    isolatedConfig: true,
  });
  const objects = resolve(
    plan.repo,
    output(plan.repo, ["rev-parse", "--git-common-dir"]),
    "objects",
  );
  if (objects.includes("\n"))
    throw new Error("Object directory cannot contain a newline");
  writeFileSync(join(repo, "objects", "info", "alternates"), `${objects}\n`);
  return repo;
}

function writeReceipts(plan, receipt) {
  const comparison = comparisonRepository(plan);
  const artifacts = [
    [
      "old-child.patch",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
        plan.oldHead,
        receipt.candidateHead,
      ],
    ],
    [
      "new-base.patch",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
        plan.newBase,
        receipt.candidateHead,
      ],
    ],
    [
      "range-diff.txt",
      [
        "range-diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        `${plan.oldParent}..${plan.oldHead}`,
        `${plan.newBase}..${receipt.candidateHead}`,
      ],
      comparison,
      true,
    ],
  ];
  if (receipt.candidateTree) {
    artifacts.push(
      [
        "working-tree.patch",
        ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary"],
        plan.worktree,
      ],
      [
        "index.patch",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--binary",
          "--cached",
        ],
        plan.worktree,
      ],
    );
  }
  receipt.artifactScope =
    receipt.status === "prepared"
      ? "complete-candidate"
      : "committed-prefix-only; inspect working-tree.patch, index.patch, and candidateStatus for unresolved state";
  for (const [
    name,
    args,
    repo = plan.repo,
    isolatedConfig = false,
  ] of artifacts) {
    const result = git(repo, args, { allowFailure: true, isolatedConfig });
    writeFileSync(join(plan.receiptDir, name), result.stdout);
    if (result.status !== 0)
      receipt.artifactErrors.push({ name, error: result.stderr });
  }
  writeFileSync(
    join(plan.receiptDir, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

export function prepareRecovery(options) {
  const plan = validate(options);
  const backupPrefix = `refs/stack-recovery/${randomUUID()}`;
  const backups = Object.fromEntries(
    ["oldParent", "oldHead", "newBase"].map((key) => [
      key,
      `${backupPrefix}/${key}`,
    ]),
  );
  mkdirSync(plan.receiptDir);
  git(plan.repo, ["update-ref", "--stdin"], {
    input: `start\n${Object.entries(backups)
      .map(([key, ref]) => `create ${ref} ${plan[key]}`)
      .join("\n")}\nprepare\ncommit\n`,
  });
  const receipt = {
    status: "prepared",
    oldParent: plan.oldParent,
    oldHead: plan.oldHead,
    newBase: plan.newBase,
    branch: plan.branch,
    worktree: plan.worktree,
    backupRefs: backups,
    cherryProof: plan.cherryProof,
    replayed: [],
    skipped: [],
    remaining: [...plan.commits],
    candidateHead: plan.newBase,
    candidateTree: null,
    candidateStatus: null,
    conflicts: [],
    artifactErrors: [],
  };
  try {
    mkdirSync(plan.worktree);
    git(plan.repo, [
      "worktree",
      "add",
      "-b",
      plan.branch,
      plan.worktree,
      plan.newBase,
    ]);
    for (const commit of plan.commits) {
      const reachable = ancestor(plan.repo, commit, plan.newBase);
      if (plan.equivalent.has(commit) || reachable) {
        receipt.skipped.push({
          commit,
          proof: reachable ? "ancestor-of-new-base" : "git-cherry-equivalent",
        });
      } else {
        const result = git(plan.worktree, ["cherry-pick", commit], {
          allowFailure: true,
        });
        if (result.status !== 0) {
          receipt.status = "blocked";
          receipt.error = result.stderr;
          receipt.conflicts = output(plan.worktree, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "--diff-filter=U",
          ])
            .split("\n")
            .filter(Boolean);
          break;
        }
        receipt.replayed.push({
          old: commit,
          new: output(plan.worktree, ["rev-parse", "HEAD"]),
        });
      }
      receipt.remaining.shift();
    }
    receipt.candidateHead = output(plan.worktree, ["rev-parse", "HEAD"]);
    receipt.candidateTree = output(plan.worktree, ["rev-parse", "HEAD^{tree}"]);
    receipt.candidateStatus = git(plan.worktree, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout;
    if (receipt.status === "prepared" && receipt.candidateStatus) {
      receipt.status = "blocked";
      receipt.error =
        "Candidate has uncommitted changes; preserve and inspect them before review";
    }
  } catch (error) {
    receipt.status = "blocked";
    receipt.error = error.message;
  }
  writeReceipts(plan, receipt);
  return receipt;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.slice(2).includes("--help")) process.stdout.write(HELP);
    else {
      const receipt = prepareRecovery(parseRecoveryArgs(process.argv.slice(2)));
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      if (receipt.status !== "prepared" || receipt.artifactErrors.length)
        process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

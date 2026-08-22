/**
 * The repository facts the routing consults that are not the changed-path list.
 *
 * Everything here is something the bash gate reads from the tree or from git at
 * run time: whether a path exists, what the base ref resolves to, which
 * `scripts/` symlinks resolve where, which Terraform stacks are registered, and
 * how the root manifest changed. Keeping them behind one object means the
 * engine is a pure function of (changed paths, facts) — which is what makes it
 * testable and what lets the parity harness feed it the same inputs the gate
 * had.
 *
 * FAIL-CLOSED IS THE HOUSE RULE. Every ambiguity here resolves toward MORE
 * work, never less: an unreadable manifest classifies as `workspace` (the full
 * suite), an unresolvable ref becomes a sentinel rather than an empty string,
 * and a missing classifier is an error rather than a shrug. A fact that fails
 * quietly produces a smaller plan, which is the one outcome the gate must never
 * reach.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

const git = (repoRoot, args) => {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

/** The dev-metadata pointers a manifest change may touch without escalating. */
const DEV_METADATA = [
  /^\/devDependencies$/,
  /^\/devDependencies\//,
  /^\/name$/,
  /^\/description$/,
  /^\/license$/,
  /^\/keywords$/,
  /^\/keywords\//,
  /^\/author$/,
  /^\/author\//,
  /^\/repository$/,
  /^\/repository\//,
  /^\/bugs$/,
  /^\/bugs\//,
  /^\/homepage$/,
];

/**
 * The root `package.json` script names that count as TOOLING rather than as
 * package scripts. A manifest whose only changes are these is safe to route to
 * the tooling checks instead of the full workspace suite.
 *
 * Transcribed from the gate's own `case` list; `check-sentry-suites-in-ci-gate-probe.mjs`
 * pins the closed verdict set this feeds.
 */
const TOOLING_SCRIPT_POINTERS = new Set(
  [
    "agent:quality-gate",
    "agent:quality-gate:test",
    "agent:prewarm",
    "agent:prewarm:test",
    "agent:review-materiality",
    "agent:review-materiality:test",
    "agent:context-check",
    "agent:context-budget",
    "agent:context-budget:test",
    "docs:index",
    "docs:index:test",
    "docs:audit",
    "docs:audit:test",
    "docs:garden",
    "docs:garden:test",
    "docs:navigation-eval",
    "docs:navigation-eval:test",
    "agent:autoreview",
    "issue:board",
    "issue:board:test",
    "issue:claim",
    "issue:review",
    "issue:release",
    "sentry:ingest",
    "sentry:ingest:test",
    "sentry:digest",
    "sentry:digest:test",
    "sentry:project",
    "sentry:project:test",
    "sentry:brief",
    "sentry:brief:test",
    "sentry:autofix:select",
    "sentry:autofix:select:test",
    "sentry:autofix:finalize:test",
    "sentry:autofix:run-record:test",
    "sentry:archive",
    "sentry:archive:test",
    "sentry:broker:test",
    "sentry:requeue:test",
    "pr:feedback-state",
    "pr:feedback-state:test",
    "pr:ready-state",
    "pr:ready-state:test",
    "tf",
    "tf:test",
    "alerts:rules:lint",
    "alerts:rules:lint:test",
    "lockfile:lint",
    "lockfile:lint:test",
    "skew:check",
    "skew:check:test",
    "override:prune-report",
    "override:prune-report:test",
    "adr:check",
    "adr:check:test",
    "sanitize:test",
  ].map((name) => `/scripts/${name}`),
);

const escapePointer = (part) => part.replace(/~/g, "~0").replace(/\//g, "~1");
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** JSON-pointer paths that differ between two parsed objects, sorted per key. */
function jsonChangePaths(base, head) {
  const changes = [];
  const walk = (a, b, path) => {
    if (Object.is(a, b)) return;
    if (isRecord(a) && isRecord(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys)
        walk(a[key], b[key], `${path}/${escapePointer(key)}`);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(path || "/");
  };
  walk(base, head, "");
  return changes;
}

export class Facts {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.baseRef = options.baseRef;
    this.headRef = options.headRef;
    this.changedPathsFile = options.changedPathsFile;
    this.fullLocalTests = options.fullLocalTests === true;
    // The gate fences repository-specific routing behind this, so its own unit
    // tests — which run against stub fixture repositories — do not inherit it.
    this.isRealTree = options.isRealTree === true;
    this.scriptSourceDir = options.scriptSourceDir;
    this.#rootPackageJsonClass = null;
  }

  /** `git rev-parse` of the base ref, or the gate's sentinel when unresolvable. */
  get baseOid() {
    if (this.#baseOid === undefined) {
      const resolved = git(this.repoRoot, [
        "rev-parse",
        "--verify",
        `${this.baseRef}^{commit}`,
      ]);
      this.#baseOid =
        resolved === null ? `__unresolved__:${this.baseRef}` : resolved.trim();
    }
    return this.#baseOid;
  }
  #baseOid;

  pathExistsInWorktree(path) {
    return existsSync(join(this.repoRoot, path));
  }

  /**
   * Whether the path is a symlink in the working tree.
   *
   * `lstat`, not `stat`: the arm exists precisely because a link's own entry is
   * what changed, and following it would answer about the target instead.
   */
  pathIsSymlink(path) {
    try {
      return lstatSync(join(this.repoRoot, path)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * Whether a path exists in the HEAD state: the working tree when head is
   * HEAD (so uncommitted edits count), otherwise the ref via git.
   */
  pathExistsAtHead(path) {
    if (this.headRef === "HEAD") return this.pathExistsInWorktree(path);
    return (
      git(this.repoRoot, ["cat-file", "-e", `${this.headRef}:${path}`]) !== null
    );
  }

  /** Repo-relative resolved targets of every directory symlink under scripts/. */
  get scriptsSymlinkTargets() {
    if (this.#symlinkTargets === undefined) {
      this.#symlinkTargets = [];
      const scriptsDir = join(this.repoRoot, "scripts");
      if (this.isRealTree && existsSync(scriptsDir)) {
        const listed = git(this.repoRoot, ["ls-files", "-s", "scripts"]) ?? "";
        const rootPhysical = realpathSync(this.repoRoot);
        for (const line of listed.split("\n")) {
          // Mode 120000 is a symlink in git's index.
          if (!line.startsWith("120000")) continue;
          const path = line.split("\t")[1];
          if (path === undefined) continue;
          const absolute = join(this.repoRoot, path);
          try {
            if (!statSync(absolute).isDirectory()) continue;
            const target = realpathSync(absolute);
            const rel = relative(rootPhysical, target);
            if (rel === "" || rel.startsWith("..") || rel.startsWith(sep))
              continue;
            this.#symlinkTargets.push(rel.split(sep).join("/"));
          } catch {
            // A dangling or unreadable link exposes no suite tree.
          }
        }
      }
    }
    return this.#symlinkTargets;
  }
  #symlinkTargets;

  /** Registered Terraform stack paths, from the registry rather than from paths. */
  get terraformStackPaths() {
    if (this.#stackPaths === undefined) {
      this.#stackPaths = [];
      const registry = join(this.repoRoot, "terraform.stacks.json");
      if (existsSync(registry)) {
        try {
          const parsed = JSON.parse(readFileSync(registry, "utf8"));
          for (const stack of parsed.stacks ?? []) {
            if (typeof stack.path === "string")
              this.#stackPaths.push(stack.path);
          }
        } catch {
          // An unreadable registry routes no stack-specific validation, which
          // is what the gate does too — the unconditional `pnpm tf:test` sweep
          // still runs.
        }
      }
    }
    return this.#stackPaths;
  }
  #stackPaths;

  /**
   * How the root `package.json` changed, as one of the four closed classes.
   *
   * Anything unreadable or unparsable is `workspace`, which is the widest
   * answer — the full suite.
   */
  rootPackageJsonClass() {
    if (this.#rootPackageJsonClass !== null) return this.#rootPackageJsonClass;
    this.#rootPackageJsonClass = this.#classifyRootPackageJson();
    return this.#rootPackageJsonClass;
  }
  #rootPackageJsonClass;

  #classifyRootPackageJson() {
    const baseText = git(this.repoRoot, [
      "show",
      `${this.baseRef}:package.json`,
    ]);
    if (baseText === null) return "workspace";

    let headText;
    if (this.headRef === "HEAD" && this.pathExistsInWorktree("package.json")) {
      headText = readFileSync(join(this.repoRoot, "package.json"), "utf8");
    } else {
      headText = git(this.repoRoot, ["show", `${this.headRef}:package.json`]);
      if (headText === null) return "workspace";
    }

    let changes;
    try {
      changes = jsonChangePaths(JSON.parse(baseText), JSON.parse(headText));
    } catch {
      return "workspace";
    }
    if (changes.length === 0) return "workspace";

    let toolingScript = false;
    let nonToolingScript = false;
    let nonScript = false;
    let devMetadata = false;
    let nonDevMetadata = false;

    for (const change of changes) {
      if (TOOLING_SCRIPT_POINTERS.has(change)) {
        toolingScript = true;
      } else if (change === "/scripts" || change.startsWith("/scripts/")) {
        nonToolingScript = true;
      } else if (DEV_METADATA.some((pattern) => pattern.test(change))) {
        nonScript = true;
        devMetadata = true;
      } else {
        nonScript = true;
        nonDevMetadata = true;
      }
    }

    if (toolingScript && !nonToolingScript && !nonScript) {
      return "root-tooling-scripts";
    }
    if (toolingScript || nonToolingScript) return "package-scripts";
    if (devMetadata && !nonDevMetadata) return "workspace-dev-metadata";
    return "workspace";
  }
}

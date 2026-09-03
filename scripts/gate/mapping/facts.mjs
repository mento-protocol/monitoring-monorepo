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
 * FAIL-CLOSED IS THE HOUSE RULE, and it has two distinct shapes. An AMBIGUOUS
 * fact resolves toward more work: an unreadable root manifest classifies as
 * `workspace`, the full suite, and an unresolvable ref becomes a sentinel
 * rather than an empty string. A BROKEN fact refuses outright: an invalid
 * Terraform registry throws rather than routing zero stacks, because "no
 * registered stacks" and "the registry is corrupt" are the same empty list to
 * every consumer downstream. A fact that fails quietly produces a smaller plan,
 * which is the one outcome the gate must never reach.
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
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
 * Transcribed from the gate's own `case` list, which D5c retired: this set is
 * the allowlist now. `check-sentry-suites-in-ci-gate-probe.mjs` reads it through
 * `classifyRootPackageJsonChanges` and asserts every `sentry:*` alias is in it.
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
    "agent:closeout-review",
    "agent:closeout-review:test",
    "agent:autoreview",
    "issue:board",
    "issue:board:test",
    "issue:claim",
    "issue:groom",
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

/**
 * The four classes `rootPackageJsonClass()` may answer, as a closed set.
 *
 * Exported so a caller can refuse anything else rather than storing a
 * plausible-looking string. A class added here has to be added on purpose.
 */
export const ROOT_PACKAGE_JSON_CLASSES = Object.freeze([
  "workspace",
  "workspace-dev-metadata",
  "root-tooling-scripts",
  "package-scripts",
]);

/**
 * Classify a set of root-manifest JSON-pointer changes into one of the four
 * classes above.
 *
 * The pure half of `rootPackageJsonClass()`: no git, no filesystem, no parsing.
 * Exported because it is a routing authority two checks need to interrogate
 * directly — `check-sentry-suites-in-ci-gate-probe.mjs` asks it which aliases
 * the gate trusts, and it used to do that by lifting the gate's bash function
 * out of the script and re-running it under a stubbed shell.
 *
 * An empty change set is `workspace`, the widest answer, which is also what an
 * unreadable or unparsable manifest gets.
 *
 * @param {readonly string[]} changes JSON-pointer paths, e.g. `/scripts/tf:test`
 * @returns {string} one of `ROOT_PACKAGE_JSON_CLASSES`
 */
export function classifyRootPackageJsonChanges(changes) {
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

/**
 * Absolute paths of every symlink under `dir`, at any depth.
 *
 * Mirrors `find <dir> -type l`: the link's own entry is what is reported, and
 * the walk does not descend through one (`Dirent.isDirectory()` is false for a
 * symlink, exactly as `find` without `-L` behaves).
 */
function findSymlinks(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // `find … 2>/dev/null || true` — an unreadable directory is skipped.
      continue;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) found.push(absolute);
      else if (entry.isDirectory()) stack.push(absolute);
    }
  }
  return found.sort();
}

/** The registry's text when the gate's `[[ -r ]]` would pass, else null. */
function readRegistryText(registry) {
  try {
    accessSync(registry, constants.R_OK);
  } catch {
    return null;
  }
  try {
    return readFileSync(registry, "utf8");
  } catch {
    // Readable a moment ago and unreadable now: refuse rather than route an
    // empty stack list, which is the same direction as a parse failure.
    throw registryRefusal();
  }
}

const registryRefusal = () => {
  const error = new Error(
    "failed to load Terraform stack paths from terraform.stacks.json",
  );
  error.exitCode = 2;
  return error;
};

/**
 * The registry's stack paths, validated exactly as the gate validates them.
 *
 * Transcribed from `agent-quality-gate.sh:265-292`. Every rejection there is
 * `exit 2`, so every rejection here throws.
 */
function validateStackPaths(text) {
  if (text === null) return [];
  let registry;
  try {
    registry = JSON.parse(text);
  } catch {
    throw registryRefusal();
  }
  if (
    !isRecord(registry) ||
    registry.version !== 1 ||
    !Array.isArray(registry.stacks)
  ) {
    throw registryRefusal();
  }
  const paths = registry.stacks.map((stack) =>
    isRecord(stack) ? stack.path : undefined,
  );
  if (
    paths.length === 0 ||
    paths.some(
      (stackPath) =>
        typeof stackPath !== "string" ||
        !/^[A-Za-z0-9._/-]+$/u.test(stackPath) ||
        stackPath.startsWith("/") ||
        stackPath
          .split("/")
          .some((segment) => ["", ".", ".."].includes(segment)),
    ) ||
    new Set(paths).size !== paths.length
  ) {
    throw registryRefusal();
  }
  return paths;
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

  /** `[[ -e "$path" ]]`: the path exists, following symlinks. */
  pathExistsInWorktree(path) {
    return existsSync(join(this.repoRoot, path));
  }

  /**
   * `[[ -f "$path" ]]`: the path is a REGULAR file, following symlinks.
   *
   * Not `existsSync`, which is `-e`. The two disagree on exactly the shapes a
   * repository can hold: a directory, a symlink to a directory, and a gitlink
   * (`160000`, a submodule, which is a directory in the working tree) all
   * exist and are not regular files. `[[ -f ]]` is false for each, so the
   * guarded command is not scheduled, and a guard that answered `-e` would
   * schedule `bash -n <directory>` — a command the gate never emits.
   */
  pathIsFile(path) {
    try {
      return statSync(join(this.repoRoot, path)).isFile();
    } catch {
      // A dangling symlink or an unreadable parent: `[[ -f ]]` is false too.
      return false;
    }
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

  /**
   * Repo-relative resolved targets of every directory symlink under scripts/.
   *
   * The source is the WORKING TREE, not git's index: the gate runs
   * `find "$repo_root/scripts" -type l` and keeps the links that resolve to a
   * directory inside the repository. Reading git's index instead would miss an
   * untracked directory symlink that the gate sees — and missing one means the
   * suites beneath it stop being routed, which is a smaller plan.
   *
   * `find` without `-L` does not descend through symlinks, so neither does
   * this walk.
   */
  get scriptsSymlinkTargets() {
    if (this.#symlinkTargets === undefined) {
      this.#symlinkTargets = [];
      const scriptsDir = join(this.repoRoot, "scripts");
      if (this.isRealTree && existsSync(scriptsDir)) {
        const rootPhysical = realpathSync(this.repoRoot);
        for (const absolute of findSymlinks(scriptsDir)) {
          try {
            // `-d` follows the link; only a directory exposes a suite tree.
            if (!statSync(absolute).isDirectory()) continue;
            const target = realpathSync(absolute);
            const rel = relative(rootPhysical, target);
            // `..name` is a directory whose NAME starts with two dots, not a
            // path that climbs out of the repository — and the gate, which
            // tests `case "$target/" in "$repo_root"/*`, accepts it. Rejecting
            // every `..` prefix drops a routing pattern the gate has, which is
            // a smaller plan. Only `..` itself and a `../` prefix leave the
            // tree.
            const escapes =
              rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep);
            if (rel === "" || escapes) continue;
            this.#symlinkTargets.push(rel.split(sep).join("/"));
          } catch {
            // A dangling or unreadable link exposes no suite tree, and the
            // gate's own `cd "$link" && pwd -P || continue` skips it too.
          }
        }
      }
    }
    return this.#symlinkTargets;
  }
  #symlinkTargets;

  /**
   * Registered Terraform stack paths, from the registry rather than from paths.
   *
   * ABSENT AND INVALID ARE DIFFERENT ANSWERS, and the gate already separates
   * them (`agent-quality-gate.sh:263-302`). A registry that is not readable is
   * a repository without one — the fixture repos the gate's own unit tests run
   * against — and routes no stack-specific validation. A registry that IS
   * readable but does not parse, or holds a shape the gate rejects, is a
   * REFUSAL: the gate prints `failed to load Terraform stack paths` and exits
   * 2. Returning `[]` there would silently drop `terraform validate` for every
   * registered stack while the run still printed "All mapped commands passed."
   */
  get terraformStackPaths() {
    if (this.#stackPaths === undefined) {
      this.#stackPaths = validateStackPaths(
        readRegistryText(join(this.repoRoot, "terraform.stacks.json")),
      );
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
    // `[[ "$head_ref" == "HEAD" && -f "$path" ]]`, the gate's own test.
    if (this.headRef === "HEAD" && this.pathIsFile("package.json")) {
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

    return classifyRootPackageJsonChanges(changes);
  }
}

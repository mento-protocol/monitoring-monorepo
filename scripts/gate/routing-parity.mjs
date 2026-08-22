#!/usr/bin/env node
/**
 * Differential parity: the Node mapping engine against the LIVE bash gate.
 *
 * A development tool for the D5b swap, deleted once the swap lands.
 *
 * DEVIATION FROM THE DESIGN, DELIBERATE. The design has this compare a gate
 * pinned in a separate worktree against a swapped gate. That shape exists
 * because it assumed the swap had already happened. Landing the engine INERT
 * first makes a simpler and stronger comparison available: the bash arms are
 * still the routing that runs, so the live gate IS the oracle, on the same tree
 * and the same commit, with no pinned worktree to keep in step. Every
 * difference is attributable to the engine rather than to a checkout skew.
 *
 * The observable is the gate's dry-run stdout — the routing contract two Node
 * consumers already parse and 1,229 suite assertions already assert on.
 *
 * ZERO differences is the pass condition, and a green run is not believed until
 * `--mutate` has been shown to red it. An empty corpus is a FAILURE, not a
 * pass: "compared 0 sets; 0 differed" is the shape of the bug this harness
 * exists to catch, so it exits non-zero rather than reporting green.
 *
 * Usage:
 *   node scripts/gate/routing-parity.mjs [--corpus <name>] [--limit <n>]
 *                                        [--base <ref>] [--mutate]
 *
 *   --corpus tracked    one run per tracked path (default)
 *   --corpus multi      multi-path sets — the four whole-set post-passes
 *   --corpus synthetic  one built path per routing-table pattern no tracked
 *                       path reaches, so an arm the tree cannot exercise is
 *                       still compared
 *   --corpus base       synthetic BASE COMMITS — the root-manifest classifier's
 *                       four classes and the lockfile importer scoping, none of
 *                       which is reachable while base and head are the same
 *                       commit
 *   --corpus fixture    a stub fixture repository, where the gate is not in its
 *                       own tree and the repository-specific groups are skipped
 *   --corpus symlink    a real directory symlink under scripts/, the dynamic
 *                       pattern source no committed path can exercise
 *   --pass2             deprecated alias for `--corpus multi`
 *   --limit <n>         positive integer; sample the tracked corpus evenly
 *   --base <ref>        base ref for the corpora that do not supply their own
 *                       (default HEAD)
 *   --mutate            drop one engine command and require the harness to red
 */

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Facts } from "./mapping/facts.mjs";
import { buildPlan, routingSensitivePathsChanged } from "./mapping.mjs";
import { BUCKETS } from "./mapping/plan.mjs";
import { ROUTING_GROUPS } from "./routing-table/index.mjs";
import { walkArms } from "./routing-table/schema.mjs";
import { isGlob } from "./routing-table/pattern.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const git = (args, input) =>
  execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });

/**
 * The gate's own dry-run stdout, reduced to the three observable sections.
 *
 * The header carries the base, the head and the Turbo cache directory, none of
 * which is routing; the changed-path echo is the input. Surfaces and checklists
 * are sets and are sorted; the command list keeps its order, because order is
 * an invariant the plan and the stamp both depend on.
 */
/**
 * Blank the changed-paths file each side happened to use.
 *
 * The ADR reminder embeds it, and the two sides legitimately differ: the gate
 * writes its own randomized scratch file, the harness writes one of its own.
 * `write_command_plan` already performs exactly this substitution before the
 * freshness stamp hashes the plan, for the same reason — the execution path is
 * not part of the routing. Anything else that differs is a real difference.
 */
const NORMALIZE_PATHS_FILE = /--changed-paths-file \S+/g;
const normalize = (line) =>
  line.replace(
    NORMALIZE_PATHS_FILE,
    "--changed-paths-file __CHANGED_PATHS_FILE__",
  );

function parseGateStdout(text) {
  const surfaces = [];
  const checklists = [];
  const commands = [];
  // The gate's own normalized changed-path set, in ITS order. The gate applies
  // `sed '/^$/d' | sort -u` to the input file, and that ordering is routing:
  // `add_command` keeps the first reason it is given, so iterating the set in a
  // different order produces the same commands with different reasons. Feeding
  // the engine what the gate printed removes the question entirely — including
  // the collation the gate's `sort` happened to use, which is locale-dependent
  // and therefore not something this harness should try to reproduce.
  const changedPaths = [];
  let section = null;
  for (const line of text.split("\n")) {
    if (line === "Detected surfaces:") {
      section = "surface";
      continue;
    }
    if (line === "Required checklist review:") {
      section = "checklist";
      continue;
    }
    if (line === "Mapped safe local commands:") {
      section = "command";
      continue;
    }
    if (line === "Changed paths:") {
      section = "changed";
      continue;
    }
    if (line === "") {
      section = null;
      continue;
    }
    if (section === null || !line.startsWith("- ")) continue;
    const body = line.slice(2);
    if (section === "surface") surfaces.push(body);
    else if (section === "checklist") checklists.push(body);
    else if (section === "command") commands.push(normalize(body));
    else if (section === "changed") changedPaths.push(body);
  }
  return {
    surfaces: surfaces.sort(),
    checklists: checklists.sort(),
    commands,
    changedPaths,
  };
}

/** The engine's plan in the same shape, so the two can be compared directly. */
function planToObservable(plan) {
  const commands = [];
  for (const bucket of BUCKETS) {
    for (const entry of plan.buckets.get(bucket)) {
      commands.push(normalize(`${entry.command} (${entry.reason})`));
    }
  }
  return {
    surfaces: [...plan.surfaces].sort(),
    checklists: plan.checklists
      .map((entry) => `${entry.checklist} (${entry.reason})`)
      .sort(),
    commands,
  };
}

function runGate(changedPaths, dir, baseRef, repoRoot) {
  const pathsFile = join(dir, "paths");
  writeFileSync(pathsFile, `${changedPaths.join("\n")}\n`);
  // The gate SCRIPT always comes from this checkout; only the repository it
  // runs against moves. That is exactly the split `$script_source_dir` tests.
  const stdout = execFileSync(
    "bash",
    [
      join(REPO, "scripts/agent-quality-gate.sh"),
      "--changed-paths-file",
      pathsFile,
      "--base",
      baseRef,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, AGENT_QUALITY_GATE_LOCK: "0" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return { stdout, pathsFile };
}

async function runEngine(changedPaths, pathsFile, baseRef, repoRoot) {
  const scriptSourceDir = join(REPO, "scripts");
  const facts = new Facts({
    repoRoot,
    baseRef,
    headRef: "HEAD",
    changedPathsFile: pathsFile,
    // The gate's own test, evaluated here rather than assumed: repository-
    // specific routing is fenced behind the gate living in the tree it checks.
    isRealTree: scriptSourceDir === join(repoRoot, "scripts"),
    scriptSourceDir,
  });
  const routingSensitive = await routingSensitivePathsChanged(
    changedPaths,
    scriptSourceDir,
  );
  return planToObservable(buildPlan({ changedPaths, facts, routingSensitive }));
}

/** One line per difference, naming the path set and what moved. */
function diff(label, gate, engine) {
  const problems = [];
  for (const field of ["surfaces", "checklists"]) {
    const missing = gate[field].filter((x) => !engine[field].includes(x));
    const extra = engine[field].filter((x) => !gate[field].includes(x));
    for (const item of missing)
      problems.push(`${label}: engine MISSING ${field} ${item}`);
    for (const item of extra)
      problems.push(`${label}: engine EXTRA ${field} ${item}`);
  }
  const n = Math.max(gate.commands.length, engine.commands.length);
  for (let i = 0; i < n; i += 1) {
    if (gate.commands[i] !== engine.commands[i]) {
      problems.push(
        `${label}: command[${i}]\n    gate:   ${gate.commands[i] ?? "(none)"}\n    engine: ${engine.commands[i] ?? "(none)"}`,
      );
      break;
    }
  }
  return problems;
}

function corpusTracked(limit) {
  const listed = execFileSync("git", ["-C", REPO, "ls-files"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const all = listed.split("\n").filter((p) => p !== "");
  if (limit === null || limit >= all.length) return all;
  // Deterministic spread rather than a random sample, so a re-run compares the
  // same paths and a difference is reproducible.
  const step = all.length / limit;
  return Array.from({ length: limit }, (_, i) => all[Math.floor(i * step)]);
}

/**
 * Pass 2 — multi-path sets.
 *
 * Four behaviours are set-dependent and a single-path corpus cannot see any of
 * them: the Trunk full-vs-targeted decision, the codegen sort (which only has
 * something to sort when several variants are scheduled), Turbo compaction
 * (which needs two packages sharing a task), and scoped tests (which have a
 * 15-path threshold and four disqualifiers). Pass 1 proving zero differences
 * says almost nothing about these, so this is where the post-passes are
 * actually tested.
 */
function corpusMultiPath(tracked) {
  const sets = [];
  const pick = (source, count, seed) => {
    // Deterministic, so a difference is reproducible on a re-run.
    const chosen = [];
    let cursor = seed;
    for (let i = 0; i < count; i += 1) {
      cursor = (cursor * 1103515245 + 12345) % 2147483648;
      chosen.push(source[cursor % source.length]);
    }
    return [...new Set(chosen)];
  };

  for (const k of [2, 3, 5, 15, 16]) {
    for (let seed = 1; seed <= 6; seed += 1) {
      sets.push({
        label: `random-k${k}-s${seed}`,
        paths: pick(tracked, k, seed * 7919),
      });
    }
  }

  // Straddle each scoped-test disqualifier: the same base set with and without
  // the one path that turns scoping off.
  const base = [
    "ui-dashboard/src/lib/utils.ts",
    "indexer-envio/src/EventHandlers.ts",
  ];
  const straddles = {
    "shared-config": "shared-config/src/index.ts",
    "test-infra-hermetic": "ui-dashboard/vitest.hermetic-setup.ts",
    "test-infra-config": "ui-dashboard/vitest.config.ts",
    "schema-stub": "scripts/envio-schema-stubs.graphql",
    "workspace-escalation": "package.json",
    "lockfile-scoped": "pnpm-lock.yaml",
    "non-source-in-package": "ui-dashboard/src/lib/types.json",
    "test-file-in-package": "ui-dashboard/src/lib/utils.test.ts",
  };
  sets.push({ label: "straddle-base", paths: base });
  for (const [name, extra] of Object.entries(straddles)) {
    sets.push({ label: `straddle-${name}`, paths: [...base, extra] });
  }

  // The 15/16 threshold, exactly.
  const dashboardFiles = tracked
    .filter((p) => p.startsWith("ui-dashboard/src/") && p.endsWith(".ts"))
    .slice(0, 16);
  if (dashboardFiles.length === 16) {
    sets.push({ label: "threshold-15", paths: dashboardFiles.slice(0, 15) });
    sets.push({ label: "threshold-16", paths: dashboardFiles });
  }

  // Turbo compaction needs two packages sharing a task.
  sets.push({
    label: "turbo-compaction",
    paths: [
      "ui-dashboard/src/lib/utils.ts",
      "metrics-bridge/src/index.ts",
      "integration-probes/src/index.ts",
    ],
  });
  // Several codegen variants at once, so the sort has something to order.
  sets.push({
    label: "codegen-sort",
    paths: [
      "indexer-envio/config.yaml",
      "indexer-envio/config.testnet.yaml",
      "ui-dashboard/src/lib/utils.ts",
    ],
  });
  return sets;
}

/**
 * Pass 3 — one built path per pattern the tracked tree cannot reach.
 *
 * The tracked corpus exercises an arm only if some committed file happens to
 * match it. Measured on this tree, 225 of the table's 234 arms are reached that
 * way and nine are not — a repository with no `.npmrc`, and a star-slash
 * `package.json` arm that every earlier package arm claims first. An arm no
 * corpus reaches is an arm the parity evidence says nothing about, so this
 * builds a path for it.
 *
 * The pattern COMPILER is not what this tests — `pattern-oracle.test.mjs`
 * already proves every pattern against real bash, matches and near misses
 * both. This tests the arm's effects: the verbs, the reasons and the bucket
 * the engine produces once the arm fires.
 */
function corpusSynthetic(tracked) {
  const trackedSet = new Set(tracked);
  const seen = new Set();
  const sets = [];
  for (const { subject, arm } of walkArms(ROUTING_GROUPS)) {
    // A dispatch on the root-manifest class switches on a verdict string
    // rather than a path; `--corpus base` is what reaches those arms.
    if (subject !== "path") continue;
    for (const pattern of arm.patterns) {
      // A dynamic group's pattern carries a `${placeholder}` that only means
      // something once a symlink target or a stack path is substituted in.
      if (/\$\{[a-z_][a-z_0-9]*\}/.test(pattern)) continue;
      // Two expansions of `*`, because segment COUNT is routing: a nested
      // dispatch that tries `*/*/*` before `*` is only reached by the second
      // one, and a `*` that always spans a separator would never get there.
      for (const star of ["a/b", "a"]) {
        const path = synthesizeMatch(pattern, star);
        if (path === "" || trackedSet.has(path) || seen.has(path)) continue;
        seen.add(path);
        sets.push({
          label: `synthetic:${pattern}${isGlob(pattern) ? "" : " (literal)"}`,
          paths: [path],
        });
      }
    }
  }
  return sets;
}

/**
 * A path built to match a bash `case` pattern, expanding `*` as `star`.
 *
 * `a/b` is the expansion that matters most — `*` crosses `/` in a `case`
 * pattern, and a synthetic match that never spans a separator would not
 * exercise that. Same construction as `pattern-oracle.test.mjs`, which proves
 * against bash that the paths it builds really do match.
 */
function synthesizeMatch(pattern, star) {
  let path = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      path += star;
    } else if (character === "?") {
      path += "c";
    } else if (character === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close === -1) {
        path += "[";
        continue;
      }
      const member = [...pattern.slice(index + 1, close)].find(
        (candidate) => !"!^-".includes(candidate),
      );
      path += member ?? "d";
      index = close;
    } else if (character === "\\") {
      index += 1;
      path += pattern[index] ?? "";
    } else {
      path += character;
    }
  }
  return path;
}

/**
 * Pass 4 — synthetic BASE COMMITS.
 *
 * Every other corpus runs with base and head at the same commit, which is what
 * makes them cheap and reproducible — and which also makes two whole routing
 * families unreachable, because both read the DIFF between base and head
 * rather than the changed-path list:
 *
 *   - `classify_root_package_json_changes` has four classes, and an empty diff
 *     is always `workspace`. Three classes, five dispatch arms and the
 *     29-command `add_root_tooling_package_script_checks` verb never fire.
 *   - `lockfile_scoped_importers` reports the importer keys that CHANGED, and
 *     an empty diff reports none — so the scoped branch is entered with an
 *     empty importer list and the whole importer→bundle map, including the
 *     `mark_lockfile_scoped_package` calls that disable scoped tests, is never
 *     reached.
 *
 * So build a base commit that differs from HEAD in exactly one engineered way,
 * and run both sides against it. The commit is a dangling object written with
 * `commit-tree`; nothing is checked out and no ref moves.
 */
function corpusBase(dir) {
  const headPackageJson = readFileSync(join(REPO, "package.json"), "utf8");
  const headLockfile = readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8");
  const withPackageJson = (mutate) => {
    const parsed = JSON.parse(headPackageJson);
    mutate(parsed);
    return `${JSON.stringify(parsed, null, 2)}\n`;
  };

  const sets = [
    {
      label: "base-class-root-tooling-scripts",
      paths: ["package.json"],
      file: "package.json",
      content: withPackageJson((p) => {
        // A tooling script pointer and nothing else → root-tooling-scripts.
        p.scripts["docs:index"] = `${p.scripts["docs:index"]} --parity-probe`;
      }),
    },
    {
      label: "base-class-package-scripts",
      paths: ["package.json"],
      file: "package.json",
      // A script that is not on the tooling list → package-scripts.
      content: withPackageJson((p) => {
        p.scripts["parity-probe-script"] = "true";
      }),
    },
    {
      label: "base-class-workspace-dev-metadata",
      paths: ["package.json"],
      file: "package.json",
      content: withPackageJson((p) => {
        p.description = "parity probe";
      }),
    },
    {
      label: "base-class-workspace",
      paths: ["package.json"],
      file: "package.json",
      content: withPackageJson((p) => {
        p.packageManager = "pnpm@0.0.0";
      }),
    },
  ];

  // One mappable importer per bundle shape the map holds, plus the two
  // fail-toward-full shapes.
  for (const importer of [
    "ui-dashboard",
    "indexer-envio",
    "shared-config",
    "alerts/infra/oncall-announcer",
  ]) {
    const content = mutateImporter(headLockfile, importer);
    if (content === null) continue;
    sets.push({
      label: `base-lockfile-importer-${importer}`,
      paths: ["pnpm-lock.yaml"],
      file: "pnpm-lock.yaml",
      content,
    });
  }
  const rootImporter = mutateImporter(headLockfile, ".");
  if (rootImporter !== null) {
    // The root importer maps to no bundle → fail toward the full suite.
    sets.push({
      label: "base-lockfile-importer-unmappable-root",
      paths: ["pnpm-lock.yaml"],
      file: "pnpm-lock.yaml",
      content: rootImporter,
    });
  }
  sets.push({
    label: "base-lockfile-non-importer-section",
    paths: ["pnpm-lock.yaml"],
    file: "pnpm-lock.yaml",
    // A top-level section outside `importers` → the classifier says "full".
    content: headLockfile.replace(
      /^lockfileVersion: .*$/m,
      "lockfileVersion: '0.0'",
    ),
  });
  // A lockfile change alongside a manifest-class path is not lockfile-only, so
  // it must widen even though the importer diff is perfectly scopable.
  const straddle = mutateImporter(headLockfile, "ui-dashboard");
  if (straddle !== null) {
    sets.push({
      label: "base-lockfile-with-co-changed-manifest",
      paths: ["pnpm-lock.yaml", "ui-dashboard/package.json"],
      file: "pnpm-lock.yaml",
      content: straddle,
    });
  }

  return sets.map(({ label, paths, file, content }) => ({
    label,
    paths,
    baseRef: baseCommitWith(dir, file, content),
  }));
}

/**
 * The head lockfile with one importer's first `specifier:` altered.
 *
 * A textual edit, not a YAML round-trip: re-dumping the document could move
 * something outside `importers` and the classifier would answer "full" for a
 * reason the probe never intended. Returns null when the importer is absent.
 */
function mutateImporter(lockfile, importer) {
  const lines = lockfile.split("\n");
  const start = lines.findIndex((line) => line === `  ${importer}:`);
  if (start === -1) return null;
  for (let index = start + 1; index < lines.length; index += 1) {
    // Still inside this importer's block?
    if (/^ {0,2}\S/.test(lines[index])) return null;
    const match = /^(\s+specifier: )(.*)$/.exec(lines[index]);
    if (match === null) continue;
    lines[index] = `${match[1]}${match[2]}-parity-probe`;
    return lines.join("\n");
  }
  return null;
}

/**
 * Pass 5 — a STUB FIXTURE REPOSITORY, where the gate is not in its own tree.
 *
 * Four routing effects are fenced behind
 * `[[ "$script_source_dir" == "$repo_root/scripts" ]]` so the gate's own unit
 * tests do not inherit them: the two Sentry arms, the symlink groups, and the
 * unconditional `pnpm tf:test` sweep. Every other corpus here runs the gate on
 * its own checkout, where that condition is true — so the engine's
 * `isRealTree: false` branch, which SKIPS whole groups, had no comparison at
 * all. A branch that only ever removes work is the one to check hardest.
 *
 * The fixture is the shape `agent-quality-gate.test.sh` builds: a throwaway git
 * repository with a root manifest, invoked with the real gate script from this
 * checkout.
 */
function corpusFixture(dir) {
  const fixture = join(dir, "fixture");
  const inFixture = (...args) =>
    execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8" });

  mkdirSync(join(fixture, "ui-dashboard/src"), { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  mkdirSync(join(fixture, "terraform"), { recursive: true });
  mkdirSync(join(fixture, "docs/notes"), { recursive: true });
  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify(
      {
        name: "routing-parity-fixture",
        private: true,
        scripts: {
          "docs:index": "node scripts/context/docs-index.mjs",
          build: "true",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(fixture, "ui-dashboard/src/x.ts"),
    "export const x = 1;\n",
  );
  writeFileSync(join(fixture, "scripts/probe.sh"), "echo probe\n");
  writeFileSync(join(fixture, "scripts/probe.mjs"), "export const y = 1;\n");
  writeFileSync(join(fixture, "terraform/main.tf"), "# fixture\n");
  writeFileSync(join(fixture, "docs/notes/a.md"), "# fixture\n");

  inFixture("init", "-q");
  inFixture("config", "user.email", "routing-parity@example.invalid");
  inFixture("config", "user.name", "routing-parity");
  // Signing and hooks are the developer's, not this probe's. A global
  // `commit.gpgsign` would ask a pinentry for a throwaway fixture commit —
  // inside the outer gate run, since the mapping arm schedules this corpus —
  // and a global `core.hooksPath` or `init.templateDir` would run their hooks
  // against a repository that is not their work.
  //
  // An empty hooks directory rather than a verification bypass: this
  // repository does not skip hooks, it points them at a directory that holds
  // none. The directory lives outside the fixture so it can never become
  // fixture content.
  const emptyHooks = join(dir, "no-hooks");
  mkdirSync(emptyHooks, { recursive: true });
  inFixture("config", "commit.gpgsign", "false");
  inFixture("config", "core.hooksPath", emptyHooks);
  inFixture("add", "-A");
  inFixture("commit", "-qm", "fixture");

  // Uncommitted, so `git show HEAD:package.json` and the working tree differ:
  // that diff is what the root-manifest classifier reads, and it makes the
  // fixture reach `root-tooling-scripts` without a synthetic base commit.
  const manifest = JSON.parse(
    readFileSync(join(fixture, "package.json"), "utf8"),
  );
  manifest.scripts["docs:index"] = "node scripts/context/docs-index.mjs --f";
  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return [
    { label: "fixture-shell-script", paths: ["scripts/probe.sh"] },
    { label: "fixture-script-module", paths: ["scripts/probe.mjs"] },
    { label: "fixture-dashboard-source", paths: ["ui-dashboard/src/x.ts"] },
    { label: "fixture-terraform", paths: ["terraform/main.tf"] },
    { label: "fixture-docs-note", paths: ["docs/notes/a.md"] },
    { label: "fixture-root-manifest", paths: ["package.json"] },
    {
      label: "fixture-sentry-suite",
      paths: ["scripts/sentry/gate/sentry-probe.test.mjs"],
    },
    {
      label: "fixture-multi",
      paths: ["ui-dashboard/src/x.ts", "scripts/probe.sh", "docs/notes/a.md"],
    },
  ].map((set) => ({ ...set, repoRoot: fixture, baseRef: "HEAD" }));
}

/**
 * Pass 6 — a real directory symlink under `scripts/`.
 *
 * `scriptsSymlinkTargets` is a DYNAMIC pattern source: the arms it feeds are
 * built from whatever `find scripts -type l` resolves to, so with no directory
 * symlink in the tree — and there is none today — the whole group is inert and
 * every other corpus says nothing about it. The gate's own self-test creates
 * one for the same reason.
 *
 * Two targets, because the containment rule is where this goes wrong: an
 * ordinary directory, and one whose NAME begins with two dots. `path.relative`
 * answers `..name` for the second, which a `startsWith("..")` test reads as
 * "outside the repository" while the gate's prefix match accepts it
 * (Codex 3838283142). That is a routing pattern the gate has and the engine
 * does not, which is a smaller plan.
 *
 * Everything created here is removed in the same call, including on a throw.
 */
function corpusSymlink() {
  const targets = [
    { label: "plain", dir: ".routing-parity-target.tmp" },
    { label: "dotdot-prefixed", dir: "..routing-parity-target.tmp" },
  ];
  const link = "scripts/.routing-parity-link.tmp";
  const sets = [];
  for (const { label, dir } of targets) {
    sets.push({
      label: `symlink-${label}-link-itself`,
      paths: [link],
      symlink: { dir, link },
    });
    sets.push({
      label: `symlink-${label}-beneath-target`,
      paths: [`${dir}/sentry-probe.test.mjs`],
      symlink: { dir, link },
    });
    sets.push({
      label: `symlink-${label}-unrelated-path`,
      paths: ["ui-dashboard/src/lib/utils.ts"],
      symlink: { dir, link },
    });
  }
  return sets;
}

/**
 * Create the symlink a `symlink` corpus set needs, and hand back its undo.
 *
 * SETUP CLEANS UP AFTER ITSELF. The caller only receives the undo once every
 * step has succeeded, so a throw in between — a filesystem or sandbox that
 * refuses `symlink(2)`, a transient `EEXIST` — would otherwise leave a probe
 * directory at the root of the tree the outer gate is checking. Everything
 * here is removed before the throw is re-raised.
 */
function withSymlink({ dir, link }) {
  const targetPath = join(REPO, dir);
  const linkPath = join(REPO, link);

  // REFUSE, never clear the way. These are fixed names in the developer's real
  // repository, and an `rm -rf` of a path this run did not create would delete
  // whatever happened to be sitting there. A leftover from a killed run is a
  // thing to be told about, not something to silently overwrite.
  for (const path of [targetPath, linkPath]) {
    if (!pathPresent(path)) continue;
    const error = new Error(
      `${path} already exists; the symlink corpus creates its own probe paths and will not remove one it did not create. Remove it by hand if it is a leftover.`,
    );
    error.exitCode = 2;
    throw error;
  }

  // Undo removes exactly what this call made, in reverse order, and nothing
  // else — including when setup throws part-way and the caller never gets it.
  const created = [];
  const undo = () => {
    for (const path of [...created].reverse()) {
      rmSync(path, { recursive: true, force: true });
    }
    created.length = 0;
  };
  try {
    mkdirSync(targetPath);
    created.push(targetPath);
    writeFileSync(join(targetPath, "sentry-probe.test.mjs"), "// probe\n");
    symlinkSync(targetPath, linkPath);
    created.push(linkPath);
  } catch (error) {
    undo();
    throw error;
  }
  return undo;
}

/** Whether any entry sits at this path — a dangling symlink included. */
function pathPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A dangling commit whose tree is HEAD's with one top-level path replaced. */
function baseCommitWith(dir, path, content) {
  const blobFile = join(dir, "blob");
  writeFileSync(blobFile, content);
  const blob = git(["hash-object", "-w", "--path", path, blobFile]).trim();
  const entries = git(["ls-tree", "HEAD"])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [meta, name] = line.split("\t");
      if (name !== path) return line;
      return `${meta.split(" ")[0]} blob ${blob}\t${name}`;
    });
  const tree = git(["mktree"], `${entries.join("\n")}\n`).trim();
  // `--no-gpg-sign`: this is a dangling probe object in the developer's REAL
  // repository, and `commit-tree` honours `commit.gpgsign` too.
  return git([
    "commit-tree",
    "--no-gpg-sign",
    tree,
    "-m",
    "routing-parity synthetic base",
  ]).trim();
}

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};

const fail = (message) => {
  console.error(`routing-parity: ${message}`);
  process.exit(2);
};

/**
 * A limit that is not a positive integer is a REFUSAL, not a default.
 *
 * `--limit` with nothing after it makes `Number(undefined)` NaN, every
 * comparison against NaN is false, and the corpus comes out empty — so the
 * harness would compare nothing, report "0 differed" and exit 0. That is the
 * "All 0 …" failure this harness was written to prevent, reproduced inside the
 * harness itself.
 */
function parseLimit(raw) {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`--limit requires a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const CORPORA = new Set([
  "tracked",
  "multi",
  "synthetic",
  "base",
  "fixture",
  "symlink",
]);
const limit = parseLimit(option("--limit", null));
const mutate = argv.includes("--mutate");
const defaultBase = option("--base", "HEAD");
if (defaultBase === undefined) fail("--base requires a ref");
const corpus = argv.includes("--pass2")
  ? "multi"
  : (option("--corpus", "tracked") ?? "");
if (!CORPORA.has(corpus)) {
  fail(`--corpus must be one of ${[...CORPORA].join(", ")}, got "${corpus}"`);
}

const dir = mkdtempSync(join(tmpdir(), "routing-parity-"));
let differences = 0;
let compared = 0;

/** The work list: one entry per comparison, each with the base it runs at. */
function buildWork() {
  if (corpus === "multi") return corpusMultiPath(corpusTracked(null));
  if (corpus === "synthetic") return corpusSynthetic(corpusTracked(null));
  if (corpus === "base") return corpusBase(dir);
  if (corpus === "fixture") return corpusFixture(dir);
  if (corpus === "symlink") return corpusSymlink();
  return corpusTracked(limit).map((path) => ({ label: path, paths: [path] }));
}

try {
  for (const { label, paths: set, baseRef, repoRoot, symlink } of buildWork()) {
    if (set.length === 0) continue;
    const base = baseRef ?? defaultBase;
    const root = repoRoot ?? REPO;
    // A set that needs a symlink in the real tree owns it for exactly its own
    // two runs, so a failure cannot leave one behind.
    const undo = symlink === undefined ? () => {} : withSymlink(symlink);
    let gate;
    let engine;
    try {
      const run = runGate(set, dir, base, root);
      gate = parseGateStdout(run.stdout);
      // The gate's normalized set, not the harness's raw one.
      engine = await runEngine(gate.changedPaths, run.pathsFile, base, root);
    } finally {
      undo();
    }
    if (mutate) engine.commands.shift();
    const problems = diff(label, gate, engine);
    compared += 1;
    if (problems.length > 0) {
      differences += 1;
      if (differences <= 15) console.log(problems.join("\n"));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\ncompared ${compared} ${corpus} sets; ${differences} differed`);
// A harness that compared nothing has proven nothing, whatever the difference
// count says.
if (compared === 0) {
  console.log("EMPTY CORPUS — this run proves nothing.");
  process.exit(2);
}
if (mutate) {
  console.log(
    differences > 0
      ? "MUTATION CONTROL FIRED: the harness can tell the two apart."
      : "MUTATION CONTROL DID NOT FIRE — this harness proves nothing.",
  );
  process.exit(differences > 0 ? 0 : 1);
}
process.exit(differences === 0 ? 0 : 1);

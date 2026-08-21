#!/usr/bin/env node
/**
 * `/bin/bash` is the oracle for `casePatternToRegExp`.
 *
 * The pattern compiler is the single largest correctness hazard in converting
 * the routing table to data. A bash `case` pattern is not a filesystem glob:
 * `*` and `?` both match `/` and there is no globstar. Every off-the-shelf glob
 * library defaults to the opposite, and adopting one would NARROW all ~230 arms
 * at once — the gate would map fewer commands, exit 0, and print "All mapped
 * commands passed." So the compiler is hand-written, and the only way to be
 * sure a hand-written compiler is right is to ask the shell.
 *
 * The corpus is every pattern in the table crossed with:
 *
 *   - every literal path the table itself names;
 *   - every tracked path in the repository;
 *   - one synthetic path per glob pattern, built to MATCH it;
 *   - one synthetic path per glob pattern, built to JUST MISS it.
 *
 * The last two are the negative controls, and they are checked twice: the shell
 * must agree that the first matches and the second does not. A "matching" path
 * the shell rejects, or a "just miss" it accepts, means the generator is broken
 * and the control proves nothing — the failure this repo has already had once,
 * where a check printed "All 0 …" and exited 0 over an empty subject list.
 *
 * Every bash on the machine is driven, not just the first on PATH. macOS ships
 * 3.2 at /bin/bash — the floor this repo supports and the one the pre-push hook
 * actually runs — while a developer's PATH usually has 5.x.
 *
 * Run: node --test scripts/gate/routing-table/
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  probeDirs,
  runProbeShell,
} from "../../sentry/ci-wiring/check-sentry-suites-in-ci-gate-extract.mjs";
import { casePatternToRegExp, isGlob } from "./pattern.mjs";
import { ROUTING_GROUPS } from "./index.mjs";
import { walkArms } from "./schema.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The whole matrix, not one shell per comparison.
 *
 * Emitting only the MATCHES keeps this linear in the corpus instead of
 * quadratic in string concatenation: measured on bash 3.2, printing a full
 * 0/1 row per pattern took 32 seconds where printing hits takes 8.
 *
 * `$pattern` is deliberately unquoted in the `case` arm — that is what makes
 * bash treat it as a pattern rather than a literal. The test asserts no pattern
 * carries a character that would expand there before it ever reaches this.
 */
const ORACLE = `
set -uo pipefail
patterns_file="$1"
paths_file="$2"
paths=()
while IFS= read -r line; do paths+=("$line"); done < "$paths_file"
index=0
while IFS= read -r pattern; do
  for path in "\${paths[@]}"; do
    case "$path" in
      $pattern) printf '%s\\t%s\\n' "$index" "$path" ;;
    esac
  done
  index=$((index + 1))
done < "$patterns_file"
`;

/** Long enough for the whole matrix on bash 3.2, short enough to be a deadline. */
const ORACLE_TIMEOUT_MS = 300_000;

/**
 * Every bash this machine has, by resolved path.
 *
 * 3.2 and 5.x have genuinely disagreed about shell fixtures in this repo
 * before, and 3.2 is the one the pre-push hook runs on a Mac. Driving both is
 * the difference between "the compiler matches a bash" and "the compiler
 * matches the bash that will run".
 */
function bashInterpreters() {
  const resolved = new Map();
  for (const candidate of [
    "/bin/bash",
    "bash",
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
  ]) {
    const found = spawnSync(
      candidate,
      ["-c", 'printf "%s %s" "$BASH" "$BASH_VERSION"'],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        timeout: 30_000,
      },
    );
    if (found.error || found.status !== 0) continue;
    const [path, version] = found.stdout.trim().split(" ");
    if (path?.startsWith("/") && !resolved.has(path))
      resolved.set(path, version);
  }
  return resolved;
}

/** Every distinct path pattern the table matches changed paths against. */
function tablePatterns() {
  const patterns = new Set();
  for (const { subject, dynamic, arm } of walkArms(ROUTING_GROUPS)) {
    // A dispatch on the root-manifest class switches on a verdict string, and
    // an engine-computed group's patterns are built at run time from a value
    // this test does not have. Neither is a path pattern.
    if (subject !== "path" || dynamic !== null) continue;
    for (const pattern of arm.patterns) patterns.add(pattern);
  }
  return [...patterns];
}

/**
 * A path built to match `pattern`, with the index in that path of the first
 * character the pattern requires literally.
 *
 * `*` becomes `a/b` rather than a single segment: the whole point of this
 * compiler is that `*` crosses `/`, so the synthetic match has to exercise it.
 */
function synthesize(pattern) {
  let path = "";
  let firstLiteral = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      path += "a/b";
      continue;
    }
    if (character === "?") {
      path += "c";
      continue;
    }
    if (character === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close === -1) {
        if (firstLiteral === null) firstLiteral = path.length;
        path += "[";
        continue;
      }
      // A member of the class, skipping a leading negation and any range
      // punctuation, is enough to exercise it.
      const member = [...pattern.slice(index + 1, close)].find(
        (candidate) => !"!^-".includes(candidate),
      );
      path += member ?? "d";
      index = close;
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (firstLiteral === null) firstLiteral = path.length;
      path += pattern[index] ?? "";
      continue;
    }
    if (firstLiteral === null) firstLiteral = path.length;
    path += character;
  }
  return { path, firstLiteral };
}

/**
 * Neighbours of the synthetic match, each a small mutation away from it.
 *
 * A near miss has to be near: an unrelated string proves the compiler can say
 * "no" to something obvious, which is not the question. Each candidate keeps
 * the shape of the matching path and changes one thing about it.
 *
 * Several candidates are generated rather than one, because which mutation
 * actually misses depends on the pattern. Mutating the first required literal
 * breaks `scripts/deploy-*.sh`, but a pattern whose only literals are
 * separators survives it: a three-star, two-slash pattern given
 * `a/bta/b/a/b` still has three slashes and still matches, because the
 * character that changed was one of them. BASH decides which are real misses; the test
 * then requires every glob pattern to have at least one, and a pattern with
 * none fails rather than quietly losing its control.
 */
function nearMisses(pattern) {
  const { path, firstLiteral } = synthesize(pattern);
  const candidates = new Set();
  if (firstLiteral !== null) {
    const original = path[firstLiteral];
    candidates.add(
      path.slice(0, firstLiteral) +
        (original === "t" ? "s" : "t") +
        path.slice(firstLiteral + 1),
    );
    candidates.add(path.slice(0, firstLiteral) + path.slice(firstLiteral + 1));
  }
  candidates.add(`${path}Z`);
  candidates.add(`Z${path}`);
  // Flattening every separator is what reaches a pattern made only of stars and
  // slashes: it changes how many segments the path has without touching a
  // single literal character.
  candidates.add(path.split("/").join("-"));
  candidates.add(path.slice(0, -1));
  candidates.delete(path);
  return [...candidates].filter((candidate) => candidate !== "");
}

/** Ask one bash which of `paths` each of `patterns` matches. */
function askBash(bash, patterns, paths) {
  const dir = mkdtempSync(join(tmpdir(), "routing-oracle-"));
  try {
    const patternsFile = join(dir, "patterns");
    const pathsFile = join(dir, "paths");
    writeFileSync(patternsFile, `${patterns.join("\n")}\n`);
    writeFileSync(pathsFile, `${paths.join("\n")}\n`);
    const result = runProbeShell(bash, ["-s", "--", patternsFile, pathsFile], {
      input: ORACLE,
      dirs: probeDirs(dir),
      timeout: ORACLE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(
      result.error?.code,
      undefined,
      `asking ${bash} for the match matrix failed: ${result.error?.message}`,
    );
    assert.equal(
      result.status,
      0,
      `asking ${bash} for the match matrix exited ${result.status}: ${result.stderr}`,
    );
    const hits = new Set();
    for (const line of result.stdout.split("\n")) {
      if (line !== "") hits.add(line);
    }
    return hits;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The path corpus. Tracked paths come from `git ls-files -z`, so a name with a
 * space or a quote in it arrives intact rather than in git's escaped form.
 */
function trackedPaths() {
  const listed = spawnSync("git", ["-C", REPO, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split("\0").filter((path) => path !== "");
}

const patterns = tablePatterns();
const globs = patterns.filter((pattern) => isGlob(pattern));

const literals = patterns.filter((pattern) => !isGlob(pattern));
const synthetics = globs.map((pattern) => synthesize(pattern).path);
const misses = globs.map((pattern) => nearMisses(pattern));
const corpus = [
  ...new Set([...literals, ...trackedPaths(), ...synthetics, ...misses.flat()]),
];

test("no pattern carries a character bash would expand in a `case` arm", () => {
  // The oracle puts the pattern in the arm UNQUOTED, which is what makes bash
  // read it as a pattern. That also means `$`, a backtick, `~` or `{}` would be
  // expanded before matching, and the oracle would be answering about a
  // different pattern than the table holds.
  for (const pattern of patterns) {
    assert.ok(
      !/[$`~{}]/.test(pattern),
      `pattern ${JSON.stringify(pattern)} carries a character bash expands in an unquoted \`case\` arm; the oracle cannot ask about it faithfully`,
    );
  }
});

test("no corpus path carries a byte the line-based oracle cannot carry", () => {
  for (const path of corpus) {
    assert.ok(
      !path.includes("\n") && !path.includes("\t"),
      `path ${JSON.stringify(path)} holds a tab or newline, which the oracle's line protocol would split`,
    );
  }
});

test("the corpus is the size the design asks for", () => {
  assert.ok(
    patterns.length > 400,
    `only ${patterns.length} patterns in the table`,
  );
  assert.ok(corpus.length > 2000, `only ${corpus.length} paths in the corpus`);
  assert.equal(
    misses.filter((candidates) => candidates.length === 0).length,
    0,
    "some glob pattern got no near-miss candidates at all; a control that does not exist proves nothing",
  );
});

const interpreters = bashInterpreters();

test("at least one bash was found to act as the oracle", () => {
  assert.ok(interpreters.size > 0, "no usable bash on this machine");
});

for (const [bash, version] of interpreters) {
  test(`the compiler agrees with ${bash} (${version}) on every pattern`, () => {
    const hits = askBash(bash, patterns, corpus);
    const disagreements = [];
    patterns.forEach((pattern, index) => {
      const compiled = casePatternToRegExp(pattern);
      for (const path of corpus) {
        const shell = hits.has(`${index}\t${path}`);
        const compiledSays = compiled.test(path);
        if (shell !== compiledSays && disagreements.length < 20) {
          disagreements.push(
            `${JSON.stringify(pattern)} vs ${JSON.stringify(path)}: bash says ${shell}, casePatternToRegExp says ${compiledSays}`,
          );
        }
      }
    });
    assert.deepEqual(
      disagreements,
      [],
      `the pattern compiler disagrees with ${bash}:\n  - ${disagreements.join("\n  - ")}`,
    );
  });

  test(`${bash} confirms every glob has a real match and a real near miss`, () => {
    const paths = [...new Set([...synthetics, ...misses.flat()])];
    const hits = askBash(bash, globs, paths);
    const broken = [];
    globs.forEach((pattern, index) => {
      if (!hits.has(`${index}\t${synthetics[index]}`)) {
        broken.push(
          `${JSON.stringify(pattern)} was given ${JSON.stringify(synthetics[index])} as a synthetic MATCH and bash does not match it`,
        );
      }
      const missed = misses[index].filter(
        (candidate) => !hits.has(`${index}\t${candidate}`),
      );
      // A pattern of nothing but stars matches every string there is, so it has
      // no non-matching neighbour and demanding one would be demanding a
      // falsehood. The table holds exactly one — the default arm under
      // `*/package.json` — and naming the shape rather than the arm keeps the
      // exemption from widening into "controls are optional".
      if (missed.length === 0 && /^\*+$/.test(pattern)) return;
      if (missed.length === 0) {
        broken.push(
          `${JSON.stringify(pattern)} has no near miss among ${JSON.stringify(misses[index])} — every candidate still matches, so this pattern has no negative control`,
        );
      }
    });
    assert.deepEqual(
      broken,
      [],
      `synthetic controls that do not control anything:\n  - ${broken.join("\n  - ")}`,
    );
  });
}

test("the compiler holds the semantics a glob library would get wrong", () => {
  // Written out rather than derived, so a reader can see the claim without
  // running the oracle, and so a regression names itself.
  const cases = [
    ["scripts/*.sh", "scripts/repo-health/dev-janitor.sh", true],
    ["scripts/*/deploy-*.sh", "scripts/deploy/a/b/deploy-bridge.sh", true],
    ["scripts/deploy-*.sh", "scripts/deploy/deploy-bridge.sh", false],
    ["*.md", "docs/notes/x.md", true],
    ["a?b", "a/b", true],
    [
      "ui-dashboard/src/app/*/page.tsx",
      "ui-dashboard/src/app/x/y/page.tsx",
      true,
    ],
    ["docs/*", "docs/a/b/c.md", true],
    ["scripts/deploy-*.sh", "scripts/deployx-a.sh", false],
  ];
  for (const [pattern, path, expected] of cases) {
    assert.equal(
      casePatternToRegExp(pattern).test(path),
      expected,
      `${pattern} vs ${path} should be ${expected}`,
    );
  }
});

test("the compiler refuses what it cannot translate faithfully", () => {
  assert.throws(
    () => casePatternToRegExp("scripts/[[:alpha:]]*"),
    /POSIX class/,
    "a POSIX class has no faithful JavaScript equivalent and must be refused, not approximated",
  );
  assert.throws(() => casePatternToRegExp("scripts/x\\"), /backslash/);
});

test("the oracle script itself is the file this test claims it is", () => {
  // Cheap guard against the ORACLE template drifting into something that no
  // longer treats the pattern as a pattern.
  assert.match(ORACLE, /\$pattern\) printf/);
  assert.ok(
    !ORACLE.includes('"$pattern")'),
    "the oracle quotes the pattern in its `case` arm, which makes bash match it literally",
  );
  assert.ok(
    readFileSync(fileURLToPath(import.meta.url), "utf8").includes("ORACLE"),
  );
});

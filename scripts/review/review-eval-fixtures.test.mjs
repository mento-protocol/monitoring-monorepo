#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalPath,
  checkFinderArgv,
  checkFixtures,
  DEFAULT_CONTRACT_PATH,
  FINDER_ARGV_ELEMENT,
  forbiddenShasForFixture,
  fixtureForPr,
  gridFixtures,
  loadContract,
  materializeFixture,
  scorableTotals,
} from "./review-eval-fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const contractPath = path.join(repoRoot, DEFAULT_CONTRACT_PATH);
const committed = loadContract(contractPath);
const TAGS = "eval/review-skill/v1";

function temp(prefix) {
  return mkdtempSync(path.join(tmpdir(), `review-eval-${prefix}-`));
}

function clone(value) {
  return structuredClone(value);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Copies only the byte-frozen inputs the contract pins, so a corruption case
// can flip one character without touching the real repository.
function stageFrozenInputs() {
  const root = temp("root");
  mkdirSync(path.join(root, "docs/evals"), { recursive: true });
  mkdirSync(path.join(root, "scripts/review"), { recursive: true });
  for (const relative of [
    "docs/evals/review-skill-truth",
    "docs/evals/review-skill-finder-reports",
    "scripts/review/prompts",
  ]) {
    cpSync(path.join(repoRoot, relative), path.join(root, relative), {
      recursive: true,
    });
  }
  return root;
}

function replaceOnce(file, from, to) {
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes(from), `${file} does not contain ${from}`);
  writeFileSync(file, text.replace(from, to));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, message, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(cwd, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * A source repository shaped like the real one: a base, the pull request head,
 * and the fix commit that carries the answer key and must never survive.
 */
function buildSourceRepo({
  pr = 42,
  skillDirAtHead = false,
  tagHeadAt = null,
} = {}) {
  const dir = temp("src");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Fixture");
  git(dir, "config", "user.email", "fixture@example.com");
  const root = commit(dir, "root", { "README.md": `root of ${pr}\n` });
  const base = commit(dir, "base", {
    "src/app.mjs": "export const value = 1;\n",
  });
  const headFiles = { "src/app.mjs": "export const value = 2;\n" };
  if (skillDirAtHead) headFiles[".skill/SKILL.md"] = "leaked skill\n";
  const head = commit(dir, "head", headFiles);
  const fix = commit(dir, "fix", {
    "src/app.mjs": "export const value = 3; // reviewer found the defect\n",
  });
  git(dir, "tag", `${TAGS}/pr-${pr}/head`, tagHeadAt === "fix" ? fix : head);
  git(dir, "tag", `${TAGS}/pr-${pr}/base`, base);
  return { dir, pr, root, base, head, fix };
}

// No repo slug, so materialization passes no --url and no test can reach the
// network when a tag or a commit is deliberately absent.
function syntheticContract(source) {
  return {
    schema_version: 1,
    suite_id: "review-skill-v1",
    tags_namespace: TAGS,
    fixtures: [
      {
        pr: source.pr,
        title: "fixture",
        first_head: source.head,
        base_sha: source.base,
        tag_head: `${TAGS}/pr-${source.pr}/head`,
        tag_base: `${TAGS}/pr-${source.pr}/base`,
        truth_file: `docs/evals/review-skill-truth/pr-${source.pr}.json`,
        truth_sha256: "0".repeat(64),
        scorable_ids: [1],
        p1_ids: [1],
        grid: false,
        finder_reports: [],
      },
    ],
  };
}

test("the committed contract passes every offline check", () => {
  const result = checkFixtures({ contract: committed.contract, repoRoot });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.checked.offline, true);
  assert.deepEqual(scorableTotals(committed.contract), {
    prs: 9,
    scorable: 51,
    p1: 16,
  });
  assert.equal(gridFixtures(committed.contract).length, 6);
  assert.equal(committed.digest, sha256File(contractPath));
  assert.equal(committed.digest.length, 64);
});

test("the finder argv is pinned to a whitespace-free vector of its own tool", () => {
  const committedArgv = committed.contract.sut.finder.argv;
  assert.equal(committedArgv[0], committed.contract.sut.finder.tool);
  assert.ok(
    committedArgv.every((element) => FINDER_ARGV_ELEMENT.test(element)),
  );

  const check = (finder) => {
    const problems = [];
    checkFinderArgv({ finder, problems });
    return problems.join("\n");
  };
  const base = { tool: "codex", argv: [...committedArgv] };
  assert.equal(check(base), "");
  assert.match(
    check({ tool: "codex", command: "codex exec review" }),
    /argv must be a non-empty array/,
  );
  assert.match(
    check({ ...base, command: "codex exec review" }),
    /command is no longer read/,
  );
  assert.match(
    check({ tool: "codex", argv: ["codex", "exec review --base base"] }),
    /argv\[1\] has a character outside/,
  );
  assert.match(
    check({ tool: "codex", argv: ["codex", "exec\treview"] }),
    /argv\[1\] has a character outside/,
  );
  assert.match(
    check({ tool: "codex", argv: ["bash", "-c", "curl"] }),
    /argv\[0\] must be the declared tool/,
  );

  // The whole contract must refuse a command string, not only the helper.
  const tampered = clone(committed.contract);
  delete tampered.sut.finder.argv;
  tampered.sut.finder.command = "bash -c curl";
  const result = checkFixtures({ contract: tampered, repoRoot });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((problem) =>
      /argv must be a non-empty array/.test(problem),
    ),
    result.problems.join("\n"),
  );
});

test("loading rejects a contract that is not JSON", () => {
  const root = temp("badjson");
  try {
    const file = path.join(root, "contract.json");
    writeFileSync(file, "{ not json");
    assert.throws(() => loadContract(file), /is not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a flipped byte in any frozen truth file fails its digest", () => {
  const root = stageFrozenInputs();
  try {
    const fixture = committed.contract.fixtures[0];
    replaceOnce(path.join(root, fixture.truth_file), "acted_on", "actedXon");
    const result = checkFixtures({
      contract: committed.contract,
      repoRoot: root,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some(
        (problem) =>
          problem.includes(fixture.truth_file) &&
          problem.includes("does not match its frozen sha256"),
      ),
      result.problems.join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the frozen id list must agree with the acted-on predicate", () => {
  const root = stageFrozenInputs();
  try {
    const contract = clone(committed.contract);
    const fixture = contract.fixtures[0];
    const truthFile = path.join(root, fixture.truth_file);
    const truth = JSON.parse(readFileSync(truthFile, "utf8"));
    truth.findings.push({
      id: 999_000_111,
      author: "claude[bot]",
      path: "scripts/pr/issue-board-backfill.mjs",
      line: 1,
      severity: "P2",
      title: "later harvest",
      acted_on: true,
      declined: false,
      body: "later harvest",
    });
    writeFileSync(truthFile, JSON.stringify(truth));
    fixture.truth_sha256 = sha256File(truthFile);

    const result = checkFixtures({ contract, repoRoot: root });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some(
        (problem) =>
          problem.includes("scorable_ids omits") &&
          problem.includes("999000111"),
      ),
      result.problems.join("\n"),
    );
    assert.ok(
      !result.problems.some((problem) => problem.includes("frozen sha256")),
      "the rewritten truth still matches its recorded digest",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a flipped byte in a frozen finder report fails its digest", () => {
  const root = stageFrozenInputs();
  try {
    const report = gridFixtures(committed.contract)[0].finder_reports[0];
    replaceOnce(path.join(root, report.file), "e", "3");
    const result = checkFixtures({
      contract: committed.contract,
      repoRoot: root,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some(
        (problem) =>
          problem.includes(report.file) && problem.includes("frozen sha256"),
      ),
      result.problems.join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a truth finding marked duplicate_of is refused as a scorable id", () => {
  const root = stageFrozenInputs();
  try {
    const contract = clone(committed.contract);
    const fixture = fixtureForPr(contract, 2121);
    const file = path.join(root, fixture.truth_file);
    const truth = JSON.parse(readFileSync(file, "utf8"));
    const acted = truth.findings.filter((finding) => finding.acted_on === true);
    const [kept, duplicate] = acted;
    duplicate.duplicate_of = kept.id;
    writeFileSync(file, JSON.stringify(truth, null, 1));
    fixture.truth_sha256 = sha256File(file);
    const ids = acted.map((finding) => finding.id);
    fixture.scorable_ids = ids;
    fixture.p1_ids = [];
    const problems = () =>
      checkFixtures({ contract, repoRoot: root }).problems.join("\n");
    assert.match(
      problems(),
      new RegExp(`names ${duplicate.id},.*duplicate_of ${kept.id}`),
    );
    // Dropping it is accepted: the duplicate leaves the derived set too, so
    // the acted-on comparison no longer demands it back.
    fixture.scorable_ids = ids.filter((id) => id !== duplicate.id);
    assert.doesNotMatch(problems(), /duplicate_of|_ids/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a grid fixture carries exactly two frozen finder reports", () => {
  const exactlyTwo = (contract) =>
    checkFixtures({ contract, repoRoot }).problems.filter((problem) =>
      problem.includes("needs exactly two"),
    );
  assert.deepEqual(exactlyTwo(committed.contract), []);
  const short = clone(committed.contract);
  const shortFixture = gridFixtures(short)[0];
  const [first] = shortFixture.finder_reports;
  shortFixture.finder_reports = [first];
  assert.deepEqual(exactlyTwo(short), [
    `PR ${shortFixture.pr} is a grid fixture with 1 frozen finder reports; a grid fixture needs exactly two`,
  ]);
  const long = clone(committed.contract);
  const longFixture = gridFixtures(long)[0];
  longFixture.finder_reports = [...longFixture.finder_reports, first];
  assert.deepEqual(exactlyTwo(long), [
    `PR ${longFixture.pr} is a grid fixture with 3 frozen finder reports; a grid fixture needs exactly two`,
  ]);
});

test("a flipped byte in either run prompt fails its digest", () => {
  for (const name of ["request", "handoff"]) {
    const root = stageFrozenInputs();
    try {
      const prompt = committed.contract.prompts[name];
      replaceOnce(path.join(root, prompt.file), "Review", "Reviev");
      const result = checkFixtures({
        contract: committed.contract,
        repoRoot: root,
      });
      assert.equal(result.ok, false);
      assert.ok(
        result.problems.some(
          (problem) =>
            problem.includes(prompt.file) && problem.includes("frozen sha256"),
        ),
        result.problems.join("\n"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a handoff prompt without its placeholder is reported", () => {
  const root = stageFrozenInputs();
  try {
    const contract = clone(committed.contract);
    const file = path.join(root, contract.prompts.handoff.file);
    replaceOnce(file, "{{OTHER_REVIEW}}", "the other review");
    contract.prompts.handoff.sha256 = sha256File(file);
    const result = checkFixtures({ contract, repoRoot: root });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => problem.includes("OTHER_REVIEW")),
      result.problems.join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing frozen files are reported rather than thrown", () => {
  const root = temp("empty");
  try {
    const result = checkFixtures({
      contract: committed.contract,
      repoRoot: root,
    });
    assert.equal(result.ok, false);
    const missing = result.problems.filter((problem) =>
      problem.includes("is missing"),
    );
    // One truth file per fixture, every frozen finder report, both prompts.
    const frozen = committed.contract.fixtures.reduce(
      (total, fixture) => total + 1 + (fixture.finder_reports ?? []).length,
      Object.keys(committed.contract.prompts).length,
    );
    assert.equal(missing.length, frozen);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every contract problem is collected, not just the first", () => {
  const contract = clone(committed.contract);
  contract.fixtures[0].first_head = "not-a-sha";
  contract.fixtures[1].tag_head = "eval/other/pr-1984/head";
  contract.fixtures[2].scorable_ids.push(contract.fixtures[3].scorable_ids[0]);
  contract.fixtures[4].p1_ids.push(123);
  contract.cadence_days.freshness_warn = 90;
  contract.verdict_rules.regression_net_flips = 0;

  const result = checkFixtures({ contract, repoRoot });
  assert.equal(result.ok, false);
  const joined = result.problems.join("\n");
  assert.match(joined, /first_head must be a 40-character lowercase sha/);
  assert.match(
    joined,
    /tag_head must be eval\/review-skill\/v1\/pr-1984\/head/,
  );
  assert.match(joined, /appears in more than one fixture/);
  assert.match(joined, /p1 id 123 is not in scorable_ids/);
  assert.match(joined, /freshness_warn must be shorter than/);
  assert.match(joined, /regression_net_flips must be a positive number/);
});

test("a contract that is not an object fails closed", () => {
  for (const bad of [null, [], "contract"]) {
    const result = checkFixtures({ contract: bad, repoRoot });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, ["contract must be a JSON object"]);
  }
});

test("online mode resolves every eval tag against the pinned commit", () => {
  const calls = [];
  const runGit = ({ args }) => {
    calls.push(args);
    const ref = args[args.length - 1];
    const fixture = committed.contract.fixtures.find(
      (candidate) =>
        ref.includes(candidate.tag_head) || ref.includes(candidate.tag_base),
    );
    if (args.includes("cat-file")) return { status: 0, stdout: "", stderr: "" };
    const sha = ref.includes("/head") ? fixture.first_head : fixture.base_sha;
    return { status: 0, stdout: `${sha}\n`, stderr: "" };
  };
  const result = checkFixtures({
    contract: committed.contract,
    repoRoot,
    offline: false,
    srcRepo: "/src/monorepo",
    runGit,
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked.offline, false);
  // Two refs per fixture, each resolved and then proved present.
  assert.equal(calls.length, committed.contract.fixtures.length * 2 * 2);
  assert.ok(
    calls.every((args) => args[0] === "-C" && args[1] === "/src/monorepo"),
  );
});

test("a tag that moved off the pinned commit is reported", () => {
  const moved = "f".repeat(40);
  const runGit = ({ args }) => {
    if (args.includes("cat-file")) return { status: 0, stdout: "", stderr: "" };
    const ref = args[args.length - 1];
    if (ref.includes("pr-1990/head"))
      return { status: 0, stdout: `${moved}\n`, stderr: "" };
    if (ref.includes("pr-1995/base"))
      return { status: 1, stdout: "", stderr: "" };
    const fixture = committed.contract.fixtures.find(
      (candidate) =>
        ref.includes(candidate.tag_head) || ref.includes(candidate.tag_base),
    );
    const sha = ref.includes("/head") ? fixture.first_head : fixture.base_sha;
    return { status: 0, stdout: `${sha}\n`, stderr: "" };
  };
  const result = checkFixtures({
    contract: committed.contract,
    repoRoot,
    offline: false,
    srcRepo: "/src/monorepo",
    runGit,
  });
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /pr-1990\/head resolves to f{40}/);
  assert.match(result.problems[1], /tag does not exist/);
});

test("offline mode resolves the eval tags locally and never over the network", () => {
  const calls = [];
  const runGit = ({ args }) => {
    calls.push(args);
    if (args[0] === "ls-remote") throw new Error("offline made a network call");
    if (args.includes("cat-file")) return { status: 0, stdout: "", stderr: "" };
    const ref = args[args.length - 1];
    // Every tag resolves except this one, which stands for a deleted or
    // renamed `eval/**` tag. Offline used to skip the check and stay green.
    if (ref.includes("pr-1999/head")) {
      return { status: 1, stdout: "", stderr: "" };
    }
    const fixture = committed.contract.fixtures.find(
      (candidate) =>
        ref.includes(candidate.tag_head) || ref.includes(candidate.tag_base),
    );
    const sha = ref.includes("/head") ? fixture.first_head : fixture.base_sha;
    return { status: 0, stdout: `${sha}\n`, stderr: "" };
  };
  const result = checkFixtures({
    contract: committed.contract,
    repoRoot,
    offline: true,
    runGit,
  });
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /pr-1999\/head/);
  assert.match(result.problems[0], /tag does not exist/);
  // The repository the check runs on is the clone it resolves against.
  assert.ok(calls.every((args) => args[0] === "-C" && args[1] === repoRoot));
});

test("online mode without a local clone peels the tag from ls-remote", () => {
  const runGit = ({ args }) => {
    assert.equal(args[0], "ls-remote");
    assert.equal(
      args[1],
      "https://github.com/mento-protocol/monitoring-monorepo.git",
    );
    const ref = args[2];
    const fixture = committed.contract.fixtures.find(
      (candidate) =>
        ref.includes(candidate.tag_head) || ref.includes(candidate.tag_base),
    );
    const sha = ref.includes("/head") ? fixture.first_head : fixture.base_sha;
    return {
      status: 0,
      stdout: `${"a".repeat(40)}\t${ref}\n${sha}\t${ref}^{}\n`,
      stderr: "",
    };
  };
  const result = checkFixtures({
    contract: committed.contract,
    repoRoot,
    offline: false,
    runGit,
  });
  assert.deepEqual(result.problems, []);
});

test("the forbidden set names the fix head from the frozen truth", () => {
  for (const fixture of committed.contract.fixtures) {
    const forbidden = forbiddenShasForFixture({ fixture, repoRoot });
    const truth = JSON.parse(
      readFileSync(path.join(repoRoot, fixture.truth_file), "utf8"),
    );
    const expected =
      truth.last_head === fixture.first_head ? [] : [truth.last_head];
    assert.deepEqual(forbidden, expected);
  }
  assert.deepEqual(
    forbiddenShasForFixture({
      fixture: {
        ...committed.contract.fixtures[0],
        truth_file: "docs/evals/absent.json",
      },
      repoRoot,
    }),
    [],
  );
});

test("materialization detaches at the pinned head and prunes the fix commit", () => {
  const source = buildSourceRepo();
  const cacheDir = temp("cache");
  try {
    const contract = syntheticContract(source);
    const built = materializeFixture({
      contract,
      pr: source.pr,
      cacheDir,
      srcRepo: source.dir,
      forbidden: [source.fix],
    });
    assert.equal(built.status, "built");
    assert.equal(built.head, source.head);
    assert.equal(built.tag_pinned, true);
    assert.equal(path.dirname(built.path), path.resolve(cacheDir));
    assert.equal(
      path.basename(built.path),
      `fx-${source.pr}-${source.head.slice(0, 12)}`,
    );

    assert.equal(git(built.path, "rev-parse", "HEAD"), source.head);
    assert.equal(git(built.path, "rev-parse", "refs/heads/base"), source.base);
    assert.equal(git(built.path, "remote"), "");
    assert.equal(git(built.path, "status", "--porcelain"), "");
    assert.equal(git(built.path, "rev-list", "--all", "--count"), "3");
    assert.equal(built.commits, 3);
    assert.equal(
      readFileSync(path.join(built.path, "src/app.mjs"), "utf8"),
      "export const value = 2;\n",
    );
    assert.throws(() => git(built.path, "cat-file", "-e", source.fix));
    assert.equal(
      git(built.path, "for-each-ref", "--format=%(refname)"),
      "refs/heads/base",
    );

    const reused = materializeFixture({
      contract,
      pr: source.pr,
      cacheDir,
      srcRepo: source.dir,
      forbidden: [source.fix],
    });
    assert.equal(reused.status, "reused");
    assert.equal(reused.path, built.path);
    assert.equal(reused.tag_pinned, true);
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a cached fixture that a run edited or moved is rebuilt", () => {
  const source = buildSourceRepo();
  const cacheDir = temp("cache");
  try {
    const contract = syntheticContract(source);
    const call = () =>
      materializeFixture({
        contract,
        pr: source.pr,
        cacheDir,
        srcRepo: source.dir,
        forbidden: [source.fix],
      });
    const built = call();
    assert.equal(built.status, "built");

    writeFileSync(
      path.join(built.path, "src/app.mjs"),
      "edited by a review run\n",
    );
    assert.equal(call().status, "built");
    assert.equal(
      readFileSync(path.join(built.path, "src/app.mjs"), "utf8"),
      "export const value = 2;\n",
    );

    assert.equal(call().status, "reused");
    git(built.path, "checkout", "--quiet", "--detach", "base");
    assert.equal(call().status, "built");
    assert.equal(git(built.path, "rev-parse", "HEAD"), source.head);

    assert.equal(call().status, "reused");
    assert.equal(
      materializeFixture({
        contract,
        pr: source.pr,
        cacheDir,
        srcRepo: source.dir,
        forbidden: [source.fix],
        force: true,
      }).status,
      "built",
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a reachable forbidden commit fails the build", () => {
  const source = buildSourceRepo();
  const cacheDir = temp("cache");
  try {
    assert.throws(
      () =>
        materializeFixture({
          contract: syntheticContract(source),
          pr: source.pr,
          cacheDir,
          srcRepo: source.dir,
          forbidden: [source.root],
        }),
      /forbidden object .* is still reachable/,
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a .skill directory in the checkout fails the build", () => {
  const source = buildSourceRepo({ skillDirAtHead: true });
  const cacheDir = temp("cache");
  try {
    assert.throws(
      () =>
        materializeFixture({
          contract: syntheticContract(source),
          pr: source.pr,
          cacheDir,
          srcRepo: source.dir,
          forbidden: [source.fix],
        }),
      /\.skill directory survives/,
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an eval tag that names another commit fails the build", () => {
  const source = buildSourceRepo({ tagHeadAt: "fix" });
  const cacheDir = temp("cache");
  try {
    assert.throws(
      () =>
        materializeFixture({
          contract: syntheticContract(source),
          pr: source.pr,
          cacheDir,
          srcRepo: source.dir,
          forbidden: [source.fix],
        }),
      new RegExp(`tag ${TAGS}/pr-${source.pr}/head resolves to ${source.fix}`),
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a missing eval tag falls back and records that the run was not tag-pinned", () => {
  const source = buildSourceRepo();
  const cacheDir = temp("cache");
  try {
    git(source.dir, "tag", "-d", `${TAGS}/pr-${source.pr}/head`);
    git(source.dir, "tag", "-d", `${TAGS}/pr-${source.pr}/base`);
    const built = materializeFixture({
      contract: syntheticContract(source),
      pr: source.pr,
      cacheDir,
      srcRepo: source.dir,
      forbidden: [source.fix],
    });
    assert.equal(built.status, "built");
    assert.equal(built.tag_pinned, false);
    assert.equal(git(built.path, "rev-parse", "HEAD"), source.head);
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an unreachable head fails the build instead of scoring a wrong tree", () => {
  const source = buildSourceRepo();
  const other = buildSourceRepo({ pr: 43 });
  const cacheDir = temp("cache");
  try {
    const contract = syntheticContract(source);
    assert.throws(
      () =>
        materializeFixture({
          contract,
          pr: source.pr,
          cacheDir,
          srcRepo: other.dir,
          forbidden: [],
        }),
      /is unreachable from/,
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(other.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("the fixture cache may not live inside the source repository", () => {
  const source = buildSourceRepo();
  try {
    assert.throws(
      () =>
        materializeFixture({
          contract: syntheticContract(source),
          pr: source.pr,
          cacheDir: path.join(source.dir, ".cache"),
          srcRepo: source.dir,
        }),
      /inside the source repository/,
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
  }
});

test("a cache directory that reaches the repository through a symlink is refused", () => {
  // The lexical comparison this replaced accepted any path whose text sat
  // outside the checkout. A `--cache-dir` behind a symlink — or one whose own
  // parent is a link, so the check runs before the directory exists — then put
  // the fixture physically inside the repository, where a cell running with
  // Bash walks up to the frozen truth and scores without a leak signal.
  const source = buildSourceRepo();
  const outside = temp("outside");
  try {
    const link = path.join(outside, "cache");
    symlinkSync(path.join(source.dir, ".cache"), link);
    for (const cacheDir of [link, path.join(link, "fixtures")]) {
      assert.throws(
        () =>
          materializeFixture({
            contract: syntheticContract(source),
            pr: source.pr,
            cacheDir,
            srcRepo: source.dir,
          }),
        /inside the source repository/,
        `${cacheDir} was accepted`,
      );
    }
    // A link that stays outside the checkout is not the problem this refuses.
    assert.equal(
      canonicalPath(path.join(outside, "elsewhere", "fixtures")),
      path.join(realpathSync(outside), "elsewhere", "fixtures"),
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("materialization refuses a pull request the contract does not carry", () => {
  const source = buildSourceRepo();
  const cacheDir = temp("cache");
  try {
    assert.throws(
      () =>
        materializeFixture({
          contract: syntheticContract(source),
          pr: 4242,
          cacheDir,
          srcRepo: source.dir,
        }),
      /no fixture for PR 4242/,
    );
    assert.throws(
      () => fixtureForPr(committed.contract, 1978),
      /no fixture for PR 1978/,
    );
    assert.equal(fixtureForPr(committed.contract, "1990").pr, 1990);
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("build-fixture.sh is invoked with the pinned commits and never a shell string", () => {
  const source = buildSourceRepo();
  try {
    const calls = [];
    const report = materializeFixture({
      contract: syntheticContract(source),
      pr: source.pr,
      cacheDir: "/tmp/review-eval-cache",
      srcRepo: source.dir,
      forbidden: [source.fix],
      exec: ({ file, args, cwd }) => {
        calls.push({ file, args, cwd });
        return {
          status: 0,
          stdout: `${JSON.stringify({
            path: repoRoot,
            status: "reused",
            head: source.head,
            base: source.base,
            commits: 3,
            tag_pinned: true,
          })}\n`,
          stderr: "",
        };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(path.basename(calls[0].file), "build-fixture.sh");
    assert.ok(Array.isArray(calls[0].args));
    assert.deepEqual(calls[0].args.slice(0, 8), [
      "--src",
      source.dir,
      "--pr",
      String(source.pr),
      "--head",
      source.head,
      "--base",
      source.base,
    ]);
    assert.ok(calls[0].args.includes("--forbidden"));
    assert.equal(
      calls[0].args[calls[0].args.indexOf("--forbidden") + 1],
      source.fix,
    );
    assert.equal(report.pr, source.pr);
    assert.deepEqual(report.forbidden, [source.fix]);
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
  }
});

test("a build report that contradicts the contract is rejected", () => {
  const source = buildSourceRepo();
  try {
    const contract = syntheticContract(source);
    assert.throws(
      () =>
        materializeFixture({
          contract,
          pr: source.pr,
          cacheDir: "/tmp/review-eval-cache",
          srcRepo: source.dir,
          forbidden: [],
          exec: () => ({
            status: 0,
            stdout: `${JSON.stringify({ path: repoRoot, head: source.fix })}\n`,
            stderr: "",
          }),
        }),
      /reported head .* the contract pins/,
    );
    assert.throws(
      () =>
        materializeFixture({
          contract,
          pr: source.pr,
          cacheDir: "/tmp/review-eval-cache",
          srcRepo: source.dir,
          forbidden: [],
          exec: () => ({
            status: 1,
            stdout: "",
            stderr: "FATAL: cannot clone\n",
          }),
        }),
      /build-fixture\.sh failed for PR 42: FATAL: cannot clone/,
    );
  } finally {
    rmSync(source.dir, { recursive: true, force: true });
  }
});

test("the contract must declare a tool, a model and an effort for every role", () => {
  // Only `model` was checked here. `planCells` copies each role's `model` and
  // `effort` into `plan.json`, the orchestrator reads them out of the matrix
  // line and hands the effort to the CLI, so a contract that dropped one
  // passed the offline check and reached the shell as the string "undefined":
  // a run executed and recorded under provenance the contract never declared.
  for (const role of ["finder", "verifier", "control"]) {
    for (const field of ["tool", "model", "effort"]) {
      const tampered = clone(committed.contract);
      delete tampered.sut[role][field];
      const result = checkFixtures({ contract: tampered, repoRoot });
      assert.equal(result.ok, false, `sut.${role}.${field} was accepted`);
      assert.ok(
        result.problems.some((problem) =>
          new RegExp(
            `sut\\.${role}\\.${field} must be a non-empty string`,
          ).test(problem),
        ),
        result.problems.join("\n"),
      );
    }
    const empty = clone(committed.contract);
    empty.sut[role].effort = "";
    assert.ok(
      checkFixtures({ contract: empty, repoRoot }).problems.some((problem) =>
        new RegExp(`sut\\.${role}\\.effort must be a non-empty string`).test(
          problem,
        ),
      ),
    );
  }
  assert.deepEqual(
    checkFixtures({ contract: committed.contract, repoRoot }).problems.filter(
      (problem) => /sut\./.test(problem),
    ),
    [],
  );
});

test("the contract must declare a model and an effort for the judge", () => {
  // `runScoring` hands `contract.judge.effort` to the scoring helpers, whose
  // parameter defaults fire on `undefined`. A contract missing it would score
  // at the `high` default while the row claims the contract's effort, so the
  // offline check has to refuse it for the same reason it refuses a SUT role
  // with no effort.
  for (const field of ["model", "effort"]) {
    const missing = clone(committed.contract);
    delete missing.judge[field];
    const result = checkFixtures({ contract: missing, repoRoot });
    assert.equal(result.ok, false, `judge.${field} was accepted`);
    assert.ok(
      result.problems.some((problem) =>
        new RegExp(`judge\\.${field} must be a non-empty string`).test(problem),
      ),
      result.problems.join("\n"),
    );
    const empty = clone(committed.contract);
    empty.judge[field] = "";
    assert.ok(
      checkFixtures({ contract: empty, repoRoot }).problems.some((problem) =>
        new RegExp(`judge\\.${field} must be a non-empty string`).test(problem),
      ),
    );
  }
  assert.deepEqual(
    checkFixtures({ contract: committed.contract, repoRoot }).problems.filter(
      (problem) => /judge\./.test(problem),
    ),
    [],
  );
});

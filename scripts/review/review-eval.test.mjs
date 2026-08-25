#!/usr/bin/env node

// CLI-level suite for the review-skill evaluation. Every case runs offline:
// no model, no network, no `gh`. `scorePlan` is exercised with a stubbed exec
// so the judge path is covered without spending a cent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  forbiddenShasForFixture,
  loadContract,
} from "./review-eval-fixtures.mjs";
import { readLedger, validateLedgerRow } from "./review-eval-ledger.mjs";
import { baseLedgerRows, parseArgs, runScheduleIssue } from "./review-eval.mjs";
import { verdict } from "./review-eval-report.mjs";
import {
  assertAuthorizedFreshnessWorkflow,
  buildPlan,
  cellFingerprint,
  cellReuseDecision,
  comparabilityKey,
  leakSignals,
  loginsInFixtureTree,
  planCells,
  planStalenessIssueSync,
  resolveKind,
  scorePlan,
  SCRUBBED_ENV_VARS,
  scrubbedEnv,
} from "./review-eval-run.mjs";
import {
  failedRow,
  resolveBaseline,
  revalidateRow,
} from "./review-eval-result-shape.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = fileURLToPath(new URL("./review-eval.mjs", import.meta.url));
const contractRelative = "docs/evals/review-skill-fixtures.json";
const ledgerRelative = "docs/evals/review-skill-ledger.jsonl";
const { contract, digest: contractDigest } = loadContract(
  path.join(repoRoot, contractRelative),
);
const planEnv = {
  REVIEW_EVAL_CLAUDE_CLI: "2.1.14",
  REVIEW_EVAL_CODEX_CLI: "0.48.2",
  REVIEW_EVAL_HOST: "test-host",
  REVIEW_EVAL_SKILL_DIR: path.join(repoRoot, "scripts/review/prompts"),
  REVIEW_EVAL_CODEX_REVIEW_SH: path.join(repoRoot, contractRelative),
};

/** A temporary repository root holding only what the CLI reads. */
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "review-eval-cli-"));
  mkdirSync(path.join(root, "docs/evals"), { recursive: true });
  mkdirSync(path.join(root, "scripts/review"), { recursive: true });
  for (const entry of [
    contractRelative,
    "docs/evals/review-skill-truth",
    "docs/evals/review-skill-finder-reports",
    "docs/evals/review-skill-judge-calibration.json",
    "scripts/review/prompts",
  ]) {
    cpSync(path.join(repoRoot, entry), path.join(root, entry), {
      recursive: true,
    });
  }
  writeFileSync(path.join(root, ledgerRelative), "");
  return root;
}

function cli(args, { root, env = {} } = {}) {
  return spawnSync(
    process.execPath,
    [scriptPath, ...(root ? ["--root", root] : []), ...args],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function scorableIdsFor(prs) {
  return contract.fixtures
    .filter((fixture) => prs.includes(fixture.pr))
    .flatMap((fixture) => fixture.scorable_ids.map(String));
}

function p1IdsFor(prs) {
  return contract.fixtures
    .filter((fixture) => prs.includes(fixture.pr))
    .flatMap((fixture) => fixture.p1_ids.map(String));
}

/**
 * A schema-valid row whose numbers agree with its own bits. `verdict` defaults
 * to the verdict those numbers actually give, because a row is only evidence
 * while every field on it agrees with every other.
 */
function makeRow({
  executedAt = "2026-09-08T10:41:07Z",
  kind = "full",
  status = "complete",
  matchedIds = [],
  key = comparabilityKey({ contract, contractDigest }),
  verdict: statedVerdict = null,
} = {}) {
  const prs = contract.fixtures.map((fixture) => fixture.pr);
  const ids = scorableIdsFor(prs);
  const p1 = new Set(p1IdsFor(prs));
  const matched = new Set(matchedIds.map(String));
  const perDefect = Object.fromEntries(
    ids.map((id) => [id, [matched.has(id) ? 1 : 0]]),
  );
  const count = (subset) => {
    const hit = subset.filter((id) => matched.has(id)).length;
    return {
      matched: hit,
      opportunities: subset.length,
      rate: Number((hit / subset.length).toFixed(3)),
    };
  };
  const built = {
    schema_version: 1,
    kind,
    executed_at: executedAt,
    status,
    verdict: "INCOMPLETE",
    comparability_key: key,
    contract_digest: contractDigest,
    inputs: {
      skill_digest: "a".repeat(64),
      skill_ref: "installed",
      codex_review_sh_digest: "b".repeat(64),
      claude_cli: "2.1.14",
      codex_cli: "0.48.2",
      host: "test-host",
    },
    conditions: {
      pipeline: {
        model: "claude-opus-5",
        effort: "high",
        finder: "gpt-5.6-sol@high",
        draws: 1,
        recall: count(ids),
        p1: count(ids.filter((id) => p1.has(id))),
        novel_real: 1,
        wrong_claims: 0,
        usd: 4.2,
        seconds: 600,
        per_defect: perDefect,
      },
    },
    judge_calibration: { agreement: 40, total: 40 },
    vs_baseline: null,
    detail_dir: "docs/evals/review-skill-runs/2026-09-08-deadbeef",
    notes: "",
  };
  built.verdict = statedVerdict ?? verdict({ contract, row: built }).verdict;
  return built;
}

test("parseArgs selects exactly one mode and rejects the rest", () => {
  assert.equal(parseArgs(["--check-fixtures"]).mode, "check-fixtures");
  assert.equal(parseArgs(["--score", "/tmp/plan"]).planDir, "/tmp/plan");
  assert.throws(() => parseArgs([]), /choose one of/);
  assert.throws(
    () => parseArgs(["--check-fixtures", "--check-ledger"]),
    /exactly one mode/,
  );
  assert.throws(() => parseArgs(["--nope"]), /--nope/);
  assert.throws(() => parseArgs(["--score", ""]), /requires a value/);
});

test("parseArgs refuses an option that belongs to another mode", () => {
  assert.throws(
    () => parseArgs(["--check-ledger", "--offline"]),
    /--offline is not valid with --check-ledger/,
  );
  assert.throws(
    () => parseArgs(["--plan", "--kind", "weekly"]),
    /--kind must be full, canary, or auto/,
  );
  assert.throws(
    () => parseArgs(["--schedule-issue", "--repo", "nope"]),
    /owner\/repository/,
  );
  assert.throws(
    () => parseArgs(["--schedule-issue", "--date", "2026-9-1"]),
    /YYYY-MM-DD/,
  );
});

test("parseArgs defaults --kind to auto and tolerates the pnpm separator", () => {
  const options = parseArgs(["--", "--plan"]);
  assert.equal(options.mode, "plan");
  assert.equal(options.kind, "auto");
  assert.equal(options.contractPath, contractRelative);
  assert.equal(options.ledgerPath, ledgerRelative);
});

test("--help prints usage and exits zero", () => {
  const result = cli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Only\n--score invokes a model/);
});

test("--check-fixtures --offline passes on the committed contract", () => {
  const result = cli(["--check-fixtures", "--offline", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.contract_digest, contractDigest);
  assert.deepEqual(
    [output.prs, output.scorable, output.p1, output.grid],
    [6, 34, 12, 3],
  );
});

test("--check-fixtures online proves the tags against the remote", () => {
  const shim = mkdtempSync(path.join(tmpdir(), "review-eval-git-"));
  try {
    const log = path.join(shim, "calls.log");
    // A `git` that answers `ls-remote` from the contract and refuses every
    // other subcommand. Online mode that quietly resolved the tags in this
    // checkout would therefore fail here, which is the point: a local tag
    // still pointing at the pinned commit says nothing about the remote.
    writeFileSync(
      path.join(shim, "git"),
      `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args[0] !== "ls-remote") process.exit(1);
const contract = JSON.parse(readFileSync(${JSON.stringify(path.join(repoRoot, contractRelative))}, "utf8"));
const ref = String(args[2] || "").replace(/^refs\\/tags\\//, "");
for (const fixture of contract.fixtures) {
  const sha =
    fixture.tag_head === ref
      ? fixture.first_head
      : fixture.tag_base === ref
        ? fixture.base_sha
        : null;
  if (sha) {
    process.stdout.write(sha + "\\trefs/tags/" + ref + "^{}\\n");
    process.exit(0);
  }
}
process.exit(1);
`,
      { mode: 0o755 },
    );
    const result = cli(["--check-fixtures", "--json"], {
      env: { PATH: `${shim}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, JSON.stringify(output.problems));
    assert.equal(output.offline, false);
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.equal(calls.length, contract.fixtures.length * 2);
    assert.ok(
      calls.every((call) => call.startsWith("ls-remote https://github.com/")),
      calls.join(" | "),
    );
  } finally {
    rmSync(shim, { recursive: true, force: true });
  }
});

test("--check-fixtures fails on a tampered truth file", () => {
  const root = makeRoot();
  try {
    const truth = path.join(root, contract.fixtures[0].truth_file);
    writeFileSync(truth, `${readFileSync(truth, "utf8")} `);
    const result = cli(["--check-fixtures", "--offline", "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(
      output.problems.some((problem) => /sha256|digest/i.test(problem)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check-ledger accepts a valid row and rejects a foreign defect id", () => {
  const root = makeRoot();
  try {
    const ledger = path.join(root, ledgerRelative);
    const row = makeRow({ matchedIds: scorableIdsFor([1990]) });
    writeFileSync(ledger, `${JSON.stringify(row)}\n`);
    const good = cli(["--check-ledger", "--json"], { root });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).rows, 1);

    row.conditions.pipeline.per_defect["999999999"] = [0];
    row.conditions.pipeline.recall.opportunities += 1;
    row.conditions.pipeline.recall.rate = Number(
      (
        row.conditions.pipeline.recall.matched /
        row.conditions.pipeline.recall.opportunities
      ).toFixed(3),
    );
    writeFileSync(ledger, `${JSON.stringify(row)}\n`);
    const bad = cli(["--check-ledger", "--json"], { root });
    assert.equal(bad.status, 1);
    assert.ok(
      JSON.parse(bad.stdout).problems.some((problem) =>
        problem.includes("999999999"),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--check-ledger reports freshness from executed_at alone", () => {
  const root = makeRoot();
  try {
    const result = cli(["--check-ledger", "--json"], { root });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.rows, 0);
    assert.ok(["green", "warn", "red"].includes(output.freshness.level));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planCells builds the documented matrices", () => {
  const canary = planCells({ contract, kind: "canary" });
  assert.equal(canary.length, 3);
  assert.ok(canary.every((cell) => cell.condition === "replay"));
  assert.ok(canary.every((cell) => cell.finder_report));

  const full = planCells({ contract, kind: "full" });
  const byCondition = (name) =>
    full.filter((cell) => cell.condition === name).length;
  assert.equal(full.length, 24);
  assert.equal(byCondition("pipeline"), 12);
  assert.equal(byCondition("replay"), 6);
  assert.equal(byCondition("control"), 6);
  assert.ok(
    full
      .filter((cell) => cell.condition === "control")
      .every((cell) => cell.prompt === "request"),
  );
});

test("--plan writes plan.json and pins the comparability key", () => {
  const root = makeRoot();
  const out = path.join(root, "plan");
  try {
    const result = cli(["--plan", "--kind", "canary", "--out", out, "--json"], {
      root,
      env: planEnv,
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.kind, "canary");
    assert.equal(plan.cells.length, 3);
    assert.equal(
      plan.comparability_key,
      comparabilityKey({ contract, contractDigest }),
    );
    assert.equal(plan.inputs.host, "test-host");
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(out, "plan.json"), "utf8")).cells,
      plan.cells,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--plan --skill-ref stamps a dirty candidate run", () => {
  const root = makeRoot();
  const out = path.join(root, "plan");
  try {
    const result = cli(
      [
        "--plan",
        "--kind",
        "canary",
        "--skill-ref",
        path.join(repoRoot, "scripts/review/prompts"),
        "--out",
        out,
        "--json",
      ],
      { root, env: planEnv },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.inputs.dirty, true);
    assert.match(plan.inputs.skill_ref, /prompts$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comparabilityKey moves with the contract, the prompts, and the scorer", () => {
  const base = comparabilityKey({ contract, contractDigest });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(
    base,
    comparabilityKey({ contract, contractDigest: "f".repeat(64) }),
  );
  const drifted = structuredClone(contract);
  drifted.prompts.request.sha256 = "0".repeat(64);
  assert.notEqual(
    base,
    comparabilityKey({ contract: drifted, contractDigest }),
  );
  assert.notEqual(
    base,
    comparabilityKey({
      contract,
      contractDigest,
      matcherDigest: "1".repeat(64),
    }),
  );
  // The frozen calibration set decides what `judge_calibration` means, so an
  // edit to it starts a new series instead of being compared across.
  assert.notEqual(
    base,
    comparabilityKey({
      contract,
      contractDigest,
      calibrationDigest: "2".repeat(64),
    }),
  );
});

test("resolveKind picks full only when the last full run is past cadence", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  const fresh = [
    makeRow({ executedAt: "2026-11-01T00:00:00Z", kind: "full" }),
  ].map((row) => ({ ...row, contract_digest: contractDigest }));
  assert.equal(
    resolveKind({ kind: "auto", rows: fresh, contract, contractDigest, now }),
    "canary",
  );
  const stale = [makeRow({ executedAt: "2026-01-01T00:00:00Z", kind: "full" })];
  assert.equal(
    resolveKind({ kind: "auto", rows: stale, contract, contractDigest, now }),
    "full",
  );
  assert.equal(
    resolveKind({ kind: "canary", rows: stale, contract, contractDigest, now }),
    "canary",
  );
  // A full run that failed leaves a `kind: "full"` trace row. It is a record
  // that the harness tried, not a score, so it must not buy the schedule
  // another cadence window of canaries.
  const failed = [
    makeRow({ executedAt: "2026-01-01T00:00:00Z", kind: "full" }),
    makeRow({
      executedAt: "2026-11-30T00:00:00Z",
      kind: "full",
      status: "failed",
      verdict: "INCOMPLETE",
    }),
  ];
  assert.equal(
    resolveKind({ kind: "auto", rows: failed, contract, contractDigest, now }),
    "full",
  );
});

test("leakSignals flags a PR number and a reviewer login, not a bare review", () => {
  const truth = JSON.parse(
    readFileSync(path.join(repoRoot, contract.fixtures[2].truth_file), "utf8"),
  );
  const clean = leakSignals({
    transcript: "scripts/pr/pr-ready-state-core.mjs:750 grows past the cap.",
    truth,
    pr: 1990,
  });
  assert.equal(clean.suspected, false);
  const leaked = leakSignals({
    transcript: `I read the comments on #1990 from ${truth.findings[0].author}.`,
    truth,
    pr: 1990,
  });
  assert.equal(leaked.suspected, true);
  assert.equal(leaked.hard.length, 2);
});

test("a reviewer login the fixture's own source names is not a leak", () => {
  const truth = JSON.parse(
    readFileSync(path.join(repoRoot, contract.fixtures[2].truth_file), "utf8"),
  );
  const login = truth.findings[0].author;

  // A stub fixture whose tracked source names the reviewer, exactly as
  // pr-ready-state-core.mjs names coderabbitai[bot] at PR 1990's first head.
  const fixture = mkdtempSync(path.join(tmpdir(), "review-eval-tree-"));
  try {
    const git = (...args) =>
      spawnSync("git", ["-C", fixture, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("config", "user.email", "eval@example.com");
    git("config", "user.name", "eval");
    writeFileSync(
      path.join(fixture, "pr-ready-state-core.mjs"),
      `export const BOT_APPROVER = ${JSON.stringify(login)};\n`,
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "fixture");

    const inTree = loginsInFixtureTree({
      fixturePath: fixture,
      logins: [login, "nobody-not-in-this-tree[bot]"],
    });
    assert.deepEqual([...inTree], [login]);

    const quoting = leakSignals({
      transcript: `line 1 sets BOT_APPROVER to ${login}, which is never read.`,
      truth,
      pr: 1990,
      excludeLogins: [...inTree],
    });
    assert.equal(quoting.suspected, false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("naming a commit withheld from the fixture is a hard leak signal", () => {
  const fixture = contract.fixtures[2];
  const truth = JSON.parse(
    readFileSync(path.join(repoRoot, fixture.truth_file), "utf8"),
  );
  const forbidden = forbiddenShasForFixture({ fixture, repoRoot });
  assert.ok(forbidden.length > 0, "the truth names a withheld fix head");

  const fetched = leakSignals({
    transcript: `I ran git show ${forbidden[0].slice(0, 12)} and read the fix.`,
    truth,
    pr: fixture.pr,
    forbiddenShas: forbidden,
  });
  assert.equal(fetched.suspected, true);
  assert.ok(
    fetched.hard.some((signal) => /withheld commit/.test(signal)),
    fetched.hard.join("; "),
  );

  const clean = leakSignals({
    transcript: "scripts/pr/pr-ready-state-core.mjs:750 grows past the cap.",
    truth,
    pr: fixture.pr,
    forbiddenShas: forbidden,
  });
  assert.equal(clean.suspected, false);
});

test("a cached cell from another skill or contract is never reused", () => {
  const plan = buildPlan({
    contract,
    contractDigest,
    kind: "canary",
    repoRoot,
    write: false,
    env: planEnv,
  });
  const fingerprint = cellFingerprint({ plan });
  assert.deepEqual(Object.keys(fingerprint).sort(), [
    "claude_cli",
    "codex_cli",
    "codex_review_sh_digest",
    "contract_digest",
    "kind",
    "skill_digest",
  ]);

  const decide = (result) =>
    cellReuseDecision({ plan, resultPath: "unused", result });
  assert.equal(decide({ ok: true, fingerprint }).reuse, true);
  assert.match(decide({ ok: true }).reason, /carries no fingerprint/);
  assert.match(
    decide({ ok: true, fingerprint: { ...fingerprint, skill_digest: "0" } })
      .reason,
    /different skill_digest/,
  );
  assert.match(
    decide({ ok: true, fingerprint: { ...fingerprint, kind: "full" } }).reason,
    /different kind/,
  );
  assert.match(
    decide({
      ok: true,
      fingerprint: { ...fingerprint, contract_digest: "0".repeat(64) },
    }).reason,
    /different contract_digest/,
  );
  // A run resumed after a CLI upgrade must re-run its cells: the new row
  // stamps the current versions, so reusing output from the previous binaries
  // would record two runtimes under one provenance.
  for (const field of ["claude_cli", "codex_cli", "codex_review_sh_digest"]) {
    assert.match(
      decide({ ok: true, fingerprint: { ...fingerprint, [field]: "moved" } })
        .reason,
      new RegExp(`different ${field}`),
    );
  }
  assert.match(
    cellReuseDecision({ plan, resultPath: path.join(repoRoot, "no-such-cell") })
      .reason,
    /no cell result/,
  );
});

test("the detail directory separates two skills under one contract", () => {
  const forSkill = (skillDir) =>
    buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot,
      write: false,
      skillRef: skillDir,
      env: planEnv,
    });
  const a = forSkill(path.join(repoRoot, "scripts/review/prompts"));
  const b = forSkill(path.join(repoRoot, "docs/evals/review-skill-truth"));
  assert.notEqual(a.inputs.skill_digest, b.inputs.skill_digest);
  assert.notEqual(a.detail_dir, b.detail_dir);
  assert.equal(a.comparability_key, b.comparability_key);
  assert.match(a.detail_dir, /-canary-[0-9a-f]{8}$/);
});

test("failedRow is schema-valid and never ranks", () => {
  const plan = buildPlan({
    contract,
    contractDigest,
    kind: "canary",
    repoRoot,
    write: false,
    env: planEnv,
  });
  const row = failedRow({
    plan,
    contract,
    contractDigest,
    reason: "claude was unauthenticated",
  });
  assert.deepEqual(validateLedgerRow(row), []);
  assert.equal(row.status, "failed");
  assert.equal(row.verdict, "INCOMPLETE");
  assert.match(row.notes, /unauthenticated/);
});

test("revalidateRow recomputes the numbers and catches a tampered count", () => {
  const row = makeRow({ matchedIds: scorableIdsFor([1990]) });
  assert.deepEqual(revalidateRow({ contract, row, repoRoot }).problems, []);
  row.conditions.pipeline.recall.matched += 3;
  const bad = revalidateRow({ contract, row, repoRoot });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((problem) => problem.includes("recall.matched")));
});

test("revalidateRow recomputes the P1 denominator, not just its numerator", () => {
  // `verdict()` skips the `p1_recall_floor` check on a null rate, because only
  // zero P1 opportunities may produce one. A row that keeps its P1 bits but
  // states it scored no P1 defect therefore hides a floor breach: every P1 bit
  // is a miss and the row still passes as GREEN with the floor never applied.
  const honest = makeRow({ matchedIds: [] });
  const opportunities = honest.conditions.pipeline.p1.opportunities;
  assert.ok(opportunities > 0);
  const laundered = makeRow({ matchedIds: [], verdict: "GREEN" });
  laundered.conditions.pipeline.p1 = {
    matched: 0,
    opportunities: 0,
    rate: null,
  };
  const caught = revalidateRow({ contract, row: laundered, repoRoot });
  assert.equal(caught.ok, false);
  assert.ok(
    caught.problems.some((problem) =>
      problem.startsWith(
        `conditions.pipeline.p1.opportunities is 0; the bits give ${opportunities}`,
      ),
    ),
    JSON.stringify(caught.problems),
  );
  assert.ok(
    caught.problems.some((problem) => /p1\.rate is null/.test(problem)),
    JSON.stringify(caught.problems),
  );
});

test("revalidateRow recomputes the verdict a row states about itself", () => {
  const honest = makeRow({ matchedIds: scorableIdsFor([1990]) });
  const recomputed = revalidateRow({ contract, row: honest, repoRoot });
  assert.deepEqual(recomputed.problems, []);
  assert.equal(recomputed.verdict, honest.verdict);

  const stated = honest.verdict === "GREEN" ? "PROMOTE" : "GREEN";
  const mislabelled = makeRow({
    matchedIds: scorableIdsFor([1990]),
    verdict: stated,
  });
  const caught = revalidateRow({ contract, row: mislabelled, repoRoot });
  assert.equal(caught.ok, false);
  assert.ok(
    caught.problems.some((problem) =>
      problem.startsWith(
        `row.verdict is ${stated}; the row's own numbers give`,
      ),
    ),
    JSON.stringify(caught.problems),
  );
});

test("run-eval.sh inserts finder output into the handoff prompt verbatim", () => {
  // The finder output is model text. `String.prototype.replace` reads $&, $`,
  // $' and $1 in a *string* replacement, so a review containing one of those
  // would rewrite the prompt the treatment under test receives. This runs the
  // shell script's own node program to prove the replacement stays literal.
  const shell = readFileSync(
    path.join(repoRoot, "scripts/review/run-eval.sh"),
    "utf8",
  );
  const program = shell.match(
    /REVIEW_EVAL_OTHER="\$other_review" node -e '\n([\s\S]*?)\n {4}' "\$SPEC/,
  )?.[1];
  assert.ok(program, "the handoff prompt node program was not found");
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-handoff-"));
  try {
    const template = path.join(dir, "handoff.md");
    writeFileSync(template, "before\n{{OTHER_REVIEW}}\nafter\n");
    const other = "finding: the regex $& eats $`this$' and $1 too";
    const result = spawnSync(process.execPath, ["-e", program, template], {
      encoding: "utf8",
      env: { ...process.env, REVIEW_EVAL_OTHER: other },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `before\n${other}\nafter\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--validate refuses a bad row and appends a good one", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    const row = makeRow({ matchedIds: scorableIdsFor([1990, 1999]) });
    row.conditions.pipeline.p1.matched += 1;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const bad = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).appended, false);
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);

    row.conditions.pipeline.p1.matched -= 1;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const good = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).appended, true);
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --detail-dir recomputes from a run outside --root", () => {
  const root = makeRoot();
  const detail = mkdtempSync(path.join(tmpdir(), "review-eval-detail-"));
  try {
    const row = makeRow({ matchedIds: scorableIdsFor([1990]) });
    const rowPath = path.join(root, "row.json");
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    // The orchestrator reads the contract from a spec worktree while the
    // scored cells live in the real checkout, so the row's repo-relative
    // detail_dir does not resolve against --root.
    writeFileSync(
      path.join(detail, "result-1990-pipeline-1.json"),
      JSON.stringify({
        pr: 1990,
        condition: "pipeline",
        draw: 1,
        matched_ids: [],
        claims: ["one"],
        novel: { novelWrong: 0 },
      }),
    );
    const result = cli(
      ["--validate", rowPath, "--detail-dir", detail, "--json"],
      { root },
    );
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.detail_dir, detail);
    assert.ok(
      parsed.problems.some((problem) => /the run detail gives/.test(problem)),
      JSON.stringify(parsed.problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(detail, { recursive: true, force: true });
  }
});

test("--validate reports a malformed row as problems, not a stack trace", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    const row = makeRow({ matchedIds: scorableIdsFor([1990, 1999]) });
    // A hand-edited or truncated row file reaches `--validate` unvalidated.
    // Dropping the counts the recompute reads must name the gap, not throw.
    delete row.conditions.pipeline.recall;
    delete row.conditions.pipeline.p1;
    row.conditions.control = null;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--json"], { root });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /Cannot read properties/);
    const problems = JSON.parse(result.stdout).problems;
    assert.ok(
      problems.some((problem) =>
        /conditions\.pipeline is missing recall or p1/.test(problem),
      ),
      JSON.stringify(problems),
    );
    assert.ok(
      problems.some((problem) =>
        /conditions\.control is not an object/.test(problem),
      ),
      JSON.stringify(problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --append refuses a row that overstates its own verdict", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    const row = makeRow({
      matchedIds: scorableIdsFor([1990, 1999]),
      verdict: "PROMOTE",
    });
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--append", "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.appended, false);
    assert.notEqual(output.recomputed_verdict, "PROMOTE");
    assert.ok(
      output.problems.some((problem) => problem.includes("row.verdict")),
      JSON.stringify(output.problems),
    );
    assert.equal(readLedger(path.join(root, ledgerRelative)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--validate --against rechecks the verdict on the named baseline", () => {
  const root = makeRoot();
  try {
    const baselineRow = makeRow({
      executedAt: "2026-08-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990, 1999]),
    });
    const baselinePath = path.join(root, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(baselineRow, null, 2));
    const row = makeRow({
      executedAt: "2026-12-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990, 1999]),
    });
    row.verdict = verdict({ contract, row, baselineRow }).verdict;
    const rowPath = path.join(root, "row.json");
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(
      ["--validate", rowPath, "--against", baselinePath, "--append", "--json"],
      { root },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.appended, true);
    assert.equal(output.recomputed_verdict, row.verdict);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--report renders the newest row and pairs it with its baseline", () => {
  const root = makeRoot();
  try {
    const baseline = makeRow({
      executedAt: "2026-09-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990, 1999]),
    });
    const candidate = makeRow({
      executedAt: "2026-12-08T10:00:00Z",
      matchedIds: scorableIdsFor([1990]),
    });
    writeFileSync(
      path.join(root, ledgerRelative),
      `${JSON.stringify(baseline)}\n${JSON.stringify(candidate)}\n`,
    );
    const markdown = cli(["--report"], { root });
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /Review-skill eval — 2026-12-08 \(full\)/);
    assert.match(markdown.stdout, /McNemar vs 2026-09-08/);

    const json = cli(["--report", "--json"], { root });
    assert.equal(json.status, 0, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.baseline_executed_at, baseline.executed_at);
    assert.ok(["RED", "AMBER", "GREEN", "PROMOTE"].includes(output.verdict));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveBaseline ignores incomparable, incomplete, and later rows", () => {
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  const rows = [
    makeRow({ executedAt: "2026-09-08T10:00:00Z", status: "partial" }),
    makeRow({ executedAt: "2026-10-08T10:00:00Z", key: "c".repeat(64) }),
    makeRow({ executedAt: "2026-11-08T10:00:00Z", kind: "canary" }),
    makeRow({ executedAt: "2027-01-08T10:00:00Z" }),
  ];
  assert.equal(resolveBaseline({ rows, row }), null);
  const usable = makeRow({ executedAt: "2026-11-30T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [...rows, usable], row }).executed_at,
    usable.executed_at,
  );
});

test("resolveBaseline anchors on the first full row until a PROMOTE re-anchors", () => {
  const anchor = makeRow({ executedAt: "2026-09-08T10:00:00Z" });
  const later = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  // Pairing against the previous run would hide a slide that never trips the
  // per-run flip threshold, so the anchor is the baseline of record.
  assert.equal(
    resolveBaseline({ rows: [anchor, later], row }).executed_at,
    anchor.executed_at,
  );
  // The runbook moves the anchor in exactly one place: a reviewed PROMOTE row.
  const promoted = makeRow({
    executedAt: "2026-11-08T10:00:00Z",
    verdict: "PROMOTE",
  });
  const older = makeRow({
    executedAt: "2026-10-20T10:00:00Z",
    verdict: "PROMOTE",
  });
  assert.equal(
    resolveBaseline({ rows: [anchor, older, later, promoted], row })
      .executed_at,
    promoted.executed_at,
  );
});

test("resolveBaseline refuses a row whose judge calibration failed", () => {
  // The runbook excludes an under-calibrated row from baseline comparison, and
  // an anchor is the comparison every later run is paired against: bits a
  // judge that failed its own replay produced must not become the record.
  const drifted = {
    ...makeRow({ executedAt: "2026-09-08T10:00:00Z" }),
    judge_calibration: { agreement: 37, total: 40 },
  };
  const row = makeRow({ executedAt: "2026-12-08T10:00:00Z" });
  assert.equal(resolveBaseline({ rows: [drifted], row }), null);

  const clean = makeRow({ executedAt: "2026-10-08T10:00:00Z" });
  assert.equal(
    resolveBaseline({ rows: [drifted, clean], row }).executed_at,
    clean.executed_at,
  );
  // Nor may it re-anchor as a PROMOTE row.
  const promoted = {
    ...makeRow({ executedAt: "2026-11-08T10:00:00Z", verdict: "PROMOTE" }),
    judge_calibration: { agreement: 30, total: 40 },
  };
  assert.equal(
    resolveBaseline({ rows: [drifted, clean, promoted], row }).executed_at,
    clean.executed_at,
  );
});

test("--validate reports a malformed per_defect vector instead of throwing", () => {
  const root = makeRoot();
  try {
    const rowPath = path.join(root, "row.json");
    const row = makeRow({ matchedIds: scorableIdsFor([1990]) });
    const [first] = Object.keys(row.conditions.pipeline.per_defect);
    // A scalar where a bit vector belongs: `--validate` reads a row file it did
    // not write, so this is a problem to report, not a `.join is not a
    // function` stack trace in place of the problem list.
    row.conditions.pipeline.per_defect[first] = 1;
    writeFileSync(rowPath, JSON.stringify(row, null, 2));
    const result = cli(["--validate", rowPath, "--json"], { root });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(
      output.problems.some((problem) =>
        /per_defect must map each defect to a non-empty array/.test(problem),
      ),
      output.problems.join(" | "),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--score refuses a calibration set the plan never hashed", () => {
  const root = makeRoot();
  try {
    const planDir = path.join(root, "plan");
    mkdirSync(planDir, { recursive: true });
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: planDir,
      env: planEnv,
    });
    assert.match(plan.calibration_digest, /^[0-9a-f]{64}$/);
    const other = path.join(root, "other-calibration.json");
    writeFileSync(
      other,
      `${readFileSync(path.join(root, "docs/evals/review-skill-judge-calibration.json"), "utf8")} `,
    );
    const result = cli(
      ["--score", planDir, "--calibration", "other-calibration.json"],
      { root },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /plan was written against calibration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--schedule-issue stays silent while the ledger is fresh", () => {
  const root = makeRoot();
  try {
    const row = makeRow({ executedAt: "2027-05-30T10:00:00Z" });
    writeFileSync(path.join(root, ledgerRelative), `${JSON.stringify(row)}\n`);
    const result = cli(
      ["--schedule-issue", "--json", "--dry-run", "--date", "2027-06-01"],
      { root },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).action, "skip-fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runScheduleIssue creates one issue per contract month and then keeps it", async () => {
  const root = makeRoot();
  try {
    const options = {
      ledgerPath: ledgerRelative,
      repo: "mento-protocol/monitoring-monorepo",
      date: "2027-06-01",
      dryRun: false,
    };
    const context = { repoRoot: root, contract, contractDigest };
    const created = [];
    const deps = {
      listIssues: async () => [],
      authorize: async () => {},
      ensureLabels: async () => {},
      createIssue: async (_options, payload) => created.push(payload),
    };
    const first = await runScheduleIssue(options, context, deps);
    assert.equal(first.action, "create");
    assert.equal(first.mutated, true);
    assert.equal(created.length, 1);
    assert.match(created[0].title, /Review-skill eval is stale/);

    const open = [
      {
        number: 42,
        state: "OPEN",
        marker: { month: "2027-06", contract_digest: contractDigest },
      },
    ];
    const second = await runScheduleIssue(options, context, {
      ...deps,
      listIssues: async () => open,
    });
    assert.equal(second.action, "keep-current");
    assert.equal(second.mutated, false);
    assert.equal(created.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planStalenessIssueSync skips a completed month and a foreign digest", () => {
  const payload = { title: "t", body: "b", labels: [] };
  const closed = planStalenessIssueSync({
    month: "2027-06",
    contractDigest,
    issues: [
      {
        number: 7,
        state: "CLOSED",
        marker: { month: "2027-06", contract_digest: contractDigest },
      },
    ],
    payload,
  });
  assert.equal(closed.action, "skip-complete");
  const drifted = planStalenessIssueSync({
    month: "2027-06",
    contractDigest,
    issues: [
      {
        number: 8,
        state: "OPEN",
        marker: { month: "2027-06", contract_digest: "e".repeat(64) },
      },
    ],
    payload,
  });
  assert.equal(drifted.action, "skip-prior-open");
});

test("live issue creation is restricted to the freshness workflow", () => {
  const options = { repo: "mento-protocol/monitoring-monorepo" };
  assert.throws(
    () => assertAuthorizedFreshnessWorkflow(options, { env: {} }),
    /restricted to the review-eval freshness workflow/,
  );
  assert.throws(
    () =>
      assertAuthorizedFreshnessWorkflow(options, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/heads/main",
          GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/main`,
        },
      }),
    /restricted/,
  );
  // A dispatch can name any branch, so it never authorizes an issue write.
  assert.throws(
    () =>
      assertAuthorizedFreshnessWorkflow(options, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/main",
          GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/main`,
        },
      }),
    /restricted/,
  );
  // The ref is pinned to the default branch, not to whatever the run reports.
  assert.throws(
    () =>
      assertAuthorizedFreshnessWorkflow(options, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "schedule",
          GITHUB_REF: "refs/heads/attacker",
          GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/attacker`,
        },
      }),
    /restricted/,
  );
  assert.doesNotThrow(() =>
    assertAuthorizedFreshnessWorkflow(options, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_REF: "refs/heads/main",
        GITHUB_WORKFLOW_REF: `${options.repo}/.github/workflows/review-eval-freshness.yml@refs/heads/main`,
      },
    }),
  );
});

/** A git stand-in: one handler per subcommand, everything else fails. */
function fakeGit(handlers) {
  const calls = [];
  const run = (binary, args) => {
    calls.push(args.join(" "));
    const handler = handlers[args[0]];
    return handler ? handler(args) : { status: 128, stdout: "", stderr: "" };
  };
  run.calls = calls;
  return run;
}

const OK = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const FAILED = { status: 128, stdout: "", stderr: "fatal" };

test("baseLedgerRows separates an unresolvable ref from an absent ledger", () => {
  const args = {
    repoRoot: "/tmp/repo",
    baseRef: "origin/main",
    ledgerPath: ledgerRelative,
  };
  const unresolvable = baseLedgerRows({
    ...args,
    run: fakeGit({ "rev-parse": () => FAILED }),
  });
  assert.equal(unresolvable.rows, null);
  assert.equal(unresolvable.resolved, false);
  assert.match(unresolvable.reason, /does not resolve/);

  // The ref resolves and the ledger is simply not committed there yet: a
  // bootstrap branch, not a failure.
  const bootstrap = baseLedgerRows({
    ...args,
    run: fakeGit({
      "rev-parse": () => OK("commit\n"),
      "merge-base": () => OK("aaaa111\n"),
      show: () => FAILED,
    }),
  });
  assert.equal(bootstrap.rows, null);
  assert.equal(bootstrap.resolved, true);
  assert.match(bootstrap.reason, /does not exist at aaaa111/);
});

test("baseLedgerRows reads the merge base, and falls back to the tip", () => {
  const row = makeRow();
  const args = {
    repoRoot: "/tmp/repo",
    baseRef: "origin/main",
    ledgerPath: ledgerRelative,
  };
  const merged = fakeGit({
    "rev-parse": () => OK("commit\n"),
    "merge-base": () => OK("aaaa111\n"),
    show: () => OK(`${JSON.stringify(row)}\n`),
  });
  const fromMergeBase = baseLedgerRows({ ...args, run: merged });
  assert.equal(fromMergeBase.mode, "merge-base");
  assert.equal(fromMergeBase.base, "aaaa111");
  assert.equal(fromMergeBase.rows.length, 1);
  assert.ok(merged.calls.includes(`show aaaa111:${ledgerRelative}`));

  const detached = fakeGit({
    "rev-parse": () => OK("commit\n"),
    "merge-base": () => FAILED,
    show: () => OK(`${JSON.stringify(row)}\n`),
  });
  const fromTip = baseLedgerRows({ ...args, run: detached });
  assert.equal(fromTip.mode, "tip");
  assert.equal(fromTip.base, "origin/main");
  assert.ok(detached.calls.includes(`show origin/main:${ledgerRelative}`));
});

test("--check-ledger --require-base fails when the base ref does not resolve", () => {
  const root = makeRoot();
  try {
    const flags = ["--base-ref", "refs/heads/no-such-base", "--json"];
    const lenient = cli(["--check-ledger", ...flags], { root });
    assert.equal(lenient.status, 0, lenient.stderr);
    const skipped = JSON.parse(lenient.stdout);
    assert.equal(skipped.ok, true);
    assert.equal(skipped.append_only_base, null);
    assert.match(skipped.append_only_reason, /does not resolve/);

    const strict = cli(["--check-ledger", "--require-base", ...flags], {
      root,
    });
    assert.equal(strict.status, 1);
    const failed = JSON.parse(strict.stdout);
    assert.equal(failed.ok, false);
    assert.ok(
      failed.problems.some((problem) => /does not resolve/.test(problem)),
      JSON.stringify(failed.problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A judge stand-in. It never leaves the process and never calls a model. */
function stubExec({ matchAll = true } = {}) {
  const calls = [];
  return {
    calls,
    exec: async ({ prompt }) => {
      calls.push(prompt);
      if (prompt.startsWith("Below is a code review.")) {
        return JSON.stringify(["claim one", "claim two"]);
      }
      if (prompt.startsWith("You are matching a code review")) {
        const indexes = [...prompt.matchAll(/^\s*(\d+)\.\s/gm)].map((match) =>
          Number(match[1]),
        );
        return JSON.stringify({
          matches: matchAll ? indexes : [],
          reasoning: Object.fromEntries(
            indexes.map((index) => [String(index), "same defect"]),
          ),
        });
      }
      return JSON.stringify({
        verdicts: { 1: { class: "real" }, 2: { class: "wrong" } },
      });
    },
  };
}

/**
 * A git stand-in for the scoring path. On an operator machine the fixture a
 * cell names is a real checkout that scoring resets before the judge reads it;
 * here it is a temporary directory, so git answers from this instead.
 */
function stubGit({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    runGit: ({ args, cwd }) => {
      calls.push({ args, cwd });
      const status = args[0] === failOn ? 128 : args[0] === "grep" ? 1 : 0;
      return { status, stdout: "", stderr: "" };
    },
  };
}

test("scorePlan folds stubbed cells into a schema-valid ledger row", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          output: `scripts/pr/pr-ready-state-core.mjs:750 is too long.`,
          seconds: 300,
          cost_usd: 3.5,
          fixture_path: root,
        }),
      );
    }
    const { exec } = stubExec();
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    assert.deepEqual(validateLedgerRow(scored.row), []);
    assert.equal(scored.row.kind, "canary");
    assert.equal(scored.row.status, "complete");
    assert.deepEqual(scored.missing, []);
    assert.equal(Object.keys(scored.row.conditions).length, 1);
    const replay = scored.row.conditions.replay;
    assert.equal(replay.draws, 1);
    assert.equal(replay.recall.opportunities, 22);
    assert.equal(replay.usd, 10.5);
    assert.equal(replay.novel_real, 3);
    assert.equal(replay.wrong_claims, 3);
    assert.equal(
      readLedger(path.join(root, ledgerRelative)).length,
      0,
      "scoring never writes the ledger",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a PR that ran fewer draws loses opportunities, not recall", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "full",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const both = contract.fixtures[0];
    const single = contract.fixtures[1];
    const firstScorable = (fixture) => {
      const truth = JSON.parse(
        readFileSync(path.join(root, fixture.truth_file), "utf8"),
      );
      return truth.findings.find((finding) =>
        fixture.scorable_ids.includes(finding.id),
      );
    };
    const hit = {
      [both.pr]: firstScorable(both),
      [single.pr]: firstScorable(single),
    };
    // PR `both` runs draws 1 and 2; PR `single` runs draw 1 only. Every other
    // cell of the matrix is missing, exactly as a deadline or an abort leaves it.
    const ran = plan.cells.filter(
      (cell) =>
        cell.condition === "pipeline" &&
        (cell.pr === both.pr || (cell.pr === single.pr && cell.draw === 1)),
    );
    assert.equal(ran.length, 3);
    for (const cell of ran) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      const finding = hit[cell.pr];
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          output: `${finding.path}:${finding.line} is wrong.`,
          seconds: 300,
          cost_usd: 3.5,
          fixture_path: root,
        }),
      );
    }
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec: stubExec().exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    const pipeline = scored.row.conditions.pipeline;
    assert.equal(pipeline.draws, 2);
    for (const id of both.scorable_ids) {
      assert.equal(pipeline.per_defect[String(id)].length, 2, `defect ${id}`);
    }
    for (const id of single.scorable_ids) {
      assert.equal(pipeline.per_defect[String(id)].length, 1, `defect ${id}`);
    }
    // The defect PR `single` did find is a 1 and nothing else: the draw it
    // never ran contributes no bit, so no false zero follows it.
    assert.deepEqual(pipeline.per_defect[String(hit[single.pr].id)], [1]);
    assert.equal(
      pipeline.recall.opportunities,
      both.scorable_ids.length * 2 + single.scorable_ids.length,
    );
    assert.deepEqual(validateLedgerRow(scored.row), []);
    // The ledger's own recompute reads the per-cell detail and must fold it the
    // same way, or `--validate --append` would refuse every partial run.
    const revalidated = revalidateRow({
      contract,
      row: scored.row,
      repoRoot: root,
      detailDir: plan.plan_dir,
    });
    assert.deepEqual(revalidated.problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan stores no McNemar against an incomparable baseline", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({
          ok: true,
          output: "scripts/pr/pr-ready-state-core.mjs:750 is too long.",
          seconds: 300,
          cost_usd: 3.5,
          fixture_path: root,
        }),
      );
    }
    const calibrationSet = JSON.parse(
      readFileSync(
        path.join(root, "docs/evals/review-skill-judge-calibration.json"),
        "utf8",
      ),
    );
    const score = (baselineRow) =>
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec: stubExec().exec,
        runGit: stubGit().runGit,
        calibrationSet,
        baselineRow,
      });

    // `--against` may name any row, including one that measures something
    // else. That pair is recorded, never counted.
    const foreign = await score(makeRow({ key: "c".repeat(64) }));
    assert.deepEqual(validateLedgerRow(foreign.row), []);
    assert.equal(foreign.row.vs_baseline.mcnemar, null);
    assert.equal(
      foreign.row.vs_baseline.baseline_comparability_key,
      "c".repeat(64),
    );

    const paired = await score(makeRow());
    assert.equal(typeof paired.row.vs_baseline.mcnemar.delta, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scorePlan reports a partial matrix and refuses an empty one", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const { exec } = stubExec({ matchAll: false });
    const calibrationSet = JSON.parse(
      readFileSync(
        path.join(root, "docs/evals/review-skill-judge-calibration.json"),
        "utf8",
      ),
    );
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec,
        runGit: stubGit().runGit,
        calibrationSet,
      }),
      /no completed cell results/,
    );

    const cell = plan.cells[0];
    const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({
        ok: true,
        output: "nothing looks wrong here",
        seconds: 10,
        cost_usd: 0.5,
        fixture_path: root,
      }),
    );
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: stubGit().runGit,
      calibrationSet,
    });
    assert.equal(scored.row.status, "partial");
    assert.equal(scored.missing.length, 2);
    assert.match(scored.row.notes, /2 cell\(s\) missing/);
    // A canary that did not finish never ranks, not even as a pass.
    assert.equal(scored.row.verdict, "INCOMPLETE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write one stubbed cell result under a plan directory. */
function writeCell(plan, cell, { output, root, usd = 3.5 }) {
  const dir = path.join(plan.plan_dir, "cells", cell.cell_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({
      ok: true,
      output,
      seconds: 300,
      cost_usd: usd,
      fixture_path: root,
    }),
  );
}

test("a PR is zero-finding only when every draw it ran found nothing", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "full",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    const [quiet, mixed] = contract.fixtures.map((fixture) => fixture.pr);
    const cells = plan.cells.filter(
      (cell) =>
        cell.condition === "pipeline" && [quiet, mixed].includes(cell.pr),
    );
    assert.equal(cells.length, 4);
    for (const cell of cells) {
      // `mixed` finds nothing on draw 1 and reviews on draw 2; `quiet` finds
      // nothing on either draw. Only `quiet` found nothing on its PR.
      const empty = cell.pr === quiet || cell.draw === 1;
      writeCell(plan, cell, {
        root,
        output: empty ? "" : "scripts/review/run-eval.sh:150 is wrong.",
      });
    }
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec: stubExec().exec,
      runGit: stubGit().runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    const pipeline = scored.row.conditions.pipeline;
    assert.equal(pipeline.zero_finding_prs, 1);
    assert.deepEqual(validateLedgerRow(scored.row), []);
    // Two zero-finding PRs are RED, so counting one empty draw per PR would
    // red a run on the strength of a PR it did review.
    assert.ok(
      !scored.reasons.some((reason) =>
        /emitted no parseable finding on 2 PRs/.test(reason),
      ),
      JSON.stringify(scored.reasons),
    );

    // `--validate` derives both RED-capable counters from the run detail, so
    // an edited counter cannot ride along on the row's own say-so.
    const honest = revalidateRow({
      contract,
      row: scored.row,
      repoRoot: root,
      detailDir: plan.plan_dir,
    });
    assert.deepEqual(honest.problems, []);
    const tampered = structuredClone(scored.row);
    tampered.conditions.pipeline.wrong_claims += 5;
    tampered.conditions.pipeline.zero_finding_prs = 0;
    const caught = revalidateRow({
      contract,
      row: tampered,
      repoRoot: root,
      detailDir: plan.plan_dir,
    });
    assert.equal(caught.ok, false);
    assert.ok(
      caught.problems.some((problem) => problem.includes("wrong_claims is")),
      JSON.stringify(caught.problems),
    );
    assert.ok(
      caught.problems.some((problem) =>
        problem.includes("zero_finding_prs is 0"),
      ),
      JSON.stringify(caught.problems),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoring resets each fixture, uses the contract judge, and totals its cost", async () => {
  const root = makeRoot();
  try {
    const plan = buildPlan({
      contract,
      contractDigest,
      kind: "canary",
      repoRoot: root,
      outDir: path.join(root, "run"),
      env: planEnv,
    });
    for (const cell of plan.cells) {
      writeCell(plan, cell, {
        root,
        output: "scripts/review/run-eval.sh:150 is wrong.",
      });
    }
    // Every judge reply arrives in a CLI envelope carrying its own cost.
    const models = new Set();
    const inner = stubExec().exec;
    let judgeCalls = 0;
    const exec = async (request) => {
      models.add(request.model);
      judgeCalls += 1;
      return JSON.stringify({
        result: await inner(request),
        total_cost_usd: 0.25,
      });
    };
    const git = stubGit();
    const scored = await scorePlan({
      plan,
      contract,
      contractDigest,
      repoRoot: root,
      planDir: plan.plan_dir,
      exec,
      runGit: git.runGit,
      calibrationSet: JSON.parse(
        readFileSync(
          path.join(root, "docs/evals/review-skill-judge-calibration.json"),
          "utf8",
        ),
      ),
    });
    // The judge the comparability key records is the judge that ran.
    assert.deepEqual([...models], [contract.judge.model]);
    // The forty calibration replays and every judge call the cells needed.
    assert.ok(judgeCalls >= 40 + plan.cells.length);
    assert.equal(
      scored.row.scoring_usd,
      Number((judgeCalls * 0.25).toFixed(2)),
    );
    assert.deepEqual(validateLedgerRow(scored.row), []);
    // The last cell left the fixture dirty, so every scoring pass resets it
    // before the novel judge reads the tree with Bash.
    const resets = git.calls.filter((call) => call.args[0] === "reset");
    const cleans = git.calls.filter((call) => call.args[0] === "clean");
    assert.equal(resets.length, plan.cells.length);
    assert.equal(cleans.length, plan.cells.length);
    assert.ok(resets.every((call) => call.cwd === root));

    // A fixture that cannot be reset is a scoring failure, never a number.
    await assert.rejects(
      scorePlan({
        plan,
        contract,
        contractDigest,
        repoRoot: root,
        planDir: plan.plan_dir,
        exec,
        runGit: stubGit({ failOn: "reset" }).runGit,
        calibrationSet: JSON.parse(
          readFileSync(
            path.join(root, "docs/evals/review-skill-judge-calibration.json"),
            "utf8",
          ),
        ),
      }),
      /could not be reset before scoring/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scoring subprocess inherits no GitHub credential", () => {
  const scrubbed = scrubbedEnv({
    env: {
      PATH: "/usr/bin",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GITHUB_PERSONAL_ACCESS_TOKEN: "secret",
      GH_ENTERPRISE_TOKEN: "secret",
      ANTHROPIC_API_KEY: "kept",
    },
    ghConfigDir: "/tmp/empty-gh",
  });
  for (const name of SCRUBBED_ENV_VARS) {
    assert.equal(scrubbed[name], undefined, name);
  }
  // The model API must stay reachable; only the credentials go.
  assert.equal(scrubbed.ANTHROPIC_API_KEY, "kept");
  assert.equal(scrubbed.PATH, "/usr/bin");
  assert.equal(scrubbed.GH_CONFIG_DIR, "/tmp/empty-gh");
  assert.equal(scrubbed.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(scrubbed.GIT_CONFIG_VALUE_0, "");
  assert.equal(scrubbed.GIT_ALLOW_PROTOCOL, "file");
  assert.equal(scrubbed.GIT_TERMINAL_PROMPT, "0");
});

test("the orchestrator keeps its resume cache outside the spec worktree", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/review/run-eval.sh"),
    "utf8",
  );
  // The spec worktree is a temporary directory the EXIT trap removes, so a
  // plan directory inside it takes every completed cell down with it.
  assert.match(script, /RUN_DIR="\$REPO\/\$DETAIL_DIR"/);
  assert.match(script, /--out "\$RUN_DIR"/);
});

test("the orchestrator rejects a cell whose finder or report failed", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/review/run-eval.sh"),
    "utf8",
  );
  // A finder that writes a partial report and then exits non-zero — a session
  // limit, a killed process — produces output that is not empty and is not a
  // review. Cached, it would score forever as a finder that missed those
  // defects, so the cell fails on the finder's own status.
  assert.match(script, /\|\| finder_status=\$\?/);
  assert.match(script, /if \[\[ \$finder_status -ne 0 \]\]; then/);
  assert.doesNotMatch(
    script,
    /"\$\{FINDER_ARGV\[@\]\}" 2>\/dev\/null \| tail -c 30000\)" \|\| true/,
  );
  // The replay condition's whole treatment is the frozen report; an empty one
  // would hand the model an empty handoff and score that as a review.
  assert.match(script, /frozen finder report \$finder_report is unreadable/);
});

test("the orchestrator snapshots the skill once and refuses a mid-run edit", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/review/run-eval.sh"),
    "utf8",
  );
  // The plan records one skill digest for the whole matrix and every cached
  // cell's fingerprint carries it, so cells must all stage the same bytes.
  assert.match(script, /SKILL_DIR="\$SKILL_SNAPSHOT"/);
  assert.match(script, /cp -R "\$SKILL_DIR" "\$fixture\/\.skill"/);
  assert.match(
    script,
    /\[\[ \$SNAPSHOT_SKILL_DIGEST == "\$PLANNED_SKILL_DIGEST" \]\]/,
  );
  assert.match(script, /rm -rf "\$SKILL_SNAPSHOT"/);
});

test("a failed run that cannot record its failure exits non-zero", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/review/run-eval.sh"),
    "utf8",
  );
  // `abort` exits zero so launchd does not double-report a failure the ledger
  // already carries. That trade only holds while the row was really appended:
  // a run that leaves no trace is indistinguishable from one that never ran,
  // and the freshness guard cannot tell those apart either.
  assert.match(
    script,
    /write_failed_row "\$1" \|\|\n {4}fail "the run failed and the failure row could not be appended: \$1"/,
  );
});

test("the cell reader emits nothing when the plan carries a forged field", () => {
  // The loop that spends money reads this program through a process
  // substitution and cannot see the writer die. Emitting rows as it goes would
  // run every cell before the offending one and then score that truncated
  // matrix as merely partial, which is what the tab check exists to prevent.
  const shell = readFileSync(
    path.join(repoRoot, "scripts/review/run-eval.sh"),
    "utf8",
  );
  const program = shell.match(
    /cell_rows\(\) \{\n[\s\S]*?node -e '\n([\s\S]*?)\n {2}' "\$PLAN_JSON"/,
  )?.[1];
  assert.ok(program, "the cell row node program was not found");
  const dir = mkdtempSync(path.join(tmpdir(), "review-eval-cellrows-"));
  try {
    const planPath = path.join(dir, "plan.json");
    const cell = (cellId, extra = {}) => ({
      cell_id: cellId,
      pr: 1982,
      condition: "pipeline",
      draw: 1,
      model: "claude-opus-5",
      effort: "high",
      finder: "gpt-5.6-sol@high",
      prompt: "handoff",
      ...extra,
    });
    writeFileSync(
      planPath,
      JSON.stringify({ cells: [cell("first"), cell("second")] }),
    );
    const good = spawnSync(process.execPath, ["-e", program, planPath], {
      encoding: "utf8",
    });
    assert.equal(good.status, 0);
    assert.equal(good.stdout.split("\n").filter(Boolean).length, 2);

    writeFileSync(
      planPath,
      JSON.stringify({
        cells: [cell("first"), cell("second", { model: "opus\thandoff" })],
      }),
    );
    const forged = spawnSync(process.execPath, ["-e", program, planPath], {
      encoding: "utf8",
    });
    assert.notEqual(forged.status, 0);
    assert.equal(forged.stdout, "");
    assert.match(forged.stderr, /carries a tab or a newline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the freshness workflow watches the frozen input directories", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/review-eval-freshness.yml"),
    "utf8",
  );
  // `*` stops at a path separator in a GitHub path filter, so the recursive
  // form is what reaches docs/evals/review-skill-truth/ and its siblings.
  assert.match(workflow, /- docs\/evals\/review-skill\*\*/);
  assert.doesNotMatch(workflow, /- docs\/evals\/review-skill\*$/m);
  // Every step of the job runs a `review:eval*` alias, so a PR that renames or
  // removes one has to run this workflow.
  assert.match(workflow, /^ {6}- package\.json$/m);
  const aliases = [
    ...new Set(
      [...workflow.matchAll(/pnpm (review:eval[\w:]*)/g)].map((m) => m[1]),
    ),
  ];
  const scripts = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).scripts;
  for (const alias of aliases) {
    assert.ok(scripts[alias], `package.json has no ${alias} script`);
  }
});

test("a scheduled run refuses a checkout that is not at origin/main", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/review/run-eval.sh"),
    "utf8",
  );
  // The spec worktree pins the contract, but the ledger, the baseline it
  // resolves and the PR commands come from the checkout launchd fires in. A
  // feature branch there would score against the wrong anchor and offer to
  // commit the row on top of unrelated work.
  assert.match(script, /rev-parse origin\/main/);
  assert.match(script, /not origin\/main/);
  assert.match(script, /has uncommitted changes/);
});

test("the launchd template carries placeholders the runbook install step rewrites", () => {
  const plist = readFileSync(
    path.join(repoRoot, "scripts/review/launchd/org.mento.review-eval.plist"),
    "utf8",
  );
  const runbook = readFileSync(
    path.join(repoRoot, "docs/evals/review-skill.md"),
    "utf8",
  );
  // The managed-context rule: no author-account path may survive in either file.
  assert.doesNotMatch(plist, /\/Users\//);
  assert.doesNotMatch(runbook, /\/Users\//);
  const tokens = [
    ...new Set([...plist.matchAll(/__[A-Z_]+__/g)].map((match) => match[0])),
  ].sort();
  assert.deepEqual(tokens, ["__REPO_CHECKOUT__", "__USER_HOME__"]);
  for (const token of tokens) {
    assert.ok(
      runbook.includes(`s|${token}|`),
      `${token} is not rewritten by the documented install step`,
    );
  }
});

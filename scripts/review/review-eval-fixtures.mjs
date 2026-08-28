import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REVIEW_EVAL_SCHEMA_VERSION = 1;
export const REVIEW_EVAL_SUITE_ID = "review-skill-v1";
export const DEFAULT_CONTRACT_PATH = "docs/evals/review-skill-fixtures.json";
export const BUILD_FIXTURE_SCRIPT = fileURLToPath(
  new URL("./build-fixture.sh", import.meta.url),
);
export const HANDOFF_PLACEHOLDER = "{{OTHER_REVIEW}}";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const FINDER_ARGV_ELEMENT = /^[A-Za-z0-9._="@/:-]+$/;
const REQUIRED_VERDICT_RULES = [
  "noise_floor_defects",
  "regression_net_flips",
  "p1_recall_floor",
  "wrong_claims_ratio_ceiling",
  "canary_min_matched_grid",
];
const REQUIRED_CADENCE_DAYS = [
  "canary",
  "full",
  "freshness_warn",
  "freshness_red",
  "complete_red",
  "full_red",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBytes(repoRoot, relativePath) {
  return readFileSync(path.resolve(repoRoot, relativePath));
}

// Symlink hops one path may take before it is treated as a loop.
const MAX_LINK_HOPS = 40;

/**
 * The path with every symlink resolved, including a path that does not exist
 * yet: each component is canonicalized against its resolved parent, and a
 * dangling link is followed by hand.
 *
 * `path.resolve` is lexical, so it reports `~/.cache/eval` as outside the
 * checkout even when `~/.cache` is a symlink into it. That is the whole
 * isolation boundary between a contestant cell and the frozen truth, so it is
 * decided on canonical paths. A link that points at a directory nobody has
 * created yet counts: `mkdir -p` follows it, so the fixture would still land
 * where the link points.
 */
export function canonicalPath(target, hops = 0) {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    // Some component does not exist yet; resolve what does, below.
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  const child = path.join(canonicalPath(parent, hops), path.basename(resolved));
  // A cycle of dangling links resolves to itself rather than to a stack
  // overflow. The comparison then falls back to the last name reached.
  if (hops >= MAX_LINK_HOPS) return child;
  let link;
  try {
    link = readlinkSync(child);
  } catch {
    return child;
  }
  return canonicalPath(path.resolve(path.dirname(child), link), hops + 1);
}

export function defaultRunGit({ args, cwd = process.cwd() }) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export function defaultExec({ file, args, cwd = process.cwd() }) {
  const result = spawnSync("bash", [file, ...args], { cwd, encoding: "utf8" });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/**
 * The digest covers the committed bytes, not a re-serialization, so
 * reformatting the contract changes comparability exactly as a content edit
 * does. Every ledger row records it; reports refuse to compare across it.
 */
export function loadContract(contractPath) {
  const resolved = path.resolve(contractPath);
  const bytes = readFileSync(resolved);
  let contract;
  try {
    contract = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `contract ${contractPath} is not valid JSON: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  return { contract, digest: sha256(bytes), path: resolved };
}

export function fixtureForPr(contract, pr) {
  const wanted = Number(pr);
  const fixture = (contract?.fixtures || []).find(
    (candidate) => candidate.pr === wanted,
  );
  if (!fixture) throw new Error(`contract has no fixture for PR ${pr}`);
  return fixture;
}

export function gridFixtures(contract) {
  return (contract?.fixtures || []).filter((fixture) => fixture.grid === true);
}

// Draws the pipeline condition takes per PR. The finder samples, so one draw
// carries no variance signal; `planCells` spawns exactly this many.
export const PIPELINE_DRAWS = 2;

/**
 * The cells a run of one kind plans, as condition -> [{ pr, draws }].
 *
 * `planCells` in `review-eval-run.mjs` builds exactly this matrix with the
 * model, effort and report file each cell needs. This is the same shape without
 * any of that, so the ledger validator can ask what a complete run owed without
 * importing the planner — `review-eval-ledger.test.mjs` cross-checks the two
 * against each other so they cannot drift apart silently.
 */
export function plannedMatrix(contract, kind) {
  const fixtures = contract?.fixtures ?? [];
  const grid = gridFixtures(contract);
  const replay = grid.map((fixture) => ({
    pr: fixture.pr,
    draws: kind === "canary" ? 1 : (fixture.finder_reports ?? []).length,
  }));
  if (kind === "canary") return new Map([["replay", replay]]);
  return new Map([
    [
      "pipeline",
      fixtures.map((fixture) => ({ pr: fixture.pr, draws: PIPELINE_DRAWS })),
    ],
    ["replay", replay],
    ["control", fixtures.map((fixture) => ({ pr: fixture.pr, draws: 1 }))],
  ]);
}

export function scorableTotals(contract) {
  const fixtures = contract?.fixtures || [];
  return {
    prs: fixtures.length,
    scorable: fixtures.reduce(
      (sum, fixture) => sum + (fixture.scorable_ids || []).length,
      0,
    ),
    p1: fixtures.reduce(
      (sum, fixture) => sum + (fixture.p1_ids || []).length,
      0,
    ),
  };
}

/**
 * Commits that must not survive in a materialized fixture. The contract pins
 * the first head and the base; the frozen truth names the last head, which is
 * the commit that carries the fixes and is therefore the answer key.
 */
export function forbiddenShasForFixture({
  fixture,
  repoRoot = process.cwd(),
  truth: suppliedTruth = null,
}) {
  const forbidden = new Set();
  let truth = suppliedTruth;
  if (!truth) {
    try {
      truth = JSON.parse(
        readBytes(repoRoot, fixture.truth_file).toString("utf8"),
      );
    } catch {
      return [];
    }
  }
  for (const sha of [truth.last_head]) {
    if (
      typeof sha === "string" &&
      SHA_PATTERN.test(sha) &&
      sha !== fixture.first_head &&
      sha !== fixture.base_sha
    ) {
      forbidden.add(sha);
    }
  }
  return [...forbidden];
}

function checkDigestedFile({
  repoRoot,
  relativePath,
  expected,
  label,
  problems,
}) {
  let bytes;
  try {
    bytes = readBytes(repoRoot, relativePath);
  } catch {
    problems.push(`${label} is missing: ${relativePath}`);
    return null;
  }
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
    problems.push(`${label} has no sha256 in the contract: ${relativePath}`);
    return bytes;
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    problems.push(
      `${label} does not match its frozen sha256: ${relativePath} is ${actual}, the contract pins ${expected}`,
    );
  }
  return bytes;
}

function checkTruthFile({ repoRoot, fixture, problems }) {
  const bytes = checkDigestedFile({
    repoRoot,
    relativePath: fixture.truth_file,
    expected: fixture.truth_sha256,
    label: `PR ${fixture.pr} truth`,
    problems,
  });
  if (!bytes) return;
  let truth;
  try {
    truth = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    problems.push(`PR ${fixture.pr} truth is not valid JSON: ${error.message}`);
    return;
  }
  if (truth.pr !== fixture.pr) {
    problems.push(`PR ${fixture.pr} truth names PR ${truth.pr}`);
  }
  if (truth.first_head !== fixture.first_head) {
    problems.push(
      `PR ${fixture.pr} truth first_head ${truth.first_head} is not the contract head ${fixture.first_head}`,
    );
  }
  if (truth.base_sha !== fixture.base_sha) {
    problems.push(
      `PR ${fixture.pr} truth base_sha ${truth.base_sha} is not the contract base ${fixture.base_sha}`,
    );
  }
  if (!Array.isArray(truth.findings) || truth.findings.length === 0) {
    problems.push(`PR ${fixture.pr} truth carries no findings`);
    return;
  }

  // The frozen id list is the denominator. Recomputing it from the acted_on
  // predicate at score time would let a parser change move the denominator
  // silently, so both are computed and required to agree.
  const actedOn = truth.findings
    .filter((finding) => finding.acted_on === true)
    .map((finding) => finding.id);
  const p1 = truth.findings
    .filter((finding) => finding.acted_on === true && finding.severity === "P1")
    .map((finding) => finding.id);
  compareIdSets({
    label: `PR ${fixture.pr} scorable_ids`,
    frozen: fixture.scorable_ids,
    derived: actedOn,
    derivedLabel: "acted-on truth findings",
    problems,
  });
  compareIdSets({
    label: `PR ${fixture.pr} p1_ids`,
    frozen: fixture.p1_ids,
    derived: p1,
    derivedLabel: "acted-on P1 truth findings",
    problems,
  });
}

function compareIdSets({ label, frozen, derived, derivedLabel, problems }) {
  if (!Array.isArray(frozen)) {
    problems.push(`${label} must be an array`);
    return;
  }
  const frozenSet = new Set(frozen);
  const derivedSet = new Set(derived);
  const missing = derived.filter((id) => !frozenSet.has(id));
  const extra = frozen.filter((id) => !derivedSet.has(id));
  if (missing.length > 0) {
    problems.push(`${label} omits ${derivedLabel}: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    problems.push(
      `${label} names ids that are not ${derivedLabel}: ${extra.join(", ")}`,
    );
  }
}

function checkFinderReports({ repoRoot, fixture, seenReportFiles, problems }) {
  const reports = fixture.finder_reports;
  if (!Array.isArray(reports)) {
    problems.push(`PR ${fixture.pr} finder_reports must be an array`);
    return;
  }
  if (fixture.grid === true && reports.length === 0) {
    problems.push(
      `PR ${fixture.pr} is a grid fixture with no frozen finder report`,
    );
  }
  if (fixture.grid !== true && reports.length > 0) {
    problems.push(
      `PR ${fixture.pr} is not a grid fixture and cannot carry finder reports`,
    );
  }
  for (const report of reports) {
    if (!isObject(report) || typeof report.file !== "string") {
      problems.push(`PR ${fixture.pr} has a finder report without a file`);
      continue;
    }
    if (seenReportFiles.has(report.file)) {
      problems.push(`finder report is referenced twice: ${report.file}`);
    }
    seenReportFiles.add(report.file);
    if (typeof report.source !== "string" || report.source.length === 0) {
      problems.push(`finder report has no provenance: ${report.file}`);
    }
    const bytes = checkDigestedFile({
      repoRoot,
      relativePath: report.file,
      expected: report.sha256,
      label: `PR ${fixture.pr} finder report`,
      problems,
    });
    if (!bytes) continue;
    const chars = bytes.toString("utf8").length;
    if (report.chars !== undefined && report.chars !== chars) {
      problems.push(
        `finder report ${report.file} is ${chars} characters, the contract records ${report.chars}`,
      );
    }
  }
}

function checkPrompts({ repoRoot, contract, problems }) {
  const prompts = contract.prompts;
  if (!isObject(prompts)) {
    problems.push("contract.prompts must be an object");
    return;
  }
  for (const name of ["request", "handoff"]) {
    const prompt = prompts[name];
    if (!isObject(prompt) || typeof prompt.file !== "string") {
      problems.push(`contract.prompts.${name} must name a file`);
      continue;
    }
    const bytes = checkDigestedFile({
      repoRoot,
      relativePath: prompt.file,
      expected: prompt.sha256,
      label: `${name} prompt`,
      problems,
    });
    if (!bytes) continue;
    const text = bytes.toString("utf8");
    if (name === "handoff" && !text.includes(HANDOFF_PLACEHOLDER)) {
      problems.push(
        `handoff prompt has no ${HANDOFF_PLACEHOLDER} placeholder, so the finder report would be dropped`,
      );
    }
    if (name === "request" && text.includes(HANDOFF_PLACEHOLDER)) {
      problems.push(
        `request prompt carries the ${HANDOFF_PLACEHOLDER} placeholder, which belongs to the handoff prompt`,
      );
    }
  }
}

/**
 * The finder is spawned by the orchestrator, so its argument vector is code.
 * A contract edit is reviewed as data, which is why the argv is pinned here:
 * argv[0] must be the declared tool, and no element may carry whitespace, a
 * shell metacharacter, a tab or a newline. That keeps the orchestrator free of
 * word splitting and keeps a contract-supplied field out of the TSV framing.
 */
export function checkFinderArgv({ finder, problems }) {
  if (!isObject(finder)) return;
  const argv = finder.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    problems.push("contract sut.finder.argv must be a non-empty array");
    return;
  }
  if (finder.command !== undefined) {
    problems.push(
      "contract sut.finder.command is no longer read; declare sut.finder.argv instead",
    );
  }
  for (const [index, element] of argv.entries()) {
    if (typeof element !== "string" || element.length === 0) {
      problems.push(
        `contract sut.finder.argv[${index}] must be a non-empty string`,
      );
      continue;
    }
    if (!FINDER_ARGV_ELEMENT.test(element)) {
      problems.push(
        `contract sut.finder.argv[${index}] has a character outside ${FINDER_ARGV_ELEMENT}: ${JSON.stringify(element)}`,
      );
    }
  }
  if (argv[0] !== finder.tool) {
    problems.push(
      `contract sut.finder.argv[0] must be the declared tool ${JSON.stringify(finder.tool)}, not ${JSON.stringify(argv[0])}`,
    );
  }
}

function checkShape({ contract, problems }) {
  if (contract.schema_version !== REVIEW_EVAL_SCHEMA_VERSION) {
    problems.push("contract schema_version must be 1");
  }
  if (contract.suite_id !== REVIEW_EVAL_SUITE_ID) {
    problems.push(`contract suite_id must be ${REVIEW_EVAL_SUITE_ID}`);
  }
  if (
    typeof contract.repo !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(contract.repo)
  ) {
    problems.push("contract repo must be an owner/repository slug");
  }
  if (
    typeof contract.tags_namespace !== "string" ||
    contract.tags_namespace.length === 0
  ) {
    problems.push("contract tags_namespace must be a non-empty string");
  }
  if (!isObject(contract.provenance) || !contract.provenance.truth_method) {
    problems.push(
      "contract provenance must record how the truth was harvested",
    );
  }
  // The judge is configured like a SUT role and spends quota like one.
  // `runScoring` reads `judge.effort` straight out of the contract and hands it
  // to the scoring helpers, whose parameter defaults fire on `undefined`. A
  // contract that dropped `judge.effort` would pass the offline check and then
  // score at the `high` default instead of the effort the contract declares,
  // recording calibration and cell numbers under provenance that never held.
  // Require both fields, while the check is still free.
  if (!isObject(contract.judge)) {
    problems.push("contract judge must be an object");
  } else {
    for (const field of ["model", "effort"]) {
      if (
        typeof contract.judge[field] !== "string" ||
        contract.judge[field].length === 0
      ) {
        problems.push(`contract judge.${field} must be a non-empty string`);
      }
    }
  }
  if (!isObject(contract.sut)) {
    problems.push("contract sut must be an object");
  } else {
    // Provenance the matrix spends quota under, not decoration. `planCells`
    // copies each role's `model` and `effort` into `plan.json`, the
    // orchestrator reads them out of the matrix line and hands the effort to
    // the CLI, and the scored row records the pair as the condition it
    // measured; `tool` is what `checkFinderArgv` pins argv[0] against and what
    // each contestant declares itself to be. Only `model` was checked here, so
    // a contract that dropped `sut.verifier.effort` passed the offline check
    // and reached the shell as the literal string "undefined" — a run executed
    // and recorded under provenance the contract never validly declared.
    // Refuse it here, while the check is still free.
    for (const role of ["finder", "verifier", "control"]) {
      const entry = contract.sut[role];
      if (!isObject(entry)) {
        problems.push(`contract sut.${role} must be an object`);
        continue;
      }
      for (const field of ["tool", "model", "effort"]) {
        if (typeof entry[field] !== "string" || entry[field].length === 0) {
          problems.push(
            `contract sut.${role}.${field} must be a non-empty string`,
          );
        }
      }
    }
    checkFinderArgv({ finder: contract.sut.finder, problems });
  }
  const rules = contract.verdict_rules;
  if (!isObject(rules)) {
    problems.push("contract verdict_rules must be an object");
  } else {
    for (const key of REQUIRED_VERDICT_RULES) {
      if (!Number.isFinite(rules[key]) || rules[key] <= 0) {
        problems.push(`verdict_rules.${key} must be a positive number`);
      }
    }
    if (Number.isFinite(rules.p1_recall_floor) && rules.p1_recall_floor > 1) {
      problems.push(
        "verdict_rules.p1_recall_floor must be a rate at or below 1",
      );
    }
  }
  const cadence = contract.cadence_days;
  if (!isObject(cadence)) {
    problems.push("contract cadence_days must be an object");
  } else {
    for (const key of REQUIRED_CADENCE_DAYS) {
      if (!Number.isSafeInteger(cadence[key]) || cadence[key] <= 0) {
        problems.push(`cadence_days.${key} must be a positive integer`);
      }
    }
    const ordered = [
      ["freshness_warn", "freshness_red"],
      ["freshness_red", "complete_red"],
      ["complete_red", "full_red"],
      ["canary", "full"],
    ];
    for (const [earlier, later] of ordered) {
      if (
        Number.isSafeInteger(cadence[earlier]) &&
        Number.isSafeInteger(cadence[later]) &&
        cadence[earlier] >= cadence[later]
      ) {
        problems.push(
          `cadence_days.${earlier} must be shorter than cadence_days.${later}`,
        );
      }
    }
  }
}

function checkFixtureEntry({ contract, fixture, index, seen, problems }) {
  if (!isObject(fixture)) {
    problems.push(`fixtures[${index}] must be an object`);
    return;
  }
  const pr = fixture.pr;
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    problems.push(`fixtures[${index}].pr must be a pull request number`);
    return;
  }
  if (seen.prs.has(pr)) problems.push(`PR ${pr} appears twice in the contract`);
  seen.prs.add(pr);
  if (typeof fixture.title !== "string" || fixture.title.length === 0) {
    problems.push(`PR ${pr} has no title`);
  }
  for (const field of ["first_head", "base_sha"]) {
    if (!SHA_PATTERN.test(String(fixture[field]))) {
      problems.push(`PR ${pr} ${field} must be a 40-character lowercase sha`);
    }
  }
  if (fixture.first_head === fixture.base_sha) {
    problems.push(`PR ${pr} first_head and base_sha are the same commit`);
  }
  const namespace = contract.tags_namespace;
  if (typeof namespace === "string" && namespace.length > 0) {
    if (fixture.tag_head !== `${namespace}/pr-${pr}/head`) {
      problems.push(
        `PR ${pr} tag_head must be ${namespace}/pr-${pr}/head, not ${fixture.tag_head}`,
      );
    }
    if (fixture.tag_base !== `${namespace}/pr-${pr}/base`) {
      problems.push(
        `PR ${pr} tag_base must be ${namespace}/pr-${pr}/base, not ${fixture.tag_base}`,
      );
    }
  }
  if (typeof fixture.grid !== "boolean") {
    problems.push(`PR ${pr} grid must be a boolean`);
  }
  if (
    typeof fixture.truth_file !== "string" ||
    fixture.truth_file.length === 0
  ) {
    problems.push(`PR ${pr} truth_file must be a path`);
  }

  const scorable = fixture.scorable_ids;
  if (!Array.isArray(scorable) || scorable.length === 0) {
    problems.push(`PR ${pr} scorable_ids must be a non-empty array`);
  } else {
    if (new Set(scorable).size !== scorable.length) {
      problems.push(`PR ${pr} scorable_ids repeats a defect id`);
    }
    for (const id of scorable) {
      if (!Number.isSafeInteger(id)) {
        problems.push(`PR ${pr} scorable id ${id} must be an integer`);
        continue;
      }
      if (seen.ids.has(id)) {
        problems.push(`defect id ${id} appears in more than one fixture`);
      }
      seen.ids.add(id);
    }
  }
  const p1 = fixture.p1_ids;
  if (!Array.isArray(p1)) {
    problems.push(`PR ${pr} p1_ids must be an array`);
  } else {
    if (new Set(p1).size !== p1.length) {
      problems.push(`PR ${pr} p1_ids repeats a defect id`);
    }
    const scorableSet = new Set(Array.isArray(scorable) ? scorable : []);
    for (const id of p1) {
      if (!scorableSet.has(id)) {
        problems.push(`PR ${pr} p1 id ${id} is not in scorable_ids`);
      }
    }
  }
}

function resolveEvalTag({
  ref,
  expected,
  srcRepo,
  url,
  runGit,
  problems,
  label,
}) {
  if (srcRepo) {
    const resolved = runGit({
      args: [
        "-C",
        srcRepo,
        "rev-parse",
        "-q",
        "--verify",
        `refs/tags/${ref}^{commit}`,
      ],
    });
    if (resolved.status !== 0) {
      problems.push(`${label} tag does not exist in ${srcRepo}: ${ref}`);
      return;
    }
    const sha = resolved.stdout.trim();
    if (sha !== expected) {
      problems.push(
        `${label} tag ${ref} resolves to ${sha}, the contract pins ${expected}`,
      );
      return;
    }
    const present = runGit({
      args: ["-C", srcRepo, "cat-file", "-e", expected],
    });
    if (present.status !== 0) {
      problems.push(
        `${label} commit ${expected} is not in the object store of ${srcRepo}`,
      );
    }
    return;
  }
  const listed = runGit({
    args: ["ls-remote", url, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
  });
  if (listed.status !== 0) {
    problems.push(`${label} tag could not be listed on ${url}: ${ref}`);
    return;
  }
  const rows = listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2);
  if (rows.length === 0) {
    problems.push(`${label} tag is missing on ${url}: ${ref}`);
    return;
  }
  const peeled = rows.find((parts) => parts[1].endsWith("^{}")) || rows[0];
  if (peeled[0] !== expected) {
    problems.push(
      `${label} tag ${ref} resolves to ${peeled[0]}, the contract pins ${expected}`,
    );
  }
}

/**
 * The frozen files the contract pins by sha256, rechecked against their bytes
 * on disk: both prompts, every truth file, every frozen finder report.
 *
 * `--check-fixtures` covers these once, before the matrix starts. A full run
 * then takes hours, and under `--skill-ref` the spec worktree is the live
 * checkout the operator keeps editing, so the bytes a cell read are not
 * guaranteed to be the bytes that check passed. No git and no network here:
 * this is the subset `--score` can afford to re-run before it spends a judge.
 */
export function frozenInputProblems({ contract, repoRoot = process.cwd() }) {
  if (!isObject(contract)) return ["contract must be a JSON object"];
  const problems = [];
  checkPrompts({ repoRoot, contract, problems });
  const seenReportFiles = new Set();
  for (const fixture of contract.fixtures ?? []) {
    if (!isObject(fixture) || !Number.isSafeInteger(fixture.pr)) continue;
    if (typeof fixture.truth_file === "string") {
      checkTruthFile({ repoRoot, fixture, problems });
    }
    checkFinderReports({ repoRoot, fixture, seenReportFiles, problems });
  }
  return problems;
}

/**
 * Validate the contract against the bytes it pins. Offline is the CI mode and
 * needs no network and no model. Every problem is collected: a check that
 * stops at the first failure hides the rest of a broken contract.
 */
export function checkFixtures({
  contract,
  repoRoot = process.cwd(),
  offline = true,
  srcRepo = null,
  runGit = defaultRunGit,
}) {
  const problems = [];
  if (!isObject(contract)) {
    return {
      ok: false,
      problems: ["contract must be a JSON object"],
      checked: null,
    };
  }
  checkShape({ contract, problems });
  checkPrompts({ repoRoot, contract, problems });

  const fixtures = contract.fixtures;
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    problems.push("contract fixtures must be a non-empty array");
    return { ok: false, problems, checked: null };
  }
  const seen = { prs: new Set(), ids: new Set() };
  const seenReportFiles = new Set();
  const seenTruthFiles = new Set();
  fixtures.forEach((fixture, index) => {
    checkFixtureEntry({ contract, fixture, index, seen, problems });
    if (!isObject(fixture) || !Number.isSafeInteger(fixture.pr)) return;
    if (typeof fixture.truth_file === "string") {
      if (seenTruthFiles.has(fixture.truth_file)) {
        problems.push(`truth file is referenced twice: ${fixture.truth_file}`);
      }
      seenTruthFiles.add(fixture.truth_file);
      checkTruthFile({ repoRoot, fixture, problems });
    }
    checkFinderReports({ repoRoot, fixture, seenReportFiles, problems });
  });

  // Offline forbids the network, not the check. The tags and the objects they
  // name are in the local checkout the caller already has, and a deleted or
  // moved `eval/**` tag is exactly what this check exists to catch; skipping
  // it offline left CI green until a paid run tried to materialize a fixture.
  const localRepo = offline ? (srcRepo ?? repoRoot) : srcRepo;
  const url = offline ? null : `https://github.com/${contract.repo}.git`;
  for (const fixture of fixtures) {
    if (!isObject(fixture) || !Number.isSafeInteger(fixture.pr)) continue;
    resolveEvalTag({
      ref: fixture.tag_head,
      expected: fixture.first_head,
      srcRepo: localRepo,
      url,
      runGit,
      problems,
      label: `PR ${fixture.pr} head`,
    });
    resolveEvalTag({
      ref: fixture.tag_base,
      expected: fixture.base_sha,
      srcRepo: localRepo,
      url,
      runGit,
      problems,
      label: `PR ${fixture.pr} base`,
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    checked: {
      offline,
      ...scorableTotals(contract),
      grid: gridFixtures(contract).length,
    },
  };
}

/**
 * Build or reuse the leak-proof checkout for one fixture. The leak checks live
 * in build-fixture.sh so that a cached fixture is verified by the same code
 * that produced it.
 */
export function materializeFixture({
  contract,
  pr,
  cacheDir,
  srcRepo,
  repoRoot = process.cwd(),
  forbidden = null,
  force = false,
  exec = defaultExec,
}) {
  const fixture = fixtureForPr(contract, pr);
  if (!cacheDir) throw new Error("materializeFixture requires a cacheDir");
  if (!srcRepo) throw new Error("materializeFixture requires a srcRepo");
  const absoluteCache = path.resolve(cacheDir);
  const absoluteSource = path.resolve(srcRepo);
  // Compared canonically, never lexically. A `--cache-dir` that reaches the
  // checkout through a symlink — or through one on an ancestor that does not
  // exist yet — passes a `path.resolve` comparison while the fixture is
  // physically created inside the repository, where a cell running with Bash
  // can walk up to the frozen truth files. That defeats the answer-key
  // isolation and produces contaminated scores with no leak signal.
  const canonicalCache = canonicalPath(absoluteCache);
  const canonicalSource = canonicalPath(absoluteSource);
  if (
    canonicalCache === canonicalSource ||
    canonicalCache.startsWith(`${canonicalSource}${path.sep}`)
  ) {
    throw new Error(
      `cacheDir ${absoluteCache} resolves to ${canonicalCache}, inside the source repository, where the reviewed agent can reach the frozen truth`,
    );
  }
  const forbiddenShas =
    forbidden === null
      ? forbiddenShasForFixture({ fixture, repoRoot })
      : forbidden;
  const args = [
    "--src",
    absoluteSource,
    "--pr",
    String(fixture.pr),
    "--head",
    fixture.first_head,
    "--base",
    fixture.base_sha,
    "--cache-dir",
    absoluteCache,
  ];
  if (fixture.tag_head) args.push("--tag-head", fixture.tag_head);
  if (fixture.tag_base) args.push("--tag-base", fixture.tag_base);
  if (contract.repo)
    args.push("--url", `https://github.com/${contract.repo}.git`);
  for (const sha of forbiddenShas) args.push("--forbidden", sha);
  if (force) args.push("--force");

  const result = exec({ file: BUILD_FIXTURE_SCRIPT, args, cwd: repoRoot });
  if (result.status !== 0) {
    const reason =
      String(result.stderr || "")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("FATAL:"))
        .pop() ||
      String(result.stderr || "")
        .trim()
        .split("\n")
        .pop() ||
      `exit ${result.status}`;
    throw new Error(`build-fixture.sh failed for PR ${fixture.pr}: ${reason}`);
  }
  let report;
  try {
    report = JSON.parse(String(result.stdout).trim().split("\n").pop());
  } catch (error) {
    throw new Error(
      `build-fixture.sh printed no fixture report for PR ${fixture.pr}: ${error.message}`,
      { cause: error },
    );
  }
  if (report.head !== fixture.first_head) {
    throw new Error(
      `build-fixture.sh reported head ${report.head} for PR ${fixture.pr}, the contract pins ${fixture.first_head}`,
    );
  }
  try {
    statSync(report.path);
  } catch {
    throw new Error(
      `fixture path ${report.path} does not exist for PR ${fixture.pr}`,
    );
  }
  return { ...report, pr: fixture.pr, forbidden: forbiddenShas };
}

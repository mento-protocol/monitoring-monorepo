// Cell identity, raw and judge cache reuse, and answer-key leak signals.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defaultRunGit } from "./review-eval-fixtures.mjs";

const MIN_VERBATIM_TITLE_WORDS = 6;

// The shell refactor moved the cell runtime into two sourced helpers. Its final
// reviewed wrapper also binds every helper source to one private snapshot before
// paid work starts. Permit only that audited transition so the 24 paid cells
// cached before the refactor remain reusable. The current digest binds the
// wrapper and all three helpers. Any later edit closes this compatibility path.
//
// CLOSED. The cell runtime now captures the whole `stream-json` session instead
// of the CLI's last-message envelope, so `run-eval-runtime.sh` moved and the
// digest below is no longer any live orchestrator's. That is the right outcome
// rather than a stale pin: a cell cached under the old runtime recorded only the
// reviewer's final message, and folding one into a run that records whole
// sessions would mix two capture regimes inside one row. The pair stays as the
// audit record of the transition that was permitted.
const ORCHESTRATOR_REUSE_TRANSITIONS = new Map([
  [
    "5cdfbd0e709af2d68c193d484b724706b339ab0562d14b283f5fc38eebe9ae49",
    "d0790e1d52542ac8e22bbc84932e98d635035f685ca201321bda3ab4c196033a",
  ],
]);

// One full run finished its 24 paid cells before the orchestrator and scorer
// were split into focused modules. This exact source tuple is the only old
// lineage the planner may discover by scanning a physical runs directory.
export const LEGACY_SPLIT_CACHE_PLAN = Object.freeze({
  comparabilityKey:
    "4543e3da483d5f2c70fc97e97664377ae22cc844bf1e5f376c1ce60eb3a42267",
  contractDigest:
    "7223888cc6bd15c9bdb3bf1f6929a516719dd497ee6d2f1bc577a6405e8202e9",
  matcherDigest:
    "d183758cd7a3b28aa14fe857ed04c6ca93601e1834a1dfd08cf730ad2332c922",
  calibrationDigest:
    "aa930bb14f90b5c747706771685eb0696100e1ce9e64ab8595440b55fde017dd",
  orchestratorDigest:
    "5cdfbd0e709af2d68c193d484b724706b339ab0562d14b283f5fc38eebe9ae49",
});

/** Whether one recorded orchestrator change preserves raw cell behavior. */
export function orchestratorReuseAllowed(fromDigest, toDigest) {
  return ORCHESTRATOR_REUSE_TRANSITIONS.get(fromDigest) === toDigest;
}

/** Whether an on-disk plan is the exact reusable pre-split cache lineage. */
export function legacySplitCachePlanMatches({
  plan,
  detailDir,
  contractDigest,
  calibrationDigest,
  kind,
  inputs,
  cells,
}) {
  const legacy = LEGACY_SPLIT_CACHE_PLAN;
  return (
    contractDigest === legacy.contractDigest &&
    calibrationDigest === legacy.calibrationDigest &&
    plan?.schema_version === 1 &&
    plan?.detail_dir === detailDir &&
    plan?.comparability_key === legacy.comparabilityKey &&
    plan?.contract_digest === legacy.contractDigest &&
    plan?.matcher_digest === legacy.matcherDigest &&
    plan?.calibration_digest === legacy.calibrationDigest &&
    plan?.kind === kind &&
    plan?.inputs?.skill_digest === inputs.skill_digest &&
    plan?.inputs?.finder_argv_digest === inputs.finder_argv_digest &&
    plan?.inputs?.claude_cli === inputs.claude_cli &&
    plan?.inputs?.codex_cli === inputs.codex_cli &&
    plan?.inputs?.orchestrator_digest === legacy.orchestratorDigest &&
    orchestratorReuseAllowed(
      legacy.orchestratorDigest,
      inputs.orchestrator_digest,
    ) &&
    JSON.stringify(plan?.cells) === JSON.stringify(cells)
  );
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
}

/**
 * Heuristic answer-key detection. The contestant runs with real network and
 * real credentials on purpose, so this is defense in depth, not proof: naming
 * the PR or one of its reviewers is a hard signal, while a verbatim truth
 * title is only advisory because a correct review may word a defect the way
 * the reviewer did.
 */
export function reviewerLogins(truth) {
  return [
    ...new Set(
      [
        ...(truth?.reviewers ?? []),
        ...(truth?.findings ?? []).map((finding) => finding.author),
      ].filter(Boolean),
    ),
  ];
}

/**
 * Logins that the fixture's own tree already contains at its first head. A
 * review that quotes the line it is criticizing is doing what the prompt asks;
 * flagging `coderabbitai[bot]` because the source names it caps a correct run
 * at AMBER forever, so those logins are excluded from the login signal.
 */
export function loginsInFixtureTree({
  fixturePath,
  logins,
  runGit = defaultRunGit,
}) {
  const present = new Set();
  if (!fixturePath || !existsSync(fixturePath)) return present;
  for (const login of logins ?? []) {
    const result = runGit({
      args: [
        "grep",
        "--fixed-strings",
        "--files-with-matches",
        "-I",
        "-e",
        login,
      ],
      cwd: fixturePath,
    });
    if (result.status === 0) present.add(login);
  }
  return present;
}

export function leakSignals({
  transcript,
  truth,
  pr,
  excludeLogins = [],
  forbiddenShas = [],
}) {
  const text = String(transcript ?? "");
  const hard = [];
  const advisory = [];
  if (new RegExp(`(?:#|pull/|pulls/|PR )${pr}(?!\\d)`).test(text)) {
    hard.push(`transcript names PR ${pr}`);
  }
  const excluded = new Set(excludeLogins);
  for (const login of reviewerLogins(truth)) {
    if (excluded.has(login)) continue;
    if (text.includes(login)) hard.push(`transcript names reviewer ${login}`);
  }
  // The withheld commits are the answer key. `git` is neutralized per cell, but
  // that is a speed bump, so naming one of those commits is scored as a leak.
  const hexRuns = text.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  for (const sha of forbiddenShas ?? []) {
    if (hexRuns.some((token) => String(sha).startsWith(token))) {
      hard.push(
        `transcript names the withheld commit ${String(sha).slice(0, 12)}`,
      );
    }
  }
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  for (const finding of truth?.findings ?? []) {
    const title = String(finding.title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (title.split(" ").filter(Boolean).length < MIN_VERBATIM_TITLE_WORDS) {
      continue;
    }
    if (normalized.includes(title)) {
      advisory.push(`transcript repeats truth title ${finding.id} verbatim`);
    }
  }
  return { suspected: hard.length > 0, hard, advisory };
}

/**
 * What a cached cell must have been produced under. The detail directory alone
 * is not enough: an aborted run leaves cells behind, and the next run may carry
 * an edited skill or an edited contract into the same directory.
 *
 * The recorded runtime is part of it. An interrupted run resumed after a CLI
 * upgrade would otherwise reuse cells produced by the previous binaries while
 * the new row stamps the current versions, which puts two runtimes in one row
 * under one provenance. `finder_argv_digest` is the command the pipeline
 * condition spawns, and `orchestrator_digest` is the script that spawns it with
 * its tools, turn limit and skill staging, so both move a recorded number the
 * same way.
 */
export function cellFingerprint({ plan }) {
  return {
    skill_digest: plan?.inputs?.skill_digest ?? null,
    kind: plan?.kind ?? null,
    contract_digest: plan?.contract_digest ?? null,
    claude_cli: plan?.inputs?.claude_cli ?? null,
    codex_cli: plan?.inputs?.codex_cli ?? null,
    finder_argv_digest: plan?.inputs?.finder_argv_digest ?? null,
    orchestrator_digest: plan?.inputs?.orchestrator_digest ?? null,
  };
}

/** The installed or candidate selection that scored evidence must retain. */
export function treatmentIdentity({ plan }) {
  return {
    skill_ref: plan?.inputs?.skill_ref ?? null,
    dirty: plan?.inputs?.dirty === true,
  };
}

// The historical producer wrote only these two shapes. The skill digest, not
// this display identity, decides whether the raw cell still matches this run.
function validLegacyTreatmentFingerprint(fingerprint) {
  if (
    !Object.hasOwn(fingerprint, "skill_ref") ||
    !Object.hasOwn(fingerprint, "dirty")
  ) {
    return false;
  }
  if (fingerprint.skill_ref === "installed") {
    return fingerprint.dirty === false;
  }
  return (
    fingerprint.dirty === true &&
    typeof fingerprint.skill_ref === "string" &&
    fingerprint.skill_ref.length > 0 &&
    path.isAbsolute(fingerprint.skill_ref) &&
    path.resolve(fingerprint.skill_ref) === fingerprint.skill_ref
  );
}

/**
 * Whether the orchestrator may reuse a cell it finds on disk. An unfingerprinted
 * or mismatched cell is refused, which costs one re-run and never scores the
 * previous skill's output under this run's digest.
 */
export function cellReuseDecision({ plan, resultPath, result = null }) {
  const expected = cellFingerprint({ plan });
  let stored = result;
  if (!stored) {
    if (!existsSync(resultPath)) {
      return { reuse: false, reason: `no cell result at ${resultPath}` };
    }
    try {
      stored = readJson(resultPath);
    } catch (error) {
      return { reuse: false, reason: error.message };
    }
  }
  const found = stored?.fingerprint;
  if (!found || typeof found !== "object") {
    return { reuse: false, reason: "the cached cell carries no fingerprint" };
  }
  const reusedAcrossOrchestratorSplit = orchestratorReuseAllowed(
    found.orchestrator_digest,
    expected.orchestrator_digest,
  );
  const validLegacyTreatment = validLegacyTreatmentFingerprint(found);
  if (reusedAcrossOrchestratorSplit && !validLegacyTreatment) {
    return {
      reuse: false,
      reason:
        "the approved pre-split fingerprint lacks the complete historically valid legacy treatment fields",
    };
  }
  const acceptedLegacyFields = new Set(
    reusedAcrossOrchestratorSplit && validLegacyTreatment
      ? ["skill_ref", "dirty"]
      : [],
  );
  const unexpected = Object.keys(found).filter(
    (field) =>
      !Object.hasOwn(expected, field) && !acceptedLegacyFields.has(field),
  );
  if (unexpected.length > 0) {
    return {
      reuse: false,
      reason: `the cached cell fingerprint carries unexpected ${unexpected.join(", ")}`,
    };
  }
  const differing = Object.keys(expected).filter((field) => {
    if (found[field] === expected[field]) return false;
    if (field === "orchestrator_digest" && reusedAcrossOrchestratorSplit) {
      return false;
    }
    return true;
  });
  if (differing.length > 0) {
    return {
      reuse: false,
      reason: `the cached cell was produced under a different ${differing.join(", ")}`,
    };
  }
  return {
    reuse: true,
    reason: reusedAcrossOrchestratorSplit
      ? "the cached cell matches this run through the recorded reviewed orchestrator transition"
      : "the cached cell matches this run",
  };
}

/** Where the orchestrator wrote one cell's raw contestant transcript. */
export function cellResultPath(planDir, cell) {
  return path.join(planDir, "cells", cell.cell_id, "result.json");
}

/**
 * One cell's raw result plus the digest of the exact bytes scoring reads, or
 * null when the cell never completed. The digest is what ties a cached judge
 * verdict to the transcript that verdict was formed on.
 */
export function readCellResult(planDir, cell) {
  const file = cellResultPath(planDir, cell);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  let result;
  try {
    result = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`could not read valid JSON from ${file}`, { cause: error });
  }
  if (result?.ok !== true || typeof result.output !== "string") return null;
  return { result, digest: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * What a cached judge verdict must have been produced under.
 *
 * The judge pass cost about four dollars and nine minutes a cell at the
 * fable-max judge, so a 27-cell pass ran about four hours: long enough to meet
 * a usage limit, so it has to resume rather than re-spend from zero. The
 * opus-high judge that replaced it is not measured per cell yet. These fields
 * are every input that can move a scored number - the
 * comparability key the row is filed under, the contract, the scorer and
 * calibration bytes that key is derived from, the execution fingerprint the raw
 * cell already carries, and, per cell, the transcript itself. A record matching
 * all of them is the same judge call, so replaying it changes nothing. Anything
 * else is ignored and re-judged, which costs one cell and never scores one
 * pipeline's output under another pipeline's identity.
 */
function judgeResumeIdentity({ plan, resultDigest = null, judge = null }) {
  return {
    comparability_key: plan?.comparability_key ?? null,
    contract_digest: plan?.contract_digest ?? null,
    matcher_digest: plan?.matcher_digest ?? null,
    calibration_digest: plan?.calibration_digest ?? null,
    fingerprint: cellFingerprint({ plan }),
    ...(resultDigest === null ? {} : { result_digest: resultDigest }),
    ...(judge === null ? {} : { judge }),
  };
}

/** The record a resume file holds, or null when it does not match or parse. */
function readResume(file, identity) {
  let stored;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return JSON.stringify(stored?.resume_identity) === JSON.stringify(identity)
    ? (stored.record ?? null)
    : null;
}

function writeResume(file, identity, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ resume_identity: identity, record }, null, 2)}\n`,
  );
}

// The resume cache lives under `cells/`: the directory publication already
// excludes with a pathspec and a failed run already keeps on disk. Scored
// evidence at the detail-dir root is exactly what a failed row must not carry,
// so the scorer writes nothing there until the pass has finished.
function scoreResumePath(planDir, cellId) {
  return path.join(planDir, "cells", cellId, "score.json");
}

function calibrationResumePath(planDir) {
  return path.join(planDir, "cells", "calibration.json");
}

/**
 * Whether a stored record can stand in for a judge call.
 *
 * A resumed record is published verbatim as
 * `result-<pr>-<condition>-<draw>.json` and folded into a condition on the way,
 * so every field either consumer dereferences has to be there and has to have
 * the right type. A partial record is worse than no record: it is not re-judged,
 * it aborts the pass on the missing field, and it stays under `cells/` so the
 * next retry aborts the same way. Rejecting it takes the ending an unparsable
 * file already gets, for the same reason - one cell re-spent beats a dead
 * six-hour pass.
 */
function usableScoreRecord(record, cell) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return false;
  }
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  return (
    record.cell_id === cell.cell_id &&
    record.pr === cell.pr &&
    record.condition === cell.condition &&
    record.draw === cell.draw &&
    finite(record.scoring_usd) &&
    record.scoring_usd >= 0 &&
    finite(record.seconds) &&
    finite(record.usd) &&
    Array.isArray(record.claims) &&
    Array.isArray(record.matched_ids) &&
    typeof record.leak?.suspected === "boolean" &&
    Array.isArray(record.leak?.hard) &&
    finite(record.novel?.novelReal) &&
    finite(record.novel?.novelWrong)
  );
}

/**
 * A judge verdict for this cell that this plan may reuse, or null.
 *
 * `treatment` stays out of the resume identity: the selection that named the
 * run is display identity, not a judge input, so the same transcript under the
 * same contract earns the same verdict either way. The record is published as
 * `result-<pr>-<condition>-<draw>.json` though, and run evidence rejects one
 * whose treatment is not this plan's, so a reused verdict is rebound to this
 * run's selection - exactly what a fresh judge call stamps onto a cached raw
 * cell.
 */
export function readScoreResume({ planDir, plan, cell, resultDigest }) {
  const record = readResume(
    scoreResumePath(planDir, cell.cell_id),
    judgeResumeIdentity({ plan, resultDigest }),
  );
  return usableScoreRecord(record, cell)
    ? { ...record, treatment: treatmentIdentity({ plan }) }
    : null;
}

export function writeScoreResume({
  planDir,
  plan,
  cell,
  resultDigest,
  record,
}) {
  writeResume(
    scoreResumePath(planDir, cell.cell_id),
    judgeResumeIdentity({ plan, resultDigest }),
    record,
  );
}

/**
 * Whether a stored calibration replay can stand in for running the forty pairs.
 *
 * It is published as `calibration.json`, and `--validate` re-derives
 * `agreement` and `total` from `outcomes` to check the row's own numbers. A
 * record that cannot support that re-derivation would be published as a reuse,
 * fail validation, and - because the failed-run path keeps `cells/` - be reused
 * by every retry after it. Replaying forty pairs once is the cheaper ending.
 */
function usableCalibrationRecord(calibration) {
  if (
    typeof calibration !== "object" ||
    calibration === null ||
    Array.isArray(calibration)
  ) {
    return false;
  }
  return (
    Number.isInteger(calibration.total) &&
    calibration.total > 0 &&
    Number.isInteger(calibration.agreement) &&
    calibration.agreement >= 0 &&
    calibration.agreement <= calibration.total &&
    Array.isArray(calibration.outcomes) &&
    calibration.outcomes.length === calibration.total &&
    typeof calibration.scoring_usd === "number" &&
    Number.isFinite(calibration.scoring_usd) &&
    calibration.scoring_usd >= 0
  );
}

/** A calibration replay this plan and judge may reuse, or null. */
export function readCalibrationResume({ planDir, plan, judge }) {
  const calibration = readResume(
    calibrationResumePath(planDir),
    judgeResumeIdentity({ plan, judge }),
  );
  return usableCalibrationRecord(calibration) ? calibration : null;
}

export function writeCalibrationResume({ planDir, plan, judge, calibration }) {
  writeResume(
    calibrationResumePath(planDir),
    judgeResumeIdentity({ plan, judge }),
    calibration,
  );
}

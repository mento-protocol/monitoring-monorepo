#!/usr/bin/env node

// Offline contract tests for the non-ledger review-skill experiment lane.
// Every execution seam is injected. This suite must never call a model or the
// network.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalPath, loadContract } from "./review-eval-fixtures.mjs";
import {
  absoluteExperimentStageDeadline,
  acquireExperimentRunLock,
  assertExperimentCalibrationCovers,
  assertRetryEligible,
  assertDisjointExperimentRoots,
  assertExperimentArtifactRoot,
  assertExperimentCampaignFresh,
  assertExperimentRuntimeIdentity,
  assertExperimentStorageRoot,
  attemptReceiptPath,
  buildExperimentSandboxProfile,
  buildCacheIdentity,
  buildExperimentPlan,
  calibrationBoundedStageDeadline,
  CALIBRATION_MAX_AGE_MS,
  CAMPAIGN_MAX_AGE_MS,
  calibrationReuseDecision,
  claimInflationRequiresNovelty,
  capturedSkillDigest,
  createExperimentJudgeExec,
  createDisposableExperimentFixture,
  digestExperimentSources,
  drainExperimentProcesses,
  EXPERIMENT_CACHE_STAGES,
  EXPERIMENT_NAMESPACE,
  EXPERIMENT_SOURCES,
  EXPERIMENT_STAGE_TIMEOUT_MS,
  EXPERIMENT_STAGES,
  EXPERIMENT_STATUSES,
  digestObject,
  disposeDisposableExperimentFixture,
  DEFAULT_EXPERIMENT_ARTIFACT_ROOT,
  DEFAULT_EXPERIMENT_FIXTURE_ROOT,
  evaluateExperimentDecision,
  experimentSkillDigest,
  isolateExperimentCommand,
  latestStageRun,
  MAX_CANDIDATES,
  MAX_FIXTURE_LANES,
  MAX_STAGE_ATTEMPTS,
  publishValidatedStageArtifact,
  releaseExperimentRunLock,
  registeredExperimentWorktrees,
  resolveExperimentExecutable,
  resolveExperimentArtifactPath,
  runExperimentStage,
  runArtifactPath,
  sealRunEvidence,
  sealExperimentRuntimeSources,
  spawnExperimentProcess,
  stageExperimentSkill,
  stageRetryDecision,
  treatmentOrder,
  validateExperimentPlan,
  validateExperimentCalibrationReceipt,
  validateStageRunArtifact,
  validateStageAttempt,
} from "./review-eval-experiment-core.mjs";
import {
  createExperimentArmExecutor,
  enrichRecordsWithNovelty,
  ensureExperimentCalibration,
  liveFinderHandoff,
  validateExperimentRecordCaches,
} from "./review-eval-experiment-runtime.mjs";
import { cellFingerprint } from "./review-eval-run-cell.mjs";
import { skillDigest } from "./review-eval-run-plan.mjs";
import { SCORING_MODULES, scorerDigest } from "./review-eval-score.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const { contract, digest: actualContractDigest } = loadContract(
  path.join(repoRoot, "docs/evals/review-skill-fixtures.json"),
);
const digest = (character) => character.repeat(64);
const ownerMarker = (name) => `owner-${name}`;
const plannedAt = "2026-09-01T09:00:00.000Z";

test("experiment source identity covers every executable module", () => {
  const sources = readdirSync(path.join(repoRoot, "scripts/review"))
    .filter(
      (name) =>
        name.startsWith("review-eval-experiment") &&
        name.endsWith(".mjs") &&
        !name.endsWith(".test.mjs"),
    )
    .sort();
  assert.deepEqual([...EXPERIMENT_SOURCES].sort(), sources);
});

test("experiment-only modules stay outside the canonical scorer identity", () => {
  const canonicalModules = new Set(
    SCORING_MODULES.map((module) => path.basename(module)),
  );
  assert.equal(canonicalModules.has("review-eval-fixtures.mjs"), true);
  for (const source of EXPERIMENT_SOURCES) {
    assert.equal(canonicalModules.has(source), false, source);
  }
});

test("experiment source identity frames names and bytes without ambiguity", () => {
  const left = [
    { name: "a", bytes: Buffer.from("bc") },
    { name: "d", bytes: Buffer.from("e") },
  ];
  const right = [
    { name: "a", bytes: Buffer.from("b") },
    { name: "cd", bytes: Buffer.from("e") },
  ];
  assert.equal(
    Buffer.concat(
      left.flatMap(({ name, bytes }) => [Buffer.from(name), bytes]),
    ).equals(
      Buffer.concat(
        right.flatMap(({ name, bytes }) => [Buffer.from(name), bytes]),
      ),
    ),
    true,
  );
  assert.notEqual(
    digestExperimentSources(left),
    digestExperimentSources(right),
  );
});

test("paid CLI identity skips script launchers and pins direct bytes", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-provider-bin-"),
  );
  try {
    const shimDir = path.join(root, "shim");
    const directDir = path.join(root, "direct");
    mkdirSync(shimDir);
    mkdirSync(directDir);
    const shim = path.join(shimDir, "claude");
    writeFileSync(shim, '#!/bin/sh\nexec elsewhere "$@"\n', { mode: 0o755 });
    symlinkSync(process.execPath, path.join(directDir, "claude"));
    const resolved = resolveExperimentExecutable({
      name: "claude",
      env: { PATH: `${shimDir}${path.delimiter}${directDir}` },
    });
    assert.equal(resolved.path, realpathSync(process.execPath));
    assert.equal(resolved.version, process.version);
    assert.equal(
      resolved.digest,
      createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
    );
    assert.throws(
      () =>
        resolveExperimentExecutable({
          name: "claude",
          env: { PATH: shimDir },
        }),
      /no direct provider executable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const identities = {
  matcher_digest: digest("1"),
  calibration_digest: digest("2"),
  experiment_digest: digest("3"),
  orchestrator_digest: digest("4"),
  finder_argv_digest: digest("5"),
  claude_cli: "claude 2.1.14",
  judge_cli: "claude 2.1.14",
  codex_cli: "codex 0.48.2",
  claude_bin: {
    name: "claude",
    path: "/offline/bin/claude",
    digest: digest("c"),
    version: "claude 2.1.14",
  },
  codex_bin: {
    name: "codex",
    path: "/offline/bin/codex",
    digest: digest("e"),
    version: "codex 0.48.2",
  },
  host: "offline-test-host",
  judge: { model: "claude-opus-5", effort: "high" },
};

function treatment(id, character) {
  return {
    ...(id === "incumbent" ? {} : { id }),
    skill_ref: `/skills/${id}`,
    skill_digest: digest(character),
    canonical_skill_digest: digest(character),
  };
}

function makePlan({
  candidateCount = 1,
  includeLivePaired = false,
  identityOverrides = {},
} = {}) {
  return buildExperimentPlan({
    contract,
    contractDigest: digest("a"),
    plannedAt,
    incumbent: treatment("incumbent", "b"),
    candidates: Array.from({ length: candidateCount }, (_, index) =>
      treatment(`candidate-${index + 1}`, String(index + 6)),
    ),
    identities: { ...identities, ...identityOverrides },
    includeLivePaired,
  });
}

const fixtureByPr = new Map(
  contract.fixtures.map((fixture) => [fixture.pr, fixture]),
);

function armRecord({
  pr,
  treatment: armTreatment,
  known,
  p1,
  claims = known,
  wrongClaims,
  ...extra
}) {
  const fixture = fixtureByPr.get(pr);
  const p1Ids = fixture.p1_ids.slice(0, p1);
  const p1Set = new Set(fixture.p1_ids);
  const ordinaryIds = fixture.scorable_ids.filter((id) => !p1Set.has(id));
  const matchedIds = [...p1Ids, ...ordinaryIds.slice(0, known - p1)];
  assert.equal(
    matchedIds.length,
    known,
    `PR ${pr} can represent ${known}/${p1}`,
  );
  return {
    pr,
    treatment: armTreatment,
    ok: true,
    claims_count: Math.max(1, claims),
    matched_ids: matchedIds,
    ...(wrongClaims === undefined ? {} : { wrong_claims: wrongClaims }),
    ...extra,
  };
}

function recordsFromSpecs(specs, { wrongClaims = false } = {}) {
  return specs.flatMap(({ pr, incumbent, candidate }) =>
    [
      ["incumbent", incumbent],
      ["candidate", candidate],
    ].map(([armTreatment, values]) =>
      armRecord({
        pr,
        treatment: armTreatment,
        ...values,
        ...(wrongClaims ? { wrongClaims: values.wrongClaims ?? 0 } : {}),
      }),
    ),
  );
}

function passingScreen({ wrongClaims = false } = {}) {
  return recordsFromSpecs(
    [
      {
        pr: 1990,
        incumbent: { known: 1, p1: 0 },
        candidate: { known: 4, p1: 3 },
      },
      {
        pr: 1995,
        incumbent: { known: 2, p1: 1 },
        candidate: { known: 1, p1: 1 },
      },
      {
        pr: 1999,
        incumbent: { known: 2, p1: 1 },
        candidate: { known: 2, p1: 1 },
      },
    ],
    { wrongClaims },
  );
}

function passingCombinedRecords() {
  const screen = passingScreen({ wrongClaims: true });
  const holdout = recordsFromSpecs(
    [
      {
        pr: 1990,
        incumbent: { known: 4, p1: 3 },
        candidate: { known: 1, p1: 1 },
      },
      {
        pr: 1995,
        incumbent: { known: 1, p1: 0 },
        candidate: { known: 3, p1: 1 },
      },
      {
        pr: 1999,
        incumbent: { known: 2, p1: 0 },
        candidate: { known: 4, p1: 2, wrongClaims: 1 },
      },
    ],
    { wrongClaims: true },
  );
  return { screen, holdout };
}

function decide({ stage = "screen", recordsByStage }) {
  return evaluateExperimentDecision({
    plan: makePlan(),
    candidateId: "candidate-1",
    stage,
    recordsByStage,
  });
}

const calibrationPath = path.join(
  repoRoot,
  "docs/evals/review-skill-judge-calibration.json",
);
const calibrationBytes = readFileSync(calibrationPath);
const calibrationSet = JSON.parse(calibrationBytes.toString("utf8"));
const calibrationDigest = createHash("sha256")
  .update(calibrationBytes)
  .digest("hex");

function fakeCalibrationExec({ correct = true, onCall = () => {} } = {}) {
  let index = 0;
  return async () => {
    const record = calibrationSet.records[index];
    index += 1;
    onCall(index);
    const expectedMatch = record.expected_verdict === "matched";
    const matched = correct ? expectedMatch : !expectedMatch;
    return JSON.stringify({
      matches: matched ? [1] : [],
      reasoning: { 1: "offline calibration stub" },
    });
  };
}

function writeJsonArtifact(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCalibrationReceipt({
  plan,
  artifactRoot,
  completedAt = "2026-09-01T09:30:00.000Z",
}) {
  const outcomes = calibrationSet.records.map((record) => ({
    record_id: record.record_id,
    defect_id: record.defect_id,
    expected: record.expected_verdict,
    actual: record.expected_verdict,
    reasoning: "offline exact calibration outcome",
  }));
  const base = {
    schema_version: 1,
    namespace: plan.namespace,
    identity: plan.calibration_identity,
    completed_at: completedAt,
    agreement: outcomes.length,
    total: outcomes.length,
    outcomes,
  };
  const artifact = { ...base, receipt_digest: digestObject(base) };
  const file = path.join(
    artifactRoot,
    "cache/calibration",
    digestObject(plan.calibration_identity),
    `receipt-${artifact.receipt_digest}.json`,
  );
  writeJsonArtifact(file, artifact);
  return {
    artifact,
    file,
    evidence: {
      receipt_file: file,
      receipt_digest: artifact.receipt_digest,
      agreement: artifact.agreement,
      total: artifact.total,
      reused: false,
      checked_at: completedAt,
    },
  };
}

function writeCachedStageRecords({
  plan,
  candidateId,
  stage,
  artifactRoot,
  summaries,
  calibrationReceiptDigest = digest("d"),
}) {
  const byArm = new Map(
    summaries.map((record) => [`${record.pr}:${record.treatment}`, record]),
  );
  const lanes = plan.candidate_plans.find(
    (candidate) => candidate.candidate_id === candidateId,
  ).stages[stage].lanes;
  return lanes.flatMap((lane) =>
    lane.sequence.map((arm) => {
      const summary = byArm.get(`${lane.pr}:${arm.treatment}`);
      assert.ok(summary, `missing ${lane.pr} ${arm.treatment} summary`);
      const rawIdentity = buildCacheIdentity({
        phase: "raw",
        plan,
        candidateId,
        stage,
        pr: lane.pr,
        treatment: arm.treatment,
      });
      const rawBase = {
        schema_version: 1,
        namespace: plan.namespace,
        identity: rawIdentity,
        campaign_id: plan.campaign_id,
        comparison_id: rawIdentity.comparison_id,
        stage,
        attempt: 1,
        cell_id: arm.canonical_cell_id,
        pr: lane.pr,
        treatment: arm.treatment,
        fingerprint: arm.execution_fingerprint,
        ok: true,
        output: `${lane.pr} ${arm.treatment} deterministic review output.`,
      };
      const raw = { ...rawBase, raw_digest: digestObject(rawBase) };
      const rawFile = path.join(
        artifactRoot,
        `cache/raw/${rawIdentity.digest}.json`,
      );
      writeJsonArtifact(rawFile, raw);

      const matchIdentity = buildCacheIdentity({
        phase: "match",
        plan,
        candidateId,
        stage,
        pr: lane.pr,
        treatment: arm.treatment,
        rawDigest: raw.raw_digest,
        calibrationReceiptDigest,
      });
      const claims = Array.from(
        { length: summary.claims_count },
        (_, index) => `${lane.pr} ${arm.treatment} claim ${index + 1}`,
      );
      const matchBase = {
        schema_version: 1,
        namespace: plan.namespace,
        identity: matchIdentity,
        raw_digest: raw.raw_digest,
        claims,
        claims_digest: digestObject(claims),
        matched_ids: summary.matched_ids,
        judge_reasoning: {},
        leak: { suspected: false, hard: [], advisory: [] },
      };
      const matched = {
        ...matchBase,
        match_digest: digestObject(matchBase),
      };
      const matchFile = path.join(
        artifactRoot,
        `cache/match/${matchIdentity.digest}.json`,
      );
      writeJsonArtifact(matchFile, matched);
      return {
        ok: true,
        campaign_id: plan.campaign_id,
        candidate_id: candidateId,
        stage,
        attempt: 1,
        cell_id: arm.canonical_cell_id,
        fingerprint: raw.fingerprint,
        pr: lane.pr,
        treatment: arm.treatment,
        output: raw.output,
        raw_digest: raw.raw_digest,
        match_digest: matched.match_digest,
        claims_digest: matched.claims_digest,
        claims_count: claims.length,
        matched_ids: matched.matched_ids,
        leak: matched.leak,
        empty: false,
        artifacts: { raw: rawFile, match: matchFile },
      };
    }),
  );
}

function runNodeWorker(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source, ...args],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function forceKillProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

test("experiment policy constants bound cost and outcomes", () => {
  assert.equal(EXPERIMENT_NAMESPACE, "review-skill-experiments/v1");
  assert.deepEqual(EXPERIMENT_STATUSES, [
    "PROMISING",
    "REJECT",
    "INCONCLUSIVE",
  ]);
  assert.deepEqual(EXPERIMENT_STAGES, ["screen", "holdout", "live-paired"]);
  assert.deepEqual(EXPERIMENT_CACHE_STAGES, ["raw", "match", "novel"]);
  assert.equal(MAX_CANDIDATES, 3);
  assert.equal(MAX_STAGE_ATTEMPTS, 2);
  assert.equal(MAX_FIXTURE_LANES, 3);
  assert.equal(CALIBRATION_MAX_AGE_MS, 6 * 60 * 60 * 1000);
});

test("the plan freezes both paired replay panels", () => {
  const plan = makePlan();
  assert.equal(validateExperimentPlan({ plan, contract }).ok, true);
  assert.equal(plan.ledger_eligible, false);
  assert.equal(plan.canonical_verdict_eligible, false);
  assert.deepEqual(plan.canonical_outcomes_allowed, []);
  assert.deepEqual(plan.experiment_statuses, [...EXPERIMENT_STATUSES]);
  assert.equal(plan.candidate_plans.length, 1);

  const stages = plan.candidate_plans[0].stages;
  assert.deepEqual(
    stages.screen.lanes.map((lane) => [lane.pr, lane.source.draw]),
    [
      [1990, 1],
      [1995, 2],
      [1999, 1],
    ],
  );
  assert.deepEqual(
    stages.holdout.lanes.map((lane) => [lane.pr, lane.source.draw]),
    [
      [1990, 2],
      [1995, 1],
      [1999, 2],
    ],
  );
  assert.equal(stages["live-paired"].enabled, false);
  assert.equal(stages.screen.pair_arms_sequential, true);
  assert.equal(stages.screen.fixture_lane_limit, 3);
  assert.equal(stages.screen.attempt_limit, 2);
  assert.equal(stages.screen.scoring.first_pass, "extract-and-match");
  assert.equal(stages.screen.scoring.novelty, "deferred-until-recall-pass");
});

test("qualification fingerprints use the canonical skill digest", () => {
  const skillRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-canonical-skill-"),
  );
  try {
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: digest-test\n---\nReview the supplied change.\n",
      { mode: 0o600 },
    );
    const experimentDigest = experimentSkillDigest(skillRoot);
    const canonicalDigest = skillDigest(skillRoot);
    assert.notEqual(experimentDigest, canonicalDigest);
    const plan = buildExperimentPlan({
      contract,
      contractDigest: digest("a"),
      plannedAt,
      incumbent: {
        skill_ref: skillRoot,
        skill_digest: experimentDigest,
        canonical_skill_digest: canonicalDigest,
      },
      candidates: [
        {
          id: "candidate-1",
          skill_ref: skillRoot,
          skill_digest: experimentDigest,
          canonical_skill_digest: canonicalDigest,
        },
      ],
      identities,
    });
    const qualification = plan.qualification.treatments.find(
      ({ treatment_id: treatmentId }) => treatmentId === "candidate-1",
    );
    assert.deepEqual(
      qualification.planned_fingerprint,
      cellFingerprint({
        plan: {
          kind: "full",
          contract_digest: plan.contract_digest,
          inputs: {
            skill_digest: canonicalDigest,
            claude_cli: identities.claude_cli,
            codex_cli: identities.codex_cli,
            finder_argv_digest: identities.finder_argv_digest,
            orchestrator_digest: identities.orchestrator_digest,
          },
        },
      }),
    );
  } finally {
    rmSync(skillRoot, { recursive: true, force: true });
  }
});

test("plan validation fails closed on a changed cell or policy", () => {
  for (const mutate of [
    (plan) => plan.candidate_plans[0].stages.screen.lanes.pop(),
    (plan) => {
      plan.policy.screen.known_net_min = 1;
    },
    (plan) => {
      plan.ledger_eligible = true;
    },
  ]) {
    const plan = structuredClone(makePlan());
    mutate(plan);
    const validation = validateExperimentPlan({ plan, contract });
    assert.equal(validation.ok, false);
    assert.match(validation.problems.join("\n"), /complete deterministic/);
  }
});

test("AB/BA order is deterministic across candidates and fixture lanes", () => {
  assert.deepEqual(
    [0, 1, 2].map((fixtureIndex) =>
      treatmentOrder({ candidateIndex: 0, fixtureIndex }),
    ),
    ["AB", "BA", "AB"],
  );
  assert.deepEqual(
    [0, 1, 2].map((fixtureIndex) =>
      treatmentOrder({ candidateIndex: 1, fixtureIndex }),
    ),
    ["BA", "AB", "BA"],
  );

  const plans = makePlan({ candidateCount: 2 }).candidate_plans;
  assert.deepEqual(
    plans.map((candidate) =>
      candidate.stages.screen.lanes.map((lane) => lane.paired_order),
    ),
    [
      ["AB", "BA", "AB"],
      ["BA", "AB", "BA"],
    ],
  );
});

test("campaigns permit three candidates and only one retry per stage", () => {
  assert.equal(makePlan({ candidateCount: 3 }).candidates.length, 3);
  assert.throws(() => makePlan({ candidateCount: 4 }), /at most 3 candidates/);
  assert.equal(validateStageAttempt({ attempt: 1 }).ok, true);
  assert.equal(
    validateStageAttempt({ attempt: 2, priorAttempts: [1] }).ok,
    true,
  );
  assert.equal(
    validateStageAttempt({ attempt: 3, priorAttempts: [1, 2] }).ok,
    false,
  );
  assert.equal(
    validateStageAttempt({ attempt: 2, priorAttempts: [] }).ok,
    false,
  );
  assert.equal(
    validateStageAttempt({ attempt: 1, priorAttempts: [1] }).ok,
    false,
  );
});

test("raw, match, and novel cache identities bind their own inputs", () => {
  const plan = makePlan();
  const common = {
    plan,
    candidateId: "candidate-1",
    stage: "screen",
    pr: 1990,
    treatment: "candidate",
  };
  const raw = buildCacheIdentity({ phase: "raw", ...common });
  const rawWithIrrelevantScoreDigests = buildCacheIdentity({
    phase: "raw",
    ...common,
    rawDigest: digest("c"),
    matchDigest: digest("d"),
  });
  assert.equal(raw.digest, rawWithIrrelevantScoreDigests.digest);

  const match = buildCacheIdentity({
    phase: "match",
    ...common,
    rawDigest: digest("c"),
    calibrationReceiptDigest: digest("e"),
  });
  const changedMatch = buildCacheIdentity({
    phase: "match",
    ...common,
    rawDigest: digest("d"),
    calibrationReceiptDigest: digest("e"),
  });
  assert.notEqual(match.digest, changedMatch.digest);
  const recalibratedMatch = buildCacheIdentity({
    phase: "match",
    ...common,
    rawDigest: digest("c"),
    calibrationReceiptDigest: digest("f"),
  });
  assert.notEqual(match.digest, recalibratedMatch.digest);

  const novel = buildCacheIdentity({
    phase: "novel",
    ...common,
    rawDigest: digest("c"),
    matchDigest: match.digest,
    claimsDigest: digest("f"),
    calibrationReceiptDigest: digest("e"),
  });
  const changedNovel = buildCacheIdentity({
    phase: "novel",
    ...common,
    rawDigest: digest("c"),
    matchDigest: changedMatch.digest,
    claimsDigest: digest("f"),
    calibrationReceiptDigest: digest("e"),
  });
  assert.notEqual(novel.digest, changedNovel.digest);
  const changedClaims = buildCacheIdentity({
    phase: "novel",
    ...common,
    rawDigest: digest("c"),
    matchDigest: match.digest,
    claimsDigest: digest("0"),
    calibrationReceiptDigest: digest("e"),
  });
  assert.notEqual(novel.digest, changedClaims.digest);
  assert.equal(Object.hasOwn(raw, "raw_digest"), false);
  assert.equal(Object.hasOwn(match, "match_digest"), false);
  assert.equal(novel.match_digest, match.digest);
});

test("incumbent raw artifacts are shared only inside one exact campaign", () => {
  const plan = makePlan({ candidateCount: 2 });
  const common = {
    phase: "raw",
    plan,
    stage: "screen",
    pr: 1990,
    treatment: "incumbent",
  };
  const first = buildCacheIdentity({
    ...common,
    candidateId: "candidate-1",
  });
  const second = buildCacheIdentity({
    ...common,
    candidateId: "candidate-2",
  });
  assert.equal(first.comparison_id, "shared-incumbent");
  assert.equal(first.digest, second.digest);

  const candidate = buildCacheIdentity({
    ...common,
    candidateId: "candidate-1",
    treatment: "candidate",
  });
  assert.notEqual(first.digest, candidate.digest);
});

test("candidate 2 accepts a candidate-neutral incumbent cache written by candidate 1", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-shared-incumbent-"),
  );
  try {
    const plan = makePlan({ candidateCount: 2 });
    const candidateOneRecords = writeCachedStageRecords({
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      artifactRoot,
      summaries: passingScreen(),
    });
    const candidateOneRecord = candidateOneRecords.find(
      (record) => record.pr === 1990 && record.treatment === "incumbent",
    );
    assert.ok(candidateOneRecord);
    const raw = JSON.parse(
      readFileSync(candidateOneRecord.artifacts.raw, "utf8"),
    );
    assert.equal(raw.comparison_id, "shared-incumbent");
    assert.equal(raw.identity.comparison_id, "shared-incumbent");

    const candidateTwoLane = plan.candidate_plans
      .find((candidate) => candidate.candidate_id === "candidate-2")
      .stages.screen.lanes.find((lane) => lane.pr === candidateOneRecord.pr);
    const candidateTwoArm = candidateTwoLane.sequence.find(
      (arm) => arm.treatment === "incumbent",
    );
    const candidateTwoIdentity = buildCacheIdentity({
      phase: "raw",
      plan,
      candidateId: "candidate-2",
      stage: "screen",
      pr: candidateOneRecord.pr,
      treatment: "incumbent",
    });
    assert.equal(candidateTwoIdentity.digest, raw.identity.digest);

    const candidateTwoRecord = {
      ...candidateOneRecord,
      candidate_id: "candidate-2",
      cell_id: candidateTwoArm.canonical_cell_id,
      fingerprint: candidateTwoArm.execution_fingerprint,
    };
    assert.equal(
      validateExperimentRecordCaches({
        plan,
        candidateId: "candidate-2",
        records: [candidateTwoRecord],
        artifactRoot,
        calibrationReceiptDigest: digest("d"),
      }),
      true,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("live-paired cache identity binds its finder artifact", () => {
  const plan = makePlan({ includeLivePaired: true });
  const stage = plan.candidate_plans[0].stages["live-paired"];
  assert.equal(stage.enabled, true);
  assert.ok(stage.lanes.every((lane) => lane.source.kind === "live-finder"));
  const common = {
    phase: "raw",
    plan,
    candidateId: "candidate-1",
    stage: "live-paired",
    pr: 1990,
    treatment: "candidate",
  };
  assert.throws(
    () => buildCacheIdentity(common),
    /finderArtifactDigest must be a lowercase sha256/,
  );
  const first = buildCacheIdentity({
    ...common,
    finderArtifactDigest: digest("c"),
  });
  const second = buildCacheIdentity({
    ...common,
    finderArtifactDigest: digest("d"),
  });
  assert.notEqual(first.digest, second.digest);
});

test("calibration reuse requires exact identity and expires after six hours", () => {
  const expectedIdentity = makePlan().calibration_identity;
  const completedAt = "2026-09-01T09:00:00.000Z";
  const artifact = {
    identity: expectedIdentity,
    completed_at: completedAt,
    outcomes: [{ id: 1, verdict: "matched" }],
  };
  assert.equal(
    calibrationReuseDecision({
      artifact,
      expectedIdentity,
      now: new Date(Date.parse(completedAt) + CALIBRATION_MAX_AGE_MS),
    }).reuse,
    true,
  );
  assert.match(
    calibrationReuseDecision({
      artifact,
      expectedIdentity,
      now: new Date(Date.parse(completedAt) + CALIBRATION_MAX_AGE_MS + 1),
    }).reason,
    /older than 6 hours/,
  );
  assert.equal(
    calibrationReuseDecision({
      artifact,
      expectedIdentity: { ...expectedIdentity, matcher_digest: digest("f") },
      now: completedAt,
    }).reuse,
    false,
  );
  assert.equal(
    assertExperimentCalibrationCovers({
      artifact,
      requiredValidUntil: Date.parse(completedAt) + CALIBRATION_MAX_AGE_MS,
    }),
    Date.parse(completedAt) + CALIBRATION_MAX_AGE_MS,
  );
  assert.throws(
    () =>
      assertExperimentCalibrationCovers({
        artifact,
        requiredValidUntil:
          Date.parse(completedAt) + CALIBRATION_MAX_AGE_MS + 1,
      }),
    /expires before the stage deadline/,
  );
  const calibrationExpiry = Date.parse(completedAt) + CALIBRATION_MAX_AGE_MS;
  assert.deepEqual(
    calibrationBoundedStageDeadline({
      stageDeadlineMs: calibrationExpiry + 60_000,
      calibrationArtifact: artifact,
      now: Date.parse(completedAt) + 1,
    }),
    { deadlineMs: calibrationExpiry, calibrationLimited: true },
  );
  assert.deepEqual(
    calibrationBoundedStageDeadline({
      stageDeadlineMs: calibrationExpiry - 60_000,
      calibrationArtifact: artifact,
      now: Date.parse(completedAt) + 1,
    }),
    {
      deadlineMs: calibrationExpiry - 60_000,
      calibrationLimited: false,
    },
  );
  assert.throws(
    () =>
      calibrationBoundedStageDeadline({
        stageDeadlineMs: calibrationExpiry + 1,
        calibrationArtifact: artifact,
        now: calibrationExpiry,
      }),
    /no execution time remaining/,
  );
});

test("experiment artifacts cannot target the repository or escape their root", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-artifacts-"),
  );
  try {
    assert.equal(
      assertExperimentArtifactRoot({ repoRoot, artifactRoot }),
      realpathSync(artifactRoot),
    );
    assert.equal(
      resolveExperimentArtifactPath({
        artifactRoot,
        relativePath: "candidate-1/screen/attempt-1.json",
      }),
      path.join(
        realpathSync(artifactRoot),
        "candidate-1/screen/attempt-1.json",
      ),
    );
    assert.throws(
      () =>
        resolveExperimentArtifactPath({
          artifactRoot,
          relativePath: "../review-skill-ledger.jsonl",
        }),
      /escapes its root/,
    );

    for (const forbidden of [
      path.join(repoRoot, "docs/evals/review-skill-ledger.jsonl"),
      path.join(repoRoot, "docs/evals/review-skill-runs/experiment"),
      path.join(repoRoot, "docs/evals/review-skill-experiments"),
    ]) {
      assert.throws(
        () =>
          assertExperimentArtifactRoot({ repoRoot, artifactRoot: forbidden }),
        /outside the repository/,
      );
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("screen advances only when every recall threshold passes", () => {
  const passed = decide({ recordsByStage: { screen: passingScreen() } });
  assert.equal(passed.status, "PROMISING");
  assert.deepEqual(passed.metrics.known, {
    incumbent: 5,
    candidate: 7,
    net: 2,
  });
  assert.deepEqual(passed.metrics.p1, {
    incumbent: 2,
    candidate: 5,
    net: 3,
  });
  assert.equal(passed.metrics.nonnegative_prs, 2);
  assert.deepEqual(passed.novelty, {
    required: false,
    deferred: true,
    reason: "no material claim inflation requires novel classification",
  });

  const oneKnownShort = structuredClone(passingScreen());
  oneKnownShort
    .find((record) => record.pr === 1999 && record.treatment === "candidate")
    .matched_ids.pop();
  assert.equal(
    decide({ recordsByStage: { screen: oneKnownShort } }).status,
    "INCONCLUSIVE",
  );

  const oneNonnegativePr = recordsFromSpecs([
    {
      pr: 1990,
      incumbent: { known: 1, p1: 0 },
      candidate: { known: 5, p1: 2 },
    },
    {
      pr: 1995,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 1999,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
  ]);
  const spread = decide({ recordsByStage: { screen: oneNonnegativePr } });
  assert.equal(spread.metrics.known.net, 2);
  assert.equal(spread.metrics.nonnegative_prs, 1);
  assert.equal(spread.status, "INCONCLUSIVE");
});

test("screen rejects clear known and P1 regressions", () => {
  const knownRegression = recordsFromSpecs([
    {
      pr: 1990,
      incumbent: { known: 1, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 1995,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 1999,
      incumbent: { known: 2, p1: 0 },
      candidate: { known: 1, p1: 0 },
    },
  ]);
  const known = decide({ recordsByStage: { screen: knownRegression } });
  assert.equal(known.metrics.known.net, -2);
  assert.equal(known.status, "REJECT");

  const p1Regression = recordsFromSpecs([
    {
      pr: 1990,
      incumbent: { known: 1, p1: 1 },
      candidate: { known: 4, p1: 3 },
    },
    {
      pr: 1995,
      incumbent: { known: 2, p1: 1 },
      candidate: { known: 1, p1: 0 },
    },
    {
      pr: 1999,
      incumbent: { known: 2, p1: 2 },
      candidate: { known: 2, p1: 0 },
    },
  ]);
  const p1 = decide({ recordsByStage: { screen: p1Regression } });
  assert.equal(p1.metrics.known.net, 2);
  assert.equal(p1.metrics.p1.net, -1);
  assert.equal(p1.status, "REJECT");
});

test("novel scoring stays absent until recall or inflation requires it", () => {
  const screen = passingScreen();
  assert.ok(screen.every((record) => !Object.hasOwn(record, "wrong_claims")));
  const deferred = decide({ recordsByStage: { screen } });
  assert.equal(deferred.status, "PROMISING");
  assert.equal(deferred.metrics.wrong_claims.complete, false);
  assert.equal(deferred.metrics.wrong_claims.incumbent, null);
  assert.equal(deferred.metrics.wrong_claims.candidate, null);
  assert.doesNotMatch(JSON.stringify(deferred.metrics), /"wrong_claims":0/);

  assert.equal(
    claimInflationRequiresNovelty({
      incumbentClaims: 10,
      candidateClaims: 12,
      policy: makePlan().policy,
    }).required,
    false,
  );
  assert.equal(
    claimInflationRequiresNovelty({
      incumbentClaims: 10,
      candidateClaims: 13,
      policy: makePlan().policy,
    }).required,
    true,
  );
  assert.equal(
    claimInflationRequiresNovelty({
      incumbentClaims: 20,
      candidateClaims: 23,
      policy: makePlan().policy,
    }).required,
    false,
  );

  const inflated = structuredClone(screen);
  inflated.find(
    (record) => record.pr === 1990 && record.treatment === "candidate",
  ).claims_count += 1;
  const needsNovelty = decide({ recordsByStage: { screen: inflated } });
  assert.equal(needsNovelty.status, "INCONCLUSIVE");
  assert.equal(needsNovelty.novelty.required, true);
  assert.equal(needsNovelty.novelty.deferred, true);

  const classified = inflated.map((record) => ({
    ...record,
    wrong_claims: 0,
  }));
  assert.equal(
    decide({ recordsByStage: { screen: classified } }).status,
    "PROMISING",
  );
  classified.find(
    (record) => record.pr === 1990 && record.treatment === "candidate",
  ).wrong_claims = 2;
  assert.equal(
    decide({ recordsByStage: { screen: classified } }).status,
    "REJECT",
  );
});

test("holdout uses both complementary panels and exact finalist thresholds", () => {
  const recordsByStage = passingCombinedRecords();
  const passed = decide({ stage: "holdout", recordsByStage });
  assert.equal(passed.status, "PROMISING");
  assert.equal(passed.metrics.known.net, 3);
  assert.equal(passed.metrics.p1.candidate, 9);
  assert.equal(passed.metrics.p1.net, 4);
  assert.equal(passed.metrics.gaining_prs, 2);
  assert.equal(passed.metrics.wrong_claims.net, 1);
  assert.deepEqual(
    passed.metrics.per_pr.map((row) => [row.pr, row.known.net]),
    [
      [1990, 0],
      [1995, 1],
      [1999, 2],
    ],
  );

  const knownShort = structuredClone(recordsByStage);
  const incumbent1999 = knownShort.holdout.find(
    (record) => record.pr === 1999 && record.treatment === "incumbent",
  );
  incumbent1999.matched_ids.push(
    fixtureByPr
      .get(1999)
      .scorable_ids.find((id) => !incumbent1999.matched_ids.includes(id)),
  );
  const known = decide({ stage: "holdout", recordsByStage: knownShort });
  assert.equal(known.metrics.known.net, 2);
  assert.equal(known.status, "INCONCLUSIVE");

  const p1Floor = structuredClone(recordsByStage);
  const candidate1990 = p1Floor.screen.find(
    (record) => record.pr === 1990 && record.treatment === "candidate",
  );
  const p1Set = new Set(fixtureByPr.get(1990).p1_ids);
  const replacement = fixtureByPr
    .get(1990)
    .scorable_ids.find(
      (id) => !p1Set.has(id) && !candidate1990.matched_ids.includes(id),
    );
  candidate1990.matched_ids[0] = replacement;
  const floor = decide({ stage: "holdout", recordsByStage: p1Floor });
  assert.equal(floor.metrics.p1.candidate, 8);
  assert.ok(floor.metrics.p1.net >= 2);
  assert.equal(floor.status, "INCONCLUSIVE");

  const p1Net = structuredClone(recordsByStage);
  for (const [stage, pr] of [
    ["screen", 1990],
    ["holdout", 1995],
    ["holdout", 1999],
  ]) {
    const record = p1Net[stage].find(
      (entry) => entry.pr === pr && entry.treatment === "incumbent",
    );
    const p1Id = fixtureByPr
      .get(pr)
      .p1_ids.find((id) => !record.matched_ids.includes(id));
    const ordinaryIndex = record.matched_ids.findIndex(
      (id) => !fixtureByPr.get(pr).p1_ids.includes(id),
    );
    record.matched_ids[ordinaryIndex] = p1Id;
  }
  const net = decide({ stage: "holdout", recordsByStage: p1Net });
  assert.equal(net.metrics.p1.candidate, 9);
  assert.equal(net.metrics.p1.net, 1);
  assert.equal(net.status, "INCONCLUSIVE");

  const narrow = structuredClone(recordsByStage);
  const narrow1995 = narrow.holdout.find(
    (record) => record.pr === 1995 && record.treatment === "candidate",
  );
  narrow1995.matched_ids.pop();
  const narrow1999 = narrow.holdout.find(
    (record) => record.pr === 1999 && record.treatment === "candidate",
  );
  for (const id of fixtureByPr.get(1999).scorable_ids) {
    if (
      !narrow1999.matched_ids.includes(id) &&
      narrow1999.matched_ids.length < 6
    ) {
      narrow1999.matched_ids.push(id);
    }
  }
  const spread = decide({ stage: "holdout", recordsByStage: narrow });
  assert.ok(spread.metrics.known.net >= 3);
  assert.equal(spread.metrics.gaining_prs, 1);
  assert.equal(spread.status, "INCONCLUSIVE");
});

test("holdout rejects a clear P1 regression or wrong-claim breach", () => {
  const p1Regression = passingCombinedRecords();
  for (const [stage, pr, targetP1] of [
    ["screen", 1990, 1],
    ["screen", 1999, 2],
    ["holdout", 1995, 1],
    ["holdout", 1999, 2],
  ]) {
    const record = p1Regression[stage].find(
      (entry) => entry.pr === pr && entry.treatment === "incumbent",
    );
    record.matched_ids = armRecord({
      pr,
      treatment: "incumbent",
      known: record.matched_ids.length,
      p1: targetP1,
    }).matched_ids;
  }
  const p1 = decide({ stage: "holdout", recordsByStage: p1Regression });
  assert.equal(p1.metrics.p1.net, -1);
  assert.equal(p1.status, "REJECT");

  const wrong = passingCombinedRecords();
  wrong.screen.find(
    (record) => record.pr === 1990 && record.treatment === "candidate",
  ).wrong_claims = 1;
  const breach = decide({ stage: "holdout", recordsByStage: wrong });
  assert.equal(breach.metrics.wrong_claims.net, 2);
  assert.equal(breach.status, "REJECT");
});

test("malformed and incumbent-invalid pairs are inconclusive", () => {
  const cases = [];

  const missing = passingScreen();
  missing.pop();
  cases.push(missing);

  const malformed = passingScreen();
  malformed[0].malformed = true;
  cases.push(malformed);

  const badId = passingScreen();
  badId[0].matched_ids.push(999_999_999);
  cases.push(badId);

  const incumbentLeak = passingScreen();
  incumbentLeak.find((record) => record.treatment === "incumbent").leak = {
    suspected: true,
  };
  cases.push(incumbentLeak);

  const incumbentEmpty = passingScreen();
  const empty = incumbentEmpty.find(
    (record) => record.treatment === "incumbent",
  );
  empty.empty = true;
  empty.claims_count = 0;
  cases.push(incumbentEmpty);

  for (const records of cases) {
    assert.equal(
      decide({ recordsByStage: { screen: records } }).status,
      "INCONCLUSIVE",
    );
  }
});

test("candidate leak and empty output reject the experiment", () => {
  const leaked = passingScreen();
  leaked.find((record) => record.treatment === "candidate").leak = true;
  assert.equal(decide({ recordsByStage: { screen: leaked } }).status, "REJECT");

  const emptyRecords = passingScreen();
  const empty = emptyRecords.find((record) => record.treatment === "candidate");
  empty.empty = true;
  empty.claims_count = 0;
  assert.equal(
    decide({ recordsByStage: { screen: emptyRecords } }).status,
    "REJECT",
  );
});

test("the injected runner caps lane concurrency and keeps each pair sequential", async () => {
  const plan = makePlan();
  let activeLanes = 0;
  let maximumActiveLanes = 0;
  const activeByPr = new Map();
  const eventsByPr = new Map();
  const execute = async ({ lane, arm }) => {
    activeLanes += 1;
    maximumActiveLanes = Math.max(maximumActiveLanes, activeLanes);
    activeByPr.set(lane.pr, (activeByPr.get(lane.pr) ?? 0) + 1);
    assert.equal(activeByPr.get(lane.pr), 1, `PR ${lane.pr} arms overlapped`);
    const events = eventsByPr.get(lane.pr) ?? [];
    events.push(`start:${arm.treatment}`);
    eventsByPr.set(lane.pr, events);
    await new Promise((resolve) => queueMicrotask(resolve));
    events.push(`end:${arm.treatment}`);
    activeByPr.set(lane.pr, activeByPr.get(lane.pr) - 1);
    activeLanes -= 1;
    return {
      ok: true,
      pr: lane.pr,
      treatment: arm.treatment,
      claims_count: 1,
      matched_ids: [],
    };
  };
  const result = await runExperimentStage({
    plan,
    candidateId: "candidate-1",
    stage: "screen",
    execute,
    concurrency: 3,
  });
  assert.equal(maximumActiveLanes, 3);
  assert.equal(result.records.length, 6);
  for (const lane of result.lanes) {
    assert.deepEqual(
      eventsByPr.get(lane.pr),
      lane.sequence.flatMap((arm) => [`start:${arm}`, `end:${arm}`]),
    );
  }
  await assert.rejects(
    runExperimentStage({
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      execute,
      concurrency: 4,
    }),
    /concurrency must be 1\.\.3/,
  );
});

test("dry-run calls no executor and run artifacts fail closed", async () => {
  const plan = makePlan();
  let calls = 0;
  const dry = await runExperimentStage({
    plan,
    candidateId: "candidate-1",
    stage: "screen",
    dryRun: true,
    execute: async () => {
      calls += 1;
      throw new Error("paid executor must not run");
    },
  });
  assert.equal(calls, 0);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.records.length, 0);

  await assert.rejects(
    runExperimentStage({
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      execute: async ({ lane, arm }) => ({
        ok: true,
        pr: lane.pr,
        treatment: arm.treatment,
      }),
    }),
    /incomplete or mismatched artifact/,
  );
  await assert.rejects(
    runExperimentStage({
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      execute: async ({ lane, arm }) => ({
        ok: true,
        pr: lane.pr,
        treatment: arm.treatment,
        claims_count: 1,
        matched_ids: [],
        malformed: true,
      }),
    }),
    /incomplete or mismatched artifact/,
  );
});

test("calibration completes on the post-run clock and refreshes an expired receipt", async () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-calibration-"),
  );
  try {
    const plan = makePlan({
      identityOverrides: { calibration_digest: calibrationDigest },
    });
    let clockValue = Date.parse("2026-09-01T09:00:00.000Z");
    const firstCompleted = "2026-09-01T09:05:00.000Z";
    const first = await ensureExperimentCalibration({
      plan,
      artifactRoot,
      repoRoot,
      calibrationPath,
      clock: () => new Date(clockValue),
      exec: fakeCalibrationExec({
        onCall: () => {
          clockValue = Date.parse(firstCompleted);
        },
      }),
    });
    assert.equal(first.reused, false);
    assert.equal(first.artifact.completed_at, firstCompleted);
    assert.equal(first.artifact.agreement, 40);
    assert.equal(first.artifact.total, 40);

    clockValue = Date.parse(firstCompleted) + CALIBRATION_MAX_AGE_MS + 1;
    const refreshedAt = "2026-09-01T15:10:00.000Z";
    const refreshed = await ensureExperimentCalibration({
      plan,
      artifactRoot,
      repoRoot,
      calibrationPath,
      clock: () => new Date(clockValue),
      exec: fakeCalibrationExec({
        onCall: () => {
          clockValue = Date.parse(refreshedAt);
        },
      }),
    });
    assert.equal(refreshed.reused, false);
    assert.notEqual(refreshed.file, first.file);
    assert.equal(existsSync(first.file), true);
    assert.equal(refreshed.artifact.completed_at, refreshedAt);
    assert.notEqual(
      refreshed.artifact.receipt_digest,
      first.artifact.receipt_digest,
    );
    assert.equal(
      JSON.parse(readFileSync(refreshed.file, "utf8")).receipt_digest,
      refreshed.artifact.receipt_digest,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("calibration refuses low agreement instead of caching a receipt", async () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-low-calibration-"),
  );
  try {
    const plan = makePlan({
      identityOverrides: { calibration_digest: calibrationDigest },
    });
    await assert.rejects(
      ensureExperimentCalibration({
        plan,
        artifactRoot,
        repoRoot,
        calibrationPath,
        clock: () => new Date("2026-09-01T09:00:00.000Z"),
        exec: fakeCalibrationExec({ correct: false }),
      }),
      /calibration 0\/40 is below 35\/40/,
    );
    const receiptDirectory = path.join(
      realpathSync(artifactRoot),
      "cache/calibration",
      digestObject(plan.calibration_identity),
    );
    assert.equal(existsSync(receiptDirectory), true);
    assert.deepEqual(readdirSync(receiptDirectory), []);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("campaign expiry between cache write and publication leaves no receipt", async () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-expiry-write-"),
  );
  try {
    const plan = makePlan({
      identityOverrides: { calibration_digest: calibrationDigest },
    });
    const deadline = Date.parse(plan.planned_at) + CAMPAIGN_MAX_AGE_MS;
    let guardChecks = 0;
    const beforeWrite = () => {
      const now = new Date(deadline + (guardChecks < 2 ? -1 : 1));
      guardChecks += 1;
      assertExperimentCampaignFresh({ plan, now });
    };
    await assert.rejects(
      ensureExperimentCalibration({
        plan,
        artifactRoot,
        repoRoot,
        calibrationPath,
        clock: () => new Date(plannedAt),
        exec: fakeCalibrationExec(),
        beforeWrite,
      }),
      /older than 6 hours/,
    );
    assert.equal(guardChecks, 3);
    const receiptDirectory = path.join(
      realpathSync(artifactRoot),
      "cache/calibration",
      digestObject(plan.calibration_identity),
    );
    assert.equal(existsSync(receiptDirectory), true);
    assert.deepEqual(readdirSync(receiptDirectory), []);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("a cached first-pass arm record omits deferred wrong-claim evidence", async () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-deferred-arm-"),
  );
  try {
    const plan = makePlan();
    const lane = plan.candidate_plans[0].stages.screen.lanes[0];
    const arm = lane.sequence[0];
    const rawIdentity = buildCacheIdentity({
      phase: "raw",
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      pr: lane.pr,
      treatment: arm.treatment,
    });
    const rawBase = {
      schema_version: 1,
      namespace: plan.namespace,
      identity: rawIdentity,
      campaign_id: plan.campaign_id,
      comparison_id: rawIdentity.comparison_id,
      stage: "screen",
      attempt: 1,
      cell_id: arm.canonical_cell_id,
      pr: lane.pr,
      treatment: arm.treatment,
      fingerprint: arm.execution_fingerprint,
      ok: true,
      output: "A deterministic cached review claim.",
    };
    const raw = { ...rawBase, raw_digest: digestObject(rawBase) };
    writeJsonArtifact(
      path.join(artifactRoot, `cache/raw/${rawIdentity.digest}.json`),
      raw,
    );
    const calibrationReceipt = { receipt_digest: digest("d") };
    const matchIdentity = buildCacheIdentity({
      phase: "match",
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      pr: lane.pr,
      treatment: arm.treatment,
      rawDigest: raw.raw_digest,
      calibrationReceiptDigest: calibrationReceipt.receipt_digest,
    });
    const cachedClaims = ["A deterministic cached review claim."];
    const matchBase = {
      schema_version: 1,
      namespace: plan.namespace,
      identity: matchIdentity,
      raw_digest: raw.raw_digest,
      claims_digest: digestObject(cachedClaims),
      claims: cachedClaims,
      matched_ids: [],
      judge_reasoning: {},
      leak: { suspected: false, hard: [], advisory: [] },
    };
    const match = { ...matchBase, match_digest: digestObject(matchBase) };
    writeJsonArtifact(
      path.join(artifactRoot, `cache/match/${matchIdentity.digest}.json`),
      match,
    );
    const execute = createExperimentArmExecutor({
      plan,
      contract,
      artifactRoot,
      repoRoot,
      fixtureCacheDir: path.join(artifactRoot, "fixtures"),
      sourceSeal: {
        manifest: { plan_digest: plan.plan_digest },
        finder_reports: {
          [lane.source.file]: readFileSync(
            path.join(repoRoot, lane.source.file),
            "utf8",
          ),
        },
        truth_by_pr: {},
        skill_snapshots: {},
      },
      calibrationReceipt,
      runCommand: async () => {
        throw new Error("contestant executor must not run for an exact cache");
      },
      judgeExec: async () => {
        throw new Error("judge executor must not run for an exact cache");
      },
    });
    const record = await execute({
      candidateId: "candidate-1",
      stage: "screen",
      attempt: 1,
      lane,
      arm,
    });
    assert.equal(record.claims_count, 1);
    assert.equal(Object.hasOwn(record, "wrong_claims"), false);
    assert.equal(Object.hasOwn(record, "novel_real"), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("runtime identity drift fails before a paid executor can be constructed", () => {
  const plan = makePlan({
    identityOverrides: { judge: { ...contract.judge } },
  });
  const promptDigests = { ...plan.calibration_identity.prompts };
  const exact = {
    plan,
    contract,
    contractDigest: plan.contract_digest,
    identities: { ...plan.identities },
    promptDigests,
  };
  assert.equal(assertExperimentRuntimeIdentity(exact), true);

  let executorCalls = 0;
  const constructExecutor = (runtime) => {
    assertExperimentRuntimeIdentity(runtime);
    executorCalls += 1;
  };
  assert.throws(
    () =>
      constructExecutor({
        ...exact,
        identities: {
          ...exact.identities,
          matcher_digest: digest("f"),
        },
      }),
    /matcher_digest drifted/,
  );
  assert.throws(
    () =>
      constructExecutor({
        ...exact,
        promptDigests: { ...promptDigests, handoff: digest("0") },
      }),
    /handoff prompt digest drifted/,
  );
  assert.equal(executorCalls, 0);
});

test("plan validation binds the committed contract byte digest", () => {
  const plan = buildExperimentPlan({
    contract,
    contractDigest: actualContractDigest,
    plannedAt,
    incumbent: treatment("incumbent", "b"),
    candidates: [treatment("candidate-1", "6")],
    identities,
  });
  assert.equal(
    validateExperimentPlan({
      plan,
      contract,
      contractDigest: actualContractDigest,
    }).ok,
    true,
  );

  const changed = validateExperimentPlan({
    plan,
    contract,
    contractDigest: digest("f"),
  });
  assert.equal(changed.ok, false);
  assert.match(changed.problems.join("\n"), /contract digest differs/);
});

test("campaign freshness includes six hours exactly and refuses the next millisecond", () => {
  const plan = makePlan();
  const planned = Date.parse(plan.planned_at);
  assert.equal(CAMPAIGN_MAX_AGE_MS, 6 * 60 * 60 * 1000);
  assert.equal(
    assertExperimentCampaignFresh({
      plan,
      now: new Date(planned + CAMPAIGN_MAX_AGE_MS),
    }),
    true,
  );
  assert.throws(
    () =>
      assertExperimentCampaignFresh({
        plan,
        now: new Date(planned + CAMPAIGN_MAX_AGE_MS + 1),
      }),
    /older than 6 hours/,
  );
  assert.throws(
    () =>
      assertExperimentCampaignFresh({
        plan,
        now: new Date(planned - 1),
      }),
    /future-dated/,
  );
});

test("stage deadlines stay fixed when the timer arms after the start sample", () => {
  const plan = makePlan();
  const plannedMs = Date.parse(plan.planned_at);
  const stageLimitedStart = new Date(plannedMs + 30 * 60 * 1000).toISOString();
  assert.deepEqual(
    absoluteExperimentStageDeadline({ plan, startedAt: stageLimitedStart }),
    {
      deadlineMs: Date.parse(stageLimitedStart) + EXPERIMENT_STAGE_TIMEOUT_MS,
      campaignLimited: false,
    },
  );

  const campaignLimitedStart = new Date(
    plannedMs + 4 * 60 * 60 * 1000,
  ).toISOString();
  const deadline = absoluteExperimentStageDeadline({
    plan,
    startedAt: campaignLimitedStart,
  });
  const campaignDeadlineMs = plannedMs + CAMPAIGN_MAX_AGE_MS;
  assert.deepEqual(deadline, {
    deadlineMs: campaignDeadlineMs,
    campaignLimited: true,
  });
  const timerArmedAt = Date.parse(campaignLimitedStart) + 12_345;
  const relativeDelay = deadline.deadlineMs - timerArmedAt;
  assert.equal(timerArmedAt + relativeDelay, campaignDeadlineMs);
});

test("stage retry eligibility distinguishes failure, crash, completion, and active ownership", () => {
  assert.deepEqual(stageRetryDecision({ started: true, failed: true }), {
    retry: true,
    reason: "attempt 1 recorded a failure",
  });
  assert.equal(
    stageRetryDecision({ started: true, ownerActive: false }).retry,
    true,
  );
  assert.equal(
    stageRetryDecision({ started: true, ownerActive: true }).retry,
    false,
  );
  assert.equal(
    stageRetryDecision({
      started: true,
      baseDecision: { novelty: { required: false, deferred: false } },
    }).retry,
    false,
  );
  assert.equal(
    stageRetryDecision({
      started: true,
      baseDecision: { novelty: { required: true, deferred: true } },
    }).retry,
    true,
  );
  assert.equal(
    stageRetryDecision({
      started: true,
      baseDecision: { novelty: { required: true, deferred: true } },
      novelDecision: { status: "PROMISING" },
    }).retry,
    false,
  );
  assert.equal(stageRetryDecision({}).retry, false);
});

test("campaign run locks reject contention and fail closed on a dead owner", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-lock-"),
  );
  try {
    const first = acquireExperimentRunLock({
      artifactRoot,
      owner: { pid: 101, host: "lock-test-host" },
      isPidAlive: () => true,
      token: ownerMarker("first"),
    });
    assert.throws(
      () =>
        acquireExperimentRunLock({
          artifactRoot,
          owner: { pid: 202, host: "lock-test-host" },
          isPidAlive: () => true,
          token: ownerMarker("contending"),
        }),
      /already running as pid 101/,
    );
    assert.equal(releaseExperimentRunLock(first), true);

    writeJsonArtifact(path.join(artifactRoot, "run.lock"), {
      pid: 303,
      host: "lock-test-host",
      token: ownerMarker("dead"),
    });
    assert.throws(
      () =>
        acquireExperimentRunLock({
          artifactRoot,
          owner: { pid: 404, host: "lock-test-host" },
          isPidAlive: () => false,
          token: ownerMarker("replacement"),
        }),
      /stale owner.*fails closed.*lineage cannot be proven settled/,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(artifactRoot, "run.lock"), "utf8")),
      { pid: 303, host: "lock-test-host", token: ownerMarker("dead") },
    );
    assert.equal(existsSync(path.join(artifactRoot, "locks")), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("artifact and fixture roots stay disjoint through nesting and symlinks", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-disjoint-"),
  );
  try {
    const artifactRoot = path.join(root, "artifacts");
    const fixtureRoot = path.join(root, "fixtures");
    mkdirSync(artifactRoot);
    mkdirSync(fixtureRoot);
    assert.deepEqual(
      assertDisjointExperimentRoots({ artifactRoot, fixtureRoot }),
      {
        artifact: realpathSync(artifactRoot),
        fixture: realpathSync(fixtureRoot),
      },
    );
    assert.throws(
      () =>
        assertDisjointExperimentRoots({
          artifactRoot,
          fixtureRoot: path.join(artifactRoot, "nested-fixtures"),
        }),
      /must be disjoint/,
    );
    assert.throws(
      () =>
        assertDisjointExperimentRoots({
          artifactRoot: path.join(fixtureRoot, "nested-artifacts"),
          fixtureRoot,
        }),
      /must be disjoint/,
    );

    const linkedTarget = path.join(artifactRoot, "linked-fixtures");
    const linkedFixtureRoot = path.join(root, "linked-fixture-root");
    mkdirSync(linkedTarget);
    symlinkSync(linkedTarget, linkedFixtureRoot, "dir");
    assert.throws(
      () =>
        assertDisjointExperimentRoots({
          artifactRoot,
          fixtureRoot: linkedFixtureRoot,
        }),
      /must be disjoint/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "plan publication is atomic for identical and conflicting process writers",
  { timeout: 15_000 },
  async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "review-eval-experiment-plan-race-"),
    );
    const moduleUrl = pathToFileURL(
      path.join(repoRoot, "scripts/review/review-eval-experiment-evidence.mjs"),
    ).href;
    const workerSource = `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const [moduleUrl, repoRoot, artifactRoot, planFile, barrier, ready] = process.argv.slice(1);
      const { writeExperimentPlan } = await import(moduleUrl);
      writeFileSync(ready, "ready", { flag: "wx" });
      const deadline = Date.now() + 5000;
      while (!existsSync(barrier) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!existsSync(barrier)) throw new Error("plan race barrier timed out");
      try {
        writeExperimentPlan({
          plan: JSON.parse(readFileSync(planFile, "utf8")),
          artifactRoot,
          repoRoot,
        });
      } catch (error) {
        console.error(error.message);
        process.exitCode = 2;
      }
    `;

    const race = async ({ name, leftPlan, rightPlan }) => {
      const artifactRoot = path.join(root, name);
      mkdirSync(artifactRoot);
      const leftFile = path.join(root, `${name}-left.json`);
      const rightFile = path.join(root, `${name}-right.json`);
      const barrier = path.join(root, `${name}-go`);
      const leftReady = path.join(root, `${name}-left-ready`);
      const rightReady = path.join(root, `${name}-right-ready`);
      writeJsonArtifact(leftFile, leftPlan);
      writeJsonArtifact(rightFile, rightPlan);
      const left = runNodeWorker(workerSource, [
        moduleUrl,
        repoRoot,
        artifactRoot,
        leftFile,
        barrier,
        leftReady,
      ]);
      const right = runNodeWorker(workerSource, [
        moduleUrl,
        repoRoot,
        artifactRoot,
        rightFile,
        barrier,
        rightReady,
      ]);
      await waitUntil(
        () => existsSync(leftReady) && existsSync(rightReady),
        `${name} plan writers`,
      );
      writeFileSync(barrier, "go", { flag: "wx" });
      return {
        artifactRoot,
        results: await Promise.all([left, right]),
      };
    };

    try {
      const plan = makePlan();
      const identical = await race({
        name: "identical",
        leftPlan: plan,
        rightPlan: plan,
      });
      assert.deepEqual(
        identical.results.map((result) => result.code).sort(),
        [0, 0],
      );
      assert.deepEqual(
        JSON.parse(
          readFileSync(path.join(identical.artifactRoot, "plan.json"), "utf8"),
        ),
        plan,
      );
      assert.deepEqual(
        readdirSync(identical.artifactRoot).filter((file) =>
          file.endsWith(".tmp"),
        ),
        [],
      );

      const otherPlan = makePlan({
        identityOverrides: { experiment_digest: digest("e") },
      });
      const conflicting = await race({
        name: "conflicting",
        leftPlan: plan,
        rightPlan: otherPlan,
      });
      assert.deepEqual(
        conflicting.results.map((result) => result.code).sort(),
        [0, 2],
      );
      assert.equal(
        conflicting.results.some((result) =>
          /different campaign plan/.test(result.stderr),
        ),
        true,
      );
      const published = JSON.parse(
        readFileSync(path.join(conflicting.artifactRoot, "plan.json"), "utf8"),
      );
      assert.equal(
        [plan.plan_digest, otherPlan.plan_digest].includes(
          published.plan_digest,
        ),
        true,
      );
      assert.deepEqual(
        readdirSync(conflicting.artifactRoot).filter((file) =>
          file.endsWith(".tmp"),
        ),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("live finder handoff retains the final 30,000 bytes and binds both forms", () => {
  const prefix = "finder-prefix:";
  const tail = "x".repeat(30_000);
  const handoff = liveFinderHandoff(`${prefix}${tail}`);
  assert.equal(handoff.raw_bytes, Buffer.byteLength(prefix) + 30_000);
  assert.equal(handoff.delivered_bytes, 30_000);
  assert.equal(handoff.delivered, tail);
  assert.notEqual(handoff.raw_digest, handoff.delivered_digest);

  const exact = liveFinderHandoff(tail);
  assert.equal(exact.delivered, tail);
  assert.equal(exact.raw_digest, exact.delivered_digest);
});

test("live finder handoff does not split a UTF-8 code point", () => {
  const tail = "x".repeat(29_998);
  const raw = `ab😀${tail}`;
  const naiveStart = Buffer.byteLength(raw) - 30_000;
  assert.equal((Buffer.from(raw)[naiveStart] & 0xc0) === 0x80, true);

  const handoff = liveFinderHandoff(raw);
  assert.equal(handoff.delivered, tail);
  assert.equal(handoff.delivered_bytes, 29_998);
  assert.equal(handoff.delivered.includes("\uFFFD"), false);
  assert.equal(
    Buffer.from(raw)
      .subarray(-handoff.delivered_bytes)
      .equals(Buffer.from(handoff.delivered)),
    true,
  );
});

test(
  "aborting a spawned process cleans up its detached descendant group",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "review-eval-experiment-process-group-"),
    );
    const pidFile = path.join(root, "pids.json");
    const controller = new AbortController();
    let pids = [];
    const parentSource = `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const grandchild = spawn(process.execPath, [
        "--eval",
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
      ], { stdio: "ignore" });
      writeFileSync(process.env.EXPERIMENT_TEST_PID_FILE, JSON.stringify([process.pid, grandchild.pid]));
      process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25));
      setInterval(() => {}, 1000);
    `;
    const operation = spawnExperimentProcess({
      file: process.execPath,
      args: ["--input-type=module", "--eval", parentSource],
      cwd: root,
      env: { ...process.env, EXPERIMENT_TEST_PID_FILE: pidFile },
      timeoutMs: 8_000,
      signal: controller.signal,
    });
    try {
      await waitUntil(() => existsSync(pidFile), "process-group pid receipt");
      pids = JSON.parse(readFileSync(pidFile, "utf8"));
      assert.equal(pids.length, 2);
      assert.equal(
        pids.every((pid) => pidIsAlive(pid)),
        true,
      );
      controller.abort(new Error("test abort cleanup"));
      await assert.rejects(operation, /test abort cleanup/);
      await drainExperimentProcesses();
      assert.equal(
        pids.some((pid) => pidIsAlive(pid)),
        false,
      );
    } finally {
      controller.abort(new Error("test cleanup"));
      await drainExperimentProcesses();
      for (const pid of pids) {
        if (!Number.isSafeInteger(pid) || pid < 2 || !pidIsAlive(pid)) continue;
        forceKillProcess(pid);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("sealed skill bytes stage from memory after the source changes", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-source-seal-"),
  );
  try {
    const incumbentRoot = path.join(root, "incumbent");
    const candidateRoot = path.join(root, "candidate");
    const artifactRoot = path.join(root, "artifacts");
    const fixtureRoot = path.join(root, "fixture");
    mkdirSync(path.join(incumbentRoot, "references"), { recursive: true });
    mkdirSync(path.join(candidateRoot, "references"), { recursive: true });
    mkdirSync(artifactRoot);
    mkdirSync(fixtureRoot);
    writeFileSync(
      path.join(incumbentRoot, "SKILL.md"),
      "---\nname: incumbent\n---\nOriginal incumbent instruction.\n",
    );
    writeFileSync(
      path.join(incumbentRoot, "references", "guide.md"),
      "Original incumbent reference.\n",
    );
    const originalSkill =
      "---\nname: candidate\n---\nOriginal candidate instruction.\n";
    const originalReference = "Original candidate reference.\n";
    writeFileSync(path.join(candidateRoot, "SKILL.md"), originalSkill);
    writeFileSync(
      path.join(candidateRoot, "references", "guide.md"),
      originalReference,
    );

    const plan = buildExperimentPlan({
      contract,
      contractDigest: actualContractDigest,
      plannedAt,
      incumbent: {
        skill_ref: incumbentRoot,
        skill_digest: experimentSkillDigest(incumbentRoot),
        canonical_skill_digest: skillDigest(incumbentRoot),
      },
      candidates: [
        {
          id: "candidate-1",
          skill_ref: candidateRoot,
          skill_digest: experimentSkillDigest(candidateRoot),
          canonical_skill_digest: skillDigest(candidateRoot),
        },
      ],
      identities: {
        ...identities,
        matcher_digest: scorerDigest(),
        calibration_digest: calibrationDigest,
        judge: { ...contract.judge },
      },
    });
    const candidateSkillFile = path.join(candidateRoot, "SKILL.md");
    const originalMode = statSync(candidateSkillFile).mode & 0o777;
    chmodSync(candidateSkillFile, originalMode ^ 0o100);
    assert.throws(
      () =>
        sealExperimentRuntimeSources({
          plan,
          contract,
          artifactRoot: path.join(root, "mode-change-artifacts"),
          repoRoot,
          calibrationPath,
        }),
      /candidate-1 skill changed after planning/,
    );
    chmodSync(candidateSkillFile, originalMode);
    const guardedArtifactRoot = path.join(root, "guarded-artifacts");
    mkdirSync(guardedArtifactRoot);
    const deadline = Date.parse(plan.planned_at) + CAMPAIGN_MAX_AGE_MS;
    let guardChecks = 0;
    assert.throws(
      () =>
        sealExperimentRuntimeSources({
          plan,
          contract,
          artifactRoot: guardedArtifactRoot,
          repoRoot,
          calibrationPath,
          beforeWrite: () => {
            const now = new Date(deadline + (guardChecks === 0 ? -1 : 1));
            guardChecks += 1;
            assertExperimentCampaignFresh({ plan, now });
          },
        }),
      /older than 6 hours/,
    );
    assert.equal(guardChecks, 2);
    const guardedSnapshotRoot = path.join(
      guardedArtifactRoot,
      "snapshots/runtime",
      plan.plan_digest,
    );
    assert.equal(existsSync(guardedSnapshotRoot), true);
    assert.deepEqual(readdirSync(guardedSnapshotRoot), []);

    const sourceSeal = sealExperimentRuntimeSources({
      plan,
      contract,
      artifactRoot,
      repoRoot,
      calibrationPath,
    });

    writeFileSync(
      path.join(candidateRoot, "SKILL.md"),
      "---\nname: candidate\n---\nMutated candidate instruction.\n",
    );
    writeFileSync(
      path.join(candidateRoot, "references", "guide.md"),
      "Mutated candidate reference.\n",
    );
    const preamble = stageExperimentSkill({
      fixturePath: fixtureRoot,
      snapshot: sourceSeal.skill_snapshots["candidate-1"],
    });
    assert.equal(
      readFileSync(path.join(fixtureRoot, ".skill", "SKILL.md"), "utf8"),
      originalSkill,
    );
    assert.equal(
      readFileSync(
        path.join(fixtureRoot, ".skill", "references", "guide.md"),
        "utf8",
      ),
      originalReference,
    );
    assert.match(preamble, /Original candidate instruction/);
    assert.doesNotMatch(preamble, /Mutated candidate instruction/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cached match validation detects claim tampering under a fresh outer digest", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-match-tamper-"),
  );
  try {
    const plan = makePlan();
    const lane = plan.candidate_plans[0].stages.screen.lanes[0];
    const arm = lane.sequence[0];
    const rawIdentity = buildCacheIdentity({
      phase: "raw",
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      pr: lane.pr,
      treatment: arm.treatment,
    });
    const rawBase = {
      schema_version: 1,
      namespace: plan.namespace,
      identity: rawIdentity,
      campaign_id: plan.campaign_id,
      comparison_id: rawIdentity.comparison_id,
      stage: "screen",
      attempt: 1,
      cell_id: arm.canonical_cell_id,
      pr: lane.pr,
      treatment: arm.treatment,
      fingerprint: arm.execution_fingerprint,
      ok: true,
      output: "Original cached review claim.",
    };
    const raw = { ...rawBase, raw_digest: digestObject(rawBase) };
    const rawFile = path.join(
      artifactRoot,
      `cache/raw/${rawIdentity.digest}.json`,
    );
    writeJsonArtifact(rawFile, raw);

    const matchIdentity = buildCacheIdentity({
      phase: "match",
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      pr: lane.pr,
      treatment: arm.treatment,
      rawDigest: raw.raw_digest,
      calibrationReceiptDigest: digest("d"),
    });
    const claims = ["Original cached review claim."];
    const matchBase = {
      schema_version: 1,
      namespace: plan.namespace,
      identity: matchIdentity,
      raw_digest: raw.raw_digest,
      claims,
      claims_digest: digestObject(claims),
      matched_ids: [],
      judge_reasoning: {},
      leak: { suspected: false, hard: [], advisory: [] },
    };
    const matched = {
      ...matchBase,
      match_digest: digestObject(matchBase),
    };
    const matchFile = path.join(
      artifactRoot,
      `cache/match/${matchIdentity.digest}.json`,
    );
    writeJsonArtifact(matchFile, matched);
    const record = {
      ok: true,
      campaign_id: plan.campaign_id,
      candidate_id: "candidate-1",
      stage: "screen",
      attempt: 1,
      cell_id: arm.canonical_cell_id,
      fingerprint: raw.fingerprint,
      pr: lane.pr,
      treatment: arm.treatment,
      output: raw.output,
      raw_digest: raw.raw_digest,
      match_digest: matched.match_digest,
      claims_digest: matched.claims_digest,
      claims_count: matched.claims.length,
      matched_ids: matched.matched_ids,
      leak: matched.leak,
      empty: false,
      artifacts: { raw: rawFile, match: matchFile },
    };
    assert.equal(
      validateExperimentRecordCaches({
        plan,
        candidateId: "candidate-1",
        records: [record],
        artifactRoot,
        calibrationReceiptDigest: digest("d"),
      }),
      true,
    );

    const tamperedBase = {
      ...matchBase,
      claims: ["Tampered cached review claim."],
    };
    const tampered = {
      ...tamperedBase,
      match_digest: digestObject(tamperedBase),
    };
    writeJsonArtifact(matchFile, tampered);
    record.match_digest = tampered.match_digest;
    assert.throws(
      () =>
        validateExperimentRecordCaches({
          plan,
          candidateId: "candidate-1",
          records: [record],
          artifactRoot,
          calibrationReceiptDigest: digest("d"),
        }),
      /mismatched claim evidence/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("sandbox profile denies every checkout and cache except the active fixture", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-sandbox-profile-"),
  );
  try {
    const worktrees = [
      path.join(root, "worktree-one"),
      path.join(root, "worktree-two"),
    ];
    const artifactRoot = path.join(root, "artifacts");
    const fixtureRoot = path.join(root, "fixtures");
    const fixturePath = path.join(fixtureRoot, "active-pr");
    for (const directory of [...worktrees, artifactRoot, fixturePath]) {
      mkdirSync(directory, { recursive: true });
    }
    const registered = registeredExperimentWorktrees({
      repoRoot,
      exec: (_file, args, options) => {
        assert.deepEqual(args, [
          "-C",
          repoRoot,
          "worktree",
          "list",
          "--porcelain",
        ]);
        assert.equal(options.encoding, "utf8");
        return worktrees
          .map(
            (worktree, index) =>
              `worktree ${worktree}\nHEAD ${String(index + 1).repeat(40)}\n`,
          )
          .join("\n");
      },
    });
    assert.deepEqual(
      registered,
      worktrees.map((worktree) => canonicalPath(worktree)),
    );

    const profile = buildExperimentSandboxProfile({
      deniedRoots: [...registered, artifactRoot, fixtureRoot],
      fixturePath,
    });
    assert.equal(profile.split("\n").includes("(deny process-info*)"), true);
    assert.equal(
      profile.split("\n").includes("(allow process-info* (target self))"),
      true,
    );
    assert.equal(
      profile
        .split("\n")
        .some(
          (line) =>
            line.startsWith("(allow process-info") &&
            line !== "(allow process-info* (target self))",
        ),
      false,
      "profile must not permit inspection of other processes",
    );
    const denyLine = (target) =>
      `(deny file-read* file-write* (literal "${canonicalPath(target)}") (subpath "${canonicalPath(target)}"))`;
    for (const denied of [
      ...worktrees,
      artifactRoot,
      fixtureRoot,
      DEFAULT_EXPERIMENT_ARTIFACT_ROOT,
      DEFAULT_EXPERIMENT_FIXTURE_ROOT,
    ]) {
      assert.equal(
        profile.split("\n").includes(denyLine(denied)),
        true,
        `profile must deny ${denied}`,
      );
    }
    const fileAllows = profile
      .split("\n")
      .filter((line) => line.startsWith("(allow file-read* file-write*"));
    assert.deepEqual(fileAllows, [
      `(allow file-read* file-write* (literal "${canonicalPath(fixturePath)}") (subpath "${canonicalPath(fixturePath)}"))`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox wrapper fails closed on a non-Darwin host", () => {
  assert.throws(
    () =>
      isolateExperimentCommand({
        file: "claude",
        args: [],
        repoRoot,
        artifactRoot: "/outside/artifacts",
        fixtureCacheDir: "/outside/fixtures",
        fixturePath: "/outside/fixtures/pr-1990",
        platform: "linux",
      }),
    /require Darwin sandbox-exec isolation/,
  );
});

test("experiment storage roots reject lexical and symlink escapes", () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-storage-root-"),
  );
  try {
    const base = path.join(root, "global-root");
    const outside = path.join(root, "outside");
    const campaign = path.join(base, "campaign-one");
    mkdirSync(campaign, { recursive: true });
    mkdirSync(outside);
    assert.equal(
      assertExperimentStorageRoot({
        target: campaign,
        base,
        label: "campaign root",
      }),
      realpathSync(campaign),
    );
    assert.equal(
      assertExperimentStorageRoot({
        target: base,
        base,
        label: "global root",
        allowBase: true,
      }),
      realpathSync(base),
    );
    assert.throws(
      () =>
        assertExperimentStorageRoot({
          target: path.join(base, "..", "outside", "campaign"),
          base,
          label: "campaign root",
        }),
      /campaign root must stay under/,
    );

    const escapeLink = path.join(base, "linked-campaign");
    symlinkSync(outside, escapeLink, "dir");
    assert.throws(
      () =>
        assertExperimentStorageRoot({
          target: path.join(escapeLink, "attempt"),
          base,
          label: "campaign root",
        }),
      /campaign root must stay under/,
    );
    assert.throws(
      () =>
        resolveExperimentArtifactPath({
          artifactRoot: base,
          relativePath: "linked-campaign/receipt.json",
        }),
      /escapes its root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage evidence recomputes the decision and rejects a resealed forgery", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-stage-evidence-"),
  );
  try {
    const plan = makePlan();
    const calibration = writeCalibrationReceipt({ plan, artifactRoot });
    const candidateId = "candidate-1";
    const stage = "screen";
    const records = writeCachedStageRecords({
      plan,
      candidateId,
      stage,
      artifactRoot,
      summaries: passingScreen(),
      calibrationReceiptDigest: calibration.artifact.receipt_digest,
    });
    const recordsByStage = { [stage]: records };
    const decision = evaluateExperimentDecision({
      plan,
      candidateId,
      stage,
      recordsByStage,
    });
    const base = {
      schema_version: 1,
      namespace: plan.namespace,
      campaign_id: plan.campaign_id,
      plan_digest: plan.plan_digest,
      candidate_id: candidateId,
      stage,
      attempt: 1,
      evidence_phase: "base",
      calibration: calibration.evidence,
      records,
      recordsByStage,
      decision,
    };
    const artifact = sealRunEvidence(base);
    assert.equal(
      validateStageRunArtifact({
        artifact,
        plan,
        candidateId,
        stage,
        artifactRoot,
        calibrationSet,
        allowIncomplete: true,
      }),
      artifact,
    );

    const changedDecision = {
      ...decision,
      status: decision.status === "REJECT" ? "PROMISING" : "REJECT",
    };
    const forged = sealRunEvidence({ ...base, decision: changedDecision });
    assert.throws(
      () =>
        validateStageRunArtifact({
          artifact: forged,
          plan,
          candidateId,
          stage,
          artifactRoot,
          calibrationSet,
          allowIncomplete: true,
        }),
      /decision does not recompute/,
    );

    const digestTampered = structuredClone(artifact);
    digestTampered.decision.status = changedDecision.status;
    assert.throws(
      () =>
        validateStageRunArtifact({
          artifact: digestTampered,
          plan,
          candidateId,
          stage,
          artifactRoot,
          calibrationSet,
          allowIncomplete: true,
        }),
      /artifact digest check/,
    );

    const calibrationTampered = sealRunEvidence({
      ...base,
      calibration: {
        ...base.calibration,
        receipt_digest: digest("f"),
      },
    });
    assert.throws(
      () =>
        validateStageRunArtifact({
          artifact: calibrationTampered,
          plan,
          candidateId,
          stage,
          artifactRoot,
          calibrationSet,
          allowIncomplete: true,
        }),
      /calibration receipt digest differs/,
    );

    const publishedFile = path.join(artifactRoot, "published-stage.json");
    let guardChecks = 0;
    const published = publishValidatedStageArtifact({
      file: publishedFile,
      artifact,
      plan,
      candidateId,
      stage,
      artifactRoot,
      calibrationSet,
      beforeWrite: () => {
        guardChecks += 1;
        if (guardChecks > 2) {
          throw new Error("publication ran a post-link deadline guard");
        }
      },
    });
    assert.equal(guardChecks, 2);
    assert.equal(published.artifact_file, publishedFile);
    assert.deepEqual(JSON.parse(readFileSync(publishedFile, "utf8")), artifact);

    const expiredArtifact = sealRunEvidence({
      ...base,
      calibration: {
        ...base.calibration,
        checked_at: new Date(
          Date.parse(base.calibration.checked_at) + CALIBRATION_MAX_AGE_MS + 1,
        ).toISOString(),
      },
    });
    const expiredFile = path.join(artifactRoot, "expired-stage.json");
    assert.throws(
      () =>
        publishValidatedStageArtifact({
          file: expiredFile,
          artifact: expiredArtifact,
          plan,
          candidateId,
          stage,
          artifactRoot,
          calibrationSet,
        }),
      /older than 6 hours/,
    );
    assert.equal(existsSync(expiredFile), false);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("stage evidence binds match and novelty caches to its calibration receipt", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-stage-cache-calibration-"),
  );
  try {
    const plan = makePlan();
    const calibration = writeCalibrationReceipt({ plan, artifactRoot });
    const candidateId = "candidate-1";
    const stage = "screen";
    const mismatchedReceiptDigest =
      calibration.artifact.receipt_digest === digest("f")
        ? digest("e")
        : digest("f");
    const stageArtifact = (records) => {
      const recordsByStage = { [stage]: records };
      return sealRunEvidence({
        schema_version: 1,
        namespace: plan.namespace,
        campaign_id: plan.campaign_id,
        plan_digest: plan.plan_digest,
        candidate_id: candidateId,
        stage,
        attempt: 1,
        evidence_phase: "base",
        calibration: calibration.evidence,
        records,
        recordsByStage,
        decision: evaluateExperimentDecision({
          plan,
          candidateId,
          stage,
          recordsByStage,
        }),
      });
    };
    const validate = (artifact) =>
      validateStageRunArtifact({
        artifact,
        plan,
        candidateId,
        stage,
        artifactRoot,
        calibrationSet,
        allowIncomplete: true,
      });

    const matchMismatched = writeCachedStageRecords({
      plan,
      candidateId,
      stage,
      artifactRoot,
      summaries: passingScreen(),
      calibrationReceiptDigest: mismatchedReceiptDigest,
    });
    const mismatchedMatch = JSON.parse(
      readFileSync(matchMismatched[0].artifacts.match, "utf8"),
    );
    assert.equal(
      mismatchedMatch.identity.calibration_receipt_digest,
      mismatchedReceiptDigest,
    );
    assert.notEqual(
      mismatchedMatch.identity.calibration_receipt_digest,
      calibration.artifact.receipt_digest,
    );
    assert.throws(
      () => validate(stageArtifact(matchMismatched)),
      /match cache identity differs/,
    );

    const records = writeCachedStageRecords({
      plan,
      candidateId,
      stage,
      artifactRoot,
      summaries: passingScreen(),
      calibrationReceiptDigest: calibration.artifact.receipt_digest,
    });
    const record = records[0];
    const novelIdentity = buildCacheIdentity({
      phase: "novel",
      plan,
      candidateId,
      stage,
      pr: record.pr,
      treatment: record.treatment,
      rawDigest: record.raw_digest,
      matchDigest: record.match_digest,
      claimsDigest: record.claims_digest,
      calibrationReceiptDigest: mismatchedReceiptDigest,
    });
    const verdicts = Object.fromEntries(
      Array.from({ length: record.claims_count }, (_, index) => [
        String(index + 1),
        { class: "vague", why: "offline calibration lineage test" },
      ]),
    );
    const novelBase = {
      schema_version: 1,
      namespace: plan.namespace,
      identity: novelIdentity,
      verdict: {
        claims: record.claims_count,
        novelReal: 0,
        novelWrong: 0,
        novelVague: record.claims_count,
        restatedKnown: 0,
        alreadyMatched: record.matched_ids.length,
        verdicts,
      },
    };
    const novel = { ...novelBase, novel_digest: digestObject(novelBase) };
    const novelFile = path.join(
      artifactRoot,
      `cache/novel/${novelIdentity.digest}.json`,
    );
    writeJsonArtifact(novelFile, novel);
    assert.equal(
      novel.identity.calibration_receipt_digest,
      mismatchedReceiptDigest,
    );
    const noveltyMismatched = [
      {
        ...record,
        wrong_claims: 0,
        novel_real: 0,
        novel_digest: novel.novel_digest,
        artifacts: { ...record.artifacts, novel: novelFile },
      },
      ...records.slice(1),
    ];
    assert.throws(
      () => validate(stageArtifact(noveltyMismatched)),
      /novel evidence differs/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("prior-stage lookup authenticates its calibration receipt", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-prior-calibration-"),
  );
  try {
    const plan = makePlan();
    const calibration = writeCalibrationReceipt({ plan, artifactRoot });
    const candidateId = "candidate-1";
    const stage = "screen";
    const summaries = recordsFromSpecs([
      {
        pr: 1990,
        incumbent: { known: 1, p1: 0 },
        candidate: { known: 1, p1: 0 },
      },
      {
        pr: 1995,
        incumbent: { known: 2, p1: 0 },
        candidate: { known: 1, p1: 0 },
      },
      {
        pr: 1999,
        incumbent: { known: 2, p1: 0 },
        candidate: { known: 1, p1: 0 },
      },
    ]);
    const records = writeCachedStageRecords({
      plan,
      candidateId,
      stage,
      artifactRoot,
      summaries,
      calibrationReceiptDigest: calibration.artifact.receipt_digest,
    });
    const recordsByStage = { [stage]: records };
    const artifact = sealRunEvidence({
      schema_version: 1,
      namespace: plan.namespace,
      campaign_id: plan.campaign_id,
      plan_digest: plan.plan_digest,
      candidate_id: candidateId,
      stage,
      attempt: 1,
      evidence_phase: "base",
      calibration: calibration.evidence,
      records,
      recordsByStage,
      decision: evaluateExperimentDecision({
        plan,
        candidateId,
        stage,
        recordsByStage,
      }),
    });
    const file = runArtifactPath({
      artifactRoot,
      candidateId,
      stage,
      attempt: 1,
      novel: false,
    });
    writeJsonArtifact(file, artifact);
    assert.equal(
      latestStageRun({
        artifactRoot,
        candidateId,
        stage,
        plan,
        calibrationSet,
      }).artifact_digest,
      artifact.artifact_digest,
    );

    const outsideIdentityCache = path.join(
      artifactRoot,
      "cache/calibration/prior-stage-forgery.json",
    );
    writeJsonArtifact(outsideIdentityCache, calibration.artifact);
    const tampered = structuredClone(artifact);
    delete tampered.artifact_digest;
    tampered.calibration.receipt_file = outsideIdentityCache;
    writeJsonArtifact(file, sealRunEvidence(tampered));
    assert.throws(
      () =>
        latestStageRun({
          artifactRoot,
          candidateId,
          stage,
          plan,
          calibrationSet,
        }),
      /outside its identity cache/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test(
  "finder, contestant, and novelty judge commands use the injected sandbox wrapper",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "review-eval-experiment-sandbox-runtime-"),
    );
    try {
      const artifactRoot = path.join(root, "artifacts");
      const fixtureCacheDir = path.join(root, "fixture-cache");
      const fixturePath = path.join(fixtureCacheDir, "pr-1990");
      mkdirSync(artifactRoot);
      mkdirSync(fixtureCacheDir);
      const clone = spawnSync(
        "git",
        [
          "clone",
          "--quiet",
          "--shared",
          "--no-checkout",
          repoRoot,
          fixturePath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(
        clone.status,
        0,
        `local fixture clone failed: ${clone.stderr || clone.error?.message}`,
      );

      const skillSnapshot = (id, instruction) => {
        const files = [
          {
            relative: "SKILL.md",
            bytes: Buffer.from(`---\nname: ${id}\n---\n${instruction}\n`),
            mode: 0o600,
          },
        ];
        return { id, files, digest: capturedSkillDigest(files) };
      };
      const incumbentSnapshot = skillSnapshot(
        "incumbent",
        "Review the supplied fixture.",
      );
      const candidateSnapshot = skillSnapshot(
        "candidate-1",
        "Review the supplied fixture with the candidate instructions.",
      );
      const plan = buildExperimentPlan({
        contract,
        contractDigest: digest("a"),
        plannedAt,
        incumbent: {
          skill_ref: "/offline/incumbent",
          skill_digest: incumbentSnapshot.digest,
          canonical_skill_digest: incumbentSnapshot.digest,
        },
        candidates: [
          {
            id: "candidate-1",
            skill_ref: "/offline/candidate-1",
            skill_digest: candidateSnapshot.digest,
            canonical_skill_digest: candidateSnapshot.digest,
          },
        ],
        identities,
        includeLivePaired: true,
      });
      const lane = plan.candidate_plans[0].stages["live-paired"].lanes[0];
      const arm = lane.sequence[0];
      const truth = JSON.parse(
        readFileSync(path.join(repoRoot, lane.fixture.truth_file), "utf8"),
      );
      const sourceSeal = {
        manifest: { plan_digest: plan.plan_digest },
        handoff_template:
          "Other review:\n{{OTHER_REVIEW}}\nReview the fixture.",
        truth_by_pr: { [lane.pr]: truth },
        skill_snapshots: {
          incumbent: incumbentSnapshot,
          "candidate-1": candidateSnapshot,
        },
      };
      const preparedFixtures = new Map([[lane.pr, { path: fixturePath }]]);
      let fixtureSerial = 0;
      const createdFixtures = [];
      const disposedFixtures = [];
      const fixtureProbes = [];
      const createFixture = ({ seedFixture, head, base, cellId }) => {
        assert.equal(seedFixture.path, fixturePath);
        assert.equal(head, lane.fixture.first_head);
        assert.equal(base, lane.fixture.base_sha);
        const activePath = path.join(
          fixtureCacheDir,
          "active",
          `${cellId}-${++fixtureSerial}`,
        );
        mkdirSync(activePath, { recursive: true });
        createdFixtures.push(activePath);
        return { path: activePath, seed_path: fixturePath, head };
      };
      const disposeFixture = ({ fixturePath: activePath }) => {
        assert.equal(createdFixtures.includes(activePath), true);
        assert.equal(disposedFixtures.includes(activePath), false);
        disposedFixtures.push(activePath);
        rmSync(activePath, { recursive: true, force: true });
      };
      const sandboxProbe = ({ fixturePath: activePath, role }) => {
        assert.equal(existsSync(activePath), true);
        fixtureProbes.push({ path: activePath, role });
      };
      const isolated = [];
      const isolateCommand = ({
        file,
        args,
        repoRoot: suppliedRepoRoot,
        artifactRoot: suppliedArtifactRoot,
        fixtureCacheDir: suppliedFixtureRoot,
        fixturePath: suppliedFixturePath,
        worktreeRoots,
      }) => {
        assert.equal(suppliedRepoRoot, repoRoot);
        assert.equal(suppliedArtifactRoot, artifactRoot);
        assert.equal(suppliedFixtureRoot, fixtureCacheDir);
        assert.equal(createdFixtures.includes(suppliedFixturePath), true);
        assert.notEqual(suppliedFixturePath, fixturePath);
        assert.equal(existsSync(suppliedFixturePath), true);
        assert.deepEqual(worktreeRoots, [repoRoot]);
        isolated.push({ file, args, fixturePath: suppliedFixturePath });
        return {
          file: "/usr/bin/sandbox-exec",
          args: ["-p", "(version 1)", file, ...args],
        };
      };
      const wrappedCommands = [];
      const contestantPrompt =
        "Other review:\nOffline finder report.\nReview the fixture.";
      const runCommand = async ({ file, args, input, cwd }) => {
        wrappedCommands.push({ file, args, input, cwd });
        assert.equal(file, "/usr/bin/sandbox-exec");
        const original = args[2];
        assert.equal(createdFixtures.includes(cwd), true);
        if (original === plan.identities.codex_bin.path) {
          assert.equal(input, undefined);
          return { stdout: "Offline finder report.", stderr: "" };
        }
        if (original === plan.identities.claude_bin.path) {
          assert.equal(input, contestantPrompt);
          assert.equal(args.includes("--no-session-persistence"), true);
          assert.equal(JSON.stringify(args).includes(input), false);
          const promptFileIndex = args.indexOf("--append-system-prompt-file");
          assert.notEqual(promptFileIndex, -1);
          const systemPrompt = readFileSync(args[promptFileIndex + 1], "utf8");
          assert.equal(
            systemPrompt.includes("Review the supplied fixture"),
            true,
          );
          assert.equal(JSON.stringify(args).includes(systemPrompt), false);
          return {
            stdout: JSON.stringify({
              result: "unrelated.txt:1: A model-free test claim.",
              total_cost_usd: 0,
              num_turns: 1,
            }),
            stderr: "",
          };
        }
        throw new Error(`unexpected wrapped command ${original}`);
      };
      let blindJudgeCalls = 0;
      const execute = createExperimentArmExecutor({
        plan,
        contract,
        artifactRoot,
        repoRoot,
        fixtureCacheDir,
        sourceSeal,
        preparedFixtures,
        calibrationReceipt: { receipt_digest: digest("d") },
        runCommand,
        judgeExec: async () => {
          blindJudgeCalls += 1;
          return JSON.stringify(["unrelated.txt:1: A model-free test claim."]);
        },
        isolateCommand,
        sandboxWorktreeRoots: [repoRoot],
        createFixture,
        disposeFixture,
        sandboxProbe,
      });
      const records = [];
      for (const laneArm of lane.sequence) {
        records.push(
          await execute({
            candidateId: "candidate-1",
            stage: "live-paired",
            attempt: 1,
            lane,
            arm: laneArm,
          }),
        );
      }
      assert.equal(
        records.every((record) => record.ok),
        true,
      );
      assert.equal(blindJudgeCalls, 2);
      assert.deepEqual(
        isolated.map((entry) => entry.file),
        [
          plan.identities.codex_bin.path,
          plan.identities.claude_bin.path,
          plan.identities.claude_bin.path,
        ],
      );

      const novelCommands = [];
      const enriched = await enrichRecordsWithNovelty({
        plan,
        candidateId: "candidate-1",
        records,
        artifactRoot,
        repoRoot,
        fixtureCacheDir,
        sourceSeal,
        preparedFixtures,
        calibrationReceipt: { receipt_digest: digest("d") },
        runCommand: async ({ file, args, input, cwd }) => {
          novelCommands.push({ file, args, input, cwd });
          assert.equal(file, "/usr/bin/sandbox-exec");
          assert.equal(args[2], plan.identities.claude_bin.path);
          assert.equal(createdFixtures.includes(cwd), true);
          assert.equal(input.trim().length > 0, true);
          assert.equal(args.includes("--no-session-persistence"), true);
          assert.equal(JSON.stringify(args).includes(input), false);
          return {
            stdout: JSON.stringify({
              verdicts: {
                1: { class: "wrong", why: "offline test verdict" },
              },
            }),
            stderr: "",
          };
        },
        isolateCommand,
        sandboxWorktreeRoots: [repoRoot],
        createFixture,
        disposeFixture,
        sandboxProbe,
      });
      assert.equal(
        enriched.every((record) => record.wrong_claims === 1),
        true,
      );
      assert.deepEqual(
        isolated.map((entry) => entry.file),
        [
          plan.identities.codex_bin.path,
          plan.identities.claude_bin.path,
          plan.identities.claude_bin.path,
          plan.identities.claude_bin.path,
          plan.identities.claude_bin.path,
        ],
      );
      assert.equal(wrappedCommands.length, 3);
      assert.equal(novelCommands.length, 2);
      assert.equal(new Set(createdFixtures).size, 5);
      assert.deepEqual(disposedFixtures, createdFixtures);
      assert.equal(
        createdFixtures.every((file) => !existsSync(file)),
        true,
      );
      assert.deepEqual(fixtureProbes.map((probe) => probe.role).sort(), [
        "candidate",
        "finder",
        "incumbent",
        "novelty",
        "novelty",
      ]);

      const retryCommands = [];
      const fixturesBeforeRetry = createdFixtures.length;
      const retryExecute = createExperimentArmExecutor({
        plan,
        contract,
        artifactRoot,
        repoRoot,
        fixtureCacheDir,
        sourceSeal,
        preparedFixtures,
        calibrationReceipt: { receipt_digest: digest("d") },
        runCommand: async ({ file, args }) => {
          retryCommands.push({ file, args });
          assert.equal(file, "/usr/bin/sandbox-exec");
          assert.equal(args[2], plan.identities.codex_bin.path);
          return { stdout: "Offline finder report.", stderr: "" };
        },
        judgeExec: async () => {
          throw new Error("exact retry caches must not rerun a judge");
        },
        isolateCommand,
        sandboxWorktreeRoots: [repoRoot],
        createFixture,
        disposeFixture,
        sandboxProbe,
      });
      const retryRecord = await retryExecute({
        candidateId: "candidate-1",
        stage: "live-paired",
        attempt: 2,
        lane,
        arm,
      });
      assert.deepEqual(retryRecord.cache_reuse, {
        raw: true,
        match: true,
      });
      assert.deepEqual(retryCommands, []);
      assert.equal(createdFixtures.length, fixturesBeforeRetry);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("experiment subprocesses deliver prompt bytes through stdin", async () => {
  const prompt = "offline-stdin-prompt-7f6d7d28";
  const response = await spawnExperimentProcess({
    file: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => process.stdout.write(input));",
    ],
    cwd: repoRoot,
    env: process.env,
    input: prompt,
    timeoutMs: 5_000,
  });
  assert.equal(response.stdout, prompt);
});

test("experiment judge prompts never enter argv and disable session persistence", async () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-judge-stdin-"),
  );
  try {
    const calls = [];
    const exec = createExperimentJudgeExec({
      claudeFile: "/offline/claude",
      repoRoot,
      artifactRoot: path.join(root, "artifacts"),
      fixtureCacheDir: root,
      env: {},
      timeoutMs: 1_000,
      signal: null,
      runCommand: async (call) => {
        calls.push(call);
        return { stdout: "{}", stderr: "" };
      },
      isolateCommand: ({ file, args }) => ({ file, args }),
      worktreeRoots: [repoRoot],
    });
    const requests = [
      {
        prompt: "blind-prompt-4bb49af7",
        model: "offline-model",
        effort: "high",
        allowedTools: [],
        maxTurns: 1,
      },
      {
        prompt: "tool-prompt-ec0d20a4",
        model: "offline-model",
        effort: "high",
        allowedTools: ["Read"],
        maxTurns: 1,
        cwd: root,
      },
    ];
    for (const request of requests) await exec(request);
    assert.equal(calls.length, requests.length);
    for (const [index, call] of calls.entries()) {
      const prompt = requests[index].prompt;
      assert.equal(call.file, "/offline/claude");
      assert.equal(call.args.includes("--no-session-persistence"), true);
      assert.equal(JSON.stringify(call.args).includes(prompt), false);
      assert.equal(call.input, prompt);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "successful process completion kills its background process-group descendants",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "review-eval-experiment-success-cleanup-"),
    );
    const pidFile = path.join(root, "descendant.pid");
    let descendantPid = null;
    const parentSource = `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const descendant = spawn(process.execPath, [
        "--eval",
        "setInterval(() => {}, 1000);",
      ], { stdio: "ignore" });
      writeFileSync(process.env.EXPERIMENT_DESCENDANT_PID_FILE, String(descendant.pid));
      process.exit(0);
    `;
    try {
      await spawnExperimentProcess({
        file: process.execPath,
        args: ["--input-type=module", "--eval", parentSource],
        cwd: root,
        env: { ...process.env, EXPERIMENT_DESCENDANT_PID_FILE: pidFile },
        timeoutMs: 5_000,
      });
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      assert.equal(Number.isSafeInteger(descendantPid), true);
      await waitUntil(
        () => !pidIsAlive(descendantPid),
        "successful process descendant cleanup",
        3_000,
      );
    } finally {
      if (Number.isSafeInteger(descendantPid) && pidIsAlive(descendantPid)) {
        forceKillProcess(descendantPid);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("record cache lineage authenticates match leak evidence", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-leak-lineage-"),
  );
  try {
    const plan = makePlan();
    const records = writeCachedStageRecords({
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      artifactRoot,
      summaries: passingScreen(),
    });
    records[0].leak = {
      suspected: true,
      hard: ["forged leak signal"],
    };
    assert.throws(
      () =>
        validateExperimentRecordCaches({
          plan,
          candidateId: "candidate-1",
          records,
          artifactRoot,
          calibrationReceiptDigest: digest("d"),
        }),
      /recorded cache evidence differs|leak evidence differs|mismatched leak evidence/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("record cache lineage requires complete novelty identity and counters", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-novel-lineage-"),
  );
  try {
    const plan = makePlan();
    const records = writeCachedStageRecords({
      plan,
      candidateId: "candidate-1",
      stage: "screen",
      artifactRoot,
      summaries: passingScreen(),
    });
    const record = records[0];
    const identity = buildCacheIdentity({
      phase: "novel",
      plan,
      candidateId: "candidate-1",
      stage: record.stage,
      pr: record.pr,
      treatment: record.treatment,
      rawDigest: record.raw_digest,
      matchDigest: record.match_digest,
      claimsDigest: record.claims_digest,
      calibrationReceiptDigest: digest("d"),
    });
    const novelBase = {
      schema_version: 1,
      namespace: plan.namespace,
      identity,
      verdict: {
        claims: record.claims_count,
        novelReal: 0,
        novelWrong: 1,
        novelVague: Math.max(0, record.claims_count - 1),
        restatedKnown: 0,
        alreadyMatched: record.matched_ids.length,
        verdicts: Object.fromEntries(
          Array.from({ length: record.claims_count }, (_, index) => [
            String(index + 1),
            index === 0
              ? { class: "wrong", why: "offline test wrong claim" }
              : { class: "vague", why: "offline test vague claim" },
          ]),
        ),
      },
    };
    const novel = { ...novelBase, novel_digest: digestObject(novelBase) };
    const novelFile = path.join(
      artifactRoot,
      `cache/novel/${identity.digest}.json`,
    );
    writeJsonArtifact(novelFile, novel);
    const enriched = {
      ...record,
      wrong_claims: 1,
      novel_real: 0,
      novel_digest: novel.novel_digest,
      artifacts: { ...record.artifacts, novel: novelFile },
    };
    assert.equal(
      validateExperimentRecordCaches({
        plan,
        candidateId: "candidate-1",
        records: [enriched],
        artifactRoot,
        calibrationReceiptDigest: digest("d"),
      }),
      true,
    );

    const withoutIdentityBase = { ...novelBase };
    delete withoutIdentityBase.identity;
    const withoutIdentity = {
      ...withoutIdentityBase,
      novel_digest: digestObject(withoutIdentityBase),
    };
    writeJsonArtifact(novelFile, withoutIdentity);
    assert.throws(
      () =>
        validateExperimentRecordCaches({
          plan,
          candidateId: "candidate-1",
          records: [
            { ...enriched, novel_digest: withoutIdentity.novel_digest },
          ],
          artifactRoot,
          calibrationReceiptDigest: digest("d"),
        }),
      /malformed novel evidence|novel cache identity differs|mismatched identity|calibrationReceiptDigest/,
    );

    writeJsonArtifact(novelFile, {
      ...novel,
      novel_digest: digest("f"),
    });
    assert.throws(
      () =>
        validateExperimentRecordCaches({
          plan,
          candidateId: "candidate-1",
          records: [enriched],
          artifactRoot,
          calibrationReceiptDigest: digest("d"),
        }),
      /mismatched novel_digest/,
    );

    writeJsonArtifact(novelFile, novel);
    assert.throws(
      () =>
        validateExperimentRecordCaches({
          plan,
          candidateId: "candidate-1",
          records: [{ ...enriched, wrong_claims: 2 }],
          artifactRoot,
          calibrationReceiptDigest: digest("d"),
        }),
      /novel counters differ|novel evidence differs/,
    );
    const missingNovel = structuredClone(enriched);
    delete missingNovel.artifacts.novel;
    assert.throws(
      () =>
        validateExperimentRecordCaches({
          plan,
          candidateId: "candidate-1",
          records: [missingNovel],
          artifactRoot,
          calibrationReceiptDigest: digest("d"),
        }),
      /novel cache artifact is missing|novel artifact|incomplete novel evidence/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("stage evidence rejects cross-key records and current-attempt drift", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-stage-map-"),
  );
  try {
    const plan = makePlan();
    const calibration = writeCalibrationReceipt({ plan, artifactRoot });
    const candidateId = "candidate-1";
    const stage = "holdout";
    const summaries = passingCombinedRecords();
    const screenRecords = writeCachedStageRecords({
      plan,
      candidateId,
      stage: "screen",
      artifactRoot,
      summaries: summaries.screen,
      calibrationReceiptDigest: calibration.artifact.receipt_digest,
    });
    const records = writeCachedStageRecords({
      plan,
      candidateId,
      stage,
      artifactRoot,
      summaries: summaries.holdout,
      calibrationReceiptDigest: calibration.artifact.receipt_digest,
    });
    const recordsByStage = { screen: screenRecords, holdout: records };
    const decision = evaluateExperimentDecision({
      plan,
      candidateId,
      stage,
      recordsByStage,
    });
    const common = {
      schema_version: 1,
      namespace: plan.namespace,
      campaign_id: plan.campaign_id,
      plan_digest: plan.plan_digest,
      candidate_id: candidateId,
      stage,
      attempt: 1,
      evidence_phase: "base",
      calibration: calibration.evidence,
      records,
      recordsByStage,
      decision,
    };
    const crossKey = sealRunEvidence({
      ...common,
      records: [screenRecords[0]],
      recordsByStage: {
        screen: screenRecords,
        holdout: [screenRecords[0]],
      },
    });
    assert.throws(
      () =>
        validateStageRunArtifact({
          artifact: crossKey,
          plan,
          candidateId,
          stage,
          artifactRoot,
          calibrationSet,
          allowIncomplete: true,
        }),
      /mismatched holdout provenance|record\.stage|stage map key/,
    );

    const wrongAttemptRecords = records.map((record) => ({
      ...record,
      attempt: 2,
    }));
    const wrongAttempt = sealRunEvidence({
      ...common,
      records: wrongAttemptRecords,
      recordsByStage: {
        screen: screenRecords,
        holdout: wrongAttemptRecords,
      },
    });
    assert.throws(
      () =>
        validateStageRunArtifact({
          artifact: wrongAttempt,
          plan,
          candidateId,
          stage,
          artifactRoot,
          calibrationSet,
          allowIncomplete: true,
        }),
      /attempt/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("retry receipts require exact provenance and start-owner linkage", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-retry-provenance-"),
  );
  try {
    const plan = makePlan();
    const candidateId = "candidate-1";
    const stage = "screen";
    const host = "offline-retry-host";
    const owner = {
      token: ownerMarker("attempt-one"),
      host,
      pid: 99_999_999,
      candidate_id: candidateId,
      stage,
      attempt: 1,
    };
    const receiptBase = {
      schema_version: 1,
      namespace: plan.namespace,
      campaign_id: plan.campaign_id,
      plan_digest: plan.plan_digest,
      candidate_id: candidateId,
      stage,
      attempt: 1,
    };
    const startFile = attemptReceiptPath({
      artifactRoot,
      candidateId,
      stage,
      attempt: 1,
      suffix: "start",
    });
    const failureFile = attemptReceiptPath({
      artifactRoot,
      candidateId,
      stage,
      attempt: 1,
      suffix: "failed",
    });
    const writeReceipts = ({ startChanges = {}, failureChanges = {} }) => {
      const start = sealRunEvidence({
        ...receiptBase,
        status: "started",
        started_at: plannedAt,
        owner,
        schedule: { dry_run: true },
        ...startChanges,
      });
      const failure = sealRunEvidence({
        ...receiptBase,
        status: "failed",
        completed_at: plannedAt,
        reason: "offline harness failure",
        owner,
        start_artifact_digest: start.artifact_digest,
        ...failureChanges,
      });
      writeJsonArtifact(startFile, start);
      writeJsonArtifact(failureFile, failure);
    };

    writeReceipts({
      startChanges: { candidate_id: "candidate-forged" },
    });
    assert.throws(
      () =>
        assertRetryEligible({
          artifactRoot,
          candidateId,
          stage,
          host,
          plan,
        }),
      /start.*provenance|mismatched provenance/,
    );

    writeReceipts({ failureChanges: { stage: "holdout" } });
    assert.throws(
      () =>
        assertRetryEligible({
          artifactRoot,
          candidateId,
          stage,
          host,
          plan,
        }),
      /failure.*provenance|mismatched provenance/,
    );

    writeReceipts({
      failureChanges: {
        owner: { ...owner, token: ownerMarker("different") },
        start_artifact_digest: digest("f"),
      },
    });
    assert.throws(
      () =>
        assertRetryEligible({
          artifactRoot,
          candidateId,
          stage,
          host,
          plan,
        }),
      /owner|start.*link|start_artifact_digest/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("a terminal base artifact blocks retry despite a failure receipt", () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-terminal-retry-"),
  );
  try {
    const plan = makePlan();
    const calibration = writeCalibrationReceipt({ plan, artifactRoot });
    const candidateId = "candidate-1";
    const stage = "screen";
    const host = "offline-terminal-retry-host";
    const owner = {
      token: ownerMarker("terminal"),
      host,
      pid: 99_999_999,
      candidate_id: candidateId,
      stage,
      attempt: 1,
    };
    const receiptBase = {
      schema_version: 1,
      namespace: plan.namespace,
      campaign_id: plan.campaign_id,
      plan_digest: plan.plan_digest,
      candidate_id: candidateId,
      stage,
      attempt: 1,
    };
    const start = sealRunEvidence({
      ...receiptBase,
      status: "started",
      started_at: plannedAt,
      owner,
      schedule: { dry_run: true },
    });
    const failure = sealRunEvidence({
      ...receiptBase,
      status: "failed",
      completed_at: plannedAt,
      reason: "failure written after the terminal base artifact",
      owner,
      start_artifact_digest: start.artifact_digest,
    });
    writeJsonArtifact(
      attemptReceiptPath({
        artifactRoot,
        candidateId,
        stage,
        attempt: 1,
        suffix: "start",
      }),
      start,
    );
    writeJsonArtifact(
      attemptReceiptPath({
        artifactRoot,
        candidateId,
        stage,
        attempt: 1,
        suffix: "failed",
      }),
      failure,
    );

    const summaries = recordsFromSpecs([
      {
        pr: 1990,
        incumbent: { known: 1, p1: 0 },
        candidate: { known: 1, p1: 0 },
      },
      {
        pr: 1995,
        incumbent: { known: 2, p1: 0 },
        candidate: { known: 1, p1: 0 },
      },
      {
        pr: 1999,
        incumbent: { known: 2, p1: 0 },
        candidate: { known: 1, p1: 0 },
      },
    ]);
    const records = writeCachedStageRecords({
      plan,
      candidateId,
      stage,
      artifactRoot,
      summaries,
      calibrationReceiptDigest: calibration.artifact.receipt_digest,
    });
    const recordsByStage = { [stage]: records };
    const base = sealRunEvidence({
      ...receiptBase,
      evidence_phase: "base",
      calibration: calibration.evidence,
      records,
      recordsByStage,
      decision: evaluateExperimentDecision({
        plan,
        candidateId,
        stage,
        recordsByStage,
      }),
    });
    assert.equal(base.decision.status, "REJECT");
    writeJsonArtifact(
      runArtifactPath({
        artifactRoot,
        candidateId,
        stage,
        attempt: 1,
        novel: false,
      }),
      base,
    );

    assert.throws(
      () =>
        assertRetryEligible({
          artifactRoot,
          candidateId,
          stage,
          host,
          plan,
          calibrationSet,
        }),
      /attempt 2 is not allowed:.*completed its decision|terminal/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("calibration receipt validation binds path, digest, identity, outcomes, agreement, and age", async () => {
  const artifactRoot = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-calibration-lineage-"),
  );
  try {
    const completedAt = "2026-09-01T09:30:00.000Z";
    const plan = makePlan({
      identityOverrides: { calibration_digest: calibrationDigest },
    });
    const created = await ensureExperimentCalibration({
      plan,
      artifactRoot,
      repoRoot,
      calibrationBytes,
      clock: () => new Date(completedAt),
      exec: fakeCalibrationExec(),
    });
    const validate = ({
      receiptFile = created.file,
      expectedReceiptDigest = created.artifact.receipt_digest,
      checkedAt = new Date(completedAt),
    } = {}) =>
      validateExperimentCalibrationReceipt({
        plan,
        artifactRoot,
        receiptFile,
        expectedReceiptDigest,
        calibrationSet,
        checkedAt,
      });
    assert.equal(validate().file, realpathSync(created.file));

    const outsideIdentityCache = path.join(
      artifactRoot,
      "cache/calibration/outside-receipt.json",
    );
    writeJsonArtifact(outsideIdentityCache, created.artifact);
    assert.throws(
      () => validate({ receiptFile: outsideIdentityCache }),
      /outside its identity cache/,
    );

    const selfDigestTampered = {
      ...created.artifact,
      agreement: created.artifact.agreement - 1,
    };
    writeJsonArtifact(created.file, selfDigestTampered);
    assert.throws(() => validate(), /failed its identity check/);

    const wrongIdentityBase = {
      ...created.artifact,
      identity: {
        ...created.artifact.identity,
        host: "forged-host",
      },
    };
    delete wrongIdentityBase.receipt_digest;
    const wrongIdentity = {
      ...wrongIdentityBase,
      receipt_digest: digestObject(wrongIdentityBase),
    };
    writeJsonArtifact(created.file, wrongIdentity);
    assert.throws(
      () => validate({ expectedReceiptDigest: wrongIdentity.receipt_digest }),
      /failed its identity check/,
    );

    const incompleteBase = {
      ...created.artifact,
      outcomes: created.artifact.outcomes.slice(0, -1),
    };
    delete incompleteBase.receipt_digest;
    const incomplete = {
      ...incompleteBase,
      receipt_digest: digestObject(incompleteBase),
    };
    writeJsonArtifact(created.file, incomplete);
    assert.throws(
      () => validate({ expectedReceiptDigest: incomplete.receipt_digest }),
      /incomplete outcomes/,
    );

    const wrongAgreementBase = {
      ...created.artifact,
      agreement: created.artifact.agreement - 1,
    };
    delete wrongAgreementBase.receipt_digest;
    const wrongAgreement = {
      ...wrongAgreementBase,
      receipt_digest: digestObject(wrongAgreementBase),
    };
    writeJsonArtifact(created.file, wrongAgreement);
    assert.throws(
      () => validate({ expectedReceiptDigest: wrongAgreement.receipt_digest }),
      /below or differs/,
    );

    writeJsonArtifact(created.file, created.artifact);
    assert.throws(
      () =>
        validate({
          checkedAt: new Date(
            Date.parse(completedAt) + CALIBRATION_MAX_AGE_MS + 1,
          ),
        }),
      /older than 6 hours/,
    );
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("disposable fixture clones are unique and cleanup removes every role checkout", () => {
  const fixtureCacheDir = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-disposable-"),
  );
  try {
    const seedPath = path.join(fixtureCacheDir, "seed-pr-1990");
    mkdirSync(path.join(seedPath, ".git"), { recursive: true });
    const head = "1".repeat(40);
    const base = "2".repeat(40);
    const events = [];
    const runGit = ({ args, cwd }) => {
      events.push({ args: [...args], cwd });
      if (args[0] === "clone") {
        mkdirSync(path.join(args.at(-1), ".git"), { recursive: true });
      }
      if (args[0] === "rev-parse") {
        return { status: 0, stdout: `${head}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const paths = [];
    for (const role of ["arm-incumbent", "arm-candidate", "novel-judge"]) {
      const disposable = createDisposableExperimentFixture({
        seedFixture: { path: seedPath, pr: 1990 },
        fixtureCacheDir,
        head,
        base,
        cellId: role,
        nonce: `nonce-${role}`,
        runGit,
      });
      paths.push(disposable.path);
      assert.equal(disposable.seed_path, realpathSync(seedPath));
      assert.equal(existsSync(disposable.path), true);
      assert.notEqual(disposable.path, disposable.seed_path);
      writeFileSync(path.join(disposable.path, `${role}.txt`), role);
      disposeDisposableExperimentFixture({
        fixturePath: disposable.path,
        fixtureCacheDir,
      });
      assert.equal(existsSync(disposable.path), false);
    }
    assert.equal(new Set(paths).size, 3);
    assert.equal(events.filter((event) => event.args[0] === "clone").length, 3);
    assert.equal(
      events.filter(
        (event) => event.args[0] === "remote" && event.args[1] === "remove",
      ).length,
      3,
    );
    assert.equal(
      events.filter(
        (event) =>
          event.args[0] === "config" &&
          event.args.includes("core.hooksPath") &&
          event.args.includes("/dev/null"),
      ).length,
      3,
    );
  } finally {
    rmSync(fixtureCacheDir, { recursive: true, force: true });
  }
});

test("disposable fixture Git commands use the remaining absolute deadline", () => {
  const fixtureCacheDir = mkdtempSync(
    path.join(tmpdir(), "review-eval-experiment-disposable-deadline-"),
  );
  try {
    const seedPath = path.join(fixtureCacheDir, "seed-pr-1990");
    mkdirSync(path.join(seedPath, ".git"), { recursive: true });
    const head = "1".repeat(40);
    const base = "2".repeat(40);
    let clock = 1_000;
    const timeouts = [];
    const runGit = ({ args, timeoutMs }) => {
      timeouts.push(timeoutMs);
      if (args[0] === "clone") {
        mkdirSync(path.join(args.at(-1), ".git"), { recursive: true });
      }
      clock += 10;
      if (args[0] === "rev-parse") {
        return { status: 0, stdout: `${head}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const disposable = createDisposableExperimentFixture({
      seedFixture: { path: seedPath, pr: 1990 },
      fixtureCacheDir,
      head,
      base,
      cellId: "deadline",
      nonce: "within-budget",
      runGit,
      deadlineMs: 1_100,
      now: () => clock,
    });
    assert.deepEqual(timeouts, [100, 90, 80, 70, 60, 50, 40, 30]);
    disposeDisposableExperimentFixture({
      fixturePath: disposable.path,
      fixtureCacheDir,
    });

    clock = 2_000;
    let calls = 0;
    const expiredTarget = path.join(
      realpathSync(fixtureCacheDir),
      "active",
      "deadline-expired-after-clone",
    );
    assert.throws(
      () =>
        createDisposableExperimentFixture({
          seedFixture: { path: seedPath, pr: 1990 },
          fixtureCacheDir,
          head,
          base,
          cellId: "deadline",
          nonce: "expired-after-clone",
          deadlineMs: 2_005,
          now: () => clock,
          runGit: ({ args }) => {
            calls += 1;
            if (args[0] === "clone") {
              mkdirSync(path.join(args.at(-1), ".git"), { recursive: true });
              clock = 2_006;
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
      /stage expired during disposable fixture setup/,
    );
    assert.equal(calls, 1);
    assert.equal(existsSync(expiredTarget), false);
  } finally {
    rmSync(fixtureCacheDir, { recursive: true, force: true });
  }
});

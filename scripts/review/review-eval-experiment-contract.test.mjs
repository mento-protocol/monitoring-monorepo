import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildExperimentPlan,
  canonicalRerunManifest,
  digestObject,
  EXPERIMENT_SOURCE_FILES,
  experimentSourceDigest,
  novelCacheIdentity,
  rawCacheIdentity,
  scoreCacheIdentity,
  stagePlanFor,
  validateExperimentPlan,
} from "./review-eval-experiment-contract.mjs";
import {
  finderArgvDigest,
  planCells,
  skillDigest,
} from "./review-eval-run-plan.mjs";
import { scorerDigest } from "./review-eval-score.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractBytes = readFileSync(
  path.join(repoRoot, "docs/evals/review-skill-fixtures.json"),
);
const contract = JSON.parse(contractBytes);
const contractDigest = createHash("sha256").update(contractBytes).digest("hex");
const root = mkdtempSync(path.join(os.tmpdir(), "review-experiment-contract-"));
const incumbentRoot = path.join(root, "incumbent");
const candidateRoot = path.join(root, "candidate");
const secondRoot = path.join(root, "second");

for (const [directory, text] of [
  [incumbentRoot, "incumbent"],
  [candidateRoot, "candidate"],
  [secondRoot, "second"],
]) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "SKILL.md"), `${text}\n`);
}

after(() => rmSync(root, { recursive: true, force: true }));

const plannedAt = "2026-09-01T08:00:00.000Z";
const cliVersions = {
  claude: "claude 2.1.252",
  codex: "codex 0.152.0",
  judge: "claude 2.1.252",
};

function candidate(skillRef = candidateRoot, id = "candidate-a") {
  return { id, skill_ref: skillRef };
}

function makePlan(overrides = {}) {
  return buildExperimentPlan({
    contract,
    contractDigest,
    plannedAt,
    incumbent: { skill_ref: incumbentRoot },
    candidate: candidate(),
    cliVersions,
    ...overrides,
  });
}

function replacePlanField(plan, mutate) {
  const body = structuredClone(plan);
  delete body.plan_digest;
  mutate(body);
  return { ...body, plan_digest: digestObject(body) };
}

test("digestObject and plan validation are stable across persistence", () => {
  assert.equal(
    digestObject({ z: 1, a: { y: 2, x: 3 } }),
    digestObject({ a: { x: 3, y: 2 }, z: 1 }),
  );
  const plan = JSON.parse(JSON.stringify(makePlan()));
  assert.deepEqual(validateExperimentPlan({ plan, contract, contractDigest }), {
    ok: true,
    problems: [],
  });
  const tampered = structuredClone(plan);
  tampered.stages.screen.lanes[0].source.sha256 = "f".repeat(64);
  assert.equal(
    validateExperimentPlan({ plan: tampered, contract, contractDigest }).ok,
    false,
  );
});

test("harness source identity binds five exact paths and their bytes", () => {
  assert.deepEqual(EXPERIMENT_SOURCE_FILES, [
    "scripts/review/review-eval-experiment.mjs",
    "scripts/review/review-eval-experiment-contract.mjs",
    "scripts/review/review-eval-experiment-decision.mjs",
    "scripts/review/review-eval-experiment-cache.mjs",
    "scripts/review/review-eval-experiment-runtime.mjs",
  ]);
  const virtualRoot = "/virtual-review-experiment";
  const bytes = new Map([
    ["a.mjs", Buffer.from("first")],
    ["b.mjs", Buffer.from("second")],
    ["c.mjs", Buffer.from("second")],
  ]);
  const readFile = (file) => bytes.get(path.relative(virtualRoot, file));
  const exact = experimentSourceDigest({
    files: ["a.mjs", "b.mjs"],
    root: virtualRoot,
    readFile,
  });
  assert.equal(
    exact,
    experimentSourceDigest({
      files: ["a.mjs", "b.mjs"],
      root: virtualRoot,
      readFile,
    }),
  );
  assert.notEqual(
    exact,
    experimentSourceDigest({
      files: ["a.mjs", "c.mjs"],
      root: virtualRoot,
      readFile,
    }),
  );
  assert.notEqual(
    exact,
    experimentSourceDigest({
      files: ["a.mjs", "b.mjs"],
      root: virtualRoot,
      readFile: (file) =>
        path.basename(file) === "b.mjs"
          ? Buffer.from("changed")
          : readFile(file),
    }),
  );
  assert.throws(
    () =>
      experimentSourceDigest({
        files: ["../outside.mjs"],
        root: virtualRoot,
        readFile,
      }),
    /source path/,
  );

  const plan = makePlan();
  assert.equal(plan.inputs.harness_source_digest, experimentSourceDigest());
  const forged = replacePlanField(plan, (copy) => {
    copy.inputs.harness_source_digest = "0".repeat(64);
  });
  assert.equal(
    validateExperimentPlan({ plan: forged, contract, contractDigest }).ok,
    false,
  );
});

test("a campaign contains exactly one candidate", () => {
  const plan = makePlan();
  assert.equal(plan.candidate.id, "candidate-a");
  assert.equal("candidates" in plan, false);
  assert.equal(plan.ledger_eligible, false);
  assert.equal(plan.canonical_verdict_eligible, false);
  assert.equal(plan.namespace, "review-skill-experiments/v1");
  assert.throws(
    () =>
      buildExperimentPlan({
        contract,
        contractDigest,
        plannedAt,
        incumbent: { skill_ref: incumbentRoot },
        candidates: [candidate(), candidate(secondRoot, "candidate-b")],
        cliVersions,
      }),
    /exactly one candidate/,
  );
  const incompletePanel = structuredClone(contract);
  incompletePanel.fixtures.find((fixture) => fixture.pr === 1990).p1_ids.pop();
  assert.throws(
    () => makePlan({ contract: incompletePanel }),
    /P1 opportunities/,
  );
});

test("screen, holdout, and live stages use the required paired panels", () => {
  const plan = makePlan({ includeLivePaired: true });
  const screen = stagePlanFor({ plan, stage: "screen" });
  const holdout = stagePlanFor({ plan, stage: "holdout" });
  const live = stagePlanFor({ plan, stage: "live-paired" });

  assert.deepEqual(
    screen.lanes.map((lane) => lane.source.report_index),
    [0, 0, 0],
  );
  assert.deepEqual(
    holdout.lanes.map((lane) => lane.source.report_index),
    [1, 1, 1],
  );
  assert.deepEqual(
    screen.lanes.map((lane) => lane.sequence),
    [
      ["incumbent", "candidate"],
      ["candidate", "incumbent"],
      ["incumbent", "candidate"],
    ],
  );
  assert.equal(live.enabled, true);
  for (const lane of live.lanes) {
    assert.deepEqual(lane.source, {
      kind: "live-finder",
      finder_id: `live-pr-${lane.pr}`,
      shared: true,
      finder_argv_digest: finderArgvDigest(contract),
    });
  }
  assert.throws(
    () => stagePlanFor({ plan, stage: "unknown" }),
    /unknown experiment stage/,
  );
});

test("raw, score, and novel identities drift on every dependent input", () => {
  const plan = makePlan({ includeLivePaired: true });
  const screenLane = plan.stages.screen.lanes[0];
  const incumbent = rawCacheIdentity({
    plan,
    stage: "screen",
    lane: screenLane,
    treatment: "incumbent",
  });
  const candidateIdentity = rawCacheIdentity({
    plan,
    stage: "screen",
    lane: screenLane,
    treatment: "candidate",
  });
  assert.notEqual(incumbent.digest, candidateIdentity.digest);
  assert.throws(
    () =>
      rawCacheIdentity({
        plan,
        stage: "screen",
        lane: screenLane,
        treatment: "candidate",
        sourceDigest: "f".repeat(64),
      }),
    /frozen report digest differs/,
  );

  const liveLane = plan.stages["live-paired"].lanes[0];
  const liveA = rawCacheIdentity({
    plan,
    stage: "live-paired",
    lane: liveLane,
    treatment: "candidate",
    sourceDigest: "a".repeat(64),
  });
  const liveB = rawCacheIdentity({
    plan,
    stage: "live-paired",
    lane: liveLane,
    treatment: "candidate",
    sourceDigest: "b".repeat(64),
  });
  assert.notEqual(liveA.digest, liveB.digest);

  const mutations = [
    (copy) => (copy.contract_digest = "0".repeat(64)),
    (copy) => (copy.inputs.scorer_digest = "1".repeat(64)),
    (copy) => (copy.inputs.harness_source_digest = "7".repeat(64)),
    (copy) => (copy.inputs.finder_argv_digest = "2".repeat(64)),
    (copy) => (copy.candidate.skill_digest = "3".repeat(64)),
    (copy) => (copy.inputs.models.verifier.model = "changed-model"),
    (copy) => (copy.inputs.models.verifier.effort = "changed-effort"),
    (copy) => (copy.inputs.cli_versions.claude = "claude changed"),
    (copy) => (copy.inputs.prompts.handoff.sha256 = "4".repeat(64)),
    (copy) =>
      (copy.stages.screen.lanes[0].fixture.truth_sha256 = "5".repeat(64)),
    (copy) => (copy.stages.screen.lanes[0].source.sha256 = "6".repeat(64)),
    (copy) => (copy.stages.screen.lanes[0].fixture.first_head = "changed-head"),
  ];
  for (const mutate of mutations) {
    const changed = replacePlanField(plan, mutate);
    const changedIdentity = rawCacheIdentity({
      plan: changed,
      stage: "screen",
      lane: changed.stages.screen.lanes[0],
      treatment: "candidate",
    });
    assert.notEqual(changedIdentity.digest, candidateIdentity.digest);
  }
  assert.notEqual(
    scoreCacheIdentity({ plan, rawDigest: "1".repeat(64) }).digest,
    scoreCacheIdentity({ plan, rawDigest: "2".repeat(64) }).digest,
  );
  assert.notEqual(
    novelCacheIdentity({ plan, scoreDigest: "3".repeat(64) }).digest,
    novelCacheIdentity({ plan, scoreDigest: "4".repeat(64) }).digest,
  );
});

test("the qualification manifest is the canonical 24-cell rerun", () => {
  const plan = makePlan();
  const expectedCells = planCells({ contract, kind: "full" });
  assert.equal(plan.qualification.cell_count, 24);
  assert.deepEqual(plan.qualification.cells, expectedCells);
  assert.equal(plan.qualification.experiment_artifact_reuse_allowed, false);
  assert.equal(plan.qualification.skill_digest, skillDigest(candidateRoot));

  const direct = canonicalRerunManifest({
    contract,
    contractDigest,
    scorerDigest: scorerDigest(),
    skillDigest: skillDigest(candidateRoot),
    finderArgvDigest: finderArgvDigest(contract),
    cliVersions,
    treatmentId: "candidate-a",
  });
  assert.deepEqual(plan.qualification, direct);
});

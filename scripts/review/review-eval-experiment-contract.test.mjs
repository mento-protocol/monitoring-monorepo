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
  fullRerunCellCount,
  novelCacheIdentity,
  rawCacheIdentity,
  scoreCacheIdentity,
  stagePlanFor,
} from "./review-eval-experiment-contract.mjs";
import { validateExperimentPlan } from "./review-eval-experiment-plan-check.mjs";
import {
  cliVersionDrift,
  phaseCliVersions,
  recordedPhaseCliVersions,
  recordRuntimeDrift,
  runtimeDriftReason,
} from "./review-eval-experiment-versions.mjs";
import { evaluateExperimentDecision } from "./review-eval-experiment-decision.mjs";
import {
  finderArgvDigest,
  planCells,
  skillDigest,
} from "./review-eval-run-plan.mjs";
import { gridFixtures, PIPELINE_DRAWS } from "./review-eval-fixtures.mjs";
import { scorerDigest } from "./review-eval-score.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const contractBytes = readFileSync(
  path.join(repoRoot, "docs/evals/review-skill-fixtures.json"),
);
const contract = JSON.parse(contractBytes);
const contractDigest = createHash("sha256").update(contractBytes).digest("hex");
// The panel is whatever the contract marks `grid: true`. Every count below is
// read from it, so a fixture joining the grid widens these tests with it.
const grid = gridFixtures(contract).sort((left, right) => left.pr - right.pr);
const gridPrs = grid.map((fixture) => fixture.pr);
const scorableOpportunities = grid.reduce(
  (total, fixture) => total + fixture.scorable_ids.length,
  0,
);
const p1Ids = grid.reduce((total, fixture) => total + fixture.p1_ids.length, 0);
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
    drift: null,
  });
  const tampered = structuredClone(plan);
  tampered.stages.screen.lanes[0].source.sha256 = "f".repeat(64);
  assert.equal(
    validateExperimentPlan({ plan: tampered, contract, contractDigest }).ok,
    false,
  );
});

test("harness source identity binds every module path and its bytes", () => {
  assert.deepEqual(EXPERIMENT_SOURCE_FILES, [
    "scripts/review/review-eval-experiment.mjs",
    "scripts/review/review-eval-experiment-contract.mjs",
    "scripts/review/review-eval-experiment-plan-check.mjs",
    "scripts/review/review-eval-experiment-decision.mjs",
    "scripts/review/review-eval-experiment-stats.mjs",
    "scripts/review/review-eval-experiment-cache.mjs",
    "scripts/review/review-eval-experiment-runtime.mjs",
    "scripts/review/review-eval-experiment-novelty.mjs",
    "scripts/review/review-eval-experiment-versions.mjs",
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
  // Any grid narrower than three fails planning, whatever its width today.
  const smallGrid = structuredClone(contract);
  for (const pr of gridPrs.slice(2)) {
    smallGrid.fixtures.find((fixture) => fixture.pr === pr).grid = false;
  }
  assert.throws(
    () => makePlan({ contract: smallGrid }),
    /at least 3 grid fixtures, got 2/,
  );
  const singleReport = structuredClone(contract);
  const trimmed = gridPrs[0];
  singleReport.fixtures.find(
    (fixture) => fixture.pr === trimmed,
  ).finder_reports = [
    contract.fixtures.find((fixture) => fixture.pr === trimmed)
      .finder_reports[0],
  ];
  assert.throws(
    () => makePlan({ contract: singleReport }),
    new RegExp(`PR ${trimmed} requires two frozen finder reports`),
  );
});

// The formulas the runbook states, written out once so the plan is checked
// against the policy rather than against a transcription of it.
function expectedBars(draws) {
  const p1Opportunities = p1Ids * 2 * draws;
  return {
    screenNet: Math.max(2, Math.round(0.06 * scorableOpportunities * draws)),
    combinedNet: Math.max(
      3,
      Math.round(0.06 * scorableOpportunities * draws * 2),
    ),
    p1Opportunities,
    candidateP1: Math.round(0.75 * p1Opportunities),
    p1Net: Math.max(2, Math.round(p1Opportunities / 6)),
    halfThePanel: Math.ceil(grid.length / 2),
  };
}

test("the grid and the draws derive every threshold in the plan", () => {
  const plan = makePlan();
  const one = expectedBars(1);
  assert.deepEqual(plan.policy.opportunities, {
    prs: grid.length,
    draws: 1,
    reports_per_fixture: 2,
    scorable_opportunities: scorableOpportunities,
    p1_opportunities: one.p1Opportunities,
  });
  assert.equal(plan.policy.screen.known_net_min, one.screenNet);
  assert.equal(plan.policy.screen.nonnegative_prs_min, one.halfThePanel);
  assert.equal(plan.policy.combined.known_net_min, one.combinedNet);
  assert.equal(plan.policy.combined.candidate_p1_min, one.candidateP1);
  assert.equal(plan.policy.combined.p1_net_min, one.p1Net);
  // The reject bound is the screen bar negated at both stages, so the holdout
  // rejects the same size of loss the screen does.
  assert.equal(plan.policy.screen.known_net_reject_max, -one.screenNet);
  assert.equal(plan.policy.combined.known_net_reject_max, -one.screenNet);

  // Four draws quadruple the panel, and every derived bar follows it up.
  const four = expectedBars(4);
  const wide = makePlan({ draws: 4 });
  assert.equal(wide.draws, 4);
  assert.equal(
    wide.policy.opportunities.p1_opportunities,
    four.p1Opportunities,
  );
  assert.equal(wide.policy.screen.known_net_min, four.screenNet);
  assert.equal(wide.policy.combined.known_net_min, four.combinedNet);
  assert.equal(wide.policy.combined.candidate_p1_min, four.candidateP1);
  assert.equal(wide.policy.combined.p1_net_min, four.p1Net);
  assert.equal(four.screenNet > one.screenNet, true);
  assert.equal(wide.policy.combined.known_net_reject_max, -four.screenNet);
  assert.throws(
    () => makePlan({ draws: 0 }),
    /draws must be an integer 1\.\.5/,
  );
  // Five draws plan; six are refused rather than clamped, because every draw
  // multiplies the paid cells.
  assert.equal(makePlan({ draws: 5 }).draws, 5);
  assert.throws(
    () => makePlan({ draws: 6 }),
    /draws must be an integer 1\.\.5/,
  );
});

test("each draw is its own lane, its own order, and its own cells", () => {
  const plan = makePlan({ draws: 2 });
  const screen = stagePlanFor({ plan, stage: "screen" });
  assert.equal(screen.draws, 2);
  assert.deepEqual(
    screen.lanes.map((lane) => [lane.lane_id, lane.draw, lane.paired_order]),
    gridPrs.flatMap((pr, index) =>
      [0, 1].map((draw) => [
        `screen-pr-${pr}-d${draw}`,
        draw,
        (index + draw) % 2 === 0 ? "AB" : "BA",
      ]),
    ),
  );
  // Both draws of a PR read the identical frozen report.
  assert.deepEqual(screen.lanes[0].source, screen.lanes[1].source);

  const identityFor = (lane) =>
    rawCacheIdentity({
      plan,
      stage: "screen",
      lane,
      treatment: "candidate",
      cliVersions,
    });
  const first = identityFor(screen.lanes[0]);
  const second = identityFor(screen.lanes[1]);
  assert.equal(first.draw, 0);
  assert.equal(second.draw, 1);
  // The draw is what separates them: same report, same arm, same skill.
  assert.notEqual(first.digest, second.digest);
  assert.equal(identityFor(screen.lanes[0]).digest, first.digest);
  const rawDigest = "1".repeat(64);
  assert.notEqual(
    scoreCacheIdentity({ plan, rawDigest, draw: 1, cliVersions }).digest,
    scoreCacheIdentity({ plan, rawDigest, draw: 0, cliVersions }).digest,
  );
  assert.equal(
    scoreCacheIdentity({ plan, rawDigest, draw: 0, cliVersions }).digest,
    scoreCacheIdentity({ plan, rawDigest, cliVersions }).digest,
  );
  const scoreDigest = "2".repeat(64);
  assert.notEqual(
    novelCacheIdentity({ plan, scoreDigest, draw: 1, cliVersions }).digest,
    novelCacheIdentity({ plan, scoreDigest, draw: 0, cliVersions }).digest,
  );
  assert.throws(
    () => scoreCacheIdentity({ plan, rawDigest, draw: -1, cliVersions }),
    /draw must be a non-negative integer/,
  );
});

test("screen, holdout, and live stages use the required paired panels", () => {
  const plan = makePlan({ includeLivePaired: true });
  const screen = stagePlanFor({ plan, stage: "screen" });
  const holdout = stagePlanFor({ plan, stage: "holdout" });
  const live = stagePlanFor({ plan, stage: "live-paired" });

  assert.deepEqual(
    screen.lanes.map((lane) => lane.source.report_index),
    grid.map(() => 0),
  );
  assert.deepEqual(
    holdout.lanes.map((lane) => lane.source.report_index),
    grid.map(() => 1),
  );
  assert.deepEqual(
    screen.lanes.map((lane) => lane.pr),
    gridPrs,
  );
  // The order alternates on the fixture index at one draw.
  assert.deepEqual(
    screen.lanes.map((lane) => lane.sequence),
    gridPrs.map((_pr, index) =>
      index % 2 === 0 ? ["incumbent", "candidate"] : ["candidate", "incumbent"],
    ),
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
    cliVersions,
  });
  const candidateIdentity = rawCacheIdentity({
    plan,
    stage: "screen",
    lane: screenLane,
    treatment: "candidate",
    cliVersions,
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
        cliVersions,
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
    cliVersions,
  });
  const liveB = rawCacheIdentity({
    plan,
    stage: "live-paired",
    lane: liveLane,
    treatment: "candidate",
    sourceDigest: "b".repeat(64),
    cliVersions,
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
      cliVersions,
    });
    assert.notEqual(changedIdentity.digest, candidateIdentity.digest);
  }
  assert.notEqual(
    scoreCacheIdentity({ plan, rawDigest: "1".repeat(64), cliVersions }).digest,
    scoreCacheIdentity({ plan, rawDigest: "2".repeat(64), cliVersions }).digest,
  );
  assert.notEqual(
    novelCacheIdentity({ plan, scoreDigest: "3".repeat(64), cliVersions })
      .digest,
    novelCacheIdentity({ plan, scoreDigest: "4".repeat(64), cliVersions })
      .digest,
  );
});

test("cache identities key on the live version of each phase's providers", () => {
  const plan = makePlan({ includeLivePaired: true });
  const screenLane = plan.stages.screen.lanes[0];
  const liveLane = plan.stages["live-paired"].lanes[0];
  const rawFor = (versions, lane = screenLane, stage = "screen") =>
    rawCacheIdentity({
      plan,
      stage,
      lane,
      treatment: "candidate",
      sourceDigest: stage === "screen" ? null : "a".repeat(64),
      cliVersions: versions,
    });
  const upgradedClaude = { ...cliVersions, claude: "claude 2.1.259" };
  const upgradedCodex = { ...cliVersions, codex: "codex 0.152.1" };
  const upgradedJudge = { ...cliVersions, judge: "judge 2.1.259" };

  // An upgraded contestant CLI never finds the artifact the old one wrote.
  assert.notEqual(rawFor(upgradedClaude).digest, rawFor(cliVersions).digest);
  assert.deepEqual(rawFor(cliVersions).cli_versions, {
    claude: cliVersions.claude,
  });
  // A frozen-report lane spawns no finder, so Codex is not part of its cell.
  assert.equal(rawFor(upgradedCodex).digest, rawFor(cliVersions).digest);
  // The live-paired lane does spawn the finder, so Codex is part of that cell.
  const liveBase = rawFor(cliVersions, liveLane, "live-paired");
  assert.deepEqual(liveBase.cli_versions, {
    claude: cliVersions.claude,
    codex: cliVersions.codex,
  });
  assert.notEqual(
    rawFor(upgradedCodex, liveLane, "live-paired").digest,
    liveBase.digest,
  );
  const rawDigest = "1".repeat(64);
  const scoreDigest = "2".repeat(64);
  assert.notEqual(
    scoreCacheIdentity({ plan, rawDigest, cliVersions: upgradedJudge }).digest,
    scoreCacheIdentity({ plan, rawDigest, cliVersions }).digest,
  );
  assert.notEqual(
    novelCacheIdentity({ plan, scoreDigest, cliVersions: upgradedJudge })
      .digest,
    novelCacheIdentity({ plan, scoreDigest, cliVersions }).digest,
  );
  assert.deepEqual(
    scoreCacheIdentity({ plan, rawDigest, cliVersions }).cli_versions,
    { judge: cliVersions.judge },
  );
  assert.throws(
    () => phaseCliVersions({ phase: "stage", cliVersions }),
    /unknown experiment cache phase/,
  );

  // A phase that answers without a provider keys on the empty set, and an
  // identity rebuilt from a record's own bytes keys on what that record ran.
  assert.deepEqual(
    phaseCliVersions({ phase: "score", cliVersions, invokesJudge: false }),
    {},
  );
  assert.equal(
    scoreCacheIdentity({ plan, rawDigest, phaseVersions: { judge: "judge 1" } })
      .digest,
    scoreCacheIdentity({
      plan,
      rawDigest,
      cliVersions: { ...cliVersions, judge: "judge 1" },
    }).digest,
  );
  assert.notEqual(
    scoreCacheIdentity({ plan, rawDigest, phaseVersions: {} }).digest,
    scoreCacheIdentity({ plan, rawDigest, cliVersions }).digest,
  );

  // A raw identity keys on the set the cell stores and validates as well, so a
  // provider the raw phase never invoked cannot re-key a contestant cell.
  assert.equal(
    rawCacheIdentity({
      plan,
      stage: "screen",
      lane: screenLane,
      treatment: "candidate",
      sourceDigest: null,
      cliVersions: upgradedClaude,
      phaseVersions: { claude: cliVersions.claude },
    }).digest,
    rawFor(cliVersions).digest,
  );
});

test("a record's recorded phase provenance is read strictly", () => {
  const record = {
    cell_id: "screen-pr-1990-d0-candidate",
    cli_versions: { raw: { claude: "claude 1" }, score: { judge: "judge 1" } },
  };
  assert.deepEqual(recordedPhaseCliVersions({ record, phase: "score" }), {
    judge: "judge 1",
  });
  assert.deepEqual(
    recordedPhaseCliVersions({
      record: {
        ...record,
        cli_versions: { ...record.cli_versions, score: {} },
      },
      phase: "score",
    }),
    {},
  );
  assert.throws(
    () => recordedPhaseCliVersions({ record, phase: "novel" }),
    /screen-pr-1990-d0-candidate stores no novel runtime provenance/,
  );
  assert.throws(
    () =>
      recordedPhaseCliVersions({
        record: { ...record, cli_versions: { score: "judge 1" } },
        phase: "score",
      }),
    /score CLI versions must be an object/,
  );
  assert.throws(
    () =>
      recordedPhaseCliVersions({
        record: { ...record, cli_versions: { score: { claude: "claude 1" } } },
        phase: "score",
      }),
    /names score provider "claude", which that phase never invokes/,
  );
  assert.throws(
    () =>
      recordedPhaseCliVersions({
        record: { ...record, cli_versions: { score: { judge: "" } } },
        phase: "score",
      }),
    /score\.judge must be a non-empty string/,
  );
});

test("the qualification manifest is the canonical full rerun", () => {
  const plan = makePlan();
  const expectedCells = planCells({ contract, kind: "full" });
  // Two pipeline draws of every fixture, one replay per frozen grid report,
  // and one control cell per fixture. A grid fixture added to the contract
  // moves this count rather than failing the manifest against a literal.
  const replays = grid.reduce(
    (total, fixture) => total + fixture.finder_reports.length,
    0,
  );
  const expectedCount =
    PIPELINE_DRAWS * contract.fixtures.length +
    replays +
    contract.fixtures.length;
  assert.equal(expectedCells.length, expectedCount);
  assert.equal(plan.qualification.cell_count, expectedCount);
  assert.equal(fullRerunCellCount(contract), expectedCount);
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

test("a stored plan validates against its own recorded CLI versions", () => {
  const plan = JSON.parse(JSON.stringify(makePlan()));
  const upgraded = { claude: "claude 2.1.259", codex: cliVersions.codex };
  const validation = validateExperimentPlan({
    plan,
    contract,
    contractDigest,
    cliVersions: upgraded,
  });
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.drift.providers, [
    { provider: "claude", planned: cliVersions.claude, live: "claude 2.1.259" },
    { provider: "judge", planned: cliVersions.judge, live: "claude 2.1.259" },
  ]);
  assert.equal(
    validateExperimentPlan({ plan, contract, contractDigest }).drift,
    null,
  );
  const tampered = replacePlanField(plan, (copy) => {
    copy.inputs.finder_argv_digest = "9".repeat(64);
  });
  const broken = validateExperimentPlan({
    plan: tampered,
    contract,
    contractDigest,
    cliVersions: upgraded,
  });
  assert.equal(broken.ok, false);
  assert.match(broken.problems[0], /inputs\.finder_argv_digest/);
});

function armRecords(plan, stage, versionsFor) {
  return plan.stages[stage].lanes.flatMap((lane) =>
    lane.sequence.map((treatment) => ({
      ok: true,
      campaign_id: plan.campaign_id,
      candidate_id: plan.candidate.id,
      stage,
      cell_id: `${lane.lane_id}-${treatment}`,
      pr: lane.pr,
      treatment,
      claims_count: 1,
      matched_ids: [],
      leak: { suspected: false },
      empty: false,
      cli_versions: versionsFor({ lane, treatment }),
    })),
  );
}

test("drift is read from the records, and only from phases that ran", () => {
  const plan = makePlan();
  const planned = plan.inputs.cli_versions;
  const onPlan = {
    raw: { claude: planned.claude },
    score: { judge: planned.judge },
  };
  const steady = armRecords(plan, "screen", () => onPlan);
  assert.equal(recordRuntimeDrift({ planned, records: steady }), null);

  // A frozen-report lane spawns no finder, so a Codex upgrade during the
  // screen is attributed to nothing.
  const codexDrifted = cliVersionDrift({
    planned,
    live: { ...planned, codex: "codex 0.152.9" },
  });
  assert.equal(codexDrifted.providers.length, 1);
  assert.equal(recordRuntimeDrift({ planned, records: steady }), null);

  const upgraded = "claude 2.1.259";
  const records = armRecords(plan, "screen", ({ lane, treatment }) =>
    lane.pr === 1990 && treatment === "candidate"
      ? { raw: { claude: upgraded }, score: { judge: planned.judge } }
      : onPlan,
  );
  const drift = recordRuntimeDrift({ planned, records });
  assert.deepEqual(drift.providers, [
    {
      provider: "claude",
      planned: planned.claude,
      live: upgraded,
      cell_ids: ["screen-pr-1990-d0-candidate"],
    },
  ]);
  const decision = evaluateExperimentDecision({
    plan,
    stage: "screen",
    recordsByStage: { screen: records },
    runtimeDrift: drift,
  });
  assert.equal(
    decision.reasons[0],
    `runtime drift: claude ${planned.claude} -> ${upgraded} ` +
      "on screen-pr-1990-d0-candidate",
  );
  assert.equal(decision.reasons.length > 1, true);
  assert.deepEqual(decision.runtime_drift.cell_ids, [
    "screen-pr-1990-d0-candidate",
  ]);
  const clean = evaluateExperimentDecision({
    plan,
    stage: "screen",
    recordsByStage: { screen: steady },
  });
  assert.equal(Object.hasOwn(clean, "runtime_drift"), false);
  assert.equal(runtimeDriftReason(null), null);
});

test("drift reporting fails closed on a record it cannot read", () => {
  const plan = makePlan();
  const planned = plan.inputs.cli_versions;
  const upgraded = { raw: { claude: "claude 2.1.259" } };
  const broken = (cliVersions) => [
    { cell_id: "screen-pr-1990-d0-candidate", cli_versions: upgraded },
    { cell_id: "screen-pr-1990-d0-incumbent", cli_versions: cliVersions },
  ];
  // Skipping any of these would report the first cell's upgrade as the whole
  // story and present the second cell as a clean, on-plan run.
  for (const [cliVersions, message] of [
    [undefined, /screen-pr-1990-d0-incumbent stores no runtime provenance/],
    [null, /screen-pr-1990-d0-incumbent stores no runtime provenance/],
    [
      "claude 2.1.259",
      /screen-pr-1990-d0-incumbent stores no runtime provenance/,
    ],
    [{ stage: { claude: "claude 2" } }, /names unknown cache phase "stage"/],
    [{ raw: "claude 2" }, /raw CLI versions must be an object/],
    [
      { score: { claude: "claude 2" } },
      /names score provider "claude", which that phase never invokes/,
    ],
    [{ raw: { claude: "" } }, /raw\.claude must be a non-empty string/],
  ]) {
    assert.throws(
      () => recordRuntimeDrift({ planned, records: broken(cliVersions) }),
      message,
    );
  }
  assert.deepEqual(
    recordRuntimeDrift({
      planned,
      records: broken({ raw: { claude: planned.claude }, score: {} }),
    }).cell_ids,
    ["screen-pr-1990-d0-candidate"],
  );
});

test("a novelty judge that drifts alone still names its cell", () => {
  const plan = makePlan();
  const planned = plan.inputs.cli_versions;
  const upgraded = "judge 2.1.259";
  const records = armRecords(plan, "screen", ({ lane, treatment }) => ({
    raw: { claude: planned.claude },
    score: { judge: planned.judge },
    ...(lane.pr === 1995 && treatment === "incumbent"
      ? { novel: { judge: upgraded } }
      : { novel: { judge: planned.judge } }),
  }));
  const drift = recordRuntimeDrift({ planned, records });
  assert.deepEqual(drift.providers, [
    {
      provider: "judge",
      planned: planned.judge,
      live: upgraded,
      cell_ids: ["screen-pr-1995-d0-incumbent"],
    },
  ]);
  assert.equal(
    runtimeDriftReason(drift),
    `runtime drift: judge ${planned.judge} -> ${upgraded} ` +
      "on screen-pr-1995-d0-incumbent",
  );
});

test("a combined decision names every transition across both stages", () => {
  const plan = makePlan();
  const planned = plan.inputs.cli_versions;
  const screenClaude = "claude 2.1.259";
  const holdoutClaude = "claude 2.1.260";
  const screen = armRecords(plan, "screen", ({ lane, treatment }) => ({
    raw: {
      claude:
        lane.pr === gridPrs[0] && treatment === "candidate"
          ? screenClaude
          : planned.claude,
    },
    score: { judge: planned.judge },
  }));
  const holdout = armRecords(plan, "holdout", () => ({
    raw: { claude: holdoutClaude },
    score: { judge: planned.judge },
  }));
  const drift = recordRuntimeDrift({
    planned,
    records: [...screen, ...holdout],
  });
  // Both arms of every grid lane drifted in the holdout; one candidate cell
  // drifted in the screen.
  const holdoutCells = gridPrs.length * 2;
  assert.deepEqual(
    drift.providers.map((entry) => [entry.live, entry.cell_ids.length]),
    [
      [screenClaude, 1],
      [holdoutClaude, holdoutCells],
    ],
  );
  const decision = evaluateExperimentDecision({
    plan,
    stage: "holdout",
    recordsByStage: { screen, holdout },
    runtimeDrift: drift,
  });
  assert.equal(
    decision.reasons[0],
    `runtime drift: claude ${planned.claude} -> ${screenClaude} ` +
      `on screen-pr-${gridPrs[0]}-d0-candidate; ` +
      `claude ${planned.claude} -> ${holdoutClaude} on ` +
      drift.providers[1].cell_ids.join(", "),
  );
  assert.equal(decision.runtime_drift.cell_ids.length, holdoutCells + 1);
});

/**
 * A six-fixture contract, every one of them on the grid. Fixtures that carry no
 * frozen report get two synthetic ones: the plan binds a report's path and
 * digest, never its bytes.
 */
function sixGridContract() {
  const copy = structuredClone(contract);
  copy.fixtures = copy.fixtures.slice(0, 6).map((fixture, index) => ({
    ...fixture,
    grid: true,
    finder_reports:
      (fixture.finder_reports ?? []).length === 2
        ? fixture.finder_reports
        : [0, 1].map((report) => ({
            file: `docs/evals/review-skill-finder-reports/pr-${fixture.pr}-draw${report + 1}.md`,
            sha256: createHash("sha256")
              .update(`synthetic-${index}-${report}`)
              .digest("hex"),
          })),
  }));
  return copy;
}

test("a six-fixture grid plans its own rerun manifest and its own panel", () => {
  const wideContract = sixGridContract();
  const wideDigest = createHash("sha256")
    .update(JSON.stringify(wideContract))
    .digest("hex");
  const plan = makePlan({ contract: wideContract, contractDigest: wideDigest });

  // Six fixtures: twelve pipeline cells, twelve replay cells, six control
  // cells. The manifest derives that rather than checking a literal, so a
  // widened grid plans instead of throwing.
  assert.equal(fullRerunCellCount(wideContract), 30);
  assert.equal(plan.qualification.cell_count, 30);
  assert.equal(plan.qualification.cells.length, 30);

  const screen = stagePlanFor({ plan, stage: "screen" });
  assert.equal(screen.lanes.length, 6);
  assert.deepEqual(
    screen.lanes.map((lane) => lane.pr),
    wideContract.fixtures.map((fixture) => fixture.pr).sort((a, b) => a - b),
  );
  assert.equal(plan.policy.opportunities.prs, 6);
  assert.equal(plan.policy.screen.nonnegative_prs_min, 3);

  // Twelve lanes at two draws, and the manifest is unchanged by the draw count.
  const twoDraws = makePlan({
    contract: wideContract,
    contractDigest: wideDigest,
    draws: 2,
  });
  assert.equal(
    stagePlanFor({ plan: twoDraws, stage: "screen" }).lanes.length,
    12,
  );
  assert.equal(twoDraws.qualification.cell_count, 30);
});

/** One screen record per arm of every lane, with the candidate one match up. */
function screenRecords(plan) {
  return plan.stages.screen.lanes.flatMap((lane) =>
    lane.sequence.map((treatment) => ({
      ok: true,
      campaign_id: plan.campaign_id,
      candidate_id: plan.candidate.id,
      stage: "screen",
      cell_id: `${lane.lane_id}-${treatment}`,
      pr: lane.pr,
      treatment,
      claims_count: 2,
      matched_ids:
        treatment === "candidate" ? [lane.fixture.scorable_ids[0]] : [],
      leak: { suspected: false },
      empty: false,
    })),
  );
}

test("a grid fixture with no P1 defect plans, derives, and decides", () => {
  const wideContract = sixGridContract();
  const zeroP1Pr = wideContract.fixtures[0].pr;
  wideContract.fixtures[0] = { ...wideContract.fixtures[0], p1_ids: [] };
  const wideDigest = createHash("sha256")
    .update(JSON.stringify(wideContract))
    .digest("hex");
  const plan = makePlan({ contract: wideContract, contractDigest: wideDigest });
  const panelP1 = wideContract.fixtures
    .slice(1)
    .reduce((total, fixture) => total + fixture.p1_ids.length, 0);
  const p1Opportunities = panelP1 * 2;

  // The fixture is a full member of the panel on the known-defect axis and
  // contributes nothing on the P1 axis, so every P1 bar is the other five
  // fixtures' own.
  assert.equal(plan.policy.opportunities.prs, 6);
  assert.equal(
    plan.policy.opportunities.scorable_opportunities,
    wideContract.fixtures.reduce(
      (total, fixture) => total + fixture.scorable_ids.length,
      0,
    ),
  );
  assert.equal(plan.policy.opportunities.p1_opportunities, p1Opportunities);
  assert.equal(
    plan.policy.combined.candidate_p1_min,
    Math.round(0.75 * p1Opportunities),
  );
  assert.equal(
    plan.policy.combined.p1_net_min,
    Math.max(2, Math.round(p1Opportunities / 6)),
  );
  for (const bar of [
    plan.policy.screen.known_net_min,
    plan.policy.screen.p1_net_min,
    plan.policy.combined.candidate_p1_min,
    plan.policy.combined.p1_net_min,
  ]) {
    assert.equal(Number.isSafeInteger(bar), true);
  }
  assert.deepEqual(
    stagePlanFor({ plan, stage: "screen" }).lanes.find(
      (lane) => lane.pr === zeroP1Pr,
    ).fixture.p1_ids,
    [],
  );

  // And the stage decides: the zero-P1 lane carries its known-defect gain into
  // the paired net without being asked for a P1 it never froze.
  const decided = evaluateExperimentDecision({
    plan,
    stage: "screen",
    recordsByStage: { screen: screenRecords(plan) },
  });
  assert.equal(decided.status, "PROMISING");
  assert.equal(decided.metrics.known.net, plan.stages.screen.lanes.length);
  assert.equal(
    decided.metrics.per_pr.find((entry) => entry.pr === zeroP1Pr).known.net,
    1,
  );
  assert.equal(decided.metrics.p1.net >= 0, true);
  assert.equal(decided.metrics.p1_gates, "applicable");
});

test("a grid with no P1 defect anywhere plans an inert P1 gate, not an impossible one", () => {
  const wideContract = sixGridContract();
  wideContract.fixtures = wideContract.fixtures.map((fixture) => ({
    ...fixture,
    p1_ids: [],
  }));
  const wideDigest = createHash("sha256")
    .update(JSON.stringify(wideContract))
    .digest("hex");
  const plan = makePlan({ contract: wideContract, contractDigest: wideDigest });

  // At their floors the finalist gate would ask for a P1 net of two out of
  // zero opportunities, which no candidate could ever reach.
  assert.equal(plan.policy.opportunities.p1_opportunities, 0);
  assert.equal(plan.policy.combined.candidate_p1_min, 0);
  assert.equal(plan.policy.combined.p1_net_min, 0);
  assert.equal(plan.policy.combined.p1_gates, "not applicable");
  assert.equal(plan.policy.screen.p1_gates, "not applicable");
  // The known-defect panel is untouched, so the lane still measures recall.
  assert.equal(plan.policy.screen.known_net_min > 0, true);

  const decided = evaluateExperimentDecision({
    plan,
    stage: "screen",
    recordsByStage: { screen: screenRecords(plan) },
  });
  assert.equal(decided.metrics.p1_gates, "not applicable");
  assert.equal(decided.metrics.p1.net, 0);
  assert.equal(decided.status, "PROMISING");
});

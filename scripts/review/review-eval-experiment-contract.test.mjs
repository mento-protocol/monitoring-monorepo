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
import { scorerDigest } from "./review-eval-score.mjs";
import {
  experimentFixtures,
  experimentPolicy,
} from "./review-eval-experiment-grid.mjs";

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
    "scripts/review/review-eval-experiment-decision.mjs",
    "scripts/review/review-eval-experiment-grid.mjs",
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
  // The panel is the contract's grid, so a grid too narrow to pair is the
  // only shape planning refuses.
  const narrowed = structuredClone(contract);
  for (const fixture of narrowed.fixtures
    .filter((entry) => entry.grid)
    .slice(2)) {
    fixture.grid = false;
  }
  assert.throws(
    () => makePlan({ contract: narrowed }),
    /at least 3 grid fixtures/,
  );
});

test("screen, holdout, and live stages use the required paired panels", () => {
  const plan = makePlan({ includeLivePaired: true });
  const screen = stagePlanFor({ plan, stage: "screen" });
  const holdout = stagePlanFor({ plan, stage: "holdout" });
  const live = stagePlanFor({ plan, stage: "live-paired" });

  // Every grid fixture the contract carries gets a lane, at whatever width the
  // grid has grown to.
  const gridPrs = contract.fixtures
    .filter((fixture) => fixture.grid === true)
    .map((fixture) => fixture.pr)
    .sort((left, right) => left - right);
  assert.deepEqual(
    screen.lanes.map((lane) => lane.pr),
    gridPrs,
  );
  assert.deepEqual(
    screen.lanes.map((lane) => lane.source.report_index),
    gridPrs.map(() => 0),
  );
  assert.deepEqual(
    holdout.lanes.map((lane) => lane.source.report_index),
    gridPrs.map(() => 1),
  );
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

test("a two-draw campaign keys every lane and cell on its draw", () => {
  const plan = makePlan({ draws: 2 });
  assert.equal(plan.draws, 2);
  const screen = stagePlanFor({ plan, stage: "screen" });
  const prs = new Set(screen.lanes.map((lane) => lane.pr));
  assert.equal(screen.lanes.length, prs.size * 2);
  const [first, second] = screen.lanes.filter(
    (lane) => lane.pr === screen.lanes[0].pr,
  );
  assert.deepEqual(
    [first.lane_id, second.lane_id],
    [`screen-pr-${first.pr}-d0`, `screen-pr-${first.pr}-d1`],
  );
  // The two draws read the same frozen report through opposite arm orders.
  assert.deepEqual(first.source, second.source);
  assert.notDeepEqual(first.sequence, second.sequence);

  const rawIdentity = (lane) =>
    rawCacheIdentity({
      plan,
      stage: "screen",
      lane,
      treatment: "candidate",
      cliVersions,
    });
  assert.equal(rawIdentity(first).draw, 0);
  assert.equal(rawIdentity(second).draw, 1);
  assert.notEqual(rawIdentity(first).digest, rawIdentity(second).digest);
  const rawDigest = "a".repeat(64);
  assert.notEqual(
    scoreCacheIdentity({ plan, rawDigest, draw: 0, cliVersions }).digest,
    scoreCacheIdentity({ plan, rawDigest, draw: 1, cliVersions }).digest,
  );
  const scoreDigest = "b".repeat(64);
  assert.notEqual(
    novelCacheIdentity({ plan, scoreDigest, draw: 0, cliVersions }).digest,
    novelCacheIdentity({ plan, scoreDigest, draw: 1, cliVersions }).digest,
  );
  assert.throws(
    () => makePlan({ draws: 6 }),
    /draws must be an integer 1\.\.5/,
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

test("the qualification manifest is the contract's own full rerun", () => {
  const plan = makePlan();
  const expectedCells = planCells({ contract, kind: "full" });
  assert.equal(plan.qualification.cell_count, expectedCells.length);
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
        lane.pr === 1990 && treatment === "candidate"
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
  assert.deepEqual(
    drift.providers.map((entry) => [entry.live, entry.cell_ids.length]),
    [
      [screenClaude, 1],
      [holdoutClaude, holdout.length],
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
      "on screen-pr-1990-d0-candidate; " +
      `claude ${planned.claude} -> ${holdoutClaude} on ` +
      drift.providers[1].cell_ids.join(", "),
  );
  assert.equal(decision.runtime_drift.cell_ids.length, 1 + holdout.length);
});

// The screens this lane has already read, decided again by today's rule. Each
// case is a screen the incumbent and a candidate produced on PRs 1990, 1995 and
// 1999 at one draw, replayed through a contract narrowed to those three
// fixtures: the panel the counts were drawn from, and the panel whose
// thresholds they derive.
const RECORDED_PRS = [1990, 1995, 1999];
const recordedContract = structuredClone(contract);
for (const fixture of recordedContract.fixtures) {
  fixture.grid = fixture.grid === true && RECORDED_PRS.includes(fixture.pr);
  if (!fixture.grid) fixture.finder_reports = [];
}
const recordedPlan = makePlan({ contract: recordedContract });

// Claim counts are equal across the arms, so no case turns on claim inflation.
function screenArm(lane, treatment, known, p1) {
  const ordinary = lane.fixture.scorable_ids.filter(
    (id) => !lane.fixture.p1_ids.includes(id),
  );
  const matched = [
    ...lane.fixture.p1_ids.slice(0, p1),
    ...ordinary.slice(0, known - p1),
  ];
  assert.equal(matched.length, known, `PR ${lane.pr} cannot match ${known}`);
  return {
    ok: true,
    campaign_id: recordedPlan.campaign_id,
    candidate_id: recordedPlan.candidate.id,
    stage: "screen",
    cell_id: `${lane.lane_id}-${treatment}`,
    pr: lane.pr,
    treatment,
    claims_count: 24,
    matched_ids: matched,
    leak: { suspected: false },
    empty: false,
  };
}

/** One screen, as `pr -> [incumbent known, P1, candidate known, P1]`. */
function decideScreen(byPr) {
  return evaluateExperimentDecision({
    plan: recordedPlan,
    candidateId: recordedPlan.candidate.id,
    stage: "screen",
    recordsByStage: {
      screen: recordedPlan.stages.screen.lanes.flatMap((lane) => {
        const [known, p1, candidateKnown, candidateP1] = byPr[lane.pr];
        return [
          screenArm(lane, "incumbent", known, p1),
          screenArm(lane, "candidate", candidateKnown, candidateP1),
        ];
      }),
    },
  });
}

test("the recorded screens keep their verdicts under the paired rule", () => {
  assert.deepEqual(
    recordedPlan.stages.screen.lanes.map((lane) => lane.pr),
    RECORDED_PRS,
  );
  // 15 -> 19 known, 4 -> 5 P1, per-PR nets +2, +2, 0.
  const netGain = decideScreen({
    1990: [3, 2, 5, 3],
    1995: [4, 1, 6, 1],
    1999: [8, 1, 8, 1],
  });
  assert.deepEqual(netGain.metrics.known, {
    incumbent: 15,
    candidate: 19,
    net: 4,
  });
  assert.deepEqual(netGain.metrics.p1, { incumbent: 4, candidate: 5, net: 1 });
  assert.deepEqual(
    netGain.metrics.per_pr.map((row) => row.known.net),
    [2, 2, 0],
  );
  assert.equal(netGain.status, "PROMISING");
  // Two of the three lanes differ, so the flip distribution is four wide and
  // one assignment reaches the observed sum. Reported, never gating.
  assert.deepEqual(netGain.metrics.sign_flip, {
    pairs: 3,
    informative_pairs: 2,
    p_value: 0.25,
  });

  // 16 -> 16: nothing moved, and no lane differs.
  const flat = decideScreen({
    1990: [5, 2, 5, 2],
    1995: [5, 1, 5, 1],
    1999: [6, 1, 6, 1],
  });
  assert.equal(flat.metrics.known.net, 0);
  assert.equal(flat.status, "INCONCLUSIVE");
  assert.deepEqual(flat.reasons, ["known net missed"]);
  assert.equal(flat.metrics.sign_flip.informative_pairs, 0);

  // 17 -> 18, P1 4 -> 4, per-PR nets +1, 0, 0: one match short of the bar.
  const shallow = decideScreen({
    1990: [4, 2, 5, 2],
    1995: [5, 1, 5, 1],
    1999: [8, 1, 8, 1],
  });
  assert.equal(shallow.metrics.known.net, 1);
  assert.equal(shallow.metrics.p1.net, 0);
  assert.equal(shallow.status, "INCONCLUSIVE");
  assert.deepEqual(shallow.reasons, ["known net missed"]);

  // 18 -> 17 known and 5 -> 4 P1: a P1 loss rejects whatever the net.
  const rejected = decideScreen({
    1990: [5, 3, 5, 3],
    1995: [5, 1, 4, 0],
    1999: [8, 1, 8, 1],
  });
  assert.equal(rejected.metrics.known.net, -1);
  assert.equal(rejected.metrics.p1.net, -1);
  // Minus one is short of the negated bar; the P1 loss rejects this screen.
  assert.equal(rejected.status, "REJECT");

  // The live grid sets its own bar, and it can only be wider than this one.
  const live = makePlan();
  assert.deepEqual(
    live.policy,
    experimentPolicy({ fixtures: experimentFixtures(contract) }),
  );
  assert.equal(
    live.policy.screen.known_net_min >=
      recordedPlan.policy.screen.known_net_min,
    true,
  );
});

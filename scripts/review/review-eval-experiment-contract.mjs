// Immutable plans and cache identities for the non-ledger experiment lane.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gridFixtures, PIPELINE_DRAWS } from "./review-eval-fixtures.mjs";
import {
  finderArgvDigest as canonicalFinderArgvDigest,
  planCells,
  skillDigest as canonicalSkillDigest,
} from "./review-eval-run-plan.mjs";
import { scorerDigest as canonicalScorerDigest } from "./review-eval-score.mjs";
import {
  cliVersionIdentity,
  isObject,
  nonempty,
  phaseVersionsFor,
} from "./review-eval-experiment-versions.mjs";
import { experimentPolicy } from "./review-eval-experiment-stats.mjs";

export const EXPERIMENT_SCHEMA_VERSION = 1;
export const EXPERIMENT_NAMESPACE = "review-skill-experiments/v1";
export const EXPERIMENT_STATUSES = Object.freeze([
  "PROMISING",
  "REJECT",
  "INCONCLUSIVE",
]);
export const EXPERIMENT_STAGES = Object.freeze([
  "screen",
  "holdout",
  "live-paired",
]);
/** The grid is any size from this up; only concurrency is capped at three. */
export const MIN_GRID_FIXTURES = 3;
/**
 * Fixture trees the runner works at once, one PR each. Every draw of a PR
 * shares that PR's tree, so the runner never overlaps two of its lanes. Cost
 * control, not panel size.
 */
export const LANE_CONCURRENCY_MAX = 3;
export const DEFAULT_DRAWS = 1;
/**
 * The most draws one campaign may plan.
 *
 * Every draw multiplies the paid cells: at six grid fixtures a screen is
 * `grid x draws x 2` verifier cells, so five draws already cost sixty cells a
 * stage. The cap is a spend guard, not a statistical one — a wider panel is
 * bought with more fixtures rather than more repeats of the same one.
 */
export const MAX_DRAWS = 5;
export const EXPERIMENT_SOURCE_FILES = Object.freeze([
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

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const experimentRepoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function digestObject(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

/** Hash the exact relative path and bytes of every lean harness module. */
export function experimentSourceDigest({
  files = EXPERIMENT_SOURCE_FILES,
  root = experimentRepoRoot,
  readFile = readFileSync,
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("experiment source files must be a non-empty array");
  }
  const hash = createHash("sha256");
  const frame = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  frame("review-skill-experiment-harness/v1");
  for (const file of files) {
    if (
      typeof file !== "string" ||
      file.length === 0 ||
      path.isAbsolute(file) ||
      file.includes("\\") ||
      path.posix.normalize(file) !== file ||
      file === ".." ||
      file.startsWith("../")
    ) {
      throw new Error(
        `experiment source path ${JSON.stringify(file)} is invalid`,
      );
    }
    frame(file);
    frame(readFile(path.resolve(root, file)));
  }
  return hash.digest("hex");
}

function assertDigest(value, label) {
  const digest = String(value ?? "");
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
  return digest;
}

function treatment(value, { incumbent = false } = {}) {
  if (!isObject(value)) {
    throw new Error(`${incumbent ? "incumbent" : "candidate"} is missing`);
  }
  const id = incumbent ? "incumbent" : String(value.id ?? "");
  if (!CANDIDATE_ID_PATTERN.test(id) || (!incumbent && id === "incumbent")) {
    throw new Error(`candidate id ${JSON.stringify(id)} is invalid`);
  }
  const skillRef = nonempty(value.skill_ref, `${id}.skill_ref`);
  const currentDigest = canonicalSkillDigest(skillRef);
  for (const field of ["skill_digest", "canonical_skill_digest"]) {
    if (value[field] !== undefined && value[field] !== currentDigest) {
      throw new Error(`${id}.${field} differs from the current skill bytes`);
    }
  }
  return { id, skill_ref: skillRef, skill_digest: currentDigest };
}

function oneCandidate(candidate, candidates) {
  if (candidate && candidates) {
    throw new Error("use candidate, not candidate and candidates together");
  }
  const selected =
    candidate ?? (Array.isArray(candidates) ? candidates[0] : null);
  if (!selected || (Array.isArray(candidates) && candidates.length !== 1)) {
    throw new Error("an experiment campaign requires exactly one candidate");
  }
  return selected;
}

function modelIdentity(contract) {
  const copy = (value, label) => ({
    model: nonempty(value?.model, `${label}.model`),
    effort: nonempty(value?.effort, `${label}.effort`),
  });
  return {
    finder: copy(contract?.sut?.finder, "sut.finder"),
    verifier: copy(contract?.sut?.verifier, "sut.verifier"),
    control: copy(contract?.sut?.control, "sut.control"),
    judge: copy(contract?.judge, "judge"),
  };
}

function frozenInputs(contract) {
  const prompts = Object.fromEntries(
    Object.entries(contract?.prompts ?? {}).map(([name, prompt]) => [
      name,
      {
        file: nonempty(prompt?.file, `prompts.${name}.file`),
        sha256: assertDigest(prompt?.sha256, `prompts.${name}.sha256`),
      },
    ]),
  );
  const fixtures = (contract?.fixtures ?? []).map((fixture) => ({
    pr: fixture.pr,
    first_head: nonempty(fixture.first_head, `PR ${fixture.pr} first_head`),
    base_sha: nonempty(fixture.base_sha, `PR ${fixture.pr} base_sha`),
    truth_file: nonempty(fixture.truth_file, `PR ${fixture.pr} truth_file`),
    truth_sha256: assertDigest(
      fixture.truth_sha256,
      `PR ${fixture.pr} truth_sha256`,
    ),
    finder_reports: (fixture.finder_reports ?? []).map((report, index) => ({
      index,
      file: nonempty(report.file, `PR ${fixture.pr} report ${index} file`),
      sha256: assertDigest(
        report.sha256,
        `PR ${fixture.pr} report ${index} sha256`,
      ),
    })),
  }));
  return { prompts, fixtures };
}

/**
 * Every grid fixture the contract carries, by PR number. The lane takes the
 * contract's grid as it stands rather than a pinned PR list: a fixture added to
 * the grid joins the panel, and the derived thresholds move with it.
 */
export function experimentFixtures(contract) {
  const fixtures = gridFixtures(contract).sort(
    (left, right) => left.pr - right.pr,
  );
  if (fixtures.length < MIN_GRID_FIXTURES) {
    throw new Error(
      `experiment requires at least ${MIN_GRID_FIXTURES} grid fixtures, got ${fixtures.length}`,
    );
  }
  for (const fixture of fixtures) {
    if ((fixture.finder_reports ?? []).length < 2) {
      throw new Error(`PR ${fixture.pr} requires two frozen finder reports`);
    }
  }
  return fixtures;
}

export function experimentDraws(draws = DEFAULT_DRAWS) {
  if (!Number.isSafeInteger(draws) || draws < 1 || draws > MAX_DRAWS) {
    throw new Error(`draws must be an integer 1..${MAX_DRAWS}`);
  }
  return draws;
}

/**
 * A is the incumbent. B is the candidate. Order alternates on the parity of the
 * fixture and the draw together, so a fixture that always ran the incumbent
 * first on draw 0 runs it second on draw 1 and order cannot ride along with a
 * fixture across the campaign.
 */
export function treatmentOrder({
  fixtureIndex,
  drawIndex = 0,
  candidateIndex = 0,
}) {
  if (candidateIndex !== 0) {
    throw new Error("one-candidate campaigns use candidateIndex 0");
  }
  for (const [label, value] of [
    ["fixtureIndex", fixtureIndex],
    ["drawIndex", drawIndex],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer`);
    }
  }
  return (fixtureIndex + drawIndex) % 2 === 0 ? "AB" : "BA";
}

function laneFixture(fixture) {
  return {
    first_head: fixture.first_head,
    base_sha: fixture.base_sha,
    truth_file: fixture.truth_file,
    truth_sha256: fixture.truth_sha256,
    scorable_ids: [...fixture.scorable_ids],
    p1_ids: [...fixture.p1_ids],
  };
}

function stageSource({ stage, fixture, finderIdentity }) {
  if (stage === "live-paired") {
    return {
      kind: "live-finder",
      finder_id: `live-pr-${fixture.pr}`,
      shared: true,
      finder_argv_digest: finderIdentity,
    };
  }
  const reportIndex = stage === "screen" ? 0 : 1;
  const report = fixture.finder_reports[reportIndex];
  return {
    kind: "frozen-report",
    report_index: reportIndex,
    file: report.file,
    sha256: report.sha256,
  };
}

/**
 * One lane per fixture per draw. Every draw of a lane replays the same frozen
 * report through both arms, so a difference between two draws is verifier
 * variance and nothing else.
 */
function stageLanes({ stage, fixtures, draws, finderIdentity }) {
  return fixtures.flatMap((fixture, fixtureIndex) =>
    Array.from({ length: draws }, (_unused, drawIndex) => {
      const pairedOrder = treatmentOrder({ fixtureIndex, drawIndex });
      return {
        lane_id: `${stage}-pr-${fixture.pr}-d${drawIndex}`,
        pr: fixture.pr,
        draw: drawIndex,
        paired_order: pairedOrder,
        fixture: laneFixture(fixture),
        source: stageSource({ stage, fixture, finderIdentity }),
        sequence:
          pairedOrder === "AB"
            ? ["incumbent", "candidate"]
            : ["candidate", "incumbent"],
      };
    }),
  );
}

function stagesFor({ contract, finderIdentity, includeLivePaired, draws }) {
  const fixtures = experimentFixtures(contract);
  return Object.fromEntries(
    EXPERIMENT_STAGES.map((stage) => [
      stage,
      {
        stage,
        enabled: stage !== "live-paired" || includeLivePaired === true,
        draws,
        lanes: stageLanes({ stage, fixtures, draws, finderIdentity }),
      },
    ]),
  );
}

/**
 * How many cells a canonical full rerun of this contract owes, derived from the
 * contract itself rather than written down: two pipeline draws of every
 * fixture, one replay of every frozen report the grid carries, and one control
 * cell per fixture. A fixture joining the grid moves the count with it, so a
 * wider grid does not fail planning against a number calibrated for a narrower
 * one.
 */
export function fullRerunCellCount(contract) {
  const fixtures = contract?.fixtures ?? [];
  const replays = gridFixtures(contract).reduce(
    (total, fixture) => total + (fixture.finder_reports ?? []).length,
    0,
  );
  return PIPELINE_DRAWS * fixtures.length + replays + fixtures.length;
}

export function canonicalRerunManifest({
  contract,
  contractDigest,
  scorerDigest,
  skillDigest,
  finderArgvDigest,
  cliVersions,
  treatmentId = "candidate",
}) {
  const cells = planCells({ contract, kind: "full" });
  const expected = fullRerunCellCount(contract);
  if (cells.length !== expected) {
    throw new Error(
      `canonical full rerun must contain ${expected} cells, got ${cells.length}`,
    );
  }
  const body = {
    kind: "canonical-full-rerun",
    treatment_id: nonempty(treatmentId, "treatmentId"),
    experiment_artifact_reuse_allowed: false,
    contract_digest: assertDigest(contractDigest, "contractDigest"),
    scorer_digest: assertDigest(scorerDigest, "scorerDigest"),
    skill_digest: assertDigest(skillDigest, "skillDigest"),
    finder_argv_digest: assertDigest(finderArgvDigest, "finderArgvDigest"),
    cli_versions: cliVersionIdentity(cliVersions),
    cell_count: cells.length,
    cells: structuredClone(cells),
  };
  return { ...body, manifest_digest: digestObject(body) };
}

/** Build every lane before any model process starts. */
export function buildExperimentPlan({
  contract,
  contractDigest,
  plannedAt = new Date().toISOString(),
  incumbent,
  candidate = null,
  candidates = null,
  cliVersions = null,
  identities = null,
  includeLivePaired = false,
  draws = DEFAULT_DRAWS,
}) {
  if (!isObject(contract)) throw new Error("contract is missing");
  const drawCount = experimentDraws(draws);
  const contractIdentity = assertDigest(contractDigest, "contractDigest");
  const incumbentIdentity = treatment(incumbent, { incumbent: true });
  const candidateIdentity = treatment(oneCandidate(candidate, candidates));
  const versions = cliVersionIdentity(cliVersions, identities);
  const models = modelIdentity(contract);
  const scorerIdentity = canonicalScorerDigest();
  const finderIdentity = canonicalFinderArgvDigest(contract);
  const milliseconds = Date.parse(plannedAt);
  if (!Number.isFinite(milliseconds)) throw new Error("plannedAt is invalid");
  const planned = new Date(milliseconds).toISOString();
  const stages = stagesFor({
    contract,
    finderIdentity,
    includeLivePaired,
    draws: drawCount,
  });
  const seed = {
    namespace: EXPERIMENT_NAMESPACE,
    planned_at: planned,
    contract_digest: contractIdentity,
    candidate: candidateIdentity,
  };
  const body = {
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    suite_id: nonempty(contract.suite_id, "contract.suite_id"),
    campaign_id: `${planned.replace(/[-:.]/g, "")}-${digestObject(seed).slice(0, 10)}`,
    planned_at: planned,
    ledger_eligible: false,
    canonical_verdict_eligible: false,
    experiment_statuses: [...EXPERIMENT_STATUSES],
    contract_digest: contractIdentity,
    draws: drawCount,
    inputs: {
      scorer_digest: scorerIdentity,
      harness_source_digest: experimentSourceDigest(),
      finder_argv_digest: finderIdentity,
      cli_versions: versions,
      models,
      ...frozenInputs(contract),
    },
    policy: experimentPolicy({
      fixtures: experimentFixtures(contract),
      draws: drawCount,
    }),
    incumbent: incumbentIdentity,
    candidate: candidateIdentity,
    stages,
    qualification: canonicalRerunManifest({
      contract,
      contractDigest: contractIdentity,
      scorerDigest: scorerIdentity,
      skillDigest: candidateIdentity.skill_digest,
      finderArgvDigest: finderIdentity,
      cliVersions: versions,
      treatmentId: candidateIdentity.id,
    }),
  };
  return { ...body, plan_digest: digestObject(body) };
}

export function stagePlanFor({ plan, stage }) {
  if (!EXPERIMENT_STAGES.includes(stage)) {
    throw new Error(`unknown experiment stage ${JSON.stringify(stage)}`);
  }
  const stagePlan = plan?.stages?.[stage];
  if (!isObject(stagePlan) || stagePlan.stage !== stage) {
    throw new Error(`plan has no complete ${stage} stage`);
  }
  return stagePlan;
}
function treatmentFor(plan, name) {
  if (name === "incumbent") return plan.incumbent;
  if (name === "candidate") return plan.candidate;
  throw new Error(`unknown treatment ${JSON.stringify(name)}`);
}

function withDigest(identity) {
  return { ...identity, digest: digestObject(identity) };
}

function drawIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("cache identity draw must be a non-negative integer");
  }
  return value;
}

/** `phaseVersionsFor` states how a cache identity is keyed on versions. */
export function rawCacheIdentity({
  plan,
  stage,
  lane,
  treatment: treatmentName,
  sourceDigest = null,
  cliVersions,
  phaseVersions = null,
}) {
  const plannedStage = stagePlanFor({ plan, stage });
  const plannedLane = plannedStage.lanes.find(
    (candidateLane) => candidateLane.lane_id === lane?.lane_id,
  );
  if (!plannedLane || JSON.stringify(plannedLane) !== JSON.stringify(lane)) {
    throw new Error("raw cache lane differs from the immutable plan");
  }
  if (!plannedLane.sequence.includes(treatmentName)) {
    throw new Error("raw cache treatment is not in the planned sequence");
  }
  const selectedTreatment = treatmentFor(plan, treatmentName);
  let source = plannedLane.source;
  if (source.kind === "live-finder") {
    source = {
      ...source,
      report_digest: assertDigest(sourceDigest, "live finder report digest"),
    };
  } else if (sourceDigest !== null && sourceDigest !== source.sha256) {
    throw new Error("frozen report digest differs from the plan");
  }
  return withDigest({
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    phase: "raw",
    campaign_id: plan.campaign_id,
    plan_digest: plan.plan_digest,
    stage,
    lane_id: plannedLane.lane_id,
    pr: plannedLane.pr,
    // Two draws of one lane read the same report through the same arm, so only
    // the draw index keeps their cells apart in the cache.
    draw: drawIndex(plannedLane.draw),
    treatment: treatmentName,
    skill_digest: selectedTreatment.skill_digest,
    contract_digest: plan.contract_digest,
    cli_versions: phaseVersionsFor("raw", {
      cliVersions,
      phaseVersions,
      source,
    }),
    model: plan.inputs.models.verifier,
    prompt: plan.inputs.prompts.handoff,
    fixture: plannedLane.fixture,
    source,
  });
}

export function scoreCacheIdentity({
  plan,
  rawDigest,
  draw = 0,
  cliVersions,
  phaseVersions = null,
}) {
  return withDigest({
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    phase: "score",
    plan_digest: plan.plan_digest,
    draw: drawIndex(draw),
    raw_digest: assertDigest(rawDigest, "rawDigest"),
    scorer_digest: plan.inputs.scorer_digest,
    judge: plan.inputs.models.judge,
    cli_versions: phaseVersionsFor("score", { cliVersions, phaseVersions }),
  });
}

export function novelCacheIdentity({
  plan,
  scoreDigest,
  draw = 0,
  cliVersions,
  phaseVersions = null,
}) {
  return withDigest({
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    phase: "novel",
    plan_digest: plan.plan_digest,
    draw: drawIndex(draw),
    score_digest: assertDigest(scoreDigest, "scoreDigest"),
    scorer_digest: plan.inputs.scorer_digest,
    judge: plan.inputs.models.judge,
    cli_versions: phaseVersionsFor("novel", { cliVersions, phaseVersions }),
  });
}

export function buildCacheIdentity({ phase, ...options }) {
  if (phase === "raw") return rawCacheIdentity(options);
  if (phase === "score" || phase === "match") {
    return scoreCacheIdentity(options);
  }
  if (phase === "novel") return novelCacheIdentity(options);
  throw new Error(`unknown cache identity phase ${JSON.stringify(phase)}`);
}

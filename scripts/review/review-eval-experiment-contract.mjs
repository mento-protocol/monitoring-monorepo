// Immutable plans and cache identities for the non-ledger experiment lane.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gridFixtures } from "./review-eval-fixtures.mjs";
import {
  finderArgvDigest as canonicalFinderArgvDigest,
  planCells,
  skillDigest as canonicalSkillDigest,
} from "./review-eval-run-plan.mjs";
import { scorerDigest as canonicalScorerDigest } from "./review-eval-score.mjs";

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
export const SCREEN_PRS = Object.freeze([1990, 1995, 1999]);
export const MAX_FIXTURE_LANES = 3;
export const EXPERIMENT_SOURCE_FILES = Object.freeze([
  "scripts/review/review-eval-experiment.mjs",
  "scripts/review/review-eval-experiment-contract.mjs",
  "scripts/review/review-eval-experiment-decision.mjs",
  "scripts/review/review-eval-experiment-cache.mjs",
  "scripts/review/review-eval-experiment-runtime.mjs",
]);

export const DEFAULT_EXPERIMENT_POLICY = Object.freeze({
  screen: Object.freeze({
    known_net_min: 2,
    p1_net_min: 0,
    nonnegative_prs_min: 2,
  }),
  combined: Object.freeze({
    known_net_min: 3,
    candidate_p1_min: 9,
    p1_opportunities: 12,
    p1_net_min: 2,
    gaining_prs_min: 2,
    wrong_claim_delta_max: 1,
  }),
  claim_inflation: Object.freeze({
    absolute_delta_min: 3,
    ratio_min: 1.25,
  }),
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const experimentRepoRoot = fileURLToPath(new URL("../../", import.meta.url));

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
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

function nonempty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
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

function cliIdentity(cliVersions, identities) {
  const supplied = cliVersions ?? {
    claude: identities?.claude_cli,
    codex: identities?.codex_cli,
    judge: identities?.judge_cli,
  };
  const claude = nonempty(supplied?.claude, "cliVersions.claude");
  return {
    claude,
    codex: nonempty(supplied?.codex, "cliVersions.codex"),
    judge: nonempty(supplied?.judge ?? claude, "cliVersions.judge"),
  };
}

const CLI_PROVIDERS = Object.freeze(["claude", "codex", "judge"]);

/** Normalize probed or recorded provider versions into the plan identity. */
export function cliVersionIdentity(cliVersions, identities = null) {
  return cliIdentity(cliVersions, identities);
}

/**
 * Compare the versions a plan recorded with the versions probed now. A plan
 * keeps its recorded versions forever, so an upgrade mid-campaign is drift to
 * label, never a reason to refuse the plan.
 */
export function cliVersionDrift({ planned, live }) {
  if (live === null || live === undefined) return null;
  const recorded = cliVersionIdentity(planned);
  const current = cliVersionIdentity(live);
  const providers = CLI_PROVIDERS.filter(
    (provider) => recorded[provider] !== current[provider],
  ).map((provider) => ({
    provider,
    planned: recorded[provider],
    live: current[provider],
  }));
  if (providers.length === 0) return null;
  return {
    providers,
    planned: recorded,
    live: current,
    summary: providers
      .map((entry) => `${entry.provider} ${entry.planned} -> ${entry.live}`)
      .join(", "),
  };
}

/**
 * The providers one cache phase invokes, at the versions it invokes them at.
 * A frozen-report lane never spawns the finder, so `codex` belongs to a
 * live-finder raw phase alone; scoring and novelty classification are judge
 * calls. These versions go into the phase's cache identity and into the
 * artifact it writes, so a phase can never be attributed to a provider it did
 * not run or to a version it did not run under.
 */
export function phaseCliVersions({ phase, cliVersions, source = null }) {
  const live = cliVersionIdentity(cliVersions);
  if (phase === "raw") {
    return source?.kind === "live-finder"
      ? { claude: live.claude, codex: live.codex }
      : { claude: live.claude };
  }
  if (phase === "score" || phase === "novel") return { judge: live.judge };
  throw new Error(`unknown experiment cache phase ${JSON.stringify(phase)}`);
}

/**
 * Read the versions every record actually ran under out of the records
 * themselves, and name each transition away from the planned versions with the
 * cells it touched. Records carry what their artifacts stored, so a stage
 * retried later reports the runtime that produced each artifact rather than the
 * runtime of the retry. Pass every record the decision reads, including screen
 * records folded into a holdout decision.
 */
export function recordRuntimeDrift({ planned, records }) {
  const recorded = cliVersionIdentity(planned);
  const transitions = new Map();
  for (const record of records ?? []) {
    if (!isObject(record?.cli_versions)) continue;
    for (const phase of Object.values(record.cli_versions)) {
      if (!isObject(phase)) continue;
      for (const [provider, version] of Object.entries(phase)) {
        if (!CLI_PROVIDERS.includes(provider)) continue;
        if (version === recorded[provider]) continue;
        const key = `${provider}\u0000${version}`;
        if (!transitions.has(key)) {
          transitions.set(key, {
            provider,
            planned: recorded[provider],
            live: version,
            cells: new Set(),
          });
        }
        transitions.get(key).cells.add(record.cell_id);
      }
    }
  }
  if (transitions.size === 0) return null;
  const providers = [...transitions.values()]
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.live.localeCompare(right.live),
    )
    .map(({ cells, ...entry }) => ({ ...entry, cell_ids: [...cells].sort() }));
  return {
    providers,
    cell_ids: [...new Set(providers.flatMap((entry) => entry.cell_ids))].sort(),
    summary: providers
      .map((entry) => `${entry.provider} ${entry.planned} -> ${entry.live}`)
      .join(", "),
  };
}

/** One reason string naming each transition and the cells that ran under it. */
export function runtimeDriftReason(drift) {
  if (!isObject(drift) || !Array.isArray(drift.providers)) return null;
  if (drift.providers.length === 0) return null;
  const transitions = drift.providers.map((entry) => {
    const move = `${entry.provider} ${entry.planned} -> ${entry.live}`;
    const cells = [...new Set(entry.cell_ids ?? [])].sort();
    return cells.length === 0 ? move : `${move} on ${cells.join(", ")}`;
  });
  return `runtime drift: ${transitions.join("; ")}`;
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

function experimentFixtures(contract) {
  const fixtures = gridFixtures(contract).sort(
    (left, right) => left.pr - right.pr,
  );
  const prs = fixtures.map(({ pr }) => pr);
  if (
    fixtures.length !== MAX_FIXTURE_LANES ||
    JSON.stringify(prs) !== JSON.stringify(SCREEN_PRS)
  ) {
    throw new Error(
      `experiment requires grid fixtures ${SCREEN_PRS.join(", ")}`,
    );
  }
  for (const fixture of fixtures) {
    if ((fixture.finder_reports ?? []).length < 2) {
      throw new Error(`PR ${fixture.pr} requires two frozen finder reports`);
    }
  }
  const p1Opportunities = fixtures.reduce(
    (total, fixture) => total + fixture.p1_ids.length * 2,
    0,
  );
  if (p1Opportunities !== DEFAULT_EXPERIMENT_POLICY.combined.p1_opportunities) {
    throw new Error(`experiment panel has ${p1Opportunities} P1 opportunities`);
  }
  return fixtures;
}

/** A is the incumbent. B is the candidate. */
export function treatmentOrder({ fixtureIndex, candidateIndex = 0 }) {
  if (candidateIndex !== 0) {
    throw new Error("one-candidate campaigns use candidateIndex 0");
  }
  if (!Number.isSafeInteger(fixtureIndex) || fixtureIndex < 0) {
    throw new Error("fixtureIndex must be a non-negative integer");
  }
  return fixtureIndex % 2 === 0 ? "AB" : "BA";
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

function stagesFor({ contract, finderIdentity, includeLivePaired }) {
  const fixtures = experimentFixtures(contract);
  return Object.fromEntries(
    EXPERIMENT_STAGES.map((stage) => [
      stage,
      {
        stage,
        enabled: stage !== "live-paired" || includeLivePaired === true,
        lanes: fixtures.map((fixture, fixtureIndex) => {
          const pairedOrder = treatmentOrder({ fixtureIndex });
          return {
            lane_id: `${stage}-pr-${fixture.pr}`,
            pr: fixture.pr,
            paired_order: pairedOrder,
            fixture: laneFixture(fixture),
            source: stageSource({ stage, fixture, finderIdentity }),
            sequence:
              pairedOrder === "AB"
                ? ["incumbent", "candidate"]
                : ["candidate", "incumbent"],
          };
        }),
      },
    ]),
  );
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
  if (cells.length !== 24) {
    throw new Error(
      `canonical full rerun must contain 24 cells, got ${cells.length}`,
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
    cli_versions: cliIdentity(cliVersions),
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
}) {
  if (!isObject(contract)) throw new Error("contract is missing");
  const contractIdentity = assertDigest(contractDigest, "contractDigest");
  const incumbentIdentity = treatment(incumbent, { incumbent: true });
  const candidateIdentity = treatment(oneCandidate(candidate, candidates));
  const versions = cliIdentity(cliVersions, identities);
  const models = modelIdentity(contract);
  const scorerIdentity = canonicalScorerDigest();
  const finderIdentity = canonicalFinderArgvDigest(contract);
  const milliseconds = Date.parse(plannedAt);
  if (!Number.isFinite(milliseconds)) throw new Error("plannedAt is invalid");
  const planned = new Date(milliseconds).toISOString();
  const stages = stagesFor({ contract, finderIdentity, includeLivePaired });
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
    inputs: {
      scorer_digest: scorerIdentity,
      harness_source_digest: experimentSourceDigest(),
      finder_argv_digest: finderIdentity,
      cli_versions: versions,
      models,
      ...frozenInputs(contract),
    },
    policy: structuredClone(DEFAULT_EXPERIMENT_POLICY),
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

const MAX_PLAN_DIFFERENCES = 8;

/** Name the paths where a stored plan and its rebuild disagree. */
function planDifferences(actual, expected, path = "", out = []) {
  if (out.length >= MAX_PLAN_DIFFERENCES) return out;
  if (JSON.stringify(actual) === JSON.stringify(expected)) return out;
  if (isObject(actual) && isObject(expected)) {
    for (const key of new Set([
      ...Object.keys(actual),
      ...Object.keys(expected),
    ])) {
      planDifferences(
        actual[key],
        expected[key],
        path ? `${path}.${key}` : key,
        out,
      );
    }
    return out;
  }
  if (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length
  ) {
    for (const [index, item] of actual.entries()) {
      planDifferences(item, expected[index], `${path}[${index}]`, out);
    }
    return out;
  }
  out.push(path || "plan");
  return out;
}

/**
 * Rebuild the plan from its own recorded inputs, including the CLI versions it
 * was planned under, so a stored plan stays internally consistent forever. A
 * live probe passed as `cliVersions` is reported as drift, not as a problem.
 */
export function validateExperimentPlan({
  plan,
  contract,
  contractDigest = plan?.contract_digest,
  cliVersions = null,
}) {
  const problems = [];
  let drift = null;
  try {
    if (!isObject(plan)) throw new Error("plan must be an object");
    const rebuilt = buildExperimentPlan({
      contract,
      contractDigest,
      plannedAt: plan.planned_at,
      incumbent: plan.incumbent,
      candidate: plan.candidate,
      cliVersions: plan?.inputs?.cli_versions,
      includeLivePaired: plan.stages?.["live-paired"]?.enabled === true,
    });
    const differences = planDifferences(
      stableValue(plan),
      stableValue(rebuilt),
    );
    if (differences.length > 0) {
      problems.push(
        "plan differs from the complete deterministic campaign plan at " +
          differences.join(", "),
      );
    } else if (JSON.stringify(plan) !== JSON.stringify(rebuilt)) {
      problems.push("plan key order differs from the deterministic plan");
    }
    drift = cliVersionDrift({
      planned: rebuilt.inputs.cli_versions,
      live: cliVersions,
    });
  } catch (error) {
    problems.push(error.message);
  }
  return { ok: problems.length === 0, problems, drift };
}

function treatmentFor(plan, name) {
  if (name === "incumbent") return plan.incumbent;
  if (name === "candidate") return plan.candidate;
  throw new Error(`unknown treatment ${JSON.stringify(name)}`);
}

function withDigest(identity) {
  return { ...identity, digest: digestObject(identity) };
}

/**
 * Cache identities carry the LIVE version of every provider the phase invokes,
 * exactly as the canonical lane's cell fingerprint does. An artifact produced
 * under another runtime is therefore never found, the cell reruns, and no
 * decision ever mixes two runtimes inside one phase.
 */
export function rawCacheIdentity({
  plan,
  stage,
  lane,
  treatment: treatmentName,
  sourceDigest = null,
  cliVersions,
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
    treatment: treatmentName,
    skill_digest: selectedTreatment.skill_digest,
    contract_digest: plan.contract_digest,
    cli_versions: phaseCliVersions({ phase: "raw", cliVersions, source }),
    model: plan.inputs.models.verifier,
    prompt: plan.inputs.prompts.handoff,
    fixture: plannedLane.fixture,
    source,
  });
}

export function scoreCacheIdentity({ plan, rawDigest, cliVersions }) {
  return withDigest({
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    phase: "score",
    plan_digest: plan.plan_digest,
    raw_digest: assertDigest(rawDigest, "rawDigest"),
    scorer_digest: plan.inputs.scorer_digest,
    judge: plan.inputs.models.judge,
    cli_versions: phaseCliVersions({ phase: "score", cliVersions }),
  });
}

export function novelCacheIdentity({ plan, scoreDigest, cliVersions }) {
  return withDigest({
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    phase: "novel",
    plan_digest: plan.plan_digest,
    score_digest: assertDigest(scoreDigest, "scoreDigest"),
    scorer_digest: plan.inputs.scorer_digest,
    judge: plan.inputs.models.judge,
    cli_versions: phaseCliVersions({ phase: "novel", cliVersions }),
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

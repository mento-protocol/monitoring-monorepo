// Plan and evidence identities for the non-ledger review-skill experiment lane.

import { createHash } from "node:crypto";
import path from "node:path";

import { gridFixtures } from "./review-eval-fixtures.mjs";
import { planCells } from "./review-eval-run-plan.mjs";

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
export const EXPERIMENT_CACHE_STAGES = Object.freeze(["raw", "match", "novel"]);
export const SCREEN_PRS = Object.freeze([1990, 1995, 1999]);
export const SCREEN_REPORT_DRAWS = Object.freeze({
  1990: 1,
  1995: 2,
  1999: 1,
});
export const MAX_CANDIDATES = 3;
export const MAX_STAGE_ATTEMPTS = 2;
export const MAX_FIXTURE_LANES = 3;
export const CALIBRATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const CAMPAIGN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_EXPERIMENT_ROOT = "~/.cache/mento-review-eval-experiments";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  calibration: Object.freeze({
    agreement_min: 35,
    total: 40,
    max_age_ms: CALIBRATION_MAX_AGE_MS,
  }),
  campaign: Object.freeze({ max_age_ms: CAMPAIGN_MAX_AGE_MS }),
  max_candidates: MAX_CANDIDATES,
  max_stage_attempts: MAX_STAGE_ATTEMPTS,
  max_fixture_lanes: MAX_FIXTURE_LANES,
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeForDigest(value) {
  if (Array.isArray(value)) return value.map(normalizeForDigest);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeForDigest(value[key])]),
  );
}

export function digestObject(value) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeForDigest(value)))
    .digest("hex");
}

function assertDigest(value, label) {
  if (!SHA256_PATTERN.test(String(value ?? ""))) {
    throw new Error(`${label} must be a lowercase sha256`);
  }
  return String(value);
}

function normalizeTreatment(value, { incumbent = false } = {}) {
  if (!isObject(value)) {
    throw new Error(`${incumbent ? "incumbent" : "candidate"} is missing`);
  }
  const id = incumbent ? "incumbent" : String(value.id ?? "");
  if (!CANDIDATE_ID_PATTERN.test(id) || (!incumbent && id === "incumbent")) {
    throw new Error(`candidate id ${JSON.stringify(id)} is not valid`);
  }
  if (typeof value.skill_ref !== "string" || value.skill_ref.length === 0) {
    throw new Error(`${id}.skill_ref must be a non-empty string`);
  }
  return {
    id,
    skill_ref: value.skill_ref,
    skill_digest: assertDigest(value.skill_digest, `${id}.skill_digest`),
    canonical_skill_digest: assertDigest(
      value.canonical_skill_digest,
      `${id}.canonical_skill_digest`,
    ),
    dirty: value.dirty === true,
  };
}

function normalizeIdentities(value) {
  if (!isObject(value)) throw new Error("identities are missing");
  const judge = value.judge;
  if (
    !isObject(judge) ||
    typeof judge.model !== "string" ||
    typeof judge.effort !== "string"
  ) {
    throw new Error("identities.judge must name a model and effort");
  }
  for (const field of ["claude_cli", "judge_cli", "codex_cli", "host"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`identities.${field} must be a non-empty string`);
    }
  }
  const executable = (field, expectedName) => {
    const current = value[field];
    if (
      !isObject(current) ||
      current.name !== expectedName ||
      typeof current.path !== "string" ||
      !path.isAbsolute(current.path) ||
      typeof current.version !== "string" ||
      current.version.length === 0
    ) {
      throw new Error(`identities.${field} is not a pinned executable`);
    }
    return {
      name: expectedName,
      path: current.path,
      digest: assertDigest(current.digest, `identities.${field}.digest`),
      version: current.version,
    };
  };
  return {
    matcher_digest: assertDigest(
      value.matcher_digest,
      "identities.matcher_digest",
    ),
    calibration_digest: assertDigest(
      value.calibration_digest,
      "identities.calibration_digest",
    ),
    experiment_digest: assertDigest(
      value.experiment_digest,
      "identities.experiment_digest",
    ),
    orchestrator_digest: assertDigest(
      value.orchestrator_digest,
      "identities.orchestrator_digest",
    ),
    finder_argv_digest: assertDigest(
      value.finder_argv_digest,
      "identities.finder_argv_digest",
    ),
    claude_cli: value.claude_cli,
    judge_cli: value.judge_cli,
    codex_cli: value.codex_cli,
    claude_bin: executable("claude_bin", "claude"),
    codex_bin: executable("codex_bin", "codex"),
    host: value.host,
    judge: { model: judge.model, effort: judge.effort },
  };
}

function selectedFixtures(contract) {
  const fixtures = gridFixtures(contract).filter((fixture) =>
    SCREEN_PRS.includes(fixture.pr),
  );
  const found = fixtures.map((fixture) => fixture.pr).sort((a, b) => a - b);
  if (JSON.stringify(found) !== JSON.stringify([...SCREEN_PRS])) {
    throw new Error(
      `experiment contract must have grid fixtures ${SCREEN_PRS.join(", ")}`,
    );
  }
  for (const fixture of fixtures) {
    if (
      !Array.isArray(fixture.finder_reports) ||
      fixture.finder_reports.length < 2
    ) {
      throw new Error(`PR ${fixture.pr} needs two frozen finder reports`);
    }
  }
  const p1Opportunities = fixtures.reduce(
    (total, fixture) => total + fixture.p1_ids.length * 2,
    0,
  );
  if (p1Opportunities !== DEFAULT_EXPERIMENT_POLICY.combined.p1_opportunities) {
    throw new Error(
      `experiment fixtures carry ${p1Opportunities} P1 opportunities, expected ${DEFAULT_EXPERIMENT_POLICY.combined.p1_opportunities}`,
    );
  }
  return fixtures.sort((a, b) => a.pr - b.pr);
}

/** A is the incumbent and B is the candidate. */
export function treatmentOrder({ candidateIndex, fixtureIndex }) {
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0) {
    throw new Error("candidateIndex must be a non-negative integer");
  }
  if (!Number.isSafeInteger(fixtureIndex) || fixtureIndex < 0) {
    throw new Error("fixtureIndex must be a non-negative integer");
  }
  return (candidateIndex + fixtureIndex) % 2 === 0 ? "AB" : "BA";
}

function fullFingerprint({ treatment, contractDigest, identities }) {
  return {
    skill_digest: treatment.canonical_skill_digest,
    kind: "full",
    contract_digest: contractDigest,
    claude_cli: identities.claude_cli,
    codex_cli: identities.codex_cli,
    finder_argv_digest: identities.finder_argv_digest,
    orchestrator_digest: identities.orchestrator_digest,
  };
}

function experimentFingerprint({ treatment, contractDigest, identities }) {
  return {
    skill_digest: treatment.skill_digest,
    kind: "experiment",
    contract_digest: contractDigest,
    claude_cli: identities.claude_cli,
    codex_cli: identities.codex_cli,
    claude_bin_digest: identities.claude_bin.digest,
    codex_bin_digest: identities.codex_bin.digest,
    finder_argv_digest: identities.finder_argv_digest,
    orchestrator_digest: identities.experiment_digest,
  };
}

function sourceForStage({ fixture, stage, identities }) {
  if (stage === "live-paired") {
    return {
      kind: "live-finder",
      finder_argv_digest: identities.finder_argv_digest,
    };
  }
  const screenDraw = SCREEN_REPORT_DRAWS[fixture.pr];
  const draw = stage === "screen" ? screenDraw : screenDraw === 1 ? 2 : 1;
  const report = fixture.finder_reports[draw - 1];
  return {
    kind: "frozen-replay",
    draw,
    file: report.file,
    sha256: report.sha256,
  };
}

function canonicalCellId(stage, fixture) {
  if (stage === "live-paired") {
    return `pr-${fixture.pr}-pipeline-draw1`;
  }
  const screenDraw = SCREEN_REPORT_DRAWS[fixture.pr];
  const draw = stage === "screen" ? screenDraw : screenDraw === 1 ? 2 : 1;
  return `pr-${fixture.pr}-replay-draw${draw}`;
}

function buildStagePlan({
  stage,
  fixtureList,
  candidate,
  candidateIndex,
  incumbent,
  contractDigest,
  identities,
  enabled,
}) {
  const treatments = new Map([
    ["incumbent", incumbent],
    ["candidate", candidate],
  ]);
  const lanes = fixtureList.map((fixture, fixtureIndex) => {
    const pairedOrder = treatmentOrder({ candidateIndex, fixtureIndex });
    const sequence =
      pairedOrder === "AB"
        ? ["incumbent", "candidate"]
        : ["candidate", "incumbent"];
    return {
      lane_id: `${candidate.id}-${stage}-pr-${fixture.pr}`,
      pr: fixture.pr,
      paired_order: pairedOrder,
      source: sourceForStage({ fixture, stage, identities }),
      fixture: {
        first_head: fixture.first_head,
        base_sha: fixture.base_sha,
        truth_file: fixture.truth_file,
        truth_sha256: fixture.truth_sha256,
        scorable_ids: [...fixture.scorable_ids],
        p1_ids: [...fixture.p1_ids],
      },
      sequence: sequence.map((treatmentName) => {
        const treatment = treatments.get(treatmentName);
        return {
          treatment: treatmentName,
          canonical_cell_id: canonicalCellId(stage, fixture),
          execution_fingerprint: experimentFingerprint({
            treatment,
            contractDigest,
            identities,
          }),
        };
      }),
    };
  });
  return {
    stage,
    enabled,
    candidate_id: candidate.id,
    fixture_lane_limit: MAX_FIXTURE_LANES,
    attempt_limit: MAX_STAGE_ATTEMPTS,
    pair_arms_sequential: true,
    scoring: {
      first_pass: "extract-and-match",
      novelty: "deferred-until-recall-pass",
    },
    lanes,
  };
}

/** Build every experiment and qualification cell before any model can run. */
export function buildExperimentPlan({
  contract,
  contractDigest,
  plannedAt = new Date().toISOString(),
  incumbent,
  candidates,
  identities,
  includeLivePaired = false,
}) {
  if (!isObject(contract)) throw new Error("contract is missing");
  const normalizedContractDigest = assertDigest(
    contractDigest,
    "contractDigest",
  );
  const normalizedIncumbent = normalizeTreatment(incumbent, {
    incumbent: true,
  });
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("at least one candidate is required");
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `a campaign may contain at most ${MAX_CANDIDATES} candidates`,
    );
  }
  const normalizedCandidates = candidates.map((candidate) =>
    normalizeTreatment(candidate),
  );
  const ids = normalizedCandidates.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("candidate ids must be unique");
  }
  const normalizedIdentities = normalizeIdentities(identities);
  const fixtureList = selectedFixtures(contract);
  const parsedAt = Date.parse(plannedAt);
  if (!Number.isFinite(parsedAt))
    throw new Error("plannedAt is not an instant");
  const normalizedAt = new Date(parsedAt).toISOString();
  const seed = {
    namespace: EXPERIMENT_NAMESPACE,
    suite_id: contract.suite_id,
    planned_at: normalizedAt,
    contract_digest: normalizedContractDigest,
    incumbent: normalizedIncumbent,
    candidates: normalizedCandidates,
    identities: normalizedIdentities,
    include_live_paired: includeLivePaired === true,
  };
  const seedDigest = digestObject(seed);
  const campaignId = `${normalizedAt.replace(/[-:.]/g, "").replace("Z", "Z")}-${seedDigest.slice(0, 8)}`;
  const candidatePlans = normalizedCandidates.map(
    (candidate, candidateIndex) => ({
      candidate_id: candidate.id,
      stages: Object.fromEntries(
        EXPERIMENT_STAGES.map((stage) => [
          stage,
          buildStagePlan({
            stage,
            fixtureList,
            candidate,
            candidateIndex,
            incumbent: normalizedIncumbent,
            contractDigest: normalizedContractDigest,
            identities: normalizedIdentities,
            enabled: stage !== "live-paired" || includeLivePaired === true,
          }),
        ]),
      ),
    }),
  );
  const fullCells = planCells({ contract, kind: "full" });
  const treatments = [normalizedIncumbent, ...normalizedCandidates];
  const planWithoutDigest = {
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    namespace: EXPERIMENT_NAMESPACE,
    suite_id: contract.suite_id,
    campaign_id: campaignId,
    planned_at: normalizedAt,
    ledger_eligible: false,
    canonical_verdict_eligible: false,
    canonical_outcomes_allowed: [],
    experiment_statuses: [...EXPERIMENT_STATUSES],
    contract_digest: normalizedContractDigest,
    identities: normalizedIdentities,
    calibration_identity: {
      calibration_digest: normalizedIdentities.calibration_digest,
      matcher_digest: normalizedIdentities.matcher_digest,
      judge: { ...normalizedIdentities.judge },
      judge_cli: normalizedIdentities.judge_cli,
      host: normalizedIdentities.host,
      prompts: Object.fromEntries(
        Object.entries(contract.prompts ?? {}).map(([name, prompt]) => [
          name,
          prompt.sha256,
        ]),
      ),
    },
    policy: JSON.parse(JSON.stringify(DEFAULT_EXPERIMENT_POLICY)),
    incumbent: normalizedIncumbent,
    candidates: normalizedCandidates,
    candidate_plans: candidatePlans,
    qualification: {
      kind: "canonical-full-rerun-plan",
      experiment_artifact_reuse_allowed: false,
      canonical_importer: null,
      cells: fullCells,
      treatments: treatments.map((treatment) => ({
        treatment_id: treatment.id,
        planned_fingerprint: fullFingerprint({
          treatment,
          contractDigest: normalizedContractDigest,
          identities: normalizedIdentities,
        }),
      })),
    },
  };
  return {
    ...planWithoutDigest,
    plan_digest: digestObject(planWithoutDigest),
  };
}

export function validateExperimentPlan({
  plan,
  contract,
  contractDigest = null,
}) {
  const problems = [];
  try {
    if (!isObject(plan)) throw new Error("plan must be an object");
    if (
      contractDigest !== null &&
      plan.contract_digest !== assertDigest(contractDigest, "contractDigest")
    ) {
      problems.push("plan contract digest differs from the current contract");
    }
    const rebuilt = buildExperimentPlan({
      contract,
      contractDigest: plan.contract_digest,
      plannedAt: plan.planned_at,
      incumbent: plan.incumbent,
      candidates: plan.candidates,
      identities: plan.identities,
      includeLivePaired:
        plan.candidate_plans?.[0]?.stages?.["live-paired"]?.enabled === true,
    });
    if (JSON.stringify(plan) !== JSON.stringify(rebuilt)) {
      problems.push(
        "plan does not match the complete deterministic campaign plan",
      );
    }
  } catch (error) {
    problems.push(error.message);
  }
  return { ok: problems.length === 0, problems };
}

/** Return the remaining common-control campaign window in milliseconds. */
export function experimentCampaignRemainingMs({ plan, now = new Date() }) {
  const planned = Date.parse(plan?.planned_at);
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(planned) || !Number.isFinite(current)) {
    throw new Error("experiment campaign timestamp is invalid");
  }
  const age = current - planned;
  if (age < 0) throw new Error("experiment campaign is future-dated");
  return CAMPAIGN_MAX_AGE_MS - age;
}

/** Refuse paid work after the bounded common-control campaign window. */
export function assertExperimentCampaignFresh(options) {
  if (experimentCampaignRemainingMs(options) < 0) {
    throw new Error("experiment campaign is older than 6 hours");
  }
  return true;
}

/** Refuse paid work when any planned runtime or frozen prompt identity drifted. */
export function assertExperimentRuntimeIdentity({
  plan,
  contract,
  contractDigest,
  identities,
  promptDigests,
}) {
  const checks = [
    ["contract_digest", plan.contract_digest, contractDigest],
    [
      "matcher_digest",
      plan.identities.matcher_digest,
      identities.matcher_digest,
    ],
    [
      "calibration_digest",
      plan.identities.calibration_digest,
      identities.calibration_digest,
    ],
    [
      "experiment_digest",
      plan.identities.experiment_digest,
      identities.experiment_digest,
    ],
    [
      "orchestrator_digest",
      plan.identities.orchestrator_digest,
      identities.orchestrator_digest,
    ],
    [
      "finder_argv_digest",
      plan.identities.finder_argv_digest,
      identities.finder_argv_digest,
    ],
    ["claude_cli", plan.identities.claude_cli, identities.claude_cli],
    ["judge_cli", plan.identities.judge_cli, identities.judge_cli],
    ["codex_cli", plan.identities.codex_cli, identities.codex_cli],
    [
      "claude_bin",
      digestObject(plan.identities.claude_bin),
      digestObject(identities.claude_bin),
    ],
    [
      "codex_bin",
      digestObject(plan.identities.codex_bin),
      digestObject(identities.codex_bin),
    ],
    ["host", plan.identities.host, identities.host],
  ];
  for (const [name, planned, current] of checks) {
    if (planned !== current) {
      throw new Error(
        `experiment runtime ${name} drifted: planned ${planned}, current ${current}`,
      );
    }
  }
  if (
    plan.identities.judge.model !== contract.judge.model ||
    plan.identities.judge.effort !== contract.judge.effort
  ) {
    throw new Error("experiment runtime judge identity drifted");
  }
  for (const [name, prompt] of Object.entries(contract.prompts ?? {})) {
    const planned = plan.calibration_identity.prompts?.[name];
    const current = promptDigests?.[name];
    if (planned !== prompt.sha256 || current !== prompt.sha256) {
      throw new Error(`experiment runtime ${name} prompt digest drifted`);
    }
  }
  return true;
}

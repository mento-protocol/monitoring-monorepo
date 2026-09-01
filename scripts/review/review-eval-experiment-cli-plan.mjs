// Campaign planning and executable-source identity for review experiments.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkFixtures, loadContract } from "./review-eval-fixtures.mjs";
import {
  DEFAULT_SKILL_DIR,
  expandHome,
  fileDigest,
  finderArgvDigest,
  orchestratorSourceDigest,
  skillDigest,
} from "./review-eval-run-plan.mjs";
import { scorerDigest } from "./review-eval-score.mjs";
import { buildExperimentPlan } from "./review-eval-experiment-contract.mjs";
import { scrubbedEnv } from "./review-eval-run-execution.mjs";
import { writeExperimentPlan } from "./review-eval-experiment-evidence.mjs";
import {
  assertExperimentStorageRoot,
  DEFAULT_EXPERIMENT_ARTIFACT_ROOT,
  registeredExperimentWorktrees,
} from "./review-eval-experiment-isolation.mjs";
import { resolveExperimentExecutable } from "./review-eval-experiment-process.mjs";
import { experimentSkillDigest } from "./review-eval-experiment-seal.mjs";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
export const EXPERIMENT_SOURCES = Object.freeze([
  "review-eval-experiment.mjs",
  "review-eval-experiment-cli-campaign.mjs",
  "review-eval-experiment-cli-evidence.mjs",
  "review-eval-experiment-cli-options.mjs",
  "review-eval-experiment-cli-plan.mjs",
  "review-eval-experiment-cli-run.mjs",
  "review-eval-experiment-cache.mjs",
  "review-eval-experiment-contract.mjs",
  "review-eval-experiment-core.mjs",
  "review-eval-experiment-decision.mjs",
  "review-eval-experiment-evidence.mjs",
  "review-eval-experiment-finder.mjs",
  "review-eval-experiment-isolation.mjs",
  "review-eval-experiment-novelty.mjs",
  "review-eval-experiment-process.mjs",
  "review-eval-experiment-prepare.mjs",
  "review-eval-experiment-run.mjs",
  "review-eval-experiment-runtime.mjs",
  "review-eval-experiment-seal.mjs",
  "review-eval-experiment-stage-evidence.mjs",
]);

export function digestExperimentSources(entries) {
  const hash = createHash("sha256");
  const updateFramed = (bytes) => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(value.length));
    hash.update(length);
    hash.update(value);
  };
  updateFramed("mento-review-eval-experiment-sources-v1");
  for (const { name, bytes } of entries) {
    updateFramed(name);
    updateFramed(bytes);
  }
  return hash.digest("hex");
}

export function experimentSourceDigest() {
  return digestExperimentSources(
    EXPERIMENT_SOURCES.map((name) => ({
      name,
      bytes: readFileSync(path.join(scriptDir, name)),
    })),
  );
}

function parseCandidate(value) {
  const split = value.indexOf("=");
  if (split <= 0 || split === value.length - 1) {
    throw new Error(
      `--candidate must be ID=PATH, got ${JSON.stringify(value)}`,
    );
  }
  const id = value.slice(0, split);
  const skillRef = path.resolve(expandHome(value.slice(split + 1)));
  return {
    id,
    skill_ref: skillRef,
    skill_digest: experimentSkillDigest(skillRef),
    canonical_skill_digest: skillDigest(skillRef),
    dirty: true,
  };
}

export async function planExperimentCampaign(options) {
  if (options.candidates.length === 0) {
    throw new Error("--plan requires at least one --candidate ID=PATH");
  }
  const contractFile = path.resolve(options.repoRoot, options.contractPath);
  const { contract, digest: contractDigest } = loadContract(contractFile);
  const fixtureCheck = checkFixtures({
    contract,
    repoRoot: options.repoRoot,
    offline: true,
    srcRepo: options.repoRoot,
  });
  if (!fixtureCheck.ok) throw new Error(fixtureCheck.problems.join(" | "));
  const incumbentPath = path.resolve(
    expandHome(options.incumbent ?? DEFAULT_SKILL_DIR),
  );
  const modelEnv = scrubbedEnv({ roots: [options.repoRoot] });
  const claudeBin = resolveExperimentExecutable({
    name: "claude",
    env: modelEnv,
  });
  const codexBin = resolveExperimentExecutable({
    name: "codex",
    env: modelEnv,
  });
  const calibrationFile = path.resolve(
    options.repoRoot,
    options.calibrationPath,
  );
  const plan = buildExperimentPlan({
    contract,
    contractDigest,
    incumbent: {
      skill_ref: incumbentPath,
      skill_digest: experimentSkillDigest(incumbentPath),
      canonical_skill_digest: skillDigest(incumbentPath),
      dirty: options.incumbent !== null,
    },
    candidates: options.candidates.map(parseCandidate),
    identities: {
      matcher_digest: scorerDigest(),
      calibration_digest: fileDigest(calibrationFile),
      experiment_digest: experimentSourceDigest(),
      orchestrator_digest: orchestratorSourceDigest(),
      finder_argv_digest: finderArgvDigest(contract),
      claude_cli: claudeBin.version,
      judge_cli: claudeBin.version,
      codex_cli: codexBin.version,
      claude_bin: claudeBin,
      codex_bin: codexBin,
      host: modelEnv.REVIEW_EVAL_HOST ?? hostname(),
      judge: { ...contract.judge },
    },
    includeLivePaired: options.includeLivePaired,
  });
  const artifactRoot = options.out
    ? path.resolve(expandHome(options.out))
    : path.join(DEFAULT_EXPERIMENT_ARTIFACT_ROOT, plan.campaign_id);
  assertExperimentStorageRoot({
    target: artifactRoot,
    base: DEFAULT_EXPERIMENT_ARTIFACT_ROOT,
    label: "experiment artifact root",
    worktreeRoots: registeredExperimentWorktrees({
      repoRoot: options.repoRoot,
    }),
  });
  const planFile = writeExperimentPlan({
    plan,
    artifactRoot,
    repoRoot: options.repoRoot,
  });
  return { artifact_root: path.dirname(planFile), plan_file: planFile, plan };
}

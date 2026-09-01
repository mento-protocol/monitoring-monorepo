// Campaign loading and exact runtime identity checks for experiment commands.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import { checkFixtures, loadContract } from "./review-eval-fixtures.mjs";
import {
  expandHome,
  fileDigest,
  finderArgvDigest,
  orchestratorSourceDigest,
  skillDigest,
} from "./review-eval-run-plan.mjs";
import { scorerDigest, validateCalibrationSet } from "./review-eval-score.mjs";
import { scrubbedEnv } from "./review-eval-run-execution.mjs";
import {
  assertExperimentCampaignFresh,
  assertExperimentRuntimeIdentity,
  validateExperimentPlan,
} from "./review-eval-experiment-contract.mjs";
import { experimentSourceDigest } from "./review-eval-experiment-cli-plan.mjs";
import {
  assertExperimentArtifactRoot,
  resolveExperimentArtifactPath,
} from "./review-eval-experiment-evidence.mjs";
import {
  assertExperimentStorageRoot,
  DEFAULT_EXPERIMENT_ARTIFACT_ROOT,
  registeredExperimentWorktrees,
} from "./review-eval-experiment-isolation.mjs";
import { resolveExperimentExecutable } from "./review-eval-experiment-process.mjs";
import { experimentSkillDigest } from "./review-eval-experiment-seal.mjs";

function promptDigests({ contract, repoRoot }) {
  return Object.fromEntries(
    Object.entries(contract.prompts ?? {}).map(([name, prompt]) => [
      name,
      createHash("sha256")
        .update(readFileSync(path.resolve(repoRoot, prompt.file)))
        .digest("hex"),
    ]),
  );
}

export function loadExperimentCampaign({
  campaignDir,
  repoRoot,
  contractPath,
  calibrationPath,
  verifyRuntime = false,
}) {
  const artifactRoot = assertExperimentArtifactRoot({
    repoRoot,
    artifactRoot: path.resolve(expandHome(campaignDir)),
  });
  const sandboxWorktreeRoots = registeredExperimentWorktrees({ repoRoot });
  assertExperimentStorageRoot({
    target: artifactRoot,
    base: DEFAULT_EXPERIMENT_ARTIFACT_ROOT,
    label: "experiment artifact root",
    worktreeRoots: sandboxWorktreeRoots,
  });
  const planFile = resolveExperimentArtifactPath({
    artifactRoot,
    relativePath: "plan.json",
  });
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const { contract, digest: contractDigest } = loadContract(
    path.resolve(repoRoot, contractPath),
  );
  const validation = validateExperimentPlan({
    plan,
    contract,
    contractDigest,
  });
  if (!validation.ok) throw new Error(validation.problems.join(" | "));
  if (verifyRuntime) {
    assertExperimentCampaignFresh({ plan });
    const fixtureCheck = checkFixtures({
      contract,
      repoRoot,
      offline: true,
      srcRepo: repoRoot,
    });
    if (!fixtureCheck.ok) throw new Error(fixtureCheck.problems.join(" | "));
    for (const treatment of [plan.incumbent, ...plan.candidates]) {
      const currentSkillDigest = experimentSkillDigest(treatment.skill_ref);
      if (currentSkillDigest !== treatment.skill_digest) {
        throw new Error(
          `${treatment.id} skill changed after planning: expected ${treatment.skill_digest}, got ${currentSkillDigest}`,
        );
      }
      const currentCanonicalDigest = skillDigest(treatment.skill_ref);
      if (currentCanonicalDigest !== treatment.canonical_skill_digest) {
        throw new Error(
          `${treatment.id} canonical skill digest changed after planning: expected ${treatment.canonical_skill_digest}, got ${currentCanonicalDigest}`,
        );
      }
    }
    const modelEnv = scrubbedEnv({ roots: [repoRoot] });
    const claudeBin = resolveExperimentExecutable({
      name: "claude",
      env: modelEnv,
    });
    const codexBin = resolveExperimentExecutable({
      name: "codex",
      env: modelEnv,
    });
    assertExperimentRuntimeIdentity({
      plan,
      contract,
      contractDigest,
      identities: {
        matcher_digest: scorerDigest(),
        calibration_digest: fileDigest(path.resolve(repoRoot, calibrationPath)),
        experiment_digest: experimentSourceDigest(),
        orchestrator_digest: orchestratorSourceDigest(),
        finder_argv_digest: finderArgvDigest(contract),
        claude_cli: claudeBin.version,
        judge_cli: claudeBin.version,
        codex_cli: codexBin.version,
        claude_bin: claudeBin,
        codex_bin: codexBin,
        host: modelEnv.REVIEW_EVAL_HOST ?? hostname(),
      },
      promptDigests: promptDigests({ contract, repoRoot }),
    });
  }
  const calibrationFile = path.resolve(repoRoot, calibrationPath);
  const calibrationSet = JSON.parse(readFileSync(calibrationFile, "utf8"));
  const calibrationValidation = validateCalibrationSet(calibrationSet);
  if (!calibrationValidation.ok) {
    throw new Error(calibrationValidation.problems.join(" | "));
  }
  return {
    artifactRoot,
    plan,
    contract,
    calibrationSet,
    sandboxWorktreeRoots,
  };
}

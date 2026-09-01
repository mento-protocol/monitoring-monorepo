#!/usr/bin/env node

// Executable non-ledger review-skill experiment lane. Only --run without
// --dry-run invokes paid models. Other modes are deterministic and never write
// the canonical review-eval ledger.

import { readFileSync } from "node:fs";
import process from "node:process";

import { loadExperimentCampaign } from "./review-eval-experiment-cli-campaign.mjs";
import { writeExperimentJson } from "./review-eval-experiment-cli-evidence.mjs";
import {
  experimentUsage,
  parseExperimentArgs,
} from "./review-eval-experiment-cli-options.mjs";
import { planExperimentCampaign } from "./review-eval-experiment-cli-plan.mjs";
import { runExperimentMode } from "./review-eval-experiment-cli-run.mjs";
import { evaluateExperimentDecision } from "./review-eval-experiment-decision.mjs";
import { resolveExperimentArtifactPath } from "./review-eval-experiment-evidence.mjs";

export { parseExperimentArgs };

function output(value, json) {
  process.stdout.write(
    `${json ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`,
  );
}

async function evaluateMode(options) {
  if (!options.candidateId || !options.stage || !options.results) {
    throw new Error(
      "--evaluate requires --candidate-id, --stage, and --results",
    );
  }
  const { artifactRoot, plan } = loadExperimentCampaign(options);
  const supplied = JSON.parse(readFileSync(options.results, "utf8"));
  const recordsByStage = supplied.recordsByStage ?? supplied;
  const decision = evaluateExperimentDecision({
    plan,
    candidateId: options.candidateId,
    stage: options.stage,
    recordsByStage,
  });
  if (options.write) {
    const file = resolveExperimentArtifactPath({
      artifactRoot,
      relativePath: `decisions/${options.candidateId}-${options.stage}-${Date.now()}.json`,
    });
    writeExperimentJson(file, {
      schema_version: 1,
      namespace: plan.namespace,
      plan_digest: plan.plan_digest,
      decision,
    });
    return { decision_file: file, decision };
  }
  return { decision };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseExperimentArgs(argv);
  if (options.help) {
    process.stdout.write(experimentUsage());
    return;
  }
  let value;
  if (options.mode === "plan") value = await planExperimentCampaign(options);
  else if (options.mode === "validate-plan") {
    const { artifactRoot, plan } = loadExperimentCampaign(options);
    value = {
      ok: true,
      artifact_root: artifactRoot,
      plan_digest: plan.plan_digest,
    };
  } else if (options.mode === "run") {
    value = await runExperimentMode(options);
  } else {
    value = await evaluateMode(options);
  }
  output(value, options.json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

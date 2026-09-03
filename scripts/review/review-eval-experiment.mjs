#!/usr/bin/env node

// Small non-ledger review-skill experiment CLI. Only --run without --dry-run
// invokes model providers.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

import {
  canonicalPath,
  checkFixtures,
  loadContract,
} from "./review-eval-fixtures.mjs";
import { DEFAULT_SKILL_DIR, expandHome } from "./review-eval-run-plan.mjs";
import { scrubbedEnv, sourceCheckouts } from "./review-eval-run-execution.mjs";
import {
  buildExperimentPlan,
  digestObject,
  EXPERIMENT_STAGES,
  labelRecordRuntimes,
  stagePlanFor,
  validateExperimentPlan,
} from "./review-eval-experiment-contract.mjs";
import { evaluateExperimentDecision } from "./review-eval-experiment-decision.mjs";
import {
  readExperimentCache,
  writeExperimentCache,
} from "./review-eval-experiment-cache.mjs";
import {
  enrichExperimentNovelty,
  runExperimentRuntimeStage,
} from "./review-eval-experiment-runtime.mjs";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_CONTRACT = "docs/evals/review-skill-fixtures.json";
const DEFAULT_FIXTURE_ROOT = path.join(
  homedir(),
  ".cache/mento-review-eval-experiment-fixtures",
);

const OPTION_SPEC = {
  plan: { type: "boolean" },
  "validate-plan": { type: "string" },
  run: { type: "string" },
  incumbent: { type: "string" },
  candidate: { type: "string" },
  stage: { type: "string" },
  out: { type: "string" },
  root: { type: "string" },
  contract: { type: "string" },
  "cache-dir": { type: "string" },
  concurrency: { type: "string" },
  "live-paired": { type: "boolean" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Number(value);
}

export function parseExperimentArgs(argv) {
  let values;
  try {
    values = parseNodeArgs({
      args: argv.filter((arg) => arg !== "--"),
      options: OPTION_SPEC,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new Error(error.message, { cause: error });
  }
  if (values.help) return { help: true, mode: null };
  const selected = ["plan", "validate-plan", "run"].filter(
    (mode) => values[mode] !== undefined && values[mode] !== false,
  );
  if (selected.length !== 1) {
    throw new Error("choose exactly one of --plan, --validate-plan, or --run");
  }
  const mode = selected[0];
  const stage = values.stage ?? null;
  if (stage !== null && !EXPERIMENT_STAGES.includes(stage)) {
    throw new Error(`--stage must be ${EXPERIMENT_STAGES.join(", ")}`);
  }
  if (mode === "plan" && !values.candidate) {
    throw new Error("--plan requires --candidate ID=PATH");
  }
  if (mode === "plan" && !values.out) {
    throw new Error("--plan requires --out ABS_DIR");
  }
  if (mode === "run" && stage === null) {
    throw new Error("--run requires --stage");
  }
  if (mode !== "run" && values["dry-run"]) {
    throw new Error("--dry-run is valid only with --run");
  }
  if (mode !== "plan" && values["live-paired"]) {
    throw new Error("--live-paired is valid only with --plan");
  }
  const campaignDir =
    mode === "validate-plan" ? values["validate-plan"] : values.run;
  return {
    help: false,
    mode,
    repoRoot: path.resolve(values.root ?? process.cwd()),
    contractPath: values.contract ?? DEFAULT_CONTRACT,
    incumbent: values.incumbent ?? null,
    candidate: values.candidate ?? null,
    stage,
    out: values.out ?? null,
    campaignDir: campaignDir ? path.resolve(expandHome(campaignDir)) : null,
    fixtureCacheDir: values["cache-dir"]
      ? path.resolve(expandHome(values["cache-dir"]))
      : null,
    concurrency: positiveInteger(
      values.concurrency,
      "concurrency",
      DEFAULT_CONCURRENCY,
    ),
    includeLivePaired: values["live-paired"] === true,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
  };
}

function usage() {
  return `Usage: node scripts/review/review-eval-experiment.mjs MODE [options]

Plan and run one paired review-skill experiment outside the canonical ledger.
Only --run without --dry-run invokes a model.

Modes:
  --plan                    Write a complete campaign plan
  --validate-plan DIR       Validate plan.json and current input bytes
  --run DIR                 Run one planned stage

Plan options:
  --candidate ID=PATH       One candidate skill
  --incumbent PATH          Paired incumbent; default ${DEFAULT_SKILL_DIR}
  --out ABS_DIR             Campaign artifact directory
  --live-paired             Plan the optional live-finder stage

Run options:
  --stage STAGE             screen, holdout, or live-paired
  --cache-dir PATH          Mutable fixture cache outside the repository
  --concurrency N           Fixture lanes, 1..3
  --dry-run                 Print the planned lanes without a model call

Shared options:
  --root PATH               Repository root
  --contract PATH           Frozen fixture contract
  --json                    Pretty JSON output
  -h, --help                Show this help
`;
}

function parseCandidate(value) {
  const split = value.indexOf("=");
  if (split <= 0 || split === value.length - 1) {
    throw new Error(
      `--candidate must be ID=PATH, got ${JSON.stringify(value)}`,
    );
  }
  const id = value.slice(0, split);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new Error(
      "candidate ID must use letters, numbers, dot, dash, or underscore",
    );
  }
  return { id, skill_ref: path.resolve(expandHome(value.slice(split + 1))) };
}

export function assertOutsideRepository(target, repoRoot, label) {
  const resolved = canonicalPath(path.resolve(target));
  const protectedRoots = new Set(
    sourceCheckouts({ env: {}, roots: [repoRoot] }).map((root) =>
      canonicalPath(path.resolve(root)),
    ),
  );
  for (const repository of protectedRoots) {
    const relative = path.relative(repository, resolved);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    ) {
      throw new Error(`${label} ${resolved} must be outside ${repository}`);
    }
  }
  return resolved;
}

export function isExperimentEntryPoint(entryPath, moduleUrl = import.meta.url) {
  return Boolean(entryPath) && moduleUrl === pathToFileURL(entryPath).href;
}

function providerVersion(name, env) {
  const result = spawnSync(name, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0 || !String(result.stdout).trim()) {
    throw new Error(
      `${name} version probe failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    );
  }
  return String(result.stdout).trim();
}

function writePlan(file, plan) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

/** One line naming an upgrade between the planned and the live provider CLI. */
function driftWarning(drift) {
  return (
    `runtime drift: ${drift.summary}; ` +
    "cells that run now are labelled with the live versions"
  );
}

function readPlan(campaignDir) {
  const file = path.join(campaignDir, "plan.json");
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`campaign plan ${file} is unreadable: ${error.message}`, {
      cause: error,
    });
  }
  return { file, plan };
}

function loadCurrentContract(options) {
  const contractFile = path.resolve(options.repoRoot, options.contractPath);
  return { contractFile, ...loadContract(contractFile) };
}

async function planCampaign(options) {
  const artifactRoot = assertOutsideRepository(
    path.resolve(expandHome(options.out)),
    options.repoRoot,
    "experiment artifact root",
  );
  const { contract, digest: contractDigest } = loadCurrentContract(options);
  const fixtureCheck = checkFixtures({
    contract,
    repoRoot: options.repoRoot,
    offline: true,
    srcRepo: options.repoRoot,
  });
  if (!fixtureCheck.ok) throw new Error(fixtureCheck.problems.join(" | "));
  const env = scrubbedEnv({ roots: [options.repoRoot] });
  const plan = buildExperimentPlan({
    contract,
    contractDigest,
    plannedAt: new Date().toISOString(),
    incumbent: {
      id: "incumbent",
      skill_ref: path.resolve(
        expandHome(options.incumbent ?? DEFAULT_SKILL_DIR),
      ),
    },
    candidate: parseCandidate(options.candidate),
    cliVersions: {
      claude: providerVersion("claude", env),
      codex: providerVersion("codex", env),
    },
    includeLivePaired: options.includeLivePaired,
  });
  const planFile = path.join(artifactRoot, "plan.json");
  writePlan(planFile, plan);
  return { artifact_root: artifactRoot, plan_file: planFile, plan };
}

function validateLoadedCampaign(options) {
  const artifactRoot = assertOutsideRepository(
    options.campaignDir,
    options.repoRoot,
    "experiment artifact root",
  );
  const { file, plan } = readPlan(artifactRoot);
  const { contract, digest: contractDigest } = loadCurrentContract(options);
  const fixtureCheck = checkFixtures({
    contract,
    repoRoot: options.repoRoot,
    offline: true,
    srcRepo: options.repoRoot,
  });
  if (!fixtureCheck.ok) throw new Error(fixtureCheck.problems.join(" | "));
  const env = scrubbedEnv({ roots: [options.repoRoot] });
  const liveCliVersions = {
    claude: providerVersion("claude", env),
    codex: providerVersion("codex", env),
  };
  const validation = validateExperimentPlan({
    plan,
    contract,
    contractDigest,
    cliVersions: liveCliVersions,
  });
  if (!validation.ok) throw new Error(validation.problems.join(" | "));
  return {
    artifactRoot,
    planFile: file,
    plan,
    contract,
    liveCliVersions,
    drift: validation.drift,
  };
}

function stageIdentity(plan, stage) {
  const base = {
    schema_version: 1,
    phase: "stage",
    plan_digest: plan.plan_digest,
    stage,
  };
  return { ...base, digest: digestObject(base) };
}

function readStageResult({ artifactRoot, plan, stage }) {
  return readExperimentCache({
    artifactRoot,
    kind: "stage",
    identity: stageIdentity(plan, stage),
  });
}

function requirePrerequisite({ artifactRoot, plan, stage }) {
  const prerequisite =
    stage === "holdout" ? "screen" : stage === "live-paired" ? "holdout" : null;
  if (!prerequisite) return;
  const prior = readStageResult({ artifactRoot, plan, stage: prerequisite });
  if (!prior || prior.payload.decision?.status !== "PROMISING") {
    throw new Error(`${stage} requires a PROMISING ${prerequisite} result`);
  }
}

function recordsByStage({ artifactRoot, plan, stage, records }) {
  const output = { [stage]: records };
  if (stage === "holdout") {
    output.screen = readStageResult({
      artifactRoot,
      plan,
      stage: "screen",
    }).payload.records;
  }
  return output;
}

function splitRecords(records) {
  const output = {};
  for (const record of records) {
    (output[record.stage] ??= []).push(record);
  }
  return output;
}

async function runStage(options, campaign) {
  const { artifactRoot, plan, contract } = campaign;
  const stagePlan = stagePlanFor({ plan, stage: options.stage });
  if (!stagePlan.enabled) {
    throw new Error(`${options.stage} was not enabled in the campaign plan`);
  }
  if (options.concurrency > DEFAULT_CONCURRENCY) {
    throw new Error(`--concurrency cannot exceed ${DEFAULT_CONCURRENCY}`);
  }
  if (options.dryRun) {
    return {
      dry_run: true,
      stage: options.stage,
      lanes: stagePlan.lanes.map((lane) => ({
        lane_id: lane.lane_id,
        pr: lane.pr,
        source: lane.source,
        sequence: lane.sequence,
      })),
    };
  }
  requirePrerequisite({ artifactRoot, plan, stage: options.stage });
  const existing = readStageResult({
    artifactRoot,
    plan,
    stage: options.stage,
  });
  if (existing) return { ...existing.payload, cache_reused: true };
  const fixtureCacheDir = assertOutsideRepository(
    options.fixtureCacheDir ??
      path.join(DEFAULT_FIXTURE_ROOT, plan.campaign_id),
    options.repoRoot,
    "experiment fixture cache",
  );
  const runtimeOptions = {
    plan,
    stage: options.stage,
    artifactRoot,
    repoRoot: options.repoRoot,
    contract,
    fixtureCacheDir,
    concurrency: options.concurrency,
  };
  const base = await runExperimentRuntimeStage(runtimeOptions);
  const labelled = labelRecordRuntimes({
    records: base.records,
    planned: plan.inputs.cli_versions,
    live: campaign.liveCliVersions ?? null,
  });
  const runtimeDrift = campaign.drift
    ? { ...campaign.drift, cell_ids: labelled.fresh_cell_ids }
    : null;
  let grouped = recordsByStage({
    artifactRoot,
    plan,
    stage: options.stage,
    records: labelled.records,
  });
  let decision = evaluateExperimentDecision({
    plan,
    stage: options.stage,
    recordsByStage: grouped,
    runtimeDrift,
  });
  if (decision.novelty?.required === true) {
    const enriched = await enrichExperimentNovelty({
      ...runtimeOptions,
      records: Object.values(grouped).flat(),
    });
    grouped = splitRecords(enriched);
    decision = evaluateExperimentDecision({
      plan,
      stage: options.stage,
      recordsByStage: grouped,
      runtimeDrift,
    });
  }
  const payload = {
    schema_version: 1,
    plan_digest: plan.plan_digest,
    stage: options.stage,
    cli_versions: {
      planned: plan.inputs.cli_versions,
      drift: runtimeDrift,
    },
    records: grouped[options.stage],
    records_by_stage: grouped,
    decision,
  };
  const stored = writeExperimentCache({
    artifactRoot,
    kind: "stage",
    identity: stageIdentity(plan, options.stage),
    payload,
  });
  return { ...stored.payload, cache_reused: false };
}

function output(value, json) {
  process.stdout.write(
    `${json ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseExperimentArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  let value;
  if (options.mode === "plan") value = await planCampaign(options);
  else {
    const campaign = validateLoadedCampaign(options);
    if (campaign.drift && options.mode === "run") {
      process.stderr.write(`warning: ${driftWarning(campaign.drift)}\n`);
    }
    value =
      options.mode === "validate-plan"
        ? {
            ok: true,
            artifact_root: campaign.artifactRoot,
            plan_file: campaign.planFile,
            plan_digest: campaign.plan.plan_digest,
            cli_version_drift: campaign.drift,
            warnings: campaign.drift ? [driftWarning(campaign.drift)] : [],
          }
        : await runStage(options, campaign);
  }
  output(value, options.json);
}

if (isExperimentEntryPoint(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

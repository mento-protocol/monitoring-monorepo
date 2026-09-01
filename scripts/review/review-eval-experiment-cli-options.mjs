// Command-line parsing for the non-ledger review experiment lane.

import path from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";

import { DEFAULT_CALIBRATION_PATH } from "./review-eval-run-plan.mjs";
import { EXPERIMENT_STAGES } from "./review-eval-experiment-contract.mjs";

const OPTION_SPEC = {
  plan: { type: "boolean" },
  "validate-plan": { type: "string" },
  run: { type: "string" },
  evaluate: { type: "string" },
  incumbent: { type: "string" },
  candidate: { type: "string", multiple: true },
  "candidate-id": { type: "string" },
  stage: { type: "string" },
  attempt: { type: "string" },
  results: { type: "string" },
  out: { type: "string" },
  root: { type: "string" },
  contract: { type: "string" },
  calibration: { type: "string" },
  "cache-dir": { type: "string" },
  concurrency: { type: "string" },
  "live-paired": { type: "boolean" },
  "dry-run": { type: "boolean" },
  write: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

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
  const selected = ["plan", "validate-plan", "run", "evaluate"].filter(
    (mode) => values[mode] !== undefined && values[mode] !== false,
  );
  if (selected.length !== 1) {
    throw new Error(
      "choose exactly one of --plan, --validate-plan, --run, or --evaluate",
    );
  }
  const mode = selected[0];
  const positiveInteger = (name, fallback) => {
    const raw = values[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error(`--${name} must be a positive integer`);
    }
    return Number(raw);
  };
  const stage = values.stage ?? null;
  if (stage !== null && !EXPERIMENT_STAGES.includes(stage)) {
    throw new Error(`--stage must be ${EXPERIMENT_STAGES.join(", ")}`);
  }
  return {
    help: false,
    mode,
    repoRoot: path.resolve(values.root ?? process.cwd()),
    contractPath: values.contract ?? "docs/evals/review-skill-fixtures.json",
    calibrationPath: values.calibration ?? DEFAULT_CALIBRATION_PATH,
    incumbent: values.incumbent ?? null,
    candidates: values.candidate ?? [],
    candidateId: values["candidate-id"] ?? null,
    stage,
    attempt: positiveInteger("attempt", 1),
    concurrency: positiveInteger("concurrency", 3),
    results: values.results ?? null,
    out: values.out ?? null,
    campaignDir:
      mode === "validate-plan"
        ? values["validate-plan"]
        : mode === "run"
          ? values.run
          : mode === "evaluate"
            ? values.evaluate
            : null,
    fixtureCacheDir: values["cache-dir"] ?? null,
    includeLivePaired: values["live-paired"] === true,
    dryRun: values["dry-run"] === true,
    write: values.write === true,
    json: values.json === true,
  };
}

export function experimentUsage() {
  return `Usage: node scripts/review/review-eval-experiment.mjs MODE [options]

This lane never appends to the review-eval ledger. Its only outcomes are
PROMISING, REJECT, and INCONCLUSIVE. Only --run without --dry-run spends quota.

Modes:
  --plan                    Freeze a complete campaign plan
  --validate-plan DIR       Validate plan.json without a model call
  --run DIR                 Run one planned candidate stage
  --evaluate DIR            Evaluate supplied result records without a model

Plan options:
  --incumbent PATH          Installed skill to pair against
  --candidate ID=PATH       Candidate skill; repeat up to three times
  --out ABS_DIR             Campaign path under the fixed artifact root
  --live-paired             Include the optional live-finder confirmation

Run and evaluate options:
  --candidate-id ID         Candidate in the frozen plan
  --stage STAGE             screen, holdout, or live-paired
  --attempt N               First attempt or the one allowed retry
  --concurrency N           Fixture lanes, 1..3
  --results FILE            recordsByStage JSON for --evaluate
  --dry-run                 Print the paid execution schedule only
  --write                   Persist a deterministic --evaluate decision

Shared options:
  --root PATH               Repository root
  --contract PATH           Frozen fixture contract
  --calibration PATH        Frozen judge calibration set
  --cache-dir PATH          Cache path under the fixed fixture root
  --json                    Pretty JSON output
  -h, --help                Show this help
`;
}

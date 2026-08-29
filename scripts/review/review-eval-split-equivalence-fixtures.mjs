// Generated harness sources for the review-eval split equivalence test.

export const facadeHarnessSource = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [modulePath, contractPath, fixturePath, planDir] = process.argv.slice(2);
const run = await import(pathToFileURL(modulePath));
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const kind = run.resolveKind({
  kind: "canary",
  rows: [],
  contract,
  contractDigest: "0".repeat(64),
  now: new Date("2099-03-10T00:00:00Z"),
});
const cells = run.planCells({ contract, kind });
const gitCalls = [];
const head = "a".repeat(40);
const reset = run.resetFixture({
  fixturePath,
  head,
  cellId: "probe-cell",
  runGit: ({ args }) => {
    gitCalls.push(args);
    return {
      status: 0,
      stdout: args[0] === "rev-parse" ? head + "\\n" : "",
      stderr: "",
    };
  },
});
const plan = {
  kind,
  planned_at: "2099-03-10T00:00:00Z",
  contract_digest: "0".repeat(64),
  comparability_key: "1".repeat(64),
  baseline_selection: "automatic",
  baseline: null,
  detail_dir: "generated/facade-plan",
  inputs: {
    skill_digest: "2".repeat(64),
    skill_ref: "installed",
    finder_argv_digest: "3".repeat(64),
    orchestrator_digest: "4".repeat(64),
    claude_cli: "stub-claude",
    codex_cli: "stub-codex",
    host: "stub-host",
  },
  cells,
};
let execCalls = 0;
let scoreError = null;
try {
  await run.scorePlan({
    plan,
    contract,
    contractDigest: plan.contract_digest,
    repoRoot: fixturePath,
    planDir,
    exec: async () => {
      execCalls += 1;
      throw new Error("model stub must not run");
    },
    calibrationSet: [],
    write: false,
  });
} catch (error) {
  scoreError = error.message;
}
process.stdout.write(
  JSON.stringify({
    kind,
    cell_ids: cells.map((cell) => cell.cell_id),
    reset,
    git_calls: gitCalls,
    exec_calls: execCalls,
    score_error: scoreError,
  }) + "\\n",
);
`;

export const shellHarnessSource = String.raw`#!/bin/bash
set -euo pipefail

SOURCE_ROOT="$1"
MARKER_FLAVOR="$2"
STATE="$3"
if [[ $MARKER_FLAVOR == EXTRACT ]]; then
  LIFECYCLE_SOURCE="$SOURCE_ROOT/scripts/review/run-eval.sh"
  RUNTIME_SOURCE="$LIFECYCLE_SOURCE"
else
  LIFECYCLE_SOURCE="$SOURCE_ROOT/scripts/review/run-eval-lifecycle.sh"
  RUNTIME_SOURCE="$SOURCE_ROOT/scripts/review/run-eval-runtime.sh"
fi

extract_block() {
  local file="$1" id="$2"
  if [[ $MARKER_FLAVOR == EXTRACT ]]; then
    local begin end
    if [[ $id == lifecycle-support ]]; then
      begin='# --- the run deadline --------------------------------------------------------'
      end='# --- the gh-refusing shim and the per-cell credential scrub -------------------'
    else
      begin='# --- the gh-refusing shim and the per-cell credential scrub -------------------'
      end='STARTED="$(date +%s)"'
    fi
    awk -v begin="$begin" -v end="$end" '
      $0 == begin { inside = 1 }
      $0 == end { inside = 0; found = 1; exit }
      inside { print }
      END { if (!found) exit 2 }
    ' "$file"
    return
  fi
  awk -v begin="# RUN-EVAL-$MARKER_FLAVOR-BEGIN $id" \
    -v end="# RUN-EVAL-$MARKER_FLAVOR-END $id" '
      $0 == begin { inside = 1; next }
      $0 == end { inside = 0; found = 1; exit }
      inside { print }
      END { if (!found) exit 2 }
    ' "$file"
}

fail() {
  printf 'FATAL: %s\n' "$*" >&2
  return 1
}
log() {
  printf 'LOG: %s\n' "$*"
}
json_field() {
  node -e '
    const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(doc[process.argv[2]]));
  ' "$1" "$2"
}

REPO="$STATE/repo"
CACHE_DIR="$STATE/cache"
RUN_DIR="$STATE/generated/shell-run"
LEDGER="$STATE/docs/evals/review-skill-ledger.jsonl"
CONTRACT="$STATE/docs/evals/review-skill-fixtures.json"
SPEC="$SOURCE_ROOT"
TMPROOT="$STATE/tmp"
DEADLINE=40
STARTED="$(date +%s)"
OPEN_PR=0
mkdir -p "$REPO" "$CACHE_DIR" "$RUN_DIR"

eval "$(extract_block "$LIFECYCLE_SOURCE" lifecycle-support)"

printf 'bounded-out\n' >"$RUN_DIR/calibration.json"
printf 'scored\n' >"$RUN_DIR/result-probe.json"
printf 'keep\n' >"$RUN_DIR/keep.txt"
clear_scoring_artifacts
require_safe_detail "generated/safe-detail"
bounded_status=0
run_bounded "$STATE/generated/bounded.out" 5 /bin/sh -c \
  'printf "bounded stdout\\n"; printf "bounded stderr\\n" >&2; exit 7' || bounded_status=$?
printf 'lifecycle-bounded-status=%s\n' "$bounded_status"

SKILL_REF="$STATE/skill"
mkdir -p "$SKILL_REF" "$STATE/fixture" "$STATE/generated/facade-plan"
printf '%s\n' 'Review the change.' >"$SKILL_REF/SKILL.md"
PLAN_JSON="$STATE/generated/runtime-plan.json"
PLAN_OUT="$PLAN_JSON"
node --input-type=module - "$SPEC" "$SKILL_REF" "$PLAN_JSON" <<'NODE'
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [spec, skill, planPath] = process.argv.slice(2);
const run = await import(
  pathToFileURL(spec + "/scripts/review/review-eval-run.mjs"),
);
writeFileSync(
  planPath,
  JSON.stringify({
    kind: "canary",
    contract_digest: "0".repeat(64),
    resume_from: null,
    inputs: {
      skill_digest: run.skillDigest(skill),
      skill_ref: skill,
      finder_argv_digest: "1".repeat(64),
      orchestrator_digest: "2".repeat(64),
      claude_cli: "stub-claude",
      codex_cli: "stub-codex",
    },
    cells: [],
  }, null, 2) + "\n",
);
NODE

eval "$(extract_block "$RUNTIME_SOURCE" cell-runtime)"
FIXTURE_PRS=(1990)
FIXTURE_PATHS=("$STATE/fixture")
FIXTURE_HEADS=("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
runtime_status=0
run_cell probe-control 1990 control 1 stub-model stub-effort '' '' request || \
  runtime_status=$?
printf 'runtime-cell-status=%s\n' "$runtime_status"
rm -rf "$SHIM" "$SKILL_SNAPSHOT"
SHIM=""
SKILL_SNAPSHOT=""
`;

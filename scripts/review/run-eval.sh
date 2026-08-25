#!/usr/bin/env bash
# Run the review-skill evaluation end to end. This is the only script that
# spends model quota, and it never runs in CI.
#
# The contract that scores a run is the committed one: the script adds a
# detached worktree of origin/main and reads the fixtures, truth, prompts and
# scorer from there, so a dirty working tree cannot silently change what is
# being measured. --skill-ref is the deliberate exception for evaluating a
# candidate skill; it uses the current checkout and stamps dirty into the row.
#
# Leak-proofing during a contestant run: every GitHub token variable is unset,
# a gh that refuses is placed first on PATH, and git runs with no global or
# system config, no credential helper, no prompt, no askpass and no protocol
# but file. This is defense in depth, not containment — the model API hosts
# stay reachable because codex and claude need them, and a cell runs with Bash.
# The stronger controls are structural: the fixture is a detached checkout at a
# 2026-08 commit, the answer key exists only on main, and a transcript that
# names a withheld commit is scored as a hard leak signal.
#
# Every cell writes its own output directory and is resumable. A failed cell is
# never cached: a session-limit error returns in seconds and, cached, would
# permanently score as a zero-recall review. A cached cell is reused only when
# its fingerprint — skill digest, kind, contract digest — matches this run.
#
# Usage:
#   run-eval.sh [--kind full|canary|auto] [--skill-ref PATH] [--pr] [--no-pr]
#               [--repo PATH] [--cache-dir DIR] [--deadline SECONDS]
#
# Default is --no-pr: the branch, push and gh pr create commands are printed,
# not executed.

set -euo pipefail

KIND="auto"
SKILL_REF=""
OPEN_PR=0
REPO=""
CACHE_DIR="${HOME}/.cache/mento-review-eval"
DEADLINE=21600
SPEC=""
SPEC_TEMP=0
SHIM=""
RUN_DIR=""
PLAN_JSON=""
STARTED=0
STATUS_NOTE=""

fail() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"
}

require_value() {
  if [[ -z ${2:-} || ${2:-} == --* ]]; then
    fail "$1 requires a value"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)
      require_value "$1" "${2:-}"
      KIND="$2"
      shift 2
      ;;
    --skill-ref)
      require_value "$1" "${2:-}"
      SKILL_REF="$2"
      shift 2
      ;;
    --repo)
      require_value "$1" "${2:-}"
      REPO="$2"
      shift 2
      ;;
    --cache-dir)
      require_value "$1" "${2:-}"
      CACHE_DIR="$2"
      shift 2
      ;;
    --deadline)
      require_value "$1" "${2:-}"
      # The matrix loop compares this arithmetically. A word evaluates to 0
      # there and silently ends the run before its first cell; a suffixed
      # duration such as `6h` aborts on an arithmetic syntax error. Refuse
      # both here, where the message can name the cause.
      [[ $2 =~ ^[0-9]+$ && $2 -gt 0 ]] ||
        fail "--deadline must be a positive whole number of seconds"
      DEADLINE="$2"
      shift 2
      ;;
    --pr)
      OPEN_PR=1
      shift
      ;;
    --no-pr)
      OPEN_PR=0
      shift
      ;;
    -h | --help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$KIND" in
  full | canary | auto) ;;
  *) fail "--kind must be full, canary, or auto" ;;
esac

if [[ -z $REPO ]]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
[[ -d "$REPO/.git" || -f "$REPO/.git" ]] || fail "$REPO is not a git checkout"

LEDGER="$REPO/docs/evals/review-skill-ledger.jsonl"
[[ -f $LEDGER ]] || fail "ledger $LEDGER is missing"

command -v claude >/dev/null 2>&1 || fail "claude CLI is not on PATH"
command -v codex >/dev/null 2>&1 || fail "codex CLI is not on PATH"
command -v node >/dev/null 2>&1 || fail "node is not on PATH"

TMPROOT="${TMPDIR:-/tmp}"

# shellcheck disable=SC2329  # invoked by the EXIT trap below
cleanup() {
  local code=$?
  if [[ $SPEC_TEMP -eq 1 && -n $SPEC ]]; then
    git -C "$REPO" worktree remove --force "$SPEC" >/dev/null 2>&1 || true
  fi
  if [[ -n $SHIM ]]; then
    rm -rf "$SHIM"
  fi
  return "$code"
}
trap cleanup EXIT

# --- the spec worktree -------------------------------------------------------

if [[ -n $SKILL_REF ]]; then
  [[ -d $SKILL_REF ]] || fail "--skill-ref $SKILL_REF is not a directory"
  SKILL_REF="$(cd "$SKILL_REF" && pwd)"
  SPEC="$REPO"
  log "candidate run: spec is the current checkout, skill is $SKILL_REF"
else
  git -C "$REPO" fetch origin --tags --quiet
  SPEC="$(mktemp -d "$TMPROOT/review-eval-spec.XXXXXX")"
  rm -rf "$SPEC"
  git -C "$REPO" worktree add --detach "$SPEC" origin/main --quiet
  SPEC_TEMP=1
  log "spec worktree at $SPEC ($(git -C "$SPEC" rev-parse --short HEAD))"
fi

CLI="$SPEC/scripts/review/review-eval.mjs"
CONTRACT="$SPEC/docs/evals/review-skill-fixtures.json"
[[ -f $CLI ]] || fail "$CLI is missing; the spec worktree has no harness"

# --- plan --------------------------------------------------------------------

node "$CLI" --root "$SPEC" --ledger "$LEDGER" --check-fixtures --offline >/dev/null ||
  fail "the committed contract does not validate"

PLAN_OUT="$(mktemp "$TMPROOT/review-eval-plan.XXXXXX")"
PLAN_ARGS=(--root "$SPEC" --ledger "$LEDGER" --plan --kind "$KIND" --json)
if [[ -n $SKILL_REF ]]; then
  PLAN_ARGS+=(--skill-ref "$SKILL_REF")
fi
node "$CLI" "${PLAN_ARGS[@]}" >"$PLAN_OUT" || fail "planning failed"

# Read one top-level string field out of a JSON file.
json_field() {
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node -e '
    const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(doc[process.argv[2]]));
  ' "$1" "$2"
}

RUN_DIR="$(json_field "$PLAN_OUT" plan_dir)"
KIND="$(json_field "$PLAN_OUT" kind)"
PLAN_JSON="$RUN_DIR/plan.json"
# shellcheck disable=SC2016  # the single-quoted block is node source
CELL_COUNT="$(node -e '
  const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`${plan.cells.length} cells, about $${plan.estimate.claude_usd}`);
' "$PLAN_JSON")"
log "plan $KIND: $CELL_COUNT"
log "detail directory $RUN_DIR"

# --- a failed run still leaves a trace ---------------------------------------

write_failed_row() {
  local reason="$1"
  local row="$RUN_DIR/row.json"
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node --input-type=module -e '
    const [planPath, contractPath, spec, ledger, rowPath, reason] = process.argv.slice(1);
    (async () => {
      const fixtures = await import(`${spec}/scripts/review/review-eval-fixtures.mjs`);
      const shape = await import(`${spec}/scripts/review/review-eval-result-shape.mjs`);
      const ledgerMod = await import(`${spec}/scripts/review/review-eval-ledger.mjs`);
      const fs = await import("node:fs");
      const { contract, digest } = fixtures.loadContract(contractPath);
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const row = shape.failedRow({ plan, contract, contractDigest: digest, reason });
      fs.writeFileSync(rowPath, `${JSON.stringify(row, null, 2)}\n`);
      ledgerMod.appendRow(ledger, row);
    })().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  ' "$PLAN_JSON" "$CONTRACT" "$SPEC" "$LEDGER" "$row" "$reason" ||
    log "could not write the failed row: $reason"
  log "appended a status:failed ledger row — $reason"
}

abort() {
  write_failed_row "$1"
  # launchd must not see a non-zero exit for a run that recorded its failure.
  exit 0
}

# --- the gh-refusing shim and the per-cell credential scrub -------------------

SHIM="$(mktemp -d "$TMPROOT/review-eval-shim.XXXXXX")"
cat >"$SHIM/gh" <<'SHIM_EOF'
#!/bin/sh
echo "gh is disabled during evaluation" >&2
exit 1
SHIM_EOF
chmod +x "$SHIM/gh"
mkdir -p "$SHIM/gh-empty"

# Every model call in a cell runs under this prefix. It unsets the four GitHub
# token variables, points gh at an empty config directory, and takes git's
# credential helper, terminal prompt, askpass and non-file protocols away, so a
# cell cannot fetch the withheld fix commit with the operator's credentials.
# This is defense in depth, not containment: the network stays open because the
# model API must be reachable. Naming a withheld commit is a hard leak signal.
CELL_ENV=(env
  -u GH_TOKEN -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN
  -u GH_ENTERPRISE_TOKEN
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_ALLOW_PROTOCOL=file
  GH_CONFIG_DIR="$SHIM/gh-empty" PATH="$SHIM:$PATH")

# --- skill staging -----------------------------------------------------------

SKILL_DIR="${SKILL_REF:-${REVIEW_EVAL_SKILL_DIR:-$HOME/.claude/skills/review}}"
[[ -f "$SKILL_DIR/SKILL.md" ]] || fail "no SKILL.md under $SKILL_DIR"

purge_skill() {
  local fixture="$1"
  if [[ -d "$fixture/.skill" ]]; then
    chmod -R u+rwX "$fixture/.skill" 2>/dev/null || true
    rm -rf "$fixture/.skill"
  fi
}

# The preamble mirrors the benchmark's staging exactly: frontmatter stripped,
# bundled files listed by their .skill/ path. Both halves are load-bearing —
# a skill whose references are unreachable measures a different treatment.
stage_skill() {
  local fixture="$1"
  purge_skill "$fixture"
  cp -R "$SKILL_DIR" "$fixture/.skill"
  chmod -R u+rwX "$fixture/.skill"
  {
    printf 'A skill has been loaded for this task. Treat it as authoritative.\n\n'
    printf '<skill-instructions>\n'
    awk 'NR==1 && /^---$/ {front=1; next} front && /^---$/ {front=0; next} !front' \
      "$fixture/.skill/SKILL.md"
    printf '</skill-instructions>\n'
    local extra
    extra="$(cd "$fixture/.skill" && find . -type f ! -name SKILL.md |
      sed 's|^\./|  - .skill/|' | LC_ALL=C sort)"
    if [[ -n $extra ]]; then
      # shellcheck disable=SC2016  # the backticks are markdown in the preamble
      printf '\nBundled files ship with these instructions in `.skill/` of your working '
      # shellcheck disable=SC2016  # the backticks are markdown in the preamble
      printf 'directory; a relative path in the instructions resolves to `.skill/<path>`:\n'
      printf '%s\n' "$extra"
    fi
  }
}

# --- fixtures ----------------------------------------------------------------

declare -a FIXTURE_PRS=()
declare -a FIXTURE_PATHS=()

# `fixture_path` answers in this global rather than on stdout. A command
# substitution would run it in a subshell, where the two memo arrays below are
# a discarded copy — every cell would then miss the memo and re-run the whole
# `build-fixture.sh` leak verification for a fixture already on disk. The
# per-cell `git reset --hard` and `git clean` live at the call site, so a memo
# hit still gets a clean tree.
FIXTURE_PATH=""

fixture_path() {
  local pr="$1" index=0
  FIXTURE_PATH=""
  for index in "${!FIXTURE_PRS[@]}"; do
    if [[ ${FIXTURE_PRS[$index]} == "$pr" ]]; then
      FIXTURE_PATH="${FIXTURE_PATHS[$index]}"
      return 0
    fi
  done
  local built
  # shellcheck disable=SC2016  # the single-quoted block is node source
  built="$(node --input-type=module -e '
    const [contractPath, pr, cacheDir, srcRepo, repoRoot] = process.argv.slice(1);
    (async () => {
      const m = await import(`${repoRoot}/scripts/review/review-eval-fixtures.mjs`);
      const { contract } = m.loadContract(contractPath);
      const report = m.materializeFixture({
        contract, pr: Number(pr), cacheDir, srcRepo, repoRoot,
      });
      process.stdout.write(report.path);
    })().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  ' "$CONTRACT" "$pr" "$CACHE_DIR" "$REPO" "$SPEC")" || return 1
  FIXTURE_PRS+=("$pr")
  FIXTURE_PATHS+=("$built")
  FIXTURE_PATH="$built"
}

# --- the finder argv and the cell fingerprint --------------------------------

# The finder is spawned as an argument vector, never as a command string: the
# contract validator pins every element to [A-Za-z0-9._="@/:-], so reading one
# element per line reconstructs the array exactly and nothing is word-split.
FINDER_ARGV=()
while IFS= read -r finder_argv_element; do
  FINDER_ARGV+=("$finder_argv_element")
done < <(
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const cell = plan.cells.find((candidate) => Array.isArray(candidate.finder_argv));
    for (const element of cell?.finder_argv ?? []) {
      if (typeof element !== "string" || !/^[A-Za-z0-9._="@/:-]+$/.test(element)) {
        throw new Error(`finder argv element is not contract-safe: ${JSON.stringify(element)}`);
      }
      process.stdout.write(`${element}\n`);
    }
  ' "$PLAN_JSON"
)

# What a cached cell must have been produced under. An aborted run leaves cells
# behind, and the next run may carry an edited skill into the same directory.
# shellcheck disable=SC2016  # the single-quoted block is node source
FINGERPRINT_JSON="$(node --input-type=module -e '
  const [spec, planPath] = process.argv.slice(1);
  (async () => {
    const run = await import(`${spec}/scripts/review/review-eval-run.mjs`);
    const fs = await import("node:fs");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    process.stdout.write(JSON.stringify(run.cellFingerprint({ plan })));
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
' "$SPEC" "$PLAN_JSON")" || fail "the plan carries no cell fingerprint"

# Prints the reason a cached cell may not be reused and returns 0; returns 1
# when the cached cell matches this run and may be reused.
cell_reuse_refusal() {
  local reason
  # shellcheck disable=SC2016  # the single-quoted block is node source
  reason="$(node --input-type=module -e '
    const [spec, planPath, resultPath] = process.argv.slice(1);
    (async () => {
      const run = await import(`${spec}/scripts/review/review-eval-run.mjs`);
      const fs = await import("node:fs");
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const decision = run.cellReuseDecision({ plan, resultPath });
      if (decision.reuse) process.exit(1);
      process.stdout.write(decision.reason);
    })().catch((error) => {
      process.stdout.write(`the cached cell could not be read: ${error.message}`);
    });
  ' "$SPEC" "$PLAN_JSON" "$1" 2>/dev/null)" || return 1
  printf '%s' "$reason"
  return 0
}

# --- one cell ----------------------------------------------------------------

CLAUDE_TOOLS=(Read Write Edit Bash Grep Glob Agent TodoWrite)

run_cell() {
  local cell_id="$1" pr="$2" condition="$3" draw="$4" model="$5" effort="$6"
  local finder="$7" finder_report="$8" prompt_kind="$9"
  local out_dir="$RUN_DIR/cells/$cell_id"

  if [[ -f "$out_dir/result.json" ]]; then
    local refusal
    if refusal="$(cell_reuse_refusal "$out_dir/result.json")"; then
      log "  $cell_id not reused — $refusal; re-running"
      rm -rf "$out_dir"
    else
      log "  $cell_id reused"
      return 0
    fi
  fi

  local fixture
  fixture_path "$pr" || {
    log "  $cell_id FAILED — fixture"
    return 1
  }
  fixture="$FIXTURE_PATH"

  local started other_review="" codex_chars=0
  started="$(date +%s)"
  purge_skill "$fixture"
  # Cells share one fixture per PR and run with bypassPermissions, so the tree
  # is returned to its checked-out state before every cell. Without this a cell
  # reviews the previous cell's edits, and control reviews a mutated tree.
  if ! git -C "$fixture" reset --hard --quiet ||
    ! git -C "$fixture" clean -xdffq; then
    log "  $cell_id FAILED — the fixture could not be reset"
    return 1
  fi

  if [[ $condition == "pipeline" ]]; then
    if [[ ${#FINDER_ARGV[@]} -eq 0 ]]; then
      log "  $cell_id FAILED — the plan carries no finder argv"
      return 1
    fi
    other_review="$(cd "$fixture" && "${CELL_ENV[@]}" \
      "${FINDER_ARGV[@]}" 2>/dev/null | tail -c 30000)" || true
    if [[ -z ${other_review//[[:space:]]/} ]]; then
      log "  $cell_id FAILED — the finder produced nothing; not cached"
      return 1
    fi
  elif [[ $condition == "replay" ]]; then
    other_review="$(cat "$SPEC/$finder_report")"
  fi
  codex_chars="${#other_review}"

  local prompt
  if [[ $prompt_kind == "handoff" ]]; then
    # shellcheck disable=SC2016  # the single-quoted block is node source
    prompt="$(REVIEW_EVAL_OTHER="$other_review" node -e '
      const fs = require("node:fs");
      const template = fs.readFileSync(process.argv[1], "utf8");
      // The replacement is a function on purpose. A string replacement gives
      // the finder output its own dollar-sign patterns, so a review that
      // happens to contain one would silently rewrite the prompt around it.
      process.stdout.write(
        template.replace("{{OTHER_REVIEW}}", () => process.env.REVIEW_EVAL_OTHER),
      );
    ' "$SPEC/scripts/review/prompts/handoff.md")"
  else
    prompt="$(cat "$SPEC/scripts/review/prompts/request.md")"
  fi

  local -a claude_args=(-p "$prompt" --model "$model" --effort "$effort"
    --setting-sources "" --output-format json
    --permission-mode bypassPermissions
    --allowed-tools "${CLAUDE_TOOLS[@]}" --max-turns 80)
  if [[ $condition != "control" ]]; then
    claude_args+=(--append-system-prompt "$(stage_skill "$fixture")")
  fi

  local raw other_file
  raw="$(mktemp "$TMPROOT/review-eval-cell.XXXXXX")"
  other_file="$(mktemp "$TMPROOT/review-eval-other.XXXXXX")"
  printf '%s' "$other_review" >"$other_file"
  if ! (cd "$fixture" && "${CELL_ENV[@]}" \
    claude "${claude_args[@]}") >"$raw" 2>/dev/null; then
    rm -f "$raw" "$other_file"
    purge_skill "$fixture"
    log "  $cell_id FAILED — claude exited non-zero; not cached"
    return 1
  fi
  purge_skill "$fixture"

  mkdir -p "$out_dir"
  # shellcheck disable=SC2016  # the single-quoted block is node source
  if ! REVIEW_EVAL_CELL="$cell_id" REVIEW_EVAL_PR="$pr" \
    REVIEW_EVAL_CONDITION="$condition" REVIEW_EVAL_DRAW="$draw" \
    REVIEW_EVAL_MODEL="$model" REVIEW_EVAL_EFFORT="$effort" \
    REVIEW_EVAL_FINDER="$finder" REVIEW_EVAL_FIXTURE="$fixture" \
    REVIEW_EVAL_SECONDS="$(($(date +%s) - started))" \
    REVIEW_EVAL_FINDER_CHARS="$codex_chars" \
    REVIEW_EVAL_FINGERPRINT="$FINGERPRINT_JSON" \
    node -e '
      const fs = require("node:fs");
      const raw = fs.readFileSync(process.argv[1], "utf8");
      let envelope;
      try { envelope = JSON.parse(raw); } catch { envelope = { is_error: true, result: raw.slice(-4000) }; }
      const ok = !envelope.is_error && typeof envelope.result === "string" && envelope.result.trim() !== "";
      if (!ok) process.exit(3);
      const other = fs.readFileSync(process.argv[2], "utf8");
      fs.writeFileSync(process.argv[3], `${JSON.stringify({
        cell_id: process.env.REVIEW_EVAL_CELL,
        pr: Number(process.env.REVIEW_EVAL_PR),
        condition: process.env.REVIEW_EVAL_CONDITION,
        draw: Number(process.env.REVIEW_EVAL_DRAW),
        model: process.env.REVIEW_EVAL_MODEL,
        effort: process.env.REVIEW_EVAL_EFFORT,
        finder: process.env.REVIEW_EVAL_FINDER || null,
        fixture_path: process.env.REVIEW_EVAL_FIXTURE,
        fingerprint: JSON.parse(process.env.REVIEW_EVAL_FINGERPRINT),
        ok: true,
        output: envelope.result,
        other_review: other,
        finder_chars: Number(process.env.REVIEW_EVAL_FINDER_CHARS),
        seconds: Number(process.env.REVIEW_EVAL_SECONDS),
        cost_usd: envelope.total_cost_usd ?? 0,
        turns: envelope.num_turns ?? null,
      }, null, 1)}\n`);
    ' "$raw" "$other_file" "$out_dir/result.json"; then
    rm -rf "$out_dir"
    rm -f "$raw" "$other_file"
    log "  $cell_id FAILED — claude reported an error; not cached"
    return 1
  fi
  rm -f "$raw" "$other_file"
  log "  $cell_id ok $(($(date +%s) - started))s"
  return 0
}

# --- the matrix --------------------------------------------------------------

# One tab-separated line per planned cell, in plan order. Every field comes
# from the contract, so a tab or a newline in one of them would forge extra
# rows in the reader below: such a field aborts the run instead.
cell_rows() {
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const cell of plan.cells) {
      const fields = [
        cell.cell_id, cell.pr, cell.condition, cell.draw, cell.model,
        cell.effort, cell.finder ?? "", cell.finder_report ?? "",
        cell.prompt,
      ].map(String);
      for (const [index, field] of fields.entries()) {
        if (/[\t\r\n]/.test(field)) {
          throw new Error(
            `cell ${cell.cell_id} field ${index} carries a tab or a newline: ${JSON.stringify(field)}`,
          );
        }
      }
      process.stdout.write(fields.join("\t") + "\n");
    }
  ' "$PLAN_JSON"
}

STARTED="$(date +%s)"
FAILED=0
DONE=0
TOTAL=0

while IFS=$'\t' read -r cell_id pr condition draw model effort finder \
  finder_report prompt_kind extra; do
  TOTAL=$((TOTAL + 1))
  if [[ -n ${extra:-} ]]; then
    fail "the plan produced a cell row with an extra field: $extra"
  fi
  if [[ $(($(date +%s) - STARTED)) -ge $DEADLINE ]]; then
    STATUS_NOTE="deadline of ${DEADLINE}s reached"
    log "deadline reached; the matrix is partial"
    break
  fi
  if run_cell "$cell_id" "$pr" "$condition" "$draw" "$model" "$effort" \
    "$finder" "$finder_report" "$prompt_kind"; then
    DONE=$((DONE + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done < <(cell_rows)

log "matrix: $DONE done, $FAILED failed, of $TOTAL"
if [[ $DONE -eq 0 ]]; then
  abort "every cell failed${STATUS_NOTE:+ ($STATUS_NOTE)}"
fi

# --- score, validate, report -------------------------------------------------

log "scoring (this calls the judge)"
node "$CLI" --root "$SPEC" --ledger "$LEDGER" --score "$RUN_DIR" --json ||
  abort "scoring failed"

log "validating the row against its own detail"
node "$CLI" --root "$SPEC" --ledger "$LEDGER" --validate "$RUN_DIR/row.json" --append --json ||
  abort "the scored row did not revalidate; nothing was appended"

REPORT="$RUN_DIR/report.md"
node "$CLI" --root "$SPEC" --ledger "$LEDGER" --report >"$REPORT"
VERDICT="$(json_field "$RUN_DIR/row.json" verdict)"
log "verdict $VERDICT"

# --- publish -----------------------------------------------------------------

DETAIL_DIR="$(json_field "$RUN_DIR/row.json" detail_dir)"
mkdir -p "$REPO/$(dirname "$DETAIL_DIR")"
if [[ "$RUN_DIR" != "$REPO/$DETAIL_DIR" ]]; then
  rm -rf "${REPO:?}/$DETAIL_DIR"
  cp -R "$RUN_DIR" "$REPO/$DETAIL_DIR"
fi
rm -rf "${REPO:?}/$DETAIL_DIR/cells"

BRANCH="eval/review-skill-$(date -u +%Y-%m-%d)"
TITLE="Review-skill eval $(date -u +%Y-%m-%d): $VERDICT"

printf '\n----- ledger PR -----\n'
printf 'git -C %q checkout -b %q\n' "$REPO" "$BRANCH"
printf 'git -C %q add docs/evals/review-skill-ledger.jsonl %q\n' "$REPO" "$DETAIL_DIR"
printf 'git -C %q commit -m %q\n' "$REPO" "chore(evals): review-skill eval $VERDICT"
printf 'git -C %q push -u origin %q\n' "$REPO" "$BRANCH"
printf 'gh pr create --repo mento-protocol/monitoring-monorepo --title %q --body-file %q\n' \
  "$TITLE" "$REPO/$DETAIL_DIR/report.md"
printf '\nNo auto-merge. A human reads the report and approves.\n'

if [[ $OPEN_PR -eq 1 ]]; then
  log "opening the ledger PR"
  git -C "$REPO" checkout -b "$BRANCH"
  git -C "$REPO" add docs/evals/review-skill-ledger.jsonl "$DETAIL_DIR"
  git -C "$REPO" commit -m "chore(evals): review-skill eval $VERDICT"
  git -C "$REPO" push -u origin "$BRANCH"
  gh pr create --repo mento-protocol/monitoring-monorepo \
    --title "$TITLE" --body-file "$REPO/$DETAIL_DIR/report.md"
fi

cat "$REPORT"
exit 0

#!/usr/bin/env bash
# Skill, fixture, cache, and cell runtime for run-eval.sh.
# This file is sourced after the run plan exists. Do not execute it directly.

# RUN-EVAL-ORIGINAL-BEGIN cell-runtime
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
#
# `OLDPWD` goes with them, and it is the one that hands over a path rather than
# a credential. Bash exports it, and `run_in_fixture` sets it by `cd`-ing from
# the invocation directory — the repository root, per the runbook — into the
# fixture, so the contestant inherits the source checkout's location. The answer
# key lives there, frozen on main under docs/evals/review-skill-truth/, and a
# cell that reads it copies out every defect while emitting no PR number,
# reviewer login or withheld SHA for `leakSignals()` to catch: the run scores a
# recall it never earned. A shell tool re-initializes `OLDPWD` for itself, but
# `claude` and `codex` are not shells and carry the inherited value in their own
# environment, so cut it at the boundary rather than lean on that.
# `PWD` stays, because it is the fixture the cell is supposed to be reviewing.
CELL_ENV=(env
  -u GH_TOKEN -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN
  -u GH_ENTERPRISE_TOKEN -u OLDPWD)
# The documented invocation is `pnpm review:eval:run`, and pnpm exports its own
# family of path-bearing variables into every script it runs — INIT_CWD,
# PNPM_SCRIPT_SRC_DIR, npm_package_json, npm_config_local_prefix and more, each
# carrying the checkout the answer key lives in. The family is open-ended, so
# scrub it by name pattern from the live environment instead of enumerating.
while IFS= read -r cell_env_var; do
  CELL_ENV+=(-u "$cell_env_var")
done < <(compgen -e | grep -E '^(npm_|PNPM_|INIT_CWD$|NODE_PATH$)' || true)

# `PATH` is the last path-bearing variable, and it survives the scrub above
# because a cell still needs node, git and the model CLIs. Under
# `pnpm review:eval:run` pnpm prepends `<checkout>/node_modules/.bin` to it, so
# passing the caller's `PATH` through verbatim hands every Bash-enabled
# contestant the checkout root the INIT_CWD scrub just took away — and the
# answer key sits in it, under docs/evals/review-skill-truth/, readable with no
# PR number, reviewer login or withheld SHA for `leakSignals()` to catch.
# Rebuild it instead: the shim first, then every inherited entry that does not
# resolve inside the source checkout. Entries are compared canonically, because
# a symlinked `node_modules/.bin` passes a string comparison and still lands in
# the repository.
CELL_PATH="$SHIM"
REPO_REAL="$(cd "$REPO" && pwd -P)"
while IFS= read -r cell_path_entry; do
  [[ -n $cell_path_entry ]] || continue
  cell_path_real="$(cd "$cell_path_entry" 2>/dev/null && pwd -P)" ||
    cell_path_real="$cell_path_entry"
  [[ $cell_path_real == "$REPO_REAL" || $cell_path_real == "$REPO_REAL"/* ]] &&
    continue
  [[ $cell_path_entry == "$REPO" || $cell_path_entry == "$REPO"/* ]] && continue
  CELL_PATH="$CELL_PATH:$cell_path_entry"
done < <(printf '%s\n' "${PATH//:/$'\n'}")

CELL_ENV+=(
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_ALLOW_PROTOCOL=file
  GH_CONFIG_DIR="$SHIM/gh-empty" PATH="$CELL_PATH")

# A cell that cannot start its own tools is a failed run, not a safer one, and
# dropping checkout entries is the only thing that can cause it. Check the tools
# a cell actually needs against the rebuilt PATH, in a subshell so the
# operator's own PATH is untouched.
for cell_path_tool in claude codex node git; do
  (
    PATH="$CELL_PATH"
    command -v "$cell_path_tool" >/dev/null 2>&1
  ) || fail "$cell_path_tool resolves only inside $REPO; a cell must not be given a PATH into the source checkout, so install it outside the checkout"
done

# One scrubbed model call inside one fixture. `run_bounded` needs a command it
# can start in the background and signal, which a `(cd … && …)` subshell inside
# a command substitution is not; the `cd` is confined to that background job.
# shellcheck disable=SC2329  # started by name from run_bounded
run_in_fixture() {
  local fixture="$1"
  shift
  cd "$fixture" || return 1
  "${CELL_ENV[@]}" "$@"
}

# --- skill staging -----------------------------------------------------------

SKILL_SRC="${SKILL_REF:-${REVIEW_EVAL_SKILL_DIR:-$HOME/.claude/skills/review}}"
[[ -f "$SKILL_SRC/SKILL.md" ]] || fail "no SKILL.md under $SKILL_SRC"

# The skill is the treatment under test, and the plan records its digest once
# for the whole matrix — a cached cell's fingerprint carries that one digest
# too. A full run takes about two hours, which is long enough for the operator
# to keep editing the installed skill while it runs, so staging every cell from
# the live directory would measure new content under the old digest and put two
# treatments in one row. Snapshot the skill once, refuse the run if the
# snapshot is not what was planned, and stage every cell from the snapshot.
SKILL_SNAPSHOT="$(mktemp -d "$TMPROOT/review-eval-skill.XXXXXX")"
rm -rf "$SKILL_SNAPSHOT"
cp -R "$SKILL_SRC" "$SKILL_SNAPSHOT" ||
  fail "could not snapshot the skill at $SKILL_SRC"
chmod -R u+rwX "$SKILL_SNAPSHOT"
SKILL_DIR="$SKILL_SNAPSHOT"

# shellcheck disable=SC2016  # the single-quoted block is node source
PLANNED_SKILL_DIGEST="$(node -e '
  const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(plan.inputs.skill_digest));
' "$PLAN_JSON")" || fail "the plan carries no skill digest"
# shellcheck disable=SC2016  # the single-quoted block is node source
SNAPSHOT_SKILL_DIGEST="$(node --input-type=module -e '
  const [spec, dir] = process.argv.slice(1);
  (async () => {
    const run = await import(`${spec}/scripts/review/review-eval-run.mjs`);
    process.stdout.write(run.skillDigest(dir));
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
' "$SPEC" "$SKILL_SNAPSHOT")" || fail "could not digest the skill snapshot"
[[ $SNAPSHOT_SKILL_DIGEST == "$PLANNED_SKILL_DIGEST" ]] ||
  fail "the skill at $SKILL_SRC changed after planning (planned ${PLANNED_SKILL_DIGEST:0:8}, staged ${SNAPSHOT_SKILL_DIGEST:0:8}); re-run to plan against it"

purge_skill() {
  local fixture="$1"
  if [[ -d "$fixture/.skill" ]]; then
    chmod -R u+rwX "$fixture/.skill" 2>/dev/null || true
    rm -rf "$fixture/.skill"
  fi
}

# The first instruction line of a SKILL.md, frontmatter stripped. It is the one
# byte sequence a correctly staged preamble must carry, so it is what verifies
# the staging below.
skill_body_head() {
  awk 'NR==1 && /^---$/ {front=1; next} front && /^---$/ {front=0; next}
    !front && NF {print; exit}' "$1"
}

# The preamble mirrors the benchmark's staging exactly: frontmatter stripped,
# bundled files listed by their .skill/ path. Both halves are load-bearing —
# a skill whose references are unreachable measures a different treatment.
#
# The call site takes this on stdout inside a command substitution, so a failed
# `cp -R` would be discarded twice over and the framing printfs alone would
# still render a plausible, empty preamble. That cell would run, exit 0, cache,
# and be folded in as the skill's score. Both halves are checked here instead:
# a non-zero copy and a preamble that does not carry the snapshot's own first
# instruction line each return non-zero, and the caller fails the cell.
stage_skill() {
  local fixture="$1"
  purge_skill "$fixture"
  cp -R "$SKILL_DIR" "$fixture/.skill" || return 1
  chmod -R u+rwX "$fixture/.skill"
  local head preamble
  head="$(skill_body_head "$SKILL_DIR/SKILL.md")"
  preamble="$(
    printf 'A skill has been loaded for this task. Treat it as authoritative.\n\n'
    printf '<skill-instructions>\n'
    awk 'NR==1 && /^---$/ {front=1; next} front && /^---$/ {front=0; next} !front' \
      "$fixture/.skill/SKILL.md"
    printf '</skill-instructions>\n'
    extra="$(cd "$fixture/.skill" && find . -type f ! -name SKILL.md |
      sed 's|^\./|  - .skill/|' | LC_ALL=C sort)"
    if [[ -n $extra ]]; then
      # shellcheck disable=SC2016  # the backticks are markdown in the preamble
      printf '\nBundled files ship with these instructions in `.skill/` of your working '
      # shellcheck disable=SC2016  # the backticks are markdown in the preamble
      printf 'directory; a relative path in the instructions resolves to `.skill/<path>`:\n'
      printf '%s\n' "$extra"
    fi
  )"
  [[ -n $head && $preamble == *"$head"* ]] || return 1
  printf '%s\n' "$preamble"
}

# --- fixtures ----------------------------------------------------------------

declare -a FIXTURE_PRS=()
declare -a FIXTURE_PATHS=()
declare -a FIXTURE_HEADS=()

# `fixture_path` answers in these globals rather than on stdout. A command
# substitution would run it in a subshell, where the memo arrays below are a
# discarded copy — every cell would then miss the memo and re-run the whole
# `build-fixture.sh` leak verification for a fixture already on disk. The
# per-cell `reset_fixture` lives at the call site, so a memo hit still gets a
# clean tree at the pinned commit.
FIXTURE_PATH=""
FIXTURE_HEAD=""

fixture_path() {
  local pr="$1" index=0
  FIXTURE_PATH=""
  FIXTURE_HEAD=""
  for index in "${!FIXTURE_PRS[@]}"; do
    if [[ ${FIXTURE_PRS[$index]} == "$pr" ]]; then
      FIXTURE_PATH="${FIXTURE_PATHS[$index]}"
      FIXTURE_HEAD="${FIXTURE_HEADS[$index]}"
      return 0
    fi
  done
  # The head comes back beside the path because the per-cell reset targets it
  # explicitly. `materializeFixture` already refuses a build whose head is not
  # the contract's `first_head`, so this is the pinned commit by construction.
  local built head
  # shellcheck disable=SC2016  # the single-quoted block is node source
  built="$(node --input-type=module -e '
    const [contractPath, pr, cacheDir, srcRepo, repoRoot] = process.argv.slice(1);
    (async () => {
      const m = await import(`${repoRoot}/scripts/review/review-eval-fixtures.mjs`);
      const { contract } = m.loadContract(contractPath);
      const report = m.materializeFixture({
        contract, pr: Number(pr), cacheDir, srcRepo, repoRoot,
      });
      process.stdout.write(`${report.path}\n${report.head}\n`);
    })().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
  ' "$CONTRACT" "$pr" "$CACHE_DIR" "$REPO" "$SPEC")" || return 1
  head="${built##*$'\n'}"
  built="${built%%$'\n'*}"
  if [[ -z $built || ! $head =~ ^[0-9a-f]{40}$ ]]; then
    printf 'FATAL: fixture for PR %s reported no pinned head\n' "$pr" >&2
    return 1
  fi
  FIXTURE_PRS+=("$pr")
  FIXTURE_PATHS+=("$built")
  FIXTURE_HEADS+=("$head")
  FIXTURE_PATH="$built"
  FIXTURE_HEAD="$head"
}

# Return one fixture to the commit the contract pins, before every cell.
#
# Cells share one fixture per PR and run with bypassPermissions and a real Bash
# tool, so the tree has to be restored between them. An argument-free
# `git reset --hard` restores whatever `HEAD` names now, which is the one thing
# a contestant can move: committing its own edits — or a prompt-injected commit
# from the diff under review — makes that commit the fixture. Every later cell
# for the PR then reviews the contestant's tree, and so does the novelty judge
# and the pre-judge login snapshot, which is how a corrupted condition score
# becomes the run of record. The reset names the pinned commit, and `HEAD` is
# read back afterwards so a reset that did not land fails the cell instead.
reset_fixture() {
  local fixture="$1" head="$2"
  git -C "$fixture" checkout --quiet --force --detach "$head" &&
    git -C "$fixture" reset --hard --quiet "$head" &&
    git -C "$fixture" clean -xdffq &&
    [[ "$(git -C "$fixture" rev-parse --verify --quiet HEAD)" == "$head" ]]
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

# --- the resume cache --------------------------------------------------------

# Cells are what a run pays for, and the plan hands this execution its own
# detail directory as soon as a ledger row records the previous one. That older
# directory still holds paid cells, so they are copied in once — and then
# re-checked one at a time against this run's fingerprint, exactly as a cell
# found in place is, so a cell produced under an edited skill, contract,
# orchestrator or CLI is refused and re-run. Nothing is copied over cells this
# run already has.
RESUME_FROM="$(json_field "$PLAN_OUT" resume_from)"
case "$RESUME_FROM" in
  "" | undefined | null) RESUME_FROM="" ;;
  *) require_safe_detail "$RESUME_FROM" ;;
esac
if [[ -n $RESUME_FROM && -d "$REPO/$RESUME_FROM/cells" && ! -d "$RUN_DIR/cells" ]]; then
  mkdir -p "$RUN_DIR"
  if cp -R "$REPO/$RESUME_FROM/cells" "$RUN_DIR/cells"; then
    log "seeded the resume cache from $RESUME_FROM"
  else
    rm -rf "${RUN_DIR:?}/cells"
    log "could not seed the resume cache from $RESUME_FROM; every cell re-runs"
  fi
fi

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

  local fixture fixture_head
  fixture_path "$pr" || {
    log "  $cell_id FAILED — fixture"
    return 1
  }
  fixture="$FIXTURE_PATH"
  fixture_head="$FIXTURE_HEAD"

  local started other_review="" codex_chars=0
  started="$(date +%s)"
  purge_skill "$fixture"
  # Without this a cell reviews the previous cell's edits, and control reviews
  # a mutated tree. The pinned commit is named rather than implied; see
  # `reset_fixture`.
  if ! reset_fixture "$fixture" "$fixture_head"; then
    log "  $cell_id FAILED — the fixture could not be reset to $fixture_head"
    return 1
  fi

  if [[ $condition == "pipeline" ]]; then
    if [[ ${#FINDER_ARGV[@]} -eq 0 ]]; then
      log "  $cell_id FAILED — the plan carries no finder argv"
      return 1
    fi
    # The finder writes to a file rather than into a pipeline so the run
    # deadline can bound it: a stalled finder inside a command substitution
    # never returns, and the between-cells deadline check never runs again.
    # A finder that hits its session limit or dies mid-report still writes what
    # it had, and that partial report is not a review: cached, it would score
    # forever as a finder that simply missed those defects. Fail the cell on an
    # unsuccessful exit, on the deadline, or on an empty report.
    local finder_out finder_status=0
    finder_out="$(mktemp "$TMPROOT/review-eval-finder.XXXXXX")"
    run_bounded "$finder_out" "$(remaining_seconds "$MATRIX_DEADLINE")" \
      run_in_fixture "$fixture" "${FINDER_ARGV[@]}" || finder_status=$?
    other_review="$(tail -c 30000 "$finder_out")"
    if [[ $finder_status -eq 124 ]]; then
      log "  $cell_id FAILED — the finder hit the run deadline; not cached"
      log_stderr_tail "$finder_out.err"
      rm -f "$finder_out" "$finder_out.err"
      return 1
    fi
    if [[ $finder_status -ne 0 ]]; then
      log "  $cell_id FAILED — the finder exited $finder_status; not cached"
      log_stderr_tail "$finder_out.err"
      rm -f "$finder_out" "$finder_out.err"
      return 1
    fi
    if [[ -z ${other_review//[[:space:]]/} ]]; then
      log "  $cell_id FAILED — the finder produced nothing; not cached"
      log_stderr_tail "$finder_out.err"
      rm -f "$finder_out" "$finder_out.err"
      return 1
    fi
    rm -f "$finder_out" "$finder_out.err"
  elif [[ $condition == "replay" ]]; then
    # The frozen report is the whole treatment for this condition. Reading it
    # is verified once by --check-fixtures, but the spec worktree is the live
    # checkout under --skill-ref and a candidate run can outlive the branch it
    # was planned on. An unreadable or empty report here would hand the model
    # an empty handoff and score that as a review of the change.
    if ! other_review="$(cat "$SPEC/$finder_report")" ||
      [[ -z ${other_review//[[:space:]]/} ]]; then
      log "  $cell_id FAILED — frozen finder report $finder_report is unreadable or empty; not cached"
      return 1
    fi
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
    local preamble
    if ! preamble="$(stage_skill "$fixture")"; then
      log "  $cell_id FAILED — the skill did not stage into the fixture; not cached"
      purge_skill "$fixture"
      return 1
    fi
    claude_args+=(--append-system-prompt "$preamble")
  fi

  local raw other_file claude_status=0
  raw="$(mktemp "$TMPROOT/review-eval-cell.XXXXXX")"
  other_file="$(mktemp "$TMPROOT/review-eval-other.XXXXXX")"
  printf '%s' "$other_review" >"$other_file"
  # Bounded by what is left of the matrix budget for the same reason the finder
  # is: a contestant that stalls at a session limit would otherwise hold the
  # whole run open past the deadline it advertises.
  run_bounded "$raw" "$(remaining_seconds "$MATRIX_DEADLINE")" \
    run_in_fixture "$fixture" claude "${claude_args[@]}" || claude_status=$?
  if [[ $claude_status -ne 0 ]]; then
    purge_skill "$fixture"
    if [[ $claude_status -eq 124 ]]; then
      log "  $cell_id FAILED — claude hit the run deadline; not cached"
    else
      log "  $cell_id FAILED — claude exited $claude_status; not cached"
    fi
    log_stderr_tail "$raw.err"
    rm -f "$raw" "$raw.err" "$other_file"
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
    log "  $cell_id FAILED — claude reported an error; not cached"
    log_stderr_tail "$raw.err"
    rm -f "$raw" "$raw.err" "$other_file"
    return 1
  fi
  rm -f "$raw" "$raw.err" "$other_file"
  log "  $cell_id ok $(($(date +%s) - started))s"
  return 0
}

# --- the matrix --------------------------------------------------------------

# One tab-separated line per planned cell, in plan order. Every field comes
# from the contract, so a tab or a newline in one of them would forge extra
# rows in the reader below: such a field aborts the run instead.
#
# The whole matrix is built before a single line is written. Writing as it goes
# would emit every cell up to the offending one, and the reader below cannot
# see that the writer died: the run would spend money on a truncated matrix and
# then score it as merely partial, which is exactly what the check is for.
cell_rows() {
  # shellcheck disable=SC2016  # the single-quoted block is node source
  node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const lines = [];
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
      lines.push(fields.join("\t") + "\n");
    }
    process.stdout.write(lines.join(""));
  ' "$PLAN_JSON"
}
# RUN-EVAL-ORIGINAL-END cell-runtime

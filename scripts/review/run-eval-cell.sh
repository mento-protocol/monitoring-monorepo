#!/usr/bin/env bash
# One review-eval cell, phase by phase, for run-eval.sh.
# This file is sourced after run-eval-runtime.sh, whose fixture, skill and
# cache helpers every phase calls. Do not execute it directly.
#
# Reads: RUN_DIR, SPEC, CELL_WRITER, CELL_ENV, CODEX_ENV, FINDER_ARGV,
# FINGERPRINT_JSON, CLAUDE_TOOLS, CELL_STREAM_MAX_BYTES, MATRIX_DEADLINE,
# TMPROOT. It writes no global.
#
# `run_cell` declares every variable the phases share — `fixture`,
# `fixture_head`, `started`, `other_review`, `codex_chars`, `prompt`, `raw`,
# `other_file`, `last_message`, `claude_status`, `envelope_status`, `out_dir`
# and `cell_status` — `local` once, and the phases assign into them through
# dynamic scoping. A phase whose body runs a command with errexit live is
# called bare and reports through `cell_status`, never as `phase || return 1`,
# because the conditional form suspends errexit inside the callee.
#
# `run_stream_capped` stays in run-eval-lifecycle.sh: it arms `trap … TERM INT`
# and `set -m` in the shell that launches the model, and the trap has to be
# armed there.

# Reuse the cached cell when its fingerprint matches this run. Returns 0 when
# the cell was reused and `run_cell` is done, 1 when the cell must run.
cell_reuse_cached() {
  local refusal
  [[ -f "$out_dir/result.json" ]] || return 1
  if refusal="$(cell_reuse_refusal "$out_dir/result.json")"; then
    log "  $cell_id not reused — $refusal; re-running"
    rm -rf "$out_dir"
    return 1
  fi
  log "  $cell_id reused"
}

cell_preflight_writer() {
  # `--preflight` imports the writer before the paid call, so a load fault is free.
  if ! node "$CELL_WRITER" --preflight; then
    log "  $cell_id FAILED — harness fault before any cost; $CELL_WRITER did not load"
    return 1
  fi
}

cell_prepare_fixture() {
  if ! fixture_path "$pr"; then
    log "  $cell_id FAILED — fixture"
    cell_status=1
    return 0
  fi
  fixture="$FIXTURE_PATH"
  # shellcheck disable=SC2153 # FIXTURE_HEAD is set by fixture_path, not a typo
  fixture_head="$FIXTURE_HEAD"
  started="$(date +%s)"
  purge_skill "$fixture"
  # Without this a cell reviews the previous cell's edits, and control reviews
  # a mutated tree. The pinned commit is named rather than implied; see
  # `reset_fixture`.
  if ! reset_fixture "$fixture" "$fixture_head"; then
    log "  $cell_id FAILED — the fixture could not be reset to $fixture_head"
    cell_status=1
  fi
  return 0
}

cell_run_finder() {
  if [[ ${#FINDER_ARGV[@]} -eq 0 ]]; then
    log "  $cell_id FAILED — the plan carries no finder argv"
    cell_status=1
    return 0
  fi
  # The finder writes to a file so the run deadline can bound it (a stalled
  # finder inside a command substitution never returns). A finder that hits
  # its session limit still writes a partial report, which is not a review:
  # cached, it would score forever. Fail on a bad exit, the deadline, or empty.
  local finder_out finder_status=0
  finder_out="$(mktemp "$TMPROOT/review-eval-finder.XXXXXX")"
  run_bounded "$finder_out" "$(remaining_seconds "$MATRIX_DEADLINE")" \
    run_in_fixture "$fixture" "${CODEX_ENV[@]}" "${FINDER_ARGV[@]}" || finder_status=$?
  other_review="$(tail -c 30000 "$finder_out")"
  if [[ $finder_status -eq 124 ]]; then
    log "  $cell_id FAILED — the finder hit the run deadline; not cached"
    log_stderr_tail "$finder_out.err"
    rm -f "$finder_out" "$finder_out.err"
    cell_status=1
    return 0
  fi
  if [[ $finder_status -ne 0 ]]; then
    log "  $cell_id FAILED — the finder exited $finder_status; not cached"
    log_stderr_tail "$finder_out.err"
    rm -f "$finder_out" "$finder_out.err"
    cell_status=1
    return 0
  fi
  if [[ -z ${other_review//[[:space:]]/} ]]; then
    log "  $cell_id FAILED — the finder produced nothing; not cached"
    log_stderr_tail "$finder_out.err"
    rm -f "$finder_out" "$finder_out.err"
    cell_status=1
    return 0
  fi
  rm -f "$finder_out" "$finder_out.err"
}

cell_read_frozen_report() {
  # The frozen report is the whole treatment for this condition. Reading it
  # is verified once by --check-fixtures, but under --skill-ref the spec
  # worktree is the live checkout and a candidate run can outlive the branch
  # it was planned on. An unreadable or empty report here would hand the
  # model an empty handoff and score that as a review of the change.
  if ! other_review="$(cat "$SPEC/$finder_report")" ||
    [[ -z ${other_review//[[:space:]]/} ]]; then
    log "  $cell_id FAILED — frozen finder report $finder_report is unreadable or empty; not cached"
    return 1
  fi
}

cell_build_prompt() {
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
}

cell_run_codex() {
  # Codex verifier: bare model, same prompt, no skill or user config, read-only.
  last_message="$(mktemp "$TMPROOT/review-eval-last.XXXXXX")"
  run_bounded "$raw" "$(remaining_seconds "$MATRIX_DEADLINE")" \
    run_stream_capped "$CELL_STREAM_MAX_BYTES" "$fixture" \
    "${CODEX_ENV[@]}" codex exec \
    --sandbox read-only --skip-git-repo-check --ephemeral \
    --ignore-user-config --ignore-rules -m "$model" \
    -c "model_reasoning_effort=\"$effort\"" \
    --json -o "$last_message" "$prompt" || claude_status=$?
  if [[ $(wc -c <"$raw" | tr -d " ") -gt $CELL_STREAM_MAX_BYTES ]]; then
    claude_status=25
  fi
}

cell_run_claude() {
  # `stream-json`: a cell is scored on every message it wrote, not the last.
  local -a claude_args=(-p "$prompt" --model "$model" --effort "$effort"
    --setting-sources "" --output-format stream-json --verbose
    --permission-mode bypassPermissions
    --allowed-tools "${CLAUDE_TOOLS[@]}" --max-turns 80)
  if [[ $condition != "control" ]]; then
    local preamble
    if ! preamble="$(stage_skill "$fixture")"; then
      log "  $cell_id FAILED — the skill did not stage into the fixture; not cached"
      purge_skill "$fixture"
      rm -f "$raw" "$other_file"
      cell_status=1
      return 0
    fi
    claude_args+=(--append-system-prompt "$preamble")
  fi
  run_bounded "$raw" "$(remaining_seconds "$MATRIX_DEADLINE")" \
    run_capped_in_fixture "$fixture" claude "${claude_args[@]}" || claude_status=$?
}

# The contestant call and the failure path both cells share. The scratch files
# are created here so the failure path that removes them is beside them.
cell_run_model() {
  raw="$(mktemp "$TMPROOT/review-eval-cell.XXXXXX")"
  other_file="$(mktemp "$TMPROOT/review-eval-other.XXXXXX")"
  printf '%s' "$other_review" >"$other_file"
  # Bounded by the rest of the matrix budget, as the finder is: a stalled
  # contestant would hold the run past its advertised deadline.
  if [[ $tool == codex ]]; then
    cell_run_codex
  else
    cell_run_claude
  fi
  if [[ $claude_status -ne 0 ]]; then
    purge_skill "$fixture"
    if [[ $claude_status -eq 124 ]]; then
      log "  $cell_id FAILED — $tool hit the run deadline; not cached"
    else
      log "  $cell_id FAILED — $tool exited $claude_status; not cached"
    fi
    log_stderr_tail "$raw.err"
    rm -f "$raw" "$raw.err" "$other_file" ${last_message:+"$last_message"}
    cell_status=1
  fi
  return 0
}

cell_write_result() {
  mkdir -p "$out_dir"
  REVIEW_EVAL_CELL="$cell_id" REVIEW_EVAL_PR="$pr" \
    REVIEW_EVAL_CONDITION="$condition" REVIEW_EVAL_DRAW="$draw" \
    REVIEW_EVAL_MODEL="$model" REVIEW_EVAL_EFFORT="$effort" \
    REVIEW_EVAL_TOOL="$tool" REVIEW_EVAL_LAST_MESSAGE="$last_message" \
    REVIEW_EVAL_FINDER="$finder" REVIEW_EVAL_FIXTURE="$fixture" \
    REVIEW_EVAL_SECONDS="$(($(date +%s) - started))" \
    REVIEW_EVAL_FINDER_CHARS="$codex_chars" \
    REVIEW_EVAL_FINGERPRINT="$FINGERPRINT_JSON" \
    node "$CELL_WRITER" "$raw" "$other_file" "$out_dir/result.json" ||
    envelope_status=$?
  if [[ $envelope_status -ne 0 ]]; then
    log_stderr_tail "$raw.err"
    if [[ $envelope_status -eq 4 ]]; then
      # Exit 4 is the harness failing to load its own stream parser: nothing the
      # cell did, so its directory survives and the paid stream moves into it
      # rather than being deleted. Re-running the cell is the retry.
      mv "$raw" "$out_dir/stream.jsonl" || true
      mv "$raw.err" "$out_dir/stream.err" || true
      log "  $cell_id FAILED — harness fault, cell kept with its stream; the stream parser did not load"
    else
      rm -rf "$out_dir"
      log "  $cell_id FAILED — $tool reported an error; not cached"
    fi
  fi
  rm -f "$raw" "$raw.err" "$other_file" ${last_message:+"$last_message"}
  return 0
}

run_cell() {
  local cell_id="$1" pr="$2" condition="$3" draw="$4" model="$5" effort="$6"
  local finder="$7" finder_report="$8" prompt_kind="$9"
  local tool="${10:-claude}"
  # Only a probe plans a tool; the `else` below would run claude for any other.
  if [[ $tool != claude && $tool != codex ]]; then
    log "  $cell_id FAILED — unknown cell tool $tool; not cached"
    return 1
  fi
  local out_dir="$RUN_DIR/cells/$cell_id"
  local fixture fixture_head started other_review="" codex_chars=0
  local prompt raw other_file last_message="" claude_status=0 envelope_status=0
  local cell_status=0
  if cell_reuse_cached; then
    return 0
  fi
  if ! cell_preflight_writer; then
    return 1
  fi
  cell_prepare_fixture
  ((cell_status == 0)) || return 1
  if [[ $condition == "pipeline" ]]; then
    cell_run_finder
    ((cell_status == 0)) || return 1
  elif [[ $condition == "replay" ]]; then
    cell_read_frozen_report || return 1
  fi
  codex_chars="${#other_review}"
  cell_build_prompt
  cell_run_model
  ((cell_status == 0)) || return 1
  purge_skill "$fixture"
  cell_write_result
  ((envelope_status == 0)) || return 1
  log "  $cell_id ok $(($(date +%s) - started))s"
  return 0
}

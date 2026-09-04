#!/usr/bin/env bash
# Authenticate, seal, and remove the private run-eval source snapshot. The
# wrapper sources only a private copy. That copy snapshots the other sources,
# creates the owner marker, and restarts the wrapper.

run_eval_physical_dir() {
  (unset CDPATH; cd -P "$1" 2>/dev/null && pwd -P)
}

run_eval_source_snapshot_path_valid() {
  local snapshot="$RUN_EVAL_SOURCE_SNAPSHOT"
  local snapshot_name snapshot_parent physical_parent physical_snapshot
  [[ $snapshot == /* && -d $snapshot && ! -L $snapshot ]] || return 1
  snapshot_name="${snapshot##*/}"
  snapshot_parent="${snapshot%/*}"
  [[ -n $snapshot_parent ]] || snapshot_parent="/"
  [[ $snapshot_name =~ ^review-eval-source\.[[:alnum:]]{6}$ ]] || return 1
  physical_parent="$(run_eval_physical_dir "$snapshot_parent")" || return 1
  physical_snapshot="$(run_eval_physical_dir "$snapshot")" || return 1
  [[ $snapshot_parent == "$physical_parent" &&
    $snapshot == "$physical_snapshot" &&
    ${physical_snapshot%/*} == "$physical_parent" ]]
}

run_eval_source_snapshot_authentic() {
  local marker marker_pid marker_nonce
  [[ $RUN_EVAL_SOURCE_NONCE =~ ^[[:alnum:]]{12}$ ]] || return 1
  run_eval_source_snapshot_path_valid || return 1
  marker="$RUN_EVAL_SOURCE_SNAPSHOT/.review-eval-owner.$RUN_EVAL_SOURCE_NONCE"
  [[ -f $marker && ! -L $marker ]] || return 1
  IFS=$'\t' read -r marker_pid marker_nonce <"$marker" || return 1
  [[ $marker_pid == "$$" && $marker_nonce == "$RUN_EVAL_SOURCE_NONCE" ]] ||
    return 1
  [[ $RUN_EVAL_CREATED_SOURCE_SNAPSHOT -eq 1 ||
    $RUN_EVAL_ENTRY_SOURCE == "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval.sh" ]]
}

# shellcheck disable=SC2329  # invoked by the EXIT-trap wrapper below
cleanup_source_snapshot() {
  local source_path
  local source_paths=(
    "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval.sh"
    "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval-source-snapshot.sh"
    "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval-lifecycle.sh"
    "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval-runtime.sh"
    "$RUN_EVAL_SOURCE_SNAPSHOT/review-eval-cell-writer.mjs"
    "$RUN_EVAL_SOURCE_SNAPSHOT/review-eval-stream.mjs"
  )
  [[ $RUN_EVAL_SOURCE_OWNED -eq 1 ]] || return 0
  if [[ $RUN_EVAL_CREATED_SOURCE_SNAPSHOT -eq 1 ]]; then
    run_eval_source_snapshot_path_valid || return 1
  else
    run_eval_source_snapshot_authentic || return 1
  fi
  if [[ $RUN_EVAL_SOURCE_NONCE =~ ^[[:alnum:]]{12}$ ]]; then
    source_paths+=(
      "$RUN_EVAL_SOURCE_SNAPSHOT/.review-eval-owner.$RUN_EVAL_SOURCE_NONCE"
    )
  fi
  for source_path in "${source_paths[@]}"; do
    if [[ -e $source_path || -L $source_path ]]; then
      [[ -f $source_path && ! -L $source_path ]] || return 1
    fi
  done
  chmod 0700 "$RUN_EVAL_SOURCE_SNAPSHOT" || return 1
  rm -f -- "${source_paths[@]}" || return 1
  rmdir -- "$RUN_EVAL_SOURCE_SNAPSHOT" || return 1
  RUN_EVAL_SOURCE_OWNED=0
}

# shellcheck disable=SC2329  # invoked by the EXIT trap below
cleanup_with_source_snapshot() {
  local code=$?
  if declare -F cleanup >/dev/null 2>&1; then
    cleanup || true
  fi
  cleanup_source_snapshot || true
  return "$code"
}

run_eval_source_snapshot_arm() {
  run_eval_source_snapshot_authentic || return 1
  RUN_EVAL_SOURCE_OWNED=1
  trap cleanup_with_source_snapshot EXIT
}

run_eval_source_snapshot_accept() {
  local lock_root="$1"
  local live_dir="$2"
  local source_name source_path
  [[ -n $RUN_EVAL_SOURCE_SNAPSHOT && -n $RUN_EVAL_SOURCE_NONCE &&
    $RUN_EVAL_SOURCE_OWNED -eq 1 ]] || return 1
  run_eval_source_snapshot_authentic || return 1
  [[ ${RUN_EVAL_SOURCE_SNAPSHOT%/*} == "$lock_root" &&
    $live_dir == "$RUN_EVAL_SOURCE_SNAPSHOT" &&
    ! -w $RUN_EVAL_SOURCE_SNAPSHOT ]] || return 1
  for source_name in \
    run-eval.sh run-eval-source-snapshot.sh \
    run-eval-lifecycle.sh run-eval-runtime.sh \
    review-eval-cell-writer.mjs review-eval-stream.mjs; do
    source_path="$RUN_EVAL_SOURCE_SNAPSHOT/$source_name"
    [[ -f $source_path && ! -L $source_path && ! -w $source_path ]] || return 1
  done
  [[ ! -w $RUN_EVAL_SOURCE_SNAPSHOT/.review-eval-owner.$RUN_EVAL_SOURCE_NONCE ]]
}

run_eval_source_snapshot_fail() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 1
}

run_eval_source_snapshot_restart() {
  local repo live_dir source_name live_source source_path marker exec_status
  [[ $# -ge 2 ]] || run_eval_source_snapshot_fail "the source restart requires a repository and live source directory"
  repo="$1"
  live_dir="$2"
  shift 2
  RUN_EVAL_SOURCE_SNAPSHOT="$(run_eval_physical_dir "$(dirname "${BASH_SOURCE[0]}")")" ||
    run_eval_source_snapshot_fail "could not resolve the orchestrator snapshot"
  RUN_EVAL_SOURCE_NONCE=""
  RUN_EVAL_ENTRY_SOURCE="${BASH_SOURCE[0]}"
  RUN_EVAL_CREATED_SOURCE_SNAPSHOT=1
  RUN_EVAL_SOURCE_OWNED=1
  trap cleanup_with_source_snapshot EXIT
  run_eval_source_snapshot_path_valid ||
    run_eval_source_snapshot_fail "the new orchestrator snapshot path is invalid"
  [[ $live_dir == "$(run_eval_physical_dir "$live_dir")" ]] ||
    run_eval_source_snapshot_fail "the live orchestrator source directory is not physical"
  # The two node modules travel with the shell: the cell writer and the stream
  # parser it imports decide what a paid cell records, and the wrapper loads
  # them from this snapshot rather than from the live checkout, which a run can
  # outlive. `verify_plan` below digests all six against the persistent plan.
  for source_name in \
    run-eval.sh run-eval-lifecycle.sh run-eval-runtime.sh \
    review-eval-cell-writer.mjs review-eval-stream.mjs; do
    live_source="$live_dir/$source_name"
    source_path="$RUN_EVAL_SOURCE_SNAPSHOT/$source_name"
    [[ -f $live_source && ! -L $live_source ]] ||
      run_eval_source_snapshot_fail "orchestrator source $live_source is not a regular file"
    cp "$live_source" "$source_path" ||
      run_eval_source_snapshot_fail "could not snapshot orchestrator source $live_source"
    chmod 0400 "$source_path" ||
      run_eval_source_snapshot_fail "could not protect orchestrator source $source_path"
  done
  chmod 0500 "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval.sh" ||
    run_eval_source_snapshot_fail "could not make the orchestrator wrapper executable"
  marker="$(mktemp "$RUN_EVAL_SOURCE_SNAPSHOT/.review-eval-owner.XXXXXXXXXXXX")" ||
    run_eval_source_snapshot_fail "could not create the orchestrator snapshot owner marker"
  RUN_EVAL_SOURCE_NONCE="${marker##*.review-eval-owner.}"
  printf '%s\t%s\n' "$$" "$RUN_EVAL_SOURCE_NONCE" >"$marker" ||
    run_eval_source_snapshot_fail "could not bind the orchestrator snapshot owner marker"
  chmod 0400 "$marker" ||
    run_eval_source_snapshot_fail "could not protect the orchestrator snapshot owner marker"
  run_eval_source_snapshot_arm ||
    run_eval_source_snapshot_fail "could not authenticate the new orchestrator snapshot"
  chmod 0500 "$RUN_EVAL_SOURCE_SNAPSHOT" ||
    run_eval_source_snapshot_fail "could not seal the orchestrator snapshot directory"
  run_eval_source_snapshot_accept "${RUN_EVAL_SOURCE_SNAPSHOT%/*}" "$RUN_EVAL_SOURCE_SNAPSHOT" ||
    run_eval_source_snapshot_fail "could not verify the sealed orchestrator snapshot"
  export RUN_EVAL_SOURCE_SNAPSHOT RUN_EVAL_SOURCE_NONCE
  shopt -s execfail
  set +e
  exec "$RUN_EVAL_SOURCE_SNAPSHOT/run-eval.sh" "$@" --repo "$repo"
  exec_status=$?
  set -e
  run_eval_source_snapshot_fail \
    "could not restart from the immutable orchestrator snapshot (status $exec_status)"
}

run_eval_source_snapshot_verify_plan() {
  local plan_json="$1"
  local script_dir="$2"
  local planned_digest snapshot_digest
  planned_digest="$(node -e '
    const plan = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(plan.inputs.orchestrator_digest));
  ' "$plan_json")" || run_eval_source_snapshot_fail "the plan carries no orchestrator digest"
  snapshot_digest="$(node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const { basename } = require("node:path");
    const hash = createHash("sha256");
    const updateFramed = (value) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(length);
      hash.update(bytes);
    };
    updateFramed("review-skill-eval/orchestrator/v2");
    for (const file of process.argv.slice(1)) {
      updateFramed(basename(file));
      updateFramed(readFileSync(file));
    }
    process.stdout.write(hash.digest("hex"));
  ' \
    "$script_dir/run-eval.sh" \
    "$script_dir/run-eval-source-snapshot.sh" \
    "$script_dir/run-eval-lifecycle.sh" \
    "$script_dir/run-eval-runtime.sh" \
    "$script_dir/review-eval-cell-writer.mjs" \
    "$script_dir/review-eval-stream.mjs")" ||
    run_eval_source_snapshot_fail "could not digest the immutable orchestrator snapshot"
  [[ $snapshot_digest == "$planned_digest" ]] ||
    run_eval_source_snapshot_fail "the immutable orchestrator snapshot differs from the persistent plan; restart after the checkout stops changing"
}

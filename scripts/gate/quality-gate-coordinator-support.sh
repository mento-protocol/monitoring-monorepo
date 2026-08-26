# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2154
# Fingerprint, protocol identity, logging, and CLI support for the sourced
# quality-gate coordinator adapter. The caller owns shell options.

gate_coordinator_runtime_signature() {
  node "$gate_coordinator_entry" source-signature
}

gate_coordinator_node_policy_hash() {
  node "$gate_coordinator_entry" node-policy-hash
}

gate_coordinator_node_runtime_hash() {
  node "$gate_coordinator_entry" runtime-hash
}

gate_coordinator_effective_policy_hash() {
  local loaded_main_hash="${gate_coordinator_loaded_adapter_main_hash:-}"
  local loaded_support_hash="${gate_coordinator_loaded_adapter_support_hash:-}"
  local arguments=(policy-hash --capacity "$gate_coordinator_capacity")
  if [[ -n "$loaded_main_hash" || -n "$loaded_support_hash" ]]; then
    [[ "$loaded_main_hash" =~ ^[a-f0-9]{64}$ &&
      "$loaded_support_hash" =~ ^[a-f0-9]{64}$ ]] || {
      echo "error: loaded coordinator adapter identity is malformed." >&2
      return 2
    }
    arguments+=(
      --loaded-adapter-main-hash "$loaded_main_hash"
      --loaded-adapter-support-hash "$loaded_support_hash"
    )
  fi
  node "$gate_coordinator_entry" "${arguments[@]}"
}

gate_coordinator_assert_prepared_policy_current() {
  local current_policy
  current_policy="$(gate_coordinator_effective_policy_hash)" || {
    echo "error: could not recompute the coordinator policy after legacy-lock acquisition." >&2
    return 2
  }
  if [[ "$current_policy" != "$gate_coordinator_policy_hash" ]]; then
    echo "error: coordinator runtime or policy inputs changed while this gate waited." >&2
    echo "No coordinator or mapped command started. Re-run the gate." >&2
    return 2
  fi
}

gate_coordinator_material_env_digest() {
  local physical_repo_root="${1:-${repo_root:-}}" environment_helper
  [[ -n "$physical_repo_root" ]] || {
    echo "error: material environment hashing requires a repository root." >&2
    return 2
  }
  physical_repo_root="$(cd "$physical_repo_root" 2>/dev/null && pwd -P)" || return 2
  environment_helper="${script_source_dir:-}/gate/quality-gate-coordinator-environment.mjs"
  [[ -r "$environment_helper" ]] || {
    echo "error: material environment helper is missing: ${environment_helper}" >&2
    return 2
  }
  node "$environment_helper" "$physical_repo_root"
}

gate_coordinator_assert_scrub_policy_current() {
  local current_scrub_policy environment_helper
  environment_helper="${script_source_dir:-}/gate/quality-gate-coordinator-environment.mjs"
  [[ -r "$environment_helper" ]] || return 2
  current_scrub_policy="$(
    node "$environment_helper" --mapped-child-scrub-policy-digest
  )" || return 2
  [[ "$current_scrub_policy" =~ ^[a-f0-9]{64}$ ]] || return 2
  [[ "$current_scrub_policy" == \
    "${gate_mapped_child_scrub_policy_hash:-}" ]] || {
    echo "error: mapped-child environment policy changed after launcher preparation." >&2
    return 2
  }
}

gate_coordinator_current_changed_paths_hash() {
  collect_current_changed_paths |
    sed '/^$/d' | LC_ALL=C sort -u | hash_stream
}

gate_coordinator_repository_identity() {
  local common_dir
  common_dir="$(git rev-parse --git-common-dir)" || return 1
  case "$common_dir" in
    /*) ;;
    *) common_dir="$repo_root/$common_dir" ;;
  esac
  (cd "$common_dir" 2>/dev/null && pwd -P) | hash_stream
}

gate_coordinator_socket_path_is_supported() {
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const module = await import(pathToFileURL(process.argv[2]).href);
    try {
      module.socketPathForRoot(process.argv[3]);
    } catch (error) {
      if (error?.code === "SOCKET_PATH_TOO_LONG") process.exit(42);
      process.stderr.write(`${error?.message ?? String(error)}\n`);
      process.exit(2);
    }
  ' quality-gate-socket-check "$gate_coordinator_entry" "$gate_coordinator_root"
}

gate_coordinator_recompute_fingerprint() {
  local fresh_plan fresh_plan_hash fresh_base fresh_head fresh_paths
  local fresh_implementation fresh_content os_name os_arch node_path node_version
  local pnpm_path pnpm_version env_digest policy_hash runtime_hash repository_identity
  [[ "${gate_mapped_child_scrub_policy_hash:-}" =~ ^[a-f0-9]{64}$ ]] || return 1
  gate_coordinator_assert_scrub_policy_current || return 1
  fresh_plan="$(mktemp "$scratch_dir/coordinator-plan.XXXXXX")" || return 1
  if ! write_command_plan "$fresh_plan"; then
    rm -f "$fresh_plan"
    return 1
  fi
  fresh_plan_hash="$(hash_file "$fresh_plan")" || {
    rm -f "$fresh_plan"
    return 1
  }
  rm -f "$fresh_plan"
  fresh_base="$(ref_oid "$base_ref")" || return 1
  fresh_head="$(ref_oid "$head_ref")" || return 1
  fresh_paths="$(gate_coordinator_current_changed_paths_hash)" || return 1
  fresh_implementation="$(implementation_hash_value)" || return 1
  fresh_content="$(validation_content_signature)" || return 1
  os_name="$(uname -s)" || return 1
  os_arch="$(uname -m)" || return 1
  node_path="$(command -v node)" || return 1
  node_version="$(node --version 2>/dev/null)" || return 1
  pnpm_path="$(command -v pnpm)" || return 1
  pnpm_version="$(pnpm --version 2>/dev/null)" || return 1
  env_digest="$(gate_coordinator_material_env_digest)" || return 1
  policy_hash="$(gate_coordinator_effective_policy_hash)" || return 1
  runtime_hash="$(gate_coordinator_runtime_signature)" || return 1
  repository_identity="$(gate_coordinator_repository_identity)" || return 1
  printf '%s\n' \
    "schema=v2" "repository=${repository_identity}" \
    "base=${fresh_base}" "head=${fresh_head}" "paths=${fresh_paths}" \
    "plan=${fresh_plan_hash}" "implementation=${fresh_implementation}" \
    "content=${fresh_content}" "packageRisk=${package_script_risk_changed}" \
    "allowPackageScripts=${stamp_allow_package_scripts}" \
    "commandTimeout=${command_timeout_seconds}" \
    "gateSelftestTimeout=${gate_selftest_timeout_seconds}" \
    "gateLockWait=${gate_lock_wait_seconds}" \
    "qualityParallelism=${quality_parallelism}" "failFast=${fail_fast}" \
    "os=${os_name}" "arch=${os_arch}" "nodePath=${node_path}" \
    "node=${node_version}" "pnpmPath=${pnpm_path}" \
    "pnpm=${pnpm_version}" "policy=${policy_hash}" \
    "runtime=${runtime_hash}" "environment=${env_digest}" \
    "mappedChildScrubPolicy=${gate_mapped_child_scrub_policy_hash}" |
    hash_stream
}

gate_coordinator_prepare_registration_fingerprint() {
  local root socket_status token_hash user_id
  [[ -f "$gate_coordinator_entry" ]] || {
    echo "error: quality-gate coordinator runtime is missing: ${gate_coordinator_entry}" >&2
    return 2
  }
  root="$(resolve_gate_lock_root)" || {
    echo "error: no writable quality-gate lock root is available." >&2
    return 2
  }
  gate_lock_root_dir="$root"
  gate_coordinator_policy_hash="$(gate_coordinator_effective_policy_hash)" || return 2
  user_id="$(id -u)" || return 2
  [[ "$user_id" =~ ^[0-9]+$ ]] || return 2
  # An explicit legacy lock root can be shared across users. Each user needs a
  # private coordinator namespace while run.lock remains the cross-user barrier.
  gate_coordinator_root="${root}/qgc-v1-u${user_id}"
  if gate_coordinator_socket_path_is_supported; then
    :
  else
    socket_status=$?
    if [[ "$socket_status" -eq 42 ]]; then
      echo "warning: the quality-gate coordinator socket path is too long; this run uses the serialized legacy lock." >&2
      # The coordinator request token was created before this preflight. Legacy
      # recovery needs the run token, lock owner token, and holder marker to be
      # identical, so let the legacy claim create one shared token.
      gate_run_id=""
      gate_coordinator_enabled=0
      return 0
    fi
    echo "error: the quality-gate coordinator socket path could not be validated." >&2
    return 2
  fi
  gate_coordinator_owner_pid="$$"
  gate_coordinator_owner_subshell="${BASH_SUBSHELL:-0}"
  gate_coordinator_owner_start="$(gate_lock_process_start "$$")"
  if [[ -z "$gate_coordinator_owner_start" ]]; then
    echo "error: cannot read the gate process start identity; coordinator registration is unsafe." >&2
    return 2
  fi
  gate_coordinator_request_capability="$(node -e '
    process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"));
  ')" || return 2
  if [[ ! "$gate_coordinator_request_capability" =~ ^[a-f0-9]{64}$ ]]; then
    echo "error: could not create a quality-gate request capability." >&2
    return 2
  fi
  token_hash="$(printf '%s' "$gate_run_id" | hash_stream)" || return 2
  gate_coordinator_request_id="req-$$-$(date +%s)-${token_hash:0:12}"
  gate_coordinator_registration_fingerprint="$(gate_coordinator_recompute_fingerprint)" || {
    echo "error: could not compute the shared quality-gate execution fingerprint." >&2
    return 2
  }
  exec 7>&1
}

gate_coordinator_log_duration() {
  local status="$1" seconds="$2" command="$3" line_mode="$4" ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 0
  node -e '
    const [ts, command, status, seconds, mode, requestId, sequence, role] = process.argv.slice(1);
    process.stdout.write(`${JSON.stringify({
      ts, command, status, seconds: Number(seconds), mode,
      requestId: requestId || undefined,
      sequence: sequence ? Number(sequence) : undefined,
      role: role || undefined,
    })}\n`);
  ' "$ts" "$command" "$status" "$seconds" "$line_mode" \
    "$gate_coordinator_request_id" "$gate_coordinator_sequence" \
    "$gate_coordinator_role" >> "$durations_file" 2>/dev/null || true
}

gate_coordinator_cli() {
  AGENT_QUALITY_GATE_REQUEST_CAPABILITY="$gate_coordinator_request_capability" \
    node "$gate_coordinator_entry" "$@" \
    --root "$gate_coordinator_root" \
    --policy-hash "$gate_coordinator_policy_hash"
}

gate_coordinator_stop_request_lifecycle() {
  local disposition="${1:-unclean}" lifecycle_pid control_file completion_file
  local lifecycle_dir error_file update_file deadline control_failed=0
  local completion_valid=1
  lifecycle_pid="${gate_coordinator_lifecycle_pid:-}"
  lifecycle_dir="${gate_coordinator_lifecycle_dir:-}"
  control_file="${gate_coordinator_lifecycle_control_file:-}"
  completion_file="${gate_coordinator_lifecycle_completion_file:-}"
  error_file="${gate_coordinator_lifecycle_error_file:-}"
  if [[ -z "$lifecycle_pid" ]]; then
    rm -f "$control_file" "$completion_file" "$error_file"
    [[ -z "$lifecycle_dir" ]] || rmdir "$lifecycle_dir" 2>/dev/null || true
    gate_coordinator_lifecycle_dir=""
    gate_coordinator_lifecycle_control_file=""
    gate_coordinator_lifecycle_completion_file=""
    gate_coordinator_lifecycle_error_file=""
    return 0
  fi
  case "$disposition" in
    clean | unclean) ;;
    *) return 2 ;;
  esac
  [[ -n "$lifecycle_dir" && -n "$control_file" && -n "$completion_file" ]] || {
    echo "error: quality-gate lifecycle control state is incomplete." >&2
    return 2
  }
  update_file="$(mktemp "$lifecycle_dir/update.XXXXXX")" || control_failed=1
  if [[ "$control_failed" -eq 0 ]] &&
    ! printf '%s\n' "$disposition" > "$update_file"; then
    control_failed=1
  fi
  if [[ "$control_failed" -eq 0 ]] &&
    ! mv -f "$update_file" "$control_file"; then
    control_failed=1
  fi
  if [[ "$control_failed" -ne 0 ]]; then
    rm -f "$update_file" "$control_file"
    echo "error: could not publish the quality-gate lifecycle disposition; forcing an unclean disconnect." >&2
  fi
  # The clean detach RPC can use its full five-second transport timeout. Add
  # room for polling, scheduling, and whole-second deadline truncation.
  deadline=$(( $(date +%s) + 8 ))
  while [[ ! -s "$completion_file" ]]; do
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      echo "error: timed out while waiting for the quality-gate lifecycle client to stop." >&2
      return 2
    fi
    sleep 0.05
  done
  if ! node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (value.status !== "stopped" || value.exitCode !== 0) process.exit(2);
  ' "$completion_file" 2>/dev/null; then
    completion_valid=0
  fi
  wait "$lifecycle_pid" 2>/dev/null || true
  if [[ "$completion_valid" -eq 0 ]]; then
    [[ ! -s "$error_file" ]] || cat "$error_file" >&2
    echo "error: the quality-gate lifecycle client did not stop cleanly." >&2
  fi
  rm -f "$control_file" "$completion_file" "$error_file"
  rmdir "$lifecycle_dir" 2>/dev/null || true
  gate_coordinator_lifecycle_pid=""
  gate_coordinator_lifecycle_dir=""
  gate_coordinator_lifecycle_control_file=""
  gate_coordinator_lifecycle_completion_file=""
  gate_coordinator_lifecycle_error_file=""
  [[ "$control_failed" -eq 0 && "$completion_valid" -eq 1 ]] || return 2
  return 0
}

gate_coordinator_start_bound_registration() {
  local lifecycle_dir response_file error_file control_file completion_file
  local lifecycle_pid deadline rc node_executable
  gate_coordinator_bound_registration_json=""
  lifecycle_dir="$(mktemp -d "$scratch_dir/coordinator-lifecycle.XXXXXX")" || return 2
  chmod 700 "$lifecycle_dir" || {
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  response_file="$(mktemp "$lifecycle_dir/registration.XXXXXX")" || {
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  error_file="$(mktemp "$lifecycle_dir/registration-error.XXXXXX")" || {
    rm -f "$response_file"
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  control_file="$(mktemp "$lifecycle_dir/control.XXXXXX")" || {
    rm -f "$response_file" "$error_file"
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  completion_file="$(mktemp "$lifecycle_dir/completion.XXXXXX")" || {
    rm -f "$response_file" "$error_file" "$control_file"
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  node_executable="$(node -e 'process.stdout.write(process.execPath)' 2>/dev/null)" || {
    rm -f "$response_file" "$error_file" "$control_file" "$completion_file"
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  case "$node_executable" in
    /*) ;;
    *)
      rm -f "$response_file" "$error_file" "$control_file" "$completion_file"
      rmdir "$lifecycle_dir" 2>/dev/null || true
      return 2
      ;;
  esac
  [[ -f "$node_executable" && -x "$node_executable" ]] || {
    rm -f "$response_file" "$error_file" "$control_file" "$completion_file"
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  [[ -f "$gate_coordinator_lifecycle_entry" &&
    -r "$gate_coordinator_lifecycle_entry" ]] || {
    rm -f "$response_file" "$error_file" "$control_file" "$completion_file"
    rmdir "$lifecycle_dir" 2>/dev/null || true
    return 2
  }
  deadline=$(( $(date +%s) + 10 ))
  (
    export AGENT_QUALITY_GATE_REQUEST_CAPABILITY="$gate_coordinator_request_capability"
    exec 7>&-
    exec "$node_executable" "$gate_coordinator_lifecycle_entry" \
      "$gate_coordinator_entry" "$completion_file" register "$@" \
      --bind-connection \
      --parent-pid "$gate_coordinator_owner_pid" \
      --response-file "$response_file" \
      --lifecycle-control-file "$control_file" \
      --root "$gate_coordinator_root" \
      --policy-hash "$gate_coordinator_policy_hash" \
      >/dev/null 2>"$error_file"
  ) &
  lifecycle_pid=$!
  gate_coordinator_lifecycle_pid="$lifecycle_pid"
  gate_coordinator_lifecycle_dir="$lifecycle_dir"
  gate_coordinator_lifecycle_control_file="$control_file"
  gate_coordinator_lifecycle_completion_file="$completion_file"
  gate_coordinator_lifecycle_error_file="$error_file"

  while [[ ! -s "$response_file" ]]; do
    if [[ -s "$completion_file" ]]; then
      if wait "$lifecycle_pid" 2>/dev/null; then rc=2; else rc=$?; fi
      [[ ! -s "$error_file" ]] || cat "$error_file" >&2
      rm -f "$response_file" "$error_file" "$control_file" "$completion_file"
      rmdir "$lifecycle_dir" 2>/dev/null || true
      gate_coordinator_lifecycle_pid=""
      gate_coordinator_lifecycle_dir=""
      gate_coordinator_lifecycle_control_file=""
      gate_coordinator_lifecycle_completion_file=""
      gate_coordinator_lifecycle_error_file=""
      [[ "$rc" -ne 0 ]] || rc=2
      return "$rc"
    fi
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      gate_coordinator_stop_request_lifecycle unclean || true
      [[ ! -s "$error_file" ]] || cat "$error_file" >&2
      rm -f "$response_file" "$error_file"
      echo "error: timed out while binding the coordinator request lifecycle." >&2
      return 2
    fi
    sleep 0.05
  done

  gate_coordinator_bound_registration_json="$(<"$response_file")" || {
    gate_coordinator_stop_request_lifecycle unclean || true
    rm -f "$response_file" "$error_file"
    return 2
  }
  if [[ -s "$completion_file" ]]; then
    wait "$lifecycle_pid" 2>/dev/null || true
    [[ ! -s "$error_file" ]] || cat "$error_file" >&2
    rm -f "$response_file" "$error_file" "$control_file" "$completion_file"
    rmdir "$lifecycle_dir" 2>/dev/null || true
    gate_coordinator_lifecycle_pid=""
    gate_coordinator_lifecycle_dir=""
    gate_coordinator_lifecycle_control_file=""
    gate_coordinator_lifecycle_completion_file=""
    gate_coordinator_lifecycle_error_file=""
    return 2
  fi
  rm -f "$response_file"
}

gate_coordinator_stop_wait_cli() {
  local wait_pid wait_dir cancel_file completion_file error_file
  local update_file deadline control_failed=0
  wait_pid="${gate_coordinator_wait_pid:-}"
  wait_dir="${gate_coordinator_wait_dir:-}"
  cancel_file="${gate_coordinator_wait_cancel_file:-}"
  completion_file="${gate_coordinator_wait_completion_file:-}"
  error_file="${gate_coordinator_wait_error_file:-}"
  if [[ -z "$wait_pid" ]]; then
    rm -f "$cancel_file" "$completion_file" "$error_file"
    [[ -z "$wait_dir" ]] || rmdir "$wait_dir" 2>/dev/null || true
    gate_coordinator_wait_dir=""
    gate_coordinator_wait_cancel_file=""
    gate_coordinator_wait_completion_file=""
    gate_coordinator_wait_error_file=""
    return 0
  fi
  [[ -n "$wait_dir" && -n "$cancel_file" && -n "$completion_file" ]] || {
    echo "error: quality-gate coordinator wait control state is incomplete." >&2
    return 2
  }
  update_file="$(mktemp "$wait_dir/cancel-update.XXXXXX")" || control_failed=1
  if [[ "$control_failed" -eq 0 ]] &&
    ! printf 'cancel\n' > "$update_file"; then
    control_failed=1
  fi
  if [[ "$control_failed" -eq 0 ]] &&
    ! mv -f "$update_file" "$cancel_file"; then
    control_failed=1
  fi
  if [[ "$control_failed" -ne 0 ]]; then
    rm -f "$update_file" "$cancel_file"
    echo "error: could not publish the quality-gate coordinator wait cancellation." >&2
  fi
  deadline=$(( $(date +%s) + 8 ))
  while [[ ! -s "$completion_file" ]]; do
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      echo "error: timed out while waiting for the quality-gate coordinator wait client to stop." >&2
      return 2
    fi
    sleep 0.05
  done
  wait "$wait_pid" 2>/dev/null || true
  [[ ! -s "$error_file" ]] || cat "$error_file" >&2
  rm -f "$cancel_file" "$completion_file" "$error_file"
  rmdir "$wait_dir" 2>/dev/null || true
  gate_coordinator_wait_pid=""
  gate_coordinator_wait_dir=""
  gate_coordinator_wait_cancel_file=""
  gate_coordinator_wait_completion_file=""
  gate_coordinator_wait_error_file=""
  [[ "$control_failed" -eq 0 ]] || return 2
  return 0
}

gate_coordinator_wait_cli() {
  local label="$1" output_file="$2"
  shift 2
  local wait_pid wait_dir wait_error_file cancel_file completion_file
  local started now wait_deadline last_heartbeat last_recovery rc recorded_rc
  local had_errexit=0
  local run_tag request_tag coordinator_marker
  started="$(date +%s)"
  wait_deadline=$((started + gate_lock_wait_seconds + 10))
  last_heartbeat="$started"
  last_recovery="$started"
  gate_run_ensure_marker
  run_tag="$(gate_run_command_tag)"
  request_tag="$(gate_run_request_tag)"
  coordinator_marker="${gate_coordinator_marker_file:-}"
  wait_dir="$(mktemp -d "$scratch_dir/coordinator-wait.XXXXXX")" || return 2
  chmod 700 "$wait_dir" || {
    rmdir "$wait_dir" 2>/dev/null || true
    return 2
  }
  wait_error_file="$(mktemp "$wait_dir/error.XXXXXX")" || {
    rmdir "$wait_dir" 2>/dev/null || true
    return 2
  }
  cancel_file="$(mktemp "$wait_dir/cancel.XXXXXX")" || {
    rm -f "$wait_error_file"
    rmdir "$wait_dir" 2>/dev/null || true
    return 2
  }
  completion_file="$(mktemp "$wait_dir/completion.XXXXXX")" || {
    rm -f "$wait_error_file" "$cancel_file"
    rmdir "$wait_dir" 2>/dev/null || true
    return 2
  }
  # Use an exec boundary for coordinator waits. A backgrounded shell function
  # retains Bash's saved stdout descriptor as well as fd 7, so a hard-killed
  # gate can leave its caller's output pipe open until the RPC timeout. The
  # wrapper closes fd 7 and gives the RPC both process tags and both marker
  # handles. A private cancellation file stops a live wait without signalling a
  # stored PID. The RPC binds result waits to their follower request, so the
  # coordinator ends an orphaned wait when its owner sweep removes that request.
  AGENTQG_RUN="$run_tag" AGENTQG_REQUEST="$request_tag" \
    AGENT_QUALITY_GATE_REQUEST_CAPABILITY="$gate_coordinator_request_capability" \
    "${gate_sanitized_bash_launcher[@]}" -c '
      request_tag="$1"
      run_marker="$2"
      coordinator_marker="$3"
      coordinator_entry="$4"
      coordinator_root="$5"
      policy_hash="$6"
      cancellation_file="$7"
      completion_file="$8"
      shift 8

      if [[ -n "$run_marker" ]]; then
        [[ -r "$run_marker" ]] || exit 127
        exec 9< "$run_marker"
      fi
      if [[ -n "$coordinator_marker" && "$coordinator_marker" != "$run_marker" ]]; then
        [[ -r "$coordinator_marker" ]] || exit 127
        exec 8< "$coordinator_marker"
      fi
      exec 7>&-

      rc=2
      publish_completion() {
        local completion_update="${completion_file}.tmp.$$"
        trap - EXIT HUP INT TERM
        if ! printf "%s\n" "$rc" > "$completion_update" ||
          ! mv -f "$completion_update" "$completion_file"; then
          rm -f "$completion_update"
        fi
      }
      trap "publish_completion" EXIT
      trap "rc=129; exit \"\$rc\"" HUP
      trap "rc=130; exit \"\$rc\"" INT
      trap "rc=143; exit \"\$rc\"" TERM

      set +e
      node "$coordinator_entry" "$@" \
        --root "$coordinator_root" --policy-hash "$policy_hash" \
        --cancel-file "$cancellation_file"
      rc=$?
      exit "$rc"
    ' "$run_tag" "$request_tag" "$gate_run_marker_file" \
      "$coordinator_marker" "$gate_coordinator_entry" \
      "$gate_coordinator_root" "$gate_coordinator_policy_hash" \
      "$cancel_file" "$completion_file" "$@" \
      > "$output_file" 2> "$wait_error_file" &
  wait_pid=$!
  gate_coordinator_wait_pid="$wait_pid"
  gate_coordinator_wait_dir="$wait_dir"
  gate_coordinator_wait_cancel_file="$cancel_file"
  gate_coordinator_wait_completion_file="$completion_file"
  gate_coordinator_wait_error_file="$wait_error_file"
  while [[ ! -s "$completion_file" ]]; do
    sleep 1
    now="$(date +%s)"
    if [[ "$now" -ge "$wait_deadline" ]]; then
      echo "error: quality-gate coordinator wait exceeded its client timeout." >&2
      gate_coordinator_stop_wait_cli || true
      return 2
    fi
    if [[ $((now - last_recovery)) -ge 5 ]]; then
      if ! gate_coordinator_recover_stale_obligations; then
        gate_coordinator_stop_wait_cli || true
        return 2
      fi
      last_recovery="$now"
    fi
    if [[ $((now - last_heartbeat)) -ge 30 ]]; then
      printf '  ... %s after %ss.\n' "$label" "$((now - started))" >&7
      last_heartbeat="$now"
    fi
  done
  case "$-" in *e*) had_errexit=1 ;; esac
  set +e
  recorded_rc="$(<"$completion_file")" || recorded_rc=""
  wait "$wait_pid" 2>/dev/null || true
  if [[ "$recorded_rc" =~ ^[0-9]+$ && "$recorded_rc" -le 255 ]]; then
    rc="$recorded_rc"
  else
    echo "error: quality-gate coordinator wait wrote an invalid completion status." >&2
    rc=2
  fi
  gate_coordinator_wait_pid=""
  [[ ! -s "$wait_error_file" ]] || cat "$wait_error_file" >&2
  rm -f "$wait_error_file" "$cancel_file" "$completion_file"
  rmdir "$wait_dir" 2>/dev/null || true
  gate_coordinator_wait_dir=""
  gate_coordinator_wait_cancel_file=""
  gate_coordinator_wait_completion_file=""
  gate_coordinator_wait_error_file=""
  [[ "$had_errexit" -eq 1 ]] && set -e
  return "$rc"
}

gate_coordinator_classify_command() {
  local command="$1"
  gate_coordinator_command_weight=1
  gate_coordinator_command_all_capacity=0
  gate_coordinator_command_resources=()
  gate_coordinator_command_class="ordinary"

  case "$command" in
    "pnpm agent:quality-gate:test"|"bash scripts/agent-quality-gate.test.sh")
      if [[ "$gate_coordinator_capacity" -ge 2 ]]; then
        gate_coordinator_command_weight=2
      else
        gate_coordinator_command_weight=1
      fi
      gate_coordinator_command_class="gate-selftest"
      ;;
    "pnpm --filter @mento-protocol/ui-dashboard exec playwright install chromium")
      gate_coordinator_command_resources+=("playwright-install")
      gate_coordinator_command_class="playwright-install"
      ;;
    "pnpm exec turbo run test:browser --filter=@mento-protocol/ui-dashboard --cache=local:rw"|\
    "pnpm --filter @mento-protocol/ui-dashboard test:browser")
      gate_coordinator_command_all_capacity=1
      gate_coordinator_command_resources+=("browser-fixture-3211")
      gate_coordinator_command_class="dashboard-browser"
      ;;
    "pnpm --filter @mento-protocol/ui-dashboard test:coverage"|\
    "pnpm --filter @mento-protocol/ui-dashboard exec vitest related --run "*)
      gate_coordinator_command_all_capacity=1
      gate_coordinator_command_class="dashboard-coverage"
      ;;
    "VERCEL_DEPLOYMENT_ID=local-quality-gate pnpm exec turbo run size-limit --filter=@mento-protocol/ui-dashboard --cache=local:rw"|\
    "pnpm --filter @mento-protocol/ui-dashboard build"|\
    "pnpm exec turbo run build --filter=@mento-protocol/ui-dashboard --cache=local:rw")
      gate_coordinator_command_all_capacity=1
      gate_coordinator_command_class="dashboard-build"
      ;;
    TF_DATA_DIR=*terraform\ -chdir=*\ init\ -backend=false\ -input=false)
      if [[ -n "${TF_PLUGIN_CACHE_DIR:-}" ]]; then
        gate_coordinator_command_resources+=("terraform-plugin-cache")
        gate_coordinator_command_class="terraform-init"
      fi
      ;;
  esac
}

gate_coordinator_recover_stale_obligations() {
  local status_json status_records records="" obligation_id drain_token request_token request_id
  local current_status obligation_present condemned_dir
  local claim_error claim_json error_code rc had_errexit=0
  local drain_context="${1:-stale-run}"
  local request_filter="${2:-}"
  gate_coordinator_is_active || return 0
  # Parallel workers inherit the coordinator functions, but only the gate
  # parent can drain. A drain scans and updates shared capture files, so two
  # worker subshells must never enter it concurrently.
  [[ "${BASH_SUBSHELL:-0}" == "$gate_coordinator_owner_subshell" ]] || return 0
  status_json="$(gate_coordinator_cli status)" || return 2
  status_records="$(printf '%s' "$status_json" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    for (const item of value.drainObligations ?? []) {
      if (process.argv[1] && item.requestId !== process.argv[1]) continue;
      const request = (value.requests ?? []).find(
        (candidate) => candidate.requestId === item.requestId,
      );
      process.stdout.write([
        item.obligationId ?? "",
        item.drainIdentity ?? "",
        request?.drainIdentity ?? "",
        item.requestId ?? "",
      ].join("|") + "\n");
    }
  ' "$request_filter")" || return 2
  while IFS='|' read -r obligation_id drain_token request_token request_id; do
    [[ -n "$obligation_id" ]] || continue
    gate_lock_token_is_wellformed "$drain_token" || {
      echo "error: coordinator drain obligation ${obligation_id} has no safe persisted token." >&2
      return 2
    }
    gate_lock_token_is_wellformed "$request_token" || {
      echo "error: coordinator drain obligation ${obligation_id} has no safe request token." >&2
      return 2
    }
    [[ -n "$request_id" ]] || return 2
    claim_error="$(mktemp "$scratch_dir/coordinator-drain-claim.XXXXXX")" || return 2
    case "$-" in *e*) had_errexit=1 ;; esac
    set +e
    claim_json="$(gate_coordinator_cli claim-drain \
      --obligation-id "$obligation_id" --drain-token "$drain_token" \
      --claimant-pid "$gate_coordinator_owner_pid" \
      --claimant-start-utc "$gate_coordinator_owner_start" \
      2>"$claim_error")"
    rc=$?
    [[ "$had_errexit" -eq 1 ]] && set -e
    if [[ "$rc" -ne 0 ]]; then
      error_code="$(node -e '
        try {
          const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
          process.stdout.write(value.error?.code ?? "");
        } catch {}
      ' "$claim_error" 2>/dev/null || true)"
      rm -f "$claim_error"
      case "$error_code" in
        DRAIN_ALREADY_CLAIMED|DRAIN_OBLIGATION_NOT_FOUND) continue ;;
      esac
      echo "error: coordinator drain obligation ${obligation_id} could not be claimed safely." >&2
      return 2
    fi
    rm -f "$claim_error"
    if ! printf '%s' "$claim_json" | node -e '
      const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const obligation = value.obligation ?? {};
      process.exit(value.claimed === true &&
        obligation.obligationId === process.argv[1] &&
        obligation.drainIdentity === process.argv[2] ? 0 : 1);
    ' "$obligation_id" "$drain_token"; then
      gate_coordinator_cli release-drain-claim \
        --obligation-id "$obligation_id" --drain-token "$drain_token" \
        --claimant-pid "$gate_coordinator_owner_pid" \
        --claimant-start-utc "$gate_coordinator_owner_start" \
        >/dev/null 2>&1 || true
      echo "error: coordinator returned an invalid drain claim for ${obligation_id}." >&2
      return 2
    fi
    if ! record_condemned_run "$drain_token"; then
      gate_coordinator_cli release-drain-claim \
        --obligation-id "$obligation_id" --drain-token "$drain_token" \
        --claimant-pid "$gate_coordinator_owner_pid" \
        --claimant-start-utc "$gate_coordinator_owner_start" \
        >/dev/null 2>&1 || true
      echo "error: coordinator drain obligation ${obligation_id} could not be persisted." >&2
      return 2
    fi
    if ! record_condemned_run "$request_token"; then
      gate_coordinator_cli release-drain-claim \
        --obligation-id "$obligation_id" --drain-token "$drain_token" \
        --claimant-pid "$gate_coordinator_owner_pid" \
        --claimant-start-utc "$gate_coordinator_owner_start" \
        >/dev/null 2>&1 || true
      echo "error: coordinator request recovery handle for ${obligation_id} could not be persisted." >&2
      return 2
    fi
    records="${records}${obligation_id}|${drain_token}|${request_token}|${request_id}
"
  done <<< "$status_records"
  [[ -n "$records" ]] || return 0
  condemned_dir="$(gate_lock_condemned_dir)" || return 2
  [[ "$condemned_dir" == "${gate_lock_root_dir}/condemned.d" ]] || return 2
  while IFS='|' read -r obligation_id drain_token request_token request_id; do
    [[ -n "$obligation_id" ]] || continue
    case " ${gate_lock_drained_tokens} " in
      *" ${drain_token} "*) continue ;;
    esac
    # Drain only the token this parent claimed. The legacy directory-wide scan
    # would also take records claimed by another coordinator client.
    if ! drain_condemned_run_commands "$drain_token" "$drain_context"; then
      echo "error: coordinator drain obligation ${obligation_id} did not reach an empty process tree." >&2
      return 2
    fi
    rm -f "$condemned_dir/$drain_token" || return 2
    gate_lock_drained_tokens="${gate_lock_drained_tokens} ${drain_token}"
  done <<< "$records"
  # Command tokens recover exact command captures. The request token is a
  # separate coarse handle retained by every command. Drain both before any
  # lease in that stale request can release capacity.
  while IFS='|' read -r obligation_id drain_token request_token request_id; do
    [[ -n "$obligation_id" ]] || continue
    case " ${gate_lock_drained_tokens} " in
      *" ${request_token} "*) continue ;;
    esac
    if ! drain_condemned_run_commands "$request_token" "$drain_context"; then
      echo "error: coordinator request ${request_id} did not reach an empty process tree." >&2
      return 2
    fi
    rm -f "$condemned_dir/$request_token" || return 2
    gate_lock_drained_tokens="${gate_lock_drained_tokens} ${request_token}"
  done <<< "$records"
  while IFS='|' read -r obligation_id drain_token request_token request_id; do
    [[ -n "$obligation_id" ]] || continue
    case " ${gate_lock_drained_tokens} " in
      *" ${drain_token} "*) ;;
      *) continue ;;
    esac
    case " ${gate_lock_drained_tokens} " in
      *" ${request_token} "*) ;;
      *) continue ;;
    esac
    if ! gate_coordinator_cli ack-drain \
      --obligation-id "$obligation_id" --drain-token "$drain_token" \
      --drainer-pid "$gate_coordinator_owner_pid" \
      --drainer-start-utc "$gate_coordinator_owner_start" \
      --evidence-json '{"processTreeEmpty":true,"source":"bash-stale-recovery"}' \
      >/dev/null; then
      current_status="$(gate_coordinator_cli status)" || return 2
      obligation_present="$(printf '%s' "$current_status" | node -e '
        const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        process.stdout.write((value.drainObligations ?? []).some(
          (item) => item.obligationId === process.argv[1]
        ) ? "1" : "0");
      ' "$obligation_id")" || return 2
      [[ "$obligation_present" == "0" ]] || return 2
    fi
  done <<< "$records"
}

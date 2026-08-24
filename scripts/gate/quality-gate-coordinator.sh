# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2154
# Source-only Bash adapter for quality-gate-coordinator.mjs.
# The caller owns shell options and the legacy lock implementation.

gate_coordinator_capacity="${gate_coordinator_capacity:-3}"
gate_coordinator_entry="$script_source_dir/gate/quality-gate-coordinator.mjs"
gate_coordinator_active=0
gate_coordinator_request_terminal=0
gate_coordinator_result_acknowledged=0
gate_coordinator_role=""
gate_coordinator_request_id=""
gate_coordinator_request_capability=""
gate_coordinator_execution_id=""
gate_coordinator_sequence=""
gate_coordinator_generation_token=""
gate_coordinator_marker_file=""
gate_coordinator_root=""
gate_coordinator_policy_hash=""
gate_coordinator_owner_pid=""
gate_coordinator_owner_start=""
gate_coordinator_owner_subshell="${BASH_SUBSHELL:-0}"
gate_coordinator_registration_fingerprint=""
gate_coordinator_completed_result_json=""
gate_coordinator_active_lease_id=""
gate_coordinator_infrastructure_failed=0
gate_coordinator_wait_pid=""
gate_coordinator_lifecycle_pid=""
gate_coordinator_bound_registration_json=""
gate_coordinator_recovery_drain_context="stale-run"

gate_coordinator_support="${gate_coordinator_support:-$script_source_dir/gate/quality-gate-coordinator-support.sh}"
if [[ ! -r "$gate_coordinator_support" ]]; then
  echo "error: quality-gate coordinator support is missing: ${gate_coordinator_support}" >&2
  return 2
fi
# shellcheck source=scripts/gate/quality-gate-coordinator-support.sh
source "$gate_coordinator_support"

gate_coordinator_is_active() {
  [[ "$gate_coordinator_active" -eq 1 ]]
}

gate_coordinator_is_follower() {
  gate_coordinator_is_active || return 1
  [[ "$gate_coordinator_role" == "follower" ||
    "$gate_coordinator_role" == "completed" ]]
}

gate_coordinator_report_no_work_failure() {
  local status="$1" phase="$2" work_verdict="$3"
  (
    trap '' PIPE
    printf 'Quality-gate coordinator %s failed. %s; this gate exits %s.\n' \
      "$phase" "$work_verdict" "$status"
    printf '%s\n' \
      'Piped? A pipeline reports the reader status: read ${PIPESTATUS[0]} or set -o pipefail.'
  ) 2>/dev/null >&7 || true
}

gate_coordinator_apply_authority_json() {
  local authority_json="$1"
  local parsed owned generation marker owner_pid owner_start expected_marker
  parsed="$(printf '%s' "$authority_json" | node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    const fields = [
      value.owned === true ? "1" : "0",
      value.generationToken ?? "",
      value.markerPath ?? "",
      String(value.owner?.pid ?? ""),
      value.owner?.coordinator_start_utc ??
        value.coordinatorIdentity?.startUtc ??
        value.owner?.start_utc ?? "",
    ];
    if (fields.some((field) => /[\x1f\r\n]/.test(field))) process.exit(2);
    process.stdout.write(fields.join("\x1f"));
  ')" || return 2
  IFS=$'\x1f' read -r owned generation marker owner_pid owner_start <<< "$parsed"
  [[ "$owned" == "1" ]] || return 1
  gate_lock_token_is_wellformed "$generation" || return 2
  expected_marker="${gate_lock_root_dir}/holder.${generation}"
  [[ "$marker" == "$expected_marker" && -r "$marker" ]] || return 2
  [[ "$owner_pid" =~ ^[0-9]+$ && -n "$owner_start" ]] || return 2

  gate_coordinator_generation_token="$generation"
  gate_coordinator_marker_file="$marker"
  gate_lock_token="$generation"
  gate_lock_dir=""
  export AGENT_QUALITY_GATE_LOCK_HELD="$generation"
  gate_coordinator_active=1
}

gate_coordinator_parse_registration() {
  local registration_json="$1"
  local parsed blocker
  parsed="$(printf '%s' "$registration_json" | node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    const role = value.role ?? "";
    const result = value.result ?? null;
    const fields = [
      role,
      value.requestId ?? "",
      value.executionId ?? result?.executionId ?? "",
      String(value.sequence ?? ""),
      value.admission ?? (role === "completed" ? "completed" : ""),
      value.worktreeBlocker ?? "",
    ];
    if (fields.some((field) => /[\x1f\r\n]/.test(field))) process.exit(2);
    process.stdout.write(fields.join("\x1f"));
  ')" || return 2
  IFS=$'\x1f' read -r gate_coordinator_role parsed_request \
    gate_coordinator_execution_id gate_coordinator_sequence admission blocker <<< "$parsed"
  [[ "$parsed_request" == "$gate_coordinator_request_id" ]] || return 2
  case "$gate_coordinator_role" in
    leader|follower|completed)
      [[ -n "$gate_coordinator_execution_id" &&
        "$admission" =~ ^(held|queued)$ ]] || return 2
      ;;
    *) return 2 ;;
  esac
  if [[ "$gate_coordinator_role" == "completed" ]]; then
    gate_coordinator_completed_result_json="$registration_json"
  fi
  gate_coordinator_registration_admission="$admission"
  gate_coordinator_registration_blocker="$blocker"
}

gate_coordinator_wait_for_admission() {
  local wait_file wait_started wait_finished rc admission_state found
  [[ "$gate_coordinator_registration_admission" == "queued" ]] || return 0
  if [[ "$gate_lock_wait_seconds" -eq 0 ]]; then
    echo "error: quality-gate request is queued for its worktree and --lock-wait is 0." >&2
    gate_coordinator_report_no_work_failure 2 "worktree admission" "No mapped command ran in this request"; return 2
  fi
  printf 'Scheduler queue: request %s waits for worktree holder %s.\n' \
    "$gate_coordinator_request_id" \
    "${gate_coordinator_registration_blocker:-unknown}" >&7
  wait_started="$(date +%s)"
  wait_file="$(mktemp "$scratch_dir/coordinator-admission.XXXXXX")" || { gate_coordinator_report_no_work_failure 2 "worktree admission" "No mapped command ran in this request"; return 2; }
  set +e
  gate_coordinator_wait_cli "still waiting for worktree admission" "$wait_file" \
    wait-admission \
    --request-id "$gate_coordinator_request_id" \
    --owner-pid "$gate_coordinator_owner_pid" \
    --owner-start-utc "$gate_coordinator_owner_start" \
    --timeout-ms "$((gate_lock_wait_seconds * 1000))"
  rc=$?
  set -e
  wait_finished="$(date +%s)"
  gate_coordinator_log_duration \
    "$([[ "$rc" -eq 0 ]] && printf ok || printf fail)" \
    "$((wait_finished - wait_started))" "__scheduler_queue__" "scheduler"
  if [[ "$rc" -ne 0 ]]; then
    rm -f "$wait_file"
    echo "error: quality-gate worktree admission failed." >&2
    gate_coordinator_report_no_work_failure 2 "worktree admission" "No mapped command ran in this request"; return 2
  fi
  read -r found admission_state <<< "$(node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`${value.found === false ? "0" : "1"} ${value.admission ?? "gone"}`);
  ' "$wait_file")" || {
    rm -f "$wait_file"
    gate_coordinator_report_no_work_failure 2 "worktree admission" "No mapped command ran in this request"; return 2
  }
  rm -f "$wait_file"
  [[ "$found" == "1" && "$admission_state" == "held" ]] || { gate_coordinator_report_no_work_failure 2 "worktree admission" "No mapped command ran in this request"; return 2; }
}

gate_coordinator_register() {
  local registration_json rc success_max_age_ms=0
  gate_coordinator_recover_stale_obligations || { gate_coordinator_report_no_work_failure 2 "registration" "No mapped command ran in this request"; return 2; }
  if [[ "$skip_if_fresh" == "1" || "$skip_if_fresh" == "true" ]]; then
    success_max_age_ms=$((success_stamp_ttl_seconds * 1000))
  fi
  set +e
  gate_coordinator_start_bound_registration \
    --request-id "$gate_coordinator_request_id" \
    --fingerprint "$gate_coordinator_registration_fingerprint" \
    --worktree-key "$(cd "$repo_root" && pwd -P)" \
    --drain-token "$gate_run_id" \
    --owner-pid "$gate_coordinator_owner_pid" \
    --owner-start-utc "$gate_coordinator_owner_start" \
    --success-max-age-ms "$success_max_age_ms" \
    --metadata-json "{\"client\":\"agent-quality-gate.sh\",\"capacity\":${gate_coordinator_capacity}}"
  rc=$?
  registration_json="$gate_coordinator_bound_registration_json"
  set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "error: compatible coordinator rejected quality-gate registration." >&2
    gate_coordinator_report_no_work_failure 2 "registration" "No mapped command ran in this request"; return 2
  fi
  gate_coordinator_parse_registration "$registration_json" || {
    gate_coordinator_stop_request_lifecycle unclean || true
    echo "error: coordinator returned an invalid registration response." >&2
    gate_coordinator_report_no_work_failure 2 "registration" "No mapped command ran in this request"; return 2
  }
  printf 'Scheduler request %s: sequence %s, role %s.\n' \
    "$gate_coordinator_request_id" \
    "${gate_coordinator_sequence:-completed}" \
    "$gate_coordinator_role" >&7
  gate_coordinator_wait_for_admission
}

gate_coordinator_try_join_existing() {
  local authority_json rc
  [[ -n "$gate_coordinator_root" && -n "$gate_coordinator_policy_hash" ]] || return 1
  gate_coordinator_is_active && return 0
  set +e
  authority_json="$(gate_coordinator_cli authority 2>/dev/null)"
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || return 1
  gate_coordinator_apply_authority_json "$authority_json"
  rc=$?
  if [[ "$rc" -eq 1 ]]; then
    return 1
  elif [[ "$rc" -ne 0 ]]; then
    echo "error: coordinator authority response failed validation." >&2
    gate_coordinator_report_no_work_failure 2 "authority validation" "No mapped command ran in this request"; return 2
  fi
  gate_coordinator_register
}

gate_coordinator_bootstrap_from_legacy() {
  local legacy_owner_token metadata rc
  legacy_owner_token="$gate_lock_token"
  gate_coordinator_assert_prepared_policy_current || { gate_coordinator_report_no_work_failure 2 "startup" "No mapped command ran in this request"; return 2; }
  # A dead coordinator leaves the shared marker as the aggregate discovery
  # handle for all of its workers. Drain legacy obligations before the
  # successor recovers and acknowledges its journal leases.
  drain_condemned_runs
  set +e
  metadata="$(gate_coordinator_cli start \
    --capacity "$gate_coordinator_capacity" \
    --legacy-lock-root "$gate_lock_root_dir" \
    --legacy-owner-token "$legacy_owner_token" \
    --startup-timeout-ms 10000)"
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { gate_coordinator_report_no_work_failure 2 "startup" "No mapped command ran in this request"; return 2; }
  gate_coordinator_apply_authority_json "$(printf '%s' "$metadata" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify({
      owned: value.authority?.owned,
      generationToken: value.generationToken,
      markerPath: value.markerPath,
      owner: value.authority?.owner,
      coordinatorIdentity: value.coordinatorIdentity,
    }));
  ')" || { gate_coordinator_report_no_work_failure 2 "startup" "No mapped command ran in this request"; return 2; }
  gate_coordinator_recover_stale_obligations || { gate_coordinator_report_no_work_failure 2 "startup" "No mapped command ran in this request"; return 2; }
  gate_coordinator_register
}

gate_coordinator_assert_authority() {
  local authority_json status_json expected_generation request_active
  gate_coordinator_is_active || return 0
  expected_generation="$gate_coordinator_generation_token"
  authority_json="$(gate_coordinator_cli authority)" || {
    echo "error: quality-gate coordinator authority is unavailable." >&2
    gate_coordinator_report_no_work_failure 2 "authority validation" "The next mapped command did not run"; return 2
  }
  gate_coordinator_apply_authority_json "$authority_json" || {
    echo "error: quality-gate coordinator no longer owns the legacy run lock." >&2
    gate_coordinator_report_no_work_failure 2 "authority validation" "The next mapped command did not run"; return 2
  }
  if [[ "$gate_coordinator_generation_token" != "$expected_generation" ]]; then
    echo "error: quality-gate coordinator generation changed during this request." >&2
    gate_coordinator_report_no_work_failure 2 "authority validation" "The next mapped command did not run"; return 2
  fi
  [[ "$gate_coordinator_role" == "leader" ]] || return 0
  status_json="$(gate_coordinator_cli status)" || { gate_coordinator_report_no_work_failure 2 "authority validation" "The next mapped command did not run"; return 2; }
  request_active="$(printf '%s' "$status_json" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const [requestId, pid, startUtc] = process.argv.slice(1);
    const request = (value.requests ?? []).find((item) => item.requestId === requestId);
    process.stdout.write(
      request && request.role === "leader" && request.admission === "held" &&
      request.state === "active" && String(request.owner?.pid) === pid &&
      request.owner?.startUtc === startUtc ? "1" : "0",
    );
  ' "$gate_coordinator_request_id" "$gate_coordinator_owner_pid" \
    "$gate_coordinator_owner_start")" || { gate_coordinator_report_no_work_failure 2 "authority validation" "The next mapped command did not run"; return 2; }
  if [[ "$request_active" != "1" ]]; then
    echo "error: coordinator request authority is no longer active for this gate owner." >&2
    gate_coordinator_report_no_work_failure 2 "authority validation" "The next mapped command did not run"; return 2
  fi
}

gate_coordinator_abandon_active_lease() {
  local lease_id="$gate_coordinator_active_lease_id"
  [[ -n "$lease_id" ]] || return 0
  gate_coordinator_cli abandon-lease \
    --request-id "$gate_coordinator_request_id" --lease-id "$lease_id" \
    --owner-pid "$gate_coordinator_owner_pid" \
    --owner-start-utc "$gate_coordinator_owner_start" \
    --command-not-started >/dev/null 2>&1 || return 1
  gate_coordinator_active_lease_id=""
}

gate_coordinator_before_command() {
  local command="$1"
  local lease_tmp lease_suffix command_digest lease_json parsed status blockers
  local lease_sequence resource
  local wait_file wait_started wait_finished rc had_errexit=0
  local lease_args=()
  gate_coordinator_is_active || return 0
  if [[ "$gate_coordinator_infrastructure_failed" -eq 1 ||
    -n "$gate_coordinator_active_lease_id" ]]; then
    echo "error: coordinator lease state is unresolved; command scheduling has stopped." >&2
    gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
  fi
  gate_coordinator_assert_authority || return 2
  if [[ "${BASH_SUBSHELL:-0}" == "$gate_coordinator_owner_subshell" ]]; then
    gate_coordinator_recover_stale_obligations || { gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2; }
  fi
  gate_coordinator_classify_command "$command"
  lease_tmp="$(mktemp "$scratch_dir/coordinator-lease.XXXXXX")" || { gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2; }
  lease_suffix="${lease_tmp##*.}"
  rm -f "$lease_tmp"
  gate_coordinator_active_lease_id="lease-${gate_coordinator_request_id}-${lease_suffix}"
  command_digest="$(printf '%s' "$command" | hash_stream)" || { gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2; }

  lease_args=(lease
    --request-id "$gate_coordinator_request_id"
    --lease-id "$gate_coordinator_active_lease_id"
    --owner-pid "$gate_coordinator_owner_pid"
    --owner-start-utc "$gate_coordinator_owner_start"
    --weight "$gate_coordinator_command_weight"
    --metadata-json "{\"class\":\"${gate_coordinator_command_class}\",\"commandHash\":\"${command_digest}\"}")
  if [[ "$gate_coordinator_command_all_capacity" -eq 1 ]]; then
    lease_args+=(--all-capacity)
  fi
  for resource in "${gate_coordinator_command_resources[@]+"${gate_coordinator_command_resources[@]}"}"; do
    case "$resource" in
      browser-fixture-3211|playwright-install) ;;
      *) echo "error: unknown coordinator resource: ${resource}" >&2
        gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2 ;;
    esac
    lease_args+=(--resource "$resource")
  done

  case "$-" in
    *e*) had_errexit=1 ;;
  esac
  set +e
  lease_json="$(gate_coordinator_cli "${lease_args[@]}")"
  rc=$?
  [[ "$had_errexit" -eq 1 ]] && set -e
  if [[ "$rc" -ne 0 ]]; then
    gate_coordinator_abandon_active_lease || true
    echo "error: coordinator refused the command lease." >&2
    gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
  fi
  if ! parsed="$(printf '%s' "$lease_json" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const blockers = (value.blockers ?? []).map((item) =>
      item.type === "resource" ? `${item.type}:${item.resource}` : item.type
    ).join(",");
    process.stdout.write(`${value.status ?? ""}\x1f${value.sequence ?? ""}\x1f${blockers}`);
  ')"; then
    gate_coordinator_abandon_active_lease || true
    echo "error: coordinator returned an invalid command lease response." >&2
    gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
  fi
  IFS=$'\x1f' read -r status lease_sequence blockers <<< "$parsed"
  wait_started="$(date +%s)"
  if [[ "$status" == "queued" ]]; then
    printf 'Scheduler wait: command %s (%s), lease sequence %s, blockers %s.\n' \
      "${command_digest:0:12}" "$gate_coordinator_command_class" \
      "${lease_sequence:-unknown}" "${blockers:-pending fair turn}" >&7
    if [[ "$gate_lock_wait_seconds" -eq 0 ]]; then
      gate_coordinator_abandon_active_lease || true
      echo "error: command needs a scheduler lease and --lock-wait is 0." >&2
      gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
    fi
    wait_file="$(mktemp "$scratch_dir/coordinator-lease-wait.XXXXXX")" || {
      gate_coordinator_abandon_active_lease || true
      gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
    }
    set +e
    gate_coordinator_wait_cli \
      "still waiting for command ${command_digest:0:12} (${blockers:-fair turn})" \
      "$wait_file" wait-lease \
      --lease-id "$gate_coordinator_active_lease_id" \
      --owner-pid "$gate_coordinator_owner_pid" \
      --owner-start-utc "$gate_coordinator_owner_start" \
      --timeout-ms "$((gate_lock_wait_seconds * 1000))"
    rc=$?
    [[ "$had_errexit" -eq 1 ]] && set -e
    if [[ "$rc" -ne 0 ]]; then
      rm -f "$wait_file"
      gate_coordinator_abandon_active_lease || true
      echo "error: command scheduler wait failed." >&2
      gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
    fi
    status="$(node -e '
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(value.status ?? "");
    ' "$wait_file")" || {
      rm -f "$wait_file"
      gate_coordinator_abandon_active_lease || true
      gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
    }
    rm -f "$wait_file"
  fi
  wait_finished="$(date +%s)"
  last_scheduler_wait_seconds=$((wait_finished - wait_started))
  gate_coordinator_log_duration \
    "$([[ "$status" == "granted" ]] && printf ok || printf fail)" \
    "$last_scheduler_wait_seconds" \
    "__scheduler_wait__:${command_digest:0:12}" "scheduler"
  if [[ "$status" != "granted" ]]; then
    gate_coordinator_abandon_active_lease || true
    echo "error: coordinator did not grant the command lease." >&2
    gate_coordinator_report_no_work_failure 2 "command lease acquisition" "The mapped command did not run"; return 2
  fi
  printf 'Scheduler grant: command %s (%s), lease sequence %s, wait %ss.\n' \
    "${command_digest:0:12}" "$gate_coordinator_command_class" \
    "${lease_sequence:-unknown}" "$last_scheduler_wait_seconds" >&7
}

gate_coordinator_after_command() {
  local command="$1"
  local lease_id="$gate_coordinator_active_lease_id"
  gate_coordinator_is_active || return 0
  [[ -n "$lease_id" ]] || return 0
  if ! gate_coordinator_cli release \
    --request-id "$gate_coordinator_request_id" \
    --lease-id "$lease_id" \
    --owner-pid "$gate_coordinator_owner_pid" \
    --owner-start-utc "$gate_coordinator_owner_start" >/dev/null; then
    gate_coordinator_infrastructure_failed=1
    echo "error: coordinator could not release the command lease." >&2
    return 2
  fi
  gate_coordinator_active_lease_id=""
}

gate_coordinator_cancel_and_ack() {
  local reason="$1"
  local drain_context="${2:-stale-run}"
  local response parsed follower_only result_acknowledged
  response="$(gate_coordinator_cli cancel \
    --request-id "$gate_coordinator_request_id" \
    --owner-pid "$gate_coordinator_owner_pid" \
    --owner-start-utc "$gate_coordinator_owner_start" \
    --reason "$reason")" || return 2
  parsed="$(printf '%s' "$response" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write([
      value.followerOnly === true ? "1" : "0",
      value.resultAcknowledged === true ? "1" : "0",
    ].join(" "));
  ')" || return 2
  read -r follower_only result_acknowledged <<< "$parsed"
  if [[ "$follower_only" == "1" || "$result_acknowledged" == "1" ]]; then
    gate_coordinator_request_terminal=1
    gate_coordinator_result_acknowledged=1
    return 0
  fi
  gate_coordinator_recover_stale_obligations \
    "$drain_context" "$gate_coordinator_request_id" || return 2
  gate_coordinator_request_terminal=1
  gate_coordinator_acknowledge_result
}

gate_coordinator_acknowledge_result() {
  local response acknowledged
  gate_coordinator_is_active || return 0
  [[ "$gate_coordinator_request_terminal" -eq 1 ]] || return 2
  [[ "$gate_coordinator_result_acknowledged" -eq 0 ]] || return 0
  response="$(gate_coordinator_cli ack-result \
    --request-id "$gate_coordinator_request_id" \
    --owner-pid "$gate_coordinator_owner_pid" \
    --owner-start-utc "$gate_coordinator_owner_start")" || return 2
  acknowledged="$(printf '%s' "$response" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(value.acknowledged === true ? "1" : "0");
  ')" || return 2
  [[ "$acknowledged" == "1" ]] || return 2
  gate_coordinator_result_acknowledged=1
}

gate_coordinator_verify_registration_fingerprint() {
  local context="$1" fresh
  gate_coordinator_is_active || return 0
  fresh="$(gate_coordinator_recompute_fingerprint)" || {
    echo "error: could not recompute the coordinator fingerprint ${context}." >&2
    [[ "$context" != "before first dispatch" ]] || gate_coordinator_report_no_work_failure 2 "first-dispatch identity validation" "No mapped command ran in this request"
    return 2
  }
  if [[ "$fresh" != "$gate_coordinator_registration_fingerprint" ]]; then
    echo "error: quality-gate inputs changed ${context}; shared terminal result is forbidden." >&2
    gate_coordinator_cancel_and_ack "fingerprint changed ${context}" || true
    [[ "$context" != "before first dispatch" ]] || gate_coordinator_report_no_work_failure 2 "first-dispatch identity validation" "No mapped command ran in this request"
    return 2
  fi
}

gate_coordinator_publish_result() {
  local status="$1" payload="$2" response published
  gate_coordinator_is_active || return 0
  [[ "$gate_coordinator_role" == "leader" ]] || return 2
  response="$(gate_coordinator_cli result \
    --request-id "$gate_coordinator_request_id" \
    --owner-pid "$gate_coordinator_owner_pid" \
    --owner-start-utc "$gate_coordinator_owner_start" \
    --status "$status" --payload-json "$payload")" || return 2
  published="$(printf '%s' "$response" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.stdout.write(value.published === true ? "1" : "0");
  ')" || return 2
  [[ "$published" == "1" ]] || return 2
  gate_coordinator_request_terminal=1
}

gate_coordinator_publish_success() {
  gate_coordinator_publish_result success '{"source":"agent-quality-gate"}'
}

gate_coordinator_publish_failure() {
  local failures="$1"
  gate_coordinator_publish_result failure "{\"failures\":${failures}}"
}

gate_coordinator_wait_for_shared_result() {
  local wait_file started finished rc result_json parsed found status fingerprint policy execution
  started="$(date +%s)"
  if [[ "$gate_coordinator_role" == "completed" ]]; then
    result_json="$gate_coordinator_completed_result_json"
  else
    [[ "$gate_lock_wait_seconds" -gt 0 ]] || {
      echo "error: a coalesced result is pending and --lock-wait is 0." >&2
      gate_coordinator_report_no_work_failure 2 "coalesced result wait" "No mapped command ran in this request"; return 2
    }
    printf 'Coalesced wait: request %s follows execution %s.\n' \
      "$gate_coordinator_request_id" "$gate_coordinator_execution_id" >&7
    wait_file="$(mktemp "$scratch_dir/coordinator-result.XXXXXX")" || { gate_coordinator_report_no_work_failure 2 "coalesced result wait" "No mapped command ran in this request"; return 2; }
    set +e
    gate_coordinator_wait_cli "still waiting for coalesced execution" "$wait_file" \
      wait-result --fingerprint "$gate_coordinator_registration_fingerprint" \
      --execution-id "$gate_coordinator_execution_id" \
      --request-id "$gate_coordinator_request_id" \
      --owner-pid "$gate_coordinator_owner_pid" \
      --owner-start-utc "$gate_coordinator_owner_start" \
      --timeout-ms "$((gate_lock_wait_seconds * 1000))"
    rc=$?
    set -e
    if [[ "$rc" -ne 0 ]]; then
      rm -f "$wait_file"
      gate_coordinator_report_no_work_failure 2 "coalesced result wait" "No mapped command ran in this request"; return 2
    fi
    result_json="$(<"$wait_file")"
    rm -f "$wait_file"
  fi
  finished="$(date +%s)"
  gate_coordinator_log_duration ok "$((finished - started))" \
    "__coalesced_wait__" "scheduler"
  parsed="$(printf '%s' "$result_json" | node -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const result = value.result ?? value;
    process.stdout.write([
      value.found === false ? "0" : "1", result.status ?? "",
      result.fingerprint ?? "", result.policyHash ?? "", result.executionId ?? "",
    ].join("\x1f"));
  ')" || {
    gate_coordinator_report_no_work_failure 2 "coalesced result handling" "No mapped command ran in this request"; return 2
  }
  IFS=$'\x1f' read -r found status fingerprint policy execution <<< "$parsed"
  [[ "$found" == "1" && "$fingerprint" == "$gate_coordinator_registration_fingerprint" &&
    "$policy" == "$gate_coordinator_policy_hash" &&
    "$execution" == "$gate_coordinator_execution_id" ]] || {
    gate_coordinator_report_no_work_failure 2 "coalesced result handling" "No mapped command ran in this request"; return 2
  }
  gate_coordinator_verify_registration_fingerprint "before accepting a shared result" || { gate_coordinator_report_no_work_failure 2 "coalesced result handling" "No mapped command ran in this request"; return 2; }
  gate_coordinator_request_terminal=1
  if [[ "$status" == "success" ]]; then
    echo "Shared coordinator execution passed; no mapped command ran in this request."
    return 0
  fi
  echo "Shared coordinator execution ended with status ${status:-unknown}." >&2
  gate_coordinator_report_no_work_failure 1 "shared execution" "No mapped command ran in this request"; return 1
}

gate_coordinator_cleanup() {
  local lifecycle_disposition="unclean"
  gate_coordinator_is_active || return 0
  [[ "${BASH_SUBSHELL:-0}" == "$gate_coordinator_owner_subshell" ]] || return 0
  if [[ -n "$gate_coordinator_wait_pid" ]]; then
    kill -TERM "$gate_coordinator_wait_pid" 2>/dev/null || true
    wait "$gate_coordinator_wait_pid" 2>/dev/null || true
    gate_coordinator_wait_pid=""
  fi
  if [[ "$gate_coordinator_request_terminal" -eq 0 ]]; then
    gate_coordinator_cancel_and_ack \
      "gate client exited before result publication" \
      "$gate_coordinator_recovery_drain_context" || true
  elif [[ "$gate_coordinator_result_acknowledged" -eq 0 ]]; then
    gate_coordinator_acknowledge_result || true
  fi
  if [[ "$gate_coordinator_result_acknowledged" -eq 1 ]]; then
    lifecycle_disposition="clean"
  fi
  gate_coordinator_stop_request_lifecycle "$lifecycle_disposition" || true
  gate_coordinator_active=0
  gate_lock_dir=""
}

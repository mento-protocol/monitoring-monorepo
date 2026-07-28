#!/usr/bin/env bash
# Deploy a pinned Grafana Alloy App Engine version after read-only contract,
# secret-readiness, IAM, and runtime-identity checks.

set -euo pipefail

agent_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$agent_dir/../.." && pwd)"
project="${GCP_PROJECT:-mento-monitoring}"
legacy_seed_path="aegis/grafana-agent/seed-secrets.sh"
snapshot_files=(
  aegis/grafana-agent/Dockerfile
  aegis/grafana-agent/config.alloy
  aegis/grafana-agent/entrypoint.sh
  aegis/grafana-agent/grafana-agent.yaml
  aegis/grafana-agent/passive-health.sh
)
verifier_files=(
  aegis/grafana-agent/.gcloudignore
  aegis/grafana-agent/README.md
  aegis/grafana-agent/Dockerfile
  aegis/grafana-agent/cloudbuild.yaml
  aegis/grafana-agent/contract.mjs
  aegis/grafana-agent/deploy.sh
  aegis/grafana-agent/entrypoint.sh
  aegis/grafana-agent/grafana-agent.yaml
  aegis/grafana-agent/passive-health.sh
  aegis/grafana-agent/preflight.mjs
  aegis/package.json
  package.json
  terraform/.gitignore
  terraform/.terraform.lock.hcl
  terraform/aegis-bootstrap.tf
  terraform/providers.tf
  terraform/terraform.tfvars.example
  terraform/variables.tf
)
snapshot_root=""

cleanup_snapshot() {
  if [[ -n "$snapshot_root" ]]; then
    rm -rf "$snapshot_root"
  fi
}

assert_current_main() {
  local root="$1"
  local branch
  local head
  local origin_main

  branch="$(git -C "$root" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "main" ]]; then
    echo "Refusing production Alloy deploy: checkout branch is $branch, expected main." >&2
    return 1
  fi

  if ! git -C "$root" fetch --quiet origin \
    "+refs/heads/main:refs/remotes/origin/main"; then
    echo "Refusing production Alloy deploy: could not refresh origin/main." >&2
    return 1
  fi

  head="$(git -C "$root" rev-parse HEAD)"
  origin_main="$(git -C "$root" rev-parse origin/main)"
  if [[ "$head" != "$origin_main" ]]; then
    echo "Refusing production Alloy deploy: HEAD does not match current origin/main." >&2
    return 1
  fi
}

assert_source_ready() {
  local root="$1"
  local expected_head="$2"
  local status
  local head

  # Refresh remote state before the final worktree read. A fetch can take long
  # enough for another local process to edit an uploaded file; checking status
  # first would leave that edit undetected.
  assert_current_main "$root"

  if ! status="$(git -C "$root" status --porcelain)"; then
    echo "Refusing production Alloy deploy: could not verify the working tree." >&2
    return 1
  fi
  if [[ -n "$status" ]]; then
    echo "Refusing production Alloy deploy: working tree changed after preflight." >&2
    return 1
  fi

  head="$(git -C "$root" rev-parse HEAD)"
  if [[ "$head" != "$expected_head" ]]; then
    echo "Refusing production Alloy deploy: source HEAD changed after preflight." >&2
    return 1
  fi
}

materialize_source_snapshot() {
  local root="$1"
  local commit="$2"
  local destination="$3"
  local snapshot_source="$destination/aegis/grafana-agent"
  local actual_files
  local expected_files

  mkdir -p "$destination"
  git -C "$root" archive --format=tar "$commit" -- "${snapshot_files[@]}" |
    tar -xf - -C "$destination"
  git -C "$root" show \
    "$commit:aegis/grafana-agent/cloudbuild.yaml" \
    >"$destination/cloudbuild.yaml"

  actual_files="$(
    find "$snapshot_source" -type f -print |
      sed "s#^$snapshot_source/##" |
      LC_ALL=C sort
  )"
  expected_files="$(
    printf '%s\n' \
      Dockerfile \
      config.alloy \
      entrypoint.sh \
      grafana-agent.yaml \
      passive-health.sh
  )"
  if [[ "$actual_files" != "$expected_files" ]]; then
    echo "Refusing production Alloy deploy: immutable source snapshot has unexpected files." >&2
    return 1
  fi
}

materialize_verifier_snapshot() {
  local root="$1"
  local commit="$2"
  local destination="$3"
  local legacy_seed_entry

  if ! legacy_seed_entry="$(
    git -C "$root" ls-tree --name-only "$commit" -- "$legacy_seed_path"
  )"; then
    echo "Refusing production Alloy deploy: could not prove the retired legacy seed writer is absent." >&2
    return 1
  fi
  if [[ -n "$legacy_seed_entry" ]]; then
    echo "Refusing production Alloy deploy: source commit retains the retired legacy seed writer." >&2
    return 1
  fi

  mkdir -p "$destination"
  git -C "$root" archive --format=tar "$commit" -- "${verifier_files[@]}" |
    tar -xf - -C "$destination"
}

wait_for_collector_health() {
  local service_url="$1"
  local attempts=12
  local body

  while ((attempts > 0)); do
    if body="$(curl -fsS --max-time 10 "${service_url}/-/healthy")"; then
      if [[ "$body" != "collector-passive" ]]; then
        return 0
      fi
    fi
    attempts=$((attempts - 1))
    sleep 5
  done
  return 1
}

version_is_stopped() {
  local version="$1"
  local status

  if ! status="$(
    gcloud app versions describe "$version" \
      --project "$project" \
      --service grafana-agent \
      --format='value(servingStatus)'
  )"; then
    return 1
  fi
  [[ "$status" == "STOPPED" ]]
}

stop_and_prove_version() {
  local version="$1"

  if ! gcloud app versions stop "$version" \
    --project "$project" \
    --service grafana-agent \
    --quiet; then
    return 1
  fi
  version_is_stopped "$version"
}

print_manual_stop_commands() {
  local version="$1"

  printf '%s\n' \
    "  gcloud app versions stop $version --project $project --service grafana-agent --quiet && \\" \
    "    serving_status=\"\$(gcloud app versions describe $version --project $project --service grafana-agent --format='value(servingStatus)')\" && \\" \
    "    test \"\$serving_status\" = STOPPED"
}

cleanup_unpromoted_target() {
  local version="$1"

  echo "Stopping unpromoted passive target: $version" >&2
  if stop_and_prove_version "$version"; then
    return 0
  fi
  echo "Automatic cleanup halted: passive target could not be proven STOPPED." >&2
  echo "Manual passive-target cleanup:" >&2
  print_manual_stop_commands "$version" >&2
  return 1
}

stop_other_collectors() {
  local target_version="$1"
  local other_version
  local other_versions

  if ! other_versions="$(
    gcloud app versions list \
      --project "$project" \
      --service grafana-agent \
      --filter="version.servingStatus=SERVING AND version.id!=${target_version}" \
      --format='value(version.id)'
  )"; then
    echo "Could not inventory serving collector versions; refusing activation." >&2
    return 1
  fi
  while IFS= read -r other_version; do
    [[ -z "$other_version" ]] && continue
    if ! gcloud app versions stop "$other_version" \
      --project "$project" \
      --service grafana-agent \
      --quiet; then
      return 1
    fi
    if ! version_is_stopped "$other_version"; then
      return 1
    fi
  done <<<"$other_versions"
}

verify_restart_target() {
  local verifier_root="$1"
  local restart_version="$2"

  node "$verifier_root/aegis/grafana-agent/preflight.mjs" \
    --project "$project" \
    --version "$restart_version"
}

verify_restored_target() {
  local verifier_root="$1"
  local restored_version="$2"

  node "$verifier_root/aegis/grafana-agent/preflight.mjs" \
    --project "$project" \
    --version "$restored_version" \
    --version-traffic full
}

print_manual_rollback_commands() {
  local previous_version="$1"
  local target_version="$2"

  [[ -z "$previous_version" ]] && return 0
  printf '%s\n' \
    "  gcloud app versions stop $target_version --project $project --service grafana-agent --quiet && \\" \
    "    serving_status=\"\$(gcloud app versions describe $target_version --project $project --service grafana-agent --format='value(servingStatus)')\" && \\" \
    "    test \"\$serving_status\" = STOPPED && \\" \
    "    peer_versions=\"\$(gcloud app versions list --project $project --service grafana-agent --filter='version.servingStatus=SERVING AND version.id!=${previous_version}' --format='value(version.id)')\" && \\" \
    "    for peer_version in \$peer_versions; do \\" \
    "      gcloud app versions stop \"\$peer_version\" --project $project --service grafana-agent --quiet && \\" \
    "        peer_status=\"\$(gcloud app versions describe \"\$peer_version\" --project $project --service grafana-agent --format='value(servingStatus)')\" && \\" \
    "        test \"\$peer_status\" = STOPPED || exit 1; \\" \
    "    done && \\" \
    "    (pnpm --dir \"$repo_root\" aegis:agent:preflight -- --version $previous_version --version-traffic full || \\" \
    "      (pnpm --dir \"$repo_root\" aegis:agent:preflight -- --version $previous_version && \\" \
    "        gcloud app versions start $previous_version --project $project --service grafana-agent --quiet && \\" \
    "        gcloud app services set-traffic grafana-agent --project $project --splits ${previous_version}=1))"
}

rollback_cutover() {
  local previous_version="$1"
  local target_version="$2"
  local verifier_root="$3"

  echo "Cutover failed; restoring the previous collector." >&2
  if ! gcloud app versions stop "$target_version" \
    --project "$project" \
    --service grafana-agent \
    --quiet ||
    ! version_is_stopped "$target_version"; then
    echo "Automatic rollback halted: target collector could not be proven STOPPED." >&2
    if [[ -n "$previous_version" ]]; then
      echo "Manual stop-before-start recovery:" >&2
      print_manual_rollback_commands "$previous_version" "$target_version" >&2
    fi
    return 1
  fi

  if [[ -n "$previous_version" ]]; then
    if ! stop_other_collectors "$previous_version"; then
      echo "Automatic rollback halted: another collector could not be proven STOPPED." >&2
      echo "Manual stop-before-start recovery:" >&2
      print_manual_rollback_commands "$previous_version" "$target_version" >&2
      return 1
    fi
    if verify_restored_target "$verifier_root" "$previous_version"; then
      echo "Previous collector already owns full traffic; rollback is restored." >&2
      return 0
    fi
    if ! verify_restart_target "$verifier_root" "$previous_version"; then
      echo "Automatic rollback halted: previous collector failed pinned-identity and zero-traffic preflight." >&2
      echo "Manual stop-before-start recovery:" >&2
      print_manual_rollback_commands "$previous_version" "$target_version" >&2
      return 1
    fi
    if ! gcloud app versions start "$previous_version" \
      --project "$project" \
      --service grafana-agent \
      --quiet; then
      return 1
    fi
    if ! gcloud app services set-traffic grafana-agent \
      --project "$project" \
      --splits "${previous_version}=1"; then
      return 1
    fi
  fi
}

main() {
  # shellcheck source=scripts/lib/deploy-guard.sh
  source "$repo_root/scripts/lib/deploy-guard.sh"
  assert_current_main "$repo_root"

  cd "$agent_dir"

  local short_sha
  local version
  local previous_version
  local confirmation
  local source_head
  local snapshot_source_dir
  local verifier_root
  local default_hostname
  local service_url
  source_head="$(git -C "$repo_root" rev-parse HEAD)"
  short_sha="$(git -C "$repo_root" rev-parse --short=7 HEAD)"
  version="r-${short_sha}-$(date +%s)"
  previous_version="$(
    gcloud app versions list \
      --project "$project" \
      --service grafana-agent \
      --filter='traffic_split>0' \
      --sort-by='~version.createTime' \
      --limit=1 \
      --format='value(version.id)'
  )"

  node "$agent_dir/contract.mjs"
  node "$agent_dir/preflight.mjs" --project "$project"

  echo "━━━ Grafana Alloy App Engine Deploy ━━━"
  echo "Project:          $project"
  echo "Commit:           $(git -C "$repo_root" rev-parse HEAD)"
  echo "Target version:   $version"
  echo "Previous version: ${previous_version:-none}"
  echo "Verify before promotion:"
  echo "  pnpm aegis:agent:preflight -- --version $version"
  if [[ -n "$previous_version" ]]; then
    echo "Stop-before-start rollback:"
    print_manual_rollback_commands "$previous_version" "$version"
  fi
  echo
  read -r -p "Type 'deploy' to submit this production build: " confirmation
  if [[ "$confirmation" != "deploy" ]]; then
    echo "Aborted."
    return 0
  fi

  # Close the confirmation TOCTOU window. Refresh origin/main, recheck the
  # worktree, and prove the submitted files still belong to the commit printed
  # above immediately before the first cloud mutation.
  assert_source_ready "$repo_root" "$source_head"

  snapshot_root="$(mktemp -d "${TMPDIR:-/tmp}/grafana-agent-deploy.XXXXXX")"
  trap cleanup_snapshot EXIT
  materialize_source_snapshot "$repo_root" "$source_head" "$snapshot_root"
  verifier_root="$snapshot_root/verification"
  materialize_verifier_snapshot "$repo_root" "$source_head" "$verifier_root"
  snapshot_source_dir="$snapshot_root/aegis/grafana-agent"

  if ! default_hostname="$(
    gcloud app describe \
      --project "$project" \
      --format='value(defaultHostname)'
  )"; then
    echo "Could not resolve the App Engine hostname; no version was submitted." >&2
    return 1
  fi
  service_url="https://grafana-agent-dot-${default_hostname}"

  if ! gcloud builds submit \
    --project "$project" \
    --config "$snapshot_root/cloudbuild.yaml" \
    --gcs-source-staging-dir="gs://${project}-cloud-build-source/alloy" \
    --substitutions "_VERSION=$version" \
    "$snapshot_source_dir"; then
    echo "Cloud Build failed; checking for a partially created passive target." >&2
    cleanup_unpromoted_target "$version" || true
    return 1
  fi

  # The build creates a passive version whose supervisor does not start Alloy
  # while its traffic allocation is zero. Verify using only captured committed
  # verifier code and contract inputs.
  if ! node "$verifier_root/aegis/grafana-agent/preflight.mjs" \
    --project "$project" \
    --version "$version"; then
    cleanup_unpromoted_target "$version" || true
    return 1
  fi

  if ! gcloud app services set-traffic grafana-agent \
    --project "$project" \
    --splits "${version}=1"; then
    rollback_cutover "$previous_version" "$version" "$verifier_root"
    return 1
  fi

  # The new supervisor remains passive until every other version reports
  # STOPPED. Assign 100% traffic atomically, then retire all older collectors.
  # This stop-before-start handoff prevents overlap but leaves a temporary
  # collection gap until the supervisor completes three safe polls or the
  # wrapper rolls back after 12 failed health attempts. --migrate cannot
  # establish the required full-allocation activation condition.
  if ! stop_other_collectors "$version"; then
    rollback_cutover "$previous_version" "$version" "$verifier_root"
    return 1
  fi

  if ! wait_for_collector_health "$service_url"; then
    rollback_cutover "$previous_version" "$version" "$verifier_root"
    return 1
  fi

  echo "Collector handoff verified and previous version stopped: $version"
  if [[ -n "$previous_version" ]]; then
    echo "Stop-before-start rollback remains available:"
    print_manual_rollback_commands "$previous_version" "$version"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

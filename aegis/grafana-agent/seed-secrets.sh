#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-mento-monitoring}"
FORCE="${FORCE:-0}"

usage() {
  cat <<'USAGE'
Seed Grafana Alloy remote-write Secret Manager versions.

The secret IDs and environment variable names intentionally retain the
grafana-agent prefix for compatibility with existing Terraform and deploy
automation.

Required environment variables:
  GRAFANA_AGENT_ENDPOINT
  GRAFANA_AGENT_USERNAME
  GRAFANA_AGENT_PASSWORD

Optional environment variables:
  PROJECT_ID  Target GCP project. Defaults to mento-monitoring.
  FORCE=1     Add a new version even when an enabled version already exists.

USAGE
}

require_env() {
  local name="$1"

  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    usage >&2
    exit 1
  fi
}

enabled_version_count() {
  local secret_id="$1"

  gcloud secrets versions list "${secret_id}" \
    --project "${PROJECT_ID}" \
    --filter 'state=enabled' \
    --format 'value(name)' |
    wc -l |
    tr -d ' '
}

add_secret_version() {
  local secret_id="$1"
  local value="$2"
  local version_count
  local tmp_file

  if ! gcloud secrets describe "${secret_id}" --project "${PROJECT_ID}" >/dev/null; then
    echo "Secret ${secret_id} does not exist in ${PROJECT_ID}. Run terraform apply first." >&2
    exit 1
  fi

  version_count="$(enabled_version_count "${secret_id}")"
  if [[ "${version_count}" != "0" && "${FORCE}" != "1" ]]; then
    echo "Secret ${secret_id} already has an enabled version in ${PROJECT_ID}; set FORCE=1 to rotate it." >&2
    return
  fi

  tmp_file="$(mktemp)"
  chmod 600 "${tmp_file}"
  printf '%s' "${value}" >"${tmp_file}"
  if ! gcloud secrets versions add "${secret_id}" --project "${PROJECT_ID}" --data-file "${tmp_file}" >/dev/null; then
    rm -f "${tmp_file}"
    exit 1
  fi
  rm -f "${tmp_file}"
  echo "Added version for ${secret_id} in ${PROJECT_ID}."
}

require_env GRAFANA_AGENT_ENDPOINT
require_env GRAFANA_AGENT_USERNAME
require_env GRAFANA_AGENT_PASSWORD

add_secret_version grafana-agent-endpoint "${GRAFANA_AGENT_ENDPOINT}"
add_secret_version grafana-agent-username "${GRAFANA_AGENT_USERNAME}"
add_secret_version grafana-agent-password "${GRAFANA_AGENT_PASSWORD}"

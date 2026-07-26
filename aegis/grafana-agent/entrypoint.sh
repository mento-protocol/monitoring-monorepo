#!/bin/sh
# entrypoint.sh - fetch Grafana Cloud credentials from Secret Manager at
# container activation, export them as env vars, and supervise Grafana Alloy.
# A manual-scaling App Engine version runs even with zero HTTP traffic, so
# traffic allocation is an explicit activation signal rather than a proxy for
# process lifecycle.
#
# Why runtime fetch instead of build-time substitution:
#   Previous flow rendered agent.yaml on the Cloud Build VM and shipped the
#   plaintext via `gcloud app deploy`. The rendered file then sat indefinitely
#   in (1) the App Engine source staging bucket and (2) the container image
#   layer in Artifact Registry — recoverable by anyone with read on either,
#   even after Secret Manager rotation. Fetching at runtime keeps secrets
#   in Secret Manager only.
#
# Required IAM: the effective App Engine version service account needs
# the custom `grafanaAgentActivationReader` role, containing only
# `appengine.services.get` and `appengine.versions.list`, to prove it has the
# full traffic allocation and every other collector version is stopped, plus
# `roles/secretmanager.secretAccessor` on each legacy grafana-agent-* secret:
#   - grafana-agent-endpoint
#   - grafana-agent-username
#   - grafana-agent-password
# Terraform grants the pinned `grafana-agent-runtime` service account access
# through `terraform/aegis-bootstrap.tf` →
# `grafana_agent_runtime_accessor`. AppSpot and build-principal grants remain
# temporarily for Phase A rollback only; the new version must not depend on
# them.

set -eu

GCP_PROJECT="${GOOGLE_CLOUD_PROJECT:-mento-monitoring}"
METADATA="http://metadata.google.internal/computeMetadata/v1"
HTTP_TIMEOUT=10
POLL_SECONDS=5
ACTIVE_GRACE_POLLS=3
SERVICE="${GAE_SERVICE:-grafana-agent}"
VERSION="${GAE_VERSION:?entrypoint: GAE_VERSION is required}"
PORT="${PORT:-8080}"
alloy_pid=""
passive_pid=""
active_observations=0

get_access_token() {
  token=$(curl -sfH "Metadata-Flavor: Google" --max-time "${HTTP_TIMEOUT}" \
    "${METADATA}/instance/service-accounts/default/token" |
    jq -r .access_token) || {
    echo "entrypoint: failed to obtain runtime access token" >&2
    return 1
  }
  if [ -z "${token}" ] || [ "${token}" = "null" ]; then
    echo "entrypoint: empty/null runtime access token" >&2
    return 1
  fi
  printf '%s' "${token}"
}

fetch_secret() {
  secret_name=$1
  access_token=$2
  payload=$(curl -sfH "Authorization: Bearer ${access_token}" --max-time "${HTTP_TIMEOUT}" \
    "https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${secret_name}/versions/latest:access" \
    | jq -r .payload.data) || {
    echo "entrypoint: curl/jq failed reaching Secret Manager for ${secret_name}" >&2
    exit 1
  }

  if [ -z "${payload}" ] || [ "${payload}" = "null" ]; then
    echo "entrypoint: empty/null payload reading secret ${secret_name}" >&2
    exit 1
  fi

  # `tr -d '\n'` strips a trailing newline that would otherwise become part
  # of the env var. The write-only Terraform path accepts exact operator input,
  # so this remains defensive against an accidental trailing newline.
  printf '%s' "${payload}" | base64 -d | tr -d '\n'
}

activation_is_safe() {
  access_token=$(get_access_token) || return 1
  service_metadata=$(curl -sfH "Authorization: Bearer ${access_token}" \
    --max-time "${HTTP_TIMEOUT}" \
    "https://appengine.googleapis.com/v1/apps/${GCP_PROJECT}/services/${SERVICE}") ||
    return 1

  printf '%s' "${service_metadata}" |
    jq -e --arg version "${VERSION}" \
      '.split.allocations[$version] == 1' >/dev/null ||
    return 1

  page_token=""
  seen_page_tokens='[]'
  page_count=0
  while :; do
    page_count=$((page_count + 1))
    # App Engine currently caps an app near 210 versions. This bound is far
    # above that quota but still fails closed if the API repeats page tokens.
    if [ "${page_count}" -gt 100 ]; then
      echo "entrypoint: version inventory exceeded 100 pages" >&2
      return 1
    fi

    versions_url="https://appengine.googleapis.com/v1/apps/${GCP_PROJECT}/services/${SERVICE}/versions?view=BASIC&pageSize=200"
    if [ -n "${page_token}" ]; then
      encoded_page_token=$(printf '%s' "${page_token}" | jq -sRr @uri) ||
        return 1
      versions_url="${versions_url}&pageToken=${encoded_page_token}"
    fi
    versions_metadata=$(curl -sfH "Authorization: Bearer ${access_token}" \
      --max-time "${HTTP_TIMEOUT}" "${versions_url}") ||
      return 1

    printf '%s' "${versions_metadata}" |
      jq -e --arg version "${VERSION}" \
        '((.versions // []) | type) == "array" and ([.versions[]? | select(.id != $version and .servingStatus != "STOPPED")] | length == 0)' \
        >/dev/null ||
      return 1
    next_page_token=$(printf '%s' "${versions_metadata}" |
      jq -er '(.nextPageToken // "") | select(type == "string")') ||
      return 1
    [ -z "${next_page_token}" ] && break
    if printf '%s' "${seen_page_tokens}" |
      jq -e --arg token "${next_page_token}" 'index($token) != null' \
        >/dev/null; then
      echo "entrypoint: version inventory repeated a page token" >&2
      return 1
    fi
    seen_page_tokens=$(printf '%s' "${seen_page_tokens}" |
      jq -c --arg token "${next_page_token}" '. + [$token]') ||
      return 1
    page_token="${next_page_token}"
  done
}

start_passive() {
  if [ -n "${passive_pid}" ] && kill -0 "${passive_pid}" 2>/dev/null; then
    return
  fi
  socat "TCP-LISTEN:${PORT},reuseaddr,fork" \
    SYSTEM:/usr/local/bin/passive-health.sh &
  passive_pid=$!
  echo "entrypoint: version ${VERSION} is passive"
}

stop_passive() {
  if [ -n "${passive_pid}" ]; then
    kill "${passive_pid}" 2>/dev/null || true
    wait "${passive_pid}" 2>/dev/null || true
    passive_pid=""
  fi
}

start_alloy() {
  access_token=$(get_access_token)
  GRAFANA_AGENT_ENDPOINT=$(fetch_secret grafana-agent-endpoint "${access_token}")
  GRAFANA_AGENT_USERNAME=$(fetch_secret grafana-agent-username "${access_token}")
  GRAFANA_AGENT_PASSWORD=$(fetch_secret grafana-agent-password "${access_token}")
  export GRAFANA_AGENT_ENDPOINT GRAFANA_AGENT_USERNAME GRAFANA_AGENT_PASSWORD

  stop_passive
  # Alloy v1.16.1 rejects the older-looking bare --disable-support-bundle flag;
  # use the namespaced server.http flag exposed by `alloy run --help`.
  /bin/alloy run \
    --server.http.listen-addr="0.0.0.0:${PORT}" \
    --server.http.enable-pprof=false \
    --server.http.disable-support-bundle=true \
    --server.http.ui-path-prefix=/-/alloy \
    --storage.path=/var/lib/alloy/data \
    /etc/alloy/config.alloy &
  alloy_pid=$!
  echo "entrypoint: collector activated for version ${VERSION}"
}

stop_alloy() {
  if [ -n "${alloy_pid}" ]; then
    kill "${alloy_pid}" 2>/dev/null || true
    wait "${alloy_pid}" 2>/dev/null || true
    alloy_pid=""
    unset GRAFANA_AGENT_ENDPOINT GRAFANA_AGENT_USERNAME GRAFANA_AGENT_PASSWORD
    echo "entrypoint: collector deactivated for version ${VERSION}"
  fi
}

cleanup() {
  stop_alloy
  stop_passive
}
trap cleanup EXIT
trap 'exit 143' TERM INT

main() {
  start_passive
  while :; do
    if [ -n "${alloy_pid}" ] && ! kill -0 "${alloy_pid}" 2>/dev/null; then
      echo "entrypoint: Alloy exited unexpectedly" >&2
      exit 1
    fi

    if activation_is_safe; then
      active_observations=$((active_observations + 1))
      if [ -z "${alloy_pid}" ]; then
        if [ "${active_observations}" -ge "${ACTIVE_GRACE_POLLS}" ]; then
          start_alloy
        fi
      fi
    else
      active_observations=0
      stop_alloy
      start_passive
    fi
    sleep "${POLL_SECONDS}"
  done
}

if [ "${ENTRYPOINT_SOURCE_ONLY:-0}" != "1" ]; then
  main "$@"
fi

#!/bin/sh
# entrypoint.sh - fetch Grafana Cloud credentials from Secret Manager at
# container start, export them as env vars, then exec Grafana Alloy. The Alloy
# config reads these values with sys.env().
#
# Why runtime fetch instead of build-time substitution:
#   Previous flow rendered agent.yaml on the Cloud Build VM and shipped the
#   plaintext via `gcloud app deploy`. The rendered file then sat indefinitely
#   in (1) the App Engine source staging bucket and (2) the container image
#   layer in Artifact Registry — recoverable by anyone with read on either,
#   even after Secret Manager rotation. Fetching at runtime keeps secrets
#   in Secret Manager only.
#
# Required IAM: the App Engine default service account
# (`<project>@appspot.gserviceaccount.com`) needs
# `roles/secretmanager.secretAccessor` on each legacy grafana-agent-* secret:
#   - grafana-agent-endpoint
#   - grafana-agent-username
#   - grafana-agent-password
# Provisioned by `terraform/aegis-bootstrap.tf` → `grafana_agent_appspot_accessor`.
#
# Why the AppSpot SA, not the Compute default SA: App Engine Flex apps run as
# the App Engine default service account (`<project>@appspot.gserviceaccount.com`)
# even though the underlying GCE VM runs as the Compute Engine default SA.
# The metadata server inside the application context returns the App Engine
# SA's token, so that's the identity that needs the Secret Manager binding.

set -eu

GCP_PROJECT="${GOOGLE_CLOUD_PROJECT:-mento-monitoring}"
METADATA="http://metadata.google.internal/computeMetadata/v1"
HTTP_TIMEOUT=10

# Get an access token from the App Engine default service account via the
# GCE metadata server. --max-time bounds the request so a transient
# metadata-server outage doesn't wedge the container indefinitely (no
# health-check responses, no logs, no rotation possible). The `|| { ... }`
# guard catches transport-layer failures (DNS, TCP, timeout) which would
# otherwise leave `token` empty and produce a confusing downstream null check.
token=$(curl -sfH "Metadata-Flavor: Google" --max-time "${HTTP_TIMEOUT}" \
  "${METADATA}/instance/service-accounts/default/token" \
  | jq -r .access_token) || {
  echo "entrypoint: curl/jq failed reaching metadata server for access token" >&2
  exit 1
}

if [ -z "${token}" ] || [ "${token}" = "null" ]; then
  echo "entrypoint: empty/null access token from metadata server" >&2
  exit 1
fi

fetch_secret() {
  secret_name=$1
  payload=$(curl -sfH "Authorization: Bearer ${token}" --max-time "${HTTP_TIMEOUT}" \
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
  # of the env var. The seed-secrets script uses `printf '%s'` so this should
  # be a no-op in steady state — defensive against future seed paths or
  # manual `gcloud secrets versions add` invocations using `echo` (adds \n).
  printf '%s' "${payload}" | base64 -d | tr -d '\n'
}

GRAFANA_AGENT_ENDPOINT=$(fetch_secret grafana-agent-endpoint)
GRAFANA_AGENT_USERNAME=$(fetch_secret grafana-agent-username)
GRAFANA_AGENT_PASSWORD=$(fetch_secret grafana-agent-password)

export GRAFANA_AGENT_ENDPOINT GRAFANA_AGENT_USERNAME GRAFANA_AGENT_PASSWORD

exec /bin/alloy run \
  --server.http.listen-addr=0.0.0.0:8080 \
  --server.http.enable-pprof=false \
  --server.http.disable-support-bundle=true \
  --server.http.ui-path-prefix=/-/alloy \
  --storage.path=/var/lib/alloy/data \
  /etc/alloy/config.alloy

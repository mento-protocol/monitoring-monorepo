#!/bin/sh
# entrypoint.sh — fetch Grafana Cloud credentials from Secret Manager at
# container start, export as env vars, then exec grafana-agent with
# `-config.expand-env=true` so the agent substitutes `${VAR}` references
# in agent.yaml at startup.
#
# Why runtime fetch instead of build-time substitution:
#   Previous flow rendered agent.yaml on the Cloud Build VM and shipped the
#   plaintext via `gcloud app deploy`. The rendered file then sat indefinitely
#   in (1) the App Engine source staging bucket and (2) the container image
#   layer in Artifact Registry — recoverable by anyone with read on either,
#   even after Secret Manager rotation. Fetching at runtime keeps secrets
#   in Secret Manager only.
#
# Required IAM: the App Engine Flex compute service account
# (`<project-number>-compute@developer.gserviceaccount.com`) needs
# `roles/secretmanager.secretAccessor` on each of:
#   - grafana-agent-endpoint
#   - grafana-agent-username
#   - grafana-agent-password
# Provisioned by `terraform/main.tf` → `grafana_agent_cloudbuild_compute_accessor`.

set -eu

GCP_PROJECT="${GOOGLE_CLOUD_PROJECT:-mento-monitoring}"
METADATA="http://metadata.google.internal/computeMetadata/v1"

# Get an access token from the App Engine Flex compute service account via
# the GCE metadata server. -f ensures non-2xx fails the pipe.
token=$(curl -sfH "Metadata-Flavor: Google" \
  "${METADATA}/instance/service-accounts/default/token" \
  | jq -r .access_token)

if [ -z "${token}" ] || [ "${token}" = "null" ]; then
  echo "entrypoint: failed to get GCP access token from metadata server" >&2
  exit 1
fi

fetch_secret() {
  secret_name=$1
  payload=$(curl -sfH "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets/${secret_name}/versions/latest:access" \
    | jq -r .payload.data)

  if [ -z "${payload}" ] || [ "${payload}" = "null" ]; then
    echo "entrypoint: failed to read secret ${secret_name}" >&2
    exit 1
  fi

  printf '%s' "${payload}" | base64 -d
}

GRAFANA_AGENT_ENDPOINT=$(fetch_secret grafana-agent-endpoint)
GRAFANA_AGENT_USERNAME=$(fetch_secret grafana-agent-username)
GRAFANA_AGENT_PASSWORD=$(fetch_secret grafana-agent-password)

export GRAFANA_AGENT_ENDPOINT GRAFANA_AGENT_USERNAME GRAFANA_AGENT_PASSWORD

exec /bin/grafana-agent \
  -config.file=/etc/agent/agent.yaml \
  -config.expand-env=true \
  -server.http.address=0.0.0.0:8080

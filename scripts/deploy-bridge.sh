#!/usr/bin/env bash
# Build, push, and deploy the metrics-bridge container to Cloud Run.
#
# Usage:
#   pnpm bridge:deploy           → build + deploy (with confirmation)
#   pnpm bridge:deploy --yes     → skip confirmation (CI / agent friendly)
#
# Prerequisites:
#   - gcloud CLI authenticated with access to the monitoring project
#   - terraform.tfvars configured with GCP bootstrap variables
#
# Flow:
#   1. Build image via Cloud Build → push to Artifact Registry
#   2. terraform apply with the new image ref → Cloud Run rolls a new revision

set -euo pipefail

PROJECT="${GCP_PROJECT:-mento-monitoring}"
REGION="${GCP_REGION:-europe-west1}"
AR_REPO="${REGION}-docker.pkg.dev/${PROJECT}/metrics-bridge"
TAG="$(git rev-parse --short HEAD)"
IMAGE="${AR_REPO}/metrics-bridge:${TAG}"
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) SKIP_CONFIRM=true; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

echo "━━━ Metrics Bridge Deploy ━━━"
echo "Project:  ${PROJECT}"
echo "Image:    ${IMAGE}"
echo ""

if [ "$SKIP_CONFIRM" = false ]; then
  read -rp "Build and deploy? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "Building container image via Cloud Build..."
gcloud builds submit \
  --project="$PROJECT" \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" \
  --timeout=600s \
  .

echo ""
echo "Deploying to Cloud Run via Terraform..."

TF_ARGS="-var=metrics_bridge_image=${IMAGE}"
if [ "$SKIP_CONFIRM" = true ]; then
  TF_ARGS="${TF_ARGS} -auto-approve"
fi

terraform -chdir=terraform apply $TF_ARGS

echo ""
echo "Done. Service URL:"
terraform -chdir=terraform output -raw metrics_bridge_url
echo ""

#!/usr/bin/env bash
# Build and deploy the metrics-bridge container to Google Cloud Run.
#
# Usage:
#   pnpm bridge:deploy                → build, push, and deploy (with confirmation)
#   pnpm bridge:deploy --yes          → skip confirmation prompt (CI / agent friendly)
#   pnpm bridge:deploy --tag v1.2.3   → deploy with a specific image tag
#
# Prerequisites:
#   - gcloud CLI authenticated with mento-prod project access
#   - terraform.tfvars configured with gcp_project_id

set -euo pipefail

PROJECT="${GCP_PROJECT:-monitoring}"
REGION="${GCP_REGION:-europe-west1}"
REPO="metrics-bridge"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/metrics-bridge"
TAG="latest"
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) SKIP_CONFIRM=true; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

echo "━━━ Metrics Bridge Deploy ━━━"
echo "Project:  ${PROJECT}"
echo "Region:   ${REGION}"
echo "Image:    ${IMAGE}:${TAG}"
echo ""

if [ "$SKIP_CONFIRM" = false ]; then
  read -rp "Deploy metrics-bridge to Cloud Run? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
  fi
fi

echo "Building container image..."
gcloud builds submit \
  --project "$PROJECT" \
  --tag "${IMAGE}:${TAG}" \
  --timeout=600s \
  --dockerfile=metrics-bridge/Dockerfile \
  .

echo "Deploying to Cloud Run via Terraform..."
terraform -chdir=terraform apply \
  -var="metrics_bridge_image=${IMAGE}:${TAG}" \
  -target='google_cloud_run_v2_service.metrics_bridge[0]' \
  -target='google_cloud_run_v2_service_iam_member.metrics_bridge_public[0]'

echo ""
echo "Done. Run 'terraform -chdir=terraform output metrics_bridge_url' to get the service URL."

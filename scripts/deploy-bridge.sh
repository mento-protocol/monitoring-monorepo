#!/usr/bin/env bash
# Build and deploy the metrics-bridge container to Cloud Run.
#
# Handles both first-time bootstrap and subsequent deploys:
#   1. Ensures GCP project + APIs + Artifact Registry exist (terraform apply)
#   2. Builds and pushes the container image (gcloud builds submit)
#   3. Deploys Cloud Run with the new image (terraform apply)
#
# Usage:
#   pnpm bridge:deploy           → build + deploy (with confirmation)
#   pnpm bridge:deploy --yes     → skip confirmation (CI / agent friendly)
#
# Prerequisites:
#   - gcloud CLI authenticated with access to the monitoring project
#   - terraform.tfvars configured with GCP bootstrap variables

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

TF_APPROVE=""
if [ "$SKIP_CONFIRM" = true ]; then
  TF_APPROVE="-auto-approve"
fi

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

# Step 1: Ensure GCP infra + IAM exists (project, APIs, AR repo, dev permissions).
# On subsequent runs this is a no-op.
echo "Ensuring GCP infrastructure..."
terraform -chdir=terraform apply $TF_APPROVE \
  -target=google_project.monitoring \
  -target=google_project_service.run \
  -target=google_project_service.artifactregistry \
  -target=google_project_service.cloudbuild \
  -target=google_artifact_registry_repository.metrics_bridge \
  -target=google_project_iam_member.dev_run_admin \
  -target=google_project_iam_member.dev_ar_writer \
  -target=google_project_iam_member.dev_cloudbuild_editor

# Step 2: Build and push the image.
echo ""
echo "Building container image via Cloud Build..."
gcloud builds submit \
  --project="$PROJECT" \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" \
  --timeout=600s \
  .

# Step 3: Deploy Cloud Run with the new image.
echo ""
echo "Deploying to Cloud Run..."
terraform -chdir=terraform apply $TF_APPROVE \
  -var="metrics_bridge_image=${IMAGE}"

echo ""
echo "Done. Service URL:"
terraform -chdir=terraform output -raw metrics_bridge_url
echo ""

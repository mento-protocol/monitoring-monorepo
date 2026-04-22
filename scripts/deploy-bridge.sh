#!/usr/bin/env bash
# Build and deploy the metrics-bridge container to Cloud Run.
#
# Handles both first-time bootstrap and subsequent deploys:
#   1. Ensures GCP project + APIs + Artifact Registry + Cloud Run service
#      exist (terraform apply). On first run the service boots with the
#      bootstrap image from var.metrics_bridge_image (gcr.io/cloudrun/hello).
#   2. Builds and pushes the container image (gcloud builds submit).
#   3. Rolls a new revision via `gcloud run services update --image=<digest>`.
#      Image rollouts are intentionally OUT OF terraform — the CR resource
#      has `lifecycle.ignore_changes = [... image]` so `pnpm infra:apply`
#      never reverts the image back to the bootstrap placeholder.
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

# Step 1: Ensure GCP infra + IAM + Cloud Run service shape exist. On
# subsequent runs this is a no-op (terraform ignores image drift via
# `lifecycle.ignore_changes`, so the current running image is preserved
# even though `var.metrics_bridge_image` defaults to the bootstrap placeholder).
echo "Ensuring GCP infrastructure..."
terraform -chdir=terraform apply $TF_APPROVE \
  -target=google_project.monitoring \
  -target=google_project_service.run \
  -target=google_project_service.artifactregistry \
  -target=google_project_service.cloudbuild \
  -target=google_artifact_registry_repository.metrics_bridge \
  -target=google_project_iam_member.dev_run_admin \
  -target=google_project_iam_member.dev_ar_writer \
  -target=google_project_iam_member.dev_cloudbuild_editor \
  -target=google_cloud_run_v2_service.metrics_bridge \
  -target=google_cloud_run_v2_service_iam_member.metrics_bridge_public

# Step 2: Build and push the image.
echo ""
echo "Building container image via Cloud Build..."
gcloud builds submit \
  --project="$PROJECT" \
  --config=cloudbuild.yaml \
  --substitutions="_IMAGE=${IMAGE}" \
  --timeout=600s \
  .

# Resolve to digest so Cloud Run always rolls a new revision.
DIGEST=$(gcloud artifacts docker images describe "$IMAGE" \
  --project="$PROJECT" \
  --format='value(image_summary.digest)')
IMAGE_BY_DIGEST="${AR_REPO}/metrics-bridge@${DIGEST}"
echo "Resolved: ${IMAGE_BY_DIGEST}"

# Step 3: Roll a new Cloud Run revision with the new image.
# This deliberately bypasses terraform — the service resource has
# `lifecycle.ignore_changes = [template[0].containers[0].image]`, so
# `terraform apply -var=metrics_bridge_image=...` would be a no-op.
#
# Rollback: gcloud run services update-traffic metrics-bridge \
#   --to-revisions=<prev-revision>=100 --region="$REGION"
echo ""
echo "Rolling Cloud Run revision..."
gcloud run services update metrics-bridge \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_BY_DIGEST"

echo ""
echo "Recent revisions (for rollback reference):"
gcloud run revisions list \
  --service=metrics-bridge \
  --project="$PROJECT" \
  --region="$REGION" \
  --limit=3 \
  --format='table(name, creationTimestamp.date(tz=UTC), active)'

echo ""
echo "Done. Service URL:"
terraform -chdir=terraform output -raw metrics_bridge_url
echo ""

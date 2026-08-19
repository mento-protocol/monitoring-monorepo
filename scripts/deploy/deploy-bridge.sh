#!/usr/bin/env bash
# Build and deploy the metrics-bridge container to Cloud Run.
#
# Handles both first-time bootstrap and subsequent deploys:
#   1. Reconciles GCP project APIs, Artifact Registry, and IAM with Terraform,
#      then verifies the Cloud Run service. Only a confirmed first run creates
#      the service with the bootstrap image from var.metrics_bridge_image
#      (gcr.io/cloudrun/hello).
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
GRAFANA_AGENT_SOURCE_READER_TARGET="google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer[\"serviceAccount:grafana-agent-builder@${PROJECT}.iam.gserviceaccount.com\"]"
METRICS_BRIDGE_SOURCE_READER_TARGET="google_storage_bucket_iam_member.cloud_build_source_executor_object_viewer[\"serviceAccount:metrics-bridge-builder@${PROJECT}.iam.gserviceaccount.com\"]"
METRICS_BRIDGE_SERVICE_ADDRESS="google_cloud_run_v2_service.metrics_bridge"
METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS="google_cloud_run_v2_service_iam_member.metrics_bridge_public"
SKIP_CONFIRM=false
SERVICE_BOOTSTRAP_PLAN=""
PUBLIC_BINDING_PLAN=""

cleanup() {
  if [[ -n "$SERVICE_BOOTSTRAP_PLAN" ]]; then
    rm -f -- "$SERVICE_BOOTSTRAP_PLAN"
  fi
  if [[ -n "$PUBLIC_BINDING_PLAN" ]]; then
    rm -f -- "$PUBLIC_BINDING_PLAN"
  fi
}
trap cleanup EXIT

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

# shellcheck source=scripts/lib/deploy-guard.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/deploy-guard.sh"

# Anchor all subsequent terraform/gcloud mutations to the guarded repo root so
# the guard and the deploy operate on the same checkout regardless of caller CWD.
REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Compute TAG after cd so git rev-parse targets the guarded checkout.
TAG="$(git rev-parse --short HEAD)"
IMAGE="${AR_REPO}/metrics-bridge:${TAG}"

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

# Step 1a: Reconcile the GCP APIs, build/runtime IAM, source staging, and the
# Peg-policy bucket IAM dependency used by both first-time and routine deploys.
# Keep the Cloud Run service out of this routine bootstrap apply. Full platform
# review owns its two-phase service-shape rollouts; the deploy path owns image
# and generated revision-name bookkeeping before the intended image rollout.
# Target the two dedicated source-reader instances, not their whole for_each
# collection. A broad target could enact a pending sibling removal before its
# separately approved full platform apply.
echo "Ensuring GCP infrastructure..."
terraform -chdir=terraform apply $TF_APPROVE \
  -target=google_project.monitoring \
  -target=google_project_service.run \
  -target=google_project_service.artifactregistry \
  -target=google_project_service.cloudbuild \
  -target=google_project_service.storage \
  -target=google_artifact_registry_repository.metrics_bridge \
  -target=google_project_iam_member.metrics_bridge_builder \
  -target=google_artifact_registry_repository_iam_member.metrics_bridge_builder_writer \
  -target=google_storage_bucket.cloud_build_source_staging \
  -target=google_storage_bucket_iam_member.cloud_build_source_caller_bucket_reader \
  -target=google_storage_bucket_iam_member.cloud_build_source_caller_object_creator \
  -target="$GRAFANA_AGENT_SOURCE_READER_TARGET" \
  -target="$METRICS_BRIDGE_SOURCE_READER_TARGET" \
  -target=google_storage_bucket_iam_policy.peg_policy \
  -target=google_project_iam_member.dev_run_admin \
  -target=google_project_iam_member.dev_ar_writer \
  -target=google_project_iam_member.dev_cloudbuild_editor \
  -target=google_project_iam_member.dev_logging_viewer \
  -target=google_service_account_iam_member.dev_metrics_bridge_builder_service_account_user \
  -target=google_service_account_iam_member.dev_metrics_bridge_runtime_service_account_user

# Step 1b: A successful exact-name list distinguishes an existing service from
# a first bootstrap. Any gcloud/API/auth failure stops before another mutation.
echo "Checking Metrics Bridge Cloud Run service..."
if ! EXISTING_METRICS_BRIDGE_SERVICE="$(gcloud run services list \
  --project="$PROJECT" \
  --region="$REGION" \
  --filter='metadata.name=metrics-bridge' \
  --format='value(metadata.name)' \
  --limit=2)"; then
  echo "Unable to verify Metrics Bridge Cloud Run service state; refusing to deploy."
  exit 1
fi

# Classify Terraform ownership before acting on the live lookup. Saved plans
# below use -refresh=false and a strict JSON allowlist so a concurrent state
# change makes the plan stale instead of refreshing an existing live revision.
echo "Checking Metrics Bridge Terraform bootstrap state..."
if ! TERRAFORM_STATE_ADDRESSES="$(terraform -chdir=terraform state list)"; then
  echo "Unable to read Metrics Bridge Terraform state; refusing to deploy."
  exit 1
fi

case "$EXISTING_METRICS_BRIDGE_SERVICE" in
  metrics-bridge)
    if ! grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS" <<<"$TERRAFORM_STATE_ADDRESSES"; then
      echo "Cloud Run service exists but is not tracked in Terraform state; refusing to deploy."
      exit 1
    fi
    echo "Cloud Run service exists; preserving its live revision during Terraform reconciliation."
    ;;
  "")
    if grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS" <<<"$TERRAFORM_STATE_ADDRESSES"; then
      echo "Cloud Run service is tracked in Terraform state but missing live; run a reviewed platform plan/apply before deploying."
      exit 1
    fi
    echo "Cloud Run service is absent; bootstrapping it with Terraform..."
    SERVICE_BOOTSTRAP_PLAN="$(mktemp "${TMPDIR:-/tmp}/metrics-bridge-service-bootstrap.XXXXXX")"
    terraform -chdir=terraform plan \
      -refresh=false \
      -out="$SERVICE_BOOTSTRAP_PLAN" \
      -target=google_cloud_run_v2_service.metrics_bridge
    terraform -chdir=terraform show -json "$SERVICE_BOOTSTRAP_PLAN" \
      | node scripts/check-metrics-bridge-bootstrap-plan.mjs service
    terraform -chdir=terraform apply "$SERVICE_BOOTSTRAP_PLAN"
    rm -f -- "$SERVICE_BOOTSTRAP_PLAN"
    SERVICE_BOOTSTRAP_PLAN=""

    if ! CREATED_METRICS_BRIDGE_SERVICE="$(gcloud run services list \
      --project="$PROJECT" \
      --region="$REGION" \
      --filter='metadata.name=metrics-bridge' \
      --format='value(metadata.name)' \
      --limit=2)"; then
      echo "Unable to verify the created Metrics Bridge Cloud Run service; refusing to deploy."
      exit 1
    fi
    if [[ "$CREATED_METRICS_BRIDGE_SERVICE" != "metrics-bridge" ]]; then
      echo "Created Metrics Bridge Cloud Run service lookup was not exact; refusing to deploy."
      exit 1
    fi
    ;;
  *)
    echo "Unexpected Cloud Run service lookup result; refusing to deploy."
    exit 1
    ;;
esac

# Refresh state addresses after a successful service creation. This also proves
# that the saved plan recorded the exact service before binding recovery.
if ! TERRAFORM_STATE_ADDRESSES="$(terraform -chdir=terraform state list)"; then
  echo "Unable to verify Metrics Bridge Terraform state; refusing to deploy."
  exit 1
fi
if ! grep -Fqx -- "$METRICS_BRIDGE_SERVICE_ADDRESS" <<<"$TERRAFORM_STATE_ADDRESSES"; then
  echo "Cloud Run service is absent from Terraform state; refusing to deploy."
  exit 1
fi

# Step 1c: Resume an incomplete first bootstrap without refreshing the service.
# The saved-plan guard permits only creation of the public binding, so a pending
# template change or a live revision cannot slip into this recovery apply.
if grep -Fqx -- "$METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS" <<<"$TERRAFORM_STATE_ADDRESSES"; then
  echo "Public invoker binding is tracked in Terraform state."
else
  echo "Resuming incomplete public invoker binding bootstrap..."
  PUBLIC_BINDING_PLAN="$(mktemp "${TMPDIR:-/tmp}/metrics-bridge-public-bootstrap.XXXXXX")"
  terraform -chdir=terraform plan \
    -refresh=false \
    -out="$PUBLIC_BINDING_PLAN" \
    -target=google_cloud_run_v2_service_iam_member.metrics_bridge_public
  terraform -chdir=terraform show -json "$PUBLIC_BINDING_PLAN" \
    | node scripts/check-metrics-bridge-bootstrap-plan.mjs public-binding
  terraform -chdir=terraform apply "$PUBLIC_BINDING_PLAN"
  rm -f -- "$PUBLIC_BINDING_PLAN"
  PUBLIC_BINDING_PLAN=""

  if ! TERRAFORM_STATE_ADDRESSES="$(terraform -chdir=terraform state list)"; then
    echo "Unable to verify Metrics Bridge Terraform state after binding bootstrap."
    exit 1
  fi
  if ! grep -Fqx -- "$METRICS_BRIDGE_PUBLIC_BINDING_ADDRESS" <<<"$TERRAFORM_STATE_ADDRESSES"; then
    echo "Public invoker binding is still absent from Terraform state; refusing to deploy."
    exit 1
  fi
fi

# State presence proves Terraform ownership; the live policy check also catches
# later out-of-band binding drift before a private revision can be rolled out.
echo "Checking live Metrics Bridge public invoker binding..."
if ! LIVE_PUBLIC_INVOKER="$(gcloud run services get-iam-policy metrics-bridge \
  --project="$PROJECT" \
  --region="$REGION" \
  --flatten='bindings[].members' \
  --filter='bindings.role=roles/run.invoker AND bindings.members=allUsers' \
  --format='value(bindings.members)' \
  --limit=2)"; then
  echo "Unable to verify the live public invoker binding; refusing to deploy."
  exit 1
fi

case "$LIVE_PUBLIC_INVOKER" in
  allUsers)
    echo "Live public invoker binding verified."
    ;;
  "")
    echo "Public invoker binding is tracked but missing live; run a reviewed platform plan/apply before deploying."
    exit 1
    ;;
  *)
    echo "Unexpected public invoker lookup result; refusing to deploy."
    exit 1
    ;;
esac

# Step 2: Build and push the image.
echo ""
echo "Building container image via Cloud Build..."
gcloud builds submit \
  --project="$PROJECT" \
  --config=cloudbuild.yaml \
  --gcs-source-staging-dir="gs://${PROJECT}-cloud-build-source/metrics-bridge" \
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
# Revision name format: r-<short-sha>-<epoch>. The letter prefix is required
# because Cloud Run revision suffixes must start with [a-z], while raw git SHAs
# can start with a digit. Epoch disambiguates redeploys of the same commit.
REVISION_SUFFIX="r-${TAG}-$(date +%s)"
gcloud run services update metrics-bridge \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_BY_DIGEST" \
  --revision-suffix="$REVISION_SUFFIX"

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

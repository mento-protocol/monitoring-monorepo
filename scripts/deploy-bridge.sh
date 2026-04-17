#!/usr/bin/env bash
# Rebuild and deploy the metrics-bridge container via Terraform.
#
# Terraform handles the full lifecycle: project → APIs → AR → image build → Cloud Run.
# This script is a convenience wrapper that forces a rebuild and redeploy.
#
# Usage:
#   pnpm bridge:deploy           → rebuild image + redeploy (with confirmation)
#   pnpm bridge:deploy --yes     → skip confirmation prompt (CI / agent friendly)
#
# For first-time setup, run `pnpm infra:apply` instead — it bootstraps
# the entire GCP project, not just the bridge.

set -euo pipefail

SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) SKIP_CONFIRM=true; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

echo "━━━ Metrics Bridge Deploy ━━━"
echo ""
echo "This will rebuild the container image and redeploy to Cloud Run."
echo ""

if [ "$SKIP_CONFIRM" = false ]; then
  read -rp "Continue? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy] ]]; then
    echo "Aborted."
    exit 0
  fi
fi

terraform -chdir=terraform apply \
  -replace=null_resource.metrics_bridge_build \
  -target=null_resource.metrics_bridge_build \
  -target=google_cloud_run_v2_service.metrics_bridge \
  -target=google_cloud_run_v2_service_iam_member.metrics_bridge_public

echo ""
echo "Done. Service URL:"
terraform -chdir=terraform output -raw metrics_bridge_url
echo ""

#!/usr/bin/env bash
# Marathon launcher: bootstraps credentials from terraform.tfvars + Upstash
# mgmt API, exports env vars, exec's the requested stage script.
#
# Usage:
#   bash ui-dashboard/scripts/intel-marathon/run.sh baseline-snapshot
#   bash ui-dashboard/scripts/intel-marathon/run.sh tier1-bulk-enrich --chain 42220
#   bash ui-dashboard/scripts/intel-marathon/run.sh tier2-light-forensic --limit 150
#   bash ui-dashboard/scripts/intel-marathon/run.sh verify
#   bash ui-dashboard/scripts/intel-marathon/run.sh upload-drafts
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <stage> [args...]" >&2
  echo "Stages: baseline-snapshot, tier1-bulk-enrich, tier2-light-forensic, verify, upload-drafts, mirror-to-blob, migrate-rename" >&2
  exit 1
fi

STAGE="$1"
shift

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TFVARS="$REPO_ROOT/terraform/terraform.tfvars"
DB_ID="c687bf0d-f61f-498e-879a-016de335b4ce"

# Read tfvars-managed credentials.
extract() {
  grep -E "^$1" "$TFVARS" | sed 's/.*= *"//;s/"$//'
}
ARKHAM_API_KEY=$(extract arkham_api_key)
UPSTASH_EMAIL=$(extract upstash_email)
UPSTASH_API_KEY=$(extract upstash_api_key)

# Fetch the per-DB REST token from the Upstash mgmt API.
RESPONSE=$(curl -s -u "${UPSTASH_EMAIL}:${UPSTASH_API_KEY}" \
  "https://api.upstash.com/v2/redis/database/${DB_ID}")
UPSTASH_REDIS_REST_TOKEN=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['rest_token'])")
UPSTASH_ENDPOINT=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['endpoint'])")
UPSTASH_REDIS_REST_URL="https://${UPSTASH_ENDPOINT}"

export ARKHAM_API_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

# Dispatch.
case "$STAGE" in
  baseline-snapshot|baseline)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/baseline-snapshot.mjs" "$@"
    ;;
  tier1-bulk-enrich|tier1)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/tier1-bulk-enrich.mjs" "$@"
    ;;
  tier2-light-forensic|tier2)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/tier2-light-forensic.mjs" "$@"
    ;;
  verify)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/verify.mjs" "$@"
    ;;
  verify-libs)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/verify-libs.mjs" "$@"
    ;;
  inspect)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/inspect-hashes.mjs" "$@"
    ;;
  measure)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/measure-hash-bytes.mjs" "$@"
    ;;
  extract-entities|entities)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/extract-entities.mjs" "$@"
    ;;
  extract-transfers|transfers)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/extract-transfers.mjs" "$@"
    ;;
  extract-entity-cps|entity-cps)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/extract-entity-cps.mjs" "$@"
    ;;
  extract-wealth|wealth)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/extract-wealth.mjs" "$@"
    ;;
  extract-deep-transfers|deep-transfers)
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/extract-deep-transfers.mjs" "$@"
    ;;
  upload-drafts|tier0)
    bash "$SCRIPT_DIR/upload-drafts.sh"
    ;;
  mirror-to-blob|mirror)
    # Requires an explicit private-store token. The dashboard's production
    # backup/restore routes use Vercel Blob OIDC and no longer keep a static
    # Blob token in Terraform or project env vars.
    export BLOB_READ_WRITE_TOKEN
    cd "$REPO_ROOT"
    node "$SCRIPT_DIR/mirror-to-blob.mjs" "$@"
    ;;
  migrate-rename|rename)
    # One-shot migration: rename arkham_* Redis hash keys to intel_*.
    # Run BEFORE deploying the renamed dashboard code.
    cd "$REPO_ROOT"
    node ui-dashboard/scripts/migrate-rename-intel-hashes.mjs "$@"
    ;;
  *)
    echo "Unknown stage: $STAGE" >&2
    exit 1
    ;;
esac

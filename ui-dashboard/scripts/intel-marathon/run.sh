#!/usr/bin/env bash
# Marathon launcher: resolves credentials, exports env vars, exec's the
# requested stage script.
#
# Credentials come from the environment first. Anything still unset is read
# from terraform.tfvars (plus the Upstash mgmt API for the per-DB REST token),
# which exists only in a full clone — git worktrees have no terraform/ tree, so
# export the vars yourself there. A credential the stage needs and that is
# neither exported nor extractable is a named, fatal error.
#
#   ARKHAM_API_KEY                      ← tfvars `arkham_api_key`
#   UPSTASH_REDIS_REST_URL/_REST_TOKEN  ← Upstash mgmt API, itself authorized by
#                                         tfvars `upstash_email`/`upstash_api_key`
#
# `tier1-bulk-enrich --dry-run` never calls Arkham, so it needs no
# ARKHAM_API_KEY. It DOES still use Upstash when credentials resolve: the dry
# run reads the `labels` hash so its tier sizes are real, and this launcher
# still mints a REST token below when tfvars is readable. It writes nothing.
# With no credentials at all the dry run works too, reporting tier 1 as 0.
#
# Usage:
#   bash ui-dashboard/scripts/intel-marathon/run.sh baseline-snapshot
#   bash ui-dashboard/scripts/intel-marathon/run.sh tier1-bulk-enrich --dry-run
#   bash ui-dashboard/scripts/intel-marathon/run.sh tier1-bulk-enrich
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

# A dry run touches neither Arkham nor Upstash — resolve credentials
# best-effort so it works in a worktree with nothing exported.
DRY_RUN=0
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then DRY_RUN=1; fi
done

# Stages that never call Arkham (Upstash/Blob only) — the Arkham key is
# resolved best-effort for them so a worktree without it can still run them.
case "$STAGE" in
  verify | verify-libs | inspect | measure | mirror-to-blob | mirror | migrate-rename | rename | upload-drafts | tier0)
    NEEDS_ARKHAM=0
    ;;
  *)
    NEEDS_ARKHAM=1
    ;;
esac

# Resolve one credential: keep the exported value, else read it from tfvars.
# Returns non-zero when neither is available — with a named error unless the
# caller passed `optional` (a dry run, where the credential is unused).
resolve() {
  local var="$1" tfkey="$2" optional="${3:-}" value
  if [ -n "${!var:-}" ]; then return 0; fi
  if [ -f "$TFVARS" ]; then
    # grep exits 1 on no match; `|| true` keeps `set -e` from killing the run
    # before the explicit error below.
    value=$(grep -E "^[[:space:]]*${tfkey}[[:space:]]*=" "$TFVARS" | sed 's/.*= *"//;s/"$//' || true)
    if [ -n "$value" ]; then
      printf -v "$var" '%s' "$value"
      return 0
    fi
  fi
  if [ "$optional" != "optional" ]; then
    echo "Missing $var: not exported, and not readable from $TFVARS (key: $tfkey)." >&2
    echo "Export $var, or run from a clone that has terraform/terraform.tfvars." >&2
  fi
  return 1
}

if [ "$DRY_RUN" = "1" ] || [ "$NEEDS_ARKHAM" = "0" ]; then
  resolve ARKHAM_API_KEY arkham_api_key optional || true
else
  resolve ARKHAM_API_KEY arkham_api_key
fi

# Fetch the per-DB REST token from the Upstash mgmt API — skipped entirely when
# both REST vars are already exported.
if [ -z "${UPSTASH_REDIS_REST_URL:-}" ] || [ -z "${UPSTASH_REDIS_REST_TOKEN:-}" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    resolve UPSTASH_EMAIL upstash_email optional || true
    resolve UPSTASH_API_KEY upstash_api_key optional || true
  else
    resolve UPSTASH_EMAIL upstash_email
    resolve UPSTASH_API_KEY upstash_api_key
  fi
  if [ -n "${UPSTASH_EMAIL:-}" ] && [ -n "${UPSTASH_API_KEY:-}" ]; then
    RESPONSE=$(curl -s -u "${UPSTASH_EMAIL}:${UPSTASH_API_KEY}" \
      "https://api.upstash.com/v2/redis/database/${DB_ID}")
    UPSTASH_REDIS_REST_TOKEN=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['rest_token'])")
    UPSTASH_ENDPOINT=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['endpoint'])")
    UPSTASH_REDIS_REST_URL="https://${UPSTASH_ENDPOINT}"
  fi
fi

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

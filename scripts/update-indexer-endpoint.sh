#!/usr/bin/env bash
# update-indexer-endpoint.sh
# Queries the Envio operator API to find the current live deployment endpoint hash,
# then updates the corresponding Vercel env var for the given network.
#
# Usage:
#   ENVIO_API_TOKEN=<token> VERCEL_TOKEN=<token> VERCEL_PROJECT_ID=<id> ./scripts/update-indexer-endpoint.sh
#   NETWORK=celo-sepolia ENDPOINT_HASH=<hash> ./scripts/update-indexer-endpoint.sh
#   or set vars in .env.local and source it first

set -euo pipefail

# Auto-load .env.local if it exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  set -a; source "$ENV_FILE"; set +a
fi

ENVIO_TOKEN="${ENVIO_API_TOKEN:-$(pass envio/api-token 2>/dev/null || echo '')}"
VERCEL_TOKEN="${VERCEL_TOKEN:-$(pass vercel/api-token 2>/dev/null || echo '')}"
VERCEL_PROJECT_ID="${VERCEL_PROJECT_ID:-prj_monitoring_ui_dashboard}"
VERCEL_TEAM_ID="${VERCEL_TEAM_ID:-}"

NETWORK="${NETWORK:-celo-mainnet}"
ORG_ID="mento-protocol"

case "$NETWORK" in
  celo-mainnet)
    INDEXER_ID="mento-v3-celo-mainnet"
    VERCEL_ENV_KEY="NEXT_PUBLIC_HASURA_URL_MAINNET_HOSTED"
    ;;
  celo-sepolia)
    INDEXER_ID="mento-v3-celo-sepolia"
    VERCEL_ENV_KEY="NEXT_PUBLIC_HASURA_URL_SEPOLIA_HOSTED"
    ;;
  *)
    echo "❌ Unknown NETWORK: $NETWORK (supported: celo-mainnet, celo-sepolia)"
    exit 1
    ;;
esac

echo "🌐 Network: $NETWORK (indexer: $INDEXER_ID)"

if [[ -z "$ENVIO_TOKEN" ]]; then
  echo "❌ ENVIO_API_TOKEN not set"
  exit 1
fi

echo "🔍 Querying Envio operator API for latest deployment..."

# Get the latest live deployment commit hash
COMMIT_HASH=$(curl -s "https://operator.hyperindex.xyz/v1/graphql" \
  -H "x-envio-api-token: $ENVIO_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"{ deployments(where: {indexer_id: {_eq: \\\"$INDEXER_ID\\\"}}, order_by: {created_time: desc}, limit: 1) { commit_hash } }\"}" \
  | python3 -c "import json,sys; data=json.load(sys.stdin); print(data['data']['deployments'][0]['commit_hash'])")

echo "📌 Latest deployment commit: $COMMIT_HASH"

# The endpoint hash is not exposed by the Envio API directly.
# We discover it by checking which endpoint hash returns healthy data for our indexer.
# Strategy: probe the known endpoint and see if it's the same commit; if not, ask user to update.
# 
# NOTE: Until Envio exposes a stable endpoint or the endpoint hash via API,
# this script requires the endpoint hash to be passed manually after each deploy.
# 
# Workaround: use the Envio dashboard to copy the endpoint after deploying,
# then run: ENDPOINT_HASH=<hash> ./scripts/update-indexer-endpoint.sh

ENDPOINT_HASH="${ENDPOINT_HASH:-}"

if [[ -z "$ENDPOINT_HASH" ]]; then
  echo ""
  echo "⚠️  Envio doesn't expose the endpoint hash via API (free tier limitation)."
  echo "   After deploying, open https://envio.dev/app/${ORG_ID}/${INDEXER_ID}"
  echo "   and copy the GraphQL endpoint hash from the deployment detail page."
  echo ""
  echo "   Then run:"
  echo "   NETWORK=${NETWORK} ENDPOINT_HASH=<hash> ./scripts/update-indexer-endpoint.sh"
  echo ""
  echo "   Or upgrade to a paid Envio plan for static production endpoints."
  exit 0
fi

GRAPHQL_URL="https://indexer.dev.hyperindex.xyz/${ENDPOINT_HASH}/v1/graphql"

# Verify the endpoint works
echo "✅ Verifying endpoint: $GRAPHQL_URL"
HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" "$GRAPHQL_URL" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ Pool(limit:1) { id } }"}')
HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -1)

ENVIO_DASHBOARD="https://envio.dev/app/${ORG_ID}/${INDEXER_ID}/${COMMIT_HASH}"

if [[ "$HTTP_CODE" != "200" ]]; then
  RESULT="error: HTTP $HTTP_CODE — endpoint may not exist yet. Grab the correct hash from:\n   ${ENVIO_DASHBOARD}"
else
  RESULT=$(echo "$HTTP_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if d.get('data') else 'error: ' + str(d.get('errors',['unknown'])))")
fi

if [[ "$RESULT" != "ok" ]]; then
  echo -e "❌ Endpoint verification failed: $RESULT"
  exit 1
fi

echo "✅ Endpoint verified"

if [[ -z "$VERCEL_TOKEN" ]]; then
  echo ""
  echo "💡 No VERCEL_TOKEN set. Update manually in Vercel dashboard:"
  echo "   ${VERCEL_ENV_KEY}=${GRAPHQL_URL}"
  echo ""
  echo "   Or add to pass store: echo '<token>' | pass insert vercel/api-token"
  exit 0
fi

echo "🚀 Updating Vercel env var..."

# Find the env var ID first
TEAM_PARAM=""
if [[ -n "$VERCEL_TEAM_ID" ]]; then
  TEAM_PARAM="?teamId=$VERCEL_TEAM_ID"
fi

# Get the existing env var ID so we can PATCH it (not POST a duplicate)
ENV_VAR_ID=$(curl -s "https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}/env${TEAM_PARAM}" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d.get('envs', []):
    if e.get('key') == '${VERCEL_ENV_KEY}':
        print(e['id'])
        break
" 2>/dev/null)

echo "   Env var ID lookup: ${ENV_VAR_ID:-not found}"

if [[ -n "$ENV_VAR_ID" ]]; then
  # PATCH existing env var
  UPDATE_RESULT=$(curl -s -X PATCH "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env/${ENV_VAR_ID}${TEAM_PARAM}" \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"value\": \"$GRAPHQL_URL\"
    }")
else
  # POST new env var
  UPDATE_RESULT=$(curl -s -X POST "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env${TEAM_PARAM}" \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"key\": \"${VERCEL_ENV_KEY}\",
      \"value\": \"$GRAPHQL_URL\",
      \"type\": \"plain\",
      \"target\": [\"production\", \"preview\"]
    }")
fi

if echo "$UPDATE_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if d.get('key') or d.get('id') else 1)" 2>/dev/null; then
  echo "✅ Vercel env var updated"
  echo ""
  echo "📌 New endpoint: $GRAPHQL_URL"
  echo ""
  echo "🔄 Triggering Vercel redeploy..."
  # Trigger redeploy by promoting latest deployment
  REDEPLOY=$(curl -s -X POST "https://api.vercel.com/v13/deployments${TEAM_PARAM}" \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"monitoring-ui-dashboard\", \"gitSource\": {\"ref\": \"main\", \"type\": \"github\", \"repoId\": \"mento-protocol/monitoring-monorepo\"}}")
  echo "Redeploy triggered: $(echo $REDEPLOY | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('url', 'check Vercel dashboard'))" 2>/dev/null)"
else
  echo "❌ Vercel update failed: $UPDATE_RESULT"
  echo ""
  echo "   Update manually in Vercel dashboard:"
  echo "   ${VERCEL_ENV_KEY}=${GRAPHQL_URL}"
fi

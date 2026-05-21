#!/usr/bin/env bash
# Tier 0 — upload 11 pre-drafted forensic reports from .investigations/ to
# the Upstash `reports` hash. Uses the atomic Lua EVAL from
# ui-dashboard/src/lib/address-reports.ts upsertReport().
#
# Usage:
#   UPSTASH_REDIS_REST_TOKEN=... \
#   UPSTASH_REDIS_REST_URL=... \
#   bash ui-dashboard/scripts/intel-marathon/upload-drafts.sh
set -euo pipefail
: "${UPSTASH_REDIS_REST_TOKEN:?Set UPSTASH_REDIS_REST_TOKEN before running}"
: "${UPSTASH_REDIS_REST_URL:?Set UPSTASH_REDIS_REST_URL before running}"

URL="${UPSTASH_REDIS_REST_URL}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INVESTIGATIONS_DIR="$REPO_ROOT/.investigations"
AUTHOR_EMAIL="$(git config user.email)"

if [ ! -d "$INVESTIGATIONS_DIR" ]; then
  echo "✗ $INVESTIGATIONS_DIR not found"
  exit 1
fi

# Lua upsert — mirrors ui-dashboard/src/lib/address-reports.ts upsertReport().
# Preserves createdAt, increments version, stamps updatedAt = now.
SCRIPT='local key = KEYS[1]
local addr = ARGV[1]
local payload = cjson.decode(ARGV[2])
local now = ARGV[3]
local existing = redis.call("HGET", key, addr)
local prior = nil
if existing then prior = cjson.decode(existing) end
payload.createdAt = (prior and prior.createdAt) or now
payload.updatedAt = now
local priorVersion = prior and prior.version
if type(priorVersion) ~= "number" then priorVersion = 0 end
payload.version = priorVersion + 1
local encoded = cjson.encode(payload)
redis.call("HSET", key, addr, encoded)
return encoded'

UPLOADED=0
FAILED=0

upload_one() {
  local draft_path="$1"
  local fname
  fname=$(basename "$draft_path")
  local addr="${fname%%-*}"  # 0x… prefix before first dash
  local slug="${fname#${addr}-}"
  slug="${slug%.md}"

  # Mirror the API route's validation — this writer bypasses the route, so
  # without these checks a malformed filename or oversize body would land
  # straight in the production `reports` hash.
  if ! [[ "$addr" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    echo "✗ $fname — filename prefix is not a valid 0x-address"
    FAILED=$((FAILED + 1))
    return 1
  fi
  # Convert to lowercase to match the route's normalization.
  addr=$(echo "$addr" | tr "[:upper:]" "[:lower:]")

  local body_bytes
  body_bytes=$(wc -c < "$draft_path" | tr -d "[:space:]")
  # Match MAX_BODY_LENGTH from src/lib/address-reports.ts (50KB).
  if [ "$body_bytes" -gt 51200 ]; then
    echo "✗ $addr — body ${body_bytes}B exceeds 50KB cap"
    FAILED=$((FAILED + 1))
    return 1
  fi
  if [ "$body_bytes" -eq 0 ]; then
    echo "✗ $addr — empty body"
    FAILED=$((FAILED + 1))
    return 1
  fi

  # Title: first H1 line, sans leading "# "
  local title
  title=$(grep -m1 "^# " "$draft_path" | sed 's/^# //' || echo "$slug")
  # Match MAX_TITLE_LENGTH (200 chars).
  if [ "${#title}" -gt 200 ]; then
    title="${title:0:200}"
  fi
  local ts
  ts=$(date -u +%FT%T.%3NZ)

  # Pass everything via environment so Python doesn't see shell-interpolated
  # source. `${var@Q}` produces ANSI-C quoting (e.g. `$'foo\'s'`) for strings
  # containing apostrophes / backslashes — valid bash but invalid Python.
  local payload
  payload=$(
    DRAFT_PATH="$draft_path" TITLE="$title" AUTHOR_EMAIL="$AUTHOR_EMAIL" \
      python3 - <<'PYEOF'
import json, os, pathlib
body = pathlib.Path(os.environ["DRAFT_PATH"]).read_text()
print(json.dumps({
    "body": body,
    "title": os.environ["TITLE"],
    "authorEmail": os.environ["AUTHOR_EMAIL"],
    "source": "claude",
}))
PYEOF
  )

  # Upstash REST API: POST a JSON array [CMD, ARGS...] to the root.
  # EVAL takes: script, numkeys, keys..., args...
  local response
  response=$(curl -s -X POST "$URL" \
    -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg s "$SCRIPT" --arg addr "$addr" --arg p "$payload" --arg ts "$ts" \
          '["EVAL", $s, "1", "reports", $addr, $p, $ts]')")

  if echo "$response" | jq -e '.error' >/dev/null 2>&1; then
    echo "✗ $addr — $(echo "$response" | jq -r .error)"
    FAILED=$((FAILED + 1))
    return 1
  fi

  # Verify
  local check
  check=$(curl -s "$URL/hget/reports/$addr" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
    | jq -r '.result' \
    | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); print(f\"v={r['version']} body={len(r['body'])}B\")")
  echo "✓ $addr ($title) — $check"
  UPLOADED=$((UPLOADED + 1))
}

echo "Uploading drafts from $INVESTIGATIONS_DIR..."
echo ""

for draft in "$INVESTIGATIONS_DIR"/0x*.md; do
  [ -f "$draft" ] || continue
  upload_one "$draft" || true
done

echo ""
echo "✓ Done: $UPLOADED uploaded, $FAILED failed"
echo ""
echo "Verify count:"
curl -s "$URL/hlen/reports" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" | jq .

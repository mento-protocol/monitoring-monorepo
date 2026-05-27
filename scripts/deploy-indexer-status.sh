#!/usr/bin/env bash
# Show sync status for an Envio indexer deployment.
#
# Usage:
#   pnpm deploy:indexer:status                  → show latest deployment status
#   pnpm deploy:indexer:status <commit>         → show specific deployment status
#   pnpm deploy:indexer:status <commit> --watch → wait for registration, then poll until synced
#   pnpm deploy:indexer:status --json           → JSON output
#
# Requires: workspace envio-cloud CLI dependency

set -euo pipefail

ENVIO_ORG="mento-protocol"
ENVIO_INDEXER="mento"
# 10 min, not 30. Normal registration completes in 2-3 min after push; a 30-min
# silent wait was almost always wrong — by the 10-min mark Envio's webhook is
# either broken or their build queue is jammed, and waiting longer just burns
# operator time. Override per-invocation by exporting ENVIO_REGISTRATION_TIMEOUT_SECONDS.
REGISTRATION_TIMEOUT_SECONDS="${ENVIO_REGISTRATION_TIMEOUT_SECONDS:-600}"
REGISTRATION_POLL_SECONDS=30
# Emit a louder warning once registration takes longer than this. 3 min is past
# the normal 2-min P50 but short enough to catch a broken webhook before the
# operator walks away — the diagnostic-vs-timeout split makes broken webhooks
# observable within minutes instead of buried under uniform "checking again".
REGISTRATION_WARN_SECONDS=180
SYNC_POLL_SECONDS=10

deployment_list_json() {
  pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json
}

deployment_commit_from_list() {
  local target="$1"
  node scripts/resolve-envio-deployment.mjs "$target"
}

latest_deployment_commit() {
  local deployments_json=""
  deployments_json=$(deployment_list_json)
  printf '%s' "$deployments_json" | deployment_commit_from_list ""
}

resolve_deployment_commit() {
  local target="$1"
  local deployments_json=""
  deployments_json=$(deployment_list_json)
  printf '%s' "$deployments_json" | deployment_commit_from_list "$target"
}

wait_for_deployment_registration() {
  local target="$1"
  local elapsed=0
  local resolved=""
  local resolve_status=0
  local warned_slow=false

  while (( elapsed <= REGISTRATION_TIMEOUT_SECONDS )); do
    set +e
    resolved=$(resolve_deployment_commit "$target")
    resolve_status=$?
    set -e
    if [[ "$resolve_status" -ne 0 ]]; then
      return "$resolve_status"
    fi
    if [[ -n "$resolved" ]]; then
      echo "$resolved"
      return 0
    fi

    if [[ "$JSON" != "true" ]]; then
      if (( elapsed >= REGISTRATION_WARN_SECONDS )) && [[ "$warned_slow" == "false" ]]; then
        echo "" >&2
        echo "⚠️  Deployment $target still unregistered after ${elapsed}s — that's past the normal P50 of ~2 min." >&2
        echo "   Likely causes (check before waiting longer):" >&2
        echo "     • Envio Cloud's webhook receiver lost the push event (their side, opaque to us)" >&2
        echo "     • Push was a no-op (same SHA already on the deploy branch — see deploy-indexer.sh warning)" >&2
        echo "     • Envio's build queue is backed up" >&2
        echo "   Inspect: https://envio.dev/app/${ENVIO_ORG}/${ENVIO_INDEXER}" >&2
        echo "   Will keep polling until ${REGISTRATION_TIMEOUT_SECONDS}s then give up." >&2
        echo "" >&2
        warned_slow=true
      elif [[ "$warned_slow" == "true" ]]; then
        # Keep the warning context visible in scroll-back so the operator
        # doesn't lose track of the suspect state once the polling line
        # restarts and the diagnostic block scrolls off.
        echo "⏳ Deployment $target not registered yet (${elapsed}s elapsed; webhook suspect — see warning above); checking again in ${REGISTRATION_POLL_SECONDS}s..." >&2
      else
        echo "⏳ Deployment $target not registered yet (${elapsed}s elapsed); checking again in ${REGISTRATION_POLL_SECONDS}s..." >&2
      fi
    fi
    sleep "$REGISTRATION_POLL_SECONDS"
    elapsed=$((elapsed + REGISTRATION_POLL_SECONDS))
  done

  return 1
}

deployment_status_json() {
  pnpm exec envio-cloud deployment status "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" -o json
}

render_status_json() {
  local status_json=""
  status_json=$(cat)
  STATUS_JSON="$status_json" node <<'NODE'
    const d = JSON.parse(process.env.STATUS_JSON ?? '{}');
    const rows = d.data ?? [];
    const pct = (row) => {
      const start = Number(row.start_block ?? 0);
      const head = Number(row.block_height ?? 0);
      const processed = Number(row.latest_processed_block ?? 0);
      const denominator = Math.max(head - start, 1);
      const numerator = Math.max(Math.min(processed, head) - start, 0);
      return (numerator / denominator) * 100;
    };
    const progressParts = (row) => {
      const start = Number(row.start_block ?? 0);
      const head = Number(row.block_height ?? 0);
      const processed = Number(row.latest_processed_block ?? 0);
      return {
        denominator: Math.max(head - start, 0),
        numerator: Math.max(Math.min(processed, head) - start, 0),
      };
    };
    const fmtPct = (value) => `${value.toFixed(2)}%`;
    const fmtNum = (value) => Number(value ?? 0).toLocaleString('en-US');
    const widths = [8, 10, 14, 14, 10, 10, 20];
    const pad = (value, width) => String(value).padEnd(width, ' ');
    const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join('  ');
    console.log(line(['CHAIN', 'CATCH-UP', 'START', 'HEAD', 'PROCESSED', 'EVENTS', 'SYNCED AT']));
    console.log(line(['-----', '--------', '-----', '----', '---------', '------', '---------']));
    for (const row of rows) {
      console.log(line([
        row.chain_id,
        fmtPct(pct(row)),
        fmtNum(row.start_block),
        fmtNum(row.block_height),
        fmtNum(row.latest_processed_block),
        fmtNum(row.num_events_processed),
        row.timestamp_caught_up_to_head_or_endblock ? row.timestamp_caught_up_to_head_or_endblock.replace('T', ' ').slice(0, 19) : '-',
      ]));
    }
    const totalParts = rows.map(progressParts);
    const totalDenominator = Math.max(totalParts.reduce((sum, part) => sum + part.denominator, 0), 1);
    const totalNumerator = totalParts.reduce((sum, part) => sum + part.numerator, 0);
    const isCaughtUp = (row) => Number(row.latest_processed_block ?? 0) >= Number(row.block_height ?? 0);
    const allCaughtUp = rows.length > 0 && rows.every(isCaughtUp);
    console.log('');
    console.log(`Overall catch-up: ${fmtPct((totalNumerator / totalDenominator) * 100)} (${fmtNum(totalNumerator)}/${fmtNum(totalDenominator)} blocks since start)`);
    console.log(`Status: ${allCaughtUp ? 'caught up' : 'syncing'}`);
    process.exit(allCaughtUp ? 0 : 10);
NODE
}

watch_status() {
  local status_json=""

  while true; do
    if ! status_json=$(deployment_status_json); then
      return 1
    fi

    printf '\033[2J\033[H'
    echo "Deployment Metrics: $ENVIO_ORG/$ENVIO_INDEXER (commit: $COMMIT)"
    echo "Last updated: $(date '+%H:%M:%S')"
    echo ""

    set +e
    printf '%s' "$status_json" | render_status_json
    local render_exit=$?
    set -e

    if [[ "$render_exit" -eq 0 ]]; then
      return 0
    fi
    if [[ "$render_exit" -ne 10 ]]; then
      return "$render_exit"
    fi

    echo ""
    echo "Watching for updates. Press Ctrl+C to stop..."
    sleep "$SYNC_POLL_SECONDS"
  done
}

# Parse flags
COMMIT=""
WATCH=false
JSON=false
for arg in "$@"; do
  case "$arg" in
    --watch|-w) WATCH=true ;;
    --json|-j) JSON=true ;;
    --) ;;
    *)
      if [[ -n "$COMMIT" ]]; then
        echo "❌ Unexpected argument: $arg"
        echo "Usage: pnpm deploy:indexer:status [<commit>] [--watch] [--json]"
        exit 1
      fi
      COMMIT="$arg"
      ;;
  esac
done

if [[ -z "$COMMIT" ]]; then
  COMMIT=$(latest_deployment_commit)

  if [[ -z "$COMMIT" ]]; then
    echo "❌ No deployments found for $ENVIO_ORG/$ENVIO_INDEXER" >&2
    exit 1
  fi

  if [[ "$JSON" != "true" ]]; then
    echo "📊 Latest deployment: $COMMIT"
  fi
else
  TARGET_COMMIT="$COMMIT"
  if [[ "$WATCH" == "true" ]]; then
    set +e
    COMMIT=$(wait_for_deployment_registration "$TARGET_COMMIT")
    wait_status=$?
    set -e
    if [[ "$wait_status" -ne 0 ]]; then
      if [[ "$wait_status" -eq 1 ]]; then
        echo "❌ Deployment $TARGET_COMMIT did not register within $((REGISTRATION_TIMEOUT_SECONDS / 60)) minutes." >&2
        echo "   This is almost always an Envio-side issue (broken webhook, stuck build queue)." >&2
        echo "   The push to the deploy branch succeeded — verify on GitHub and check Envio's UI:" >&2
        echo "   https://envio.dev/app/${ENVIO_ORG}/${ENVIO_INDEXER}" >&2
      else
        echo "❌ Failed to resolve deployment $TARGET_COMMIT for $ENVIO_ORG/$ENVIO_INDEXER" >&2
      fi
      exit 1
    fi
  else
    COMMIT=$(resolve_deployment_commit "$TARGET_COMMIT")
    if [[ -z "$COMMIT" ]]; then
      echo "❌ Deployment $TARGET_COMMIT not found for $ENVIO_ORG/$ENVIO_INDEXER" >&2
      echo "   Envio deployment ids are short commit hashes and may lag after pushing to the deploy branch." >&2
      echo "   Re-run with --watch to wait for registration." >&2
      exit 1
    fi
  fi

  if [[ "$JSON" != "true" ]]; then
    echo "📊 Deployment: $COMMIT"
  fi
fi

if [[ "$JSON" != "true" ]]; then
  echo ""
fi

if [[ "$WATCH" == "true" ]]; then
  if [[ "$JSON" == "true" ]]; then
    pnpm exec envio-cloud deployment status "$ENVIO_INDEXER" "$COMMIT" "$ENVIO_ORG" --watch-till-synced -o json
  else
    watch_status
  fi
  exit $?
fi

if [[ "$JSON" == "true" ]]; then
  deployment_status_json
else
  set +e
  deployment_status_json | render_status_json
  status_exit=$?
  set -e
  if [[ "$status_exit" -eq 10 ]]; then
    exit 0
  fi
  exit "$status_exit"
fi

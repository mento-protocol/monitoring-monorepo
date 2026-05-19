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
REGISTRATION_TIMEOUT_SECONDS=1800
REGISTRATION_POLL_SECONDS=30
SYNC_POLL_SECONDS=10

deployment_list_json() {
  pnpm exec envio-cloud indexer get "$ENVIO_INDEXER" "$ENVIO_ORG" -o json
}

deployment_commit_from_list() {
  local target="$1"
  node -e "
    const target = process.argv[1];
    const { execFileSync } = require('child_process');
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const deps = [...(d.data?.deployments ?? [])].sort((a,b) => b.created_time.localeCompare(a.created_time));
    if (!target) {
      process.stdout.write(deps[0]?.commit_hash ?? '');
      process.exit(0);
    }
    let verifiedTarget = '';
    try {
      verifiedTarget = execFileSync('git', ['rev-parse', '--verify', target + '^{commit}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {}
    const matches = deps.filter((dep) =>
      dep.commit_hash.startsWith(target) ||
      (verifiedTarget && verifiedTarget.startsWith(dep.commit_hash))
    );
    if (matches.length > 1) {
      console.error('Ambiguous deployment commit ' + target + ' matches: ' + matches.map((dep) => dep.commit_hash).join(', '));
      process.exit(2);
    }
    const match = matches[0];
    process.stdout.write(match?.commit_hash ?? '');
  " "$target"
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

  while (( elapsed <= REGISTRATION_TIMEOUT_SECONDS )); do
    resolved=$(resolve_deployment_commit "$target")
    if [[ -n "$resolved" ]]; then
      echo "$resolved"
      return 0
    fi

    if [[ "$JSON" != "true" ]]; then
      echo "⏳ Deployment $target not registered yet; checking again in ${REGISTRATION_POLL_SECONDS}s..." >&2
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
    const allCaughtUp = rows.length > 0 && rows.every((row) => row.timestamp_caught_up_to_head_or_endblock);
    console.log('');
    console.log(`Overall catch-up: ${fmtPct((totalNumerator / totalDenominator) * 100)} (${fmtNum(totalNumerator)}/${fmtNum(totalDenominator)} blocks since start)`);
    console.log(`Status: ${allCaughtUp ? 'caught up' : 'syncing'}`);
    process.exit(allCaughtUp ? 0 : 10);
NODE
}

watch_status() {
  local status_json=""

  while true; do
    if ! status_json=$(deployment_status_json 2>&1); then
      echo "$status_json" >&2
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
    if ! COMMIT=$(wait_for_deployment_registration "$TARGET_COMMIT"); then
      echo "❌ Deployment $TARGET_COMMIT did not register within $((REGISTRATION_TIMEOUT_SECONDS / 60)) minutes" >&2
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

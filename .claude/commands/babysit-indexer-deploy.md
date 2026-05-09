# Babysit Indexer Deploy

Monitor an in-flight Envio HyperIndex deployment for `mento-protocol/mento` until every chain is caught up, then prompt the user to promote it. Never auto-promote.

Target commit: `$1` (default: derive from `git fetch origin envio && git rev-parse --short origin/envio`)

## How this works (Monitor, not cron)

This skill uses the `Monitor` tool to run a single long-running shell script that polls Envio internally at a tight cadence (45s) but **only emits stdout lines on state changes worth notifying** — deployment registered, all chains caught up, build deadline missed, sync deadline missed, or script-level error. Every emitted stdout line is a notification; silent no-op cycles produce zero notifications. A typical 30–60 min sync produces 2–3 notifications instead of the ~12 the previous `/loop 5m` cron version generated.

If you find yourself reaching for `CronCreate` or `/loop` here, stop — Monitor is the right primitive.

## Preflight (run once, before arming the Monitor)

1. **Resolve the target commit.**
   - If `$1` is set, use it verbatim (short SHA, 7–8 chars). Capture as `TARGET_COMMIT`.
   - Otherwise: `git fetch origin envio && git rev-parse --short origin/envio`.
   - Print the resolved commit so the user can sanity-check it.

2. **No cycle counter needed.** Wall-clock budgets are enforced inside the Monitor script — see "Emit policy" below.

## Steps

Arm a single Monitor with `persistent: true` and a `description` like `envio sync for <commit>`. The script body:

```bash
set -uo pipefail
TARGET="<TARGET_COMMIT>"               # interpolate the resolved short SHA
ORG="mento-protocol"
INDEXER="mento"
START=$(date +%s)
BUILD_DEADLINE=$((START + 1800))       # 30 min
SYNC_DEADLINE=$((START + 5400))        # 90 min
POLL_INTERVAL=45                       # seconds

REGISTERED=0
LAST_ERROR_KIND=""                     # debounce identical errors

emit() { printf '%s\n' "$*"; }
elapsed_min() { echo $(( ($(date +%s) - START) / 60 )); }

while true; do
  NOW=$(date +%s)

  # --- Has the deployment registered yet? ---
  IDX_JSON=$(npx -q envio-cloud indexer get "$INDEXER" "$ORG" -o json 2>/dev/null) || {
    if [[ "$LAST_ERROR_KIND" != "auth_or_network" ]]; then
      emit "ERROR auth_or_network: 'envio-cloud indexer get' failed — auth expired or network down. Try 'npx envio-cloud login'."
      LAST_ERROR_KIND="auth_or_network"
    fi
    sleep "$POLL_INTERVAL"; continue
  }
  LAST_ERROR_KIND=""

  DEPLOYMENT=$(echo "$IDX_JSON" | jq -r --arg t "$TARGET" \
    '.data.deployments[]? | select(.commit_hash | startswith($t))' 2>/dev/null)

  if [[ -z "$DEPLOYMENT" ]]; then
    if (( NOW >= BUILD_DEADLINE )); then
      emit "BUILD_FAILED elapsed=$(elapsed_min)m — deployment for $TARGET never registered. Try: pnpm deploy:indexer:logs --build"
      exit 1
    fi
    sleep "$POLL_INTERVAL"; continue
  fi

  if (( REGISTERED == 0 )); then
    PROD_STATUS=$(echo "$DEPLOYMENT" | jq -r '.prod_status // "unknown"')
    emit "REGISTERED prod_status=$PROD_STATUS elapsed=$(elapsed_min)m"
    REGISTERED=1
    if [[ "$PROD_STATUS" == "prod" ]]; then
      emit "ALREADY_PROMOTED commit=$TARGET — re-run case, no further action needed"
      exit 0
    fi
  fi

  # --- Per-chain sync status ---
  STATUS_JSON=$(npx -q envio-cloud deployment status "$INDEXER" "$TARGET" "$ORG" -o json 2>/dev/null) || {
    if [[ "$LAST_ERROR_KIND" != "status_fetch" ]]; then
      emit "ERROR status_fetch: 'envio-cloud deployment status $TARGET' failed"
      LAST_ERROR_KIND="status_fetch"
    fi
    sleep "$POLL_INTERVAL"; continue
  }
  LAST_ERROR_KIND=""

  ALL_CAUGHT_UP=$(echo "$STATUS_JSON" | jq -r \
    '[.data[]? | (.timestamp_caught_up_to_head_or_endblock // "") != ""] | all' 2>/dev/null)

  if [[ "$ALL_CAUGHT_UP" == "true" ]]; then
    PER_CHAIN=$(echo "$STATUS_JSON" | jq -r \
      '.data[]? | "  \(.network // .chain_id): caught_up=\(.timestamp_caught_up_to_head_or_endblock)"')
    emit "READY_TO_PROMOTE elapsed=$(elapsed_min)m commit=$TARGET"
    emit "$PER_CHAIN"
    emit "Run: pnpm deploy:indexer:promote $TARGET -y"
    exit 0
  fi

  if (( NOW >= SYNC_DEADLINE )); then
    SNAPSHOT=$(echo "$STATUS_JSON" | jq -r \
      '.data[]? | "  \(.network // .chain_id): \(.latest_processed_block)/\(.block_height) caught_up=\(.timestamp_caught_up_to_head_or_endblock // "false")"')
    emit "SYNC_DEADLINE elapsed=$(elapsed_min)m — last status:"
    emit "$SNAPSHOT"
    exit 1
  fi

  sleep "$POLL_INTERVAL"
done
```

### Emit policy

| Event                                             | Emit                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| Deployment first registers                        | `REGISTERED prod_status=<status> elapsed=<m>m`                         |
| Found `prod_status: "prod"` (re-run / idempotent) | `ALREADY_PROMOTED commit=<sha>` then `exit 0`                          |
| All chains caught up                              | `READY_TO_PROMOTE elapsed=<m>m commit=<sha>` + per-chain timestamps    |
| Build not registered after 30 min                 | `BUILD_FAILED elapsed=30m+` then `exit 1`                              |
| Sync not all-caught-up after 90 min               | `SYNC_DEADLINE elapsed=90m` + last snapshot then `exit 1`              |
| Auth-expired / network failure                    | `ERROR auth_or_network: <msg>` (debounced — only emits on kind change) |
| Status fetch failure                              | `ERROR status_fetch: <msg>` (debounced)                                |
| All other progress (per-chain blocks ticking up)  | silent — internal poll only                                            |

The emit-on-error rule preserves the visibility the cron version got implicitly from "the next cycle's network/auth failure surfaces loudly". Without it, a stuck Monitor with expired auth would sit silent until the wall-clock deadline. Kind-debouncing prevents a flapping outage from flooding the chat.

The script's natural exits (caught-up / build-failed / sync-deadline / already-promoted) close the Monitor cleanly. A `persistent: true` Monitor is required because typical syncs run 30–60 min — well past the default 5-min Monitor timeout.

## Decision tree for the calling skill

When the Monitor emits `READY_TO_PROMOTE` or `ALREADY_PROMOTED`, treat it as the success terminal and proceed to the next phase (typically promote). When it emits `BUILD_FAILED`, `SYNC_DEADLINE`, or `ERROR <kind>` and exits, treat as failure and stop without promoting. The Monitor process exits cleanly on terminal events — no `TaskStop` needed for those paths. Call `TaskStop` only if the user asks to abort early.

## Rules

- **Never auto-promote.** Surfacing `pnpm deploy:indexer:promote <commit>` to the user is the final step — they run it, not you.
- **Prefer the `pnpm deploy:indexer:*` wrappers** over raw `envio-cloud` calls (they handle auth + repo defaults), with two exceptions:
  - `indexer get` — no wrapper exists.
  - `deployment status <commit>` — wrapper auto-resolves _latest_ (we want explicit commit targeting).
- **Do not poll status yourself in parallel** while the Monitor is armed. The Monitor is the single source of truth for sync state.
- **Stop after 90 minutes** (`SYNC_DEADLINE`) without full sync. Typical sync is 15–40 min; 90 min means something is wrong.
- **Stop after 30 minutes if the deployment still 404s** (`BUILD_FAILED`). Direct the user to `pnpm deploy:indexer:logs --build`.
- **`has_processed_to_end_block` is a red herring** for this indexer (`end_block: 0`). Ignore it — only `timestamp_caught_up_to_head_or_endblock` matters.

## External contract

Callers (notably the `deploy-indexer` skill, Phase 2) invoke this command with a target commit string and treat the Monitor's terminal emit as the result:

- `READY_TO_PROMOTE` / `ALREADY_PROMOTED` → success, continue
- `BUILD_FAILED` / `SYNC_DEADLINE` / `ERROR …` → failure, stop, do not promote
- User-cancelled (`TaskStop`) → stop, do not promote

This contract matches the previous cron-based version's outputs verbatim, so `deploy-indexer` Phase 2 needs no changes.

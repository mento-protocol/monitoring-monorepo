# Babysit Indexer Deploy

Monitor an in-flight Envio HyperIndex deployment for `mento-protocol/mento` until every chain is caught up, then prompt the user to promote it. Never auto-promote.

Target commit: `$1` (default: derive from `git fetch origin envio && git rev-parse --short origin/envio`)

## How this works (Monitor, not cron)

This skill uses the `Monitor` tool to run a single long-running shell script that polls Envio internally at a tight cadence (45s) but **only emits stdout lines on state changes worth notifying** — deployment registered, all chains caught up, build deadline missed, sync deadline missed, or script-level error. Every emitted stdout line is a notification; silent no-op cycles produce zero notifications. A typical 30–60 min sync produces 2–3 notifications instead of the ~12 the previous `/loop 5m` cron version generated.

If you find yourself reaching for `CronCreate` or `/loop` here, stop — Monitor is the right primitive.

## Preflight (run once, before arming the Monitor)

1. **Resolve the target commit.**
   - If `$1` is set, use it verbatim. Capture as `TARGET_COMMIT`.
   - Otherwise: `git fetch origin envio && git rev-parse --short=7 origin/envio`.
   - Print the resolved commit so the user can sanity-check it.
   - **Envio's API stores `commit_hash` truncated to exactly 7 chars** — the script body below clips `TARGET` to `${TARGET:0:7}` defensively so an 8-char short SHA (which is what `git rev-parse --short` returns once a repo's `core.abbrev` ticks up past 7) doesn't break `startswith` matching and silently flunk the build-deadline check. Don't trim here in preflight; leave it to the script's first line so the contract is one-place.

2. **No cycle counter needed.** Wall-clock budgets are enforced inside the Monitor script — see "Emit policy" below.

## Steps

Arm a single Monitor with `persistent: true` and a `description` like `envio sync for <commit>`. The script body:

```bash
# Deliberately NOT setting -e: the inner jq parses use 2>/dev/null and we want
# silent fall-through (empty var → loop continues at next poll) rather than a
# fatal exit on a transient parse miss. -u catches typos in our own variables;
# -o pipefail catches a real upstream failure that gets masked by jq exiting 0.
set -uo pipefail
TARGET="<TARGET_COMMIT>"               # interpolate the resolved short SHA
# Envio's API returns `commit_hash` clipped to exactly 7 chars; an 8-char
# short SHA passed in (which is what `git push origin envio` prints, and what
# bare `git rev-parse --short HEAD` returns once `core.abbrev` ticks up past
# 7) would cause `startswith($t)` below to match zero rows on every poll.
# The build deadline then fires after 30 min with `BUILD_FAILED elapsed=30m`
# even though the deployment registered fine. Clip to 7 chars defensively.
TARGET="${TARGET:0:7}"
ORG="mento-protocol"
INDEXER="mento"
START=$(date +%s)
BUILD_DEADLINE=$((START + 1800))       # 30 min
SYNC_DEADLINE=$((START + 5400))        # 90 min
POLL_INTERVAL=45                       # seconds

REGISTERED=0
# Per-call debounce so an alternating success/fail across the two API calls
# can't wipe the debounce state of either one — see PR #364 review feedback.
LAST_IDX_ERROR=""
LAST_STATUS_ERROR=""
STATUS_JSON=""                         # last successful status payload, used by SYNC_DEADLINE snapshot

emit() { printf '%s\n' "$*"; }
elapsed_min() { echo $(( ($(date +%s) - START) / 60 )); }

# Wall-clock deadline check — runs at the TOP of every loop iteration so it
# fires regardless of whether the upstream API has been succeeding or failing.
# Without this, a stuck auth-expired state would emit ERROR once and then loop
# forever silent until the user notices.
check_deadlines() {
  local now=$1
  if (( REGISTERED == 0 && now >= BUILD_DEADLINE )); then
    emit "BUILD_FAILED elapsed=$(elapsed_min)m — deployment for $TARGET never registered. Try: pnpm deploy:indexer:logs --build"
    exit 1
  fi
  if (( now >= SYNC_DEADLINE )); then
    if [[ -n "$STATUS_JSON" ]]; then
      local snapshot
      snapshot=$(echo "$STATUS_JSON" | jq -r \
        '.data[]? | "  \(.network // .chain_id): \(.latest_processed_block)/\(.block_height) caught_up=\(.timestamp_caught_up_to_head_or_endblock // "false")"' 2>/dev/null)
      emit "SYNC_DEADLINE elapsed=$(elapsed_min)m — last status:"
      emit "$snapshot"
    else
      emit "SYNC_DEADLINE elapsed=$(elapsed_min)m — no successful status snapshot during the run"
    fi
    exit 1
  fi
}

while true; do
  NOW=$(date +%s)
  check_deadlines "$NOW"

  # --- Has the deployment registered yet? ---
  IDX_JSON=$(npx -q envio-cloud indexer get "$INDEXER" "$ORG" -o json 2>/dev/null) || {
    if [[ "$LAST_IDX_ERROR" != "auth_or_network" ]]; then
      emit "ERROR auth_or_network: 'envio-cloud indexer get' failed — auth expired or network down. Try 'npx envio-cloud login'."
      LAST_IDX_ERROR="auth_or_network"
    fi
    sleep "$POLL_INTERVAL"; continue
  }
  LAST_IDX_ERROR=""

  DEPLOYMENT=$(echo "$IDX_JSON" | jq -r --arg t "$TARGET" \
    '.data.deployments[]? | select(.commit_hash | startswith($t))' 2>/dev/null)

  if [[ -z "$DEPLOYMENT" ]]; then
    # Build deadline is enforced by check_deadlines at the top of the loop;
    # nothing extra needed here. Just keep polling until either the deployment
    # registers or the deadline check fires.
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
    STATUS_JSON=""  # don't trust a partial value
    if [[ "$LAST_STATUS_ERROR" != "status_fetch" ]]; then
      emit "ERROR status_fetch: 'envio-cloud deployment status $TARGET' failed"
      LAST_STATUS_ERROR="status_fetch"
    fi
    sleep "$POLL_INTERVAL"; continue
  }
  LAST_STATUS_ERROR=""

  # `(.data | length) > 0 and (... | all)` guards against the vacuous-truth
  # case: `[.data[]? | …] | all` returns true on an empty array, so a
  # `data: []` response (e.g. before any chain row is created) would
  # otherwise emit a false READY_TO_PROMOTE.
  ALL_CAUGHT_UP=$(echo "$STATUS_JSON" | jq -r \
    '(.data | length) > 0 and ([.data[] | (.timestamp_caught_up_to_head_or_endblock // "") != ""] | all)' 2>/dev/null)

  if [[ "$ALL_CAUGHT_UP" == "true" ]]; then
    PER_CHAIN=$(echo "$STATUS_JSON" | jq -r \
      '.data[]? | "  \(.network // .chain_id): caught_up=\(.timestamp_caught_up_to_head_or_endblock)"')
    emit "READY_TO_PROMOTE elapsed=$(elapsed_min)m commit=$TARGET"
    emit "$PER_CHAIN"
    emit "Run: pnpm deploy:indexer:promote $TARGET -y"
    exit 0
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

Each emit is either **terminal** (the script exits after emitting) or **transient** (the script keeps polling).

**Terminal emits** — the calling skill treats these as the final result:

- `READY_TO_PROMOTE` / `ALREADY_PROMOTED` → success; proceed to the next phase (typically promote).
- `BUILD_FAILED` / `SYNC_DEADLINE` → failure; stop without promoting.

**Transient emits** — the script keeps polling after these; the calling skill should NOT stop on them:

- `REGISTERED prod_status=<status>` — informational, fires once when the deployment first appears.
- `ERROR auth_or_network: …` / `ERROR status_fetch: …` — debounced; surfaces a stuck upstream that the user may need to fix (e.g. `npx envio-cloud login`). The Monitor keeps polling, so transient blips self-heal. The wall-clock deadline checks at the top of the loop ensure a stuck error eventually escalates to `BUILD_FAILED` or `SYNC_DEADLINE` rather than running forever.

The Monitor process exits cleanly on terminal events — no `TaskStop` needed. Call `TaskStop` only if the user asks to abort early.

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
- `BUILD_FAILED` / `SYNC_DEADLINE` → failure, stop, do not promote
- User-cancelled (`TaskStop`) → stop, do not promote
- `ERROR <kind>` is **non-terminal** — keep waiting; the Monitor will continue polling. A stuck error eventually escalates via the wall-clock deadline checks above.

The terminal-emit names (`READY_TO_PROMOTE`, `ALREADY_PROMOTED`, `BUILD_FAILED`, `SYNC_DEADLINE`) replace the previous cron-based version's prose returns (`"ready to promote"`, etc.) — `deploy-indexer` Phase 2 needs to map to the new names.

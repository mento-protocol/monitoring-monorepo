# Babysit Indexer Deploy

Monitor an in-flight Envio HyperIndex deployment for `mento-protocol/mento` until every chain is caught up, then prompt the user to promote it. Never auto-promote.

Target commit: `$1` (default: derive from `git fetch origin envio && git rev-parse --short origin/envio`)

Poll interval is implicit — use `/loop 5m` unless the user specified otherwise.

## Preflight (run once, before entering the loop)

1. **Resolve the target commit.**
   - If `$1` is set, use it verbatim (short SHA, 7–8 chars).
   - Otherwise: `git fetch origin envio && git rev-parse --short origin/envio`.
   - Print the resolved commit so the user can sanity-check it.

2. **Start a poll-count / wall-clock budget.** Max 18 cycles (≈90 min at 5m interval). Track cycle count in your running context.

## Steps

Use `/loop 5m` (or the user-specified interval) to repeat the following on each cycle:

### 1. Has the deployment registered yet?

```
npx envio-cloud indexer get mento mento-protocol -o json
```

Parse `.data.deployments[]` (NOT the top-level — the payload is wrapped in `{ok, data}`). Look for an entry whose `commit_hash` starts with the target commit.

- **Not found, cycle ≤ 6 (~30 min):** Build is still pending. Keep waiting. On the first miss, suggest the user run `pnpm deploy:indexer:logs --build` in another terminal if they want to tail build progress — do not run it yourself unless the user asks.
- **Not found, cycle > 6 (past 30 min):** Build most likely failed. Stop looping. Report: "Deployment for `<commit>` has not registered after 30 min — build likely failed. Run `pnpm deploy:indexer:logs --build` to check."
- **Found with `prod_status: "prod"`:** Already promoted. Report success and stop looping.
- **Found with `prod_status != "prod"`:** Built and syncing (or caught up). Continue to step 2.

### 2. Per-chain sync status

```
pnpm deploy:indexer:status <commit> -o json
```

Parse `.data[]` (again wrapped — chains are under `.data`, not top level). For each chain, extract:

- `network` or chain id
- `block_height` (head)
- `latest_processed_block`
- `timestamp_caught_up_to_head_or_endblock` (the primary "synced" signal)

Compute `sync % = (latest_processed_block - start_block) / (block_height - start_block) * 100` when `block_height > start_block`. Print a compact one-line-per-chain table: chain, processed/head, sync %, caught-up flag.

### 3. Decide

- **All chains have a non-empty `timestamp_caught_up_to_head_or_endblock`:** Report ready-to-promote. Stop looping. Suggest exactly: `pnpm deploy:indexer:promote <commit>`. Do NOT run it — the user must confirm.
- **Any chain still behind:** Wait for the next poll cycle.
- **Cycle count hits 18 without all chains caught up:** Stop looping. Report the last status snapshot and note the 90-min budget was exhausted.

## Rules

- **Never auto-promote.** Surfacing `pnpm deploy:indexer:promote <commit>` to the user is the final step — they run it, not you.
- **Always use the `pnpm deploy:indexer:*` wrappers** over raw `envio-cloud` calls. They handle auth + repo defaults. The one exception is step 1's `indexer get`, which has no wrapper.
- **Stop after 90 minutes** (18 cycles at 5m) without full sync. Typical sync is 15–40 min; 90 min means something is wrong — report last known status and stop.
- **Stop after 30 minutes if the deployment still 404s** (step 1 miss past cycle 6). Direct the user to `pnpm deploy:indexer:logs --build`.
- **Don't spam.** On no-op cycles (still syncing, no state change), output one compact status line, not a full report.
- **`has_processed_to_end_block` is a red herring** for this indexer (`end_block: 0`). Ignore it — only `timestamp_caught_up_to_head_or_endblock` matters.

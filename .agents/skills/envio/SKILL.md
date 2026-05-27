---
name: envio
description: Envio HyperIndex guidance — local dev (`envio` CLI), local/hosted performance metrics, hosted service (`envio-cloud` CLI), Git-based deploys, sync monitoring, promote-to-prod semantics, and Hasura query limits. Use when the user asks about Envio indexers, sync status, performance bottlenecks, promoting a deployment, Envio logs, indexer deploy failures, or GraphQL/Hasura quirks. Tailored to the `mento-protocol/mento` indexer in this repo.
title: Envio Skill
status: active
owner: eng
canonical: true
last_verified: 2026-05-20
allowed-tools: Bash, Read, Grep, Glob, WebFetch
---

# Envio HyperIndex

Two CLIs, two scopes:

| CLI           | Scope                                                    | Auth                               |
| ------------- | -------------------------------------------------------- | ---------------------------------- |
| `envio`       | Local dev (codegen, `envio dev`, Docker Postgres+Hasura) | none                               |
| `envio-cloud` | Hosted service (deployments, promote, logs, metrics)     | GitHub OAuth — `envio-cloud login` |

Docs: <https://docs.envio.dev/docs/HyperIndex/hosted-service>

## Version baseline

- Treat this repo as HyperIndex V3-first. Verify the exact installed package with `pnpm --filter @mento-protocol/indexer-envio exec envio --version`; the pinned version in `indexer-envio/package.json` is `envio@3.0.0`.
- V3 preload optimization is always on. There is no `preload_handlers:` config flag, and loader-era patterns should be translated into normal handler code.
- V3 handlers run twice: a concurrent preload pass for DB reads/effects, then an ordered processing pass for writes. Do not put expensive `context.effect(...)` calls behind an early `if (context.isPreload) return`; do keep writes out of preload.
- Prefer the installed CLI help over stale docs when they disagree. In this baseline, `envio metrics` exists and `envio benchmark-summary` does not.

## Mento repo quick reference

- Org: `mento-protocol`, indexer: `mento`
- Deploy branch: `envio` (multichain Celo + Monad)
- Wrapper scripts (always prefer these over raw CLI inside this repo):

```bash
pnpm deploy:indexer [--yes]         # Push HEAD to `envio` → Envio auto-builds
pnpm deploy:indexer:status [--watch] [--json]
pnpm deploy:indexer:promote [<commit>]
pnpm deploy:indexer:logs [--follow] [--level error] [--build]
```

- Dashboard: <https://envio.dev/app/mento-protocol/mento>

## Deployment lifecycle

1. **Push** to the `envio` branch — Envio GitHub App picks it up and starts a build. There is **no** `envio deploy` command.
2. **Build** produces a new deployment keyed by the short commit hash. A deployment with commit X appears in `envio-cloud indexer get mento mento-protocol` a few minutes after push (expect ~5–15 min). Until then `deployment status` returns **404**.
3. **Sync** — the new deployment re-indexes from `start_block`. The previous deployment keeps serving the GraphQL endpoint with zero downtime.
4. **Promote** — when sync completes, call `deployment promote` to swap `prod_status` to `prod`. Only then does the public GraphQL endpoint point at the new deployment.

Every push triggers a full re-index (event handlers, schema, config.yaml, ABIs, or contract-address changes all invalidate cache). Rollback = `deployment promote <older-commit>`.

### Static vs per-deployment endpoint URLs

Frontends should **always** reference the **static indexer URL** (e.g. `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql` for the mento indexer), not a per-deployment slug. The static URL routes to whichever deployment is currently `prod`, so promotions are transparent.

`envio-cloud deployment endpoint <indexer> <commit>` returns a **per-deployment** slug URL (different per build). Use it only for ad-hoc queries against a specific build — never hardcode it into a frontend env var.

**Propagation lag after promote:** the static URL can take ~30 s – a few minutes to flip to the newly promoted deployment. During that window the UI may transiently query the old schema. If a user reports "broken right after promote", verify with a direct curl against the static URL before assuming the env var is wrong.

## Checking sync status

```bash
pnpm exec envio-cloud deployment status mento <commit> mento-protocol -o json
```

Per-chain fields that matter:

| Field                                     | Meaning                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `block_height`                            | Chain head as Envio sees it (updates continuously)                                                |
| `latest_processed_block`                  | Last block the indexer fully processed                                                            |
| `latest_fetched_block_number`             | HyperSync cursor — ahead of processed during catch-up                                             |
| `timestamp_caught_up_to_head_or_endblock` | Non-empty ISO string once caught up. **Primary signal for "synced".**                             |
| `has_processed_to_end_block`              | Only `true` when config has a concrete `end_block`; ignore for live indexers where `end_block: 0` |
| `num_events_processed`                    | Cumulative; useful for progress feel but not completion                                           |

**"Ready to promote"** = `timestamp_caught_up_to_head_or_endblock` is non-empty on **every** chain in the response. `latest_processed_block === block_height` is a close proxy but can flicker because `block_height` keeps advancing.

Add `--watch-till-synced` to block until all chains hit 100%. Useful in CI or a foreground terminal; for agentic monitoring, poll with `-o json` and parse.

Progress math for a per-chain % estimate: `(latest_processed_block - start_block) / (block_height - start_block)`.

## Logs

```bash
pnpm deploy:indexer:logs --level error        # last 100 runtime error lines
pnpm deploy:indexer:logs --build              # build logs (useful when a deploy doesn't register)
pnpm deploy:indexer:logs --follow             # tail (polls every 10s)
```

`--limit` is clamped to 50 by the wrapper script (`scripts/deploy-indexer-logs.sh`); higher values are silently lowered. `--level` is comma-separated: `trace,debug,info,warn,error`. `--build` flips to build-time logs — check these first if a push never produces a deployment record.

## envio-cloud CLI cheat sheet

```bash
envio-cloud login                                         # GitHub OAuth
envio-cloud config set-org mento-protocol                 # kubectl-style default context
envio-cloud config set-indexer mento
envio-cloud indexer list --org mento-protocol             # public indexers
envio-cloud indexer get mento mento-protocol -o json      # indexer + deployments[]
envio-cloud indexer env list mento mento-protocol         # dashboard env vars (ENVIO_-prefixed)
envio-cloud indexer security                              # IP/domain allowlist
envio-cloud deployment metrics  mento <commit> mento-protocol   # throughput, error rate
envio-cloud deployment info     mento <commit> mento-protocol   # cache/DB exposure config
envio-cloud deployment status   mento <commit> mento-protocol
envio-cloud deployment endpoint mento <commit> mento-protocol   # GraphQL URL
envio-cloud deployment logs     mento <commit> mento-protocol
envio-cloud deployment promote  mento <commit> mento-protocol
envio-cloud deployment restart  mento <commit> mento-protocol
envio-cloud deployment delete   mento <commit> mento-protocol
```

For CI, set `ENVIO_GITHUB_TOKEN` to skip interactive login.

## Local dev (`envio` CLI)

Run from `indexer-envio/`:

```bash
pnpm codegen          # Regenerate types from schema.graphql + config.*.yaml — always run after schema/config edits
pnpm dev              # `envio dev`: Docker up (Postgres+Hasura) + hot-reload indexer
pnpm start            # `envio start`: starts without hot reload; current v3 CLI also runs codegen
pnpm stop             # Stop Docker and drop the local DB
pnpm test             # vitest (`vitest run`)
```

Testnet config is selected via the env-wrapped script in `scripts/run-envio-with-env.mjs`; mainnet uses `config.multichain.mainnet.yaml` by default.

## Local performance triage before hosted re-sync

Before pushing a handler/schema/config change that may trigger an expensive hosted replay, do a cheap local perf pass:

```bash
cd indexer-envio
INDEXER_PERF=1 INDEXER_PERF_LOG_INTERVAL_EVENTS=5000 \
ENVIO_INDEXER_PORT=9898 \
pnpm dev --config config.multichain.mainnet.yaml --restart
```

In another shell:

```bash
pnpm exec envio metrics
curl -s http://127.0.0.1:9898/console/state
curl -s http://127.0.0.1:9898/metrics | rg 'envio_(preload|processing|effect|storage|fetching|progress)'
```

Notes:

- `envio metrics` reads the running indexer's Prometheus endpoint at `127.0.0.1:9898/metrics`; set `ENVIO_INDEXER_PORT` (or legacy `METRICS_PORT`) if using a different port.
- `https://envio.dev/console` can inspect the local dev server; the local server exposes `/console/state` and CORS-allows the Envio app.
- Public docs may lag the installed CLI. In `envio@3.0.0`, `envio metrics` exists; `envio benchmark-summary` does not.
- Watch these generic metrics first: `envio_processing_handler_seconds`, `envio_preload_handler_seconds`, `envio_preload_handler_seconds_total`, `envio_effect_call_seconds_total`, `envio_effect_call_total`, `envio_effect_active_calls`, `envio_effect_queue*`, `envio_storage_load_seconds_total`, `envio_storage_write_seconds`, `envio_fetching_block_range_*`, `envio_progress_events`.
- Combine Envio metrics with this repo's `INDEXER_PERF=1` logs. The repo profiler adds handler/effect/entity summaries and a derived `hit~` count (`effect requests - effect handler executions`) that helps detect preload/cache reuse.
- If a handler has `if (context.isPreload) return` before expensive `context.effect(...)` calls, preload optimization is disabled for those calls. The preferred shape is: perform preload DB reads and independent `context.effect(...)` calls first, then return before entity writes. The processing pass should call the same effect key so it reuses preload results.
- Do not remove every `context.isPreload` guard blindly: storage writes still belong only in the processing pass. The fix is to move bottleneck reads/effects before the guard's return.

## Gotchas

- **Hasura silently caps queries at 1000 rows.** Aggregate functions are disabled on the hosted service. For large pulls, use the offset-pagination helper (`ui-dashboard/src/lib/network-fetcher/fetch.ts` exports `fetchAllFeeSnapshotPages`) or do rollups indexer-side — do not rely on `limit: 10000` working.
- **Free tier auto-deletes after 30 days** (or 7 days idle, or 20GB storage, or 100k events). Paid tiers lift this; the mento indexer is on the `medium` tier. Don't confuse "deployment disappeared" with "build failed" — check `indexer get` first.
- **Re-index on every push.** Schema changes, handler edits, ABI bumps, and config tweaks all invalidate cache. Budget sync time before any deploy (the mento indexer takes ~15–40 min depending on how far behind head).
- **`has_processed_to_end_block: false` is not a failure.** Live indexers have `end_block: 0` so this flag can never flip. Use `timestamp_caught_up_to_head_or_endblock` instead.
- **Don't set generic `ENVIO_RPC_URL` in multichain mode** — it routes every chain to the same RPC. Use `ENVIO_RPC_URL_<chainId>` (e.g. `ENVIO_RPC_URL_42220`).
- **Celo Sepolia / Monad Testnet may fall back to RPC** instead of HyperSync. Slower but works; set `ENVIO_API_TOKEN` for HyperRPC access on testnets.
- **HyperRPC does NOT support `eth_call`** — only event sync (HyperSync) + a subset of chain-info methods (`eth_blockNumber` etc.). Contract reads in handlers (`client.readContract`, `getBreakers()`, `getReserves()`, etc.) MUST use a full-node RPC (`forno.celo.org` for Celo, `rpc2.monad.xyz` / quiknode for Monad). The constraint is hard-documented in `indexer-envio/src/rpc/client.ts` near `RPC_CONFIG_BY_CHAIN`. Don't suggest "switch to HyperRPC for archive depth" as a perf lever — it won't run the call shape we need at all.
- **Version drift is common around V3 RCs.** Check the installed CLI and package before relying on older docs, memory, or notes; do not reintroduce V2-only fields such as `preload_handlers:`.

## Monitoring playbook (agentic)

When asked to "monitor the latest deployment until ready to promote":

1. `pnpm exec envio-cloud indexer get mento mento-protocol -o json` — required to surface `deployments[]` + `prod_status`. Filter for the newest entry where `prod_status !== "prod"`. (`pnpm deploy:indexer:info <commit>` is the wrapper for inspecting a specific known commit, not for the "find newest pending" step.) If no pending deployment exists, cross-check `git rev-parse origin/envio` — if the branch HEAD commit has no deployment record, the build is still pending (or failed → check `--build` logs).
2. Poll `deployment status <commit> -o json` every 5–15 min (Envio builds finish fast, syncs take minutes–hours).
3. Ready-to-promote condition: every chain in `data[]` has a non-empty `timestamp_caught_up_to_head_or_endblock`.
4. Surface the result with a progress table and `pnpm deploy:indexer:promote <commit>` as the suggested next step — **do not promote without the user's OK.**

## Useful links

- Hosted service overview: <https://docs.envio.dev/docs/HyperIndex/hosted-service>
- Deployment guide: <https://docs.envio.dev/docs/HyperIndex/hosted-service-deployment>
- Billing/limits: <https://docs.envio.dev/docs/HyperIndex/hosted-service-billing>
- CLI reference: <https://docs.envio.dev/docs/HyperIndex/cli-commands>
- Repo AGENTS.md: `indexer-envio/AGENTS.md`

---
name: envio
description: Envio HyperIndex guidance — local dev (`envio` CLI), local/hosted performance metrics, hosted service (`envio-cloud` CLI), Git-based deploys, sync monitoring, promote-to-prod semantics, and Hasura query limits. Use when the user asks about Envio indexers, sync status, performance bottlenecks, promoting a deployment, Envio logs, indexer deploy failures, or GraphQL/Hasura quirks. Tailored to the `mento-protocol/mento` indexer in this repo.
title: Envio Skill
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
allowed-tools: Bash, Read, Grep, Glob, WebFetch
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Envio HyperIndex

Two CLIs, two scopes:

| CLI           | Scope                                                    | Auth                               |
| ------------- | -------------------------------------------------------- | ---------------------------------- |
| `envio`       | Local dev (codegen, `envio dev`, Docker Postgres+Hasura) | none                               |
| `envio-cloud` | Hosted service (deployments, promote, logs, metrics)     | GitHub OAuth — `envio-cloud login` |

Docs: <https://docs.envio.dev/docs/HyperIndex/hosted-service>

## Version baseline

- Treat this repo as HyperIndex V3-first. Verify the exact installed package with `pnpm --filter @mento-protocol/indexer-envio exec envio --version`; the pinned version in `indexer-envio/package.json` is `envio@3.2.1`.
- V3 preload optimization is always on. There is no `preload_handlers:` config flag, and loader-era patterns should be translated into normal handler code.
- V3 handlers run twice: a concurrent preload pass for reads/effects, then an
  ordered processing pass for writes. Before changing a handler or RPC effect,
  read `indexer-envio/AGENTS.md` and
  `docs/pr-checklists/indexer-handler-invariants.md`; that checklist owns effect
  ordering, preload markers, exemption syntax, helper declarations, and tests.
- Prefer the installed CLI help over stale docs when they disagree. In this baseline, `envio metrics`, `envio metrics runtime`, `envio tools search-docs`, and `envio tools fetch-docs` exist; `envio benchmark-summary` does not.

## Mento repo quick reference

- Org: `mento-protocol`, indexer: `mento`
- Deploy branch: `envio` (multichain Celo + Monad + Polygon, plus Ethereum reserve-yield events)
- Wrapper scripts (always prefer these over raw CLI inside this repo):

```bash
pnpm deploy:indexer [--yes]         # Push HEAD to `envio` → Envio auto-builds
pnpm deploy:indexer:status [<commit>] [--watch] [--compact] [--json]
pnpm deploy:indexer:metrics [<commit>] [--json]
pnpm deploy:indexer:info [<commit>]
pnpm deploy:indexer:perf [<commit>] [--json]
pnpm deploy:indexer:verify [<commit>] [--prod] [--json]
pnpm deploy:indexer:promote [<commit>]
pnpm deploy:indexer:logs [<commit>] [--follow] [--level error] [--build]
pnpm deploy:indexer:rollback <commit> [--dry-run]
```

- Dashboard: <https://envio.dev/app/mento-protocol/mento>

## Deployment lifecycle

1. **Push** to the `envio` branch — Envio GitHub App picks it up and starts a build. There is **no** `envio deploy` command.
2. **Build** produces a new deployment keyed by a commit-hash prefix. In this
   repo registration normally takes 2–3 minutes; the deploy skill warns at
   three and uses a five-minute ceiling. Until registration, deployment status
   is unavailable. If `data.deployments[]` already has three entries, delete,
   or ask the user to delete, an obsolete non-prod deployment before retrying.
3. **Sync** — the new deployment re-indexes from `start_block`. The previous deployment keeps serving the GraphQL endpoint with zero downtime.
4. **Promote** — when sync completes, call `deployment promote` to swap `prod_status` to `prod`. Only then does the public GraphQL endpoint point at the new deployment.

Each new deployment performs a full re-index. Use
`pnpm deploy:indexer:rollback <last-good-sha> --dry-run` and then the guarded
rollback wrapper; direct promotion is only its fast path when the old
deployment is still retained.

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

**"Caught up"** = `timestamp_caught_up_to_head_or_endblock` is non-empty on
**every** chain in the response. This is `SYNCED_PENDING_DATA_VERIFY`, not
`READY_TO_PROMOTE`: the commit-scoped deployment verifier must still pass.
`latest_processed_block === block_height` is a close proxy but can flicker
because `block_height` keeps advancing.

The repo status wrapper owns blocking agent watches; use raw
`--watch-till-synced` only outside that workflow.

Progress math for a per-chain % estimate: `(latest_processed_block - start_block) / (block_height - start_block)`.

## Logs

```bash
pnpm deploy:indexer:logs <commit> --level error  # runtime errors
pnpm deploy:indexer:logs <commit> --build        # registered build logs
pnpm deploy:indexer:logs <commit> --follow       # tail every 10s
```

`envio-cloud` defaults to 100 log lines and supports `--limit` up to 100; the
wrapper passes that flag through. `--level` is comma-separated and `--build`
selects build-time logs. If the target never registers, do not substitute an
unscoped older deployment's logs; use the registration diagnostic and Envio UI.

## `envio-cloud` CLI

```bash
pnpm exec envio-cloud --help
pnpm exec envio-cloud indexer get mento mento-protocol -o json
pnpm exec envio-cloud deployment status mento <commit> mento-protocol -o json
pnpm exec envio-cloud deployment endpoint mento <commit> mento-protocol
pnpm exec envio-cloud indexer env list mento mento-protocol
```

Use the workspace-pinned CLI and its current `--help`; `envio-cloud` is still
pre-1.0. Prefer repo wrappers for deploy, verify, promote, rollback, logs,
metrics, and info so org/indexer defaults and guards stay centralized.
`envio-cloud indexer env list` masks values by default. Its `--show-values`
form reveals raw `ENVIO_*` secrets; run that only when explicitly required and
never paste or quote the output in chat, PRs, logs, or docs.

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
pnpm exec envio metrics runtime
pnpm exec envio tools search-docs "getWhere multiple fields"
curl -s http://127.0.0.1:9898/console/state
curl -s http://127.0.0.1:9898/metrics | rg 'envio_(preload|processing|effect|storage|fetching|progress)'
```

Notes:

- `envio metrics` reads the running indexer's Prometheus endpoint at `127.0.0.1:9898/metrics`; set `ENVIO_INDEXER_PORT` (or legacy `METRICS_PORT`) if using a different port.
- `envio metrics runtime` reads the running indexer's `/metrics/runtime` endpoint; use it alongside Prometheus metrics when handler/effect timing is the question.
- `envio tools search-docs <query>` and `envio tools fetch-docs <url>` are available in `envio@3.2.1`; prefer them over web search for quick HyperIndex API checks.
- `https://envio.dev/console` can inspect the local dev server; the local server exposes `/console/state` and CORS-allows the Envio app.
- Public docs may lag the installed CLI. In `envio@3.2.1`, `envio metrics` and `envio metrics runtime` exist; `envio benchmark-summary` does not.
- Watch these generic metrics first: `envio_processing_handler_seconds`, `envio_preload_handler_seconds`, `envio_preload_handler_seconds_total`, `envio_effect_call_seconds_total`, `envio_effect_call_total`, `envio_effect_active_calls`, `envio_effect_queue*`, `envio_storage_load_seconds_total`, `envio_storage_write_seconds`, `envio_fetching_block_range_*`, `envio_progress_events`.
- Combine Envio metrics with this repo's `INDEXER_PERF=1` logs. The repo profiler adds handler/effect/entity summaries and a derived `hit~` count (`effect requests - effect handler executions`) that helps detect preload/cache reuse.
- Apply `docs/pr-checklists/indexer-handler-invariants.md` before moving any
  effect or preload guard; it distinguishes batchable calls from ordered-state
  exceptions and owns the required regression coverage.

## Gotchas

- **Hasura silently caps queries at 1000 rows.** Aggregate functions are disabled on the hosted service. For large pulls, use the offset-pagination helper (`ui-dashboard/src/lib/network-fetcher/fetch.ts` exports `fetchAllFeeSnapshotPages`) or do rollups indexer-side — do not rely on `limit: 10000` working.
- **Hosted deployment cap is three live deployments.** `envio-cloud indexer get mento mento-protocol -o json` shows the full `data.deployments[]` list. If it already contains three entries, a new push can fail to register because Envio has no capacity for another deployment. Keep the `prod_status == "prod"` deployment and remove an obsolete non-prod deployment before retrying.
- **Re-index on every new deployment.** Schema changes, handler edits, ABI
  bumps, and config tweaks all require replay. Do not promise a fixed duration;
  monitor the exact commit with the status wrapper.
- **`has_processed_to_end_block: false` is not a failure.** Live indexers have `end_block: 0` so this flag can never flip. Use `timestamp_caught_up_to_head_or_endblock` instead.
- **Don't set generic `ENVIO_RPC_URL` in multichain mode** — it routes every chain to the same RPC. Use `ENVIO_RPC_URL_<chainId>` (e.g. `ENVIO_RPC_URL_42220`).
- **Celo Sepolia / Monad Testnet may fall back to RPC** instead of HyperSync. Slower but works; set `ENVIO_API_TOKEN` for HyperRPC access on testnets.
- **HyperRPC does NOT support `eth_call`** — only event sync (HyperSync) + a subset of chain-info methods (`eth_blockNumber` etc.). Contract reads in handlers (`client.readContract`, `getBreakers()`, `getReserves()`, etc.) MUST use a full-node RPC (`forno.celo.org` for Celo, `rpc2.monad.xyz` / quiknode for Monad). The constraint is hard-documented in `indexer-envio/src/rpc/client.ts` near `RPC_CONFIG_BY_CHAIN`. Don't suggest "switch to HyperRPC for archive depth" as a perf lever — it won't run the call shape we need at all.
- **dRPC public JSON-RPC batches are capped at three calls.** The repo applies
  `{ batchSize: 3 }` to exact `drpc.org` hosts; do not replace it with viem's
  default 1,000-call batch. Tracked SortedOracles events also fail closed when
  their exact-block median timestamp remains unavailable after transient retry
  and fallback. A caught-up deployment with those historical reads missing is
  tainted and requires a clean replay.
- **Never bridge Envio's preload and processing passes with module-local mutable
  state.** Hosted workers and process restarts do not share a module-scoped
  `Set` or `Map`. Derive conditional-effect eligibility from the entity/event
  inputs in each pass (or use a phase-stable event-only condition), invoke the
  identical effect key before the preload return, and let a rare newly-visible
  entity take the safe serialized exact-block path. A missing warmed result must
  fail closed; it must not be reconstructed from a later event.
- **Version drift is common around V3 RCs.** Check the installed CLI and package before relying on older docs, memory, or notes; do not reintroduce V2-only fields such as `preload_handlers:`.
- Development-plan retention and quota rules change independently of this
  repo. Check Envio's current hosted deployment/billing pages instead of
  copying those limits into an operational answer.

## Monitoring playbook (agentic)

When asked to "monitor the latest deployment until ready to promote":

1. `pnpm exec envio-cloud indexer get mento mento-protocol -o json` — required to surface `deployments[]` + `prod_status`. Filter for the newest entry where `prod_status !== "prod"`. (`pnpm deploy:indexer:info <commit>` is the wrapper for inspecting a specific known commit, not for the "find newest pending" step.) If no pending deployment exists, count `deployments[]` first: three live entries means Envio has no room for a new deployment and you must delete, or ask the user to delete, an obsolete non-prod deployment before retrying. If fewer than three deployments exist, cross-check `git rev-parse origin/envio` — if the branch HEAD commit has no deployment record, the build is still pending (or failed → check `--build` logs).
2. Run `pnpm deploy:indexer:status <commit> --watch --compact`; the wrapper
   owns registration diagnostics and polling. Enforce the separate sync
   deadline in the active agent/monitor.
3. Caught-up condition: every chain in `data[]` has a non-empty `timestamp_caught_up_to_head_or_endblock`; classify this as `SYNCED_PENDING_DATA_VERIFY`.
4. Run `pnpm deploy:indexer:verify <commit>` to batch status, metrics, endpoint resolution, core rows, and Polygon replay semantics before promotion. Polygon semantic failures are never waived by `--allow-syncing`.
5. A passing verifier yields `VERIFIED_PENDING_PROMOTION`, not permission to
   run the promote wrapper by itself. If this monitor belongs to an active
   `/deploy-indexer` run, return control to Phase 4 so it captures prior prod
   and completes promotion, propagation, and UI verification after explicit
   authorization.
6. Otherwise treat the candidate's provenance as unclassified. With explicit
   production authorization, route it through
   `/deploy-indexer --resume-preload <commit>`; that guarded continuation binds
   protected main to the canonical repository, checks tree equality, reconfirms
   sync, and executes Phases 3–6. Never suggest a bare
   `pnpm deploy:indexer:promote` command as monitor closeout.

## Useful links

- Hosted service overview: <https://docs.envio.dev/docs/HyperIndex/hosted-service>
- Deployment guide: <https://docs.envio.dev/docs/HyperIndex/hosted-service-deployment>
- Billing/limits: <https://docs.envio.dev/docs/HyperIndex/hosted-service-billing>
- CLI reference: <https://docs.envio.dev/docs/HyperIndex/cli-commands>
- Repo AGENTS.md: `indexer-envio/AGENTS.md`

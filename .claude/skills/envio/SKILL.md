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

- Treat this repo as HyperIndex V3-first. Resolve the exact installed package with `pnpm --filter @mento-protocol/indexer-envio exec envio --version` instead of trusting a version literal in docs, notes, or memory.
- V3 preload optimization is always on. There is no `preload_handlers:` config flag, and loader-era patterns should be translated into normal handler code.
- V3 handlers run twice: a concurrent preload pass for reads/effects, then an
  ordered processing pass for writes. Before changing a handler or RPC effect,
  read `indexer-envio/AGENTS.md` and
  `docs/pr-checklists/indexer-handler-invariants.md`; that checklist owns effect
  ordering, phase-state and preload markers, exemption syntax, helper
  declarations, and tests.
- Prefer the installed CLI help over stale docs when they disagree. In this baseline, `envio metrics`, `envio metrics runtime`, `envio tools search-docs`, and `envio tools fetch-docs` exist; `envio benchmark-summary` does not.

## Mento repo quick reference

- Org: `mento-protocol`, indexer: `mento`
- Deploy branch: `envio` (multichain Celo + Monad + Polygon, plus Ethereum reserve-yield events)
- Always prefer the repo wrappers over the raw CLI so org/indexer defaults and
  guards stay centralized: `pnpm deploy:indexer` plus
  `pnpm deploy:indexer:{status,metrics,info,perf,verify,promote,logs,rollback}`.
  The companion wrappers take a `<commit>` (optional except for `rollback`);
  `pnpm deploy:indexer` itself always deploys the checked-out `HEAD` and takes
  no commit argument. Check each script for its flags.
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
pnpm deploy:indexer:logs <commit> --errors-only --since 2h
```

`--errors-only` owns the limit: it queries Envio's maximum 100-record page and
**fails closed** when Envio fills it, because the rest of the requested window
cannot be inspected. Narrow `--since` and retry; do not combine `--limit` with
`--errors-only`. The mode uses the wrapper's local JSON filter because Envio's
`--level error` can retain stdout-carried records; `--level` remains useful for
broad provider-level inspection. `--build` selects build-time logs and
`--follow` tails every 10s. If the target never registers, do not substitute an
unscoped older deployment's logs; use the registration diagnostic and Envio UI.

## `envio-cloud` CLI

Use the workspace-pinned CLI and its current `--help`; `envio-cloud` is still
pre-1.0. Prefer the repo wrappers for deploy, verify, promote, rollback, logs,
metrics, and info, and reach for raw subcommands (`indexer get`,
`deployment status`, `deployment endpoint`, `indexer env list`) only for reads
the wrappers do not cover — for example
`pnpm exec envio-cloud indexer get mento mento-protocol -o json`.

`envio-cloud indexer env list` masks values by default. Its `--show-values`
form reveals raw `ENVIO_*` secrets; run that only when explicitly required and
never paste or quote the output in chat, PRs, logs, or docs.

For CI, set `ENVIO_GITHUB_TOKEN` to skip interactive login.

## Local dev and performance

Local dev commands (codegen, `envio dev`, the Docker Postgres+Hasura stack,
tests) are owned by `indexer-envio/AGENTS.md` and the package README; run
`pnpm indexer:codegen` after schema, config, or handler-reachability edits.

Before pushing a handler/schema/config change that may trigger an expensive
hosted replay, do a cheap local perf pass: [`performance.md`](performance.md)
has the run commands, the metrics to watch first, and the profiler notes.

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
- **dRPC batch caps and the SortedOracles bootstrap are checklist-owned.** Apply
  `docs/pr-checklists/indexer-handler-invariants.md` before touching those RPC paths.
- **Effect rate limits are global to each created effect object.** A provider-
  specific cap in this multichain indexer must be routed through distinct
  chain/provider-scoped effect objects. Keep preload and processing on the same
  selected object so Envio still deduplicates identical inputs; never let one
  chain's public-tier floor throttle every chain.
- **Polygon oracle-freshness replay integrity is versioned.** V3 requires the
  exact-boundary timestamp-list bootstrap plus event-sourced
  `OracleReported` and `OracleReportRemoved` transitions. V1/v2 deployments are
  not promotion-compatible; `pnpm deploy:indexer:verify <commit>` enforces the
  marker before promotion.
- **Version drift is common around V3 RCs.** Check the installed CLI and package before relying on older docs, memory, or notes; do not reintroduce V2-only fields such as `preload_handlers:`.
- Development-plan retention and quota rules change independently of this
  repo. Check Envio's current hosted deployment/billing pages instead of
  copying those limits into an operational answer.

## Monitoring playbook (agentic)

"Monitor the latest deployment until ready to promote" runs the Phase 2–3
contract in [`../deploy-indexer/SKILL.md`](../deploy-indexer/SKILL.md): find the
newest `prod_status !== "prod"` entry with
`pnpm exec envio-cloud indexer get mento mento-protocol -o json` (three live
entries means there is no room for a new deployment; no record for
`git rev-parse origin/envio` means the build is still pending or failed), watch
it with `pnpm deploy:indexer:status <commit> --watch --compact`, classify
caught-up as `SYNCED_PENDING_DATA_VERIFY`, then run
`pnpm deploy:indexer:verify <commit>`.

A passing verifier yields `VERIFIED_PENDING_PROMOTION`, not permission to
promote: return control to the active `/deploy-indexer` run, or route an
unclassified candidate through `/deploy-indexer --resume-preload <commit>` after
explicit production authorization. Never suggest a bare
`pnpm deploy:indexer:promote` as monitor closeout.

## Useful links

- Hosted service overview: <https://docs.envio.dev/docs/HyperIndex/hosted-service>
- Deployment guide: <https://docs.envio.dev/docs/HyperIndex/hosted-service-deployment>
- Billing/limits: <https://docs.envio.dev/docs/HyperIndex/hosted-service-billing>
- CLI reference: <https://docs.envio.dev/docs/HyperIndex/cli-commands>
- Repo AGENTS.md: `indexer-envio/AGENTS.md`

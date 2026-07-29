---
title: Envio Local Performance Triage
status: active
owner: eng
canonical: true
last_verified: 2026-07-29
doc_type: skill
scope: repo-wide
review_interval_days: 90
garden_lane: agent-entry-points
---

# Local performance triage before hosted re-sync

Before pushing a handler/schema/config change that may trigger an expensive
hosted replay, do a cheap local perf pass:

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
- `envio tools search-docs <query>` and `envio tools fetch-docs <url>` exist in this baseline; prefer them over web search for quick HyperIndex API checks.
- `https://envio.dev/console` can inspect the local dev server; the local server exposes `/console/state` and CORS-allows the Envio app.
- Public docs may lag the installed CLI. Confirm a subcommand against `--help` on the pinned CLI before relying on it; `envio benchmark-summary` does not exist here.
- Watch these generic metrics first: `envio_processing_handler_seconds`, `envio_preload_handler_seconds`, `envio_preload_handler_seconds_total`, `envio_effect_call_seconds_total`, `envio_effect_call_total`, `envio_effect_active_calls`, `envio_effect_queue*`, `envio_storage_load_seconds_total`, `envio_storage_write_seconds`, `envio_fetching_block_range_*`, `envio_progress_events`.
- Combine Envio metrics with this repo's `INDEXER_PERF=1` logs. The repo profiler adds handler/effect/entity summaries and a derived `hit~` count (`effect requests - effect handler executions`) that helps detect preload/cache reuse.
- Apply `docs/pr-checklists/indexer-handler-invariants.md` before moving any
  effect or preload guard; it distinguishes batchable calls from ordered-state
  exceptions and owns the required regression coverage.

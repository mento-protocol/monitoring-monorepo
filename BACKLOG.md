# Backlog

GitHub Issues are the canonical active-work queue for agent-addressable work.
Use this query for ready items:

```text
is:issue is:open label:agent-ready -label:agent-active -label:in-pr
```

This file is transition storage for backlog items that have not yet been
migrated. It is currently **empty** — as of 2026-05-29 every tracked item is
either shipped, a GitHub Issue, or a `docs/notes/` record (see below). Append
here only for an item that genuinely has nowhere else to live yet; migrate it to
an Issue promptly.

- Active work → GitHub Issues (`source:backlog` label; priorities `priority:p1/p2/p3`).
- Decisions recorded so they aren't re-litigated → `docs/notes/terraform-cicd-hardening-decisions-2026-05.md`.
- Passive watch lists / parked ideas → `docs/notes/file-size-watch.md`, `docs/notes/indexer-spec-followups.md`.
- Speculative future sinks (Streamlit, ClickHouse) → `docs/ROADMAP.md`.

Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`, or
tests. Workflow details live in `docs/notes/agent-issue-workflow.md`.

## File-size watchlist (auto-generated)

_Last updated: 2026-07-01 by file-size-budget-drift-detector. Soft cap 600 lines / hard cap 1,000. See `/AGENTS.md` §"File-size budget"._

| Lines | File                                                                        | Δ since last report |
| ----: | --------------------------------------------------------------------------- | ------------------: |
|  1312 | ui-dashboard/src/lib/network-fetcher/fetch.ts                               |               (new) |
|  1052 | ui-dashboard/src/components/oracle-chart.tsx                                |               (new) |
|  1032 | indexer-envio/src/handlers/liquity/troveManager.ts                          |               (new) |
|  1027 | indexer-envio/src/breakers.ts                                               |               (new) |
|   986 | indexer-envio/src/handlers/sortedOracles.ts                                 |               (new) |
|   978 | integration-probes/src/adapters.ts                                          |               (new) |
|   943 | indexer-envio/src/rpc/effects.ts                                            |               (new) |
|   887 | ui-dashboard/src/app/cdps/[symbol]/\_components/cdp-trove-table.tsx         |               (new) |
|   857 | ui-dashboard/src/lib/health.ts                                              |               (new) |
|   818 | ui-dashboard/src/lib/volume.ts                                              |               (new) |
|   796 | indexer-envio/src/rpc/breakers.ts                                           |               (new) |
|   742 | ui-dashboard/src/lib/homepage-og.ts                                         |               (new) |
|   733 | indexer-envio/src/handlers/fpmm/state-sync.ts                               |               (new) |
|   718 | metrics-bridge/src/metrics.ts                                               |               (new) |
|   716 | indexer-envio/src/handlers/broker.ts                                        |               (new) |
|   709 | indexer-envio/src/volumeSnapshots.ts                                        |               (new) |
|   700 | ui-dashboard/src/app/page-client.tsx                                        |               (new) |
|   687 | ui-dashboard/src/components/volume-over-time-chart.tsx                      |               (new) |
|   686 | ui-dashboard/src/app/pool/[poolId]/\_tabs/oracle-tab.tsx                    |               (new) |
|   669 | ui-dashboard/src/app/pool/[poolId]/\_components/pool-detail-page-client.tsx |               (new) |
|   669 | indexer-envio/src/pool/self-heal.ts                                         |               (new) |
|   667 | ui-dashboard/src/lib/queries/volume.ts                                      |               (new) |
|   660 | ui-dashboard/src/app/volume/\_components/v3-flow-insights.tsx               |               (new) |
|   654 | indexer-envio/src/handlers/wormhole/nttManager.ts                           |               (new) |
|   642 | ui-dashboard/src/lib/cdp-borrowing-revenue.ts                               |               (new) |
|   640 | ui-dashboard/src/app/cdps/[symbol]/\_components/cdp-detail-client.tsx       |               (new) |
|   632 | ui-dashboard/src/lib/volume-hero.ts                                         |               (new) |
|   626 | indexer-envio/src/pool.ts                                                   |               (new) |
|   617 | indexer-envio/src/handlers/liquity/stabilityPool.ts                         |               (new) |
|   617 | indexer-envio/src/handlers/biPoolManager.ts                                 |               (new) |
|   610 | ui-dashboard/src/lib/address-labels/snapshot.ts                             |               (new) |
|   607 | ui-dashboard/src/app/stables/\_lib/aggregate.ts                             |               (new) |

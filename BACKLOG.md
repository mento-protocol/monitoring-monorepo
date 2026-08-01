---
title: Backlog transition storage
status: active
owner: eng
canonical: false
last_verified: 2026-07-24
doc_type: tracker
scope: repo-wide
review_interval_days: 90
garden_lane: notes-plans-archive
---

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

Durable lessons belong in `AGENTS.md`, `docs/pr-checklists/`, `docs/notes/`, or
tests. Workflow details live in `docs/notes/agent-issue-workflow.md`.

## File-size watchlist (auto-generated)

_Last updated: 2026-08-01 by file-size-budget-drift-detector. Soft cap 600 lines / hard cap 1,000. See `/AGENTS.md` §"File-size budget"._

| Lines | File | Δ since last report |
|---:|---|---:|
| 8316 | ui-dashboard/src/lib/__generated__/graphql.ts | (new) |
| 4262 | indexer-envio/.envio/types.d.ts | (new) |
| 1174 | indexer-envio/src/handlers/sortedOracles.ts | (new) |
| 1119 | ui-dashboard/src/components/oracle-chart.tsx | (new) |
| 1051 | indexer-envio/src/breakers.ts | (new) |
| 980 | indexer-envio/src/rpc/effects.ts | (new) |
| 973 | metrics-bridge/src/peg/poller.ts | (new) |
| 970 | ui-dashboard/src/lib/health.ts | (new) |
| 868 | ui-dashboard/src/lib/volume.ts | (new) |
| 821 | indexer-envio/src/rpc/breakers.ts | (new) |
| 810 | ui-dashboard/src/lib/homepage-og.ts | (new) |
| 799 | indexer-envio/src/handlers/fpmm/state-sync.ts | (new) |
| 784 | ui-dashboard/src/app/page-client.tsx | (new) |
| 772 | ui-dashboard/src/app/pool/[poolId]/_components/pool-detail-page-client.tsx | (new) |
| 764 | indexer-envio/src/handlers/liquity/troveManager.ts | (new) |
| 744 | indexer-envio/src/rpc/oracle-state.ts | (new) |
| 725 | ui-dashboard/src/components/volume-over-time-chart.tsx | (new) |
| 724 | ui-dashboard/src/components/time-series-chart-card.tsx | (new) |
| 719 | ui-dashboard/src/lib/queries/volume.ts | (new) |
| 711 | metrics-bridge/src/metrics.ts | (new) |
| 709 | indexer-envio/src/volumeSnapshots.ts | (new) |
| 709 | indexer-envio/src/handlers/broker.ts | (new) |
| 692 | ui-dashboard/src/app/pool/[poolId]/_tabs/oracle-tab.tsx | (new) |
| 689 | aegis/src/metric.spec.ts | (new) |
| 682 | ui-dashboard/src/lib/network-fetcher/pagination.ts | (new) |
| 669 | indexer-envio/src/pool/self-heal.ts | (new) |
| 654 | indexer-envio/src/handlers/wormhole/nttManager.ts | (new) |
| 642 | ui-dashboard/src/lib/cdp-borrowing-revenue.ts | (new) |
| 638 | ui-dashboard/src/lib/pool-og.ts | (new) |
| 632 | ui-dashboard/src/lib/volume-hero.ts | (new) |
| 624 | indexer-envio/src/handlers/biPoolManager.ts | (new) |
| 620 | aegis/src/query.service.spec.ts | (new) |
| 619 | indexer-envio/src/handlers/liquity/stabilityPool.ts | (new) |
| 610 | ui-dashboard/src/lib/address-labels/snapshot.ts | (new) |
| 607 | ui-dashboard/src/app/stables/_lib/aggregate.ts | (new) |
| 606 | ui-dashboard/src/app/volume/page-client.tsx | (new) |

---
title: Mento Monitoring Technical Specification
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
doc_type: reference
scope: repo-wide
review_interval_days: 90
garden_lane: package-readmes-reference
---

# Mento Monitoring — Technical Specification

This is the canonical high-level map of the monitoring system: its boundaries,
data flows, public interfaces, and owning implementation surfaces. It
intentionally does not duplicate package commands, schema inventories,
dashboard component lists, alert expressions, rollout state, or backlog items.
Follow the linked owner when exact current behavior matters.

## System scope

The system observes Mento protocol activity across Celo, Monad, and Polygon,
plus Ethereum reserve-yield positions. It turns on-chain state into:

- a Hasura GraphQL read API backed by Envio HyperIndex;
- a public and workspace-gated monitoring dashboard;
- continuous metric alerts evaluated by Grafana; and
- event-driven notifications for control-plane and application events.

| Public entry point | Address                                             |
| ------------------ | --------------------------------------------------- |
| Dashboard          | <https://monitoring.mento.org>                      |
| Production GraphQL | `https://indexer.hyperindex.xyz/2f3dd15/v1/graphql` |

The GraphQL URL is stable for the current Envio project. A deployment is not
production merely because its configuration is merged; use the
[deployment reference](./indexer-envio/STATUS.md) and
[deployment runbook](./docs/deployment.md) for current-state verification and
promotion.

## Architecture

```text
 Celo / Monad / Polygon events       Ethereum reserve-yield events
                 │                               │
                 └──────────────┬────────────────┘
                                ▼
                      Envio HyperIndex (hosted)
                                │
                                ▼
                         Hasura GraphQL ─────────────► Next.js dashboard
                                │
                                └───────────────────┐
 CEX order books ──────────────────────────────────┤
 RPC oracle conversion views ──────────────────────┴──► metrics-bridge
                                                         │
 RPC view calls ──► Aegis ───────────────────────────────┤
                                                         ▼
                                                 Grafana Alloy
                                                         │
                                                    Grafana Cloud
                                                         │
                                                 Slack / Splunk On-Call

 QuickNode webhooks ──► alert Cloud Functions ──► Slack
 Sentry events ───────► Sentry bridge ──────────► Slack
 Governance events ──► governance-watchdog ────► Discord / Telegram
 Scheduled quote probes ──► Upstash snapshot ──► dashboard
```

The system has four principal data paths:

1. **Read path:** Envio writes indexed entities; Envio-managed Hasura exposes
   them directly to the dashboard and other readers. There is no bespoke read
   service between Hasura and its consumers.
2. **Metric-alert path:** `metrics-bridge` converts indexed v3 state to
   Prometheus gauges. When its protected policy artifact is configured, an
   isolated peg lifecycle combines indexed structural state with direct CEX
   order books and RPC oracle conversion views. Aegis polls v2 contract views.
   Grafana Alloy sends both metric streams to Grafana Cloud for evaluation and
   routing.
3. **Event and incident path:** discrete events bypass the metric path.
   QuickNode and governance handlers deliver through their owning Cloud
   Functions. The Sentry-to-Slack bridge is configured directly through the
   Sentry and Slack providers, with no function in that path; scheduled Sentry
   workflows separately triage incidents into GitHub issues and eligible
   autofix PRs.
4. **Integration-health path:** scheduled read-only quote probes publish a
   bounded snapshot to Upstash for the dashboard.

Services share repository context and configuration but deploy independently.
The governing decisions are
[ADR 0001](./docs/adr/0001-monorepo-independent-deploys.md),
[ADR 0003](./docs/adr/0003-hasura-graphql-read-api.md),
[ADR 0004](./docs/adr/0004-two-alert-planes.md), and
[ADR 0036](./docs/adr/0036-sentry-triage-pipeline.md).

## Runtime boundaries

| Surface                    | Responsibility                                          | Runtime or platform          | Owning source                                                                |
| -------------------------- | ------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| Shared config              | Chain, token, deployment, threshold, and ABI metadata   | Published TypeScript package | [`shared-config/AGENTS.md`](./shared-config/AGENTS.md)                       |
| Indexer and GraphQL        | Event/RPC ingestion, entities, rollups, Hasura API      | Envio hosted                 | [`indexer-envio/AGENTS.md`](./indexer-envio/AGENTS.md)                       |
| Dashboard                  | Human-facing monitoring and analysis                    | Vercel                       | [`ui-dashboard/AGENTS.md`](./ui-dashboard/AGENTS.md)                         |
| Metrics bridge             | Indexed Hasura and direct CEX/RPC peg metrics           | Cloud Run                    | [`metrics-bridge/AGENTS.md`](./metrics-bridge/AGENTS.md)                     |
| Aegis                      | v2 contract view calls to Prometheus metrics            | App Engine                   | [`aegis/AGENTS.md`](./aegis/AGENTS.md)                                       |
| Collector                  | Aegis and bridge scrape jobs to Grafana Cloud           | Grafana Alloy on App Engine  | `aegis/grafana-agent/`                                                       |
| Metric rules and routing   | Grafana rules, contact points, templates, mute timings  | Grafana Cloud                | [`alerts/AGENTS.md`](./alerts/AGENTS.md)                                     |
| Event delivery             | QuickNode handler and on-call rotation announcer        | Cloud Functions              | [`alerts/AGENTS.md`](./alerts/AGENTS.md)                                     |
| Sentry notification bridge | Direct Sentry-to-Slack alert and channel configuration  | Terraform providers          | [`sentry-bridge/README.md`](./alerts/infra/channels/sentry-bridge/README.md) |
| Sentry triage and autofix  | Incident ingest, issue projection, and eligible fix PRs | GitHub Actions               | [ADR 0036](./docs/adr/0036-sentry-triage-pipeline.md)                        |
| Governance watchdog        | Governance event notifications                          | Cloud Function               | [`governance-watchdog/README.md`](./governance-watchdog/README.md)           |
| Integration probes         | Read-only aggregator and router coverage snapshots      | GitHub Actions and Upstash   | [`integration-probes/AGENTS.md`](./integration-probes/AGENTS.md)             |

## Networks, contracts, and identifiers

| Network                                   |               Chain ID | Configured role                                              | Detailed owner                                                     |
| ----------------------------------------- | ---------------------: | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Celo Mainnet                              |                  42220 | Core protocol, CDP, stable, bridge, and v2 Broker monitoring | Mainnet indexer config                                             |
| Monad Mainnet                             |                    143 | Core protocol, stable, and bridge monitoring                 | Mainnet indexer config                                             |
| Polygon Mainnet                           |                    137 | Core protocol, stable, bridge, probe, and alert coverage     | [Polygon coverage and rollout](./docs/notes/polygon-monitoring.md) |
| Ethereum                                  |                      1 | Reserve-yield accounting                                     | [Reserve-yield invariants](./docs/notes/reserve-yield-indexer.md)  |
| Celo Sepolia, Monad Testnet, Polygon Amoy | 11142220, 10143, 80002 | Opt-in testnet indexing and dashboard coverage               | Testnet indexer config                                             |

The executable network declarations are
[`config.multichain.mainnet.yaml`](./indexer-envio/config.multichain.mainnet.yaml)
and
[`config.multichain.testnet.yaml`](./indexer-envio/config.multichain.testnet.yaml).
Configuration establishes intended coverage, not live production state.

Published addresses and ABIs come from `@mento-protocol/contracts`; active
deployment namespaces and shared metadata come from `shared-config/`. The
indexer config may additionally use the documented NTT metadata and explicit
allowlist. CI rejects unexplained address literals. FPMM pools are discovered
dynamically, so this specification carries no static pool or contract-address
inventory.

The indexed data contract is
[`indexer-envio/schema.graphql`](./indexer-envio/schema.graphql). Cross-chain
entity identifiers include the chain dimension; pool IDs use
`{chainId}-{poolAddress}`. The indexer README owns the current contract, event,
and entity inventory.

## Monitored domains

| Domain                                                                     | Producer authority                          | Main consumers                               |
| -------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Pool, oracle, trading-limit, breaker, liquidity, swap, and rebalance state | Indexer config, schema, and loaded handlers | Dashboard, metrics bridge, Grafana rules     |
| Liquity/CDP and stability-pool state                                       | Indexer Liquity handlers and schema         | CDP dashboard, metrics bridge, Grafana rules |
| Stable supply, custody, bridge flows, and reserve yield                    | Indexer handlers and schema                 | Dashboard and revenue views                  |
| v2 relayers, reserves, trading modes, limits, and service health           | `aegis/config.yaml` and Aegis source        | Grafana rules                                |
| Multisig, governance, Sentry, and rotation events                          | `alerts/infra/` and `governance-watchdog/`  | Slack, Discord, Telegram, GitHub             |
| Aggregator and cross-chain route availability                              | Integration-probe adapters                  | Upstash snapshot and dashboard               |

Mutable thresholds are executable policy, not prose: shared TypeScript
thresholds live under `shared-config/`, indexed health logic lives under
`indexer-envio/src/`, and notification expressions live under
`alerts/rules/`. Current-state health, historical uptime accrual, and paging
answer different questions; changing one requires auditing the sibling
indexer, dashboard, bridge, and rule surfaces.

Dashboard routes and access control are defined by `ui-dashboard/src/app/`,
`ui-dashboard/src/auth.ts`, and `ui-dashboard/src/middleware.ts`. The dashboard
package instructions own browser, authentication, polling, and degraded-schema
verification. This specification does not mirror its route or component tree.

## Alerting

The two alert planes are intentionally separate:

- **Metric thresholds:** Aegis and metrics-bridge produce Prometheus metrics;
  Alloy remote-writes them; `alerts/rules/rules-*.tf` defines the current
  expressions; and the same Terraform root owns contact points, routing,
  templates, and mute timings.
- **Event and incident delivery:** `alerts/infra/` owns QuickNode-to-Slack
  delivery, the Sentry bridge, and the on-call rotation announcer. Scheduled
  Sentry workflows own issue projection and autofix PRs.
  `governance-watchdog/` independently owns governance delivery to
  Discord/Telegram.

Use [`alerts/AGENTS.md`](./alerts/AGENTS.md) for the stack boundary and
verification contract. Use the rule files themselves for exact severities,
holds, thresholds, labels, and channels. Polygon-specific coverage and rollout
ordering remain in
[`docs/notes/polygon-monitoring.md`](./docs/notes/polygon-monitoring.md).

## Authority and change routing

| Question                                                              | Current authority                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| What packages exist and how do I start locally?                       | [`README.md`](./README.md)                                                                                                                    |
| Why is the architecture shaped this way?                              | [`docs/adr/README.md`](./docs/adr/README.md)                                                                                                  |
| What does the indexer ingest and expose?                              | [`indexer-envio/README.md`](./indexer-envio/README.md), its configs, loaded handlers, and schema                                              |
| What is deployed or ready to promote?                                 | [`indexer-envio/STATUS.md`](./indexer-envio/STATUS.md) and [`docs/deployment.md`](./docs/deployment.md), verified against the live deployment |
| Which networks, symbols, thresholds, namespaces, and ABIs are shared? | [`shared-config/AGENTS.md`](./shared-config/AGENTS.md) and package source                                                                     |
| Which dashboard routes and behaviors exist?                           | [`ui-dashboard/AGENTS.md`](./ui-dashboard/AGENTS.md) and `ui-dashboard/src/`                                                                  |
| Which alerts fire and where do they route?                            | [`alerts/AGENTS.md`](./alerts/AGENTS.md), `alerts/rules/`, and `aegis/config.yaml`                                                            |
| What is planned rather than shipped?                                  | GitHub Issues are the active-work authority; historical plans and notes are non-canonical input that must be verified                         |
| Which commands and CI checks are current?                             | [`docs/notes/quick-commands.md`](./docs/notes/quick-commands.md) and the package manifests/workflows                                          |

When an implementation change alters one of these boundaries, update the
narrowest owning source and then audit every canonical entry point that teaches
the old behavior. The placement and drift rules are in
[`docs/context-standards.md`](./docs/context-standards.md).

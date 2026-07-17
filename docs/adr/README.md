---
title: Architecture Decision Records
status: active
owner: eng
canonical: false
---

# Architecture Decision Records

This is the decision log for the monitoring monorepo: the **why** behind the
architecture, so a new human or agent can understand how the system got its
shape without archaeology through 1000+ merged PRs.

Each ADR records one decision that (a) constrains how future work must be done,
(b) had a real alternative, and (c) whose rationale is not obvious from reading
the code at the call site. Bug fixes, dependency bumps, one-off features, and
no-direction refactors are deliberately **not** here — they are noise at this
altitude.

## How to read this

- **Onboarding?** Skim the `repo-wide` and `ci / process` groups first (ADRs
  0001–0010) — that is the system in ten decisions. Then read the group for
  whatever package you are about to touch.
- **About to change something?** Find the ADR that governs it. If your change
  contradicts an accepted ADR, that is a design conversation, not a drive-by edit.
- An ADR tells you _why_. It is **not** a substitute for verifying current
  behavior in code, config, or a live endpoint before you act — see
  [`docs/context-standards.md`](../context-standards.md).

## Lifecycle

Frontmatter `status` follows the repo metadata contract (`active` = in force;
`archived` = superseded/deprecated). The ADR's own lifecycle (Accepted /
Superseded by ADR-NNNN) lives in the body's **Status** line. In-force ADRs are
`canonical: true` and enrolled in the 90-day re-verification check — that is the
enforcement behind "is this still true?". Supersede an ADR by adding a new one
and flipping the old one to `status: archived` with a `superseded_by:` pointer;
do not silently rewrite history.

## Adding an ADR

Making an architectural decision in a PR? Record it here, in the same PR. The
"does this need an ADR / how do I write one" procedure lives in
[`docs/pr-checklists/architecture-decisions.md`](../pr-checklists/architecture-decisions.md);
`pnpm adr:check` reminds you when a change adds a package, Terraform stack, or
workflow without an ADR (see [ADR 0033](0033-adr-process-and-gate.md)).

## Index

### repo-wide

| ADR                                          | Decision                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| [0001](0001-monorepo-independent-deploys.md) | One pnpm+Turbo monorepo; each service deploys independently                         |
| [0002](0002-envio-hosted-indexer.md)         | Envio HyperIndex **Hosted** is the indexer; deploy via a dedicated `envio` branch   |
| [0003](0003-hasura-graphql-read-api.md)      | Hasura auto-GraphQL over Postgres is the read API                                   |
| [0004](0004-two-alert-planes.md)             | Two alert planes: Grafana metric thresholds + event-driven QuickNode→Cloud Function |
| [0005](0005-context-as-product.md)           | Context is product: canonical/non-canonical authority model + metadata contract     |

### ci / process

| ADR                                                     | Decision                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [0006](0006-github-issues-backlog.md)                   | GitHub Issues (not `BACKLOG.md`) are the canonical agent work queue             |
| [0007](0007-agent-quality-gate-and-merge-oracle.md)     | Local agent quality gate + `pr:ready-state` merge oracle + Codex approval gate  |
| [0008](0008-mandatory-hazard-checklists.md)             | Cross-layer/stateful changes must run the dedicated PR checklists before review |
| [0009](0009-supply-chain-hardening.md)                  | Supply-chain posture: release-age gate, lockfile-lint, SHA-pinned Actions       |
| [0010](0010-required-checks-no-paths-filters.md)        | Required CI checks carry no `paths:` filters; only advisory jobs may            |
| [0033](0033-adr-process-and-gate.md)                    | ADRs record architectural decisions, enforced by a reminder gate                |
| [0036](0036-sentry-triage-pipeline.md)                  | Sentry triage/autofix: staged GitHub Actions agent pipeline + GH-Issue queue    |
| [0038](0038-sentry-central-plane-verdict-projection.md) | Central Sentry triage plane; actionable verdicts projected into owning repos    |

### shared-config

| ADR                                                  | Decision                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| [0011](0011-shared-config-single-source-of-truth.md) | `shared-config` is the single source of truth for chain/token metadata |
| [0035](0035-config-public-npm-package.md)            | `shared-config` publishes as public `@mento-protocol/config`           |

### indexer-envio

| ADR                                                      | Decision                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [0012](0012-one-multichain-indexer.md)                   | One multichain indexer project; Ethereum reserve-yield shares the hosted deployment |
| [0013](0013-vendored-shared-config-mirror.md)            | The indexer vendors a mirror of `shared-config` (it builds outside the workspace)   |
| [0014](0014-snapshot-entities-no-aggregate.md)           | Precompute snapshot/rollup entities; never rely on Hasura `_aggregate`              |
| [0015](0015-abi-vendoring-and-address-drift-gate.md)     | Vendor ABIs from the contracts package; gate every config address on a drift check  |
| [0016](0016-effect-rpc-split-and-heal-stages.md)         | Split effects/RPC from handlers; decompose `upsertPool` into pure heal-stages       |
| [0017](0017-broker-denormalization-volume-dedup.md)      | Denormalize the v2 Broker swap path to de-duplicate router-routed volume            |
| [0018](0018-indexer-observability-loki.md)               | Indexer observability is structured logs → Loki → Grafana, not Sentry               |
| [0034](0034-steth-wallet-daily-sampler.md)               | stETH actuals use a launch-aligned sub-daily wallet balance sampler                 |
| [0038](0038-multistrategy-pools-historical-fx-volume.md) | Pool strategies are many-to-many; same-currency swaps use historical FX crosses     |

### ui-dashboard

| ADR                                                      | Decision                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [0019](0019-vercel-path-aware-deploys.md)                | Dashboard deploys on Vercel Git integration with a path-aware skip script         |
| [0020](0020-swr-polling-read-model.md)                   | Read model is SWR polling + client-side aggregation at current pool scale         |
| [0021](0021-dashboard-state-upstash-blob.md)             | Dashboard state lives in Upstash Redis with Vercel Blob backups, not a DB         |
| [0022](0022-authjs-google-shared-preview-secrets.md)     | Auth.js + Google; preview shares prod auth secrets behind Deployment Protection   |
| [0023](0023-es2017-no-polyfill.md)                       | Ship ES2017 with no polyfill; ban immutable-array methods via lint + `sortedCopy` |
| [0024](0024-plotly-basic-dist-bundle-budgets.md)         | Plotly.js `basic-dist` + enforced bundle-size budgets                             |
| [0025](0025-fixture-browser-tests-react-doctor.md)       | Fixture-driven browser tests + visual snapshots + a react-doctor score gate       |
| [0037](0037-dashboard-graphql-zod-mini.md)               | Native GraphQL transport + Zod Mini for browser-reachable validation              |
| [0038](0038-multistrategy-pools-historical-fx-volume.md) | Pool detail renders every active strategy from the indexed many-to-many registry  |

### aegis

| ADR                                     | Decision                                                                |
| --------------------------------------- | ----------------------------------------------------------------------- |
| [0026](0026-aegis-nestjs-app-engine.md) | Aegis is a NestJS App Engine service polling view calls into Prometheus |

### metrics-bridge

| ADR                                                      | Decision                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [0027](0027-metrics-bridge-hasura-to-prometheus.md)      | A Hasura→Prometheus bridge exists so v3 DB data can drive Grafana alerts     |
| [0038](0038-multistrategy-pools-historical-fx-volume.md) | Pool blockage requires every active indexed strategy to be confirmed blocked |

### terraform / infra

| ADR                                            | Decision                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| [0028](0028-terraform-stack-registry.md)       | Terraform ownership is a registry (`terraform.stacks.json`) with roots split by cadence |
| [0029](0029-ci-apply-production-infra-gate.md) | Infra applies on merge to `main` behind the `production-infra` environment gate         |
| [0030](0030-iac-before-cli-secrets.md)         | All secrets are managed by IaC; agents never touch them with CLI commands               |

### governance-watchdog

| ADR                                                 | Decision                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| [0031](0031-governance-watchdog-standalone-root.md) | governance-watchdog stays a standalone source root in its own GCP project |

### integration-probes

| ADR                                           | Decision                                                            |
| --------------------------------------------- | ------------------------------------------------------------------- |
| [0032](0032-integration-probes-quote-only.md) | Integration probes are quote-only, evidence-gated, and TTL-degraded |

## Not yet recorded / needs verification

These are candidate decisions left out of the first pass — record them if they
prove load-bearing, or delete this note when it goes stale:

- **CDP / Liquity-v2 fork monitoring model** (silent `BoldDebtUpdated`,
  rebalance/redemption conflation) — currently captured in indexer notes and
  memory; may deserve its own ADR once the v2-fork monitoring surface stabilizes.
- **Aegis single-fallback RPC posture** (no breaker, no backoff) — documented in
  [`aegis/AGENTS.md`](../../aegis/AGENTS.md); left as package rule, not an ADR.
- **Weekend FX-calendar KPI conventions** (7d/WoW over 24h) — a product/data
  convention in `shared-config` `fx-calendar.json`; borderline for ADR status.

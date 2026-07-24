---
title: The peg-monitor registry is service-local config, not published shared-config
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: metrics-bridge / shared-config
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0043 — The peg-monitor registry is service-local config, not published shared-config

**Status:** Accepted (Jul 2026), in force. The registry and integrity gate
landed in PR #1497; protected policy publication and alert activation remain
separate rollout phases in
[`docs/PLAN-peg-monitoring.md`](../PLAN-peg-monitoring.md).
**Scope:** metrics-bridge / shared-config

## Context

Peg monitoring for oracle-less stablecoins uses two coordinated per-asset
artifacts. The service-local registry defines venue identity and topology:
sources, pair mappings, source roles, conversion legs, pool monitors, and
coverage class. The gated policy defines page-affecting reference sizes,
cadence, freshness and spread gates, and deep-venue authority. The obvious
home for the registry appears to be `shared-config`, the repo's source of truth
for chain/token metadata
([ADR 0011](0011-shared-config-single-source-of-truth.md)).

But `shared-config` publishes as the public npm package
`@mento-protocol/config` ([ADR 0035](0035-config-public-npm-package.md)):
every export is public API surface, releases are tag-driven, and the
package's charter is _protocol_ metadata consumed by four packages. The peg
registry is single-consumer operational monitoring topology. Publishing it
would make every venue-topology tweak a public API release event and duplicate
rate-feed and token identity already canonical in
`shared-config/oracle-reporters.json`, creating a second source of truth with
no drift check.

The repo already has a home for this category: Aegis treats its
`config.yaml` as production monitoring policy, service-local and
unpublished.

## Decision

- The registry lives with the consuming service
  (`metrics-bridge/peg-registry.json` + a schema module and fixture tests),
  repo-internal and never published to npm.
- It **references** identity, never duplicates it: rate-feed identity and pair
  by feed address (canonical in `oracle-reporters.json`), tokens by chain +
  address (canonical in shared-config tokens). A referential-
  integrity check script — sibling to the existing threshold-drift check,
  wired into the quality gate and CI — fails the build when a referenced
  feed or token does not exist upstream. Pool references cannot be proven
  statically (pools are discovered on-chain), so the activated bridge resolves
  every `(chain, pool)` against Hasura at startup and re-validates continuously
  with each structural poll. It fails that asset's `indexed-pool` coverage path
  closed and publishes `mento_peg_indexed_pool_reachable` whenever resolution
  stops (retired pool, resync, partial backend failure), not only when it never
  resolved. A distinct ops alert on that metric is required before the peg
  signal becomes alert-authoritative.
- Schema decisions that the first adversarial review forced:
  - Asset keys are internal slugs (`europ-schuman`), never tickers; the
    onboarding census binds by contract address / issuer identity (ticker
    collisions are real — "EURP" vs "EUROP").
  - `tokenRefs` is restricted to identity forms the repository can
    validate upstream today: EVM chainId + address against shared-config.
    Non-EVM forms (XRPL issuer+currency) require a canonical registry in
    shared-config first; until one exists they are rejected rather than
    accepted unvalidated.
  - `monitors[]` holds one entry per (chain, pool, rate feed) —
    asset-level vs pool-level identity is explicit. Breaker thresholds are
    not stored: they are governance-mutable on-chain state already
    indexed, read live through the indexer's effective-threshold
    resolution — per-feed `BreakerConfig.rateChangeThreshold` where set,
    falling back to `Breaker.defaultRateChangeThreshold` when the per-feed
    field is the inherit sentinel `0` — so the registry cannot carry stale
    breaker policy and the decision package never shows a zero band.
  - Alert-affecting parameters (reference sizes, staleness gates,
    spread-envelope parameters, deep-venue designation) do NOT live here:
    they belong to the gated thresholds JSON
    ([ADR 0044](0044-peg-thresholds-gated-rules-plane.md)), so a bridge
    deploy cannot change page behavior through registry data.
  - Source ids are stable internal names (`bitvavo_eur`) decoupled from
    venue pair spellings, so a venue renaming a pair is a config edit, not
    Grafana label churn that orphans alert history.
  - `peg` carries the currency only. The peg TARGET and any crawling-peg
    schedule are page-affecting policy — they change the deviation
    calculation directly — and live in the gated policy artifact
    ([ADR 0044](0044-peg-thresholds-gated-rules-plane.md)) with the other
    alert-affecting parameters, so a bridge deploy cannot move the peg.
  - Each asset declares a `coverageClass` recording which alert paths its
    source mix can actually reach (see
    [ADR 0045](0045-peg-paging-semantics.md)).

## Alternatives considered

- **shared-config module** — rejected: charter violation, public
  npm exposure of monitoring policy, per-tweak release ceremony, duplicate
  source of truth for feeds.
- **Terraform variables in the alerts stack** — rejected: the poller needs
  the same data at runtime; HCL is the wrong plane for a service config and
  would couple bridge deploys to protected applies.
- **Hardcode per-asset logic in the bridge** — rejected: the entire point is
  that onboarding a new oracle-less asset with already-supported venues is
  one reviewed data change.

## Consequences

- Onboarding an asset = one registry diff (plus a gated thresholds diff,
  [ADR 0044](0044-peg-thresholds-gated-rules-plane.md)); no npm release, no
  public disclosure beyond the repo itself.
- The registry cannot drift from protocol identity silently — the
  referential-integrity check is a merge gate.
- Consumers other than metrics-bridge (dashboard panels, runbooks) read
  registry-derived data through the bridge's metrics, not by importing the
  file; if a second runtime consumer ever appears, revisit placement.

## Evidence

- `docs/PLAN-peg-monitoring.md` (schema sketch and review findings)
- `metrics-bridge/peg-registry.json` and
  `metrics-bridge/src/peg/registry.ts` (implemented topology and schema)
- `metrics-bridge/test/peg-registry.test.ts`
- `scripts/check-peg-registry-integrity.mjs`
- `metrics-bridge/Dockerfile` (service-local registry in the runtime image;
  gated policy excluded)
- `aegis/config.yaml` (service-local monitoring-policy precedent)
- `shared-config/oracle-reporters.json` (canonical feed identity referenced,
  not duplicated)
- ADRs 0011, 0035, 0044, 0045

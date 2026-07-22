---
title: The peg-monitor registry is service-local config, not published shared-config
status: active
owner: eng
canonical: true
last_verified: 2026-07-22
scope: metrics-bridge / shared-config
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0043 — The peg-monitor registry is service-local config, not published shared-config

**Status:** Accepted (Jul 2026), in force. Decided ahead of implementation;
the registry schema lands with the poller per
[`docs/PLAN-peg-monitoring.md`](../PLAN-peg-monitoring.md).
**Scope:** metrics-bridge / shared-config

## Context

Peg monitoring for oracle-less stablecoins is driven by a per-asset registry:
which venues to poll, pair mappings, reference sizes, source roles, gates,
conversion legs, and coverage class. The obvious home appears to be
`shared-config`, the repo's source of truth for chain/token metadata
([ADR 0011](0011-shared-config-single-source-of-truth.md)).

But `shared-config` publishes as the public npm package
`@mento-protocol/config` ([ADR 0035](0035-config-public-npm-package.md)):
every export is public API surface, releases are tag-driven, and the
package's charter is _protocol_ metadata consumed by four packages. The peg
registry is single-consumer _operational monitoring policy_ — venue
topology, cadences, and staleness tolerances. Publishing it would (a) make
every venue tweak a public API release event, (b) disclose monitoring
parameters that are pointless to advertise, and (c) duplicate rate-feed and
token identity already canonical in `shared-config/oracle-reporters.json`,
creating a second source of truth with no drift check.

The repo already has a home for this category: Aegis treats its
`config.yaml` as production monitoring policy, service-local and
unpublished.

## Decision

- The registry lives with the consuming service
  (`metrics-bridge/peg-registry.json` + a schema module and fixture tests),
  repo-internal and never published to npm.
- It **references** identity, never duplicates it: rate feeds and breaker
  metadata by feed address (canonical in `oracle-reporters.json`), tokens by
  chain + address (canonical in shared-config tokens). A referential-
  integrity check script — sibling to the existing threshold-drift check,
  wired into the quality gate and CI — fails the build when a referenced
  feed or token does not exist upstream. Pool references cannot be proven
  statically (pools are discovered on-chain), so the bridge resolves every
  `(chain, pool)` against Hasura at startup AND re-validates continuously
  with each structural poll, failing that asset's `indexed-pool` coverage
  path closed — with a distinct ops alert — whenever resolution stops
  (retired pool, resync, partial backend failure), not only when it never
  resolved.
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
- `aegis/config.yaml` (service-local monitoring-policy precedent)
- `shared-config/oracle-reporters.json` (canonical feed identity referenced,
  not duplicated)
- ADRs 0011, 0035, 0044, 0045

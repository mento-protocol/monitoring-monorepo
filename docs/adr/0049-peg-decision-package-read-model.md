---
title: Peg decisions use a bounded Metrics Bridge read model
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
scope: metrics-bridge / ui-dashboard
date: 2026-07
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0049 — Peg decisions use a bounded Metrics Bridge read model

**Status:** Accepted (Jul 2026). **Scope:** metrics-bridge / ui-dashboard.

## Context

A peg page requires current executable-price, structural, breaker, registry,
and approved-policy evidence. Prometheus intentionally omits topology and
policy context, while a dashboard re-poll would create a second observation
with different timing and semantics.

## Decision

Metrics Bridge owns a versioned, bounded in-memory read model at read-only
`GET /peg/decision-packages`. It commits one pre-serialized body from a
complete selected-policy snapshot after the metrics publication succeeds.
During policy rollover, a complete active or retained-previous snapshot may
replace the body even when a failed sibling forces the current-state gauge
batch empty. The selected complete policy's monotonic poll-success and
usable-decision deltas still publish before its source state commits, so a
cached or replayed observation cannot lose or repeat an accepted event. After
that successful publication, the bridge atomically merges and prunes only the
selected policy version's staged source state; failed and unselected policy
versions remain unchanged. A fully successful cycle still atomically commits
and prunes the whole source-state map. Readers receive the body atomically;
before the first body the endpoint returns `503`, and a cycle with no complete
selected policy preserves the original body and immutable `producedAt` so
clients can show stale last-confirmed evidence.

One response selects exactly one compatible policy version. It prefers a
complete active asset set and may fall back only to the explicitly retained
previous version. `approvedActivePolicyVersion`, `producedPolicyVersion`, and
`policySlot` expose the selection; the package never combines active and
previous measurements. `previous=null` is the ordinary active-only case.

The response is limited by the existing policy and registry asset/source/
monitor limits and a 512 KiB serialized-body limit. It contains registry and
policy identity, current source evidence, real per-monitor structural and
breaker evidence, and aggregate structural evidence. Missing source or monitor
evidence remains in its configured topology as explicit unavailable/null DTO
fields. The live `structural.blindConsecutivePolls` counter is distinct from
the policy threshold. Breaker integer values stay decimal strings and an
absent breaker is distinct from a configured disabled breaker.

The endpoint is current-state evidence, not alert history. Grafana remains
authoritative for duration, coverage, pending/firing state, and notifications.
The dashboard uses `producedAt`, clock skew, and fetch errors to classify
current versus stale-last-confirmed data.

This decision does not implement registry listing re-census or registry-rot
rules. Until a typed listing cache is added, each source emits
`listingState:null` and `listingCheckedAt:null`.

## Alternatives considered

- **Parse Prometheus in the dashboard** — it is an observability contract and
  lacks the bounded topology and policy evidence.
- **Query Grafana or providers from the dashboard** — this adds credentials or
  a second observation path with different timing and failure semantics.
- **Persist unbounded history in the bridge** — current incident evidence does
  not justify a second datastore or a history-retention contract.

## Consequences

- The peg lifecycle and endpoint remain isolated from `/health` and the
  primary Hasura bridge.
- The dashboard gets one validated current-state input but must not recreate
  Grafana alert evaluation.
- Listing re-census, alert rules, UI routes, infrastructure, and deployment
  stay separate follow-up work.

## Evidence

- `metrics-bridge/src/peg/poll-cycle.ts`
- `metrics-bridge/src/peg/decision-packages.ts`
- `metrics-bridge/src/peg/breaker-evidence.ts`
- ADRs 0042–0045

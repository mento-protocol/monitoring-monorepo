---
title: Repeated Peg provider observations retain bounded health, never sample authority
status: active
owner: eng
canonical: true
last_verified: 2026-08-13
scope: metrics-bridge / alerts
date: 2026-08
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0057 — Repeated Peg provider observations retain bounded health, never sample authority

**Status:** Accepted (Aug 2026), in force. This record narrows the
observation-advancement clause in [ADR 0044](0044-peg-thresholds-gated-rules-plane.md).
The predecessor cleanup named in the consequences later completed; the current
active-only proof is recorded in
[`docs/notes/peg-monitoring.md`](../notes/peg-monitoring.md).
**Scope:** metrics-bridge / alerts

## Context

Peg rules use the provider-side timestamp as evidence that a market observation
is current. A reachable provider can repeat its most recent observation across
several fetches. Treating each successful fetch as a new observation can make a
frozen at-par book satisfy coverage and erase a sustained deviation. Treating
every repeat as immediately unhealthy creates avoidable source-health noise
while the provider timestamp remains within the policy's approved freshness
window.

The distinction constrains both the bridge producer and the Grafana consumers:
source health may describe whether a recent provider observation still exists;
sample and decision metrics describe whether new decision evidence arrived.

## Decision

- A provider observation with the same timestamp and identity as the currently
  retained executable observation may retain source health only while that
  timestamp is within the source policy's `staleAfterSeconds`. A listing halt
  or absence ends this exception.
- A repeated observation never advances `mento_peg_observation_at`, counts as
  a new sample, or creates a usable decision. It cannot replenish the
  decision-history evidence used by sustain and coverage predicates.
- A stale or regressing timestamp, a previously seen identity replayed after a
  different same-timestamp identity, an exceeded identity bound, or an
  observation that does not match the configured exact pair fails closed. It
  cannot retain source health, advance a sample, or create a usable decision.
- This narrows ADR 0044 only. Policy ownership, content-addressed versions,
  two-phase predecessor retention, and the gated publication/apply sequence
  remain unchanged.

## Alternatives considered

- **Advance on every successful fetch** — rejected: endpoint availability is
  not new market evidence and can certify a frozen book.
- **Mark every repeat unhealthy immediately** — rejected: a still-fresh
  provider timestamp can honestly retain bounded source health; immediate
  failure adds noise without improving decision safety.
- **Accept stale or regressing timestamps as repeats** — rejected: this hides
  provider rollback or loss of freshness and can keep an invalid source healthy.

## Consequences

- Provider adapters and the poll cycle must retain timestamp and identity state
  separately from fetch success.
- Tests must cover repeat-within-window health, repeat-without-new-decision,
  and fail-closed stale, regressing, and identity-invalid inputs.
- Operators must wait for the human-approved Grafana cleanup, protected policy
  publication, runtime-generation attachment, and production checks before
  claiming the predecessor cleanup is live.

## Evidence

- Issue #1747
- `metrics-bridge/src/peg/poller.ts` and `metrics-bridge/src/peg/poll-cycle.ts`
  (provider-observation and decision-production path)
- `metrics-bridge/test/peg-poller.test.ts` (repeat and freshness regression
  coverage)
- `alerts/rules/peg-thresholds.json` and
  `alerts/rules/peg-promql-active.tf` (gated stale window and exact-version
  consumer contract)
- ADRs 0042, 0044, 0045

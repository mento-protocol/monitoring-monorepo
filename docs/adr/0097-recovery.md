---
title: Pool recovery
status: active
owner: eng
canonical: true
last_verified: 2026-09-14
scope: alerts
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0097 — Pool page recovery persistence

**Status:** Accepted (Sep 2026), in force. Supersedes
[ADR 0067](0067-depletion-alerts.md).
**Scope:** alerts

## Context

ADR 0067 rejected recovery holds on adjacent depletion bands because a long
hold could let both tiers reach Alerting. Later, an already-firing
`Pool Nearly One-Sided` page resolved on one mapped-Normal evaluation while the
pool remained one-sided.

For Celo USDC/USDm alert `5163504623dfc161`, Grafana fired at 23:27 UTC on
2026-09-11 and resolved one minute later while showing 100% USDm / 0% USDC.
Indexed reserves stayed one-sided until the 23:33:48 UTC rebalance. PR #2381 had
removed the sparse query behind this NoData path, but its production apply was
still waiting.

Grafana has two relevant resolution paths. A NoData result mapped to OK enters
the ordinary Recovering state, where `keep_firing_for` applies and a renewed
breach returns directly to Alerting. A labelled series that disappears entirely
is resolved by the separate missing-series counter and bypasses that hold.
Execution errors remain on the existing Error policy; they do not enter Normal
or emit the false resolved message addressed here.

## Decision

Retain ADR 0067's value-weighted depletion thresholds, severity bands, routing,
and the rule that only one depletion tier may reach Alerting for a pool. Change
only the page tier's recovery behavior:

- `Pool Nearly One-Sided` keeps `for = 1m` and adds
  `keep_firing_for = 2m`. A threshold recovery or NoData→OK evaluation must stay
  non-breaching for two minutes before Grafana resolves it.
- Pin `missing_series_evals_to_resolve = 2` on the same rule because true
  MissingSeries resolution bypasses `keep_firing_for`.
- Keep `Pool Depletion Risk` without a recovery hold and emit a non-breaching
  value in the page band, resetting critical on its first page-band evaluation.
- Keep the page hold shorter than the critical tier's 15-minute pending period.
  On an upward crossing, the page resolves before the critical tier can fire;
  the adjacent bands still cannot produce two Alerting notifications.
- Omit query-backed reserve/value rows from resolved page notifications because
  Grafana can carry alerting values forward on non-threshold paths. Use neutral
  copy plus a neutral Slack icon for any non-empty `grafana_state_reason`,
  including MissingSeries, NoData, Error, Updated, Paused, and RuleDeleted. Only
  an ordinary threshold resolution may claim that the pool is two-sided again.

## Alternatives considered

- **Rely only on PR #2381's sparse-query removal** — rejected. It closes the
  observed trigger but leaves a single false Normal evaluation able to produce
  a resolved/re-fired pair.
- **Use only `keep_firing_for`** — rejected. Grafana's MissingSeries eviction
  path bypasses Recovering, so the hold does not cover a vanished labelled
  series.
- **Put the same hold on both depletion tiers** — rejected. Holding the critical
  tier across a downward crossing permits the page tier to fire beside it.
- **Use a long page hold such as one hour** — rejected. It would overlap the
  critical tier's 15-minute pending period on an upward crossing. Two minutes
  covers an isolated 60-second evaluation without weakening tier exclusivity.

## Consequences

- One healthy or NoData→OK evaluation no longer closes an open one-sided page.
- One missing-series evaluation no longer closes it; two consecutive missing
  evaluations do, with copy that does not claim recovery.
- Genuine recovery is delayed two minutes. An upward page→critical crossing has
  at least 13 minutes between page resolution and critical firing; a downward
  crossing retains no critical-tier hold.
- Resolved Slack and Splunk messages omit reserve and value-share rows, avoiding
  stale alerting values beside recovery copy.
- This is Grafana configuration only. It has no production effect until the
  gated `alerts/rules` Terraform apply completes and the live rule is verified.

## Evidence

- PR [#2381](https://github.com/mento-protocol/monitoring-monorepo/pull/2381)
  — removed sparse annotation-only queries from the depletion rules.
- [Grafana alert rule evaluation](https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rule-evaluation/)
  — documents Recovering and direct return to Alerting when the condition is
  met again during `keep_firing_for`.
- Grafana state manager
  [`state.go`](https://github.com/grafana/grafana/blob/5bb9a2f33010a5c51db2ec40d1fd8890b87d3194/pkg/services/ngalert/state/state.go#L344-L386)
  — maps NoData→OK through the ordinary recovery hold.
- Grafana state manager
  [`manager.go`](https://github.com/grafana/grafana/blob/5bb9a2f33010a5c51db2ec40d1fd8890b87d3194/pkg/services/ngalert/state/manager.go#L570-L628)
  — resolves MissingSeries through its separate evaluation counter.
- Enforced by `alerts/rules/rules-fpmms.tf`, `contact-points.tf`, and their
  alert behavior tests.

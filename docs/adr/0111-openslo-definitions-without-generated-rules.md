---
title: SLOs are OpenSLO definitions with no generated alert rules
status: active
owner: eng
canonical: true
last_verified: 2026-10-30
scope: alerts
date: 2026-10
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0111 — SLOs are OpenSLO definitions with no generated alert rules

## Status

Accepted.

## Context

The repo had alert rules and no service level objectives. Half of the planned
SLIs do not live in Prometheus: Gateway liveness comes from healthchecks.io,
automation success from the Gateway's run log, and alert precision and change
failure rate from Hardin's incident ledgers. Three more have no data source yet.
Prometheus history here is 32 days per query at most, and the estate is small
enough that a burn-rate page adds a second alert for conditions the existing
rules already page on.

## Decision

Keep SLOs as OpenSLO v1 documents in `alerts/slo/slos.yaml`. Hardin evaluates
them daily from `main` and reports burn as a ticket-level message. No Terraform
stack reads the file and no Grafana rule is generated from it.

SLOs whose data source does not exist stay in the file with
`mento.org/sli-status: pending`, so the gap stays visible. Guessed targets carry
`mento.org/provisional: "true"` until a quarterly review confirms them.

## Alternatives

- **Generate Grafana recording and alert rules from the definitions.** Rejected:
  it covers only the Prometheus SLIs and doubles the paging surface while targets
  are still guesses.
- **Grafana SLO.** Rejected for the same reason, and it would move definitions
  out of review in this repo.
- **Keep targets only in Hardin's workspace.** Rejected: the targets are team
  decisions about these services and belong beside the alert rules, in review.

## Consequences

- Changing a target is a reviewed PR and takes effect on Hardin's next daily run.
- An SLO breach never pages. Fast outages stay the job of the existing rules.
- A burn signal depends on Hardin running. A stopped daily check loses that
  signal, and the monthly review reports no result instead of zeros.

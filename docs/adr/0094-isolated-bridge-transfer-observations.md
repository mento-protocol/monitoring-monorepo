---
title: Bridge transfers use isolated complete observations
status: active
owner: eng
canonical: true
last_verified: 2026-09-10
scope: metrics-bridge
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0094 — Bridge transfers use isolated complete observations

**Status:** Accepted. Extends [ADR 0027](0027-metrics-bridge-hasura-to-prometheus.md).

## Context

Bridge alerts need every relevant non-terminal transfer. Dashboard windows are
capped. Reusing a capped window can report a healthy queue while an older
transfer is stuck. A failed page must not clear an active incident. The existing
pool and peg observations must continue when this domain fails.

## Decision

Use an independent sequential polling loop in Metrics Bridge. Read Hasura with
ID keyset pagination. Bound each observation to 20 pages, 500 rows per page,
10,000 rows and 15 seconds. A full last page does not prove completeness;
exhausting any budget fails the observation. Deduplicate IDs within one traversal.

Publish all route gauges synchronously only after a complete observation.
Successful empty observations write zero to every finite bucket. Failure retains
the previous snapshot and last-success time. Startup has no route samples and
last-success zero. The separate observation-error signal starts at one.

Wait 30 seconds after each attempt. Export a 45-second freshness limit from the
30-second cadence plus 15-second timeout. Consumers must require error zero,
last-success greater than zero, and observation age at most this limit. Pool
health and peg freshness cannot establish bridge-transfer freshness.

Share status thresholds and timestamp precedence through
`@mento-protocol/config/bridge-status`. Labels use only chain IDs 137, 143 and
42220, canonical USDm/EURm token identities, canonical non-terminal statuses,
and `unknown`. Include partially known routes because destination-first rows
can precede source evidence. Unknown labels and missing/future ages increment a
separate invalid-row signal. Negative epochs retain the shared contract's
existing age semantics. No address, hash, transfer ID or raw symbol is a label.

## Alternatives considered

- Reuse the dashboard transfer window: incomplete coverage cannot support alerts.
- Add bridge pages to the primary pool loop: timeout and retry delays would couple
  unrelated domain freshness.
- Clear gauges when a request fails: missing evidence would resolve real incidents.
- Add a transactional server aggregate: stronger consistency, but it requires a
  new indexed data contract and rollout. This change uses existing schema fields.

## Consequences

Pagination is a bounded traversal, not a database transaction. Concurrent inserts
behind the cursor can appear on the next poll. A row that progresses after it was
read can remain in that observation. Stable ID order avoids offset skips, and
repeated IDs count once. This does not prove a simultaneous database snapshot.
The two-minute alert pending period limits transient notifications; it cannot
make an incomplete observation authoritative.

There are 180 route/token/status buckets and three gauges per bucket, plus four
domain gauges: at most 544 series. No route samples exist before first success.
Unknown-route alerts must use broader dashboard filters instead of fabricated
chain IDs. Exporter rollout and alert activation remain separate approved steps.

## Evidence

- Tracker #1362 and exporter layer #2356; parent shared contract PR #2358.
- `metrics-bridge/src/bridge/observation.ts`: traversal and timeout budgets.
- `metrics-bridge/src/bridge/metrics.ts`: finite snapshots and failure signals.
- `metrics-bridge/src/bridge/runtime.ts`: isolated cadence.
- `metrics-bridge/src/bridge/bridge.test.ts`: pagination and state transitions.

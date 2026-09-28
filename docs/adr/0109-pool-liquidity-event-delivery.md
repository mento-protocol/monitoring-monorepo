---
title: Pool liquidity watches use event-keyed durable alert delivery
status: active
owner: eng
canonical: true
last_verified: 2026-09-27
scope: alerts/infra
date: 2026-09
doc_type: adr
review_interval_days: 90
garden_lane: adrs-architecture
---

# ADR 0109 — Pool liquidity watches use event-keyed durable alert delivery

**Status:** Accepted (Sep 2026), in force.
**Scope:** Polygon pool LP-withdrawal alerts.

## Context

The first implementation exposed each burn's transaction, owner, and amounts as
Prometheus labels, then asked Grafana to fire once per event. Its six-hour
query window bounded simultaneous series, but not cumulative cardinality. A
late indexer event could be lost. A discrete withdrawal belongs in the
QuickNode → Cloud Function → Slack plane chosen by [ADR 0004](0004-two-alert-planes.md).

## Decision

Extend the existing Polygon QuickNode listener with the configured pool
addresses and their `Burn` topic. A Terraform watch list supplies stable IDs,
pool and LP-wallet addresses, token symbols, and token decimals. The first watch
covers EURm/USDm. The signed webhook only supplies a candidate key (watch ID,
transaction hash, and burn log index). Fetch the Polygon transaction receipt
and require a successful transaction, the exact pool Burn, a matching LP-token
transfer from the watched wallet to the pool, and the matching LP-token burn.
Router and beneficiary fields do not establish LP ownership. A swap in the
same receipt does not suppress a valid withdrawal.

Persist each signed candidate in a dedicated private GCS bucket before RPC
proof. A private Scheduler-invoked function retries unverified and pending
records each minute after QuickNode's signed retry window. Claim an event with
GCS generation preconditions and a lease; mark it delivered only after Slack
acknowledges `chat.postMessage`. Store the watch details in the record so a
later config change cannot erase retry proof. Never reuse a watch ID for a
different pool or wallet. Use a deterministic `client_msg_id` from chain,
watch ID, transaction hash, and log index on every send attempt. A negative receipt proof
marks the event ignored. The delivery route uses the confirmed `#alerts-pools`
channel ID. Grafana's existing pool alerts use the channel name; this direct
`chat.postMessage` route uses its ID. Live bot membership and a test delivery
remain production activation checks.

This is at-least-once **after durable staging**, while GCS, RPC, Scheduler, and
Slack recover within the 365-day state retention. Slack and GCS have no atomic
commit: Slack may accept a post whose acknowledgement or subsequent GCS update
fails, so a retry can post a duplicate. `client_msg_id` is a stable dedupe hint,
not an exactly-once guarantee. Concurrent attempts are bounded by one GCS
lease; ambiguous Slack outcomes and lease expiry still leave a duplicate
window. If GCS stays unavailable until QuickNode stops retrying, no durable
record exists; operators must backfill from Polygon logs. A retry scan cap or
persistent failure emits an error into the on-chain handler's infrastructure
alert route. A separate Scheduler attempt alert covers invocation and timeout
failures that produce no function log.

## Alternatives considered

- Keep the Prometheus/Grafana rule — rejected because per-event labels make
  series and fingerprints unbounded over time.
- Use only QuickNode retries — rejected because its signed request expires in
  five minutes, before an extended RPC or Slack outage can recover.
- Treat Slack's `client_msg_id` as exactly-once delivery — rejected because it
  cannot atomically commit a GCS state transition.

## Consequences

The alert-delivery Terraform stack owns a dedicated pool-liquidity state bucket with
access logging to a separate private, retention-limited bucket, a retry
function restricted to same-project internal ingress, Scheduler identity/job,
and scoped bucket access. The log sink cannot log to itself. The
public handler's existing Safe replay and dead-letter bucket keeps its current
permissions. The obsolete Grafana rule and bridge gauge are removed. Production
activation still requires the protected infrastructure apply and live channel
membership/destination proof; local tests establish only deterministic code
behavior. New withdrawal watches need only Terraform configuration. Deposit
alerts require a separate event-specific receipt proof before using this
delivery pattern; a deposit cannot be inferred from a withdrawal Burn.

## Evidence

PR #2525; `alerts/infra/onchain-event-handler/src/pool-liquidity-withdrawal.ts` and its
receipt fixture; `alerts/infra/onchain-event-handler/main.tf`.

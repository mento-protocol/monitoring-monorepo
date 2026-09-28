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
Consecutive watched-wallet transfers in that receipt may sum to the burned LP
amount. A partial or interleaved watched-wallet contribution keeps the record
pending and pages an operator; it must not become an ignored event.
Router and beneficiary fields do not establish LP ownership. A swap in the
same receipt does not suppress a valid withdrawal. Unrelated LP-token transfers
do not break this proof; a conflicting transfer involving the pool leaves the
candidate pending and raises a retry error for operator inspection. A prior
transaction's LP transfer cannot prove ownership of a later Burn from one
receipt; that case needs separate on-chain investigation or a future stateful
transfer-correlation design.

The public webhook only creates immutable candidate keys in a dedicated GCS
intake bucket. Its runtime identity cannot read, overwrite, or delete them and
has no access to the separate private delivery-state bucket. The private
Scheduler worker reads candidate **names**, never candidate contents or
asserted states, and checks each watch ID against its own configuration before
receipt proof. It alone creates ignored, pending, and delivered records in the
delivery-state bucket. Claim an event with
GCS generation preconditions and a lease; mark it delivered only after Slack
acknowledges `chat.postMessage`. Store the watch details in the record so a
later config change cannot erase proof for an already-pending delivery. A
candidate with a removed watch ID instead pages for operator backfill. Never
reuse a watch ID for a different pool or wallet. Use a deterministic `client_msg_id` from chain,
watch ID, transaction hash, and log index on every send attempt. A negative receipt proof
marks the event ignored. The delivery route uses the confirmed `#alerts-pools`
channel ID. Grafana's existing pool alerts use the channel name; this direct
`chat.postMessage` route uses its ID. Live bot membership and a test delivery
remain production activation checks.

The retry worker scans retained event history in bounded pages and persists a
generation-checked cursor after each page. It wraps at the end, so a long
history or failed early records cannot permanently hide later keys. A scan
that reaches its page or time budget logs an ERROR covered by the infrastructure
alert; a large backlog can delay delivery beyond one Scheduler interval. Old
cursor generations expire after seven days while the live cursor remains.
Malformed object names under the event prefix log one ERROR per scan and are
skipped so one bad upload cannot block later valid records.

This is at-least-once **after durable staging**, while GCS, RPC, Scheduler, and
Slack recover and the retry backlog drains within the 365-day state retention.
A backlog that outgrows the worker's throughput can expire before delivery and
requires operator backfill. Slack and GCS have no atomic
commit: Slack may accept a post whose acknowledgement or subsequent GCS update
fails, so a retry can post a duplicate. `client_msg_id` is a stable dedupe hint,
not an exactly-once guarantee. Concurrent attempts are bounded by one GCS
lease; ambiguous Slack outcomes and lease expiry still leave a duplicate
window. If GCS stays unavailable until QuickNode stops retrying, no durable
record exists; operators must backfill from Polygon logs. A retry scan budget or
persistent failure emits an error into the on-chain handler's infrastructure
alert route. The worker scans to its time or page budget without a fixed
25-event admission cap and advances its cursor past failing records. Sustained
Burn traffic can still exceed finite worker capacity; operators must monitor
scan lag and backfill before retention expires. A separate Scheduler attempt alert covers invocation and timeout
failures that produce no function log.

## Alternatives considered

- Keep the Prometheus/Grafana rule — rejected because per-event labels make
  series and fingerprints unbounded over time.
- Use only QuickNode retries — rejected because its signed request expires in
  five minutes, before an extended RPC or Slack outage can recover.
- Treat Slack's `client_msg_id` as exactly-once delivery — rejected because it
  cannot atomically commit a GCS state transition.

## Consequences

The alert-delivery Terraform stack owns distinct candidate and private delivery-state
buckets with access logging to a separate private, retention-limited bucket, a retry
function restricted to same-project internal ingress, Scheduler identity/job,
and separate runtime identities with scoped bucket access. The webhook-to-Slack
delay is normally up to one Scheduler interval (one minute) plus processing time.
The log sink cannot log to itself. The
public handler's existing Safe replay and dead-letter bucket keeps its current
permissions. The obsolete Grafana rule and bridge gauge are removed. Production
activation still requires the protected infrastructure apply and live channel
membership/destination proof; local tests establish only deterministic code
behavior. New withdrawal watches need only Terraform configuration. Deposit
alerts require a separate event-specific receipt proof before using this
delivery pattern; a deposit cannot be inferred from a withdrawal Burn.

## Evidence

PR #2548; `alerts/infra/onchain-event-handler/src/pool-liquidity-withdrawal.ts` and its
receipt fixture; `alerts/infra/onchain-event-handler/main.tf`.

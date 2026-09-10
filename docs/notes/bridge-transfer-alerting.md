---
title: Bridge transfer alerting
status: active
owner: eng
canonical: true
last_verified: 2026-09-10
doc_type: runbook
scope: alerts/rules
review_interval_days: 90
garden_lane: operator-runbooks
---

# Bridge transfer alerting

Bridge warnings go to `#alerts-bridges`. Severe cases page Splunk On-Call and
post to `#alerts-critical` through one contact point. Observation failures and
unknown data go to `#alerts-infra`. Tracker #1362 owns live acceptance. Code
readiness does not prove that any rule is deployed or any recipient received it.

## Transfer rules

Use the canonical seconds in `shared-config/bridge-thresholds.json`. Changes to
this shared file trigger both exporter and rules workflows. The rules stack owns
this exact dependency for change detection and protected plan/apply. Other
shared-config files can enter coarse validation without triggering rules apply.

Thresholds:

| Status         | Warning age     | Page age         |
| -------------- | --------------- | ---------------- |
| PENDING        | >3,600 seconds  | ≥7,200 seconds   |
| SENT           | >3,600 seconds  | ≥7,200 seconds   |
| ATTESTED       | >900 seconds    | ≥1,800 seconds   |
| QUEUED_INBOUND | >86,400 seconds | ≥172,800 seconds |

Three or more **stuck** transfers in the same route/token/status also page.
Healthy pending transfers do not count toward that condition. Warning predicates
exclude page conditions, so both severities do not fire for the same snapshot.
The page starts its own pending period when a warning escalates; the warning can
resolve before the new page notifies. A page that improves to a warning follows
the same separate pending period. This preserves one active severity per group,
with a possible notification gap during a severity transition.

Evaluate every minute with a two-minute pending period. A new persistent breach
can take up to three minutes to reach firing, plus scrape delay and the 30-second
notification group wait. Group by alert name, source chain, destination chain,
token and status. Group updates use five minutes; repeats use four hours. Resolve
notifications remain enabled. The pager and critical Slack destination share one
contact point; these rules bypass the global notification policy.

Firing notifications show route, token, status, age, stuck count, threshold and a
bridge dashboard URL. Resolved notifications identify the cleared alert and its
route and link without repeating the firing description. Mixed groups render
each alert by its own status. URLs use the existing `status`, `source` and `destination` query
parameters. Omit an unknown endpoint rather than invent a chain ID. The dashboard
has no token query parameter; the token remains in notification text.

## Freshness and unknown data

The exporter observes independently every 30 seconds after an attempt, with a
15-second total timeout. Its exported runtime freshness limit is 45 seconds.
Alloy scrapes every 30 seconds, so sampled alert data has a 75-second limit.
Age exactly 75 seconds is fresh; age greater than 75 is stale. Negative sample
age, last-success zero, observation error, or any missing metric family makes the
domain unavailable. The rule-linter test pins the scrape allowance to Alloy.

All transfer query nodes use one gate. Require fresh available data and zero
invalid rows. Any unknown route/token/status/time holds **all** transfer alert
states, including previously firing pages. This is intentionally coarse: a
partial observation cannot prove that a known incident recovered. The separate
unknown-data infrastructure rule stays evaluable and explains the hold.

On failure the whole transfer rule returns NoData. Grafana `KeepLast` preserves
its state for NoData and execution errors. See the
[Grafana missing-data contract](https://grafana.com/docs/grafana/latest/alerting/guides/missing-data/). Complete successful snapshots include
zero-valued finite buckets, so ordinary route resolution does not become a
missing-series eviction. Recovery requires a complete fresh observation with
usable data. Restart has no prior route snapshot; the infrastructure rule reports
never-observed state while existing Grafana transfer state stays held.

This contract assumes the current single Metrics Bridge scrape target. Adding
shards, changing label sets or removing configured buckets requires a new review
of per-series eviction; whole-rule NoData does not protect one missing shard while
another still returns results. [ADR 0094](../adr/0094-isolated-bridge-transfer-observations.md)
owns traversal budgets, bounded cardinality and concurrent-pagination limits.

## Apply order and live proof

1. Obtain approval for the specific bottommost stack PR merge. Recheck the
   remaining native members after GitHub changes their heads or bases.
2. Obtain approval for the exporter deployment. Verify the deployed image,
   seven metric families, at most 544 series, positive advancing last-success,
   error zero and known-data snapshots across multiple polls.
3. Review the `alerts-delivery` plan and obtain apply approval. Create
   `#alerts-bridges` through `bridge_warning_channel`. The existing channel
   management bot joins it and the existing `@eng` roster receives invitations.
4. Verify the Grafana Alerts bot can post. It can differ from the channel
   management bot. If membership is missing, obtain the operator's invitation
   through the existing Slack administration path. Reuse the owning IaC secrets;
   do not write a one-off token or webhook.
5. Review the trusted-main `alerts-rules` plan. Confirm only the intended bridge
   folder, two rule groups and three contact points are added. Obtain apply
   approval before activating them. Keep the channel and exporter prerequisites.
6. Obtain approval for a controlled notification test. Verify warning receipt in
   `#alerts-bridges`, page receipt in Splunk On-Call and `#alerts-critical`, and
   observation failure receipt in `#alerts-infra`. Check repeat and resolution
   behavior. Provider acceptance alone is insufficient. Never create real stuck
   transfers or disrupt production to produce test data.
7. Record image/commit, plan/apply, scrape samples, rule states and delivery
   receipts in #1362. Keep the issue open until this proof exists.

No new channel ID is guessed in source. Grafana uses the approved channel name;
the delivery stack exports the created ID for verification. Existing Grafana,
Slack and Splunk credentials stay in their current owning infrastructure paths.

For rollback, pause or revert the new rules through the reviewed Terraform path
before deploying an exporter without these metrics. Preserve existing exporter
liveness alerts. Do not archive the channel or remove shared credentials as an
incidental rollback action.

## Validation limits

`pnpm alerts:rules:lint` checks metric registration and PromQL syntax. Its tests
check scrape and dashboard-link drift. `bridge-rules.tftest.hcl` uses a mocked
Grafana provider to check rule settings and routing. Offline Prometheus evaluation
checks exact Terraform-derived expressions at boundaries and failure states.
Run `PROMTOOL=/path/to/promtool node --test alerts/rules/tests/bridge-behavior.test.mjs`
with Terraform, Go 1.26.0 and Prometheus `promtool` 3.5.0 installed. The required
credential-free Terraform CI job pins Go and downloads the pinned Linux ARM64
Prometheus archive with SHA-256 verification before running this command. Missing tools fail the test. The harness evaluates the
actual rule locals in a provider-free temporary module, then checks 41 scenarios
with 164 expression assertions. It also renders the exact notification templates
with Go for firing, resolved and mixed groups.
These checks do not exercise Grafana's live alert-state engine or Slack/Splunk
recipient delivery.

The normal secretless PR plan targets the repository guard and selected existing
rule groups. It excludes contact-point-dependent bridge groups. A mock-provider
plan checks the new configuration without tokens; the trusted-main full plan and
its state comparison remain mandatory before apply.

---
title: Peg monitoring alert source validation and activation
status: active
owner: eng
canonical: true
last_verified: 2026-08-21
doc_type: runbook
scope: alerts/peg-monitoring
review_interval_days: 90
garden_lane: operator-runbooks
---

# Peg monitoring alert source validation and activation

The peg alert ladder is source configuration only until every production
precondition in this runbook passes. A merged rule definition, a successful
Terraform validation, or a clean plan does not prove that peg monitoring is
live.

The source-owned surfaces are:

- `alerts/rules/peg-thresholds.json`: active and optional retained-previous
  policy;
- `alerts/rules/peg-policy-locals.tf`, `peg-promql-active.tf`, and
  `peg-promql-previous.tf`: exact-version policy and PromQL locals;
- `alerts/rules/peg-rule-definitions.tf` and `rules-peg.tf`: generated rule
  definitions and the Grafana rule group; and
- `alerts/rules/peg-contact-points.tf` and
  `peg-message-templates.tf`: direct warning, operations, and paging delivery.

## Current boundary

This source packet does not apply Grafana resources by itself. The activation
apply is complete: the Peg folder, templates, contact points, and rule group
are live in Grafana for the policy version published at that time
([#1680](https://github.com/mento-protocol/monitoring-monorepo/pull/1680),
[#1685](https://github.com/mento-protocol/monitoring-monorepo/pull/1685)).
`terraform/peg-policy.tf` owns the policy identities and bucket IAM. Controller
recovery and bootstrap-grant removal are complete.
The first protected `Peg Policy Publication` root created
`mento-monitoring-peg-policy/peg-policy/current.json` generation
`1785276001213660`. The later protected publication created active-only
generation `1786443055965590`, with `previous: null`. The approved platform
apply attached that exact generation to Metrics Bridge revision
`metrics-bridge-00196-6hg`. Post-apply proof confirmed active policy
`europ-2026-07-22-v1-f6cdaa2681ab92ce9d90572a4d29d32f`, current producer and API
packages, exactly one policy-version metric, no legacy-version labels, and all
17 Peg Grafana rules with health `ok`, unpaused, and Normal. The production
dashboard is also proven at
`https://monitoring.mento.org/peg-monitoring`: the live current package renders
without console errors. The reviewed source activation sets the
source-controlled `local.peg_alerts_enabled` switch to the literal `true`. That
single Terraform local gates the Peg folder, templates, contact points, and
rule group; it is not a workflow, variable, or policy-artifact switch. This
source change does not prove the consumers exist in Grafana or that their
queries have live data.

Source validators require every policy source to declare an integer
`listingAbsentConsecutiveChecks` value from 2 through 1000. Metrics Bridge
applies the same strict requirement to active and retained-previous policy
sources; it has no legacy-version default. The published and attached policy
has `previous: null`, so production currently emits active-only policy and
decision-package data.

The production identity bootstrap in
[#1566](https://github.com/mento-protocol/monitoring-monorepo/pull/1566) is
merged and its separately reviewed Terraform apply is complete. The producer
changes in [#1568](https://github.com/mento-protocol/monitoring-monorepo/pull/1568)
are merged and deployed. The runtime now fetches the authenticated
generation-pinned policy and exposes the active `policy_version`. The activation
PR records a full producer-floor window and production evaluation of all 61
unique generated query expressions. The protected-main plan, human-approved
apply, and post-apply Grafana proof are complete.

The live listing-confirmation producer and consumer source includes
`mento_peg_listing_state`, `mento_peg_listing_checked_at`, and the bounded
`mento_peg_listing_absent_consecutive_checks` gauge. A human-approved Grafana
application and Grafana query evidence remain separate gates. Listing state
must never be inferred from source health.

## Dashboard refresh diagnostics

The dashboard reports failed `/api/peg-monitoring` SWR reads to the
`analytics-mento-org` Sentry project with safe `api_route`, `failure_class`,
`http_status`, and, when the bridge returned an HTTP response,
`upstream_status` tags. The API response and Sentry event omit upstream bodies,
request query strings, credentials, and full URLs.

Use this production query to find bridge rate limits:

```text
environment:production source:swr api_route:"/api/peg-monitoring" failure_class:upstream-rate-limit upstream_status:429
```

Sentry captures at most one event per normalized SWR key and root-cause
fingerprint per client runtime per minute. Event counts therefore measure
sampled client-runtime minutes rather than raw failed requests, unique clients,
or unique wall-clock minutes. Remove the `failure_class` and `upstream_status`
terms to inspect all refresh root causes, then group the results by those tags.

The seven days ending 2026-08-14 contained one client-side peg-monitoring fetch
failure and no preserved upstream status. That evidence does not support a
cadence change, so the dashboard retains its 30-second refresh interval. Use
the classified query after a representative production window before changing
that interval; a sustained `upstream-rate-limit` signal is the trigger to
reassess it.

## Alert history explanations

The dashboard `Recent alerts` list uses cause-first sentences. The state dot
shows whether the condition is active, urgent, or resolved. Each dot also has
an accessible state label. The sentence omits Grafana state terms, policy-slot
terms, and internal rule names. For example, a downside transition reads
`Bitvavo sell price is 31 bps below peg`.

Grafana rule summaries and Peg notification templates use the same copy
contract. Grafana keeps the internal rule name stable for alert identity, but
the user-facing summary leads with the measured cause. Slack attachment titles
use only the severity icon because Grafana fixes their link to its alert page.
The Slack body links the human summary to Peg Monitoring. Slack bodies do not
repeat `FIRING`, `RESOLVED`, the policy slot, or the internal rule name.
Resolved notifications usually use the matching past-tense summary. Stale-data
and unavailable-price recoveries state that the data or price is available
again. Splunk On-Call uses the same summaries and keeps its required `P1` or
`RESOLVED` state text because it has no color icon.
Canonical display-name maps preserve asset and provider casing such as `KESm`
and `VALR` across the dashboard, Grafana, and notifications.

Each dashboard alert row has a collapsed `Details` disclosure. The disclosure
explains the fixed condition and its configured wait. It reads thresholds from
the decision package only when the event and package use the same policy
version. Older events without cause telemetry say that the exact cause was not
recorded. The history backend reads fired, resolved, evaluation-failure, and
evaluation-recovery transitions from the displayed seven days. It does not read
general Pending or canceled history. The bounded evaluation-recovery query can
accept an `Error` to `Pending` transition. Evaluation failures use distinct
monitoring copy and never become confirmed peg breaches. When a matching fired transition
is available, a resolved row keeps its cause and shows how long the alert stayed
active. A resolution remains visible without that active time when the alert
fired before the displayed window. Its details can still show the configured
wait when the event and current policy versions match.

Grafana state history stores the evaluated query values for each transition.
Every Peg rule therefore includes two helper queries, `Reason` and
`HttpStatus`. The helpers do not affect the alert condition. They also stay out
of instance labels, so a changed failure cause cannot change the alert
fingerprint. The dashboard uses the fired transition's values for both the
active row and its later resolved row. It never uses raw provider errors,
response bodies, request URLs, or annotations as display text.

Metrics Bridge publishes these bounded helper metrics:

- `mento_peg_source_failure_reason` for source and deep-price failures;
- `mento_peg_source_failure_http_status` for an exact provider HTTP status;
  and
- `mento_peg_structural_failure_reason` for indexed-pool failures.

It also increments `mento_peg_failure_events_total` for frequency analysis.
The counter labels contain a bounded reason, an exact HTTP status from 100
through 599 or `none`, and the source-controlled asset and source IDs. For
example, this query measures Bitvavo rate-limit failures:

```promql
sum(increase(mento_peg_failure_events_total{reason="rate_limited",http_status="429",source="bitvavo_eur"}[24h]))
```

Use the counter to decide whether the provider poll interval needs adjustment.
Use the current-state gauges to explain a specific alert transition.

Zero means no known failure. `metrics-bridge/src/peg/failure-reasons.ts` owns
the stable numeric mapping. The mapping distinguishes rate limits, other HTTP
errors, timeouts, network failures, invalid or stale data, repeated data,
insufficient book depth, halted or unlisted markets, conversion failures,
structural query or data failures, missing reference size, unsupported
providers, unknown failures, and multiple simultaneous structural failures.
The HTTP metric is zero when no status applies. A provider HTTP failure retains
the exact status, such as 429 or 500.

The dashboard combines matching active-policy and retained-previous rows only
for display when they transition within 90 seconds. Grafana still evaluates,
routes, and records both rule instances independently. The list does not infer
policy activation from the first observed policy metric sample.

## Rule inventory

For each active policy, the generated source defines:

| Rule                          | Signal                                                                                                      | Delivery                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Downside warning              | Fresh uncapped executable sell-price deviation with poll and usable-decision coverage                       | `#alerts-pools`                                              |
| Premium warning               | Fresh uncapped executable premium with the same coverage gates                                              | `#alerts-pools`                                              |
| Deep-venue downside critical  | Sustained critical downside on the policy-designated deep venue                                             | Splunk On-Call and `@support-engineer` in `#alerts-critical` |
| Deep-venue spread warning     | Fresh deep-venue spread above its approved envelope                                                         | `#alerts-pools`                                              |
| Structural saturation warning | Fresh reachable indexed-pool saturation above policy                                                        | `#alerts-pools`                                              |
| Blind warning                 | Producer count reaches `blindConsecutivePolls` without a usable uncapped deep-venue decision                | `#alerts-infra`                                              |
| Blind while stressed critical | Confirmed consecutive blindness plus reachable structural stress, spread stress, or partial-price shortfall | Splunk On-Call and `@support-engineer` in `#alerts-critical` |
| Source unhealthy              | Deep source unhealthy for two polls, or secondary source unhealthy for 30 minutes; display sources excluded | `#alerts-infra`                                              |
| Source permanently dead       | Secondary source unhealthy for `permanentlyDeadSeconds`; display sources excluded                           | `#alerts-infra`                                              |
| Registry rot                  | A non-deep source, including display-only, is `absent` at its producer-side consecutive-check threshold     | `#alerts-infra`                                              |
| Critical path unreachable     | The policy-designated deep source is `absent` at its producer-side consecutive-check threshold              | `#alerts-infra`                                              |
| Indexed pool unreachable      | The registry-bound indexed pool is zero or absent while the exact-version asset poll remains fresh          | `#alerts-infra`                                              |
| Heartbeat missing             | The isolated asset poll no longer advances                                                                  | `#alerts-infra`                                              |
| Policy rollover stuck         | A retained previous policy exists and the active version is not acknowledged in time                        | `#alerts-infra`                                              |

When `previous` is retained, the same decision ladder remains generated for
that exact previous version. Previous-version rules do not stop at the first
active-version acknowledgement; cleanup is a later reviewed policy change.
Source-controlled policy requires every source to declare its bounded
listing-absence threshold.

Display sources create registry-rot listing alerts, but never deviation,
premium, source-unhealthy, or permanently-dead rules. Deep-source health uses
a two-poll hold; secondary-source health uses a 30-minute hold. Structural
saturation never pages alone. Blindness does not depend on indexed-pool
reachability: reachability gates only the structural branch of the
independent-stress page, so market stress remains observable during an indexer
or pool-data outage. The producer updates
`mento_peg_blind_consecutive_polls` at deep-venue poll cadence and resets it on
each usable uncapped decision. Grafana compares that exact count with policy;
its 60-second evaluation clock never approximates 30-second polls.

Listing rules follow the same producer-owned discipline. The bridge increments
the bounded absence streak only on an authoritative exact-pair `absent`
response and resets it on authoritative `listed` or `halted`. Grafana reads the
instant state, streak, and fresh listing timestamp; it never reconstructs the
streak from scrapes. Unknown, missing, or stale listing evidence is not
delisting. `Peg Registry Rot`, `Peg Critical Path Unreachable`, and
`Peg Indexed Pool Unreachable` use `for = "0s"`, `no_data_state = "OK"`,
warning severity, and the direct `#alerts-infra` contact point. They never
page. The [onboarding and re-census runbook](peg-monitoring-onboarding.md)
owns source onboarding, re-census, replacement, and cleanup.

Under [ADR 0057](../adr/0057-peg-observation-advancement.md), a repeated
provider observation may retain source health only while its provider timestamp
is within `staleAfterSeconds`. It never advances a sample or usable decision.
Stale, regressing, and identity-invalid provider inputs fail closed.

## Local source validation

Run from the repository root:

```bash
pnpm alerts:rules:lint:test
pnpm alerts:rules:lint
pnpm tf validate alerts-rules
(cd alerts/rules && TF_DATA_DIR=.terraform-tf-wrapper terraform test -no-color)
pnpm agent:quality-gate --run
```

The linter parses map-comprehension `format()` expressions, requires every
`mento_peg_*` selector to bind one approved policy version, cross-checks metric
names against the producer registry, and validates active/retained-previous
rollover scope. Terraform validation proves configuration shape only.

The pull-request alert plan deliberately excludes rule groups with direct
secret-backed contact-point dependencies. The first complete remote diff is
therefore the trusted-main plan after merge. Keep its `production-infra` apply
blocked, inspect the full plan, and do not treat a targeted PR plan as proof of
the peg rule resources.

## Production activation preconditions

Do not approve the protected `alerts-rules` apply until all of the following
are true:

1. #1566 is merged and the human-approved identity bootstrap apply is verified.
2. Policy publication and authenticated producer fetch are live through their
   owning Terraform/runtime changes.
3. #1568 is merged, deployed, and the production bridge exposes the exact
   active `policy_version`.
4. `mento_peg_last_poll`, `mento_peg_source_healthy`,
   `mento_peg_observation_at`, `mento_peg_indexed_pool_reachable`, and
   `mento_peg_blind_consecutive_polls` return the expected labelled series.
   `mento_peg_source_failure_reason`,
   `mento_peg_source_failure_http_status`, and
   `mento_peg_structural_failure_reason` return zero for healthy evidence and
   bounded codes for reproduced failures.
   Every configured source also exposes one-hot `mento_peg_listing_state`, a
   positive `mento_peg_listing_checked_at`, and
   `mento_peg_listing_absent_consecutive_checks` for the exact policy version.
5. The full critical window has accumulated. For the current 20-minute deep
   venue window, both counters satisfy the policy-derived floor:

   ```promql
   increase(mento_peg_poll_success_total{asset="europ-schuman",source="bitvavo_eur",policy_version="<active>"}[20m]) >= 32
   ```

   ```promql
   increase(mento_peg_usable_decision_total{asset="europ-schuman",source="bitvavo_eur",policy_version="<active>"}[20m]) >= 32
   ```

6. Every exact generated query evaluates in the production Grafana data source
   without `Error` or unexplained `NoData`.
7. The reviewed source change sets `local.peg_alerts_enabled` to the literal
   `true`. Do not control activation through a workflow, Terraform variable,
   GitHub variable, or policy-artifact field. This source activation does not
   waive preconditions 1–6.
8. After the reviewed source change reaches protected `main`, a human reviews
   the trusted-main plan and explicitly approves the `production-infra` apply.

Active blindness and heartbeat rules use `no_data_state = "Alerting"`.
Applying while production peg samples are absent can create incidents by
design. Price, spread, structural, source-health, listing, indexed-pool,
retained-previous, and rollover rules use their documented non-paging no-data
behavior.

After apply, verify every rule exists in the `Peg Monitoring` folder, reports
`Normal`, `Pending`, or an explained real firing state, and has the expected
direct contact point. Listing alerts must show the exact asset/source/policy
identity and either a non-negative listing-check age or the safe `unavailable`
fallback. Delivery testing changes production alerting and requires its own
explicit approval.

## Rollback

First make a reviewed source change that sets `local.peg_alerts_enabled` to the
literal `false`. Obtain the human-approved `alerts-rules` apply and confirm the
Peg folder, contact points, templates, and rule group are absent before
withdrawing any producer series they require. Never remove the producer first:
active blindness and heartbeat intentionally fail closed on missing data.

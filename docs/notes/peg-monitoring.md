---
title: Peg monitoring alert source validation and activation hold
status: active
owner: eng
canonical: true
last_verified: 2026-07-24
doc_type: runbook
scope: alerts/peg-monitoring
review_interval_days: 90
garden_lane: operator-runbooks
---

# Peg monitoring alert source validation and activation hold

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

This source packet does not publish or authenticate the private policy
artifact, change a GitHub Actions workflow or Terraform identity, deploy the
producer, apply Grafana resources, or prove live telemetry.

The production identity bootstrap in
[#1566](https://github.com/mento-protocol/monitoring-monorepo/pull/1566) must be
merged and its separately reviewed Terraform apply must complete before this
alert stack is eligible for a trusted-main apply. The producer changes in
[#1568](https://github.com/mento-protocol/monitoring-monorepo/pull/1568) must be
merged and deployed before the duration rules have their required
`mento_peg_usable_decision_total` input.

Registry-rot and critical-path-unreachable rules are intentionally absent.
Those rules require authoritative `mento_peg_listing_state` and
`mento_peg_listing_checked_at` producer series, which are not part of #1568.
Do not add placeholder selectors or infer listing state from source health.

## Rule inventory

For each active policy, the generated source defines:

| Rule                          | Signal                                                                                                      | Delivery                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Downside warning              | Fresh uncapped executable sell-price deviation with poll and usable-decision coverage                       | `#alerts-pools`                       |
| Premium warning               | Fresh uncapped executable premium with the same coverage gates                                              | `#alerts-pools`                       |
| Deep-venue downside critical  | Sustained critical downside on the policy-designated deep venue                                             | Splunk On-Call and `#alerts-critical` |
| Deep-venue spread warning     | Fresh deep-venue spread above its approved envelope                                                         | `#alerts-pools`                       |
| Structural saturation warning | Fresh reachable indexed-pool saturation above policy                                                        | `#alerts-pools`                       |
| Blind warning                 | Producer count reaches `blindConsecutivePolls` without a usable uncapped deep-venue decision                | `#alerts-infra`                       |
| Blind while stressed critical | Confirmed consecutive blindness plus reachable structural stress, spread stress, or partial-price shortfall | Splunk On-Call and `#alerts-critical` |
| Source unhealthy              | Expected source unhealthy while the asset heartbeat is fresh                                                | `#alerts-infra`                       |
| Source permanently dead       | Source unhealthy for `permanentlyDeadSeconds`                                                               | `#alerts-infra`                       |
| Heartbeat missing             | The isolated asset poll no longer advances                                                                  | `#alerts-infra`                       |
| Policy rollover stuck         | A retained previous policy exists and the active version is not acknowledged in time                        | `#alerts-infra`                       |

When `previous` is retained, the same decision ladder remains generated for
that exact previous version. Previous-version rules do not stop at the first
active-version acknowledgement; cleanup is a later reviewed policy change.

Display sources never create deviation or premium rules. Structural saturation
never pages alone. Blindness does not depend on indexed-pool reachability:
reachability gates only the structural branch of the independent-stress page,
so market stress remains observable during an indexer or pool-data outage. The
producer updates `mento_peg_blind_consecutive_polls` at deep-venue poll cadence
and resets it on each usable uncapped decision. Grafana compares that exact
count with policy; its 60-second evaluation clock never approximates 30-second
polls.

## Local source validation

Run from the repository root:

```bash
pnpm alerts:rules:lint:test
pnpm alerts:rules:lint
pnpm tf validate alerts-rules
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
7. A human reviews the trusted-main plan and explicitly approves the
   `production-infra` apply.

Active blindness and heartbeat rules use `no_data_state = "Alerting"`.
Applying while production peg samples are absent can create incidents by
design. All price, spread, structural, source-health, retained-previous, and
rollover rules use their documented non-paging no-data behavior.

After apply, verify every rule exists in the `Peg Monitoring` folder, reports
`Normal`, `Pending`, or an explained real firing state, and has the expected
direct contact point. Delivery testing changes production alerting and requires
its own explicit approval.

## Rollback

Remove or disable the Grafana consumers first through a reviewed,
human-approved alerts-rules change. Confirm the rules are absent before
withdrawing any producer series they require. Never remove the producer first:
active blindness and heartbeat intentionally fail closed on missing data.

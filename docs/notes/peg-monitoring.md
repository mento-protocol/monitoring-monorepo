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
[#1568](https://github.com/mento-protocol/monitoring-monorepo/pull/1568) are
merged and deployed. They remain intentionally dormant until authenticated
policy delivery is live, so this milestone alone does not provide the required
`mento_peg_usable_decision_total` input or satisfy activation precondition 3
below.

The listing-confirmation producer and consumer source now includes
`mento_peg_listing_state`, `mento_peg_listing_checked_at`, and the bounded
`mento_peg_listing_absent_consecutive_checks` gauge. This does not prove those
series are deployed. Keep the protected rules apply blocked until all exact
active and retained-previous queries below are live. Listing state must never
be inferred from source health, observation timestamps, scrape counts, or
timestamp changes.

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
| Registry rot                  | A non-deep source, including display-only, is `absent` at its producer-side consecutive-check threshold     | `#alerts-infra`                       |
| Critical path unreachable     | The policy-designated deep source is `absent` at its producer-side consecutive-check threshold              | `#alerts-infra`                       |
| Indexed pool unreachable      | The registry-bound indexed pool is zero or absent while the exact-version asset poll remains fresh          | `#alerts-infra`                       |
| Heartbeat missing             | The isolated asset poll no longer advances                                                                  | `#alerts-infra`                       |
| Policy rollover stuck         | A retained previous policy exists and the active version is not acknowledged in time                        | `#alerts-infra`                       |

When `previous` is retained, the same rule ladder remains generated for that
exact previous version. Previous-version rules do not stop at the first active-
version acknowledgement; cleanup is a later reviewed policy change. The exact
legacy predecessor
`europ-2026-07-22-v1-a69b99aad61649957a2639dc8348b05f` has an effective listing
threshold of `2`; every newer policy must declare its threshold.

Display sources never create deviation or premium rules. Structural saturation
never pages alone. Blindness does not depend on indexed-pool reachability:
reachability gates only the structural branch of the independent-stress page,
so market stress remains observable during an indexer or pool-data outage. The
producer updates `mento_peg_blind_consecutive_polls` at deep-venue poll cadence
and resets it on each usable uncapped decision. Grafana compares that exact
count with policy; its 60-second evaluation clock never approximates 30-second
polls.

Listing rules follow the same producer-owned discipline. The bridge increments
the bounded absence streak only on an authoritative exact-pair `absent`
response and resets it on authoritative `listed` or `halted`. Grafana reads the
instant state, streak, and fresh listing timestamp; it never reconstructs the
streak from scrapes. Unknown, missing, or stale listing evidence is not
delisting. `Peg Registry Rot`, `Peg Critical Path Unreachable`, and
`Peg Indexed Pool Unreachable` use `for = "0s"`, `no_data_state = "OK"`,
warning severity, and the direct `#alerts-infra` contact point. They never
page. The [onboarding and re-census runbook](peg-monitoring-onboarding.md)
owns admission, scheduled exact-pair checks, operator response, and cleanup.

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
7. A human reviews the trusted-main plan and explicitly approves the
   `production-infra` apply.

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

Remove or disable the Grafana consumers first through a reviewed,
human-approved alerts-rules change. Confirm the rules are absent before
withdrawing any producer series they require. Never remove the producer first:
active blindness and heartbeat intentionally fail closed on missing data.
Consumer removal and any later policy cleanup stay behind the protected apply;
do not use a local apply or provider CLI mutation.

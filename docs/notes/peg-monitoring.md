---
title: Peg monitoring alert source validation and activation
status: active
owner: eng
canonical: true
last_verified: 2026-08-13
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

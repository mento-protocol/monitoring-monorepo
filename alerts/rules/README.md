<!-- agent-context: title="Grafana Alert Rules" status=active owner=eng canonical=true last_verified=2026-07-29 doc_type=runbook scope=alerts/rules review_interval_days=90 garden_lane=operator-runbooks -->

# alerts/rules

Grafana Cloud protocol alert rules, global routing, contact points, and message
templates for Mento monitoring.

## Scope

- **In this module:** protocol `grafana_rule_group` resources for FPMM pool health, VirtualPool oracle freshness, oracle report quality, oracle relayers, reserve balances, trading modes, trading limits, indexer health, CDP (Liquity v2) markets, metrics-bridge liveness, and policy-versioned peg monitoring, plus Aegis service-health and Aegis testnet-health rule groups. This stack also owns the singleton `grafana_notification_policy`, protocol/Aegis/peg contact points, message templates, mute timings, and protocol folders.
- **Not in this module:** the Aegis dashboard and the Aegis Grafana folder. Those stay in [`aegis/terraform`](../../aegis/terraform); the relocated rule group references the externally owned Aegis folder UID from `main.tf`.
- **Folder convention:** one folder per `service` label (`FPMMs`, `Oracles`, `Indexer`, `Metrics Bridge`, `Peg Monitoring`, `Oracle Relayers`, `Reserve`, `Trading Modes`, `Trading Limits`, `CDPs`).

## State

Separate from `terraform/` (platform) and `aegis/terraform`: `gs://mento-terraform-tfstate-6ed6/alerts-rules`. See [`docs/terraform.md`](../../docs/terraform.md) for the stack registry and completed Aegis-to-alerts state migration record.

## Prerequisites

1. **Slack app with bot token.** The "Grafana Alerts" app needs `chat:write` + `chat:write.public` scopes and must be invited (`/invite @Grafana Alerts`) to every channel it posts to. Current set: `#alerts-critical`, `#alerts-oracles`, `#alerts-pools`, `#alerts-cdps`, `#alerts-reserve`, `#alerts-infra`, `#alerts-testnet`, and the deprecated compatibility channel `#alerts-warning`. CDP warnings route to `#alerts-cdps`; CDP criticals route to `#alerts-critical`.
2. **Grafana Cloud service account token** with `Admin` role in the `clabsmento` stack (Grafana Cloud → Administration → Service accounts).
3. **Splunk On-Call webhook URL** for page-severity protocol/Aegis routes.

## Running

From the repository root:

```bash
cp alerts/rules/terraform.tfvars.example alerts/rules/terraform.tfvars
# Paste the Slack bot token, @support-engineer usergroup ID, Grafana SA token,
# and Splunk webhook into terraform.tfvars.

pnpm alerts:rules:init
pnpm alerts:rules:plan
# Apply happens via CI on merge to main (.github/workflows/alerts-rules.yml).
# The `production-infra` GitHub Environment enforces required-reviewer approval before
# the apply job runs. Do not run `terraform -chdir=alerts/rules apply` locally
# from a feature branch — it will fight CI on the next merge.
```

All rule/routing inputs that lack safe defaults live in
`alerts/rules/terraform.tfvars` (gitignored). This matches the pattern of
`terraform/terraform.tfvars`: one file, one place per stack.

### Static checks

Run `pnpm alerts:rules:lint` after changing alert rules or metrics-bridge gauge
names. The check parses extracted PromQL expressions from `alerts/rules/*.tf`
and cross-checks every referenced `mento_pool_*` / `mento_cdp_*` metric against
the gauges registered in `metrics-bridge/src/metrics.ts` and
`metrics-bridge/src/cdp-metrics.ts`, and every referenced `mento_peg_*` metric
against `metrics-bridge/src/peg/metrics.ts`.

CI runs this in the `CI / Lint + test root scripts` job, along with
`pnpm alerts:rules:lint:test` for extractor and failure-case coverage.

## Peg alert ladder

The source-generated peg ladder reads `peg-thresholds.json` once and generates
exact-version active and retained-previous rule sets. A reviewed source change
sets the singleton `local.peg_alerts_enabled` switch to the literal `true`,
which creates its folder, templates, contact points, and rule group. Market
warnings route to `#alerts-pools`, producer and source warnings route to
`#alerts-infra`, and critical rules route to both Splunk On-Call and
`#alerts-critical`. While a critical alert is firing, its Slack message
mentions `@support-engineer`; warning and resolve-only messages do not. Peg
rules use direct rule-level contact points and never inherit the FX-weekend
mute. Blind rules compare the producer's exact consecutive deep-poll count with
policy; they do not infer 30-second poll history from Grafana's 60-second
evaluation clock.

The Peg activation apply is complete and its rules are live in Grafana
([#1680](https://github.com/mento-protocol/monitoring-monorepo/pull/1680),
[#1685](https://github.com/mento-protocol/monitoring-monorepo/pull/1685)).
Later rule changes take the ordinary trusted-main plan and human-approved
apply; `peg-thresholds.json` rollovers go through the protected publication
and generation-pin sequence in
[`docs/deployment.md`](../../docs/deployment.md). Follow
[`docs/notes/peg-monitoring.md`](../../docs/notes/peg-monitoring.md) for the
dependency boundary, exact source checks, and rollback order.

Registry-rot rules cover every non-deep policy source, including display-only
sources. Critical-path-unreachable rules cover only the policy-designated deep
source. Both read the producer's current `absent` state and bounded consecutive
absence gauge, then require a fresh authoritative listing timestamp. They do
not infer checks from Grafana scrapes or gate on book health. Indexed-pool-
unreachable rules separately cover ADR-0043 structural reachability while the
exact-version asset poll remains fresh; the heartbeat rule remains the total
loop-outage detector.

All three rule classes use `for = "0s"`, `no_data_state = "OK"`, and the
warning-only `#alerts-infra` contact point. Missing or stale listing evidence
is unknown rather than delisting, and none of these rules pages. The
[onboarding and re-census runbook](../../docs/notes/peg-monitoring-onboarding.md)
owns source onboarding, exact-pair re-census, and cleanup. Its
[critical-page response](../../docs/notes/peg-monitoring-onboarding.md#5-respond-to-a-critical-peg-page)
owns the human handoff from `@support-engineer` triage through Safe execution
and recovery verification.

## Producer-first rollout and rollback

For any new rule with `no_data_state = "Alerting"`, confirm its production
metric series exists before approving the `alerts-rules` apply. A merge can
start the producer deployment and the protected Terraform workflow in
parallel; keep the `production-infra` approval pending until the producer is
deployed and the exact rule query returns the expected series. Scheduled mute
timings, including the FX-weekend mute, are not deployment silences. Peg rules
never use that mute and require a complete active decision-history window
before their protected apply can be approved.

Reverse the dependency for rollback. First merge a reviewed source change that
sets `local.peg_alerts_enabled` to `false`, then obtain the human-approved
`alerts-rules` apply and confirm the Peg consumers are absent. Only then
withdraw a producer metric or roll back its service/indexer. This order also
applies to warning rules with `no_data_state = "OK"` so stale rule definitions
do not conceal an incomplete rollback.
The Polygon-specific producer checks and ordered steps are in
[`docs/notes/polygon-monitoring.md`](../../docs/notes/polygon-monitoring.md).

## Smoke test

Before applying Aegis testnet-health rules, confirm Aegis has recently emitted
successful `view_call_query_duration_count` samples for `celoSepolia` and
`monadTestnet`. Each no-successful-poll query falls back to zero while the last
global `lastUpdatedAt` heartbeat is less than 12 minutes old. This window keeps
the chain result through the global page's five-minute stale threshold,
five-minute hold, firing evaluation, and one full evaluation interval. A
range maximum preserves the last nonzero heartbeat when a restarted Aegis
instance first exposes the gauge as zero. A missing chain can alert while other
Aegis calls still report data. After the handoff window, a complete data outage
produces no per-chain result and stays owned by the production
`Aegis does not report new data` page.

After the gated apply, verify rule evaluation in Grafana and delivery to the
expected Slack channel. A synthetic threshold test changes production alerting:
obtain explicit approval and use a reviewed temporary PR plus a reviewed revert,
each applied through the `production-infra` gate. Never run a local apply for
the test. For deviation state transitions, the bridge emits a short-lived
transition marker and the transition contact points intentionally do not send a
second resolve message.

## Service label routing

FPMM pool/deviation-transition, oracle, CDP, indexer, metrics-bridge, peg, and
Aegis testnet-health rule groups use rule-level `notification_settings`.
Relayer, reserve, trading-mode, trading-limit, and Aegis service-health rules
use the global notification policy and route by `service`, `severity`, `chain`,
and `rateFeed` labels. Aegis testnet-health rules route to `#alerts-testnet` via
`service=aegis-testnet` and do not depend on a testnet metrics bridge or hosted
testnet pool indexer.

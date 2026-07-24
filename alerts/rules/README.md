<!-- agent-context: title="Grafana Alert Rules" status=active owner=eng canonical=true last_verified=2026-07-24 doc_type=runbook scope=alerts/rules review_interval_days=90 garden_lane=operator-runbooks -->

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
# Paste the Slack bot token, Grafana SA token, and Splunk webhook into terraform.tfvars.

pnpm alerts:rules:init
pnpm alerts:rules:plan
# Apply happens via CI on merge to main (.github/workflows/alerts-rules.yml).
# The `production-infra` GitHub Environment enforces required-reviewer approval before
# the apply job runs. Do not run `terraform -chdir=alerts/rules apply` locally
# from a feature branch — it will fight CI on the next merge.
```

All rule/routing secrets live in `alerts/rules/terraform.tfvars` (gitignored). Matches the pattern of `terraform/terraform.tfvars` — one file, one place per stack.

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

The source-generated peg ladder reads `peg-thresholds.json` once and creates
exact-version active and retained-previous rule sets. Market warnings route to
`#alerts-pools`, producer and source warnings route to `#alerts-infra`, and
critical rules route to both Splunk On-Call and `#alerts-critical`. Peg rules
use direct rule-level contact points and never inherit the FX-weekend mute.

The source is not live merely because it is merged. Policy publication and
authentication, producer activation, the trusted-main Terraform plan, the
human-approved apply, and live Grafana proof are separate gates. Follow
[`docs/notes/peg-monitoring.md`](../../docs/notes/peg-monitoring.md) for the
current dependency boundary, exact source checks, telemetry preconditions,
activation hold, and rollback order.

Registry-rot and critical-path-unreachable rules are not part of the base
ladder. They wait for authoritative listing-state metrics from the producer.

## Producer-first rollout and rollback

For any new rule with `no_data_state = "Alerting"`, confirm its production
metric series exists before approving the `alerts-rules` apply. A merge can
start the producer deployment and the protected Terraform workflow in
parallel; keep the `production-infra` approval pending until the producer is
deployed and the exact rule query returns the expected series. Scheduled mute
timings, including the FX-weekend mute, are not deployment silences. Peg rules
never use that mute and require a complete active decision-history window
before their protected apply can be approved.

Reverse the dependency for rollback. If a service or indexer rollback would
remove a series required by a no-data-alerting rule, merge and apply the rule
revert first, confirm the rule is absent, and only then withdraw the producer.
The Polygon-specific producer checks and ordered steps are in
[`docs/notes/polygon-monitoring.md`](../../docs/notes/polygon-monitoring.md).

## Smoke test

Before applying Aegis testnet-health rules, confirm Aegis has recently emitted
successful `view_call_query_duration_count` samples for `celoSepolia` and
`monadTestnet`. The no-successful-poll rules intentionally use
`no_data_state = "Alerting"` with a 5m grace, so a never-published series can
fire immediately after apply.

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

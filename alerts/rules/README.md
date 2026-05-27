# alerts/rules

Grafana Cloud protocol alert rules, global routing, contact points, and message
templates for Mento monitoring.

## Scope

- **In this module:** protocol `grafana_rule_group` resources for FPMM pool health, oracle relayers, reserve balances, trading modes, trading limits, indexer health, and metrics-bridge liveness. This stack also owns the singleton `grafana_notification_policy`, protocol/Aegis contact points, message templates, mute timings, and protocol folders.
- **Not in this module:** Aegis dashboards and the Aegis service-health rule group. Those stay in [`aegis/terraform`](../../aegis/terraform).
- **Folder convention:** one folder per `service` label (`FPMMs`, `Indexer`, `Metrics Bridge`, `Oracle Relayers`, `Reserve`, `Trading Modes`, `Trading Limits`). `oracles` and `cdps` folders will be added when their first rule groups land.

## State

Separate from `terraform/` (platform) and `aegis/terraform`: `gs://mento-terraform-tfstate-6ed6/alerts-rules`. See [`docs/terraform.md`](../../docs/terraform.md) for the stack registry and the one-time Aegis-to-alerts state migration runbook.

## Prerequisites

1. **Slack app with bot token.** The "Grafana Alerts" app needs `chat:write` + `chat:write.public` scopes and must be invited (`/invite @Grafana Alerts`) to every channel it posts to. Current set: `#alerts-critical`, `#alerts-oracles`, `#alerts-pools`, `#alerts-reserve`, `#alerts-infra`, `#alerts-testnet`, and the deprecated compatibility channel `#alerts-warning`.
2. **Grafana Cloud service account token** with `Admin` role in the `clabsmento` stack (Grafana Cloud → Administration → Service accounts).
3. **Discord and Splunk webhook URLs** for legacy protocol/Aegis routes. These moved here from `aegis/terraform`.

## Running

```bash
cp terraform.tfvars.example terraform.tfvars
# Paste the Slack bot token, Grafana SA token, Discord webhooks, and Splunk webhook into terraform.tfvars.

pnpm alerts:rules:init
pnpm alerts:rules:plan
pnpm alerts:rules:apply
```

All rule/routing secrets live in `alerts/rules/terraform.tfvars` (gitignored). Matches the pattern of `terraform/terraform.tfvars` — one file, one place per stack.

## Smoke test

After `apply`, temporarily drop one threshold (e.g. set `params = [0.0]` on the Deviation Breach rule) and `terraform apply` again. Within ~2m, `#alerts-pools` should receive a fire, then a resolve after reverting the change. For deviation state transitions, the bridge emits a short-lived transition marker and the transition contact points intentionally do not send a second resolve message.

## Service label routing

v3 FPMM/indexer/metrics-bridge rules use rule-level `notification_settings`.
Protocol relayer/reserve/trading/Aegis service-health rules use the global
notification policy and route by `service`, `severity`, `chain`, and
`rateFeed` labels.
